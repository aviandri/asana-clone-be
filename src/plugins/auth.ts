import fp from 'fastify-plugin';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { User } from '@prisma/client';
import { forbidden, unauthorized } from '../errors.js';

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
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string };
    /** `request.user`: set by the auth hook on every non-public route. */
    user: User;
  }
}

async function authPlugin(app: FastifyInstance, opts: { secret: string; secureCookie: boolean }) {
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

  // Every route requires a session unless it opts out with `config: { public: true }`.
  app.addHook('onRequest', async (req: FastifyRequest) => {
    if (req.routeOptions.config?.public) return;
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

export function requireAdmin(req: FastifyRequest) {
  if (req.user.role !== 'ADMIN') throw forbidden('Admin only');
}
