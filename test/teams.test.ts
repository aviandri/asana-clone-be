import { describe, expect, it } from 'vitest';
import { createUser, prisma, setupApp, signedIn, defaultWorkspaceId } from './helpers.js';

const ctx = setupApp();

async function createTeam(cookie: string, name = 'Engineering') {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/teams',
    headers: { cookie },
    payload: { name, description: 'Builds things' },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

describe('teams', () => {
  it('creates a team with the creator as member (TeamDetail shape)', async () => {
    const { user, cookie } = await signedIn(ctx.app, { name: 'Alice' });
    const team = await createTeam(cookie);
    expect(team).toEqual({
      id: expect.any(String),
      workspaceId: expect.any(String),
      name: 'Engineering',
      description: 'Builds things',
      memberCount: 1,
      createdAt: expect.any(String),
      members: [{ id: user.id, name: 'Alice', email: user.email, avatarColor: '#4186e0' }],
    });
    const got = await ctx.app.inject({ method: 'GET', url: `/api/v1/teams/${team.id}`, headers: { cookie } });
    expect(got.json()).toEqual(team);
  });

  it('lists all teams, or only mine with ?mine=true', async () => {
    const alice = await signedIn(ctx.app);
    const bob = await signedIn(ctx.app);
    await createTeam(alice.cookie, 'Engineering');
    await createTeam(bob.cookie, 'Marketing');

    const all = await ctx.app.inject({ method: 'GET', url: '/api/v1/teams', headers: { cookie: alice.cookie } });
    expect(all.json().data.map((t: { name: string }) => t.name)).toEqual(['Engineering', 'Marketing']);
    expect(all.json().data[0]).not.toHaveProperty('members');
    expect(all.json().data[0].memberCount).toBe(1);

    const mine = await ctx.app.inject({ method: 'GET', url: '/api/v1/teams?mine=true', headers: { cookie: alice.cookie } });
    expect(mine.json().data.map((t: { name: string }) => t.name)).toEqual(['Engineering']);
  });

  it('lets team members (not outsiders) edit and manage members', async () => {
    const alice = await signedIn(ctx.app);
    const outsider = await signedIn(ctx.app);
    const carol = await createUser({ name: 'Carol' });
    const team = await createTeam(alice.cookie);

    const denied = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/teams/${team.id}`,
      headers: { cookie: outsider.cookie },
      payload: { name: 'Hijacked' },
    });
    expect(denied.statusCode).toBe(403);

    const renamed = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/teams/${team.id}`,
      headers: { cookie: alice.cookie },
      payload: { name: 'Platform', description: null },
    });
    expect(renamed.json()).toMatchObject({ name: 'Platform', description: null });

    const added = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/teams/${team.id}/members`,
      headers: { cookie: alice.cookie },
      payload: { userId: carol.id },
    });
    expect(added.json().memberCount).toBe(2);
    const again = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/teams/${team.id}/members`,
      headers: { cookie: alice.cookie },
      payload: { userId: carol.id },
    });
    expect(again.json().memberCount).toBe(2);

    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/teams/${team.id}/members/${carol.id}`,
      headers: { cookie: alice.cookie },
    });
    expect(removed.json().members.map((m: { id: string }) => m.id)).toEqual([alice.user.id]);
  });

  it('only admins delete teams, and not while they have projects', async () => {
    const member = await signedIn(ctx.app);
    const admin = await signedIn(ctx.app, { role: 'ADMIN' });
    const team = await createTeam(member.cookie);

    const forbidden = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/teams/${team.id}`, headers: { cookie: member.cookie } });
    expect(forbidden.statusCode).toBe(403);

    await prisma.project.create({
      data: { workspaceId: await defaultWorkspaceId(), teamId: team.id, ownerId: member.user.id, name: 'P', color: '#4186e0' },
    });
    const blocked = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/teams/${team.id}`, headers: { cookie: admin.cookie } });
    expect(blocked.statusCode).toBe(409);

    await prisma.project.deleteMany({ where: { teamId: team.id } });
    const ok = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/teams/${team.id}`, headers: { cookie: admin.cookie } });
    expect(ok.statusCode).toBe(204);
  });
});
