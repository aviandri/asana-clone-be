import { beforeEach, describe, expect, it } from 'vitest';
import { addMember, defaultWorkspaceId, PASSWORD, prisma, setupApp, signedIn } from './helpers.js';

const ctx = setupApp();

type Session = { user: { id: string; email: string }; cookie: string };
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

function req(s: Session, method: Method, url: string, payload?: object, workspaceId?: string) {
  return ctx.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { cookie: s.cookie, ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}) },
    payload,
  });
}

async function ok<T = { id: string }>(res: Awaited<ReturnType<typeof req>>): Promise<T> {
  if (res.statusCode >= 300) throw new Error(`${res.statusCode}: ${res.body}`);
  return res.json() as T;
}

const names = (body: { data: { name?: string; title?: string }[] }) => body.data.map((r) => r.name ?? r.title).sort();

/**
 * The test workspace: admin ADMIN, mia MEMBER (both @mekari.com), gus GUEST (@partner.test).
 * Content: a team with a PUBLIC "Shared" project (gus is an EDITOR there) and a PUBLIC "Internal"
 * project gus isn't in, plus a company goal.
 */
let ws: string;
let admin: Session;
let mia: Session;
let gus: Session;
let shared: { id: string; sections: { id: string }[] };
let internal: { id: string };
let team: { id: string };
let goal: { id: string };

beforeEach(async () => {
  ws = await defaultWorkspaceId();
  admin = await signedIn(ctx.app, { name: 'Admin', email: 'admin@mekari.com', role: 'ADMIN' });
  mia = await signedIn(ctx.app, { name: 'Mia', email: 'mia@mekari.com' });
  gus = await signedIn(ctx.app, { name: 'Gus', email: 'gus@partner.test', role: 'GUEST' });
  team = await ok(await req(admin, 'POST', '/teams', { name: 'Core' }));
  await ok(await req(admin, 'POST', `/teams/${team.id}/members`, { userId: mia.user.id }));
  shared = await ok(await req(admin, 'POST', '/projects', { teamId: team.id, name: 'Shared', privacy: 'PUBLIC' }));
  internal = await ok(await req(admin, 'POST', '/projects', { teamId: team.id, name: 'Internal', privacy: 'PUBLIC' }));
  await ok(await req(admin, 'POST', `/projects/${shared.id}/members`, { userId: gus.user.id, role: 'EDITOR' }));
  goal = await ok(await req(admin, 'POST', '/goals', { title: 'Company goal', timePeriod: '2031', isCompany: true }));
});

describe('GUEST role (SPEC §12)', () => {
  it('sees only projects they are a member of, and tasks in them plus their own personal tasks', async () => {
    await ok(await req(admin, 'POST', '/tasks', { title: 'Shared task', projectId: shared.id }));
    const hidden = await ok(await req(admin, 'POST', '/tasks', { title: 'Internal task', projectId: internal.id }));
    await ok(await req(mia, 'POST', '/tasks', { title: 'Mia errand' }));
    await ok(await req(gus, 'POST', '/tasks', { title: 'Gus errand' }));

    expect(names(await ok(await req(gus, 'GET', '/projects')))).toEqual(['Shared']);
    expect((await req(gus, 'GET', `/projects/${internal.id}`)).statusCode).toBe(404);
    expect((await req(gus, 'GET', `/tasks/${hidden.id}`)).statusCode).toBe(404);
    const search = await ok<{ tasks: { title: string }[]; projects: { name: string }[] }>(await req(gus, 'GET', '/search?q=task'));
    expect(search.tasks.map((t) => t.title)).toEqual(['Shared task']);
    const errands = await ok<{ tasks: { title: string }[] }>(await req(gus, 'GET', '/search?q=errand'));
    expect(errands.tasks.map((t) => t.title)).toEqual(['Gus errand']);
    // Members still see PUBLIC projects as before.
    expect(names(await ok(await req(mia, 'GET', '/projects')))).toEqual(['Internal', 'Shared']);
  });

  it('can’t create teams or projects, join teams, or see teams', async () => {
    expect((await req(gus, 'POST', '/teams', { name: 'Mine' })).statusCode).toBe(403);
    expect((await req(gus, 'POST', '/projects', { teamId: team.id, name: 'Mine', privacy: 'PUBLIC' })).statusCode).toBe(403);
    const join = await req(admin, 'POST', `/teams/${team.id}/members`, { userId: gus.user.id });
    expect(join.statusCode).toBe(400);
    expect(join.json().error.details).toEqual([expect.objectContaining({ path: ['userId'] })]);
    expect((await ok<{ data: unknown[] }>(await req(gus, 'GET', '/teams'))).data).toEqual([]);
    expect((await req(gus, 'GET', `/teams/${team.id}`)).statusCode).toBe(404);
  });

  it('can’t see, create or own goals', async () => {
    expect((await ok<{ data: unknown[] }>(await req(gus, 'GET', '/goals'))).data).toEqual([]);
    expect((await ok<{ data: string[] }>(await req(gus, 'GET', '/goals/time-periods'))).data).not.toContain('2031');
    expect((await req(gus, 'GET', `/goals/${goal.id}`)).statusCode).toBe(404);
    expect((await req(gus, 'GET', `/goals/${goal.id}/updates`)).statusCode).toBe(404);
    expect((await req(gus, 'POST', '/goals', { title: 'Mine', timePeriod: '2026' })).statusCode).toBe(403);
    const owned = await req(admin, 'PATCH', `/goals/${goal.id}`, { ownerId: gus.user.id });
    expect(owned.statusCode).toBe(400);
    expect(owned.json().error.details).toEqual([expect.objectContaining({ path: ['ownerId'] })]);
  });

  it('/users and search only show people who share a project with them; members see guests', async () => {
    await ok(await req(admin, 'POST', `/projects/${shared.id}/members`, { userId: mia.user.id }));
    const other = await signedIn(ctx.app, { name: 'Otto', email: 'otto@mekari.com' });
    expect(names(await ok(await req(gus, 'GET', '/users')))).toEqual(['Admin', 'Gus', 'Mia']);
    const search = await ok<{ users: { name: string }[] }>(await req(gus, 'GET', '/search?q=otto'));
    expect(search.users).toEqual([]);
    expect(names(await ok(await req(other, 'GET', '/users')))).toEqual(['Admin', 'Gus', 'Mia', 'Otto']);
  });

  it('reports: project report on visible projects only; workload is 403; admin is 403', async () => {
    expect((await req(gus, 'GET', `/projects/${shared.id}/report`)).statusCode).toBe(200);
    expect((await req(gus, 'GET', `/projects/${internal.id}/report`)).statusCode).toBe(404);
    const overview = await ok<{ projects: { project: { name: string } }[] }>(await req(gus, 'GET', '/reports/overview'));
    expect(overview.projects.map((p) => p.project.name)).toEqual(['Shared']);
    expect((await req(gus, 'GET', '/reports/workload')).statusCode).toBe(403);
    expect((await req(gus, 'GET', '/admin/users')).statusCode).toBe(403);
    expect((await req(gus, 'PATCH', `/workspaces/${ws}`, { name: 'x' })).statusCode).toBe(403);
  });

  it('demoting a member to GUEST removes their team memberships but keeps project ones', async () => {
    await ok(await req(admin, 'POST', `/projects/${shared.id}/members`, { userId: mia.user.id }));
    expect(await ok(await req(admin, 'PATCH', `/admin/users/${mia.user.id}`, { role: 'GUEST' }))).toMatchObject({ role: 'GUEST' });
    expect(await prisma.teamMember.count({ where: { userId: mia.user.id } })).toBe(0);
    expect(await prisma.projectMember.count({ where: { userId: mia.user.id } })).toBe(1);
  });
});

describe('organizations', () => {
  async function convert(body: object = { isOrganization: true, domain: 'Mekari.com' }) {
    return req(admin, 'PATCH', `/workspaces/${ws}`, body);
  }

  it('converting turns off-domain members into guests and reports how many', async () => {
    const outsider = await signedIn(ctx.app, { name: 'Ext', email: 'ext@agency.test' });
    await ok(await req(admin, 'POST', `/teams/${team.id}/members`, { userId: outsider.user.id }));
    await ok(await req(admin, 'POST', '/admin/invites', { email: 'pending@agency.test', role: 'MEMBER' }));

    const res = await ok<{ isOrganization: boolean; domain: string; convertedToGuests: number }>(await convert());
    expect(res).toMatchObject({ isOrganization: true, domain: 'mekari.com', convertedToGuests: 1 }); // gus already was one
    const roles = await prisma.workspaceMember.findMany({ where: { workspaceId: ws }, include: { user: true } });
    expect(Object.fromEntries(roles.map((m) => [m.user.email, m.role]))).toEqual({
      'admin@mekari.com': 'ADMIN',
      'mia@mekari.com': 'MEMBER',
      'gus@partner.test': 'GUEST',
      'ext@agency.test': 'GUEST',
    });
    expect(await prisma.teamMember.count({ where: { userId: outsider.user.id } })).toBe(0);
    expect((await prisma.invite.findFirstOrThrow({ where: { email: 'pending@agency.test' } })).role).toBe('GUEST');

    // Renaming doesn't re-run the conversion; turning it off clears the domain and keeps roles.
    expect(await ok(await req(admin, 'PATCH', `/workspaces/${ws}`, { name: 'Renamed' }))).not.toHaveProperty('convertedToGuests');
    expect(await ok(await convert({ isOrganization: false }))).toMatchObject({ isOrganization: false, domain: null });
    expect((await prisma.workspaceMember.findFirstOrThrow({ where: { userId: outsider.user.id } })).role).toBe('GUEST');
  });

  it('validates the domain: required, caller on it (400), unique (409), none without isOrganization', async () => {
    expect((await convert({ isOrganization: true })).statusCode).toBe(400);
    expect((await convert({ isOrganization: true, domain: 'not a domain' })).statusCode).toBe(400);
    expect((await convert({ domain: 'mekari.com' })).statusCode).toBe(400);
    const notMine = await convert({ isOrganization: true, domain: 'partner.test' });
    expect(notMine.statusCode).toBe(400);
    expect(notMine.json().error.details).toEqual([expect.objectContaining({ path: ['domain'] })]);
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: ws } })).isOrganization).toBe(false);

    await prisma.workspace.create({ data: { name: 'Other', color: '#000000', isOrganization: true, domain: 'mekari.com' } });
    expect((await convert()).statusCode).toBe(409);
  });

  it('invites and role changes: external people can only be guests', async () => {
    await ok(await convert());
    const bad = await req(admin, 'POST', '/admin/invites', { email: 'x@agency.test', role: 'MEMBER' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.details).toEqual([{ path: ['role'], message: 'External people can only be guests' }]);
    expect((await req(admin, 'POST', '/admin/invites', { email: 'x@agency.test', role: 'GUEST' })).statusCode).toBe(201);
    expect((await req(admin, 'POST', '/admin/invites', { email: 'new@mekari.com', role: 'ADMIN' })).statusCode).toBe(201);
    expect((await req(admin, 'PATCH', `/admin/users/${gus.user.id}`, { role: 'MEMBER' })).statusCode).toBe(400);
  });

  it('people on the domain can see and join it as MEMBER; others get 403; deactivated members can’t rejoin', async () => {
    await ok(await convert());
    const other = (await prisma.workspace.create({ data: { name: 'Elsewhere', color: '#000000' } })).id;
    const newcomer = await signedIn(ctx.app, { name: 'Nina', email: 'nina@mekari.com', workspaceId: other });
    const stranger = await signedIn(ctx.app, { name: 'Sam', email: 'sam@partner.test', workspaceId: other });

    expect((await ok<{ data: unknown[] }>(await req(newcomer, 'GET', '/workspaces/joinable'))).data).toEqual([
      { id: ws, name: 'Test workspace', color: '#4186e0', memberCount: 3 },
    ]);
    expect((await ok<{ data: unknown[] }>(await req(stranger, 'GET', '/workspaces/joinable'))).data).toEqual([]);
    expect((await ok<{ data: unknown[] }>(await req(mia, 'GET', '/workspaces/joinable'))).data).toEqual([]);

    expect((await req(stranger, 'POST', `/workspaces/${ws}/join`)).statusCode).toBe(403);
    const joined = await req(newcomer, 'POST', `/workspaces/${ws}/join`);
    expect(joined.statusCode).toBe(201);
    expect(joined.json()).toMatchObject({ id: ws, myRole: 'MEMBER', memberCount: 4 });
    expect((await req(newcomer, 'POST', `/workspaces/${ws}/join`)).statusCode).toBe(409);
    expect((await req(newcomer, 'POST', `/workspaces/${other}/join`)).statusCode).toBe(403); // not an organization

    // An admin deactivates Mia: she can't rejoin by herself.
    await ok(await req(admin, 'PATCH', `/admin/users/${mia.user.id}`, { isActive: false }));
    expect((await req(mia, 'POST', `/workspaces/${ws}/join`)).statusCode).toBe(403);
  });

  it('a globally deactivated user can’t log in, so can’t join or accept invites', async () => {
    await ok(await convert());
    const other = (await prisma.workspace.create({ data: { name: 'Elsewhere', color: '#000000' } })).id;
    const gone = await signedIn(ctx.app, { name: 'Gone', email: 'gone@mekari.com', workspaceId: other });
    const invite = await ok<{ id: string }>(await req(admin, 'POST', '/admin/invites', { email: 'gone@mekari.com', role: 'MEMBER' }));
    await prisma.user.update({ where: { id: gone.user.id }, data: { isActive: false } });

    const login = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'gone@mekari.com', password: PASSWORD } });
    expect(login.statusCode).toBe(401);
    // An old session doesn't help either.
    expect((await req(gone, 'GET', '/workspaces/joinable')).statusCode).toBe(401);
    expect((await req(gone, 'POST', `/workspaces/${ws}/join`)).statusCode).toBe(401);
    expect((await req(gone, 'POST', `/me/invites/${invite.id}/accept`)).statusCode).toBe(401);
    expect(await prisma.workspaceMember.count({ where: { userId: gone.user.id, workspaceId: ws } })).toBe(0);
  });
});

describe('/me/invites (existing accounts)', () => {
  let other: string;
  let pat: Session;
  beforeEach(async () => {
    other = (await prisma.workspace.create({ data: { name: 'Elsewhere', color: '#123456' } })).id;
    pat = await signedIn(ctx.app, { name: 'Pat', email: 'pat@mekari.com', workspaceId: other });
  });

  it('lists pending invites to my email; accepting adds the membership with the invite’s role', async () => {
    const invite = await ok<{ id: string; token: string }>(await req(admin, 'POST', '/admin/invites', { email: 'pat@mekari.com', role: 'GUEST' }));
    const lookup = await ctx.app.inject({ method: 'GET', url: `/api/v1/auth/invites/${invite.token}` });
    expect(lookup.json()).toMatchObject({ existingUser: true, workspace: { id: ws } });

    const mine = await ok<{ data: unknown[] }>(await req(pat, 'GET', '/me/invites'));
    expect(mine.data).toEqual([
      {
        id: invite.id,
        workspace: { id: ws, name: 'Test workspace', color: '#4186e0' },
        role: 'GUEST',
        invitedBy: expect.objectContaining({ id: admin.user.id, name: 'Admin' }),
        expiresAt: expect.any(String),
      },
    ]);
    expect((await ok<{ data: unknown[] }>(await req(mia, 'GET', '/me/invites'))).data).toEqual([]);
    // Someone else's invite looks like none.
    expect((await req(mia, 'POST', `/me/invites/${invite.id}/accept`)).statusCode).toBe(404);

    const accepted = await req(pat, 'POST', `/me/invites/${invite.id}/accept`);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ id: ws, myRole: 'GUEST' });
    expect((await req(pat, 'POST', `/me/invites/${invite.id}/accept`)).statusCode).toBe(410);
    expect((await ok<{ data: unknown[] }>(await req(pat, 'GET', '/me/invites'))).data).toEqual([]);
    expect((await ok<{ data: { id: string }[] }>(await req(pat, 'GET', '/workspaces'))).data.map((w) => w.id).sort()).toEqual(
      [ws, other].sort(),
    );
  });

  it('accepting re-activates a deactivated member; declining deletes the invite', async () => {
    await prisma.workspaceMember.create({ data: { workspaceId: ws, userId: pat.user.id, role: 'MEMBER', isActive: false } });
    const invite = await ok<{ id: string }>(await req(admin, 'POST', '/admin/invites', { email: 'pat@mekari.com', role: 'MEMBER' }));
    await ok(await req(pat, 'POST', `/me/invites/${invite.id}/accept`));
    expect(await prisma.workspaceMember.findFirstOrThrow({ where: { workspaceId: ws, userId: pat.user.id } })).toMatchObject({
      isActive: true,
      role: 'MEMBER',
    });

    // A second invite, to a workspace Admin also runs.
    const third = (await prisma.workspace.create({ data: { name: 'Third', color: '#000000' } })).id;
    await addMember(third, admin.user.id, 'ADMIN');
    const second = await ok<{ id: string }>(await req(admin, 'POST', '/admin/invites', { email: 'pat@mekari.com', role: 'MEMBER' }, third));
    expect((await req(mia, 'DELETE', `/me/invites/${second.id}`)).statusCode).toBe(404);
    expect((await req(pat, 'DELETE', `/me/invites/${second.id}`)).statusCode).toBe(204);
    expect(await prisma.invite.count({ where: { id: second.id } })).toBe(0);
  });

  it('only one pending invite per workspace and email (re-inviting replaces it)', async () => {
    await ok(await req(admin, 'POST', '/admin/invites', { email: 'pat@mekari.com', role: 'MEMBER' }));
    await ok(await req(admin, 'POST', '/admin/invites', { email: 'pat@mekari.com', role: 'GUEST' }));
    expect(await prisma.invite.count({ where: { workspaceId: ws, email: 'pat@mekari.com', acceptedAt: null } })).toBe(1);
    // The database refuses a second pending one.
    const first = await prisma.invite.findFirstOrThrow({ where: { workspaceId: ws } });
    await expect(
      prisma.invite.create({
        data: { workspaceId: ws, email: 'pat@mekari.com', role: 'MEMBER', token: 'dup', invitedById: admin.user.id, expiresAt: first.expiresAt },
      }),
    ).rejects.toThrow();
  });
});
