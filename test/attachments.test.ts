import { rm } from 'node:fs/promises';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { User } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { sweepAttachments } from '../src/lib/attachments.js';
import { derivedKey, DiskStorage } from '../src/lib/storage.js';
import { addMember, createUser, defaultWorkspaceId, login, prisma, setupApp, signedIn } from './helpers.js';

const ctx = setupApp();
const storage = () => ctx.app.storage as DiskStorage;

type Session = { user: User; cookie: string };
let alice: Session; // project owner
let bob: Session; // team member (editor)
let carol: Session; // COMMENTER
let outsider: Session; // only in another workspace
let projectId: string;
let taskId: string;

let png: Buffer;
const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

beforeAll(async () => {
  png = await sharp({ create: { width: 640, height: 400, channels: 3, background: '#e8384f' } }).png().toBuffer();
});

beforeEach(async () => {
  await rm(storage().root, { recursive: true, force: true });
  alice = await signedIn(ctx.app, { name: 'Alice' });
  bob = await signedIn(ctx.app, { name: 'Bob' });
  carol = await signedIn(ctx.app, { name: 'Carol' });
  const elsewhere = await prisma.workspace.create({ data: { name: 'Elsewhere', color: '#000000' } });
  outsider = await signedIn(ctx.app, { name: 'Outsider', workspaceId: elsewhere.id });
  const team = await prisma.team.create({
    data: {
      workspaceId: await defaultWorkspaceId(),
      name: 'Eng',
      members: { create: [{ userId: alice.user.id }, { userId: bob.user.id }, { userId: carol.user.id }] },
    },
  });
  const project = await req(alice, 'POST', '/projects', { teamId: team.id, name: 'Website' });
  projectId = project.json().id;
  await prisma.projectMember.create({ data: { projectId, userId: carol.user.id, role: 'COMMENTER' } });
  const task = await req(alice, 'POST', '/tasks', { projectId, title: 'Launch' });
  taskId = task.json().id;
});

function req(s: Session, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object, headers = {}) {
  return ctx.app.inject({ method, url: `/api/v1${url}`, headers: { cookie: s.cookie, ...headers }, payload });
}

type Part = { name: string; filename?: string; contentType?: string; data: Buffer | string };

/** A multipart/form-data body, built by hand so tests control every header (spoofed types included). */
function multipart(parts: Part[]) {
  const boundary = '----mekari-test-boundary';
  const chunks: Buffer[] = [];
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename !== undefined) head += `; filename="${p.filename}"`;
    head += '\r\n';
    if (p.contentType) head += `Content-Type: ${p.contentType}\r\n`;
    chunks.push(Buffer.from(`${head}\r\n`), Buffer.from(p.data), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

function upload(s: Session, task: string, file: Omit<Part, 'name'>, query = '', extra: Part[] = []) {
  const body = multipart([...extra, { name: 'file', ...file }]);
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/tasks/${task}/attachments${query}`,
    headers: { cookie: s.cookie, ...body.headers },
    payload: body.payload,
  });
}

async function uploaded(s: Session, file: Omit<Part, 'name'>, query = '') {
  const res = await upload(s, taskId, file, query);
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function keysOf(id: string) {
  const row = await prisma.attachment.findUniqueOrThrow({ where: { id } });
  return { key: row.storageKey!, row };
}

describe('uploads (SPEC §13)', () => {
  it('stores a file with a sniffed type, dimensions, thumbnails and activity', async () => {
    const a = await uploaded(alice, { filename: 'mock.png', contentType: 'application/octet-stream', data: png });
    expect(a).toMatchObject({
      kind: 'FILE',
      taskId,
      commentId: null,
      draft: false,
      name: 'mock.png',
      mimeType: 'image/png',
      size: png.length,
      width: 640,
      height: 400,
      hasThumbnail: true,
      url: null,
      previewStatus: null,
      hasIcon: false,
      contentPath: `/api/v1/attachments/${a.id}/content`,
      thumbnailPath: `/api/v1/attachments/${a.id}/thumbnail`,
      iconPath: null,
      imagePath: null,
    });
    expect(a.uploader.id).toBe(alice.user.id);
    expect(JSON.stringify(a)).not.toMatch(/storageKey|sha256/);
    const { key, row } = await keysOf(a.id);
    expect(key).toMatch(/^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f-]{36}$/);
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await storage().stat(derivedKey(key, 's'))).not.toBeNull();

    const detail = (await req(bob, 'GET', `/tasks/${taskId}`)).json();
    expect(detail.attachmentCount).toBe(1);
    expect(detail.attachments.map((x: { id: string }) => x.id)).toEqual([a.id]);
    const stories = (await req(bob, 'GET', `/tasks/${taskId}/stories`)).json().data;
    expect(stories.at(-1)).toMatchObject({ type: 'ATTACHMENT_ADDED', data: { attachmentId: a.id, kind: 'FILE', name: 'mock.png' } });

    const small = await req(bob, 'GET', `/attachments/${a.id}/thumbnail`);
    expect(small.statusCode).toBe(200);
    expect(small.headers['content-type']).toBe('image/webp');
    const meta = await sharp(small.rawPayload).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBe(240);
    const large = await req(bob, 'GET', `/attachments/${a.id}/thumbnail?size=large`);
    expect((await sharp(large.rawPayload).metadata()).width).toBe(640); // never enlarged
  });

  it('ignores the client-sent Content-Type: bytes decide', async () => {
    const disguisedImage = await uploaded(alice, { filename: 'shot.png', contentType: 'text/html', data: png });
    expect(disguisedImage.mimeType).toBe('image/png');
    const disguisedPage = await uploaded(alice, {
      filename: 'cat.png',
      contentType: 'image/png',
      data: '<html><script>alert(document.cookie)</script></html>',
    });
    expect(disguisedPage.mimeType).toBe('application/octet-stream');
    expect(disguisedPage.hasThumbnail).toBe(false);
    const notes = await uploaded(alice, { filename: 'notes.md', contentType: 'image/png', data: '# Notes' });
    expect(notes.mimeType).toBe('text/plain');
  });

  it('sanitises filenames: bidi controls, control characters, paths, length', async () => {
    const bidi = await uploaded(alice, { filename: 'invoice\u202Egpj.exe', data: 'MZ' });
    expect(bidi.name).toBe('invoicegpj.exe');
    const controls = await uploaded(alice, { filename: 'C:\\Users\\me\\re\u200Fport \u0007  final\u2066.txt', data: 'x' });
    expect(controls.name).toBe('report final.txt');
    const long = await uploaded(alice, { filename: `${'é'.repeat(200)}.pdf`, data: pdf });
    expect(Buffer.byteLength(long.name, 'utf8')).toBeLessThanOrEqual(255);
    expect(long.name.endsWith('.pdf')).toBe(true);
    expect(long.mimeType).toBe('application/pdf');
    const empty = await uploaded(alice, { filename: '\u202E', data: 'x' });
    expect(empty.name).toBe('file');
  });

  it('rejects more than MAX_UPLOAD_BYTES with 413 and leaves nothing behind', async () => {
    const small = await buildApp({ config: { ...loadConfig(), MAX_UPLOAD_BYTES: 1024 }, prisma, logger: false });
    try {
      const body = multipart([{ name: 'file', filename: 'big.bin', data: Buffer.alloc(4096, 1) }]);
      const res = await small.inject({
        method: 'POST',
        url: `/api/v1/tasks/${taskId}/attachments`,
        headers: { cookie: alice.cookie, ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode, res.body).toBe(413);
      expect(res.json().error.code).toBe('PAYLOAD_TOO_LARGE');
      expect(await prisma.attachment.count()).toBe(0);
      const objects = [];
      for await (const o of storage().list()) objects.push(o);
      expect(objects).toEqual([]);
    } finally {
      await small.close();
    }
  });

  it('needs exactly one part named file', async () => {
    const none = multipart([{ name: 'draft', data: 'true' }]);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/attachments`,
      headers: { cookie: alice.cookie, ...none.headers },
      payload: none.payload,
    });
    expect(res.statusCode).toBe(400);
    const json = await req(alice, 'POST', `/tasks/${taskId}/attachments`, { file: 'x' });
    expect(json.statusCode).toBe(400);
    const two = multipart([
      { name: 'file', filename: 'a.txt', data: 'a' },
      { name: 'file', filename: 'b.txt', data: 'b' },
    ]);
    const twoRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/attachments`,
      headers: { cookie: alice.cookie, ...two.headers },
      payload: two.payload,
    });
    expect(twoRes.statusCode, twoRes.body).toBe(400);
    expect(await prisma.attachment.count(), 'neither is kept').toBe(0);
    const objects = [];
    for await (const o of storage().list()) objects.push(o);
    expect(objects).toEqual([]);
  });

  it('rate-limits uploads per user', async () => {
    const limited = await buildApp({ config: { ...loadConfig(), UPLOAD_RATE_LIMIT_MAX: 2 }, prisma, logger: false });
    try {
      const send = (s: Session) => {
        const body = multipart([{ name: 'file', filename: 'a.txt', data: 'a' }]);
        return limited.inject({
          method: 'POST',
          url: `/api/v1/tasks/${taskId}/attachments`,
          headers: { cookie: s.cookie, ...body.headers },
          payload: body.payload,
        });
      };
      expect((await send(alice)).statusCode).toBe(201);
      expect((await send(alice)).statusCode).toBe(201);
      const third = await send(alice);
      expect(third.statusCode).toBe(429);
      expect(third.json().error.code).toBe('RATE_LIMITED');
      expect((await send(bob)).statusCode, 'per user').toBe(201);
    } finally {
      await limited.close();
    }
  });
});

describe('the Attachment shape', () => {
  it('serializes a LINK with its preview fields and server-built paths (A11)', async () => {
    const link = await prisma.attachment.create({
      data: {
        workspaceId: await defaultWorkspaceId(),
        taskId,
        uploaderId: alice.user.id,
        kind: 'LINK',
        url: 'https://www.figma.com/file/x/Mockups',
        title: 'Mockups',
        siteName: 'Figma',
        provider: 'figma',
        previewStatus: 'READY',
        iconKey: 'aa/bb/aabb0000-0000-4000-8000-000000000001',
      },
    });
    const res = (await req(bob, 'GET', `/attachments/${link.id}`)).json();
    expect(res).toMatchObject({
      kind: 'LINK',
      url: 'https://www.figma.com/file/x/Mockups',
      title: 'Mockups',
      provider: 'figma',
      previewStatus: 'READY',
      hasIcon: true,
      hasImage: false,
      iconPath: `/api/v1/attachments/${link.id}/icon`,
      imagePath: null,
      name: null,
      mimeType: null,
      size: null,
      hasThumbnail: false,
      contentPath: null,
      thumbnailPath: null,
    });
    expect((await req(bob, 'GET', `/attachments/${link.id}/content`)).statusCode, 'a link has no bytes').toBe(404);
  });
});

describe('serving (SPEC §13: user content on our origin)', () => {
  const SANDBOX = "sandbox; default-src 'none'; img-src 'self'; media-src 'self'";

  it('serves HTML and SVG as downloads in a sandbox, never sniffed', async () => {
    const html = await uploaded(alice, { filename: 'page.html', contentType: 'text/html', data: '<h1>hi</h1>' });
    const svg = await uploaded(alice, {
      filename: 'logo.svg',
      contentType: 'image/svg+xml',
      data: '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
    });
    for (const a of [html, svg]) {
      const res = await req(bob, 'GET', `/attachments/${a.id}/content`);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-disposition']).toMatch(/^attachment; /);
      expect(res.headers['content-type']).toBe('application/octet-stream');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toBe(SANDBOX);
      expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
      expect(res.headers['cache-control']).toBe('private, max-age=0, must-revalidate');
    }
    expect(svg.hasThumbnail).toBe(false);
  });

  it('serves allowlisted types inline, with an RFC 6266 filename, and downloads on request', async () => {
    const a = await uploaded(alice, { filename: 'Résumé (final) 100%.pdf', data: pdf });
    const inline = await req(bob, 'GET', `/attachments/${a.id}/content`);
    expect(inline.headers['content-type']).toBe('application/pdf');
    expect(inline.headers['content-disposition']).toBe(
      `inline; filename="R_sum_ (final) 100_.pdf"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%28final%29%20100%25.pdf`,
    );
    expect(inline.headers['content-security-policy']).toBe(SANDBOX);
    expect(inline.rawPayload.equals(pdf)).toBe(true);
    const download = await req(bob, 'GET', `/attachments/${a.id}/content?download=1`);
    expect(download.headers['content-disposition']).toMatch(/^attachment; /);

    const text = await uploaded(alice, { filename: 'log.txt', data: 'héllo' });
    const res = await req(bob, 'GET', `/attachments/${text.id}/content`);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(/^inline; /);
  });

  it('answers Range requests with 206 and validates with a strong ETag', async () => {
    const a = await uploaded(alice, { filename: 'mock.png', data: png });
    const full = await req(bob, 'GET', `/attachments/${a.id}/content`);
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(Number(full.headers['content-length'])).toBe(png.length);
    const etag = full.headers.etag as string;
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);

    const part = await req(bob, 'GET', `/attachments/${a.id}/content`, undefined, { range: 'bytes=10-19' });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 10-19/${png.length}`);
    expect(part.rawPayload.equals(png.subarray(10, 20))).toBe(true);

    const tail = await req(bob, 'GET', `/attachments/${a.id}/content`, undefined, { range: 'bytes=-5' });
    expect(tail.rawPayload.equals(png.subarray(png.length - 5))).toBe(true);

    const beyond = await req(bob, 'GET', `/attachments/${a.id}/content`, undefined, { range: `bytes=${png.length}-` });
    expect(beyond.statusCode).toBe(416);
    expect(beyond.headers['content-range']).toBe(`bytes */${png.length}`);

    const stale = await req(bob, 'GET', `/attachments/${a.id}/content`, undefined, { range: 'bytes=0-1', 'if-range': '"old"' });
    expect(stale.statusCode, 'a changed file is sent whole').toBe(200);

    const cached = await req(bob, 'GET', `/attachments/${a.id}/content`, undefined, { 'if-none-match': etag });
    expect(cached.statusCode).toBe(304);
    expect(cached.headers['x-content-type-options']).toBe('nosniff');
  });

  it('serves an empty file, and keeps the §13 headers on 416, 304 and errors', async () => {
    const empty = await uploaded(alice, { filename: 'empty.txt', data: '' });
    expect(empty.size).toBe(0);
    const whole = await req(bob, 'GET', `/attachments/${empty.id}/content`);
    expect(whole.statusCode).toBe(200);
    expect(whole.headers['content-length']).toBe('0');
    expect(whole.rawPayload.length).toBe(0);
    // The web text preview's first request.
    const ranged = await req(bob, 'GET', `/attachments/${empty.id}/content`, undefined, { range: 'bytes=0-1048575' });
    expect(ranged.statusCode).toBe(416);
    expect(ranged.headers['content-range']).toBe('bytes */0');
    const cached = await req(bob, 'GET', `/attachments/${empty.id}/content`, undefined, { 'if-none-match': whole.headers.etag as string });
    expect(cached.statusCode).toBe(304);
    const missing = await req(bob, 'GET', '/attachments/00000000-0000-4000-8000-000000000000/content');
    const badId = await req(bob, 'GET', '/attachments/not-a-uuid/thumbnail');
    const noThumb = await req(bob, 'GET', `/attachments/${empty.id}/thumbnail`);
    expect([missing.statusCode, badId.statusCode, noThumb.statusCode]).toEqual([404, 400, 404]);
    for (const res of [whole, ranged, cached, missing, badId, noThumb]) {
      expect(res.headers['x-content-type-options'], String(res.statusCode)).toBe('nosniff');
      expect(res.headers['content-security-policy']).toBe(SANDBOX);
      expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
      expect(res.headers['cache-control']).toBe('private, max-age=0, must-revalidate');
    }
  });

  it('ignores X-Workspace-Id on ID-addressed reads, and hides attachments from other workspaces', async () => {
    const a = await uploaded(alice, { filename: 'mock.png', data: png });
    const elsewhere = await prisma.workspace.findFirstOrThrow({ where: { name: 'Elsewhere' } });
    const withHeader = await req(bob, 'GET', `/attachments/${a.id}/content`, undefined, { 'x-workspace-id': elsewhere.id });
    expect(withHeader.statusCode).toBe(200);
    for (const path of ['', '/content', '/thumbnail']) {
      expect((await req(outsider, 'GET', `/attachments/${a.id}${path}`)).statusCode).toBe(404);
    }
    expect((await req(outsider, 'DELETE', `/attachments/${a.id}`)).statusCode).toBe(404);
    expect((await upload(outsider, taskId, { filename: 'x.txt', data: 'x' })).statusCode).toBe(404);
    // A member of both who isn't in the project's team can't see it either.
    const visitor = await signedIn(ctx.app, { name: 'Visitor' });
    expect((await req(visitor, 'GET', `/attachments/${a.id}`)).statusCode).toBe(404);
  });
});

describe('drafts and comments', () => {
  it('shows a draft only to its uploader and keeps it out of counts and activity', async () => {
    const draft = await uploaded(bob, { filename: 'wip.png', data: png }, '?draft=true');
    expect(draft.draft).toBe(true);
    for (const s of [alice, carol]) {
      for (const path of ['', '/content', '/thumbnail']) {
        expect((await req(s, 'GET', `/attachments/${draft.id}${path}`)).statusCode).toBe(404);
      }
    }
    expect((await req(alice, 'DELETE', `/attachments/${draft.id}`)).statusCode, 'even the owner can’t see it').toBe(404);
    expect((await req(bob, 'GET', `/attachments/${draft.id}/content`)).statusCode).toBe(200);
    const detail = (await req(bob, 'GET', `/tasks/${taskId}`)).json();
    expect(detail.attachmentCount).toBe(0);
    expect(detail.attachments).toEqual([]);
    const stories = (await req(bob, 'GET', `/tasks/${taskId}/stories`)).json().data;
    expect(stories.some((s: { type?: string }) => s.type === 'ATTACHMENT_ADDED')).toBe(false);
  });

  it('accepts the draft flag as a multipart field too', async () => {
    const res = await upload(bob, taskId, { filename: 'a.txt', data: 'a' }, '', [{ name: 'draft', data: 'true' }]);
    expect(res.json().draft).toBe(true);
    const after = multipart([{ name: 'file', filename: 'b.txt', data: 'b' }, { name: 'draft', data: 'true' }]);
    const late = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/attachments`,
      headers: { cookie: bob.cookie, ...after.headers },
      payload: after.payload,
    });
    expect(late.json().draft, 'after the file part as well').toBe(true);
  });

  it('lets a COMMENTER attach to comments but not to the task', async () => {
    const refused = await upload(carol, taskId, { filename: 'a.png', data: png });
    expect(refused.statusCode).toBe(403);
    const refusedEarly = await upload(carol, taskId, { filename: 'a.png', data: png }, '?draft=false');
    expect(refusedEarly.statusCode).toBe(403);
    expect(await prisma.attachment.count()).toBe(0);
    const objects = [];
    for await (const o of storage().list()) objects.push(o);
    expect(objects, 'a refused upload leaves no file').toEqual([]);

    const draft = await uploaded(carol, { filename: 'shot.png', data: png }, '?draft=true');
    const comment = await req(carol, 'POST', `/tasks/${taskId}/comments`, { attachmentIds: [draft.id] });
    expect(comment.statusCode, comment.body).toBe(201);
    expect(comment.json().body).toBe('');
    expect(comment.json().attachments).toMatchObject([{ id: draft.id, draft: false, commentId: comment.json().id }]);

    const detail = (await req(alice, 'GET', `/tasks/${taskId}`)).json();
    expect(detail.attachmentCount).toBe(1);
    expect(detail.attachments[0].commentId).toBe(comment.json().id);
    const stories = (await req(alice, 'GET', `/tasks/${taskId}/stories`)).json().data;
    expect(stories.find((s: { kind: string }) => s.kind === 'comment').attachments[0].id).toBe(draft.id);
    expect(stories.some((s: { type?: string }) => s.type === 'ATTACHMENT_ADDED'), 'no activity for comment files').toBe(false);
  });

  it('only takes the caller’s own drafts on this task, once', async () => {
    const mine = await uploaded(bob, { filename: 'a.txt', data: 'a' }, '?draft=true');
    const theirs = await uploaded(alice, { filename: 'b.txt', data: 'b' }, '?draft=true');
    const posted = await uploaded(bob, { filename: 'c.txt', data: 'c' });
    const other = (await req(alice, 'POST', '/tasks', { projectId, title: 'Other' })).json();
    const elsewhere = (await upload(bob, other.id, { filename: 'd.txt', data: 'd' }, '?draft=true')).json();

    for (const ids of [[theirs.id], [posted.id], [elsewhere.id], [mine.id, theirs.id]]) {
      const res = await req(bob, 'POST', `/tasks/${taskId}/comments`, { body: 'x', attachmentIds: ids });
      expect(res.statusCode, JSON.stringify(ids)).toBe(400);
      expect(res.json().error.details[0].path).toEqual(['attachmentIds']);
    }
    expect(await prisma.comment.count(), 'rejected comments are rolled back').toBe(0);
    expect((await req(bob, 'POST', `/tasks/${taskId}/comments`, { attachmentIds: [mine.id, mine.id] })).statusCode).toBe(201);
    expect((await req(bob, 'POST', `/tasks/${taskId}/comments`, { attachmentIds: [mine.id] })).statusCode, 'used once').toBe(400);
    expect((await req(bob, 'POST', `/tasks/${taskId}/comments`, { body: '  ' })).statusCode, 'nothing to post').toBe(400);
    const tooMany = Array.from({ length: 21 }, () => mine.id);
    expect((await req(bob, 'POST', `/tasks/${taskId}/comments`, { attachmentIds: tooMany })).statusCode).toBe(400);
  });

  it('lets a comment with attachments be edited to an empty body, but not one without', async () => {
    const draft = await uploaded(bob, { filename: 'a.txt', data: 'a' }, '?draft=true');
    const withFile = (await req(bob, 'POST', `/tasks/${taskId}/comments`, { body: 'see file', attachmentIds: [draft.id] })).json();
    expect((await req(bob, 'PATCH', `/comments/${withFile.id}`, { body: '' })).statusCode).toBe(200);
    const plain = (await req(bob, 'POST', `/tasks/${taskId}/comments`, { body: 'hello' })).json();
    expect((await req(bob, 'PATCH', `/comments/${plain.id}`, { body: '' })).statusCode).toBe(400);
  });
});

describe('deleting', () => {
  it('lets the uploader, the project owner and admins delete, and records task-level removals', async () => {
    const a = await uploaded(bob, { filename: 'a.png', data: png });
    const { key } = await keysOf(a.id);
    expect((await req(carol, 'DELETE', `/attachments/${a.id}`)).statusCode).toBe(403);
    expect((await req(alice, 'DELETE', `/attachments/${a.id}`)).statusCode, 'project owner').toBe(204);
    expect(await storage().stat(key)).toBeNull();
    expect(await storage().stat(derivedKey(key, 's'))).toBeNull();
    const stories = (await req(bob, 'GET', `/tasks/${taskId}/stories`)).json().data;
    expect(stories.at(-1)).toMatchObject({ type: 'ATTACHMENT_REMOVED', data: { kind: 'FILE', name: 'a.png' } });

    const own = await uploaded(bob, { filename: 'b.txt', data: 'b' });
    expect((await req(bob, 'DELETE', `/attachments/${own.id}`)).statusCode, 'uploader').toBe(204);
    const byAlice = await uploaded(alice, { filename: 'c.txt', data: 'c' });
    expect((await req(bob, 'DELETE', `/attachments/${byAlice.id}`)).statusCode, 'an editor isn’t enough').toBe(403);
    const admin = await createUser({ role: 'ADMIN' });
    const adminSession = { user: admin, cookie: await login(ctx.app, admin.email) };
    expect((await req(adminSession, 'DELETE', `/attachments/${byAlice.id}`)).statusCode, 'workspace admin').toBe(204);
  });

  it('on personal tasks lets the task creator delete', async () => {
    const personal = (await req(alice, 'POST', '/tasks', { title: 'Mine', assigneeId: bob.user.id })).json();
    const res = await upload(bob, personal.id, { filename: 'a.txt', data: 'a' });
    expect(res.statusCode, res.body).toBe(201);
    expect((await req(alice, 'DELETE', `/attachments/${res.json().id}`)).statusCode).toBe(204);
  });

  it('removes the files when a task, a comment, a project or a workspace goes', async () => {
    const onTask = await uploaded(alice, { filename: 'a.png', data: png });
    const draft = await uploaded(bob, { filename: 'b.txt', data: 'b' }, '?draft=true');
    const comment = (await req(bob, 'POST', `/tasks/${taskId}/comments`, { attachmentIds: [draft.id] })).json();
    const sub = (await req(alice, 'POST', '/tasks', { parentId: taskId, title: 'Sub' })).json();
    const onSub = (await upload(alice, sub.id, { filename: 'c.txt', data: 'c' })).json();
    const keys = await Promise.all([onTask, draft, onSub].map((a) => keysOf(a.id).then((k) => k.key)));

    expect((await req(bob, 'DELETE', `/comments/${comment.id}`)).statusCode).toBe(204);
    expect(await storage().stat(keys[1]!)).toBeNull();
    expect(await storage().stat(keys[0]!)).not.toBeNull();

    expect((await req(alice, 'DELETE', `/tasks/${taskId}`)).statusCode).toBe(204);
    for (const key of [keys[0]!, derivedKey(keys[0]!, 'l'), keys[2]!]) expect(await storage().stat(key)).toBeNull();
    expect(await prisma.attachment.count()).toBe(0);

    const t2 = (await req(alice, 'POST', '/tasks', { projectId, title: 'Two' })).json();
    const a2 = (await upload(alice, t2.id, { filename: 'd.txt', data: 'd' })).json();
    const k2 = (await keysOf(a2.id)).key;
    expect((await req(alice, 'DELETE', `/projects/${projectId}`)).statusCode).toBe(204);
    expect(await storage().stat(k2)).toBeNull();

    // The workspace: Alice becomes admin of a fresh one.
    const ws = await prisma.workspace.create({ data: { name: 'Doomed', color: '#000000' } });
    await addMember(ws.id, alice.user.id, 'ADMIN');
    const t3 = (
      await req(alice, 'POST', '/tasks', { title: 'Personal' }, { 'x-workspace-id': ws.id })
    ).json();
    const a3 = (await upload(alice, t3.id, { filename: 'e.txt', data: 'e' })).json();
    const k3 = (await keysOf(a3.id)).key;
    const del = await req(alice, 'DELETE', `/workspaces/${ws.id}`, { confirmName: 'Doomed' });
    expect(del.statusCode, del.body).toBe(204);
    expect(await storage().stat(k3)).toBeNull();
  });
});

describe('review fixes (#24)', () => {
  it('limits concurrent uploads per user to 3, draft bytes to 1 GiB, and refuses when the disk is nearly full', async () => {
    // Over a real socket: light-my-request would buffer a streamed body before the handler runs.
    const { request } = await import('node:http');
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (ctx.app.server.address() as { port: number }).port;
    const boundary = '----held';
    const held = [0, 1, 2].map(() => {
      const req = request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: `/api/v1/tasks/${taskId}/attachments`,
        headers: { cookie: alice.cookie, 'content-type': `multipart/form-data; boundary=${boundary}`, 'transfer-encoding': 'chunked' },
      });
      const status = new Promise<number>((resolve, reject) => {
        req.on('response', (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
      });
      req.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="slow.txt"\r\n\r\nstart`);
      return { req, status };
    });
    await new Promise((r) => setTimeout(r, 300)); // all three are streaming now
    const fourth = await upload(alice, taskId, { filename: 'a.txt', data: 'a' });
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json().error.code).toBe('RATE_LIMITED');
    expect((await upload(bob, taskId, { filename: 'b.txt', data: 'b' })).statusCode, 'per user').toBe(201);
    for (const h of held) h.req.end(`-end\r\n--${boundary}--\r\n`);
    for (const h of held) expect(await h.status).toBe(201);
    expect((await upload(alice, taskId, { filename: 'c.txt', data: 'c' })).statusCode, 'slots come back').toBe(201);

    // 1 GiB of drafts already waiting (a row is enough: the quota counts sizes).
    await prisma.attachment.create({
      data: { workspaceId: await defaultWorkspaceId(), taskId, uploaderId: bob.user.id, kind: 'FILE', draft: true, name: 'big.bin', size: 1024 ** 3 },
    });
    const overQuota = await upload(bob, taskId, { filename: 'd.txt', data: 'd' }, '?draft=true');
    expect(overQuota.statusCode).toBe(429);
    const viaField = await upload(bob, taskId, { filename: 'd.txt', data: 'd' }, '', [{ name: 'draft', data: 'true' }]);
    expect(viaField.statusCode, 'decided after the body, too').toBe(429);
    expect((await upload(bob, taskId, { filename: 'e.txt', data: 'e' })).statusCode, 'posted files are not drafts').toBe(201);

    const full = await buildApp({ config: { ...loadConfig(), STORAGE_MIN_FREE_BYTES: Number.MAX_SAFE_INTEGER }, prisma, logger: false });
    try {
      const body = multipart([{ name: 'file', filename: 'a.txt', data: 'a' }]);
      const res = await full.inject({
        method: 'POST',
        url: `/api/v1/tasks/${taskId}/attachments`,
        headers: { cookie: alice.cookie, ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(507);
      expect(res.json().error.code).toBe('INSUFFICIENT_STORAGE');
    } finally {
      await full.close();
    }
  });

  it('holds the concurrency cap under parallel requests (no await between check and claim)', async () => {
    class SlowDisk extends DiskStorage {
      override async freeBytes() {
        await new Promise((r) => setTimeout(r, 200));
        return super.freeBytes();
      }
    }
    const slow = await buildApp({ config: loadConfig(), prisma, logger: false, storage: new SlowDisk(storage().root) });
    try {
      const send = () => {
        const body = multipart([{ name: 'file', filename: 'p.txt', data: 'p' }]);
        return slow.inject({
          method: 'POST',
          url: `/api/v1/tasks/${taskId}/attachments`,
          headers: { cookie: alice.cookie, ...body.headers },
          payload: body.payload,
        });
      };
      const results = await Promise.all(Array.from({ length: 8 }, send));
      const codes = results.map((r) => r.statusCode).sort();
      expect(codes).toEqual([201, 201, 201, 429, 429, 429, 429, 429]);
      expect((await send()).statusCode, 'and the slots come back').toBe(201);

      class BrokenDisk extends DiskStorage {
        override async freeBytes(): Promise<number> {
          throw new Error('statfs failed');
        }
      }
      const broken = await buildApp({ config: loadConfig(), prisma, logger: false, storage: new BrokenDisk(storage().root) });
      try {
        const body = multipart([{ name: 'file', filename: 'p.txt', data: 'p' }]);
        const res = await broken.inject({
          method: 'POST',
          url: `/api/v1/tasks/${taskId}/attachments`,
          headers: { cookie: alice.cookie, ...body.headers },
          payload: body.payload,
        });
        expect(res.statusCode, 'unknown free space fails closed').toBe(507);
      } finally {
        await broken.close();
      }
    } finally {
      await slow.close();
    }
  });

  it('answers multipart shape limits with 400, not 413', async () => {
    const fields = multipart([...Array.from({ length: 7 }, (_, i) => ({ name: `f${i}`, data: 'x' })), { name: 'file', filename: 'a.txt', data: 'a' }]);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/attachments`,
      headers: { cookie: alice.cookie, ...fields.headers },
      payload: fields.payload,
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });

  it('answers a missing file with a 404 envelope, and an empty file’s suffix range with 416', async () => {
    const a = await uploaded(alice, { filename: 'gone.txt', data: 'bytes' });
    await storage().delete((await keysOf(a.id)).key);
    const res = await req(bob, 'GET', `/attachments/${a.id}/content`);
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.json().error.code).toBe('NOT_FOUND');
    expect(res.headers['x-content-type-options']).toBe('nosniff');

    const empty = await uploaded(alice, { filename: 'empty.txt', data: '' });
    const suffix = await req(bob, 'GET', `/attachments/${empty.id}/content`, undefined, { range: 'bytes=-5' });
    expect(suffix.statusCode).toBe(416);
    expect(suffix.headers['content-range']).toBe('bytes */0');
  });

  it('removes a comment that was only the attachment being deleted', async () => {
    const draft = await uploaded(bob, { filename: 'a.png', data: png }, '?draft=true');
    const onlyFile = (await req(bob, 'POST', `/tasks/${taskId}/comments`, { attachmentIds: [draft.id] })).json();
    const d2 = await uploaded(bob, { filename: 'b.txt', data: 'b' }, '?draft=true');
    const withText = (await req(bob, 'POST', `/tasks/${taskId}/comments`, { body: 'see', attachmentIds: [d2.id] })).json();
    expect((await req(bob, 'DELETE', `/attachments/${draft.id}`)).statusCode).toBe(204);
    expect((await req(bob, 'DELETE', `/attachments/${d2.id}`)).statusCode).toBe(204);
    const comments = (await req(bob, 'GET', `/tasks/${taskId}/stories`)).json().data.filter((st: { kind: string }) => st.kind === 'comment');
    expect(comments.map((c: { id: string }) => c.id)).toEqual([withText.id]);
    expect(onlyFile.id).not.toBe(withText.id);
  });
});

describe('sweeper', () => {
  it('keeps the files of a draft that a comment claims while the sweep runs', async () => {
    const draft = await uploaded(bob, { filename: 'late.png', data: png }, '?draft=true');
    await prisma.attachment.update({ where: { id: draft.id }, data: { createdAt: new Date(Date.now() - 25 * 3600_000) } });
    const key = (await keysOf(draft.id)).key;
    // The comment is posted between the sweep's read and its delete.
    const racing = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop !== 'attachment') return Reflect.get(target, prop, receiver);
        return new Proxy(target.attachment, {
          get(model, method, r) {
            if (method !== 'findMany') return Reflect.get(model, method, r);
            return async (args: object) => {
              const rows = await model.findMany(args as never);
              const res = await req(bob, 'POST', `/tasks/${taskId}/comments`, { body: 'just in time', attachmentIds: [draft.id] });
              expect(res.statusCode).toBe(201);
              return rows;
            };
          },
        });
      },
    });
    const result = await sweepAttachments(racing, storage(), new Date());
    expect(result.drafts).toBe(0);
    expect(await storage().stat(key), 'the posted file keeps its bytes').not.toBeNull();
    expect(await storage().stat(derivedKey(key, 's'))).not.toBeNull();
    expect((await req(alice, 'GET', `/attachments/${draft.id}/content`)).statusCode).toBe(200);
  });

  it('removes day-old drafts and orphaned objects, and nothing recent or referenced', async () => {
    const draft = await uploaded(bob, { filename: 'old.png', data: png }, '?draft=true');
    const fresh = await uploaded(bob, { filename: 'new.txt', data: 'n' }, '?draft=true');
    const kept = await uploaded(bob, { filename: 'kept.txt', data: 'k' });
    await prisma.attachment.update({ where: { id: draft.id }, data: { createdAt: new Date(Date.now() - 25 * 3600_000) } });
    const draftKey = (await keysOf(draft.id)).key;
    const keptKey = (await keysOf(kept.id)).key;
    // An orphan: an object whose row never committed.
    const { Readable } = await import('node:stream');
    const orphan = '00/00/00000000-0000-4000-8000-000000000000';
    await storage().put(orphan, Readable.from(Buffer.from('lost')));

    // Now: the day-old draft goes; the orphan is too young to tell from an upload about to commit.
    expect(await sweepAttachments(prisma, storage(), new Date())).toEqual({ drafts: 1, orphans: 0 });
    expect(await prisma.attachment.findUnique({ where: { id: draft.id } })).toBeNull();
    expect(await storage().stat(draftKey)).toBeNull();
    expect(await storage().stat(derivedKey(draftKey, 's'))).toBeNull();
    expect(await prisma.attachment.findUnique({ where: { id: fresh.id } }), 'a fresh draft stays').not.toBeNull();
    expect(await storage().stat(orphan)).not.toBeNull();

    // A day later: the other draft and the orphan go; a posted attachment never does.
    const tomorrow = new Date(Date.now() + 25 * 3600_000);
    expect(await sweepAttachments(prisma, storage(), tomorrow)).toEqual({ drafts: 1, orphans: 1 });
    expect(await storage().stat(orphan)).toBeNull();
    expect(await storage().stat(keptKey)).not.toBeNull();
    expect(await prisma.attachment.findUnique({ where: { id: kept.id } })).not.toBeNull();
  });
});
