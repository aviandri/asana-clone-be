import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { upsertAdmin } from '../src/lib/bootstrap.js';
import { createUser, login, prisma, setupApp } from './helpers.js';

const ctx = setupApp();

describe('upsertAdmin (npm run create-admin)', () => {
  it('creates a new admin who can log in', async () => {
    const { user, created } = await upsertAdmin(prisma, { email: 'Boss@Example.com', name: 'Boss', password: 'boss-password' });
    expect(created).toBe(true);
    expect(user).toMatchObject({ email: 'boss@example.com', isActive: true });
    // No workspace yet: the default one is created and becomes theirs.
    const membership = await prisma.workspaceMember.findFirstOrThrow({ where: { userId: user.id }, include: { workspace: true } });
    expect(membership).toMatchObject({ role: 'ADMIN', isActive: true, workspace: { name: 'Mekari' } });
    expect(user.lastWorkspaceId).toBe(membership.workspaceId);
    expect(await login(ctx.app, 'boss@example.com', 'boss-password')).toMatch(/^sid=/);
  });

  it('promotes and reactivates an existing user, keeping their password when none is given', async () => {
    const existing = await createUser({ email: 'm@example.com', isActive: false, workspaceId: null });
    const mekari = await prisma.workspace.create({ data: { name: 'Mekari', color: '#4186e0' } });
    await prisma.workspaceMember.create({ data: { workspaceId: mekari.id, userId: existing.id, role: 'MEMBER', isActive: false } });
    const { user, created, workspace } = await upsertAdmin(prisma, { email: 'm@example.com' });
    expect(created).toBe(false);
    expect(workspace.id).toBe(mekari.id); // reuses the existing default workspace
    expect(user).toMatchObject({ id: existing.id, isActive: true, passwordHash: existing.passwordHash, lastWorkspaceId: mekari.id });
    expect(await prisma.workspaceMember.findFirstOrThrow({ where: { userId: user.id } })).toMatchObject({ role: 'ADMIN', isActive: true });
    expect(await prisma.workspace.count()).toBe(1);
  });

  it('uses the oldest workspace when none has the default name (it was renamed), instead of creating one', async () => {
    const renamed = await prisma.workspace.create({ data: { name: 'Mekari Group', color: '#4186e0', createdAt: new Date('2026-01-01') } });
    await prisma.workspace.create({ data: { name: 'Later', color: '#000000' } });
    const { workspace } = await upsertAdmin(prisma, { email: 'boss@example.com', name: 'Boss', password: 'boss-password' });
    expect(workspace.id).toBe(renamed.id);
    expect(await prisma.workspace.count()).toBe(2);
  });

  it('needs a name and password to create', async () => {
    await expect(upsertAdmin(prisma, { email: 'new@example.com' })).rejects.toThrow(/--name and --password/);
  });
});

describe('auth rate limiting', () => {
  let limited: FastifyInstance;
  beforeAll(async () => {
    limited = await buildApp({ config: { ...loadConfig(), AUTH_RATE_LIMIT_MAX: 2 }, prisma, logger: false });
  });
  afterAll(() => limited.close());

  it('returns 429 RATE_LIMITED after the per-IP limit on /auth/login', async () => {
    const attempt = () =>
      limited.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'x@example.com', password: 'wrong' } });
    expect((await attempt()).statusCode).toBe(401);
    expect((await attempt()).statusCode).toBe(401);
    const blocked = await attempt();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('RATE_LIMITED');
    // Other routes are unaffected.
    expect((await limited.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });
});
