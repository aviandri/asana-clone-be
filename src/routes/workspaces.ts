import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, conflict, forbidden, notFound, validation } from '../errors.js';
import { toUserSummary, userSummarySelect } from '../lib/serialize.js';
import { hexColor, idParams, parse } from '../lib/validate.js';
import {
  assertNotLastAdmin,
  deleteWorkspace,
  demoteToGuests,
  emailDomain,
  listWorkspaces,
  loadWorkspace,
  lockAdmins,
  removeFromWorkspaceContent,
  requireMember,
  seniorAdminId,
} from '../lib/workspaces.js';
import { requireAdmin } from '../plugins/auth.js';

const name = z.string().trim().min(1).max(100);
const CreateBody = z.object({ name, color: hexColor.default('#4186e0') });
const domain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'Expected a domain like mekari.com');
const UpdateBody = z
  .object({ name, color: hexColor, isOrganization: z.boolean(), domain: domain.nullable() })
  .partial()
  .strict();
const DeleteBody = z.object({ confirmName: z.string() });

/** SPEC §12 workspace and `/me/invites` endpoints. All are ID-addressed or per-user; none use X-Workspace-Id. */
export default async function workspaceRoutes(app: FastifyInstance) {
  const db = app.db;

  app.get('/workspaces', async (req) => ({ data: await listWorkspaces(db, req.user) }));

  app.post('/workspaces', async (req, reply) => {
    const body = parse(CreateBody, req.body);
    // Any user can create one; they become its ADMIN and it becomes their current workspace.
    const workspace = await db.$transaction(async (tx) => {
      const created = await tx.workspace.create({
        data: { name: body.name, color: body.color, members: { create: { userId: req.user.id, role: 'ADMIN' } } },
      });
      await tx.user.update({ where: { id: req.user.id }, data: { lastWorkspaceId: created.id } });
      return created;
    });
    return reply.status(201).send(await loadWorkspace(db, req.user, workspace.id));
  });

  // Registered before /workspaces/:id for readability (static routes win in Fastify anyway).
  app.get('/workspaces/joinable', async (req) => {
    // Organizations on my email's domain that I'm not a member of. Someone an admin deactivated
    // there can't rejoin on their own: they need an invite or re-activation.
    const workspaces = await db.workspace.findMany({
      where: { isOrganization: true, domain: emailDomain(req.user.email), members: { none: { userId: req.user.id } } },
      include: { _count: { select: { members: { where: { isActive: true, user: { isActive: true } } } } } },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return { data: workspaces.map((w) => ({ id: w.id, name: w.name, color: w.color, memberCount: w._count.members })) };
  });

  app.post('/workspaces/:id/join', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const workspace = await db.workspace.findUnique({ where: { id } });
    if (!workspace) throw notFound('Workspace');
    if (!workspace.isOrganization || workspace.domain !== emailDomain(req.user.email)) {
      throw forbidden('Only people with an email on this organization’s domain can join it');
    }
    const existing = await db.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: id, userId: req.user.id } } });
    if (existing?.isActive) throw conflict('You are already a member of this workspace');
    if (existing) throw forbidden('An admin deactivated your membership; ask them for an invite');
    await db.workspaceMember.create({ data: { workspaceId: id, userId: req.user.id, role: 'MEMBER' } });
    return reply.status(201).send(await loadWorkspace(db, req.user, id));
  });

  app.get('/workspaces/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    return loadWorkspace(db, req.user, id);
  });

  app.patch('/workspaces/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(UpdateBody, req.body);
    requireAdmin(await requireMember(db, req.user, id, 'Workspace'));
    const convertedToGuests = await db.$transaction(async (tx) => {
      // Conversion can demote admins: take the same lock as the last-admin check (and re-check
      // that the caller is still an admin once it's held).
      await lockAdmins(tx, id);
      requireAdmin(await requireMember(tx, req.user, id, 'Workspace'));
      const current = await tx.workspace.findUniqueOrThrow({ where: { id } });
      const isOrganization = body.isOrganization ?? current.isOrganization;
      const nextDomain = isOrganization ? (body.domain !== undefined ? body.domain : current.domain) : null;
      if (!isOrganization && body.domain) {
        throw validation('Only organizations have a domain', [{ path: ['domain'], message: 'Set isOrganization to true' }]);
      }
      if (isOrganization && !nextDomain) {
        throw validation('An organization needs a domain', [{ path: ['domain'], message: 'Required for an organization' }]);
      }
      // Turning it off (or not touching it) leaves roles alone.
      const converting = !!nextDomain && !(current.isOrganization && current.domain === nextDomain);
      if (converting) {
        if (emailDomain(req.user.email) !== nextDomain) {
          throw validation('Your own email must be on the organization’s domain', [{ path: ['domain'], message: 'Not your email domain' }]);
        }
        // Checked first for the specific message; the unique index still catches a race (409 too).
        if (await tx.workspace.count({ where: { domain: nextDomain, id: { not: id } } })) {
          throw conflict('Another workspace already uses this domain');
        }
      }
      await tx.workspace.update({
        where: { id },
        data: { name: body.name, color: body.color, isOrganization, domain: nextDomain },
      });
      if (!converting) return undefined;

      // Everyone off the domain becomes a guest (W4/W5/W7: out of teams, no project OWNER rights;
      // the caller inherits projects left without an owner). Pending invites to them become guest
      // invites.
      const offDomain = { NOT: { email: { endsWith: `@${nextDomain}` } } };
      const demoted = await tx.workspaceMember.findMany({
        where: { workspaceId: id, role: { not: 'GUEST' }, user: offDomain },
        select: { userId: true, isActive: true },
      });
      await demoteToGuests(tx, id, demoted.map((m) => m.userId), req.user.id);
      await tx.invite.updateMany({
        where: { workspaceId: id, acceptedAt: null, role: { not: 'GUEST' }, NOT: { email: { endsWith: `@${nextDomain}` } } },
        data: { role: 'GUEST' },
      });
      return demoted.filter((m) => m.isActive).length;
    });

    const workspace = await loadWorkspace(db, req.user, id);
    return convertedToGuests === undefined ? workspace : { ...workspace, convertedToGuests };
  });

  app.delete('/workspaces/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const { confirmName } = parse(DeleteBody, req.body);
    requireAdmin(await requireMember(db, req.user, id, 'Workspace'));
    const workspace = await db.workspace.findUniqueOrThrow({ where: { id }, select: { name: true } });
    if (confirmName !== workspace.name) {
      throw validation('Type the workspace name to confirm', [{ path: ['confirmName'], message: 'Does not match the workspace name' }]);
    }
    await db.$transaction((tx) => deleteWorkspace(tx, id), { timeout: 60_000 });
    return reply.status(204).send();
  });

  app.post('/workspaces/:id/switch', async (req) => {
    const { id } = parse(idParams, req.params);
    const workspace = await loadWorkspace(db, req.user, id); // 404 unless an active member
    await db.user.update({ where: { id: req.user.id }, data: { lastWorkspaceId: id } });
    return workspace;
  });

  app.post('/workspaces/:id/leave', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    await requireMember(db, req.user, id, 'Workspace');
    const userId = req.user.id;
    await db.$transaction(async (tx) => {
      await assertNotLastAdmin(tx, id, userId);
      // Same clean-up as deactivation; the longest-standing other admin inherits orphaned projects.
      await removeFromWorkspaceContent(tx, id, userId, await seniorAdminId(tx, id, userId));
      await tx.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId: id, userId } } });
      await tx.user.updateMany({ where: { id: userId, lastWorkspaceId: id }, data: { lastWorkspaceId: null } });
    });
    return reply.status(204).send();
  });

  // --- my invites (existing accounts) --------------------------------------------------

  /** A pending invite to my email, or 404 (someone else's invite looks the same as none). */
  async function findMyInvite(inviteId: string, email: string, { allowExpired = false } = {}) {
    const invite = await db.invite.findUnique({ where: { id: inviteId } });
    if (!invite || invite.email !== email) throw notFound('Invite');
    if (invite.acceptedAt) throw new AppError('GONE', 'This invite has already been used');
    if (!allowExpired && invite.expiresAt.getTime() <= Date.now()) throw new AppError('GONE', 'This invite has expired');
    return invite;
  }

  app.get('/me/invites', async (req) => {
    const invites = await db.invite.findMany({
      where: {
        email: req.user.email,
        acceptedAt: null,
        expiresAt: { gt: new Date() },
        // Not for workspaces I'm already active in.
        workspace: { members: { none: { userId: req.user.id, isActive: true } } },
      },
      include: { workspace: true, invitedBy: { select: userSummarySelect } },
      orderBy: { createdAt: 'desc' },
    });
    return {
      data: invites.map((i) => ({
        id: i.id,
        workspace: { id: i.workspace.id, name: i.workspace.name, color: i.workspace.color },
        role: i.role,
        invitedBy: toUserSummary(i.invitedBy),
        expiresAt: i.expiresAt.toISOString(),
      })),
    };
  });

  app.post('/me/invites/:id/accept', async (req) => {
    const { id } = parse(idParams, req.params);
    const invite = await findMyInvite(id, req.user.email);
    await db.$transaction(async (tx) => {
      const claimed = await tx.invite.updateMany({ where: { id, acceptedAt: null }, data: { acceptedAt: new Date() } });
      if (claimed.count === 0) throw new AppError('GONE', 'This invite has already been used');
      const key = { workspaceId_userId: { workspaceId: invite.workspaceId, userId: req.user.id } };
      const existing = await tx.workspaceMember.findUnique({ where: key });
      // An active member keeps their role; a deactivated one is re-activated with the invite's.
      if (!existing?.isActive) {
        await tx.workspaceMember.upsert({
          where: key,
          create: { workspaceId: invite.workspaceId, userId: req.user.id, role: invite.role },
          update: { role: invite.role, isActive: true },
        });
      }
    });
    return loadWorkspace(db, req.user, invite.workspaceId);
  });

  app.delete('/me/invites/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    // Declining an expired invite just clears it away.
    await findMyInvite(id, req.user.email, { allowExpired: true });
    await db.invite.delete({ where: { id } });
    return reply.status(204).send();
  });
}
