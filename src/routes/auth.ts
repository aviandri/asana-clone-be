import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, conflict, notFound, unauthorized } from '../errors.js';
import { DUMMY_HASH, hashPassword, randomAvatarColor, verifyPassword } from '../lib/password.js';
import { email, parse, password } from '../lib/validate.js';
import { loadMe } from '../lib/workspaces.js';

const LoginBody = z.object({ email, password: z.string().min(1).max(200) });
const AcceptInviteBody = z.object({
  token: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  password,
});
const TokenParams = z.object({ token: z.string().min(1) });

export default async function authRoutes(app: FastifyInstance) {
  const limited = {
    public: true,
    rateLimit: { max: app.config.AUTH_RATE_LIMIT_MAX, timeWindow: '1 minute' },
  };

  app.post('/login', { config: limited }, async (req, reply) => {
    const body = parse(LoginBody, req.body);
    const user = await app.db.user.findUnique({ where: { email: body.email } });
    const ok = await verifyPassword(body.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) throw unauthorized('Invalid email or password');
    if (!user.isActive) throw unauthorized('This account has been deactivated');
    await app.setSession(reply, user.id);
    return loadMe(app.db, user, { req });
  });

  app.post('/logout', async (_req, reply) => {
    app.clearSession(reply);
    return reply.status(204).send();
  });

  app.get('/me', async (req) => loadMe(app.db, req.user, { req }));

  async function findUsableInvite(token: string) {
    const invite = await app.db.invite.findUnique({ where: { token } });
    if (!invite) throw notFound('Invite');
    if (invite.acceptedAt) throw new AppError('GONE', 'This invite has already been used');
    if (invite.expiresAt.getTime() <= Date.now()) throw new AppError('GONE', 'This invite has expired');
    return invite;
  }

  app.get('/invites/:token', { config: { public: true } }, async (req) => {
    const { token } = parse(TokenParams, req.params);
    const invite = await findUsableInvite(token);
    return { email: invite.email, role: invite.role };
  });

  app.post('/accept-invite', { config: limited }, async (req, reply) => {
    const body = parse(AcceptInviteBody, req.body);
    const invite = await findUsableInvite(body.token);
    if (await app.db.user.findUnique({ where: { email: invite.email } })) {
      throw conflict('An account with this email already exists');
    }
    const passwordHash = await hashPassword(body.password);
    const user = await app.db.$transaction(async (tx) => {
      // Guard against the same token being accepted twice concurrently.
      const claimed = await tx.invite.updateMany({
        where: { id: invite.id, acceptedAt: null },
        data: { acceptedAt: new Date() },
      });
      if (claimed.count === 0) throw new AppError('GONE', 'This invite has already been used');
      // The invited workspace becomes the new user's first and current workspace.
      return tx.user.create({
        data: {
          email: invite.email,
          name: body.name,
          passwordHash,
          avatarColor: randomAvatarColor(),
          lastWorkspaceId: invite.workspaceId,
          workspaceMemberships: { create: { workspaceId: invite.workspaceId, role: invite.role } },
        },
      });
    });
    await app.setSession(reply, user.id);
    return loadMe(app.db, user, { workspaceId: invite.workspaceId });
  });
}
