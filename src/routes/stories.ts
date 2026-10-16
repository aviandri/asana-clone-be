import type { FastifyInstance } from 'fastify';
import type { Comment, Prisma, Task } from '@prisma/client';
import { z } from 'zod';
import { forbidden, notFound } from '../errors.js';
import { follow, notify } from '../lib/events.js';
import { extractMentionIds } from '../lib/mentions.js';
import { toUserSummary, userSummarySelect, type UserSummaryRow } from '../lib/serialize.js';
import { findTaskWithAccess, taskAccess } from '../lib/tasks.js';
import { idParams, parse } from '../lib/validate.js';

const CommentBody = z.object({ body: z.string().trim().min(1).max(20_000) });

function toCommentStory(c: Comment & { author: UserSummaryRow }) {
  return {
    kind: 'comment' as const,
    id: c.id,
    author: toUserSummary(c.author),
    body: c.body,
    createdAt: c.createdAt.toISOString(),
    editedAt: c.editedAt?.toISOString() ?? null,
  };
}

export default async function storyRoutes(app: FastifyInstance) {
  const db = app.db;

  /**
   * Users mentioned in `body` who are active and can see the task. Mentioning someone who can't
   * see the task notifies nobody, so the task's title doesn't leak.
   */
  async function mentionRecipients(task: Task, body: string, exclude: string[] = []) {
    const ids = extractMentionIds(body).filter((id) => !exclude.includes(id));
    if (ids.length === 0) return [];
    const users = await db.user.findMany({ where: { id: { in: ids }, isActive: true } });
    const allowed = await Promise.all(
      users.map((u) => taskAccess(db, u, task).then(() => u.id, () => null)),
    );
    return allowed.filter((id): id is string => id !== null);
  }

  async function findComment(id: string) {
    const comment = await db.comment.findUnique({ where: { id }, include: { task: true } });
    if (!comment) throw notFound('Comment');
    return comment;
  }

  app.get('/tasks/:id/stories', async (req) => {
    const { id } = parse(idParams, req.params);
    await findTaskWithAccess(db, req.user, id);
    const [comments, activities] = await Promise.all([
      db.comment.findMany({ where: { taskId: id }, include: { author: { select: userSummarySelect } } }),
      db.activity.findMany({ where: { taskId: id }, include: { actor: { select: userSummarySelect } } }),
    ]);
    const stories = [
      ...comments.map(toCommentStory),
      ...activities.map((a) => ({
        kind: 'activity' as const,
        id: a.id,
        actor: toUserSummary(a.actor),
        type: a.type,
        data: a.data,
        createdAt: a.createdAt.toISOString(),
      })),
    ];
    // ISO strings sort chronologically. Ties put activity before comment, then sort by id for stability.
    stories.sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) ||
        (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === 'activity' ? -1 : 1),
    );
    return { data: stories };
  });

  // Commenting only needs visibility, so COMMENTERs can comment.
  app.post('/tasks/:id/comments', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const { body } = parse(CommentBody, req.body);
    const { task } = await findTaskWithAccess(db, req.user, id);
    const actorId = req.user.id;
    const mentioned = await mentionRecipients(task, body);

    const comment = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const created = await tx.comment.create({
        data: { taskId: id, authorId: actorId, body },
        include: { author: { select: userSummarySelect } },
      });
      await follow(tx, id, [actorId]);
      // Mentioned users get MENTIONED instead of COMMENTED, so each person gets one notification.
      const followers = await tx.taskFollower.findMany({ where: { taskId: id }, select: { userId: true } });
      await notify(tx, 'COMMENTED', actorId, id, followers.map((f) => f.userId).filter((u) => !mentioned.includes(u)));
      await notify(tx, 'MENTIONED', actorId, id, mentioned);
      return created;
    });
    return reply.status(201).send(toCommentStory(comment));
  });

  app.patch('/comments/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const { body } = parse(CommentBody, req.body);
    const existing = await findComment(id);
    await taskAccess(db, req.user, existing.task).catch(() => {
      throw notFound('Comment');
    });
    if (existing.authorId !== req.user.id) throw forbidden('Only the author can edit a comment');

    // Only people newly mentioned by the edit are notified.
    const newlyMentioned = await mentionRecipients(existing.task, body, extractMentionIds(existing.body));
    const comment = await db.$transaction(async (tx) => {
      const updated = await tx.comment.update({
        where: { id },
        data: { body, editedAt: new Date() },
        include: { author: { select: userSummarySelect } },
      });
      await notify(tx, 'MENTIONED', req.user.id, existing.taskId, newlyMentioned);
      return updated;
    });
    return toCommentStory(comment);
  });

  app.delete('/comments/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const existing = await findComment(id);
    await taskAccess(db, req.user, existing.task).catch(() => {
      throw notFound('Comment');
    });
    if (existing.authorId !== req.user.id && req.user.role !== 'ADMIN') {
      throw forbidden('Only the author or an admin can delete a comment');
    }
    await db.comment.delete({ where: { id } });
    return reply.status(204).send();
  });
}
