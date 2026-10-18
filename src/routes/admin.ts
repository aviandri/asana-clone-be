import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { conflict, notFound } from '../errors.js';
import { INVITE_TTL_MS, newInviteToken, toInvite } from '../lib/invites.js';
import { toUser, userSummarySelect } from '../lib/serialize.js';
import { email, idParams, parse } from '../lib/validate.js';
import { assertNotLastAdmin, currentMember, removeFromWorkspaceContent, seniorAdminId } from '../lib/workspaces.js';
import { requireAdmin } from '../plugins/auth.js';

const role = z.enum(['ADMIN', 'MEMBER']);
const UpdateUserBody = z.object({ role: role.optional(), isActive: z.boolean().optional() }).strict();
const CreateInviteBody = z.object({ email, role: role.default('MEMBER') });

/** SPEC §12: `/admin/*` manages the current workspace's memberships and invites; its ADMINs only. */
export default async function adminRoutes(app: FastifyInstance) {
  const db = app.db;

  app.addHook('preHandler', async (req) => requireAdmin(await currentMember(req)));

  app.get('/users', async (req) => {
    const { workspaceId } = await currentMember(req);
    const members = await db.workspaceMember.findMany({
      where: { workspaceId },
      include: { user: true },
      orderBy: [{ user: { name: 'asc' } }, { userId: 'asc' }],
    });
    // isActive is the membership's (SPEC §12). A user deactivated globally (pre-v1.2, or via
    // create-admin / DB) still can't log in after an admin re-activates them here.
    return { data: members.map((m) => toUser(m.user, { role: m.role, isActive: m.isActive })) };
  });

  app.patch('/users/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(UpdateUserBody, req.body);
    const admin = await currentMember(req);
    const { workspaceId } = admin;
    const key = { workspaceId_userId: { workspaceId, userId: id } };

    const membership = await db.$transaction(async (tx) => {
      const existing = await tx.workspaceMember.findUnique({ where: key });
      if (!existing) throw notFound('User');
      const demoted = body.role !== undefined && body.role !== 'ADMIN';
      const deactivated = body.isActive === false && existing.isActive;
      if (demoted || deactivated) await assertNotLastAdmin(tx, workspaceId, id);
      // Deactivation removes them from the workspace's teams and projects; the acting admin
      // inherits projects that would be left without an owner. Admins deactivating themselves
      // hand them on like leave does: to the longest-standing other admin.
      if (deactivated) {
        const heirId = id === admin.user.id ? await seniorAdminId(tx, workspaceId, id) : admin.user.id;
        await removeFromWorkspaceContent(tx, workspaceId, id, heirId);
      }
      return tx.workspaceMember.update({ where: key, data: body, include: { user: true } });
    });
    return toUser(membership.user, { role: membership.role, isActive: membership.isActive });
  });

  app.post('/invites', async (req, reply) => {
    const body = parse(CreateInviteBody, req.body);
    const { workspaceId } = await currentMember(req);
    const isMember = await db.workspaceMember.count({
      where: { workspaceId, isActive: true, user: { email: body.email, isActive: true } },
    });
    if (isMember) throw conflict('This person is already a member of this workspace');
    const invite = await db.$transaction(async (tx) => {
      // Re-inviting an email replaces its previous pending invite to this workspace.
      await tx.invite.deleteMany({ where: { workspaceId, email: body.email, acceptedAt: null } });
      return tx.invite.create({
        data: {
          workspaceId,
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

  app.get('/invites', async (req) => {
    const { workspaceId } = await currentMember(req);
    const invites = await db.invite.findMany({
      where: { workspaceId, acceptedAt: null, expiresAt: { gt: new Date() } },
      include: { invitedBy: { select: userSummarySelect } },
      orderBy: { createdAt: 'desc' },
    });
    return { data: invites.map((i) => toInvite(i, app.config.APP_URL)) };
  });

  app.delete('/invites/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const { workspaceId } = await currentMember(req);
    const { count } = await db.invite.deleteMany({ where: { id, workspaceId } });
    if (count === 0) throw notFound('Invite');
    return reply.status(204).send();
  });
}
