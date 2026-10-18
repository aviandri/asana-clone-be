import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { validation } from '../errors.js';
import { hexColor, idParams, parse } from '../lib/validate.js';
import {
  assertNotLastAdmin,
  deleteWorkspace,
  listWorkspaces,
  loadWorkspace,
  removeFromWorkspaceContent,
  requireMember,
  seniorAdminId,
} from '../lib/workspaces.js';
import { requireAdmin } from '../plugins/auth.js';

const name = z.string().trim().min(1).max(100);
const CreateBody = z.object({ name, color: hexColor.default('#4186e0') });
const UpdateBody = z.object({ name, color: hexColor }).partial().strict();
const DeleteBody = z.object({ confirmName: z.string() });

/** SPEC §12 workspace endpoints. All are ID-addressed or per-user; none use X-Workspace-Id. */
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

  app.get('/workspaces/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    return loadWorkspace(db, req.user, id);
  });

  app.patch('/workspaces/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(UpdateBody, req.body);
    requireAdmin(await requireMember(db, req.user, id, 'Workspace'));
    await db.workspace.update({ where: { id }, data: body });
    return loadWorkspace(db, req.user, id);
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
}
