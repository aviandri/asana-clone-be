import type { Prisma, PrismaClient, User } from '@prisma/client';
import { notFound } from '../errors.js';
import { projectAccess, visibleProjectsWhere } from './access.js';
import { requireMember, type Member } from './workspaces.js';
import { toDateOnly, toUserSummary, userSummarySelect } from './serialize.js';

/** Prisma include for the `Task` shape (SPEC §5). */
export const taskInclude = {
  assignee: { select: userSummarySelect },
  creator: { select: userSummarySelect },
  project: { select: { id: true, name: true, color: true } },
  subtasks: { select: { completed: true } },
  _count: { select: { comments: true } },
} satisfies Prisma.TaskInclude;

export type TaskRow = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;

export function toTask(t: TaskRow) {
  return {
    id: t.id,
    workspaceId: t.workspaceId,
    projectId: t.projectId,
    sectionId: t.sectionId,
    parentId: t.parentId,
    title: t.title,
    description: t.description,
    assignee: t.assignee ? toUserSummary(t.assignee) : null,
    creator: toUserSummary(t.creator),
    dueDate: toDateOnly(t.dueDate),
    startDate: toDateOnly(t.startDate),
    priority: t.priority,
    completed: t.completed,
    completedAt: t.completedAt?.toISOString() ?? null,
    position: t.position,
    subtaskCount: t.subtasks.length,
    completedSubtaskCount: t.subtasks.filter((s) => s.completed).length,
    commentCount: t._count.comments,
    project: t.project,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

export async function loadTaskDetail(db: PrismaClient, id: string) {
  const t = await db.task.findUnique({
    where: { id },
    include: {
      ...taskInclude,
      followers: { include: { user: { select: userSummarySelect } }, orderBy: { user: { name: 'asc' } } },
      parent: { select: { id: true, title: true } },
    },
  });
  if (!t) throw notFound('Task');
  const subtasks = await db.task.findMany({
    where: { parentId: id },
    include: taskInclude,
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
  });
  return {
    ...toTask(t),
    followers: t.followers.map((f) => toUserSummary(f.user)),
    subtasks: subtasks.map(toTask),
    parent: t.parent,
  };
}

/**
 * Tasks the caller can see in their workspace, for list queries. A project task is visible with its
 * project. A personal task (no project) is visible to its creator, assignee and followers.
 */
export function visibleTasksWhere(m: Member): Prisma.TaskWhereInput {
  if (m.role === 'ADMIN') return { workspaceId: m.workspaceId };
  const user = m.user;
  return {
    workspaceId: m.workspaceId,
    OR: [
      { projectId: { not: null }, project: { is: visibleProjectsWhere(m) } },
      {
        projectId: null,
        OR: [{ creatorId: user.id }, { assigneeId: user.id }, { followers: { some: { userId: user.id } } }],
      },
    ],
  };
}

export type TaskAccess = { canEdit: boolean; member: Member };

type TaskRef = { id: string; workspaceId: string; projectId: string | null; parentId: string | null };

/**
 * Resolves the caller's access to one task. Invisible tasks are 404. Subtasks of personal tasks
 * inherit visibility from the top-level task.
 */
export async function taskAccess(db: PrismaClient, user: User, task: TaskRef): Promise<TaskAccess> {
  if (task.projectId) {
    const access = await projectAccess(db, user, task.projectId).catch(() => {
      throw notFound('Task');
    });
    return { canEdit: access.canEdit, member: access.member };
  }
  const member = await requireMember(db, user, task.workspaceId, 'Task');
  if (member.role === 'ADMIN') return { canEdit: true, member };
  let root: TaskRef = task;
  for (let depth = 0; root.parentId && depth < 20; depth++) {
    const parent = await db.task.findUnique({
      where: { id: root.parentId },
      select: { id: true, workspaceId: true, projectId: true, parentId: true },
    });
    if (!parent) break;
    root = parent;
  }
  const visible = await db.task.count({
    where: {
      id: root.id,
      OR: [{ creatorId: user.id }, { assigneeId: user.id }, { followers: { some: { userId: user.id } } }],
    },
  });
  if (!visible) throw notFound('Task');
  return { canEdit: true, member };
}

/** Loads a task's ref and the caller's access in one call (404 if missing or invisible). */
export async function findTaskWithAccess(db: PrismaClient, user: User, id: string) {
  const task = await db.task.findUnique({ where: { id } });
  if (!task) throw notFound('Task');
  return { task, access: await taskAccess(db, user, task) };
}

/** Sorts tasks like the List view: by section position (no section last), then task position. */
export function sortBySectionThenPosition<T extends { sectionId: string | null; position: number; createdAt: Date }>(
  tasks: T[],
  sectionPositions: Map<string, number>,
): T[] {
  const sectionPos = (t: T) => (t.sectionId ? (sectionPositions.get(t.sectionId) ?? Infinity) : Infinity);
  return [...tasks].sort(
    (a, b) =>
      sectionPos(a) - sectionPos(b) ||
      a.position - b.position ||
      a.createdAt.getTime() - b.createdAt.getTime(),
  );
}
