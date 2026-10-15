import fp from 'fastify-plugin';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    db: PrismaClient;
  }
}

async function dbPlugin(app: FastifyInstance, opts: { prisma?: PrismaClient }) {
  // Callers (tests) may share one client across app instances; only disconnect what we created.
  const owned = !opts.prisma;
  const prisma = opts.prisma ?? new PrismaClient();
  app.decorate('db', prisma);
  if (owned) app.addHook('onClose', async () => prisma.$disconnect());
}

export default fp(dbPlugin, { name: 'db' });
