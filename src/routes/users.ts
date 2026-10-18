import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound, validation } from '../errors.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { toUser, toUserSummary, userSummarySelect } from '../lib/serialize.js';
import { hexColor, idParams, parse, password } from '../lib/validate.js';
import { currentMember, loadMe, pickableUsersWhere } from '../lib/workspaces.js';

const ListQuery = z.object({ q: z.string().trim().max(100).optional() });

const UpdateMeBody = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    avatarColor: hexColor.optional(),
    currentPassword: z.string().max(200).optional(),
    newPassword: password.optional(),
  })
  .strict();

export default async function userRoutes(app: FastifyInstance) {
  app.get('/users', async (req) => {
    const { q } = parse(ListQuery, req.query);
    const member = await currentMember(req);
    const users = await app.db.user.findMany({
      where: {
        ...pickableUsersWhere(member),
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { email: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: userSummarySelect,
      orderBy: { name: 'asc' },
    });
    return { data: users.map(toUserSummary) };
  });

  // Registered before /users/:id so "me" isn't parsed as an id.
  app.patch('/users/me', async (req) => {
    const body = parse(UpdateMeBody, req.body);
    let passwordHash: string | undefined;
    if (body.newPassword !== undefined) {
      const ok =
        body.currentPassword !== undefined &&
        (await verifyPassword(body.currentPassword, req.user.passwordHash));
      if (!ok) {
        throw validation('Current password is incorrect', [
          { path: ['currentPassword'], message: 'Current password is incorrect' },
        ]);
      }
      passwordHash = await hashPassword(body.newPassword);
    }
    const user = await app.db.user.update({
      where: { id: req.user.id },
      data: { name: body.name, avatarColor: body.avatarColor, passwordHash },
    });
    return loadMe(app.db, user, { req });
  });

  app.get('/users/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const member = await currentMember(req);
    const { workspaceId } = member;
    // Members of the current workspace only (incl. deactivated ones, who still appear on old tasks).
    const membership = await app.db.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: id } },
      include: { user: true },
    });
    if (!membership) throw notFound('User');
    // Guests only see people who share a project with them, even by id (SPEC §12).
    if (member.role === 'GUEST' && !(await app.db.user.count({ where: { AND: [{ id }, pickableUsersWhere(member)] } }))) {
      throw notFound('User');
    }
    return toUser(membership.user, { role: membership.role, isActive: membership.isActive && membership.user.isActive });
  });
}
