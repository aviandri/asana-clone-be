import type { FastifyInstance } from 'fastify';
import type { Comment, Prisma, Task } from '@prisma/client';
import { z } from 'zod';
import { forbidden, notFound, validation } from '../errors.js';
import { follow, notify } from '../lib/events.js';
import { extractMentionIds } from '../lib/mentions.js';
import { toUserSummary, userSummarySelect, type UserSummaryRow } from '../lib/serialize.js';
import { findTaskWithAccess, taskAccess } from '../lib/tasks.js';
import { idParams, parse, uuid } from '../lib/validate.js';
import {
  attachmentInclude,
  removeObjects,
  storageKeysOf,
  toAttachment,
  type AttachmentRow,
} from '../lib/attachments.js';

const body = z.string().trim().max(20_000);
const emptyBody = { path: ['body'], message: 'A comment needs text or an attachment' };

/** SPEC §13: up to 20 of the caller's drafts on this task; then the body may be empty. */
const NewComment = z
  .object({ body: body.default(''), attachmentIds: z.array(uuid).max(20).optional() })
  .transform((c) => ({ body: c.body, attachmentIds: [...new Set(c.attachmentIds ?? [])] }))
  .refine((c) => c.body.length > 0 || c.attachmentIds.length > 0, emptyBody);

const EditedComment = z.object({ body });

const commentInclude = {
  author: { select: userSummarySelect },
  attachments: { include: attachmentInclude, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.CommentInclude;

type CommentRow = Comment & { author: UserSummaryRow; attachments: AttachmentRow[] };

function toCommentStory(c: CommentRow) {
  return {
    kind: 'comment' as const,
    id: c.id,
    author: toUserSummary(c.author),
    body: c.body,
    attachments: c.attachments.map(toAttachment),
    createdAt: c.createdAt.toISOString(),
    editedAt: c.editedAt?.toISOString() ?? null,
  };
}

export default async function storyRoutes(app: FastifyInstance) {
  const db = app.db;

  /**
   * Users mentioned in `body` who are active and can see the task. Mentioning someone who can't
   * see the task notifies nobody, so the task's title doesn't leak. Mentioning someone outside the
   * task's workspace is rejected (SPEC §12).
   */
  async function mentionRecipients(task: Task, body: string, exclude: string[] = []) {
    const ids = extractMentionIds(body).filter((id) => !exclude.includes(id));
    if (ids.length === 0) return [];
    const outsiders = await db.user.count({
      where: { id: { in: ids }, workspaceMemberships: { none: { workspaceId: task.workspaceId, isActive: true } } },
    });
    if (outsiders > 0) {
      throw validation('Only members of this workspace can be mentioned', [
        { path: ['body'], message: 'Mentions someone outside this workspace' },
      ]);
    }
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
      db.comment.findMany({ where: { taskId: id }, include: commentInclude }),
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
    const { body, attachmentIds } = parse(NewComment, req.body);
    const { task } = await findTaskWithAccess(db, req.user, id);
    const actorId = req.user.id;
    const mentioned = await mentionRecipients(task, body);

    const comment = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const { id: commentId } = await tx.comment.create({ data: { taskId: id, authorId: actorId, body } });
      if (attachmentIds.length > 0) {
        // Each must still be the caller's draft on this task; claimed atomically, so two comments can't share one.
        const claimed = await tx.attachment.updateMany({
          where: { id: { in: attachmentIds }, draft: true, uploaderId: actorId, taskId: id },
          data: { draft: false, commentId },
        });
        if (claimed.count !== attachmentIds.length) {
          throw validation('Attachments must be your drafts on this task', [
            { path: ['attachmentIds'], message: 'Not a draft you uploaded to this task' },
          ]);
        }
      }
      const created = await tx.comment.findUniqueOrThrow({ where: { id: commentId }, include: commentInclude });
      await follow(tx, id, [actorId]);
      // Mentioned users get MENTIONED instead of COMMENTED, so each person gets one notification.
      const followers = await tx.taskFollower.findMany({ where: { taskId: id }, select: { userId: true } });
      await notify(tx, 'COMMENTED', actorId, task, followers.map((f) => f.userId).filter((u) => !mentioned.includes(u)));
      await notify(tx, 'MENTIONED', actorId, task, mentioned);
      return created;
    });
    return reply.status(201).send(toCommentStory(comment));
  });

  app.patch('/comments/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const { body } = parse(EditedComment, req.body);
    const existing = await findComment(id);
    await taskAccess(db, req.user, existing.task).catch(() => {
      throw notFound('Comment');
    });
    if (existing.authorId !== req.user.id) throw forbidden('Only the author can edit a comment');
    // Empty is fine only while the comment still has attachments (A9); edits never change them.
    if (body.length === 0 && (await db.attachment.count({ where: { commentId: id } })) === 0) {
      throw validation('Invalid request', [emptyBody]);
    }

    // Only people newly mentioned by the edit are notified.
    const newlyMentioned = await mentionRecipients(existing.task, body, extractMentionIds(existing.body));
    const comment = await db.$transaction(async (tx) => {
      const updated = await tx.comment.update({
        where: { id },
        data: { body, editedAt: new Date() },
        include: commentInclude,
      });
      await notify(tx, 'MENTIONED', req.user.id, existing.task, newlyMentioned);
      return updated;
    });
    return toCommentStory(comment);
  });

  app.delete('/comments/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const existing = await findComment(id);
    const { member } = await taskAccess(db, req.user, existing.task).catch(() => {
      throw notFound('Comment');
    });
    if (existing.authorId !== req.user.id && member.role !== 'ADMIN') {
      throw forbidden('Only the author or an admin can delete a comment');
    }
    const files = await storageKeysOf(db, { commentId: id });
    await db.comment.delete({ where: { id } }); // its attachments cascade
    await removeObjects(app.storage, files, req.log);
    return reply.status(204).send();
  });
}
