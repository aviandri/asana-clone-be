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
import workspaceRoutes from './routes/workspaces.js';
import attachmentRoutes from './routes/attachments.js';
import tokenRoutes from './routes/tokens.js';
import mcpRoutes from './routes/mcp.js';
import { APP_VERSION } from './version.js';
import oauthRoutes, { oauthRequestRoutes, sweepOAuth } from './routes/oauth.js';
import { sweepAttachments } from './lib/attachments.js';
import { DiskStorage, type StorageDriver } from './lib/storage.js';
import { defaultPolicy, permissivePolicy, type FetchPolicy } from './lib/link-preview.js';

export type AppOptions = {
  config: Pick<
    Config,
    | 'JWT_SECRET'
    | 'APP_URL'
    | 'NODE_ENV'
    | 'AUTH_RATE_LIMIT_MAX'
    | 'APP_TIMEZONE'
    | 'DEFAULT_WORKSPACE_NAME'
    | 'STORAGE_DIR'
    | 'MAX_UPLOAD_BYTES'
    | 'UPLOAD_RATE_LIMIT_MAX'
    | 'STORAGE_MIN_FREE_BYTES'
  > &
    Partial<
      Pick<
        Config,
        'REQUEST_TIMEOUT_MS' | 'LINK_PREVIEW_ENABLED' | 'LINK_PREVIEW_ALLOW_PRIVATE' | 'TRUST_PROXY_HOPS' | 'MCP_ENABLED' | 'OAUTH_REGISTER_RATE_LIMIT' | 'OAUTH_AUTHORIZE_RATE_LIMIT'
      >
    >;
  /** The link-preview fetcher's network policy (tests); default from LINK_PREVIEW_ALLOW_PRIVATE. */
  fetchPolicy?: FetchPolicy;
  prisma?: PrismaClient;
  logger?: boolean;
  /** Attachment storage; default: the disk driver under STORAGE_DIR. */
  storage?: StorageDriver;
  /** The hourly attachment sweeper (SPEC §13); default on, except under NODE_ENV=test. */
  sweeper?: boolean;
};

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** The first sweep, shortly after start: a service redeployed more often than hourly still sweeps. */
const FIRST_SWEEP_MS = 60 * 1000;

declare module 'fastify' {
  interface FastifyInstance {
    config: AppOptions['config'];
    storage: StorageDriver;
    fetchPolicy: FetchPolicy;
  }
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? opts.config.NODE_ENV !== 'test',
    // Hops, not `true`: with `true` the client's own leftmost X-Forwarded-For entry becomes req.ip (M2).
    trustProxy: opts.config.TRUST_PROXY_HOPS ?? 1,
    // A total cap: nginx streams upload bodies through unbuffered, so a stalled client would otherwise hold a
    // socket forever (its own timeouts are per read/write).
    requestTimeout: opts.config.REQUEST_TIMEOUT_MS ?? 900_000,
  });

  app.decorate('config', opts.config);
  app.decorate('storage', opts.storage ?? new DiskStorage(opts.config.STORAGE_DIR));
  app.decorate(
    'fetchPolicy',
    opts.fetchPolicy ?? (opts.config.LINK_PREVIEW_ALLOW_PRIVATE ? permissivePolicy : defaultPolicy),
  );
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
    appUrl: opts.config.APP_URL,
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
      await api.register(workspaceRoutes);
      await api.register(attachmentRoutes);
      await api.register(tokenRoutes);
      await api.register(oauthRequestRoutes);
    },
    { prefix: '/api/v1' },
  );

  // OAuth for MCP clients (SPEC §14): /.well-known/oauth-*, /oauth/*; 404s when MCP is off.
  await app.register(oauthRoutes);

  if (opts.config.MCP_ENABLED) {
    // The MCP endpoint (SPEC §14): bearer auth only.
    await app.register(mcpRoutes, { version: APP_VERSION });
  } else {
    // Feature off: a plain 404 for every method, not the 401 an unknown route gets without a session.
    app.all('/mcp', { config: { public: true } }, async () => {
      throw new AppError('NOT_FOUND', 'MCP is not enabled on this server');
    });
  }

  if (opts.sweeper ?? opts.config.NODE_ENV !== 'test') {
    let timer: NodeJS.Timeout | undefined;
    let closed = false;
    // Chained, never overlapping: the next sweep is scheduled when this one has finished.
    const schedule = (delay: number) => {
      if (closed) return;
      timer = setTimeout(() => {
        sweepAttachments(app.db, app.storage, new Date(), app.log)
          .then((r) => {
            if (r.drafts || r.orphans) app.log.info(r, 'Attachment sweep');
          })
          .then(() => sweepOAuth(app.db, new Date()))
          .then((r) => {
            if (Object.values(r).some((n) => n > 0)) app.log.info(r, 'OAuth sweep');
          })
          .catch((err: unknown) => app.log.error({ err }, 'Attachment sweep failed'))
          .finally(() => schedule(SWEEP_INTERVAL_MS));
      }, delay);
      timer.unref();
    };
    app.addHook('onReady', async () => schedule(FIRST_SWEEP_MS));
    app.addHook('onClose', async () => {
      closed = true;
      clearTimeout(timer);
    });
  }

  return app;
}
