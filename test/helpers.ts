import { afterAll, beforeAll, beforeEach } from 'vitest';
import { PrismaClient, type WorkspaceRole } from '@prisma/client';
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

/** The workspace test users join by default (created on demand; the DB is wiped between tests). */
export async function defaultWorkspaceId() {
  const existing = await prisma.workspace.findFirst({ where: { name: 'Test workspace' }, orderBy: { createdAt: 'asc' } });
  return (existing ?? (await prisma.workspace.create({ data: { name: 'Test workspace', color: '#4186e0' } }))).id;
}

let seq = 0;
/**
 * Creates a user with a membership (`role`, `memberActive`) in `workspaceId` (default: the test
 * workspace; `null` for none), which also becomes their last-used workspace.
 */
export async function createUser(
  overrides: {
    email?: string;
    name?: string;
    role?: WorkspaceRole;
    isActive?: boolean;
    memberActive?: boolean;
    workspaceId?: string | null;
  } = {},
) {
  seq += 1;
  const workspaceId = overrides.workspaceId === undefined ? await defaultWorkspaceId() : overrides.workspaceId;
  return prisma.user.create({
    data: {
      email: overrides.email ?? `user${seq}@example.com`,
      name: overrides.name ?? `User ${seq}`,
      isActive: overrides.isActive ?? true,
      avatarColor: '#4186e0',
      passwordHash: await hashPassword(PASSWORD),
      lastWorkspaceId: workspaceId,
      ...(workspaceId
        ? {
            workspaceMemberships: {
              create: { workspaceId, role: overrides.role ?? 'MEMBER', isActive: overrides.memberActive ?? true },
            },
          }
        : {}),
    },
  });
}

/** Adds an existing user to a workspace. */
export function addMember(workspaceId: string, userId: string, role: WorkspaceRole = 'MEMBER', isActive = true) {
  return prisma.workspaceMember.create({ data: { workspaceId, userId, role, isActive } });
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
