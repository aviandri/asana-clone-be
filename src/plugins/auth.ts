import fp from 'fastify-plugin';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { User } from '@prisma/client';
import { AppError, forbidden, unauthorized } from '../errors.js';
import { INTERNAL_HEADER, isInternal, takeTicket } from '../mcp/internal.js';
import { authenticateToken, bearerToken, UsageThrottle, type Principal } from '../lib/tokens.js';
import type { Member } from '../lib/workspaces.js';

export const SESSION_COOKIE = 'sid';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

declare module 'fastify' {
  interface FastifyInstance {
    setSession(reply: FastifyReply, userId: string): Promise<void>;
    clearSession(reply: FastifyReply): void;
  }
  interface FastifyContextConfig {
    /** Route needs no session (login, accept-invite, health). */
    public?: boolean;
    /**
     * Route authenticates with `Authorization: Bearer` (a PAT or OAuth access token) and never with the
     * cookie. Only /mcp (SPEC §14): /api/v1 stays cookie-only, so a leaked token can't drive the REST API.
     */
    bearer?: boolean;
  }
  interface FastifyRequest {
    /** The token behind the request, on `bearer` routes. */
    principal?: Principal;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string };
    /** `request.user`: set by the auth hook on every non-public route. */
    user: User;
  }
}

async function authPlugin(app: FastifyInstance, opts: { secret: string; secureCookie: boolean; appUrl: string }) {
  await app.register(cookie);
  await app.register(jwt, { secret: opts.secret, sign: { expiresIn: SESSION_TTL_SECONDS } });

  app.decorate('setSession', async (reply: FastifyReply, userId: string) => {
    const token = await reply.jwtSign({ sub: userId });
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: opts.secureCookie,
      path: '/',
      maxAge: SESSION_TTL_SECONDS,
    });
  });

  app.decorate('clearSession', (reply: FastifyReply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
  });

  const usage = new UsageThrottle();
  // What tells an MCP client (claude.ai) where to start OAuth (RFC 9728).
  const challenge = `Bearer resource_metadata="${opts.appUrl}/.well-known/oauth-protected-resource/mcp"`;

  async function authenticateBearer(req: FastifyRequest, reply: FastifyReply) {
    // error="invalid_token" only for a Bearer credential that failed (RFC 6750 §3.1), not for other schemes.
    const sent = /^bearer(\s|$)/i.test(req.headers.authorization?.trim() ?? '');
    const token = bearerToken(req.headers.authorization);
    const now = new Date();
    const principal = token ? await authenticateToken(app.db, token, now) : null;
    if (!principal) {
      reply.header('WWW-Authenticate', sent ? `${challenge}, error="invalid_token"` : challenge);
      throw unauthorized(sent ? 'Invalid, expired or revoked token' : 'A bearer token is required');
    }
    req.user = principal.user;
    req.principal = principal;
    if (usage.due(principal.token.id, now.getTime())) {
      // Best effort, off the request path: a missed lastUsedAt write is not worth failing a call over.
      app.db.apiToken
        .update({ where: { id: principal.token.id }, data: { lastUsedAt: now } })
        .catch((err: unknown) => req.log.warn({ err }, 'lastUsedAt update failed'));
    }
  }

  /**
   * An MCP tool's in-process REST call (M14). Anything else carrying the header, e.g. from the network,
   * is a 400 before any route runs. A READ ticket may only read.
   */
  async function authenticateInternal(req: FastifyRequest) {
    const claim = takeTicket(req.headers[INTERNAL_HEADER], isInternal(req.raw));
    if (!claim) throw new AppError('VALIDATION', 'Unexpected internal header');
    if (!req.url.startsWith('/api/v1/')) throw new AppError('VALIDATION', 'Unexpected internal header');
    if (claim.scope === 'READ' && req.method !== 'GET') throw forbidden('this token is read-only');
    const user = await app.db.user.findUnique({ where: { id: claim.userId } });
    if (!user || !user.isActive) throw unauthorized('Session expired or invalid');
    req.user = user;
  }

  // Every route requires a session unless it opts out with `config: { public: true }`.
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.headers[INTERNAL_HEADER] !== undefined) return authenticateInternal(req);
    if (req.routeOptions.config?.public) return;
    if (req.routeOptions.config?.bearer) return authenticateBearer(req, reply);
    const token = req.cookies[SESSION_COOKIE];
    if (!token) throw unauthorized();
    let userId: string;
    try {
      userId = app.jwt.verify<{ sub: string }>(token).sub;
    } catch {
      throw unauthorized('Session expired or invalid');
    }
    const user = await app.db.user.findUnique({ where: { id: userId } });
    if (!user || !user.isActive) throw unauthorized('Session expired or invalid');
    req.user = user;
  });
}

export default fp(authPlugin, { name: 'auth', dependencies: ['db'] });

/** Workspace settings and `/admin/*`: ADMIN of that workspace. */
export function requireAdmin(member: Member) {
  if (member.role !== 'ADMIN') throw forbidden('Admin only');
}
