import type { Goal, GoalUpdate, KeyResult, Prisma, PrismaClient, User } from '@prisma/client';
import { forbidden, notFound } from '../errors.js';
import { visibleProjectsWhere } from './access.js';
import {
  buildGraph,
  computeAllProgress,
  keyResultProgress,
  roundProgress,
  type GoalGraph,
  type TaskCounts,
} from './goal-progress.js';
import { toUserSummary, userSummarySelect, type UserSummaryRow } from './serialize.js';
import { requireMember, type Member } from './workspaces.js';

// --- batch load -----------------------------------------------------------------

export type GoalSnapshot = { graph: GoalGraph; progress: Map<string, number> };

/**
 * Loads every goal, KR, project link and linked project's task counts of one workspace in four
 * queries, then computes all progress in memory. Goals are workspace-wide and number in the
 * hundreds, so this is cheaper and simpler than recursive per-goal queries.
 */
export async function loadGoalSnapshot(db: PrismaClient, workspaceId: string): Promise<GoalSnapshot> {
  const inWorkspace = { goal: { workspaceId } };
  const [goals, keyResults, links] = await Promise.all([
    db.goal.findMany({
      where: { workspaceId },
      select: { id: true, parentId: true, progressSource: true, manualProgress: true, weight: true },
    }),
    db.keyResult.findMany({
      where: inWorkspace,
      select: { goalId: true, startValue: true, targetValue: true, currentValue: true },
    }),
    db.goalProject.findMany({ where: inWorkspace, select: { goalId: true, projectId: true } }),
  ]);
  const projectIds = [...new Set(links.map((l) => l.projectId))];
  const projectTasks = new Map<string, TaskCounts>();
  if (projectIds.length) {
    const groups = await db.task.groupBy({
      by: ['projectId', 'completed'],
      where: { projectId: { in: projectIds } },
      _count: { _all: true },
    });
    for (const g of groups) {
      const c = projectTasks.get(g.projectId!) ?? { total: 0, completed: 0 };
      c.total += g._count._all;
      if (g.completed) c.completed += g._count._all;
      projectTasks.set(g.projectId!, c);
    }
  }
  const graph = buildGraph({ goals, keyResults, links, projectTasks });
  return { graph, progress: computeAllProgress(graph) };
}

// --- permissions (SPEC §10) ----------------------------------------------------------

export type GoalViewer = { member: Member; teamIds: Set<string> };

export async function loadViewer(db: PrismaClient, member: Member): Promise<GoalViewer> {
  const memberships = await db.teamMember.findMany({
    where: { userId: member.user.id, team: { workspaceId: member.workspaceId } },
    select: { teamId: true },
  });
  return { member, teamIds: new Set(memberships.map((m) => m.teamId)) };
}

type GoalLevel = { isCompany: boolean; teamId: string | null };

/** Owner, ADMIN, or (team goals) any member of the goal's team. */
export function canEditGoal(v: GoalViewer, goal: GoalLevel & { ownerId: string }): boolean {
  return (
    v.member.role === 'ADMIN' ||
    goal.ownerId === v.member.user.id ||
    (goal.teamId !== null && v.teamIds.has(goal.teamId))
  );
}

/** Company goals: ADMIN. Team goals: that team's members or ADMIN. Personal goals: anyone. */
export function assertCanCreateAtLevel(v: GoalViewer, level: GoalLevel) {
  if (v.member.role === 'ADMIN') return;
  if (level.isCompany) throw forbidden('Only admins can create or move goals to company level');
  if (level.teamId && !v.teamIds.has(level.teamId)) {
    throw forbidden('Only members of that team can create or move goals to it');
  }
}

export function assertCanEditGoal(v: GoalViewer, goal: Goal) {
  if (!canEditGoal(v, goal)) throw forbidden('Only the goal owner, its team or an admin can change this goal');
}

/** A goal and the caller's viewer in its workspace (ID-addressed: 404 unless an active member there). */
export async function findGoal(db: PrismaClient, user: User, id: string) {
  const goal = await db.goal.findUnique({ where: { id } });
  if (!goal) throw notFound('Goal');
  const viewer = await loadViewer(db, await requireMember(db, user, goal.workspaceId, 'Goal'));
  return { goal, viewer };
}

// --- shapes (SPEC §10) ---------------------------------------------------------------

export const goalInclude = {
  owner: { select: userSummarySelect },
  team: { select: { id: true, name: true } },
  _count: { select: { keyResults: true, children: true } },
} satisfies Prisma.GoalInclude;

type GoalRow = Prisma.GoalGetPayload<{ include: typeof goalInclude }>;

export function toGoal(g: GoalRow, snap: GoalSnapshot, v: GoalViewer) {
  return {
    id: g.id,
    workspaceId: g.workspaceId,
    title: g.title,
    description: g.description,
    owner: toUserSummary(g.owner),
    team: g.team,
    isCompany: g.isCompany,
    parentId: g.parentId,
    timePeriod: g.timePeriod,
    status: g.status,
    progressSource: g.progressSource,
    progress: roundProgress(snap.progress.get(g.id) ?? 0),
    weight: g.weight,
    keyResultCount: g._count.keyResults,
    childCount: g._count.children,
    canEdit: canEditGoal(v, g),
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
  };
}

export function toKeyResult(kr: KeyResult & { owner: UserSummaryRow | null }) {
  return {
    id: kr.id,
    goalId: kr.goalId,
    title: kr.title,
    metricType: kr.metricType,
    startValue: kr.startValue,
    targetValue: kr.targetValue,
    currentValue: kr.currentValue,
    unit: kr.unit,
    owner: kr.owner ? toUserSummary(kr.owner) : null,
    progress: roundProgress(keyResultProgress(kr.startValue, kr.targetValue, kr.currentValue)),
    position: kr.position,
    updatedAt: kr.updatedAt.toISOString(),
  };
}

export function toGoalUpdate(u: GoalUpdate & { author: UserSummaryRow }) {
  return {
    id: u.id,
    goalId: u.goalId,
    author: toUserSummary(u.author),
    status: u.status,
    progress: u.progress,
    body: u.body,
    createdAt: u.createdAt.toISOString(),
  };
}

export async function loadGoalDetail(db: PrismaClient, id: string, v: GoalViewer) {
  const [snap, goal] = await Promise.all([
    loadGoalSnapshot(db, v.member.workspaceId),
    db.goal.findUnique({
      where: { id },
      include: {
        ...goalInclude,
        parent: { select: { id: true, title: true } },
        keyResults: {
          include: { owner: { select: userSummarySelect } },
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        },
        children: { include: goalInclude, orderBy: { createdAt: 'asc' } },
        projects: { select: { projectId: true } },
        updates: {
          include: { author: { select: userSummarySelect } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
        },
      },
    }),
  ]);
  if (!goal) throw notFound('Goal');

  // Linked projects the viewer can't see are counted but not shown (their tasks still count in PROJECTS progress).
  const linkedIds = goal.projects.map((p) => p.projectId);
  const visible = linkedIds.length
    ? await db.project.findMany({
        where: { AND: [{ id: { in: linkedIds } }, visibleProjectsWhere(v.member)] },
        select: { id: true, name: true, color: true },
        orderBy: { name: 'asc' },
      })
    : [];

  return {
    ...toGoal(goal, snap, v),
    parent: goal.parent,
    keyResults: goal.keyResults.map(toKeyResult),
    children: goal.children.map((c) => toGoal(c, snap, v)),
    projects: visible.map((project) => {
      const counts = snap.graph.projectTasks.get(project.id) ?? { total: 0, completed: 0 };
      return { project, total: counts.total, completed: counts.completed };
    }),
    hiddenProjectCount: linkedIds.length - visible.length,
    latestUpdate: goal.updates[0] ? toGoalUpdate(goal.updates[0]) : null,
  };
}
