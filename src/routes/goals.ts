import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { KeyResultMetric } from '@prisma/client';
import { z } from 'zod';
import { forbidden, notFound, validation } from '../errors.js';
import { projectAccess } from '../lib/access.js';
import { parentProblem, roundProgress } from '../lib/goal-progress.js';
import {
  assertCanCreateAtLevel,
  assertCanEditGoal,
  canEditGoal,
  findGoal,
  goalInclude,
  loadGoalDetail,
  loadGoalSnapshot,
  loadViewer,
  toGoal,
  toGoalUpdate,
  toKeyResult,
} from '../lib/goals.js';
import { POSITION_STEP } from '../lib/projects.js';
import { userSummarySelect } from '../lib/serialize.js';
import { currentPeriods, sortPeriods, TIME_PERIOD } from '../lib/time.js';
import { idParams, parse, queryBool, uuid } from '../lib/validate.js';
import { activeMemberWhere, currentMember } from '../lib/workspaces.js';

const goalStatus = z.enum(['NO_STATUS', 'ON_TRACK', 'AT_RISK', 'OFF_TRACK', 'ACHIEVED', 'PARTIAL', 'MISSED', 'DROPPED']);
const progressSource = z.enum(['KEY_RESULTS', 'SUB_GOALS', 'PROJECTS', 'MANUAL']);
const metricType = z.enum(['NUMBER', 'PERCENT', 'CURRENCY', 'BOOLEAN']);
const timePeriod = z.string().regex(TIME_PERIOD, 'Expected YYYY, YYYY-H1|H2 or YYYY-Q1..Q4');
const title = z.string().trim().min(1).max(300);
const description = z.string().max(20_000).nullable();
const value = z.number().finite();

const ListQuery = z.object({
  timePeriod: timePeriod.optional(),
  teamId: uuid.optional(),
  ownerId: uuid.optional(),
  company: queryBool.optional(),
  q: z.string().trim().max(100).optional(),
});

const goalFields = {
  title,
  description,
  ownerId: uuid,
  teamId: uuid.nullable(),
  isCompany: z.boolean(),
  parentId: uuid.nullable(),
  timePeriod,
  progressSource,
  weight: z.number().int().min(1).max(1000),
};
const CreateGoalBody = z.object({
  ...goalFields,
  description: description.optional(),
  ownerId: uuid.optional(),
  teamId: uuid.nullable().optional(),
  isCompany: z.boolean().optional(),
  parentId: uuid.nullable().optional(),
  progressSource: progressSource.optional(),
  weight: goalFields.weight.optional(),
});
// Unknown keys are stripped so clients can send back fields from a Goal they hold.
const UpdateGoalBody = z
  .object({ ...goalFields, status: goalStatus, manualProgress: z.number().min(0).max(100) })
  .partial();

const CreateKrBody = z.object({
  title,
  metricType,
  startValue: value.optional(),
  targetValue: value,
  currentValue: value.optional(),
  unit: z.string().trim().max(20).nullable().optional(),
  ownerId: uuid.nullable().optional(),
  position: value.optional(),
});
const UpdateKrBody = z
  .object({
    title,
    metricType,
    startValue: value,
    targetValue: value,
    currentValue: value,
    unit: z.string().trim().max(20).nullable(),
    ownerId: uuid.nullable(),
    position: value,
  })
  .partial();

const LinkBody = z.object({ projectId: uuid });
const LinkParams = z.object({ id: uuid, projectId: uuid });
const UpdateBody = z.object({ status: goalStatus, body: z.string().trim().max(20_000).nullish() });

type KrValues = { metricType: KeyResultMetric; startValue: number; targetValue: number; currentValue: number };

/** BOOLEAN KRs are always 0 → 1 with a current value of 0 or 1 (SPEC §10). */
function normaliseKr(kr: KrValues): KrValues {
  if (kr.metricType !== 'BOOLEAN') return kr;
  if (kr.currentValue !== 0 && kr.currentValue !== 1) {
    throw validation('Boolean key results are 0 or 1', [{ path: ['currentValue'], message: 'Must be 0 or 1' }]);
  }
  return { ...kr, startValue: 0, targetValue: 1 };
}

export default async function goalRoutes(app: FastifyInstance) {
  const db = app.db;

  /** Goal and KR owners must be active members of the goal's workspace (SPEC §12). */
  async function assertActiveMember(workspaceId: string, id: string, path: string) {
    const ok = await db.user.count({ where: { id, ...activeMemberWhere(workspaceId) } });
    if (!ok) {
      throw validation('User is not an active member of this workspace', [{ path: [path], message: 'Not an active workspace member' }]);
    }
  }

  async function assertTeamInWorkspace(id: string, workspaceId: string) {
    if (!(await db.team.count({ where: { id, workspaceId } }))) throw notFound('Team');
  }

  function assertExclusiveLevel(level: { isCompany: boolean; teamId: string | null }) {
    if (level.isCompany && level.teamId) {
      throw validation('A goal is either company-level or belongs to a team, not both', [
        { path: ['isCompany'], message: 'Clear teamId to make this a company goal' },
      ]);
    }
  }

  /** Parents must be in the same workspace: a parent elsewhere is "not found" (400). */
  async function assertValidParent(workspaceId: string, goalId: string | undefined, parentId: string) {
    const rows = await db.goal.findMany({ where: { workspaceId }, select: { id: true, parentId: true } });
    const parents = new Map(rows.map((r) => [r.id, r.parentId]));
    const children = new Map<string, string[]>();
    for (const r of rows) if (r.parentId) children.set(r.parentId, [...(children.get(r.parentId) ?? []), r.id]);
    const problem = parentProblem(parents, children, goalId, parentId);
    if (problem) throw validation(problem, [{ path: ['parentId'], message: problem }]);
  }

  async function editableGoal(req: FastifyRequest, id: string) {
    const { goal, viewer } = await findGoal(db, req.user, id);
    assertCanEditGoal(viewer, goal);
    return { goal, viewer };
  }

  // --- goals -----------------------------------------------------------------------

  app.get('/goals', async (req) => {
    const query = parse(ListQuery, req.query);
    const member = await currentMember(req);
    const [rows, snap, viewer] = await Promise.all([
      db.goal.findMany({
        where: {
          workspaceId: member.workspaceId,
          ...(query.timePeriod ? { timePeriod: query.timePeriod } : {}),
          ...(query.teamId ? { teamId: query.teamId } : {}),
          ...(query.ownerId ? { ownerId: query.ownerId } : {}),
          ...(query.company !== undefined ? { isCompany: query.company } : {}),
          ...(query.q ? { title: { contains: query.q, mode: 'insensitive' as const } } : {}),
        },
        include: goalInclude,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      loadGoalSnapshot(db, member.workspaceId),
      loadViewer(db, member),
    ]);
    return { data: rows.map((g) => toGoal(g, snap, viewer)) };
  });

  app.get('/goals/time-periods', async (req) => {
    const { workspaceId } = await currentMember(req);
    const used = await db.goal.findMany({ where: { workspaceId }, distinct: ['timePeriod'], select: { timePeriod: true } });
    return { data: sortPeriods([...used.map((u) => u.timePeriod), ...currentPeriods(app.config.APP_TIMEZONE)]) };
  });

  app.post('/goals', async (req, reply) => {
    const body = parse(CreateGoalBody, req.body);
    const member = await currentMember(req);
    const { workspaceId } = member;
    const viewer = await loadViewer(db, member);
    const level = { isCompany: body.isCompany ?? false, teamId: body.teamId ?? null };
    assertExclusiveLevel(level);
    assertCanCreateAtLevel(viewer, level);
    if (level.teamId) await assertTeamInWorkspace(level.teamId, workspaceId);
    const ownerId = body.ownerId ?? req.user.id;
    if (ownerId !== req.user.id) await assertActiveMember(workspaceId, ownerId, 'ownerId');
    if (body.parentId) await assertValidParent(workspaceId, undefined, body.parentId);

    const goal = await db.goal.create({
      data: {
        workspaceId,
        title: body.title,
        description: body.description ?? null,
        ownerId,
        ...level,
        parentId: body.parentId ?? null,
        timePeriod: body.timePeriod,
        progressSource: body.progressSource,
        weight: body.weight,
      },
    });
    return reply.status(201).send(await loadGoalDetail(db, goal.id, viewer));
  });

  app.get('/goals/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const { viewer } = await findGoal(db, req.user, id);
    return loadGoalDetail(db, id, viewer);
  });

  app.patch('/goals/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(UpdateGoalBody, req.body);
    const { goal, viewer } = await editableGoal(req, id);

    const level = {
      isCompany: body.isCompany ?? goal.isCompany,
      teamId: body.teamId === undefined ? goal.teamId : body.teamId,
    };
    assertExclusiveLevel(level);
    if (level.isCompany !== goal.isCompany || level.teamId !== goal.teamId) {
      // Moving a goal to another level needs the right to create goals there.
      assertCanCreateAtLevel(viewer, level);
      if (level.teamId && level.teamId !== goal.teamId) await assertTeamInWorkspace(level.teamId, goal.workspaceId);
    }
    if (body.ownerId && body.ownerId !== goal.ownerId) await assertActiveMember(goal.workspaceId, body.ownerId, 'ownerId');
    if (body.parentId && body.parentId !== goal.parentId) await assertValidParent(goal.workspaceId, id, body.parentId);

    await db.goal.update({ where: { id }, data: { ...body, ...level } });
    return loadGoalDetail(db, id, viewer);
  });

  app.delete('/goals/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    await editableGoal(req, id);
    // KRs, project links and updates cascade; children are detached (parentId = null).
    await db.goal.delete({ where: { id } });
    return reply.status(204).send();
  });

  // --- key results -------------------------------------------------------------

  app.post('/goals/:id/key-results', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const body = parse(CreateKrBody, req.body);
    const { goal } = await editableGoal(req, id);
    if (body.ownerId) await assertActiveMember(goal.workspaceId, body.ownerId, 'ownerId');

    // BOOLEAN KRs always start at 0, so their default current value is 0 too.
    const startValue = body.metricType === 'BOOLEAN' ? 0 : (body.startValue ?? 0);
    const values = normaliseKr({
      metricType: body.metricType,
      startValue,
      targetValue: body.targetValue,
      currentValue: body.currentValue ?? startValue,
    });
    let position = body.position;
    if (position === undefined) {
      const last = await db.keyResult.aggregate({ where: { goalId: id }, _max: { position: true } });
      position = (last._max.position ?? 0) + POSITION_STEP;
    }
    const kr = await db.keyResult.create({
      data: { goalId: id, title: body.title, ...values, unit: body.unit ?? null, ownerId: body.ownerId ?? null, position },
      include: { owner: { select: userSummarySelect } },
    });
    return reply.status(201).send(toKeyResult(kr));
  });

  app.patch('/key-results/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(UpdateKrBody, req.body);
    const ref = await db.keyResult.findUnique({ where: { id }, select: { goalId: true } });
    if (!ref) throw notFound('Key result');
    const { goal, viewer } = await findGoal(db, req.user, ref.goalId).catch(() => {
      throw notFound('Key result');
    });
    const kr = await db.keyResult.findUniqueOrThrow({ where: { id }, include: { goal: true } });
    if (!canEditGoal(viewer, kr.goal)) {
      // A KR's owner may update its current value, and nothing else.
      const onlyCurrent = Object.keys(body).every((k) => k === 'currentValue');
      if (kr.ownerId !== req.user.id || !onlyCurrent) {
        throw forbidden('Only the goal owner, its team or an admin can change this key result');
      }
    }
    if (body.ownerId) await assertActiveMember(goal.workspaceId, body.ownerId, 'ownerId');

    const values = normaliseKr({
      metricType: body.metricType ?? kr.metricType,
      startValue: body.startValue ?? kr.startValue,
      targetValue: body.targetValue ?? kr.targetValue,
      currentValue: body.currentValue ?? kr.currentValue,
    });
    const updated = await db.keyResult.update({
      where: { id },
      data: { ...body, ...values },
      include: { owner: { select: userSummarySelect } },
    });
    // Touch the goal so its updatedAt reflects KR progress changes.
    await db.goal.update({ where: { id: kr.goalId }, data: { updatedAt: new Date() } });
    return toKeyResult(updated);
  });

  app.delete('/key-results/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const kr = await db.keyResult.findUnique({ where: { id }, select: { goalId: true } });
    if (!kr) throw notFound('Key result');
    await editableGoal(req, kr.goalId);
    await db.keyResult.delete({ where: { id } });
    return reply.status(204).send();
  });

  // --- linked projects ------------------------------------------------------------

  app.post('/goals/:id/projects', async (req) => {
    const { id } = parse(idParams, req.params);
    const { projectId } = parse(LinkBody, req.body);
    const { goal, viewer } = await editableGoal(req, id);
    // 404 unless the caller can see it, and projects in other workspaces can't be linked (SPEC §12).
    const access = await projectAccess(db, req.user, projectId);
    if (access.member.workspaceId !== goal.workspaceId) throw notFound('Project');
    await db.goalProject.createMany({ data: [{ goalId: id, projectId }], skipDuplicates: true });
    return loadGoalDetail(db, id, viewer);
  });

  app.delete('/goals/:id/projects/:projectId', async (req) => {
    const { id, projectId } = parse(LinkParams, req.params);
    const { viewer } = await editableGoal(req, id);
    await db.goalProject.deleteMany({ where: { goalId: id, projectId } });
    return loadGoalDetail(db, id, viewer);
  });

  // --- status updates -----------------------------------------------------------

  app.get('/goals/:id/updates', async (req) => {
    const { id } = parse(idParams, req.params);
    await findGoal(db, req.user, id);
    const updates = await db.goalUpdate.findMany({
      where: { goalId: id },
      include: { author: { select: userSummarySelect } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return { data: updates.map(toGoalUpdate) };
  });

  app.post('/goals/:id/updates', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const body = parse(UpdateBody, req.body);
    const { goal, viewer } = await findGoal(db, req.user, id);
    if (!canEditGoal(viewer, goal)) {
      const ownsKr = await db.keyResult.count({ where: { goalId: id, ownerId: req.user.id } });
      if (!ownsKr) throw forbidden('Only people who can edit this goal or own one of its key results can post updates');
    }
    const snap = await loadGoalSnapshot(db, goal.workspaceId);
    const update = await db.$transaction(async (tx) => {
      const created = await tx.goalUpdate.create({
        data: {
          goalId: id,
          authorId: req.user.id,
          status: body.status,
          progress: roundProgress(snap.progress.get(id) ?? 0),
          body: body.body ?? null,
        },
        include: { author: { select: userSummarySelect } },
      });
      await tx.goal.update({ where: { id }, data: { status: body.status } });
      return created;
    });
    return reply.status(201).send(toGoalUpdate(update));
  });
}
