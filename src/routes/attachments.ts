import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import multipart, { type MultipartFile } from '@fastify/multipart';
import { Prisma } from '@prisma/client';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { AppError, forbidden, notFound, validation } from '../errors.js';
import {
  attachmentInclude,
  canDeleteAttachment,
  findVisibleAttachment,
  objectKeys,
  removeObjects,
  toAttachment,
} from '../lib/attachments.js';
import { recordActivity } from '../lib/events.js';
import { contentDisposition, sanitizeFilename } from '../lib/filenames.js';
import { contentType, isInline, isRasterImage, processImage, sniffMimeType, SNIFF_BYTES } from '../lib/media.js';
import { derivedKey, newStorageKey, type StorageDriver } from '../lib/storage.js';
import { findTaskWithAccess } from '../lib/tasks.js';
import { idParams, parse, queryBool } from '../lib/validate.js';

const UploadQuery = z.object({ draft: queryBool.optional() });
const ContentQuery = z.object({ download: z.enum(['1', 'true']).optional() });
const ThumbnailQuery = z.object({ size: z.enum(['small', 'large']).default('small') });

const UPLOAD_WINDOW_MS = 10 * 60 * 1000;

/** Uploads (files and links) per user in a sliding 10-minute window (SPEC §13, A5). In-process. */
export class UploadLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly max: number) {}

  /** Counts one upload; 429 once the user has `max` in the window. */
  hit(userId: string, now = Date.now()) {
    const recent = (this.hits.get(userId) ?? []).filter((t) => now - t < UPLOAD_WINDOW_MS);
    if (recent.length >= this.max) {
      const retry = Math.ceil((recent[0]! + UPLOAD_WINDOW_MS - now) / 60_000);
      this.hits.set(userId, recent);
      throw new AppError('RATE_LIMITED', `Too many uploads, try again in ${retry} minute${retry === 1 ? '' : 's'}`);
    }
    recent.push(now);
    this.hits.set(userId, recent);
  }
}

/**
 * Headers on every byte response (SPEC §13 Serving): files are user content on the app's own origin, so
 * the browser must never sniff them into HTML, run them, or let another origin embed them.
 */
function servingHeaders(reply: FastifyReply, etag: string) {
  reply
    .header('X-Content-Type-Options', 'nosniff')
    .header('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; media-src 'self'")
    .header('Cross-Origin-Resource-Policy', 'same-origin')
    .header('Cache-Control', 'private, max-age=0, must-revalidate')
    .header('ETag', etag);
}

/** True when If-None-Match names this (strong) ETag, or `*`. */
function notModified(req: FastifyRequest, etag: string) {
  const header = req.headers['if-none-match'];
  if (!header) return false;
  return header.split(',').some((tag) => {
    const t = tag.trim();
    return t === '*' || t === etag || t === `W/${etag}`;
  });
}

type RangeResult = { start: number; end: number } | 'unsatisfiable' | null;

/**
 * One `bytes=` range (RFC 9110). Several ranges, other units, junk or a stale If-Range get the whole file
 * (null); a range past the end is unsatisfiable.
 */
export function parseRange(header: string | undefined, size: number, ifRange: string | undefined, etag: string): RangeResult {
  if (!header) return null;
  if (ifRange !== undefined && ifRange.trim() !== etag) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, from, to] = match;
  if (from === '' && to === '') return null;
  if (from === '') {
    const suffix = Number(to);
    if (suffix === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(from);
  if (start >= size) return 'unsatisfiable';
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  if (end < start) return null;
  return { start, end };
}

export default async function attachmentRoutes(app: FastifyInstance) {
  const db = app.db;
  const storage: StorageDriver = app.storage;
  const maxBytes = app.config.MAX_UPLOAD_BYTES;
  const limiter = new UploadLimiter(app.config.UPLOAD_RATE_LIMIT_MAX);

  // Only this plugin's routes take multipart. Busboy's own cap sits one byte above ours, so the
  // storage meter (which deletes the partial file) is what rejects an oversized upload.
  await app.register(multipart, {
    // files: 2, so a second file reaches the route and gets a 400 (not busboy's generic limit error).
    limits: { fileSize: maxBytes + 1, files: 2, fields: 5, parts: 6, fieldSize: 1024, headerPairs: 100 },
  });

  /** Stores one uploaded part: bytes, sniffed type, sanitised name, and dimensions/thumbnails for images. */
  async function store(part: MultipartFile) {
    const key = newStorageKey();
    const keys = [key];
    try {
      const { size, sha256, head } = await storage.put(key, part.file, { maxBytes, headBytes: SNIFF_BYTES });
      const name = sanitizeFilename(part.filename);
      const mimeType = await sniffMimeType(head, name);
      let image = null;
      if (isRasterImage(mimeType)) {
        image = await processImage(storage.localPath ? storage.localPath(key) : await readAll(storage, key));
        if (image) {
          for (const [variant, bytes] of [['s', image.thumbnails.small], ['l', image.thumbnails.large]] as const) {
            const thumbKey = derivedKey(key, variant);
            keys.push(thumbKey);
            await storage.put(thumbKey, Readable.from(bytes));
          }
        }
      }
      return {
        file: { storageKey: key, size, sha256, name, mimeType, width: image?.width ?? null, height: image?.height ?? null, hasThumbnail: image !== null },
        keys,
      };
    } catch (err) {
      await removeObjects(storage, keys, app.log);
      throw err;
    }
  }

  // --- uploads -------------------------------------------------------------

  /**
   * One part `file`; a draft (for the comment composer) is marked with `?draft=true` (A3), so a commenter's
   * non-draft upload is refused before any byte is read. A multipart `draft` field is also honoured.
   */
  app.post('/tasks/:id/attachments', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const query = parse(UploadQuery, req.query);
    const { task, access } = await findTaskWithAccess(db, req.user, id);
    const commenterOnly = () => forbidden('Commenters can attach files to comments only');
    if (query.draft === false && !access.canEdit) throw commenterOnly();
    if (!req.isMultipart()) throw validation('Expected multipart/form-data with one part named "file"');
    limiter.hit(req.user.id);

    let draftField: boolean | undefined;
    let stored: Awaited<ReturnType<typeof store>> | undefined;
    try {
      for await (const part of req.parts()) {
        if (part.type === 'field') {
          if (part.fieldname === 'draft') draftField = part.value === 'true';
          continue;
        }
        if (part.fieldname !== 'file' || stored) {
          part.file.resume();
          throw validation('Send exactly one part named "file"', [{ path: ['file'], message: 'One file per upload' }]);
        }
        // Decidable now unless the draft flag can still arrive after the file.
        if (!access.canEdit && (query.draft ?? draftField) === false) throw commenterOnly();
        stored = await store(part);
      }
      if (!stored) throw validation('Send exactly one part named "file"', [{ path: ['file'], message: 'Required' }]);
      const draft = query.draft ?? draftField ?? false;
      if (!draft && !access.canEdit) throw commenterOnly();

      const file = stored.file;
      const attachment = await db.$transaction(async (tx) => {
        const created = await tx.attachment.create({
          data: { workspaceId: task.workspaceId, taskId: task.id, uploaderId: req.user.id, kind: 'FILE', draft, ...file },
          include: attachmentInclude,
        });
        if (!draft) {
          await recordActivity(tx, task.id, req.user.id, 'ATTACHMENT_ADDED', { attachmentId: created.id, kind: 'FILE', name: file.name });
          await tx.task.update({ where: { id: task.id }, data: { updatedAt: new Date() } });
        }
        return created;
      });
      return reply.status(201).send(toAttachment(attachment));
    } catch (err) {
      if (stored) await removeObjects(storage, stored.keys, app.log);
      // The task was deleted while the file streamed in.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') throw notFound('Task');
      throw err;
    }
  });

  // --- reads (ID-addressed: X-Workspace-Id plays no part, so <img>/<video> work) ---

  app.get('/attachments/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const { attachment } = await findVisibleAttachment(db, req.user, id);
    return toAttachment(attachment);
  });

  app.get('/attachments/:id/content', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const { download } = parse(ContentQuery, req.query);
    const { attachment } = await findVisibleAttachment(db, req.user, id);
    const { storageKey, sha256, mimeType, size, name } = attachment;
    if (attachment.kind !== 'FILE' || !storageKey || !sha256 || !mimeType || size === null || !name) {
      throw notFound('Attachment');
    }
    const etag = `"${sha256}"`;
    servingHeaders(reply, etag);
    const disposition = !download && isInline(mimeType) ? 'inline' : 'attachment';
    reply
      .header('Content-Type', contentType(mimeType))
      .header('Content-Disposition', contentDisposition(disposition, name))
      .header('Accept-Ranges', 'bytes');
    if (notModified(req, etag)) return reply.status(304).send();

    const ifRange = req.headers['if-range'];
    const range = parseRange(req.headers.range, size, Array.isArray(ifRange) ? ifRange[0] : ifRange, etag);
    if (range === 'unsatisfiable') {
      return reply.status(416).header('Content-Range', `bytes */${size}`).send();
    }
    if (range) {
      return reply
        .status(206)
        .header('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
        .header('Content-Length', range.end - range.start + 1)
        .send(storage.get(storageKey, range));
    }
    return reply.header('Content-Length', size).send(size === 0 ? '' : storage.get(storageKey));
  });

  app.get('/attachments/:id/thumbnail', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const { size } = parse(ThumbnailQuery, req.query);
    const { attachment } = await findVisibleAttachment(db, req.user, id);
    if (attachment.kind !== 'FILE' || !attachment.hasThumbnail || !attachment.storageKey) throw notFound('Thumbnail');
    const variant = size === 'small' ? 's' : 'l';
    const key = derivedKey(attachment.storageKey, variant);
    const object = await storage.stat(key);
    if (!object) throw notFound('Thumbnail');
    const etag = `"${attachment.sha256}-${variant}"`;
    servingHeaders(reply, etag);
    reply.header('Content-Type', 'image/webp').header('Content-Disposition', 'inline');
    if (notModified(req, etag)) return reply.status(304).send();
    return reply.header('Content-Length', object.size).send(storage.get(key));
  });

  // --- delete ----------------------------------------------------------------

  app.delete('/attachments/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const { attachment, access } = await findVisibleAttachment(db, req.user, id);
    if (!(await canDeleteAttachment(db, req.user, attachment, access))) {
      throw forbidden('Only the uploader, a project owner or an admin can delete an attachment');
    }
    const taskLevel = !attachment.draft && attachment.commentId === null;
    await db.$transaction(async (tx) => {
      await tx.attachment.delete({ where: { id } });
      if (taskLevel) {
        const name = attachment.kind === 'FILE' ? attachment.name : (attachment.title ?? attachment.url);
        await recordActivity(tx, attachment.taskId, req.user.id, 'ATTACHMENT_REMOVED', { kind: attachment.kind, name });
        await tx.task.update({ where: { id: attachment.taskId }, data: { updatedAt: new Date() } });
      }
    });
    // After the commit: a rollback must never leave a row without its file.
    await removeObjects(storage, objectKeys(attachment), req.log);
    return reply.status(204).send();
  });
}

/** For drivers without local files: the whole object in memory (images only, ≤ MAX_UPLOAD_BYTES). */
async function readAll(storage: StorageDriver, key: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of storage.get(key)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
