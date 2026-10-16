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

export async function notify(
  tx: Tx,
  type: NotificationType,
  actorId: string,
  taskId: string,
  recipientIds: string[],
) {
  // Nobody is notified about their own actions.
  const ids = [...new Set(recipientIds)].filter((id) => id !== actorId);
  if (ids.length === 0) return;
  await tx.notification.createMany({ data: ids.map((userId) => ({ userId, actorId, taskId, type })) });
}

/** Followers of a task, minus the actor (SPEC §3: COMMENTED / COMPLETED go to followers). */
export async function notifyFollowers(tx: Tx, type: NotificationType, actorId: string, taskId: string) {
  const followers = await tx.taskFollower.findMany({ where: { taskId }, select: { userId: true } });
  await notify(tx, type, actorId, taskId, followers.map((f) => f.userId));
}
