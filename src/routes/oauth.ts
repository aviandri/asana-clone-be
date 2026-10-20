import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { OAuthClient, Prisma, TokenScope } from '@prisma/client';
import { z } from 'zod';
import { AppError, conflict, notFound, validation } from '../errors.js';
import { generateToken, hashToken, lockUser, revokeFamily } from '../lib/tokens.js';
import {
  ACCESS_TOKEN_TTL_S,
  CODE_TTL_MS,
  escapeHtml,
  isLoopbackRedirect,
  parseScope,
  pkceMatches,
  REFRESH_REUSE_GRACE_MS,
  REFRESH_TOKEN_TTL_MS,
  redirectUriMatches,
  redirectUriProblem,
  REQUEST_TTL_MS,
  S256_CHALLENGE,
  scopeList,
  scopeString,
  withParams,
} from '../lib/oauth.js';
import { clientName, MAX_CLIENTS, MAX_REDIRECT_URIS, resolveClient } from '../lib/oauth-clients.js';

export { MAX_CLIENTS };
import { idParams, parse } from '../lib/validate.js';
import { loadMe } from '../lib/workspaces.js';

const DAY_MS = 24 * 60 * 60 * 1000;

type Db = FastifyInstance['db'];

/** RFC 6749 §5.2 / RFC 7591 §3.2.2 error bodies. */
class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
  }
}

function sendOAuthError(reply: FastifyReply, err: OAuthError) {
  return reply
    .status(err.status)
    .header('Cache-Control', 'no-store')
    .send({ error: err.error, error_description: err.description });
}

/** A form body: one value per name (RFC 6749 §3.2: parameters must not repeat). */
type Form = Record<string, string>;
const DUPLICATE = Symbol('duplicate');

/**
 * Prunes clients nobody uses (M11): ones that never got a token after a day, any unused for 30 days.
 * CIMD clients too: they are only a cache of their document, refetched on next use.
 */
export async function pruneOAuthClients(db: Db, now: Date) {
  const neverUsed = await db.oAuthClient.deleteMany({
    where: { createdAt: { lt: new Date(now.getTime() - DAY_MS) }, tokens: { none: {} }, refreshes: { none: {} } },
  });
  const cutoff = new Date(now.getTime() - 30 * DAY_MS);
  const unused = await db.oAuthClient.deleteMany({
    where: {
      OR: [{ lastUsedAt: { lt: cutoff } }, { lastUsedAt: null, createdAt: { lt: cutoff } }],
      refreshes: { none: { revokedAt: null, expiresAt: { gt: now } } },
    },
  });
  return neverUsed.count + unused.count;
}

/** The sweeper's OAuth share (M26): stale requests and codes after 1 h, dead tokens and grants after 30 d. */
export async function sweepOAuth(db: Db, now: Date) {
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const monthAgo = new Date(now.getTime() - 30 * DAY_MS);
  const [requests, codes, tokens, refreshes] = await Promise.all([
    db.oAuthRequest.deleteMany({ where: { expiresAt: { lt: hourAgo } } }),
    db.oAuthCode.deleteMany({ where: { expiresAt: { lt: hourAgo } } }),
    db.apiToken.deleteMany({ where: { OR: [{ revokedAt: { lt: monthAgo } }, { expiresAt: { lt: monthAgo } }] } }),
    db.oAuthRefresh.deleteMany({ where: { OR: [{ revokedAt: { lt: monthAgo } }, { expiresAt: { lt: monthAgo } }] } }),
  ]);
  const clients = await pruneOAuthClients(db, now);
  return { requests: requests.count, codes: codes.count, tokens: tokens.count, refreshes: refreshes.count, clients };
}

/** Issues an access token and a refresh token in `family` (a new grant, or a rotation). Under lockUser. */
async function issueTokens(tx: Prisma.TransactionClient, client: OAuthClient, userId: string, scope: TokenScope, family: string, now: Date) {
  const access = generateToken('mpoa');
  const refresh = generateToken('mpor');
  await tx.apiToken.create({
    data: {
      userId,
      name: client.name,
      source: 'OAUTH',
      scope,
      prefix: access.prefix,
      tokenHash: access.hash,
      oauthClientId: client.id,
      oauthFamily: family,
      createdAt: now,
      expiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_S * 1000),
    },
  });
  await tx.oAuthRefresh.create({
    data: {
      tokenHash: refresh.hash,
      prefix: refresh.prefix,
      family,
      clientId: client.id,
      userId,
      scope,
      createdAt: now,
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
    },
  });
  await tx.oAuthClient.update({ where: { id: client.id }, data: { lastUsedAt: now } });
  return {
    access_token: access.token,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_S,
    refresh_token: refresh.token,
    scope: scopeString(scope),
  };
}

/** The OAuth endpoints at the server root (/.well-known, /oauth). Public: they never read the session cookie. */
export default async function oauthRoutes(app: FastifyInstance) {
  const db = app.db;
  const base = app.config.APP_URL;
  const resource = `${base}/mcp`;
  const enabled = app.config.MCP_ENABLED ?? false;
  const pub = { config: { public: true } };

  app.addHook('onRequest', async () => {
    if (!enabled) throw notFound('Route');
  });
  // Metadata and token endpoints are read by browser-based clients too: open CORS, never credentials.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
  });
  for (const path of ['/oauth/*', '/.well-known/*']) {
    app.options(path, pub, async (_req, reply) =>
      reply
        .status(204)
        .header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        .header('Access-Control-Allow-Headers', 'Content-Type, Authorization, MCP-Protocol-Version')
        .header('Access-Control-Max-Age', '86400')
        .send(),
    );
  }
  // Anything else under them is a plain 404, not the 401 an unknown route gets without a session.
  for (const path of ['/oauth/*', '/.well-known/*']) {
    app.route({ method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], url: path, ...pub, handler: async () => {
      throw notFound('Route');
    } });
  }

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 16 * 1024 }, (_req, body, done) => {
    const form: Form & { [DUPLICATE]?: true } = {};
    for (const [k, v] of new URLSearchParams(body as string)) {
      if (k in form) form[DUPLICATE] = true;
      form[k] = v;
    }
    done(null, form);
  });

  // --- metadata (RFC 9728, RFC 8414) ---

  const protectedResource = {
    resource,
    authorization_servers: [base],
    scopes_supported: ['read', 'write'],
    bearer_methods_supported: ['header'],
  };
  app.get('/.well-known/oauth-protected-resource/mcp', pub, async () => protectedResource);
  app.get('/.well-known/oauth-protected-resource', pub, async () => protectedResource);
  app.get('/.well-known/oauth-authorization-server', pub, async () => ({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['read', 'write'],
    client_id_metadata_document_supported: true,
  }));

  // --- dynamic client registration (RFC 7591) ---

  const Registration = z.object({
    client_name: clientName.optional(),
    redirect_uris: z.array(z.string()).min(1).max(MAX_REDIRECT_URIS),
    token_endpoint_auth_method: z.string().optional(),
    grant_types: z.array(z.string()).optional(),
    response_types: z.array(z.string()).optional(),
  });

  app.post(
    '/oauth/register',
    { config: { public: true, rateLimit: { max: app.config.OAUTH_REGISTER_RATE_LIMIT ?? 30, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const parsed = Registration.safeParse(req.body);
      if (!parsed.success) {
        const field = parsed.error.issues[0]?.path[0];
        const err = field === 'redirect_uris' ? 'invalid_redirect_uri' : 'invalid_client_metadata';
        return sendOAuthError(reply, new OAuthError(err, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')));
      }
      const body = parsed.data;
      for (const uri of body.redirect_uris) {
        const problem = redirectUriProblem(uri);
        if (problem) return sendOAuthError(reply, new OAuthError('invalid_redirect_uri', `${uri.slice(0, 100)}: ${problem}`));
      }
      if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== 'none') {
        return sendOAuthError(reply, new OAuthError('invalid_client_metadata', 'Only public clients: token_endpoint_auth_method must be "none"'));
      }
      const grants = body.grant_types ?? ['authorization_code', 'refresh_token'];
      if (!grants.every((g) => g === 'authorization_code' || g === 'refresh_token')) {
        return sendOAuthError(reply, new OAuthError('invalid_client_metadata', 'grant_types: only authorization_code and refresh_token'));
      }
      if (!(body.response_types ?? ['code']).every((t) => t === 'code')) {
        return sendOAuthError(reply, new OAuthError('invalid_client_metadata', 'response_types: only code'));
      }
      const now = new Date();
      if ((await db.oAuthClient.count()) >= MAX_CLIENTS) {
        await pruneOAuthClients(db, now);
        if ((await db.oAuthClient.count()) >= MAX_CLIENTS) {
          return sendOAuthError(reply, new OAuthError('temporarily_unavailable', 'Too many registered clients; try again later', 503));
        }
      }
      const client = await db.oAuthClient.create({
        data: {
          clientId: randomBytes(24).toString('base64url'),
          source: 'DCR',
          name: body.client_name ?? new URL(body.redirect_uris[0]!).host,
          redirectUris: body.redirect_uris,
          createdAt: now,
        },
      });
      return reply.status(201).header('Cache-Control', 'no-store').send({
        client_id: client.clientId,
        client_id_issued_at: Math.floor(now.getTime() / 1000),
        client_name: client.name,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      });
    },
  );

  // --- authorization ---

  /** An error we must not redirect for (unknown client or redirect URI): a plain page for the user. */
  function errorPage(reply: FastifyReply, message: string) {
    return reply
      .status(400)
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
      .header('X-Frame-Options', 'DENY')
      .header('Cache-Control', 'no-store')
      .send(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Can't connect</title></head>` +
          `<body><h1>This app can't connect</h1><p>${escapeHtml(message)}</p></body></html>`,
      );
  }

  // Rate-limited: an unknown https client_id makes the server fetch a document (CIMD).
  app.get('/oauth/authorize', { config: { public: true, rateLimit: { max: app.config.OAUTH_AUTHORIZE_RATE_LIMIT ?? 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const str = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : undefined);
    const clientId = str('client_id');
    const redirectUri = str('redirect_uri');
    const state = str('state');
    if (!clientId) return errorPage(reply, 'The request has no client_id.');
    const now = new Date();
    const client = await resolveClient(db, app.fetchPolicy, clientId, now, req.log, () => pruneOAuthClients(db, now));
    if (!client) return errorPage(reply, 'The app asking for access is not registered, or its metadata could not be read.');
    if (!redirectUri || !redirectUriMatches(redirectUri, client.redirectUris)) {
      return errorPage(reply, 'The app gave a redirect address that is not registered for it.');
    }
    // From here on errors go back to the (verified) client.
    const fail = (error: string, description: string) =>
      reply.header('Cache-Control', 'no-store').redirect(withParams(redirectUri, { error, error_description: description, state, iss: base }));
    if (str('response_type') !== 'code') return fail('unsupported_response_type', 'response_type must be code');
    const challenge = str('code_challenge');
    if (str('code_challenge_method') !== 'S256' || !challenge || !S256_CHALLENGE.test(challenge)) {
      return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required');
    }
    const requested = str('resource');
    if (requested !== undefined && requested !== resource) return fail('invalid_target', `resource must be ${resource}`);
    const scope = parseScope(str('scope'));
    if (!scope) return fail('invalid_scope', 'scope may only contain read and write');
    if (state !== undefined && state.length > 1000) return fail('invalid_request', 'state is too long');
    const stored = await db.oAuthRequest.create({
      data: {
        clientId: client.id,
        redirectUri,
        codeChallenge: challenge,
        scope,
        resource,
        state: state ?? null,
        expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
      },
    });
    return reply.header('Cache-Control', 'no-store').redirect(`${base}/connect/authorize?request=${stored.id}`);
  });

  // --- token (RFC 6749 §3.2) and revocation (RFC 7009) ---

  /** The form body, or an OAuthError (wrong content type, repeated parameters). */
  function form(req: FastifyRequest): Form {
    const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== 'application/x-www-form-urlencoded') {
      throw new OAuthError('invalid_request', 'Send application/x-www-form-urlencoded');
    }
    const body = (req.body ?? {}) as Form & { [DUPLICATE]?: true };
    if (body[DUPLICATE]) throw new OAuthError('invalid_request', 'A parameter was sent more than once');
    return body;
  }

  type Outcome = { tokens: Awaited<ReturnType<typeof issueTokens>> } | { error: OAuthError };

  /**
   * Code → tokens. One transaction under the user's lock. Failures after the code is claimed are returned,
   * not thrown, so the claim (and any revocation) commits: a code is burnt by any attempt.
   */
  async function exchangeCode(f: Form, now: Date): Promise<Outcome> {
    for (const k of ['code', 'redirect_uri', 'client_id', 'code_verifier']) {
      if (!f[k]) return { error: new OAuthError('invalid_request', `${k} is required`) };
    }
    const client = await db.oAuthClient.findUnique({ where: { clientId: f.client_id! } });
    if (!client) return { error: new OAuthError('invalid_client', 'Unknown client', 401) };
    const code = await db.oAuthCode.findUnique({ where: { codeHash: hashToken(f.code!) } });
    if (!code || code.clientId !== client.id) return { error: new OAuthError('invalid_grant', 'Unknown authorization code') };
    const grant = (why: string) => ({ error: new OAuthError('invalid_grant', why) });
    return db.$transaction(async (tx): Promise<Outcome> => {
      await lockUser(tx, code.userId);
      // Single use: the first exchange claims it. A second one means the code leaked; what it issued goes too.
      const claimed = await tx.oAuthCode.updateMany({ where: { id: code.id, usedAt: null }, data: { usedAt: now } });
      if (claimed.count === 0) {
        const used = await tx.oAuthCode.findUnique({ where: { id: code.id } });
        if (used?.family) await revokeFamily(tx, used.family, now);
        return grant('Authorization code already used');
      }
      if (code.expiresAt <= now) return grant('Authorization code expired');
      if (f.redirect_uri !== code.redirectUri) return grant('redirect_uri does not match');
      if (f.resource !== undefined && f.resource !== code.resource) {
        return { error: new OAuthError('invalid_target', `resource must be ${code.resource}`) };
      }
      if (!pkceMatches(f.code_verifier!, code.codeChallenge)) return grant('code_verifier does not match');
      const user = await tx.user.findUnique({ where: { id: code.userId } });
      if (!user?.isActive) return grant('The user is no longer active');
      const family = randomUUID();
      await tx.oAuthCode.update({ where: { id: code.id }, data: { family } });
      return { tokens: await issueTokens(tx, client, user.id, code.scope, family, now) };
    });
  }

  /** Rotation (M20), under the user's lock (so it can't outrun a revocation). Every failure is invalid_grant (M13). */
  async function refresh(f: Form, now: Date): Promise<Outcome> {
    const invalid = (why: string) => ({ error: new OAuthError('invalid_grant', why) });
    if (!f.refresh_token || !f.client_id) return invalid('refresh_token and client_id are required');
    const hash = hashToken(f.refresh_token);
    const found = await db.oAuthRefresh.findUnique({ where: { tokenHash: hash }, select: { userId: true } });
    if (!found) return invalid('Unknown refresh token');
    return db.$transaction(async (tx): Promise<Outcome> => {
      await lockUser(tx, found.userId);
      const row = await tx.oAuthRefresh.findUnique({ where: { tokenHash: hash }, include: { client: true, user: true } });
      if (!row || row.client.clientId !== f.client_id) return invalid('Unknown refresh token');
      if (row.revokedAt) return invalid('Refresh token revoked');
      if (row.usedAt) {
        // Two refreshes at once from one client: not theft. Later reuse of a rotated token is (M20).
        if (now.getTime() - row.usedAt.getTime() > REFRESH_REUSE_GRACE_MS) await revokeFamily(tx, row.family, now);
        return invalid('Refresh token already used');
      }
      if (row.expiresAt <= now) return invalid('Refresh token expired');
      if (f.resource !== undefined && f.resource !== resource) return invalid(`resource must be ${resource}`);
      if (!row.user.isActive) return invalid('The user is no longer active');
      await tx.oAuthRefresh.update({ where: { id: row.id }, data: { usedAt: now } });
      return { tokens: await issueTokens(tx, row.client, row.userId, row.scope, row.family, now) };
    });
  }

  app.post('/oauth/token', pub, async (req, reply) => {
    try {
      const f = form(req);
      const now = new Date();
      let outcome: Outcome;
      if (f.grant_type === 'authorization_code') outcome = await exchangeCode(f, now);
      else if (f.grant_type === 'refresh_token') outcome = await refresh(f, now);
      else if (!f.grant_type) throw new OAuthError('invalid_request', 'grant_type is required');
      else throw new OAuthError('unsupported_grant_type', 'Only authorization_code and refresh_token');
      if ('error' in outcome) throw outcome.error;
      return reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache').send(outcome.tokens);
    } catch (err) {
      if (err instanceof OAuthError) return sendOAuthError(reply, err);
      throw err;
    }
  });

  app.post('/oauth/revoke', pub, async (req, reply) => {
    let f: Form;
    try {
      f = form(req);
    } catch (err) {
      if (err instanceof OAuthError) return sendOAuthError(reply, err);
      throw err;
    }
    const now = new Date();
    const token = f.token ?? '';
    const client = f.client_id ? await db.oAuthClient.findUnique({ where: { clientId: f.client_id } }) : null;
    // RFC 7009 §2.2: 200 whatever the token was; only the client it was issued to can revoke it.
    if (client && token) {
      const hash = hashToken(token);
      const refreshRow = await db.oAuthRefresh.findUnique({ where: { tokenHash: hash } });
      if (refreshRow?.clientId === client.id) {
        await db.$transaction(async (tx) => {
          await lockUser(tx, refreshRow.userId);
          await revokeFamily(tx, refreshRow.family, now);
        });
      } else {
        await db.apiToken.updateMany({ where: { tokenHash: hash, oauthClientId: client.id, revokedAt: null }, data: { revokedAt: now } });
      }
    }
    return reply.header('Cache-Control', 'no-store').send({});
  });
}

/** The consent page's API (cookie auth, under /api/v1; M7, M28). */
export async function oauthRequestRoutes(app: FastifyInstance) {
  const db = app.db;
  const base = app.config.APP_URL;

  app.addHook('onRequest', async () => {
    if (!app.config.MCP_ENABLED) throw notFound('Route');
  });

  /** A pending request, or 404 (unknown) / 410 (expired or already decided). */
  async function pending(id: string, now: Date) {
    const request = await db.oAuthRequest.findUnique({ where: { id }, include: { client: true } });
    if (!request) throw notFound('Authorization request');
    if (request.decidedAt) throw new AppError('GONE', 'This authorization request has already been used');
    if (request.expiresAt <= now) throw new AppError('GONE', 'This authorization request has expired');
    return request;
  }

  app.get('/oauth/requests/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const request = await pending(id, new Date());
    const redirect = new URL(request.redirectUri);
    const me = await loadMe(db, req.user);
    return {
      client: {
        name: request.client.name,
        redirectHost: redirect.host,
        clientIdHost: request.client.source === 'CIMD' ? new URL(request.client.clientId).host : null,
      },
      requestedScopes: scopeList(request.scope),
      expiresAt: request.expiresAt.toISOString(),
      isLocalRedirect: isLoopbackRedirect(redirect),
      user: me,
      workspaces: me.workspaces,
    };
  });

  const Decision = z.object({ approve: z.boolean(), scope: z.enum(['READ', 'WRITE']).optional() }).strict();

  app.post('/oauth/requests/:id/decision', async (req) => {
    // JSON only: a cross-site form can't send it, and text/plain (which Fastify also parses) is refused (M23).
    const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== 'application/json') throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Send application/json');
    const { id } = parse(idParams, req.params);
    const body = parse(Decision, req.body);
    const now = new Date();
    const known = await db.oAuthRequest.findUnique({ where: { id } });
    if (!known) throw notFound('Authorization request');
    if (known.decidedAt) throw conflict('This authorization request has already been decided');
    if (known.expiresAt <= now) throw new AppError('GONE', 'This authorization request has expired');
    const scope = body.scope ?? known.scope;
    if (scope === 'WRITE' && known.scope === 'READ') {
      throw validation('Only read access was requested', [{ path: ['scope'], message: 'Only read access was requested' }]);
    }
    // Decided once: the first decision claims the request; whoever is signed in owns the grant (M7).
    const claimed = await db.oAuthRequest.updateMany({
      where: { id, decidedAt: null, expiresAt: { gt: now } },
      data: { decidedAt: now, userId: req.user.id },
    });
    if (claimed.count === 0) throw conflict('This authorization request has already been decided');
    const state = known.state ?? undefined;
    if (!body.approve) return { redirectUrl: withParams(known.redirectUri, { error: 'access_denied', state, iss: base }) };
    const code = generateToken('mpor');
    await db.oAuthCode.create({
      data: {
        codeHash: code.hash,
        clientId: known.clientId,
        userId: req.user.id,
        redirectUri: known.redirectUri,
        codeChallenge: known.codeChallenge,
        scope,
        resource: known.resource,
        expiresAt: new Date(now.getTime() + CODE_TTL_MS),
      },
    });
    return { redirectUrl: withParams(known.redirectUri, { code: code.token, state, iss: base }) };
  });
}

