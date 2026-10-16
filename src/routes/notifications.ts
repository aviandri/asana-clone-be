import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '../errors.js';
import { toUserSummary, userSummarySelect } from '../lib/serialize.js';
import { visibleTasksWhere } from '../lib/tasks.js';
import { idParams, parse, queryBool } from '../lib/validate.js';

const ListQuery = z.object({
  unread: queryBool.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export default async function notificationRoutes(app: FastifyInstance) {
  const db = app.db;

  app.get('/notifications', async (req) => {
    const { unread, limit } = parse(ListQuery, req.query);
    const userId = req.user.id;
    // Notifications about tasks the user can no longer see are hidden, so titles don't leak once
    // access is removed.
    const visible = { OR: [{ taskId: null }, { task: { is: visibleTasksWhere(req.user) } }] };
    const [rows, unreadCount] = await Promise.all([
      db.notification.findMany({
        where: { userId, ...visible, ...(unread ? { read: false } : {}) },
        include: {
          actor: { select: userSummarySelect },
          task: { select: { id: true, title: true, projectId: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
      }),
      db.notification.count({ where: { userId, read: false, ...visible } }),
    ]);
    return {
      data: rows.map((n) => ({
        id: n.id,
        type: n.type,
        read: n.read,
        createdAt: n.createdAt.toISOString(),
        actor: toUserSummary(n.actor),
        task: n.task,
      })),
      unreadCount,
    };
  });

  // Registered before /:id/read so "read-all" can never be taken for an id.
  app.post('/notifications/read-all', async (req, reply) => {
    await db.notification.updateMany({ where: { userId: req.user.id, read: false }, data: { read: true } });
    return reply.status(204).send();
  });

  app.post('/notifications/:id/read', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const { count } = await db.notification.updateMany({ where: { id, userId: req.user.id }, data: { read: true } });
    if (count === 0) throw notFound('Notification');
    return reply.status(204).send();
  });
}
