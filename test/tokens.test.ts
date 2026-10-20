import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { User } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { generateToken, hashToken } from '../src/lib/tokens.js';
import { createUser, PASSWORD, prisma, signedIn } from './helpers.js';

const APP_URL = 'https://project.example.com';
const CHALLENGE = `Bearer resource_metadata="${APP_URL}/.well-known/oauth-protected-resource/mcp"`;
const TOKEN = /^mpat_[A-Za-z0-9_-]{43}$/;
const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
let off: FastifyInstance;

beforeAll(async () => {
  const config = loadConfig();
  app = await buildApp({ config: { ...config, APP_URL, MCP_ENABLED: true }, prisma, logger: false });
  off = await buildApp({ config: { ...config, MCP_ENABLED: false }, prisma, logger: false });
  await Promise.all([app.ready(), off.ready()]);
});
afterAll(async () => {
  await Promise.all([app.close(), off.close()]);
});
beforeEach(async () => {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${rows.map((r) => `"public"."${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
});

type Session = { user: User; cookie: string };

function api(s: Session | null, method: 'GET' | 'POST' | 'DELETE' | 'PATCH', url: string, payload?: object, on = app) {
  return on.inject({ method, url: `/api/v1${url}`, headers: s ? { cookie: s.cookie } : {}, payload });
}

function mcp(headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json', ...headers }, payload: '{}' });
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function createPat(s: Session, body: object = {}) {
  const res = await api(s, 'POST', '/me/tokens', { name: 'Claude Code', scope: 'WRITE', ...body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { token: string; info: { id: string; prefix: string; expiresAt: string | null; createdAt: string } };
}

/** An OAuth grant as PR B's token endpoint will leave it: a client, a rotated family, an access token. */
async function oauthGrant(user: User, name = 'Claude') {
  const client = await prisma.oAuthClient.create({
    data: { clientId: `client-${randomUUID()}`, name, redirectUris: ['https://claude.ai/api/mcp/auth_callback'] },
  });
  const family = randomUUID();
  const first = generateToken('mpor');
  const live = generateToken('mpor');
  const access = generateToken('mpoa');
  const t0 = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await prisma.oAuthRefresh.create({
    data: { tokenHash: first.hash, prefix: first.prefix, family, clientId: client.id, userId: user.id, scope: 'WRITE', createdAt: t0, usedAt: new Date(), expiresAt: new Date(Date.now() + 30 * DAY) },
  });
  const refresh = await prisma.oAuthRefresh.create({
    data: { tokenHash: live.hash, prefix: live.prefix, family, clientId: client.id, userId: user.id, scope: 'WRITE', expiresAt: new Date(Date.now() + 29 * DAY) },
  });
  const accessRow = await prisma.apiToken.create({
    data: {
      userId: user.id,
      name,
      source: 'OAUTH',
      scope: 'WRITE',
      prefix: access.prefix,
      tokenHash: access.hash,
      oauthClientId: client.id,
      oauthFamily: family,
      lastUsedAt: new Date(Date.now() - 5 * 60 * 1000),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return { client, family, t0, refresh, refreshToken: live.token, accessToken: access.token, accessRow };
}

describe('GET /config', () => {
  it('tells the signed-in FE the app URL and whether MCP is on', async () => {
    const alice = await signedIn(app);
    expect((await api(alice, 'GET', '/config')).json()).toEqual({ appUrl: APP_URL, mcpEnabled: true });
    expect((await api(alice, 'GET', '/config', undefined, off)).json()).toMatchObject({ mcpEnabled: false });
    expect((await api(null, 'GET', '/config')).statusCode).toBe(401);
  });
});

describe('personal access tokens', () => {
  it('creates a token, shown once, stored only as its sha256', async () => {
    const alice = await signedIn(app);
    const before = Date.now();
    const { token, info } = await createPat(alice);
    expect(token).toMatch(TOKEN);
    expect(info).toMatchObject({ name: 'Claude Code', source: 'PAT', scope: 'WRITE', prefix: token.slice(0, 12), lastUsedAt: null });
    expect(info.prefix).toMatch(/^mpat_.{7}$/);
    const expires = Date.parse(info.expiresAt!);
    expect(expires - before, 'default 90 days').toBeGreaterThanOrEqual(90 * DAY - 1000);
    expect(expires - before).toBeLessThan(90 * DAY + 60_000);

    const row = await prisma.apiToken.findUniqueOrThrow({ where: { id: info.id } });
    expect(row.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(row), 'the plaintext is nowhere in the row').not.toContain(token.slice(5));
    const listed = (await api(alice, 'GET', '/me/tokens')).json().data;
    expect(JSON.stringify(listed)).not.toContain(token.slice(5));

    expect((await createPat(alice, { expiresInDays: null, scope: 'READ' })).info).toMatchObject({ expiresAt: null, scope: 'READ' });
    expect(Date.parse((await createPat(alice, { expiresInDays: 365 })).info.expiresAt!) - Date.now()).toBeGreaterThan(364 * DAY);
  });

  it('validates the body', async () => {
    const alice = await signedIn(app);
    for (const body of [
      { name: '', scope: 'READ' },
      { name: ' ', scope: 'READ' },
      { name: 'x'.repeat(61), scope: 'READ' },
      { name: 'x', scope: 'ADMIN' },
      { name: 'x', scope: 'READ', expiresInDays: 7 },
      { name: 'x', scope: 'READ', extra: true },
    ]) {
      expect((await api(alice, 'POST', '/me/tokens', body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(await prisma.apiToken.count()).toBe(0);
  });

  it('allows 20 active PATs; revoked and expired ones do not count', async () => {
    const alice = await signedIn(app);
    const made = [];
    for (let i = 0; i < 20; i++) made.push(await createPat(alice, { name: `t${i}` }));
    const full = await api(alice, 'POST', '/me/tokens', { name: 'one more', scope: 'READ' });
    expect(full.statusCode).toBe(409);
    expect(full.json().error.code).toBe('CONFLICT');

    expect((await api(alice, 'DELETE', `/me/tokens/${made[0]!.info.id}`)).statusCode).toBe(204);
    await prisma.apiToken.update({ where: { id: made[1]!.info.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    // Two free slots, ten racing for them: exactly two win.
    const raced = await Promise.all(Array.from({ length: 10 }, (_, i) => api(alice, 'POST', '/me/tokens', { name: `race${i}`, scope: 'READ' })));
    expect(raced.filter((r) => r.statusCode === 201)).toHaveLength(2);
    expect(raced.filter((r) => r.statusCode === 409)).toHaveLength(8);

    const bob = await signedIn(app);
    expect((await api(bob, 'POST', '/me/tokens', { name: 'mine', scope: 'READ' })).statusCode, 'per user').toBe(201);
  });

  it('lists live PATs and OAuth grants, newest first, and only the caller’s', async () => {
    const alice = await signedIn(app);
    const bob = await signedIn(app);
    const grant = await oauthGrant(alice.user);
    const older = await createPat(alice, { name: 'older' });
    await prisma.apiToken.update({ where: { id: older.info.id }, data: { createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) } });
    const newer = await createPat(alice, { name: 'newer' });
    const revoked = await createPat(alice, { name: 'revoked' });
    await api(alice, 'DELETE', `/me/tokens/${revoked.info.id}`);
    const expired = await createPat(alice, { name: 'expired' });
    await prisma.apiToken.update({ where: { id: expired.info.id }, data: { expiresAt: new Date(Date.now() - 1) } });
    await createPat(bob, { name: 'bob’s' });
    // A grant whose family was revoked isn't listed.
    const gone = await oauthGrant(alice.user, 'Gone');
    await prisma.oAuthRefresh.updateMany({ where: { family: gone.family }, data: { revokedAt: new Date() } });

    const data = (await api(alice, 'GET', '/me/tokens')).json().data;
    expect(data.map((t: { name: string }) => t.name)).toEqual(['newer', 'Claude', 'older']);
    expect(data[1]).toEqual({
      id: grant.family,
      name: 'Claude',
      source: 'OAUTH',
      scope: 'WRITE',
      prefix: grant.refresh.prefix,
      createdAt: grant.t0.toISOString(),
      lastUsedAt: grant.accessRow.lastUsedAt!.toISOString(),
      expiresAt: grant.refresh.expiresAt.toISOString(),
    });
    expect(data[0].id).toBe(newer.info.id);
  });

  it('revokes a PAT or a whole OAuth grant; another user’s id is a 404', async () => {
    const alice = await signedIn(app);
    const bob = await signedIn(app);
    const pat = await createPat(alice);
    const grant = await oauthGrant(alice.user);

    expect((await api(bob, 'DELETE', `/me/tokens/${pat.info.id}`)).statusCode).toBe(404);
    expect((await api(bob, 'DELETE', `/me/tokens/${grant.family}`)).statusCode).toBe(404);
    expect((await api(alice, 'DELETE', `/me/tokens/${randomUUID()}`)).statusCode).toBe(404);
    expect((await api(alice, 'DELETE', `/me/tokens/${grant.accessRow.id}`)).statusCode, 'an access token is not a row of its own').toBe(404);
    expect((await mcp(bearer(pat.token))).statusCode, 'still works').not.toBe(401);

    expect((await api(alice, 'DELETE', `/me/tokens/${pat.info.id}`)).statusCode).toBe(204);
    expect((await api(alice, 'DELETE', `/me/tokens/${pat.info.id}`)).statusCode, 'again: still theirs').toBe(204);
    expect((await mcp(bearer(pat.token))).statusCode).toBe(401);

    expect((await mcp(bearer(grant.accessToken))).statusCode).not.toBe(401);
    expect((await api(alice, 'DELETE', `/me/tokens/${grant.family}`)).statusCode).toBe(204);
    expect((await mcp(bearer(grant.accessToken))).statusCode).toBe(401);
    const refreshes = await prisma.oAuthRefresh.findMany({ where: { family: grant.family } });
    expect(refreshes.every((r) => r.revokedAt)).toBe(true);
    expect((await api(alice, 'GET', '/me/tokens')).json().data).toEqual([]);
  });

  it('with MCP off: list and revoke still work, create is a 404', async () => {
    const alice = await signedIn(off);
    const pat = generateToken('mpat');
    const row = await prisma.apiToken.create({
      data: { userId: alice.user.id, name: 'old', source: 'PAT', scope: 'READ', prefix: pat.prefix, tokenHash: pat.hash },
    });
    expect((await api(alice, 'POST', '/me/tokens', { name: 'x', scope: 'READ' }, off)).statusCode).toBe(404);
    expect((await api(alice, 'GET', '/me/tokens', undefined, off)).json().data).toHaveLength(1);
    expect((await api(alice, 'DELETE', `/me/tokens/${row.id}`, undefined, off)).statusCode).toBe(204);
    for (const method of ['POST', 'GET', 'DELETE'] as const) {
      const disabled = await off.inject({ method, url: '/mcp', headers: bearer(pat.token) });
      expect([disabled.statusCode, disabled.json().error.message], method).toEqual([404, 'MCP is not enabled on this server']);
    }
  });
});

describe('bearer auth: only on /mcp', () => {
  it('answers a missing or bad token with 401 and the resource-metadata challenge', async () => {
    const none = await mcp();
    expect(none.statusCode).toBe(401);
    expect(none.headers['www-authenticate']).toBe(CHALLENGE);
    for (const authorization of ['Bearer nope', `Bearer ${generateToken('mpat').token}`, `bearer ${generateToken('mpoa').token}`, 'Bearer']) {
      const res = await mcp({ authorization });
      expect(res.statusCode, authorization).toBe(401);
      expect(res.headers['www-authenticate'], authorization).toBe(`${CHALLENGE}, error="invalid_token"`);
      expect(res.json().error.code).toBe('UNAUTHORIZED');
    }
    // Another scheme is no Bearer credential at all (RFC 6750 §3.1): the plain challenge.
    for (const authorization of ['Basic dTpw', 'Bearerx abc', 'Token abc']) {
      const res = await mcp({ authorization });
      expect(res.statusCode, authorization).toBe(401);
      expect(res.headers['www-authenticate'], authorization).toBe(CHALLENGE);
    }
  });

  it('accepts a live PAT or OAuth access token, never a refresh token or the session cookie', async () => {
    const alice = await signedIn(app);
    const pat = await createPat(alice);
    const grant = await oauthGrant(alice.user);
    for (const token of [pat.token, grant.accessToken]) {
      const res = await mcp(bearer(token));
      expect(res.statusCode).toBe(404);
      expect(res.json().error.message).toMatch(/MCP server is not available yet/);
    }
    expect((await mcp({ authorization: `bearer ${pat.token}` })).statusCode, 'the scheme is case-insensitive').toBe(404);
    expect((await mcp(bearer(grant.refreshToken))).statusCode).toBe(401);
    expect((await mcp({ cookie: alice.cookie })).statusCode).toBe(401);
  });

  it('refuses expired tokens and deactivated users', async () => {
    const alice = await signedIn(app);
    const pat = await createPat(alice);
    await prisma.apiToken.update({ where: { id: pat.info.id }, data: { expiresAt: new Date(Date.now() - 1) } });
    expect((await mcp(bearer(pat.token))).statusCode).toBe(401);

    const bob = await signedIn(app);
    const bobs = await createPat(bob);
    await prisma.user.update({ where: { id: bob.user.id }, data: { isActive: false } });
    expect((await mcp(bearer(bobs.token))).statusCode).toBe(401);
    await prisma.user.update({ where: { id: bob.user.id }, data: { isActive: true } });
    expect((await mcp(bearer(bobs.token))).statusCode, 'kept, not revoked (M16)').toBe(404);
  });

  it('never lets a bearer token drive /api/v1', async () => {
    const alice = await signedIn(app);
    const { token } = await createPat(alice);
    for (const url of ['/auth/me', '/me/tokens', '/projects']) {
      const res = await app.inject({ method: 'GET', url: `/api/v1${url}`, headers: bearer(token) });
      expect(res.statusCode, url).toBe(401);
    }
    const res = await app.inject({ method: 'POST', url: '/api/v1/me/tokens', headers: bearer(token), payload: { name: 'x', scope: 'WRITE' } });
    expect(res.statusCode).toBe(401);
  });

  it('records lastUsedAt at most once a minute', async () => {
    const alice = await signedIn(app);
    const { token, info } = await createPat(alice);
    const lastUsed = async () => (await prisma.apiToken.findUniqueOrThrow({ where: { id: info.id } })).lastUsedAt;
    await mcp(bearer(token));
    await expect.poll(lastUsed).not.toBeNull();
    const first = await lastUsed();
    await mcp(bearer(token));
    await new Promise((r) => setTimeout(r, 100));
    expect(await lastUsed()).toEqual(first);
  });
});

describe('a password change revokes every token and grant (M17)', () => {
  it('revokes PATs, OAuth families and unused codes; a name change does not', async () => {
    const alice = await signedIn(app);
    const bob = await signedIn(app);
    const pat = await createPat(alice);
    const bobs = await createPat(bob);
    const grant = await oauthGrant(alice.user);
    const code = generateToken('mpor');
    await prisma.oAuthCode.create({
      data: { codeHash: code.hash, clientId: grant.client.id, userId: alice.user.id, redirectUri: 'https://claude.ai/cb', codeChallenge: 'x', scope: 'WRITE', resource: `${APP_URL}/mcp`, expiresAt: new Date(Date.now() + 60_000) },
    });

    expect((await api(alice, 'PATCH', '/users/me', { name: 'Alice B' })).statusCode).toBe(200);
    expect((await mcp(bearer(pat.token))).statusCode).toBe(404);

    const res = await api(alice, 'PATCH', '/users/me', { currentPassword: PASSWORD, newPassword: 'another-password-1' });
    expect(res.statusCode, res.body).toBe(200);
    for (const token of [pat.token, grant.accessToken]) expect((await mcp(bearer(token))).statusCode).toBe(401);
    expect(await prisma.oAuthRefresh.count({ where: { userId: alice.user.id, revokedAt: null } })).toBe(0);
    expect(await prisma.oAuthCode.count({ where: { userId: alice.user.id } })).toBe(0);
    expect((await api(alice, 'GET', '/me/tokens')).json().data).toEqual([]);
    expect((await mcp(bearer(bobs.token))).statusCode, 'other users keep theirs').toBe(404);

    // A wrong current password changes nothing, so revokes nothing.
    const again = await createPat(alice);
    expect((await api(alice, 'PATCH', '/users/me', { currentPassword: 'wrong', newPassword: 'third-password-1' })).statusCode).toBe(400);
    expect((await mcp(bearer(again.token))).statusCode).toBe(404);
  });
});

describe('client IP behind the proxy (M2)', () => {
  it('a client-sent X-Forwarded-For entry cannot pick its own rate-limit bucket', async () => {
    const limited = await buildApp({ config: { ...loadConfig(), AUTH_RATE_LIMIT_MAX: 3 }, prisma, logger: false });
    try {
      const user = await createUser();
      const attempt = (xff: string) =>
        limited.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'x-forwarded-for': xff }, payload: { email: user.email, password: 'wrong' } });
      // nginx overwrites XFF with the real address; a client can only prepend entries of its own.
      const codes = [];
      for (let i = 0; i < 5; i++) codes.push((await attempt(`10.9.9.${i}, 203.0.113.7`)).statusCode);
      expect(codes).toEqual([401, 401, 401, 429, 429]);
      expect((await attempt('203.0.113.8')).statusCode, 'another real client has its own bucket').toBe(401);
    } finally {
      await limited.close();
    }
  });
});
