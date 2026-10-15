import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { conflict, notFound, validation } from '../errors.js';
import { INVITE_TTL_MS, newInviteToken, toInvite } from '../lib/invites.js';
import { toUser, userSummarySelect } from '../lib/serialize.js';
import { email, idParams, parse } from '../lib/validate.js';
import { requireAdmin } from '../plugins/auth.js';

const role = z.enum(['ADMIN', 'MEMBER']);
const UpdateUserBody = z.object({ role: role.optional(), isActive: z.boolean().optional() }).strict();
const CreateInviteBody = z.object({ email, role: role.default('MEMBER') });

export default async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req) => requireAdmin(req));

  app.get('/users', async () => {
    const users = await app.db.user.findMany({ orderBy: { name: 'asc' } });
    return { data: users.map(toUser) };
  });

  app.patch('/users/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(UpdateUserBody, req.body);
    if (id === req.user.id && (body.isActive === false || body.role === 'MEMBER')) {
      // Stops the last admin from locking everyone out by accident.
      throw validation('You cannot deactivate yourself or remove your own admin role');
    }
    const existing = await app.db.user.findUnique({ where: { id } });
    if (!existing) throw notFound('User');
    const user = await app.db.user.update({ where: { id }, data: body });
    return toUser(user);
  });

  app.post('/invites', async (req, reply) => {
    const body = parse(CreateInviteBody, req.body);
    if (await app.db.user.findUnique({ where: { email: body.email } })) {
      throw conflict('A user with this email already exists');
    }
    const invite = await app.db.$transaction(async (tx) => {
      // Re-inviting an email replaces its previous pending invite.
      await tx.invite.deleteMany({ where: { email: body.email, acceptedAt: null } });
      return tx.invite.create({
        data: {
          email: body.email,
          role: body.role,
          token: newInviteToken(),
          invitedById: req.user.id,
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        },
      });
    });
    const { invitedBy: _omit, ...shape } = toInvite(invite, app.config.APP_URL);
    return reply.status(201).send(shape);
  });

  app.get('/invites', async () => {
    const invites = await app.db.invite.findMany({
      where: { acceptedAt: null, expiresAt: { gt: new Date() } },
      include: { invitedBy: { select: userSummarySelect } },
      orderBy: { createdAt: 'desc' },
    });
    return { data: invites.map((i) => toInvite(i, app.config.APP_URL)) };
  });

  app.delete('/invites/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const { count } = await app.db.invite.deleteMany({ where: { id } });
    if (count === 0) throw notFound('Invite');
    return reply.status(204).send();
  });
}
