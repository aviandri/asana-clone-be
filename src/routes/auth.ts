import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, conflict, notFound, unauthorized } from '../errors.js';
import { DUMMY_HASH, hashPassword, randomAvatarColor, verifyPassword } from '../lib/password.js';
import { toUser } from '../lib/serialize.js';
import { email, parse, password } from '../lib/validate.js';

const LoginBody = z.object({ email, password: z.string().min(1).max(200) });
const AcceptInviteBody = z.object({
  token: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  password,
});
const TokenParams = z.object({ token: z.string().min(1) });

export default async function authRoutes(app: FastifyInstance) {
  app.post('/login', { config: { public: true } }, async (req, reply) => {
    const body = parse(LoginBody, req.body);
    const user = await app.db.user.findUnique({ where: { email: body.email } });
    const ok = await verifyPassword(body.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) throw unauthorized('Invalid email or password');
    if (!user.isActive) throw unauthorized('This account has been deactivated');
    await app.setSession(reply, user.id);
    return toUser(user);
  });

  app.post('/logout', async (_req, reply) => {
    app.clearSession(reply);
    return reply.status(204).send();
  });

  app.get('/me', async (req) => toUser(req.user));

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

  app.post('/accept-invite', { config: { public: true } }, async (req, reply) => {
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
      return tx.user.create({
        data: {
          email: invite.email,
          name: body.name,
          passwordHash,
          role: invite.role,
          avatarColor: randomAvatarColor(),
        },
      });
    });
    await app.setSession(reply, user.id);
    return toUser(user);
  });
}
