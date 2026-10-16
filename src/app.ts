import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { PrismaClient } from '@prisma/client';
import type { Config } from './config.js';
import { AppError, errorHandler } from './errors.js';
import dbPlugin from './plugins/db.js';
import authPlugin from './plugins/auth.js';
import healthRoutes from './routes/health.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import adminRoutes from './routes/admin.js';
import teamRoutes from './routes/teams.js';
import projectRoutes from './routes/projects.js';
import sectionRoutes from './routes/sections.js';
import taskRoutes from './routes/tasks.js';
import storyRoutes from './routes/stories.js';
import notificationRoutes from './routes/notifications.js';
import searchRoutes from './routes/search.js';
import goalRoutes from './routes/goals.js';
import reportRoutes from './routes/reports.js';

export type AppOptions = {
  config: Pick<Config, 'JWT_SECRET' | 'APP_URL' | 'NODE_ENV' | 'AUTH_RATE_LIMIT_MAX' | 'APP_TIMEZONE'>;
  prisma?: PrismaClient;
  logger?: boolean;
};

declare module 'fastify' {
  interface FastifyInstance {
    config: AppOptions['config'];
  }
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? opts.config.NODE_ENV !== 'test',
    trustProxy: true,
  });

  app.decorate('config', opts.config);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((req, reply) => {
    errorHandler(new AppError('NOT_FOUND', `Route ${req.method} ${req.url} not found`), req, reply);
  });

  // Off by default; auth routes opt in via `config.rateLimit`.
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_req, ctx) =>
      new AppError('RATE_LIMITED', `Too many attempts, try again in ${ctx.after}`),
  });
  await app.register(dbPlugin, { prisma: opts.prisma });
  await app.register(authPlugin, {
    secret: opts.config.JWT_SECRET,
    secureCookie: opts.config.NODE_ENV === 'production',
  });

  await app.register(healthRoutes);
  await app.register(
    async (api) => {
      await api.register(healthRoutes);
      await api.register(authRoutes, { prefix: '/auth' });
      await api.register(userRoutes);
      await api.register(adminRoutes, { prefix: '/admin' });
      await api.register(teamRoutes);
      await api.register(projectRoutes);
      await api.register(sectionRoutes);
      await api.register(taskRoutes);
      await api.register(storyRoutes);
      await api.register(notificationRoutes);
      await api.register(searchRoutes);
      await api.register(goalRoutes);
      await api.register(reportRoutes);
    },
    { prefix: '/api/v1' },
  );

  return app;
}
