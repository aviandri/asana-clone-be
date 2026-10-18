import { describe, expect, it } from 'vitest';
import { createUser, login, PASSWORD, prisma, sessionCookie, setupApp, signedIn } from './helpers.js';

const ctx = setupApp();

describe('health', () => {
  it('answers at /health and /api/v1/health without auth', async () => {
    for (const url of ['/health', '/api/v1/health']) {
      const res = await ctx.app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    }
  });
});

describe('errors', () => {
  it('returns the error envelope for unknown routes (401 first when signed out)', async () => {
    const anon = await ctx.app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(anon.statusCode).toBe(401);
    const { cookie } = await signedIn(ctx.app);
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/nope', headers: { cookie } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('requires auth on protected routes', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });

  it('rejects a tampered cookie', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: 'sid=not-a-jwt' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('maps validation failures to 400 VALIDATION', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'x' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
    expect(res.json().error.details).toBeInstanceOf(Array);
  });
});

describe('login / logout / me', () => {
  it('logs in case-insensitively, sets an httpOnly cookie and returns the User', async () => {
    const user = await createUser({ email: 'alice@example.com', name: 'Alice' });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'Alice@Example.com', password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: user.id,
      email: 'alice@example.com',
      name: 'Alice',
      avatarColor: '#4186e0',
      role: 'MEMBER',
      isActive: true,
      createdAt: user.createdAt.toISOString(),
      // SPEC §12: login returns Me.
      currentWorkspace: expect.objectContaining({ id: user.lastWorkspaceId, myRole: 'MEMBER', memberCount: 1 }),
      workspaces: [expect.objectContaining({ id: user.lastWorkspaceId, name: 'Test workspace' })],
    });
    const sid = res.cookies.find((c) => c.name === 'sid')!;
    expect(sid.httpOnly).toBe(true);
    expect(sid.sameSite).toBe('Lax');

    const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: sessionCookie(res) } });
    expect(me.statusCode).toBe(200);
    expect(me.json().id).toBe(user.id);
    expect(me.json()).not.toHaveProperty('passwordHash');
  });

  it('rejects a wrong password and an unknown email with 401', async () => {
    await createUser({ email: 'bob@example.com' });
    for (const payload of [
      { email: 'bob@example.com', password: 'wrong-password' },
      { email: 'nobody@example.com', password: PASSWORD },
    ]) {
      const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload });
      expect(res.statusCode).toBe(401);
    }
  });

  it('rejects inactive users at login and on existing sessions', async () => {
    const { user, cookie } = await signedIn(ctx.app);
    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
    const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(401);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: user.email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(401);
  });

  it('logout clears the cookie', async () => {
    const { cookie } = await signedIn(ctx.app);
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie } });
    expect(res.statusCode).toBe(204);
    const sid = res.cookies.find((c) => c.name === 'sid')!;
    expect(sid.value).toBe('');
  });
});

describe('invites', () => {
  async function invite(email = 'new@example.com', role: 'ADMIN' | 'MEMBER' = 'MEMBER') {
    const admin = await signedIn(ctx.app, { role: 'ADMIN' });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/invites',
      headers: { cookie: admin.cookie },
      payload: { email, role },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; token: string; inviteUrl: string };
  }

  it('looks up a pending invite without auth', async () => {
    const { id, token, inviteUrl } = await invite('New@Example.com', 'ADMIN');
    expect(inviteUrl).toBe(`http://localhost:5173/invite/${token}`);
    const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/auth/invites/${token}` });
    expect(res.statusCode).toBe(200);
    const ws = await prisma.workspace.findFirstOrThrow();
    expect(res.json()).toEqual({
      id,
      email: 'new@example.com',
      role: 'ADMIN',
      workspace: { id: ws.id, name: ws.name, color: ws.color },
      existingUser: false,
    });
  });

  it('returns 404 for an unknown token', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/invites/missing' });
    expect(res.statusCode).toBe(404);
  });

  it('accepts an invite, creates the user and signs them in', async () => {
    const { token } = await invite();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/accept-invite',
      payload: { token, name: 'Newbie', password: 'secret-pass' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ email: 'new@example.com', name: 'Newbie', role: 'MEMBER' });
    const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: sessionCookie(res) } });
    expect(me.json().name).toBe('Newbie');
    expect(await login(ctx.app, 'new@example.com', 'secret-pass')).toMatch(/^sid=/);
  });

  it('returns 410 for a used or expired invite', async () => {
    const { token } = await invite();
    const payload = { token, name: 'Once', password: 'secret-pass' };
    await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/accept-invite', payload });
    const again = await ctx.app.inject({ method: 'GET', url: `/api/v1/auth/invites/${token}` });
    expect(again.statusCode).toBe(410);

    const second = await invite('late@example.com');
    await prisma.invite.update({ where: { id: second.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/accept-invite',
      payload: { token: second.token, name: 'Late', password: 'secret-pass' },
    });
    expect(expired.statusCode).toBe(410);
  });

  it('rejects short passwords', async () => {
    const { token } = await invite();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/accept-invite',
      payload: { token, name: 'X', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
  });
});
