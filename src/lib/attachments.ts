import type { Attachment, Prisma, PrismaClient, Task, User } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { notFound } from '../errors.js';
import { projectAccess } from './access.js';
import { baseKey, derivedKey, type StorageDriver } from './storage.js';
import { taskAccess, type TaskAccess } from './tasks.js';
import { toUserSummary, userSummarySelect, type UserSummaryRow } from './serialize.js';

type Db = PrismaClient | Prisma.TransactionClient;

export const attachmentInclude = { uploader: { select: userSummarySelect } } satisfies Prisma.AttachmentInclude;

export type AttachmentRow = Attachment & { uploader: UserSummaryRow };

const API = '/api/v1';

/** The `Attachment` shape (SPEC §13). Storage keys never leave the server. */
export function toAttachment(a: AttachmentRow) {
  const file = a.kind === 'FILE';
  return {
    id: a.id,
    workspaceId: a.workspaceId,
    taskId: a.taskId,
    commentId: a.commentId,
    kind: a.kind,
    draft: a.draft,
    uploader: toUserSummary(a.uploader),
    createdAt: a.createdAt.toISOString(),
    name: file ? a.name : null,
    mimeType: file ? a.mimeType : null,
    size: file ? a.size : null,
    width: file ? a.width : null,
    height: file ? a.height : null,
    hasThumbnail: file && a.hasThumbnail,
    url: file ? null : a.url,
    title: file ? null : a.title,
    description: file ? null : a.description,
    siteName: file ? null : a.siteName,
    provider: file ? null : a.provider,
    previewStatus: file ? null : a.previewStatus,
    hasIcon: !file && a.iconKey !== null,
    hasImage: !file && a.imageKey !== null,
    contentPath: file ? `${API}/attachments/${a.id}/content` : null,
    thumbnailPath: file && a.hasThumbnail ? `${API}/attachments/${a.id}/thumbnail` : null,
    // A11: the server-cached favicon / og:image of a LINK.
    iconPath: !file && a.iconKey !== null ? `${API}/attachments/${a.id}/icon` : null,
    imagePath: !file && a.imageKey !== null ? `${API}/attachments/${a.id}/image` : null,
  };
}

/** Visible attachments of a task for a caller: every non-draft one, plus the caller's own drafts. */
export function visibleAttachmentsWhere(userId: string): Prisma.AttachmentWhereInput {
  return { OR: [{ draft: false }, { uploaderId: userId }] };
}

/**
 * An attachment the caller may see (SPEC §13): ID-addressed, so the X-Workspace-Id header plays no part.
 * Visible iff the caller can see its task as an active member of the task's workspace; drafts only to
 * their uploader. Everything else is 404, so existence never leaks.
 */
export async function findVisibleAttachment(
  db: PrismaClient,
  user: User,
  id: string,
): Promise<{ attachment: AttachmentRow & { task: Task }; access: TaskAccess }> {
  const attachment = await db.attachment.findUnique({ where: { id }, include: { ...attachmentInclude, task: true } });
  if (!attachment) throw notFound('Attachment');
  if (attachment.draft && attachment.uploaderId !== user.id) throw notFound('Attachment');
  const access = await taskAccess(db, user, attachment.task).catch(() => {
    throw notFound('Attachment');
  });
  return { attachment, access };
}

/**
 * Who may delete (SPEC §13, A7): the uploader, a workspace ADMIN, and the project's OWNER, or for a
 * personal task its creator.
 */
export async function canDeleteAttachment(
  db: PrismaClient,
  user: User,
  attachment: Attachment & { task: Task },
  access: TaskAccess,
): Promise<boolean> {
  if (attachment.uploaderId === user.id || access.member.role === 'ADMIN') return true;
  if (!attachment.task.projectId) return attachment.task.creatorId === user.id;
  const project = await projectAccess(db, user, attachment.task.projectId);
  return project.canManage;
}

/** Every storage object behind some attachments (files, thumbnails, link images). */
export async function storageKeysOf(db: Db, where: Prisma.AttachmentWhereInput): Promise<string[]> {
  const rows = await db.attachment.findMany({
    where,
    select: { storageKey: true, hasThumbnail: true, iconKey: true, imageKey: true },
  });
  return rows.flatMap(objectKeys);
}

export function objectKeys(a: Pick<Attachment, 'storageKey' | 'hasThumbnail' | 'iconKey' | 'imageKey'>): string[] {
  const keys: string[] = [];
  if (a.storageKey) {
    keys.push(a.storageKey);
    if (a.hasThumbnail) keys.push(derivedKey(a.storageKey, 's'), derivedKey(a.storageKey, 'l'));
  }
  if (a.iconKey) keys.push(a.iconKey);
  if (a.imageKey) keys.push(a.imageKey);
  return keys;
}

/**
 * Deletes objects whose rows are gone. Called AFTER the commit that removed the rows (SPEC §13); a failure
 * only leaves an orphan, which the sweeper removes later.
 */
export async function removeObjects(storage: StorageDriver, keys: string[], log?: FastifyBaseLogger) {
  await Promise.all(
    keys.map((key) =>
      storage.delete(key).catch((err: unknown) => log?.warn({ err }, 'Could not delete an attachment file; the sweeper will retry')),
    ),
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The hourly sweep (SPEC §13): drafts older than 24 h (never posted with a comment), then storage objects
 * older than 24 h with no row (a crash between write and commit, a failed post-commit delete). The age
 * guard keeps uploads in progress safe.
 */
export async function sweepAttachments(db: PrismaClient, storage: StorageDriver, now = new Date(), log?: FastifyBaseLogger) {
  const cutoff = new Date(now.getTime() - DAY_MS);

  const candidates = await db.attachment.findMany({
    where: { draft: true, createdAt: { lt: cutoff } },
    select: { id: true, storageKey: true, hasThumbnail: true, iconKey: true, imageKey: true },
  });
  // One row at a time, and only while it's STILL an old draft: a comment posted meanwhile claims it (it
  // stops being a draft), and its files must stay. Files go only for rows this sweep really deleted.
  let drafts = 0;
  for (const row of candidates) {
    const { count } = await db.attachment.deleteMany({ where: { id: row.id, draft: true, createdAt: { lt: cutoff } } });
    if (count === 1) {
      drafts += 1;
      await removeObjects(storage, objectKeys(row), log);
    }
  }

  // Orphans: collect old objects, then ask the DB which of their base keys still have a row.
  const old: string[] = [];
  for await (const object of storage.list()) {
    if (object.modifiedAt < cutoff) old.push(object.key);
  }
  let orphans = 0;
  for (let i = 0; i < old.length; i += 500) {
    const batch = old.slice(i, i + 500);
    const bases = [...new Set(batch.map(baseKey))];
    const rows = await db.attachment.findMany({
      where: { OR: [{ storageKey: { in: bases } }, { iconKey: { in: bases } }, { imageKey: { in: bases } }] },
      select: { storageKey: true, iconKey: true, imageKey: true },
    });
    const live = new Set(rows.flatMap((r) => [r.storageKey, r.iconKey, r.imageKey]));
    const dead = batch.filter((key) => !live.has(baseKey(key)));
    orphans += dead.length;
    await removeObjects(storage, dead, log);
  }

  await storage.sweepTemps?.(cutoff);
  return { drafts, orphans };
}
