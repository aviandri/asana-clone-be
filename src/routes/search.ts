import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { visibleProjectsWhere } from '../lib/access.js';
import { projectInclude, toProject } from '../lib/projects.js';
import { toUserSummary, userSummarySelect } from '../lib/serialize.js';
import { taskInclude, toTask, visibleTasksWhere } from '../lib/tasks.js';
import { parse } from '../lib/validate.js';

const SearchQuery = z.object({ q: z.string().trim().min(2, 'Search needs at least 2 characters').max(100) });
const PER_KIND = 10;

export default async function searchRoutes(app: FastifyInstance) {
  app.get('/search', async (req) => {
    const { q } = parse(SearchQuery, req.query);
    const contains = { contains: q, mode: 'insensitive' as const };
    const [tasks, projects, users] = await Promise.all([
      app.db.task.findMany({
        where: { AND: [{ title: contains }, visibleTasksWhere(req.user)] },
        include: taskInclude,
        orderBy: [{ completed: 'asc' }, { updatedAt: 'desc' }],
        take: PER_KIND,
      }),
      app.db.project.findMany({
        where: { AND: [{ name: contains }, visibleProjectsWhere(req.user)] },
        include: projectInclude(req.user.id),
        orderBy: [{ archived: 'asc' }, { name: 'asc' }],
        take: PER_KIND,
      }),
      app.db.user.findMany({
        where: { isActive: true, OR: [{ name: contains }, { email: contains }] },
        select: userSummarySelect,
        orderBy: { name: 'asc' },
        take: PER_KIND,
      }),
    ]);
    return { tasks: tasks.map(toTask), projects: projects.map(toProject), users: users.map(toUserSummary) };
  });
}
