import { afterAll, beforeAll, beforeEach } from 'vitest';
import { PrismaClient, type Role } from '@prisma/client';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/lib/password.js';

export const PASSWORD = 'password123';

export const prisma = new PrismaClient();

/** Every table except Prisma's bookkeeping, emptied between tests. */
async function resetDb() {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (rows.length === 0) return;
  const tables = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
}

/** Builds one app per test file and wipes the database before each test. */
export function setupApp() {
  const ctx = {} as { app: FastifyInstance };
  beforeAll(async () => {
    ctx.app = await buildApp({ config: loadConfig(), prisma, logger: false });
    await ctx.app.ready();
  });
  beforeEach(resetDb);
  afterAll(async () => {
    await ctx.app.close();
    await prisma.$disconnect();
  });
  return ctx;
}

let seq = 0;
export async function createUser(
  overrides: { email?: string; name?: string; role?: Role; isActive?: boolean } = {},
) {
  seq += 1;
  return prisma.user.create({
    data: {
      email: overrides.email ?? `user${seq}@example.com`,
      name: overrides.name ?? `User ${seq}`,
      role: overrides.role ?? 'MEMBER',
      isActive: overrides.isActive ?? true,
      avatarColor: '#4186e0',
      passwordHash: await hashPassword(PASSWORD),
    },
  });
}

export function sessionCookie(res: LightMyRequestResponse): string {
  const sid = res.cookies.find((c) => c.name === 'sid');
  if (!sid) throw new Error(`No sid cookie in response (status ${res.statusCode}): ${res.body}`);
  return `sid=${sid.value}`;
}

export async function login(app: FastifyInstance, email: string, password = PASSWORD) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
  return sessionCookie(res);
}

/** Creates a user and returns it along with a logged-in cookie. */
export async function signedIn(app: FastifyInstance, overrides: Parameters<typeof createUser>[0] = {}) {
  const user = await createUser(overrides);
  return { user, cookie: await login(app, user.email) };
}
