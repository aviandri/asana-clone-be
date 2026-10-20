import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { User } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { defaultPolicy, type FetchPolicy } from '../src/lib/link-preview.js';
import { hashToken } from '../src/lib/tokens.js';
import { MAX_CLIENTS, sweepOAuth } from '../src/routes/oauth.js';
import { PASSWORD, prisma, signedIn } from './helpers.js';

const APP_URL = 'https://project.example.com';
const RESOURCE = `${APP_URL}/mcp`;
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const DAY = 24 * 60 * 60 * 1000;

// --- a CIMD host: an https server with a throwaway CA, reached as client.test ----------------------

let tlsDir: string;
let docServer: Server;
let docPort = 0;
let caPem: string;
const docs = new Map<string, { status?: number; body: string; type?: string; location?: string }>();
let docHits = 0;

function makeCert() {
  tlsDir = mkdtempSync(join(tmpdir(), 'oauth-test-tls-'));
  const run = (...args: string[]) => execFileSync('openssl', args, { cwd: tlsDir, stdio: 'pipe' });
  run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=client.test', '-keyout', 'key.pem', '-out', 'cert.pem',
    '-addext', 'subjectAltName=DNS:client.test,DNS:other.test,IP:127.0.0.1');
  return { key: readFileSync(join(tlsDir, 'key.pem')), cert: readFileSync(join(tlsDir, 'cert.pem')) };
}

const docUrl = (path: string, host = 'client.test') => `https://${host}:${docPort}${path}`;

let app: FastifyInstance;
let policy: FetchPolicy;

beforeAll(async () => {
  const { key, cert } = makeCert();
  caPem = cert.toString();
  docServer = createServer({ key, cert }, (req, res) => {
    docHits += 1;
    const doc = docs.get(req.url!.split('?')[0]!);
    if (!doc) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(doc.status ?? 200, { 'Content-Type': doc.type ?? 'application/json', ...(doc.location ? { Location: doc.location } : {}) });
    res.end(doc.body);
  });
  await new Promise<void>((r) => docServer.listen(0, '127.0.0.1', r));
  docPort = (docServer.address() as AddressInfo).port;
  policy = {
    ...defaultPolicy,
    isAllowedAddress: () => true,
    allowAnyPort: true,
    ca: caPem,
    resolve: async (host) => (host === 'client.test' || host === 'other.test' ? [{ address: '127.0.0.1', family: 4 }] : []),
  };
  // Previews off: CIMD shares only the fetch policy, not the preview switch.
  app = await buildApp({
    config: { ...loadConfig(), APP_URL, MCP_ENABLED: true, LINK_PREVIEW_ENABLED: false, OAUTH_REGISTER_RATE_LIMIT: 1000, OAUTH_AUTHORIZE_RATE_LIMIT: 10_000 },
    prisma,
    logger: false,
    fetchPolicy: policy,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  docServer.closeAllConnections();
  await new Promise((r) => docServer.close(r));
  rmSync(tlsDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${rows.map((r) => `"public"."${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  docs.clear();
  docHits = 0;
});

// --- helpers -------------------------------------------------------------------------------------

type Session = { user: User; cookie: string };

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function register(body: object = {}) {
  return app.inject({ method: 'POST', url: '/oauth/register', payload: { client_name: 'Claude', redirect_uris: [CALLBACK], ...body } });
}

async function newClient(body: object = {}) {
  const res = await register(body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json().client_id as string;
}

function authorize(params: Record<string, string | undefined>) {
  const qs = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined));
  return app.inject({ method: 'GET', url: `/oauth/authorize?${qs}` });
}

function authorizeParams(clientId: string, challenge: string, extra: Record<string, string | undefined> = {}) {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-123',
    scope: 'read write',
    resource: RESOURCE,
    ...extra,
  };
}

/** The request id from a successful authorize redirect. */
function requestId(res: { statusCode: number; headers: Record<string, unknown>; body: string }) {
  expect(res.statusCode, res.body).toBe(302);
  const location = new URL(res.headers.location as string);
  expect(`${location.origin}${location.pathname}`).toBe(`${APP_URL}/connect/authorize`);
  return location.searchParams.get('request')!;
}

function decide(s: Session, id: string, body: object, contentType = 'application/json') {
  return app.inject({
    method: 'POST',
    url: `/api/v1/oauth/requests/${id}/decision`,
    headers: { cookie: s.cookie, 'content-type': contentType },
    payload: contentType === 'application/json' ? JSON.stringify(body) : JSON.stringify(body),
  });
}

function token(form: Record<string, string | undefined>, contentType = 'application/x-www-form-urlencoded') {
  const body = new URLSearchParams(Object.entries(form).filter((e): e is [string, string] => e[1] !== undefined)).toString();
  return app.inject({ method: 'POST', url: '/oauth/token', headers: { 'content-type': contentType }, payload: body });
}

/** Register → authorize → approve → the code, ready to exchange. */
async function codeFor(s: Session, opts: { scope?: string; decision?: object; clientId?: string; redirectUri?: string } = {}) {
  const clientId = opts.clientId ?? (await newClient());
  const { verifier, challenge } = pkce();
  const redirectUri = opts.redirectUri ?? CALLBACK;
  const id = requestId(await authorize(authorizeParams(clientId, challenge, { scope: opts.scope, redirect_uri: redirectUri })));
  const decided = await decide(s, id, opts.decision ?? { approve: true });
  expect(decided.statusCode, decided.body).toBe(200);
  const redirect = new URL(decided.json().redirectUrl);
  return { clientId, verifier, redirectUri, code: redirect.searchParams.get('code')!, redirect };
}

async function grant(s: Session, opts: Parameters<typeof codeFor>[1] = {}) {
  const c = await codeFor(s, opts);
  const res = await token({ grant_type: 'authorization_code', code: c.code, redirect_uri: c.redirectUri, client_id: c.clientId, code_verifier: c.verifier, resource: RESOURCE });
  expect(res.statusCode, res.body).toBe(200);
  return { ...c, tokens: res.json() as { access_token: string; refresh_token: string; scope: string; expires_in: number; token_type: string } };
}

const mcpStatus = async (accessToken: string) =>
  (await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }, payload: '{}' })).statusCode;

const refreshWith = (refreshToken: string, clientId: string, extra: Record<string, string> = {}) =>
  token({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, ...extra });

// --- metadata -------------------------------------------------------------------------------------

describe('metadata', () => {
  it('serves protected-resource and authorization-server metadata, with open CORS', async () => {
    for (const url of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.json(), url).toEqual({ resource: RESOURCE, authorization_servers: [APP_URL], scopes_supported: ['read', 'write'], bearer_methods_supported: ['header'] });
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    }
    const as = (await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).json();
    expect(as).toMatchObject({
      issuer: APP_URL,
      authorization_endpoint: `${APP_URL}/oauth/authorize`,
      token_endpoint: `${APP_URL}/oauth/token`,
      registration_endpoint: `${APP_URL}/oauth/register`,
      revocation_endpoint: `${APP_URL}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['read', 'write'],
      client_id_metadata_document_supported: true,
    });
  });

  it('answers preflights, and 404s (not 401s) anything else under /oauth and /.well-known', async () => {
    const pre = await app.inject({ method: 'OPTIONS', url: '/oauth/token', headers: { origin: 'https://inspector.example', 'access-control-request-method': 'POST' } });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('*');
    expect(pre.headers['access-control-allow-methods']).toContain('POST');
    for (const [method, url] of [['GET', '/.well-known/openid-configuration'], ['GET', '/oauth/nope'], ['POST', '/.well-known/x']] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, url).toBe(404);
    }
  });

  it('is all 404 with MCP off', async () => {
    const off = await buildApp({ config: { ...loadConfig(), MCP_ENABLED: false }, prisma, logger: false });
    try {
      const alice = await signedIn(off);
      for (const [method, url] of [
        ['GET', '/.well-known/oauth-protected-resource/mcp'],
        ['GET', '/.well-known/oauth-authorization-server'],
        ['POST', '/oauth/register'],
        ['GET', '/oauth/authorize?client_id=x'],
        ['POST', '/oauth/token'],
        ['POST', '/oauth/revoke'],
        ['GET', `/api/v1/oauth/requests/${randomUUID()}`],
      ] as const) {
        const res = await off.inject({ method, url, headers: { cookie: alice.cookie } });
        expect(res.statusCode, url).toBe(404);
      }
    } finally {
      await off.close();
    }
  });
});

// --- registration ---------------------------------------------------------------------------------

describe('dynamic client registration', () => {
  it('registers a public client', async () => {
    const res = await register({ redirect_uris: [CALLBACK, 'http://localhost:8765/cb'], client_name: ' Claude\u202E ' });
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toMatchObject({
      client_name: 'Claude',
      redirect_uris: [CALLBACK, 'http://localhost:8765/cb'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
    expect(res.json().client_id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(await prisma.oAuthClient.findUniqueOrThrow({ where: { clientId: res.json().client_id } })).toMatchObject({ source: 'DCR' });
  });

  it('refuses unsafe redirect URIs and confidential clients', async () => {
    for (const uri of ['http://evil.example/cb', 'https://claude.ai/cb#frag', 'https://*.claude.ai/cb', '/relative', 'https://u:p@claude.ai/cb', 'javascript:alert(1)']) {
      const res = await register({ redirect_uris: [uri] });
      expect([res.statusCode, res.json().error], uri).toEqual([400, 'invalid_redirect_uri']);
    }
    expect((await register({ redirect_uris: Array(6).fill(CALLBACK) })).json().error).toBe('invalid_redirect_uri');
    expect((await register({ redirect_uris: [] })).json().error).toBe('invalid_redirect_uri');
    expect((await register({ token_endpoint_auth_method: 'client_secret_basic' })).json().error).toBe('invalid_client_metadata');
    expect((await register({ grant_types: ['client_credentials'] })).json().error).toBe('invalid_client_metadata');
    expect((await register({ response_types: ['token'] })).json().error).toBe('invalid_client_metadata');
    expect(await prisma.oAuthClient.count()).toBe(0);
  });

  it('is rate-limited per IP', async () => {
    const limited = await buildApp({ config: { ...loadConfig(), APP_URL, MCP_ENABLED: true, OAUTH_REGISTER_RATE_LIMIT: 2 }, prisma, logger: false });
    try {
      const reg = (ip: string) =>
        limited.inject({ method: 'POST', url: '/oauth/register', headers: { 'x-forwarded-for': ip }, payload: { redirect_uris: [CALLBACK] } });
      expect([(await reg('198.51.100.1')).statusCode, (await reg('198.51.100.1')).statusCode, (await reg('198.51.100.1')).statusCode]).toEqual([201, 201, 429]);
      expect((await reg('198.51.100.2')).statusCode).toBe(201);
    } finally {
      await limited.close();
    }
  });

  it('rate-limits authorize per IP', async () => {
    const limited = await buildApp({ config: { ...loadConfig(), APP_URL, MCP_ENABLED: true, OAUTH_AUTHORIZE_RATE_LIMIT: 2 }, prisma, logger: false });
    try {
      const hit = () => limited.inject({ method: 'GET', url: `/oauth/authorize?client_id=${encodeURIComponent(docUrl('/x.json'))}` });
      expect([(await hit()).statusCode, (await hit()).statusCode, (await hit()).statusCode]).toEqual([400, 400, 429]);
    } finally {
      await limited.close();
    }
  });

  it('prunes stale clients at the cap, else answers 503', async () => {
    const old = new Date(Date.now() - 2 * DAY);
    await prisma.oAuthClient.createMany({
      data: Array.from({ length: MAX_CLIENTS }, (_, i) => ({ clientId: `c${i}`, name: 'x', redirectUris: [CALLBACK], createdAt: i < 10 ? old : new Date() })),
    });
    expect((await register()).statusCode, 'ten never-used day-old clients make room').toBe(201);
    await prisma.oAuthClient.createMany({ data: Array.from({ length: 9 }, (_, i) => ({ clientId: `d${i}`, name: 'x', redirectUris: [CALLBACK] })) });
    const full = await register();
    expect([full.statusCode, full.json().error]).toEqual([503, 'temporarily_unavailable']);
  });
});

// --- authorize + consent ---------------------------------------------------------------------------

describe('authorize', () => {
  it('never redirects for an unknown client or an unregistered redirect URI', async () => {
    const clientId = await newClient();
    const { challenge } = pkce();
    for (const params of [
      authorizeParams('no-such-client', challenge),
      authorizeParams(clientId, challenge, { redirect_uri: 'https://evil.example/cb' }),
      authorizeParams(clientId, challenge, { redirect_uri: `${CALLBACK}/x` }),
      authorizeParams(clientId, challenge, { redirect_uri: undefined }),
      authorizeParams(clientId, challenge, { client_id: undefined }),
    ]) {
      const res = await authorize(params);
      expect(res.statusCode).toBe(400);
      expect(res.headers.location).toBeUndefined();
      expect(res.headers['content-type']).toMatch(/^text\/html/);
      expect(res.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    }
  });

  it('redirects other errors back with state and iss', async () => {
    const clientId = await newClient();
    const { challenge } = pkce();
    for (const [extra, error] of [
      [{ code_challenge: undefined }, 'invalid_request'],
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
      [{ code_challenge_method: undefined }, 'invalid_request'],
      [{ code_challenge: 'short' }, 'invalid_request'],
      [{ resource: 'https://evil.example/mcp' }, 'invalid_target'],
      [{ scope: 'read admin' }, 'invalid_scope'],
      [{ response_type: 'token' }, 'unsupported_response_type'],
    ] as const) {
      const res = await authorize(authorizeParams(clientId, challenge, extra));
      expect(res.statusCode, JSON.stringify(extra)).toBe(302);
      const location = new URL(res.headers.location as string);
      expect(`${location.origin}${location.pathname}`).toBe(CALLBACK);
      expect(Object.fromEntries(location.searchParams)).toMatchObject({ error, state: 'st-123', iss: APP_URL });
    }
    expect(await prisma.oAuthRequest.count()).toBe(0);
  });

  it('stores the validated request and sends the user to the consent page', async () => {
    const clientId = await newClient();
    const { challenge } = pkce();
    const id = requestId(await authorize(authorizeParams(clientId, challenge, { scope: 'read', resource: undefined })));
    const stored = await prisma.oAuthRequest.findUniqueOrThrow({ where: { id } });
    expect(stored).toMatchObject({ redirectUri: CALLBACK, codeChallenge: challenge, scope: 'READ', resource: RESOURCE, state: 'st-123', userId: null, decidedAt: null });
    expect(stored.expiresAt.getTime() - Date.now()).toBeGreaterThan(9 * 60 * 1000);
    // Omitted scope = read write.
    const all = requestId(await authorize(authorizeParams(clientId, challenge, { scope: undefined })));
    expect((await prisma.oAuthRequest.findUniqueOrThrow({ where: { id: all } })).scope).toBe('WRITE');
  });

  it('matches loopback redirect URIs with any port, everything else exactly (M12)', async () => {
    const clientId = await newClient({ redirect_uris: ['http://127.0.0.1/callback', 'http://localhost:3000/cb'] });
    const { challenge } = pkce();
    for (const uri of ['http://127.0.0.1:53111/callback', 'http://127.0.0.1/callback', 'http://localhost:9999/cb', 'http://localhost/cb']) {
      requestId(await authorize(authorizeParams(clientId, challenge, { redirect_uri: uri })));
    }
    for (const uri of ['http://127.0.0.1:53111/other', 'https://127.0.0.1:53111/callback', 'http://localhost.evil.example/cb', 'http://127.0.0.1:1/callback?x=1']) {
      expect((await authorize(authorizeParams(clientId, challenge, { redirect_uri: uri }))).statusCode, uri).toBe(400);
    }
  });
});

describe('consent API', () => {
  it('describes the request for the consent page (M28)', async () => {
    const alice = await signedIn(app, { name: 'Alice' });
    const clientId = await newClient({ redirect_uris: ['http://localhost:4000/cb'] });
    const { challenge } = pkce();
    const id = requestId(await authorize(authorizeParams(clientId, challenge, { scope: 'read', redirect_uri: 'http://localhost:51000/cb' })));
    const res = await app.inject({ method: 'GET', url: `/api/v1/oauth/requests/${id}`, headers: { cookie: alice.cookie } });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['client', 'expiresAt', 'isLocalRedirect', 'requestedScopes', 'user', 'workspaces']);
    expect(body).toMatchObject({
      client: { name: 'Claude', redirectHost: 'localhost:51000', clientIdHost: null },
      requestedScopes: ['read'],
      isLocalRedirect: true,
      user: { id: alice.user.id, name: 'Alice' },
    });
    expect(body.workspaces).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: `/api/v1/oauth/requests/${id}` })).statusCode, 'cookie only').toBe(401);
    expect((await app.inject({ method: 'GET', url: `/api/v1/oauth/requests/${randomUUID()}`, headers: { cookie: alice.cookie } })).statusCode).toBe(404);
    await prisma.oAuthRequest.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1) } });
    expect((await app.inject({ method: 'GET', url: `/api/v1/oauth/requests/${id}`, headers: { cookie: alice.cookie } })).statusCode).toBe(410);
  });

  it('works for a user with no workspace (M8)', async () => {
    const loner = await signedIn(app, { workspaceId: null });
    const { tokens } = await grant(loner);
    expect(tokens.scope).toBe('read write');
  });

  it('decides once: JSON only; approve, deny, downgrade; WRITE on a read request is refused', async () => {
    const alice = await signedIn(app);
    const clientId = await newClient();
    const { challenge } = pkce();
    const id = requestId(await authorize(authorizeParams(clientId, challenge)));
    expect((await decide(alice, id, { approve: true }, 'text/plain')).statusCode).toBe(415);
    expect((await decide(alice, id, { approve: true }, 'application/x-www-form-urlencoded')).statusCode).toBe(415);
    const denied = await decide(alice, id, { approve: false });
    expect(Object.fromEntries(new URL(denied.json().redirectUrl).searchParams)).toEqual({ error: 'access_denied', state: 'st-123', iss: APP_URL });
    expect((await decide(alice, id, { approve: true })).statusCode, 'already decided').toBe(409);
    expect((await app.inject({ method: 'GET', url: `/api/v1/oauth/requests/${id}`, headers: { cookie: alice.cookie } })).statusCode).toBe(410);

    const readOnly = requestId(await authorize(authorizeParams(clientId, challenge, { scope: 'read' })));
    expect((await decide(alice, readOnly, { approve: true, scope: 'WRITE' })).statusCode).toBe(400);
    const expired = requestId(await authorize(authorizeParams(clientId, challenge)));
    await prisma.oAuthRequest.update({ where: { id: expired }, data: { expiresAt: new Date(Date.now() - 1) } });
    expect((await decide(alice, expired, { approve: true })).statusCode).toBe(410);
    expect((await decide(alice, randomUUID(), { approve: true })).statusCode).toBe(404);

    const { tokens } = await grant(alice, { decision: { approve: true, scope: 'READ' } });
    expect(tokens.scope, 'downgraded to read-only').toBe('read');
    expect((await prisma.apiToken.findUniqueOrThrow({ where: { tokenHash: hashToken(tokens.access_token) } })).scope).toBe('READ');
  });

  it('two decisions racing: exactly one wins', async () => {
    const alice = await signedIn(app);
    const clientId = await newClient();
    const id = requestId(await authorize(authorizeParams(clientId, pkce().challenge)));
    const results = await Promise.all(Array.from({ length: 5 }, () => decide(alice, id, { approve: true })));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409, 409, 409, 409]);
    expect(await prisma.oAuthCode.count()).toBe(1);
  });
});

// --- token ------------------------------------------------------------------------------------------

describe('token endpoint', () => {
  it('exchanges a code for tokens that work on /mcp (and are listed in /me/tokens)', async () => {
    const alice = await signedIn(app);
    const c = await codeFor(alice);
    expect(Object.fromEntries(c.redirect.searchParams)).toMatchObject({ state: 'st-123', iss: APP_URL });
    const res = await token({ grant_type: 'authorization_code', code: c.code, redirect_uri: CALLBACK, client_id: c.clientId, code_verifier: c.verifier, resource: RESOURCE });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const t = res.json();
    expect(t).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'read write' });
    expect(t.access_token).toMatch(/^mpoa_/);
    expect(t.refresh_token).toMatch(/^mpor_/);
    expect(await mcpStatus(t.access_token), 'authenticated (the placeholder 404)').toBe(404);
    const listed = (await app.inject({ method: 'GET', url: '/api/v1/me/tokens', headers: { cookie: alice.cookie } })).json().data;
    expect(listed).toEqual([expect.objectContaining({ source: 'OAUTH', name: 'Claude', scope: 'WRITE', prefix: t.refresh_token.slice(0, 12) })]);
  });

  it('checks PKCE, redirect_uri, client and resource; any failed attempt burns the code', async () => {
    const alice = await signedIn(app);
    const other = await newClient();
    for (const [change, error] of [
      [{ code_verifier: pkce().verifier }, 'invalid_grant'],
      [{ code_verifier: 'too-short' }, 'invalid_grant'],
      [{ redirect_uri: `${CALLBACK}?x=1` }, 'invalid_grant'],
      [{ client_id: 'other' }, 'invalid_client'],
      [{ resource: 'https://evil.example/mcp' }, 'invalid_target'],
    ] as const) {
      const c = await codeFor(alice);
      const base = { grant_type: 'authorization_code', code: c.code, redirect_uri: CALLBACK, client_id: c.clientId, code_verifier: c.verifier };
      const bad = await token({ ...base, ...(change.client_id ? { client_id: change.client_id === 'other' ? 'no-such' : other } : change) });
      expect([bad.statusCode, bad.json().error], JSON.stringify(change)).toEqual([error === 'invalid_client' ? 401 : 400, error]);
      if (error !== 'invalid_client') {
        expect((await token(base)).json().error, 'burnt').toBe('invalid_grant');
      }
    }
    const c = await codeFor(alice);
    const wrongClient = await token({ grant_type: 'authorization_code', code: c.code, redirect_uri: CALLBACK, client_id: other, code_verifier: c.verifier });
    expect(wrongClient.json().error).toBe('invalid_grant');
  });

  it('a reused code revokes the tokens it issued', async () => {
    const alice = await signedIn(app);
    const c = await codeFor(alice);
    const form = { grant_type: 'authorization_code', code: c.code, redirect_uri: CALLBACK, client_id: c.clientId, code_verifier: c.verifier };
    const first = (await token(form)).json();
    expect(await mcpStatus(first.access_token)).toBe(404);
    expect((await token(form)).json().error).toBe('invalid_grant');
    expect(await mcpStatus(first.access_token)).toBe(401);
    expect((await refreshWith(first.refresh_token, c.clientId)).json().error).toBe('invalid_grant');
  });

  it('refuses expired codes, inactive users, other grants and malformed bodies', async () => {
    const alice = await signedIn(app);
    const c = await codeFor(alice);
    await prisma.oAuthCode.updateMany({ data: { expiresAt: new Date(Date.now() - 1) } });
    const form = { grant_type: 'authorization_code', code: c.code, redirect_uri: CALLBACK, client_id: c.clientId, code_verifier: c.verifier };
    expect((await token(form)).json().error).toBe('invalid_grant');

    const bob = await signedIn(app);
    const b = await codeFor(bob);
    await prisma.user.update({ where: { id: bob.user.id }, data: { isActive: false } });
    expect((await token({ grant_type: 'authorization_code', code: b.code, redirect_uri: CALLBACK, client_id: b.clientId, code_verifier: b.verifier })).json().error).toBe('invalid_grant');

    expect((await token({ grant_type: 'client_credentials' })).json().error).toBe('unsupported_grant_type');
    expect((await token({})).json().error).toBe('invalid_request');
    const json = await app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token' } });
    expect([json.statusCode, json.json().error]).toEqual([400, 'invalid_request']);
    const dup = await app.inject({ method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'grant_type=refresh_token&grant_type=authorization_code' });
    expect(dup.json().error).toBe('invalid_request');
  });
});

describe('refresh rotation', () => {
  it('rotates: a new pair each time, the old refresh token used', async () => {
    const alice = await signedIn(app);
    const { clientId, tokens } = await grant(alice);
    const next = await refreshWith(tokens.refresh_token, clientId, { resource: RESOURCE });
    expect(next.statusCode, next.body).toBe(200);
    const t2 = next.json();
    expect(t2.refresh_token).not.toBe(tokens.refresh_token);
    expect(t2.scope).toBe('read write');
    expect(await mcpStatus(t2.access_token)).toBe(404);
    const third = (await refreshWith(t2.refresh_token, clientId)).json();
    expect(await mcpStatus(third.access_token)).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/me/tokens', headers: { cookie: alice.cookie } })).json().data, 'still one grant').toHaveLength(1);
  });

  it('a reuse within 30 s is a race: invalid_grant, family kept; later reuse revokes the family (M20)', async () => {
    const alice = await signedIn(app);
    const { clientId, tokens } = await grant(alice);
    const t2 = (await refreshWith(tokens.refresh_token, clientId)).json();
    const raced = await refreshWith(tokens.refresh_token, clientId);
    expect([raced.statusCode, raced.json().error]).toEqual([400, 'invalid_grant']);
    expect(await mcpStatus(t2.access_token), 'family kept').toBe(404);

    await prisma.oAuthRefresh.updateMany({ where: { tokenHash: hashToken(tokens.refresh_token) }, data: { usedAt: new Date(Date.now() - 31_000) } });
    expect((await refreshWith(tokens.refresh_token, clientId)).json().error).toBe('invalid_grant');
    expect(await mcpStatus(t2.access_token), 'stolen token replayed: everything goes').toBe(401);
    expect((await refreshWith(t2.refresh_token, clientId)).json().error).toBe('invalid_grant');
  });

  it('concurrent refreshes of one token: exactly one wins, the grant survives', async () => {
    const alice = await signedIn(app);
    const { clientId, tokens } = await grant(alice);
    const results = await Promise.all(Array.from({ length: 4 }, () => refreshWith(tokens.refresh_token, clientId)));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400, 400, 400]);
    const winner = results.find((r) => r.statusCode === 200)!.json();
    expect(await mcpStatus(winner.access_token)).toBe(404);
  });

  it('every refresh failure is invalid_grant (M13)', async () => {
    const alice = await signedIn(app);
    const { clientId, tokens } = await grant(alice);
    const other = await newClient();
    for (const form of [
      { refresh_token: tokens.refresh_token, client_id: other },
      { refresh_token: tokens.refresh_token, client_id: 'no-such-client' },
      { refresh_token: 'mpor_nope', client_id: clientId },
      { refresh_token: tokens.access_token, client_id: clientId },
      { refresh_token: tokens.refresh_token, client_id: clientId, resource: 'https://evil.example/mcp' },
      { client_id: clientId },
    ]) {
      const res = await token({ grant_type: 'refresh_token', ...form });
      expect([res.statusCode, res.json().error], JSON.stringify(form)).toEqual([400, 'invalid_grant']);
    }
    // A parameter twice, even with the same value, is malformed (RFC 6749 §3.2).
    const dup = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `${new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId })}&client_id=${encodeURIComponent(clientId)}`,
    });
    expect(dup.json().error).toBe('invalid_request');
    await prisma.user.update({ where: { id: alice.user.id }, data: { isActive: false } });
    expect((await refreshWith(tokens.refresh_token, clientId)).json().error, 'deactivated user').toBe('invalid_grant');
    await prisma.user.update({ where: { id: alice.user.id }, data: { isActive: true } });
    expect((await refreshWith(tokens.refresh_token, clientId)).statusCode, 'the token itself was still good').toBe(200);
    await prisma.oAuthRefresh.updateMany({ data: { expiresAt: new Date(Date.now() - 1) } });
    expect((await refreshWith(tokens.refresh_token, clientId)).json().error).toBe('invalid_grant');
  });

  it('a refresh racing a password change never leaves a live grant', async () => {
    for (let round = 0; round < 5; round++) {
      const user = await signedIn(app);
      const { clientId, tokens } = await grant(user);
      const [refreshed, changed] = await Promise.all([
        refreshWith(tokens.refresh_token, clientId),
        app.inject({ method: 'PATCH', url: '/api/v1/users/me', headers: { cookie: user.cookie }, payload: { currentPassword: PASSWORD, newPassword: `new-password-${round}x` } }),
      ]);
      expect(changed.statusCode).toBe(200);
      expect([200, 400]).toContain(refreshed.statusCode);
      expect(await prisma.oAuthRefresh.count({ where: { userId: user.user.id, revokedAt: null } }), `round ${round}`).toBe(0);
      expect(await prisma.apiToken.count({ where: { userId: user.user.id, revokedAt: null } }), `round ${round}`).toBe(0);
    }
  });
});

describe('revocation (RFC 7009)', () => {
  it('revokes a refresh token’s whole grant, or one access token; always 200', async () => {
    const alice = await signedIn(app);
    const a = await grant(alice);
    const b = await grant(alice);
    const revoke = (form: Record<string, string>) =>
      app.inject({ method: 'POST', url: '/oauth/revoke', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(form).toString() });

    expect((await revoke({ token: a.tokens.refresh_token, client_id: b.clientId })).statusCode, 'not its client').toBe(200);
    expect(await mcpStatus(a.tokens.access_token)).toBe(404);
    expect((await revoke({ token: a.tokens.refresh_token, client_id: a.clientId })).statusCode).toBe(200);
    expect(await mcpStatus(a.tokens.access_token)).toBe(401);
    expect((await refreshWith(a.tokens.refresh_token, a.clientId)).json().error).toBe('invalid_grant');

    expect((await revoke({ token: b.tokens.access_token, client_id: b.clientId })).statusCode).toBe(200);
    expect(await mcpStatus(b.tokens.access_token)).toBe(401);
    expect((await refreshWith(b.tokens.refresh_token, b.clientId)).statusCode, 'an access token alone: the grant stays').toBe(200);
    for (const form of [{ token: 'garbage', client_id: 'x' }, { token: '' }, {}]) {
      expect((await revoke(form as Record<string, string>)).statusCode).toBe(200);
    }
  });
});

// --- CIMD -------------------------------------------------------------------------------------------

describe('client ID metadata documents (M11)', () => {
  const doc = (url: string, extra: object = {}) => JSON.stringify({ client_id: url, client_name: 'Claude Code', redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'], ...extra });

  it('fetches the document once a day (with previews off), and shows its host on the consent page', async () => {
    const url = docUrl('/client.json');
    docs.set('/client.json', { body: doc(url) });
    const alice = await signedIn(app);
    const { verifier, challenge } = pkce();
    const id = requestId(await authorize(authorizeParams(url, challenge, { redirect_uri: 'http://127.0.0.1:61000/callback' })));
    expect(docHits).toBe(1);
    const consent = (await app.inject({ method: 'GET', url: `/api/v1/oauth/requests/${id}`, headers: { cookie: alice.cookie } })).json();
    expect(consent.client).toEqual({ name: 'Claude Code', redirectHost: '127.0.0.1:61000', clientIdHost: `client.test:${docPort}` });
    expect(await prisma.oAuthClient.findUniqueOrThrow({ where: { clientId: url } })).toMatchObject({ source: 'CIMD' });

    requestId(await authorize(authorizeParams(url, challenge, { redirect_uri: 'http://localhost:1234/callback' })));
    expect(docHits, 'cached').toBe(1);

    const code = new URL((await decide(alice, id, { approve: true })).json().redirectUrl).searchParams.get('code')!;
    const res = await token({ grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1:61000/callback', client_id: url, code_verifier: verifier });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('refuses a document that doesn’t name itself, is too large, or redirects to another host', async () => {
    const { challenge } = pkce();
    const cases: [string, object][] = [
      ['/wrong-id.json', { body: doc('https://elsewhere.example/client.json') }],
      // Valid JSON in its first 64 KB: only the size cap refuses it.
      ['/big.json', { body: doc(docUrl('/big.json')) + ' '.repeat(70 * 1024) }],
      ['/hop.json', { status: 302, body: '', location: docUrl('/hop-target.json', 'other.test') }],
      ['/bad-uri.json', { body: doc(docUrl('/bad-uri.json'), { redirect_uris: ['http://evil.example/cb'] }) }],
      ['/not-json.json', { body: '<html>', type: 'text/html' }],
    ];
    // The target names the original URL: only the cross-host rule refuses it.
    docs.set('/hop-target.json', { body: doc(docUrl('/hop.json')) });
    for (const [path, d] of cases) {
      docs.set(path, d as never);
      const res = await authorize(authorizeParams(docUrl(path), challenge, { redirect_uri: 'http://localhost/callback' }));
      expect(res.statusCode, path).toBe(400);
      expect(res.headers.location, path).toBeUndefined();
    }
    expect(await prisma.oAuthClient.count()).toBe(0);
    docs.set('/moved.json', { status: 301, body: '', location: docUrl('/moved-to.json') });
    docs.set('/moved-to.json', { body: doc(docUrl('/moved.json')) });
    requestId(await authorize(authorizeParams(docUrl('/moved.json'), challenge, { redirect_uri: 'http://localhost/callback' })));
    // Not a document URL at all: an http URL is just an unknown client_id.
    expect((await authorize(authorizeParams(`http://client.test:${docPort}/client.json`, challenge))).statusCode).toBe(400);
  });

  it('counts against the client cap', async () => {
    await prisma.oAuthClient.createMany({ data: Array.from({ length: MAX_CLIENTS }, (_, i) => ({ clientId: `c${i}`, name: 'x', redirectUris: [CALLBACK] })) });
    const url = docUrl('/client.json');
    docs.set('/client.json', { body: doc(url) });
    const res = await authorize(authorizeParams(url, pkce().challenge, { redirect_uri: 'http://localhost/callback' }));
    expect(res.statusCode).toBe(400);
    expect(docHits, 'not even fetched').toBe(0);
    await prisma.oAuthClient.updateMany({ where: { clientId: { in: ['c0', 'c1'] } }, data: { createdAt: new Date(Date.now() - 2 * DAY) } });
    requestId(await authorize(authorizeParams(url, pkce().challenge, { redirect_uri: 'http://localhost/callback' })));
  });

  it('uses a cached copy under a week old when the document is down, refetches a stale one', async () => {
    const url = docUrl('/flaky.json');
    docs.set('/flaky.json', { body: doc(url) });
    const { challenge } = pkce();
    const params = authorizeParams(url, challenge, { redirect_uri: 'http://localhost/callback' });
    requestId(await authorize(params));
    docs.delete('/flaky.json');
    await prisma.oAuthClient.update({ where: { clientId: url }, data: { cachedAt: new Date(Date.now() - 2 * DAY) } });
    requestId(await authorize(params));
    expect(docHits, 'tried to refresh it').toBe(2);
    await prisma.oAuthClient.update({ where: { clientId: url }, data: { cachedAt: new Date(Date.now() - 8 * DAY) } });
    expect((await authorize(params)).statusCode, 'too old to trust').toBe(400);

    docs.set('/flaky.json', { body: doc(url, { client_name: 'Renamed' }) });
    await prisma.oAuthClient.update({ where: { clientId: url }, data: { cachedAt: new Date(Date.now() - 2 * DAY) } });
    requestId(await authorize(params));
    expect((await prisma.oAuthClient.findUniqueOrThrow({ where: { clientId: url } })).name).toBe('Renamed');
  });
});

// --- sweeper ---------------------------------------------------------------------------------------

describe('sweepOAuth', () => {
  it('removes stale requests, codes, dead tokens and unused clients; keeps what is live', async () => {
    const alice = await signedIn(app);
    const live = await grant(alice);
    const now = new Date();
    const old = (ms: number) => new Date(now.getTime() - ms);
    const staleClient = await prisma.oAuthClient.create({ data: { clientId: 'stale', name: 'x', redirectUris: [CALLBACK], createdAt: old(2 * DAY) } });
    const freshClient = await prisma.oAuthClient.create({ data: { clientId: 'fresh', name: 'x', redirectUris: [CALLBACK] } });
    const unusedMonth = await prisma.oAuthClient.create({ data: { clientId: 'cimd', source: 'CIMD', name: 'x', redirectUris: [CALLBACK], createdAt: old(40 * DAY), lastUsedAt: old(31 * DAY) } });
    const cimdNeverUsed = await prisma.oAuthClient.create({ data: { clientId: 'https://c.example/x', source: 'CIMD', name: 'x', redirectUris: [CALLBACK], createdAt: old(2 * DAY), cachedAt: old(2 * DAY) } });
    await prisma.oAuthRequest.create({ data: { clientId: freshClient.id, redirectUri: CALLBACK, codeChallenge: 'x', scope: 'READ', resource: RESOURCE, expiresAt: old(2 * 60 * 60 * 1000) } });
    const keepRequest = await prisma.oAuthRequest.create({ data: { clientId: freshClient.id, redirectUri: CALLBACK, codeChallenge: 'x', scope: 'READ', resource: RESOURCE, expiresAt: old(30 * 60 * 1000) } });
    await prisma.oAuthCode.create({ data: { codeHash: 'h1', clientId: freshClient.id, userId: alice.user.id, redirectUri: CALLBACK, codeChallenge: 'x', scope: 'READ', resource: RESOURCE, expiresAt: old(2 * 60 * 60 * 1000) } });
    await prisma.apiToken.create({ data: { userId: alice.user.id, name: 'dead', source: 'PAT', scope: 'READ', prefix: 'p', tokenHash: 'dead', revokedAt: old(31 * DAY) } });
    await prisma.apiToken.create({ data: { userId: alice.user.id, name: 'recent', source: 'PAT', scope: 'READ', prefix: 'p', tokenHash: 'recent', revokedAt: old(DAY) } });

    // Unused for a month, but a grant is still live: kept.
    await prisma.oAuthClient.update({ where: { clientId: live.clientId }, data: { lastUsedAt: old(31 * DAY) } });
    const r = await sweepOAuth(prisma, now);
    expect(r).toMatchObject({ requests: 1, codes: 1, tokens: 1, refreshes: 0, clients: 3 });
    expect(await prisma.oAuthClient.findUnique({ where: { id: cimdNeverUsed.id } })).toBeNull();
    expect(await prisma.oAuthClient.findUnique({ where: { id: staleClient.id } })).toBeNull();
    expect(await prisma.oAuthClient.findUnique({ where: { id: unusedMonth.id } })).toBeNull();
    expect(await prisma.oAuthClient.findUnique({ where: { id: freshClient.id } })).not.toBeNull();
    expect(await prisma.oAuthRequest.findUnique({ where: { id: keepRequest.id } })).not.toBeNull();
    expect(await prisma.apiToken.count({ where: { name: 'recent' } })).toBe(1);
    expect(await mcpStatus(live.tokens.access_token), 'the live grant and its client stay').toBe(404);
  });
});
