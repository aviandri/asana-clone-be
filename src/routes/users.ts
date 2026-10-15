import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound, validation } from '../errors.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { toUser, toUserSummary, userSummarySelect } from '../lib/serialize.js';
import { hexColor, idParams, parse, password } from '../lib/validate.js';

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
    const users = await app.db.user.findMany({
      where: {
        isActive: true,
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
    return toUser(user);
  });

  app.get('/users/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const user = await app.db.user.findUnique({ where: { id } });
    if (!user) throw notFound('User');
    return toUser(user);
  });
}
