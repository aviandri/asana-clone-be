import type { FastifyInstance } from 'fastify';
import { Prisma, type Priority } from '@prisma/client';
import { z } from 'zod';
import { notFound, validation } from '../errors.js';
import { projectAccess, visibleProjectsWhere } from '../lib/access.js';
import { slugify, toCsv } from '../lib/csv.js';
import { projectInclude, toProject } from '../lib/projects.js';
import { roundProgress } from '../lib/goal-progress.js';
import { fromDateOnly, toDateOnly, toUserSummary, userSummarySelect } from '../lib/serialize.js';
import { taskInclude, toTask, visibleTasksWhere } from '../lib/tasks.js';
import { addDays, daysBetweenInclusive, mondayOf, zonedDate, zonedDayStart } from '../lib/time.js';
import { dateOnly, idParams, parse, uuid } from '../lib/validate.js';
import { activeMemberWhere, currentMember } from '../lib/workspaces.js';

const ReportQuery = z.object({ weeks: z.coerce.number().int().min(1).max(52).default(12) });
const OverviewQuery = z.object({ teamId: uuid.optional() });
const WorkloadQuery = z.object({ teamId: uuid.optional(), from: dateOnly.optional(), to: dateOnly.optional() });

const MAX_WORKLOAD_DAYS = 92;
const UPCOMING_DAYS = 14;
const UPCOMING_LIMIT = 20;
const PRIORITY_ORDER: Priority[] = ['HIGH', 'MEDIUM', 'LOW', 'NONE'];

const percent = (completed: number, total: number) => (total ? roundProgress((completed / total) * 100) : 0);

type Counts = { total: number; completed: number; incomplete: number; overdue: number };
const emptyCounts = (): Counts => ({ total: 0, completed: 0, incomplete: 0, overdue: 0 });

export default async function reportRoutes(app: FastifyInstance) {
  const db = app.db;
  const tz = () => app.config.APP_TIMEZONE;

  // --- GET /projects/:id/report ----------------------------------------------------

  app.get('/projects/:id/report', async (req) => {
    const { id } = parse(idParams, req.params);
    const { weeks } = parse(ReportQuery, req.query);
    await projectAccess(db, req.user, id);
    const today = zonedDate(tz());

    const [project, sections, cube, dated, upcoming] = await Promise.all([
      db.project.findUniqueOrThrow({ where: { id }, select: { id: true, name: true, color: true } }),
      db.section.findMany({ where: { projectId: id }, orderBy: [{ position: 'asc' }, { id: 'asc' }] }),
      // One pass over the project's tasks (incl. subtasks), grouped by every dimension the report
      // slices on. Subtasks are counted under their parent's section.
      db.$queryRaw<
        { sectionId: string | null; assigneeId: string | null; priority: Priority; completed: boolean; overdue: boolean; n: number }[]
      >`
        SELECT COALESCE(p."sectionId", t."sectionId") AS "sectionId",
               t."assigneeId", t."priority", t."completed",
               (NOT t."completed" AND t."dueDate" < ${today}::date) AS "overdue",
               count(*)::int AS n
        FROM "Task" t
        LEFT JOIN "Task" p ON p."id" = t."parentId"
        WHERE t."projectId" = ${id}::uuid
        GROUP BY 1, 2, 3, 4, 5`,
      // Local (APP_TIMEZONE) calendar days of creation and completion, for the weekly trend.
      db.$queryRaw<{ created: string; completedOn: string | null }[]>`
        SELECT to_char((t."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz()}, 'YYYY-MM-DD') AS created,
               CASE WHEN t."completed" AND t."completedAt" IS NOT NULL
                    THEN to_char((t."completedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz()}, 'YYYY-MM-DD') END AS "completedOn"
        FROM "Task" t
        WHERE t."projectId" = ${id}::uuid`,
      db.task.findMany({
        where: {
          projectId: id,
          completed: false,
          dueDate: { gte: fromDateOnly(today), lte: fromDateOnly(addDays(today, UPCOMING_DAYS)) },
        },
        include: taskInclude,
        orderBy: [{ dueDate: 'asc' }, { position: 'asc' }, { id: 'asc' }],
        take: UPCOMING_LIMIT,
      }),
    ]);

    const totals = emptyCounts();
    let unassigned = 0;
    const bySection = new Map<string | null, { total: number; completed: number; overdue: number }>();
    const byAssignee = new Map<string | null, { incomplete: number; completed: number; overdue: number }>();
    const byPriority = new Map<Priority, { total: number; incomplete: number }>(
      PRIORITY_ORDER.map((p) => [p, { total: 0, incomplete: 0 }]),
    );
    for (const row of cube) {
      const { n } = row;
      totals.total += n;
      if (row.completed) totals.completed += n;
      else totals.incomplete += n;
      if (row.overdue) totals.overdue += n;
      if (!row.completed && !row.assigneeId) unassigned += n;

      const s = bySection.get(row.sectionId) ?? { total: 0, completed: 0, overdue: 0 };
      s.total += n;
      if (row.completed) s.completed += n;
      if (row.overdue) s.overdue += n;
      bySection.set(row.sectionId, s);

      const a = byAssignee.get(row.assigneeId) ?? { incomplete: 0, completed: 0, overdue: 0 };
      if (row.completed) a.completed += n;
      else a.incomplete += n;
      if (row.overdue) a.overdue += n;
      byAssignee.set(row.assigneeId, a);

      const pr = byPriority.get(row.priority)!;
      pr.total += n;
      if (!row.completed) pr.incomplete += n;
    }

    const assigneeIds = [...byAssignee.keys()].filter((k): k is string => k !== null);
    const users = new Map(
      (await db.user.findMany({ where: { id: { in: assigneeIds } }, select: userSummarySelect })).map((u) => [u.id, u]),
    );
    const zero = { total: 0, completed: 0, overdue: 0 };
    const noSection = bySection.get(null);

    return {
      project,
      totals: { ...totals, unassigned, percentComplete: percent(totals.completed, totals.total) },
      bySection: [
        ...sections.map((s) => ({ sectionId: s.id, name: s.name, ...(bySection.get(s.id) ?? zero) })),
        // "No section" is listed (last) only when it has tasks.
        ...(noSection ? [{ sectionId: null, name: 'No section', ...noSection }] : []),
      ],
      byAssignee: [...byAssignee.entries()]
        .map(([assigneeId, c]) => {
          const u = assigneeId ? users.get(assigneeId) : undefined;
          return { assignee: u ? toUserSummary(u) : null, ...c };
        })
        .sort((x, y) => y.incomplete - x.incomplete || (x.assignee?.name ?? '\uffff').localeCompare(y.assignee?.name ?? '\uffff')),
      byPriority: PRIORITY_ORDER.map((priority) => ({ priority, ...byPriority.get(priority)! })),
      trend: weeklyTrend(dated, mondayOf(today), weeks),
      upcoming: upcoming.map(toTask),
    };
  });

  // --- GET /reports/overview ---------------------------------------------------------

  app.get('/reports/overview', async (req) => {
    const { teamId } = parse(OverviewQuery, req.query);
    const member = await currentMember(req);
    const today = zonedDate(tz());
    const projects = await db.project.findMany({
      where: { AND: [visibleProjectsWhere(member), { archived: false }, teamId ? { teamId } : {}] },
      include: projectInclude(req.user.id),
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    const ids = projects.map((p) => p.id);

    const [counts, activity] = ids.length
      ? await Promise.all([
          db.$queryRaw<{ projectId: string; total: number; completed: number; overdue: number }[]>`
            SELECT t."projectId",
                   count(*)::int AS total,
                   count(*) FILTER (WHERE t."completed")::int AS completed,
                   count(*) FILTER (WHERE NOT t."completed" AND t."dueDate" < ${today}::date)::int AS overdue
            FROM "Task" t
            WHERE t."projectId" IN (${Prisma.join(ids.map((i) => Prisma.sql`${i}::uuid`))})
            GROUP BY 1`,
          // Latest activity or comment on any of the project's tasks.
          db.$queryRaw<{ projectId: string; at: Date | null }[]>`
            SELECT t."projectId", max(e.at) AS at
            FROM "Task" t
            JOIN (SELECT "taskId", max("createdAt") AS at FROM "Activity" GROUP BY 1
                  UNION ALL
                  SELECT "taskId", max("createdAt") AS at FROM "Comment" GROUP BY 1) e ON e."taskId" = t."id"
            WHERE t."projectId" IN (${Prisma.join(ids.map((i) => Prisma.sql`${i}::uuid`))})
            GROUP BY 1`,
        ])
      : [[], []];

    const countsById = new Map(counts.map((c) => [c.projectId, c]));
    const activityById = new Map(activity.map((a) => [a.projectId, a.at]));
    const totals = { ...emptyCounts(), projects: projects.length };
    const rows = projects.map((p) => {
      const c = countsById.get(p.id) ?? { total: 0, completed: 0, overdue: 0 };
      const row = {
        project: toProject(p),
        total: c.total,
        completed: c.completed,
        incomplete: c.total - c.completed,
        overdue: c.overdue,
        percentComplete: percent(c.completed, c.total),
        lastActivityAt: activityById.get(p.id)?.toISOString() ?? null,
      };
      totals.total += row.total;
      totals.completed += row.completed;
      totals.incomplete += row.incomplete;
      totals.overdue += row.overdue;
      return row;
    });
    return { totals, projects: rows };
  });

  // --- GET /reports/workload -----------------------------------------------------------

  app.get('/reports/workload', async (req) => {
    const query = parse(WorkloadQuery, req.query);
    const member = await currentMember(req);
    const { workspaceId } = member;
    const today = zonedDate(tz());
    const from = query.from ?? mondayOf(today);
    const to = query.to ?? addDays(from, 6);
    const span = daysBetweenInclusive(from, to);
    if (span < 1) throw validation('`from` must not be after `to`', [{ path: ['from'], message: 'After `to`' }]);
    if (span > MAX_WORKLOAD_DAYS) {
      throw validation(`The range can be at most ${MAX_WORKLOAD_DAYS} days`, [{ path: ['to'], message: 'Range too long' }]);
    }
    if (query.teamId && !(await db.team.count({ where: { id: query.teamId, workspaceId } }))) {
      throw notFound('Team');
    }

    // Active members of the current workspace (of the team, if given).
    const users = await db.user.findMany({
      where: {
        ...activeMemberWhere(workspaceId),
        ...(query.teamId ? { teamMemberships: { some: { teamId: query.teamId } } } : {}),
      },
      select: userSummarySelect,
    });
    const userIds = users.map((u) => u.id);

    // §4 visibility for the caller, always. With a team, only that team's projects count.
    const scope: Prisma.TaskWhereInput = {
      AND: [
        { assigneeId: { in: userIds } },
        visibleTasksWhere(member),
        query.teamId ? { project: { is: { teamId: query.teamId } } } : {},
      ],
    };
    const countBy = async (where: Prisma.TaskWhereInput) => {
      const groups = await db.task.groupBy({ by: ['assigneeId'], where: { AND: [scope, where] }, _count: { _all: true } });
      return new Map(groups.map((g) => [g.assigneeId, g._count._all]));
    };
    const [open, overdue, dueInRange, completedInRange] = await Promise.all([
      countBy({ completed: false }),
      countBy({ completed: false, dueDate: { lt: fromDateOnly(today) } }),
      countBy({ completed: false, dueDate: { gte: fromDateOnly(from), lte: fromDateOnly(to) } }),
      countBy({
        completed: true,
        completedAt: { gte: zonedDayStart(from, tz()), lt: zonedDayStart(addDays(to, 1), tz()) },
      }),
    ]);

    const data = users
      .map((u) => ({
        user: toUserSummary(u),
        open: open.get(u.id) ?? 0,
        overdue: overdue.get(u.id) ?? 0,
        dueInRange: dueInRange.get(u.id) ?? 0,
        completedInRange: completedInRange.get(u.id) ?? 0,
      }))
      .sort((a, b) => b.open - a.open || a.user.name.localeCompare(b.user.name));
    return { from, to, data };
  });

  // --- GET /projects/:id/tasks.csv ---------------------------------------------------------

  app.get('/projects/:id/tasks.csv', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    await projectAccess(db, req.user, id);
    const [project, sections, tasks] = await Promise.all([
      db.project.findUniqueOrThrow({ where: { id }, select: { name: true } }),
      db.section.findMany({ where: { projectId: id }, select: { id: true, name: true, position: true } }),
      db.task.findMany({
        where: { projectId: id },
        include: { assignee: { select: { name: true, email: true } } },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      }),
    ]);
    const sectionById = new Map(sections.map((s) => [s.id, s]));

    // List order: top-level tasks by section position (no section last), then position; each
    // followed by its subtasks. A subtask shows its parent's section.
    const childrenOf = new Map<string, typeof tasks>();
    for (const t of tasks) if (t.parentId) childrenOf.set(t.parentId, [...(childrenOf.get(t.parentId) ?? []), t]);
    const sectionPos = (sectionId: string | null) => (sectionId ? (sectionById.get(sectionId)?.position ?? Infinity) : Infinity);
    const taskIds = new Set(tasks.map((t) => t.id));
    const topLevel = tasks
      .filter((t) => !t.parentId || !taskIds.has(t.parentId))
      .sort((a, b) => sectionPos(a.sectionId) - sectionPos(b.sectionId));

    const rows: (string | boolean | null)[][] = [];
    const emit = (t: (typeof tasks)[number], sectionId: string | null, depth: number) => {
      rows.push([
        t.id,
        t.title,
        sectionId ? (sectionById.get(sectionId)?.name ?? '') : '',
        t.parentId,
        t.assignee?.name ?? null,
        t.assignee?.email ?? null,
        t.priority,
        toDateOnly(t.startDate),
        toDateOnly(t.dueDate),
        t.completed,
        t.completedAt?.toISOString() ?? null,
        t.createdAt.toISOString(),
      ]);
      if (depth < 10) for (const child of childrenOf.get(t.id) ?? []) emit(child, sectionId, depth + 1);
    };
    for (const t of topLevel) emit(t, t.sectionId, 0);

    const csv = toCsv(
      ['id', 'title', 'section', 'parent_task_id', 'assignee_name', 'assignee_email', 'priority', 'start_date', 'due_date', 'completed', 'completed_at', 'created_at'],
      rows,
    );
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${slugify(project.name)}-tasks.csv"`)
      .send(csv);
  });
}

/**
 * `weeks` Monday-start weeks ending with the current one, oldest first. `open` = created before
 * the week ended and not completed by then (still-open tasks have no completion day).
 */
export function weeklyTrend(tasks: { created: string; completedOn: string | null }[], currentMonday: string, weeks: number) {
  const out = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = addDays(currentMonday, -7 * i);
    const end = addDays(start, 7); // exclusive
    let created = 0;
    let completed = 0;
    let open = 0;
    for (const t of tasks) {
      if (t.created >= start && t.created < end) created += 1;
      if (t.completedOn && t.completedOn >= start && t.completedOn < end) completed += 1;
      if (t.created < end && !(t.completedOn && t.completedOn < end)) open += 1;
    }
    out.push({ weekStart: start, created, completed, open });
  }
  return out;
}
