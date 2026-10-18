import type { ActivityType, NotificationType, Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

export function recordActivity(
  tx: Tx,
  taskId: string,
  actorId: string,
  type: ActivityType,
  data: Prisma.InputJsonObject = {},
) {
  return tx.activity.create({ data: { taskId, actorId, type, data } });
}

/** Adds followers, ignoring ones that already follow. */
export async function follow(tx: Tx, taskId: string, userIds: (string | null | undefined)[]) {
  const ids = [...new Set(userIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return;
  await tx.taskFollower.createMany({ data: ids.map((userId) => ({ taskId, userId })), skipDuplicates: true });
}

type TaskRef = { id: string; workspaceId: string };

/** Notifications live in the task's workspace (SPEC §12). */
export async function notify(tx: Tx, type: NotificationType, actorId: string, task: TaskRef, recipientIds: string[]) {
  // Nobody is notified about their own actions.
  const ids = [...new Set(recipientIds)].filter((id) => id !== actorId);
  if (ids.length === 0) return;
  await tx.notification.createMany({
    data: ids.map((userId) => ({ userId, actorId, taskId: task.id, workspaceId: task.workspaceId, type })),
  });
}

/** Followers of a task, minus the actor (SPEC §3: COMMENTED / COMPLETED go to followers). */
export async function notifyFollowers(tx: Tx, type: NotificationType, actorId: string, task: TaskRef) {
  const followers = await tx.taskFollower.findMany({ where: { taskId: task.id }, select: { userId: true } });
  await notify(tx, type, actorId, task, followers.map((f) => f.userId));
}
