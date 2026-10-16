import { describe, expect, it } from 'vitest';
import { createUser, login, PASSWORD, setupApp, signedIn } from './helpers.js';

const ctx = setupApp();

describe('GET /users', () => {
  it('lists active users as UserSummary, filtered by q on name or email', async () => {
    const { cookie } = await signedIn(ctx.app, { name: 'Zed', email: 'zed@example.com' });
    await createUser({ name: 'Alice Smith', email: 'alice@example.com' });
    await createUser({ name: 'Bob', email: 'bob@smith.io' });
    await createUser({ name: 'Smithy Gone', isActive: false });

    const all = await ctx.app.inject({ method: 'GET', url: '/api/v1/users', headers: { cookie } });
    expect(all.json().data.map((u: { name: string }) => u.name)).toEqual(['Alice Smith', 'Bob', 'Zed']);
    expect(Object.keys(all.json().data[0]).sort()).toEqual(['avatarColor', 'email', 'id', 'name']);

    const q = await ctx.app.inject({ method: 'GET', url: '/api/v1/users?q=SMITH', headers: { cookie } });
    expect(q.json().data.map((u: { name: string }) => u.name)).toEqual(['Alice Smith', 'Bob']);
  });
});

describe('GET /users/:id', () => {
  it('returns a User or 404', async () => {
    const { cookie } = await signedIn(ctx.app);
    const other = await createUser({ name: 'Other' });
    const ok = await ctx.app.inject({ method: 'GET', url: `/api/v1/users/${other.id}`, headers: { cookie } });
    expect(ok.json()).toMatchObject({ id: other.id, name: 'Other', role: 'MEMBER', isActive: true });

    const missing = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/users/00000000-0000-0000-0000-000000000000',
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(404);

    const bad = await ctx.app.inject({ method: 'GET', url: '/api/v1/users/not-a-uuid', headers: { cookie } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('PATCH /users/me', () => {
  it('updates name and avatar color', async () => {
    const { cookie } = await signedIn(ctx.app);
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me',
      headers: { cookie },
      payload: { name: 'Renamed', avatarColor: '#123abc' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Renamed', avatarColor: '#123abc' });
  });

  it('changes password only with the correct current password', async () => {
    const { user, cookie } = await signedIn(ctx.app);
    const wrong = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me',
      headers: { cookie },
      payload: { currentPassword: 'nope-nope', newPassword: 'brand-new-pass' },
    });
    expect(wrong.statusCode).toBe(400);

    const ok = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me',
      headers: { cookie },
      payload: { currentPassword: PASSWORD, newPassword: 'brand-new-pass' },
    });
    expect(ok.statusCode).toBe(200);
    expect(await login(ctx.app, user.email, 'brand-new-pass')).toMatch(/^sid=/);
  });

  it('cannot change role through /users/me', async () => {
    const { cookie } = await signedIn(ctx.app);
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me',
      headers: { cookie },
      payload: { role: 'ADMIN' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('admin', () => {
  it('is forbidden for members', async () => {
    const { cookie } = await signedIn(ctx.app);
    for (const [method, url] of [
      ['GET', '/api/v1/admin/users'],
      ['GET', '/api/v1/admin/invites'],
      ['POST', '/api/v1/admin/invites'],
    ] as const) {
      const res = await ctx.app.inject({ method, url, headers: { cookie }, payload: { email: 'a@b.co' } });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    }
  });

  it('lists all users including inactive', async () => {
    const { cookie } = await signedIn(ctx.app, { role: 'ADMIN', name: 'Admin' });
    await createUser({ name: 'Gone', isActive: false });
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/users', headers: { cookie } });
    expect(res.json().data.map((u: { name: string; isActive: boolean }) => [u.name, u.isActive])).toEqual([
      ['Admin', true],
      ['Gone', false],
    ]);
  });

  it('changes role and deactivates users, but not yourself', async () => {
    const admin = await signedIn(ctx.app, { role: 'ADMIN' });
    const member = await createUser();
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${member.id}`,
      headers: { cookie: admin.cookie },
      payload: { role: 'ADMIN', isActive: false },
    });
    expect(res.json()).toMatchObject({ role: 'ADMIN', isActive: false });

    const self = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${admin.user.id}`,
      headers: { cookie: admin.cookie },
      payload: { isActive: false },
    });
    expect(self.statusCode).toBe(400);
  });

  it('creates, lists and revokes invites', async () => {
    const { cookie } = await signedIn(ctx.app, { role: 'ADMIN' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/invites',
      headers: { cookie },
      payload: { email: 'pending@example.com', role: 'MEMBER' },
    });
    expect(created.statusCode).toBe(201);
    const invite = created.json();
    expect(Object.keys(invite).sort()).toEqual(['createdAt', 'email', 'expiresAt', 'id', 'inviteUrl', 'role', 'token']);

    const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/invites', headers: { cookie } });
    expect(list.json().data).toHaveLength(1);
    expect(list.json().data[0]).toMatchObject({ id: invite.id, invitedBy: { id: expect.any(String) } });

    const del = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/admin/invites/${invite.id}`, headers: { cookie } });
    expect(del.statusCode).toBe(204);
    const again = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/admin/invites/${invite.id}`, headers: { cookie } });
    expect(again.statusCode).toBe(404);
  });

  it('refuses to invite an existing user', async () => {
    const { user, cookie } = await signedIn(ctx.app, { role: 'ADMIN' });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/invites',
      headers: { cookie },
      payload: { email: user.email, role: 'MEMBER' },
    });
    expect(res.statusCode).toBe(409);
  });
});
