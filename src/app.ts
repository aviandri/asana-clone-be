import Fastify, { type FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { Config } from './config.js';
import { AppError, errorHandler } from './errors.js';
import dbPlugin from './plugins/db.js';
import authPlugin from './plugins/auth.js';
import healthRoutes from './routes/health.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import adminRoutes from './routes/admin.js';

export type AppOptions = {
  config: Pick<Config, 'JWT_SECRET' | 'APP_URL' | 'NODE_ENV'>;
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
    },
    { prefix: '/api/v1' },
  );

  return app;
}
