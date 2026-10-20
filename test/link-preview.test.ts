import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { rm } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { User } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { defaultPolicy, fetchPreview, USER_AGENT, type FetchPolicy } from '../src/lib/link-preview.js';
import { isPublicAddress } from '../src/lib/ssrf.js';
import type { DiskStorage } from '../src/lib/storage.js';
import { defaultWorkspaceId, prisma, signedIn } from './helpers.js';

// --- a local "internet": one fixture server, reached through made-up hostnames -------------------

let server: Server;
let port = 0;
const seen: IncomingMessage[] = [];
let ogPng: Buffer;
let icoWithPng: Buffer;

/** A minimal .ico whose one entry is a PNG (what modern favicons look like). */
async function makeIco() {
  const png = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#4186e0' } }).png().toBuffer();
  const header = Buffer.alloc(6 + 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(32, 6);
  header.writeUInt8(32, 7);
  header.writeUInt32LE(png.length, 6 + 8);
  header.writeUInt32LE(22, 6 + 12);
  return Buffer.concat([header, png]);
}

const PAGE = `<!doctype html><html><head><title>Fallback</title>
<meta property="og:title" content="Launch plan">
<meta property="og:description" content="Everything for the launch.">
<meta property="og:site_name" content="Fixture">
<meta property="og:image" content="/og.png">
<link rel="icon" href="/favicon.ico">
</head><body>hi</body></html>`;

beforeAll(async () => {
  ogPng = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: '#e8384f' } }).png().toBuffer();
  icoWithPng = await makeIco();
  server = createServer((req, res) => {
    seen.push(req);
    const send = (status: number, type: string, body: Buffer | string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': type, ...headers });
      res.end(body);
    };
    switch (req.url) {
      case '/page':
        return send(200, 'text/html; charset=utf-8', PAGE, { 'Set-Cookie': 'tracker=1; Path=/' });
      case '/og.png':
        return send(200, 'image/png', ogPng);
      case '/favicon.ico':
        return send(200, 'image/x-icon', icoWithPng);
      case '/r1':
        return send(302, 'text/plain', '', { Location: '/r2', 'Set-Cookie': 'hop=1' });
      case '/r2':
        return send(301, 'text/plain', '', { Location: `http://site.test:${port}/page` });
      case '/loop':
        return send(302, 'text/plain', '', { Location: '/loop' });
      case '/to-metadata':
        return send(302, 'text/plain', '', { Location: 'http://meta.test/latest/meta-data/' });
      case '/to-loopback':
        return send(307, 'text/plain', '', { Location: `http://127.0.0.2:${port}/page` });
      case '/to-mapped':
        return send(302, 'text/plain', '', { Location: `http://[::ffff:10.0.0.1]:${port}/page` });
      case '/pdf':
        return send(200, 'application/pdf', '%PDF-1.4');
      case '/gzip':
        return send(200, 'text/html', gzipSync(PAGE), { 'Content-Encoding': 'gzip' });
      case '/bomb':
        // ~50 MB of zeros that compress to ~50 KB: the cap applies to what comes out.
        return send(200, 'text/html', gzipSync(Buffer.alloc(50 * 1024 * 1024)), { 'Content-Encoding': 'gzip' });
      case '/big': {
        const filler = `<!-- ${'x'.repeat(1024 * 1024 + 10)} -->`;
        return send(200, 'text/html', `<title>Early</title>${filler}<meta property="og:title" content="Too late">`);
      }
      case '/huge-image':
        return send(200, 'text/html', '<meta property="og:image" content="/huge.png"><title>Huge</title>');
      case '/huge.png':
        return send(200, 'image/png', Buffer.concat([ogPng.subarray(0, 8), Buffer.alloc(6 * 1024 * 1024)]));
      case '/gzip-close': {
        // A gzip body cut off mid-stream: the decoder must not wait forever for its end.
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' });
        res.write(gzipSync(PAGE).subarray(0, 40));
        setTimeout(() => res.socket!.destroy(), 50);
        return;
      }
      case '/gzip-stall': {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' });
        res.write(gzipSync(PAGE).subarray(0, 40));
        return; // never ends
      }
      case '/redos':
        // 1 MB of tag starts that never close: quadratic for a backtracking parser.
        return send(200, 'text/html', '<title>Slow?</title>' + '<meta '.repeat((1024 * 1024) / 6));
      case '/slow':
        return; // never answers
      case '/delayed':
        setTimeout(() => send(200, 'text/html', PAGE), 400);
        return;
      default:
        return send(404, 'text/plain', 'nope');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  seen.length = 0;
});

/** The fixture is "public" only at 127.0.0.1; everything else is judged by the real rules. */
const HOSTS: Record<string, string[]> = {
  'site.test': ['127.0.0.1'],
  'meta.test': ['169.254.169.254'],
  'inner.test': ['10.0.0.5'],
  'mixed.test': ['127.0.0.1', '10.0.0.1'],
};
const policy: FetchPolicy = {
  isAllowedAddress: (ip) => ip === '127.0.0.1' || isPublicAddress(ip),
  allowAnyPort: true,
  resolve: async (host) => (HOSTS[host] ?? []).map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
};
const at = (path: string, host = 'site.test') => `http://${host}:${port}${path}`;

describe('the fetcher (SPEC §13 SSRF rules)', () => {
  it('reads og tags, and re-encodes the image and the favicon as WebP', async () => {
    const p = await fetchPreview(at('/page'), policy);
    expect(p).toMatchObject({ status: 'READY', title: 'Launch plan', description: 'Everything for the launch.', siteName: 'Fixture' });
    const image = await sharp(p.image!).metadata();
    expect([image.format, image.width, image.height]).toEqual(['webp', 1200, 600]);
    const icon = await sharp(p.icon!).metadata();
    expect([icon.format, icon.width]).toEqual(['webp', 32]);
    for (const req of seen) {
      expect(req.headers['user-agent']).toBe(USER_AGENT);
      expect(req.headers.cookie, 'no cookies, ever').toBeUndefined();
      expect(req.headers.authorization).toBeUndefined();
    }
  });

  it('follows up to 3 redirects, re-checking each hop, and sends no cookie it was given', async () => {
    // DNS is asked once per hop by name; a second answer (a rebinding server's private one) is never used.
    const lookups: string[] = [];
    let calls = 0;
    const rebinding: FetchPolicy = {
      ...policy,
      resolve: async (host) => {
        lookups.push(host);
        calls += 1;
        return [{ address: calls === 1 ? '127.0.0.1' : '10.0.0.1', family: 4 }];
      },
    };
    const first = await fetchPreview(at('/page'), rebinding);
    expect(first.title, 'the page and both images: one lookup, then pinned').toBe('Launch plan');
    expect(lookups.length).toBeGreaterThanOrEqual(1);
    expect(lookups[0]).toBe('site.test');
    expect(first.icon, 'the image hops resolved again and got the private answer: refused').toBeNull();
    seen.length = 0;

    expect((await fetchPreview(at('/r1'), policy)).title).toBe('Launch plan');
    expect(seen.map((r) => r.url).slice(0, 3)).toEqual(['/r1', '/r2', '/page']);
    expect(seen.every((r) => r.headers.cookie === undefined)).toBe(true);
    seen.length = 0;
    const loop = await fetchPreview(at('/loop'), policy);
    expect(loop.status).toBe('FAILED');
    expect(seen.length, 'the first request and 3 redirects').toBe(4);
  });

  it('refuses a redirect to cloud metadata, loopback or an IPv4-mapped private address', async () => {
    for (const path of ['/to-metadata', '/to-loopback', '/to-mapped']) {
      seen.length = 0;
      const p = await fetchPreview(at(path), policy);
      expect(p.status, path).toBe('FAILED');
      expect(p.reason, path).toMatch(/BlockedError/);
      expect(seen.map((r) => r.url), path).toEqual([path]);
    }
  });

  it('never connects to a blocked address, even when it is not the first one a host resolves to', async () => {
    for (const host of ['inner.test', 'meta.test', 'mixed.test']) {
      const p = await fetchPreview(at('/page', host), policy);
      expect(p.status, host).toBe('FAILED');
    }
    expect(seen).toEqual([]);
  });

  it('with the default policy reaches no private address or odd port, in any spelling', async () => {
    const anyPort = { ...defaultPolicy, allowAnyPort: true };
    for (const url of [
      `http://127.0.0.1:${port}/page`,
      `http://[::ffff:127.0.0.1]:${port}/page`,
      `http://[::1]:${port}/page`,
      `http://2130706433:${port}/page`,
      `http://0x7f.1:${port}/page`,
      `http://localhost:${port}/page`,
    ]) {
      expect((await fetchPreview(url, anyPort)).status, url).toBe('FAILED');
    }
    expect((await fetchPreview('http://example.com:8080/', defaultPolicy)).reason).toMatch(/port 8080/);
    expect((await fetchPreview('http://user:pw@example.com/', defaultPolicy)).reason).toMatch(/credentials/);
    expect((await fetchPreview('ftp://example.com/', defaultPolicy)).reason).toMatch(/scheme/);
    expect(seen).toEqual([]);
  });

  it('keeps to the budget and the size caps', async () => {
    const hangingDns: FetchPolicy = { ...policy, resolve: () => new Promise(() => {}) };
    const dnsStarted = Date.now();
    expect((await fetchPreview(at('/page'), hangingDns, 300)).status).toBe('FAILED');
    expect(Date.now() - dnsStarted, 'a stuck lookup is cut off too').toBeLessThan(2_000);
    const started = Date.now();
    const slow = await fetchPreview(at('/slow'), policy, 300);
    expect(slow.status).toBe('FAILED');
    expect(Date.now() - started).toBeLessThan(2_000);

    const big = await fetchPreview(at('/big'), policy);
    expect(big.title, 'only the first 1 MB is read').toBe('Early');
    const bomb = await fetchPreview(at('/bomb'), policy);
    expect(bomb.status).toBe('READY');
    expect((await fetchPreview(at('/gzip'), policy)).title).toBe('Launch plan');
    const huge = await fetchPreview(at('/huge-image'), policy);
    expect([huge.title, huge.image]).toEqual(['Huge', null]);
    expect((await fetchPreview(at('/pdf'), policy)).status, 'not HTML').toBe('FAILED');
    expect((await fetchPreview(at('/missing'), policy)).status).toBe('FAILED');
  });

  it('ends a gzip body that is cut off at once, and one that stalls at the budget', async () => {
    let started = Date.now();
    const cut = await fetchPreview(at('/gzip-close'), policy, 5_000);
    expect(cut.status).toBe('FAILED');
    expect(Date.now() - started, 'the decoder errors when the response closes').toBeLessThan(1_000);
    started = Date.now();
    expect((await fetchPreview(at('/gzip-stall'), policy, 500)).status).toBe('FAILED');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('parses a 1 MB pathological page in linear time', async () => {
    const started = Date.now();
    const p = await fetchPreview(at('/redos'), policy);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect([p.status, p.title]).toEqual(['READY', 'Slow?']);
  });
});

// --- the routes ------------------------------------------------------------------------------

describe('link attachments', () => {
  type Session = { user: User; cookie: string };
  let app: Awaited<ReturnType<typeof buildApp>>;
  let alice: Session;
  let carol: Session;
  let taskId: string;

  beforeAll(async () => {
    app = await buildApp({ config: loadConfig(), prisma, logger: false, fetchPolicy: policy });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const rows = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
    await prisma.$executeRawUnsafe(`TRUNCATE ${rows.map((r) => `"public"."${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
    await rm((app.storage as DiskStorage).root, { recursive: true, force: true });
    alice = await signedIn(app, { name: 'Alice' });
    carol = await signedIn(app, { name: 'Carol' });
    const team = await prisma.team.create({
      data: { workspaceId: await defaultWorkspaceId(), name: 'Eng', members: { create: [{ userId: alice.user.id }, { userId: carol.user.id }] } },
    });
    const project = (await req(alice, 'POST', '/projects', { teamId: team.id, name: 'Website' })).json();
    await prisma.projectMember.create({ data: { projectId: project.id, userId: carol.user.id, role: 'COMMENTER' } });
    taskId = (await req(alice, 'POST', '/tasks', { projectId: project.id, title: 'Launch' })).json().id;
  });

  function req(s: Session, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) {
    return app.inject({ method, url: `/api/v1${url}`, headers: { cookie: s.cookie }, payload });
  }

  it('creates a link with a fetched preview, served from our own origin', async () => {
    const res = await req(alice, 'POST', `/tasks/${taskId}/attachments/link`, { url: at('/page') });
    expect(res.statusCode, res.body).toBe(201);
    const link = res.json();
    expect(link).toMatchObject({
      kind: 'LINK',
      url: at('/page'),
      title: 'Launch plan',
      description: 'Everything for the launch.',
      siteName: 'Fixture',
      previewStatus: 'READY',
      hasIcon: true,
      hasImage: true,
      iconPath: `/api/v1/attachments/${link.id}/icon`,
      imagePath: `/api/v1/attachments/${link.id}/image`,
      contentPath: null,
    });
    for (const path of ['icon', 'image']) {
      const img = await req(alice, 'GET', `/attachments/${link.id}/${path}`);
      expect(img.statusCode).toBe(200);
      expect(img.headers['content-type']).toBe('image/webp');
      expect(img.headers['x-content-type-options']).toBe('nosniff');
      expect(img.headers['content-security-policy']).toMatch(/^sandbox;/);
      expect(img.headers.etag).toMatch(/^"[0-9a-f]{32}"$/);
    }
    const stories = (await req(alice, 'GET', `/tasks/${taskId}/stories`)).json().data;
    expect(stories.at(-1)).toMatchObject({ type: 'ATTACHMENT_ADDED', data: { kind: 'LINK', name: 'Launch plan' } });
    expect((await req(alice, 'GET', `/tasks/${taskId}`)).json().attachmentCount).toBe(1);
  });

  it('keeps a typed title, and through a refresh, which replaces the cached images', async () => {
    const link = (await req(alice, 'POST', `/tasks/${taskId}/attachments/link`, { url: at('/page'), title: 'Our plan' })).json();
    expect(link.title).toBe('Our plan');
    const before = await prisma.attachment.findUniqueOrThrow({ where: { id: link.id } });
    const refreshed = await req(alice, 'POST', `/attachments/${link.id}/refresh-preview`);
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    expect(refreshed.json()).toMatchObject({ title: 'Our plan', previewStatus: 'READY', hasIcon: true });
    const after = await prisma.attachment.findUniqueOrThrow({ where: { id: link.id } });
    expect(after.iconKey).not.toBe(before.iconKey);
    const storage = app.storage as DiskStorage;
    expect(await storage.stat(before.iconKey!), 'the old icon is gone').toBeNull();
    expect(await storage.stat(after.iconKey!)).not.toBeNull();

    // An untyped title follows the page.
    const plain = (await req(alice, 'POST', `/tasks/${taskId}/attachments/link`, { url: at('/missing') })).json();
    expect([plain.previewStatus, plain.title]).toEqual(['FAILED', null]);
    await prisma.attachment.update({ where: { id: plain.id }, data: { url: at('/page') } });
    expect((await req(alice, 'POST', `/attachments/${plain.id}/refresh-preview`)).json().title).toBe('Launch plan');
  });

  it('still creates the link when the preview fails, and never fetches with previews off', async () => {
    const blocked = (await req(alice, 'POST', `/tasks/${taskId}/attachments/link`, { url: at('/page', 'meta.test') })).json();
    expect([blocked.previewStatus, blocked.hasIcon, blocked.title]).toEqual(['FAILED', false, null]);
    const figma = (await req(alice, 'POST', `/tasks/${taskId}/attachments/link`, { url: 'https://www.figma.com/file/x' })).json();
    expect([figma.previewStatus, figma.provider], 'not resolvable here, but the provider is known').toEqual(['FAILED', 'figma']);

    const off = await buildApp({ config: { ...loadConfig(), LINK_PREVIEW_ENABLED: false }, prisma, logger: false, fetchPolicy: policy });
    try {
      seen.length = 0;
      const res = await off.inject({
        method: 'POST',
        url: `/api/v1/tasks/${taskId}/attachments/link`,
        headers: { cookie: alice.cookie },
        payload: { url: at('/page') },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().previewStatus).toBe('FAILED');
      expect(seen).toEqual([]);
    } finally {
      await off.close();
    }
  });

  it('counts link fetches against the 3-at-once cap', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => req(alice, 'POST', `/tasks/${taskId}/attachments/link`, { url: at('/delayed') })),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 201, 201, 429, 429]);
    expect((await req(alice, 'POST', `/tasks/${taskId}/attachments/link`, { url: at('/page') })).statusCode).toBe(201);
  });

  it('releases the slot when a gzip page closes early', async () => {
    const cut = await Promise.all(Array.from({ length: 3 }, () => req(alice, 'POST', `/tasks/${taskId}/attachments/link`, { url: at('/gzip-close') })));
    expect(cut.map((r) => [r.statusCode, r.json().previewStatus])).toEqual(Array(3).fill([201, 'FAILED']));
    expect((await req(alice, 'POST', `/tasks/${taskId}/attachments/link`, { url: at('/page') })).statusCode).toBe(201);
  });

  it('keeps the previous preview when a refresh fails', async () => {
    const link = (await req(alice, 'POST', `/tasks/${taskId}/attachments/link`, { url: at('/page') })).json();
    const before = await prisma.attachment.findUniqueOrThrow({ where: { id: link.id } });
    await prisma.attachment.update({ where: { id: link.id }, data: { url: at('/missing') } });
    const refreshed = await req(alice, 'POST', `/attachments/${link.id}/refresh-preview`);
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    expect(refreshed.json()).toMatchObject({ title: 'Launch plan', siteName: 'Fixture', previewStatus: 'READY', hasIcon: true, hasImage: true });
    const after = await prisma.attachment.findUniqueOrThrow({ where: { id: link.id } });
    expect(after).toEqual({ ...before, url: at('/missing') });
    expect(await (app.storage as DiskStorage).stat(before.iconKey!), 'the icon is still there').not.toBeNull();
  });

  it('cleans a typed title like a filename', async () => {
    const typed = await req(alice, 'POST', `/tasks/${taskId}/attachments/link`, {
      url: at('/page'),
      title: ' Plan\u202Etxt.exe\u0007 \u200B\n v2 \uD800 \u{1F468}\u200D\u{1F469} ',
    });
    expect(typed.json().title).toBe('Plantxt.exe v2 \uFFFD \u{1F468}\u200D\u{1F469}');
    const invisible = await req(alice, 'POST', `/tasks/${taskId}/attachments/link`, { url: at('/page'), title: '\u200B\u202E\u0000' });
    expect(invisible.json().title, 'nothing visible: the page title it is').toBe('Launch plan');
  });

  it('validates the URL', async () => {
    for (const url of ['ftp://example.com/x', '/relative', 'https://user:pw@example.com/', 'javascript:alert(1)', `https://e.com/${'a'.repeat(2048)}`, '']) {
      const res = await req(alice, 'POST', `/tasks/${taskId}/attachments/link`, { url });
      expect(res.statusCode, url.slice(0, 40)).toBe(400);
      expect(res.json().error.details[0].path).toEqual(['url']);
    }
    expect(seen).toEqual([]);
  });

  it('lets a COMMENTER add a link only as a comment draft', async () => {
    expect((await req(carol, 'POST', `/tasks/${taskId}/attachments/link`, { url: at('/page') })).statusCode).toBe(403);
    expect(seen, 'refused before any fetch').toEqual([]);
    const draft = (await req(carol, 'POST', `/tasks/${taskId}/attachments/link`, { url: at('/page'), draft: true })).json();
    expect(draft.draft).toBe(true);
    expect((await req(alice, 'GET', `/attachments/${draft.id}/icon`)).statusCode).toBe(404);
    const comment = await req(carol, 'POST', `/tasks/${taskId}/comments`, { body: 'see', attachmentIds: [draft.id] });
    expect(comment.json().attachments[0]).toMatchObject({ id: draft.id, kind: 'LINK' });
    expect((await req(carol, 'POST', `/attachments/${draft.id}/refresh-preview`)).statusCode, 'their own link').toBe(200);
  });

  it('removes the cached images when the link goes', async () => {
    const link = (await req(alice, 'POST', `/tasks/${taskId}/attachments/link`, { url: at('/page') })).json();
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: link.id } });
    expect((await req(alice, 'DELETE', `/attachments/${link.id}`)).statusCode).toBe(204);
    const storage = app.storage as DiskStorage;
    expect(await storage.stat(row.iconKey!)).toBeNull();
    expect(await storage.stat(row.imageKey!)).toBeNull();
    const stories = (await req(alice, 'GET', `/tasks/${taskId}/stories`)).json().data;
    expect(stories.at(-1)).toMatchObject({ type: 'ATTACHMENT_REMOVED', data: { kind: 'LINK', name: 'Launch plan' } });
  });
});
