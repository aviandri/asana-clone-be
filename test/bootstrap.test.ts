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
    expect(user).toMatchObject({ email: 'boss@example.com', role: 'ADMIN', isActive: true });
    expect(await login(ctx.app, 'boss@example.com', 'boss-password')).toMatch(/^sid=/);
  });

  it('promotes and reactivates an existing user, keeping their password when none is given', async () => {
    const existing = await createUser({ email: 'm@example.com', isActive: false });
    const { user, created } = await upsertAdmin(prisma, { email: 'm@example.com' });
    expect(created).toBe(false);
    expect(user).toMatchObject({ id: existing.id, role: 'ADMIN', isActive: true, passwordHash: existing.passwordHash });
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
