import { beforeEach, describe, expect, it } from 'vitest';
import { addMember, createUser, defaultWorkspaceId, login, PASSWORD, prisma, setupApp, signedIn } from './helpers.js';

const ctx = setupApp();

type Session = { user: { id: string }; cookie: string };
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

/**
 * Workspace A (the test workspace): alice ADMIN, carol MEMBER.
 * Workspace B: bob ADMIN, carol MEMBER. Carol's current workspace is A.
 */
let wsA: string;
let wsB: string;
let alice: Session;
let bob: Session;
let carol: Session;

beforeEach(async () => {
  wsA = await defaultWorkspaceId();
  wsB = (await prisma.workspace.create({ data: { name: 'Beta', color: '#000000' } })).id;
  alice = await signedIn(ctx.app, { name: 'Alice', role: 'ADMIN' });
  bob = await signedIn(ctx.app, { name: 'Bob', role: 'ADMIN', workspaceId: wsB });
  carol = await signedIn(ctx.app, { name: 'Carol' });
  await addMember(wsB, carol.user.id);
});

/** Content in workspace B, created by bob through the API. */
async function seedB() {
  const team = await ok(await req(bob, 'POST', '/teams', { name: 'Beta team' }, wsB));
  const project = await ok<{ id: string; sections: { id: string }[] }>(
    await req(bob, 'POST', '/projects', { teamId: team.id, name: 'Beta secret plan', privacy: 'PUBLIC' }, wsB),
  );
  const task = await ok(
    await req(bob, 'POST', '/tasks', { title: 'Beta secret task', projectId: project.id, assigneeId: carol.user.id }, wsB),
  );
  const personal = await ok(await req(bob, 'POST', '/tasks', { title: 'Beta secret errand', assigneeId: bob.user.id }, wsB));
  const comment = await ok(await req(bob, 'POST', `/tasks/${task.id}/comments`, { body: 'Beta secret comment' }));
  const goal = await ok(await req(bob, 'POST', '/goals', { title: 'Beta secret goal', timePeriod: '2031', isCompany: true }, wsB));
  const kr = await ok(await req(bob, 'POST', `/goals/${goal.id}/key-results`, { title: 'KR', metricType: 'NUMBER', targetValue: 5 }));
  return { team, project, section: project.sections[0]!, task, personal, comment, goal, kr };
}

describe('current workspace resolution', () => {
  it('uses the header, else lastWorkspaceId, else the oldest membership; a foreign header is 404', async () => {
    await seedB();
    // Carol: no header → lastWorkspaceId (A); header B → B.
    expect((await ok<{ data: unknown[] }>(await req(carol, 'GET', '/projects'))).data).toHaveLength(0);
    expect((await ok<{ data: { name: string }[] }>(await req(carol, 'GET', '/projects', undefined, wsB))).data.map((p) => p.name)).toEqual([
      'Beta secret plan',
    ]);
    // Without lastWorkspaceId, the oldest membership (A) is used.
    await prisma.user.update({ where: { id: carol.user.id }, data: { lastWorkspaceId: null } });
    expect((await ok<{ data: unknown[] }>(await req(carol, 'GET', '/projects'))).data).toHaveLength(0);

    for (const header of [wsB, 'not-a-uuid']) {
      const res = await req(alice, 'GET', '/projects', undefined, header);
      expect(res.statusCode).toBe(404);
    }
    // /auth/me ignores a bad header instead of failing.
    const me = await ok<{ currentWorkspace: { id: string } }>(await req(alice, 'GET', '/auth/me', undefined, wsB));
    expect(me.currentWorkspace.id).toBe(wsA);
  });

  it('returns 403 NO_WORKSPACE on scoped endpoints for a user without workspaces', async () => {
    const loner = await signedIn(ctx.app, { workspaceId: null });
    for (const url of ['/projects', '/teams', '/users', '/me/tasks', '/goals', '/notifications', '/search?q=ab', '/reports/overview']) {
      const res = await req(loner, 'GET', url);
      expect(res.statusCode, url).toBe(403);
      expect(res.json().error.details).toEqual([{ path: ['workspace'], message: 'NO_WORKSPACE' }]);
    }
    const me = await ok(await req(loner, 'GET', '/auth/me'));
    expect(me).toMatchObject({ currentWorkspace: null, workspaces: [], role: 'MEMBER' });
  });

  it('Me lists workspaces by name with my role, and the role follows the current workspace', async () => {
    const me = await ok<{ role: string; currentWorkspace: { id: string }; workspaces: { name: string; myRole: string; memberCount: number }[] }>(
      await req(carol, 'GET', '/auth/me', undefined, wsB),
    );
    expect(me.currentWorkspace.id).toBe(wsB);
    expect(me.workspaces.map((w) => [w.name, w.myRole, w.memberCount])).toEqual([
      ['Beta', 'MEMBER', 2],
      ['Test workspace', 'MEMBER', 2],
    ]);
    const bobMe = await ok<{ role: string }>(await req(bob, 'GET', '/auth/me'));
    expect(bobMe.role).toBe('ADMIN');
  });
});

describe('isolation: a member of A only never sees workspace B', () => {
  it('ID-addressed endpoints return 404', async () => {
    const b = await seedB();
    const cases: [Method, string, object?][] = [
      ['GET', `/projects/${b.project.id}`],
      ['PATCH', `/projects/${b.project.id}`, { name: 'x' }],
      ['DELETE', `/projects/${b.project.id}`],
      ['GET', `/projects/${b.project.id}/tasks`],
      ['GET', `/projects/${b.project.id}/report`],
      ['GET', `/projects/${b.project.id}/tasks.csv`],
      ['POST', `/projects/${b.project.id}/members`, { userId: alice.user.id }],
      ['POST', `/projects/${b.project.id}/sections`, { name: 'x' }],
      ['PATCH', `/sections/${b.section.id}`, { name: 'x' }],
      ['DELETE', `/sections/${b.section.id}`],
      ['GET', `/tasks/${b.task.id}`],
      ['PATCH', `/tasks/${b.task.id}`, { title: 'x' }],
      ['DELETE', `/tasks/${b.task.id}`],
      ['GET', `/tasks/${b.personal.id}`],
      ['GET', `/tasks/${b.task.id}/stories`],
      ['POST', `/tasks/${b.task.id}/comments`, { body: 'hi' }],
      ['POST', `/tasks/${b.task.id}/followers`, { userId: alice.user.id }],
      ['PATCH', `/comments/${b.comment.id}`, { body: 'x' }],
      ['DELETE', `/comments/${b.comment.id}`],
      ['GET', `/teams/${b.team.id}`],
      ['PATCH', `/teams/${b.team.id}`, { name: 'x' }],
      ['DELETE', `/teams/${b.team.id}`],
      ['POST', `/teams/${b.team.id}/members`, { userId: alice.user.id }],
      ['GET', `/goals/${b.goal.id}`],
      ['PATCH', `/goals/${b.goal.id}`, { title: 'x' }],
      ['DELETE', `/goals/${b.goal.id}`],
      ['GET', `/goals/${b.goal.id}/updates`],
      ['POST', `/goals/${b.goal.id}/updates`, { status: 'ON_TRACK' }],
      ['POST', `/goals/${b.goal.id}/key-results`, { title: 'x', metricType: 'NUMBER', targetValue: 1 }],
      ['PATCH', `/key-results/${b.kr.id}`, { currentValue: 1 }],
      ['DELETE', `/key-results/${b.kr.id}`],
      ['GET', `/workspaces/${wsB}`],
      ['PATCH', `/workspaces/${wsB}`, { name: 'x' }],
      ['POST', `/workspaces/${wsB}/switch`],
      ['POST', `/workspaces/${wsB}/leave`],
      ['DELETE', `/workspaces/${wsB}`, { confirmName: 'Beta' }],
    ];
    for (const [method, url, payload] of cases) {
      const res = await req(alice, method, url, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    // Admin of A is no admin anywhere else.
    expect((await req(alice, 'GET', '/admin/users', undefined, wsB)).statusCode).toBe(404);
  });

  it('lists, search, reports, goals and notifications are empty of B content', async () => {
    const b = await seedB();
    // A has content of its own, so emptiness isn't vacuous.
    const teamA = await ok(await req(alice, 'POST', '/teams', { name: 'Alpha team' }));
    const projectA = await ok(await req(alice, 'POST', '/projects', { teamId: teamA.id, name: 'Alpha plan', privacy: 'PUBLIC' }));
    await ok(await req(alice, 'POST', '/tasks', { title: 'Alpha task', projectId: projectA.id, assigneeId: carol.user.id }));
    await ok(await req(alice, 'POST', '/goals', { title: 'Alpha goal', timePeriod: '2026', isCompany: true }));

    const names = async (s: Session, url: string, pick: (body: never) => string[], ws?: string) =>
      pick((await ok(await req(s, 'GET', url, undefined, ws))) as never);
    const data = (key: string) => (body: { data: Record<string, unknown>[] }) => body.data.map((r) => String(r[key]));

    expect(await names(alice, '/projects', data('name'))).toEqual(['Alpha plan']);
    expect(await names(alice, '/teams', data('name'))).toEqual(['Alpha team']);
    expect(await names(alice, '/goals', data('title'))).toEqual(['Alpha goal']);
    expect(await names(alice, '/goals/time-periods', (body: { data: string[] }) => body.data)).not.toContain('2031');
    expect(await names(alice, '/users', data('name'))).toEqual(['Alice', 'Carol']);
    const search = await ok<Record<string, { title?: string; name?: string }[]>>(await req(alice, 'GET', '/search?q=Beta'));
    expect(search).toEqual({ tasks: [], projects: [], users: [] });
    const overview = await ok<{ projects: { project: { name: string } }[] }>(await req(alice, 'GET', '/reports/overview'));
    expect(overview.projects.map((p) => p.project.name)).toEqual(['Alpha plan']);
    const workload = await ok<{ data: { user: { name: string } }[] }>(await req(alice, 'GET', '/reports/workload'));
    expect(workload.data.map((r) => r.user.name).sort()).toEqual(['Alice', 'Carol']);
    expect((await req(alice, 'GET', `/reports/workload?teamId=${b.team.id}`)).statusCode).toBe(404);

    // Carol belongs to both: each workspace shows only its own tasks and inbox.
    expect(await names(carol, '/me/tasks', data('title'))).toEqual(['Alpha task']);
    expect(await names(carol, '/me/tasks', data('title'), wsB)).toEqual(['Beta secret task']);
    const inboxA = await ok<{ data: { task: { title: string }; workspaceId: string }[]; unreadCount: number }>(
      await req(carol, 'GET', '/notifications'),
    );
    expect(inboxA.data.map((n) => [n.task.title, n.workspaceId])).toEqual([['Alpha task', wsA]]);
    const inboxB = await ok<{ data: { id: string; type: string; task: { title: string } }[]; unreadCount: number }>(
      await req(carol, 'GET', '/notifications', undefined, wsB),
    );
    // Assigned on create, then (as a follower) told about bob's comment.
    expect(inboxB.data.map((n) => [n.type, n.task.title]).sort()).toEqual([
      ['ASSIGNED', 'Beta secret task'],
      ['COMMENTED', 'Beta secret task'],
    ]);
    // read-all only touches the current workspace; marking by id works from anywhere.
    await req(carol, 'POST', '/notifications/read-all');
    expect((await ok<{ unreadCount: number }>(await req(carol, 'GET', '/notifications', undefined, wsB))).unreadCount).toBe(2);
    expect((await req(carol, 'POST', `/notifications/${inboxB.data[0]!.id}/read`)).statusCode).toBe(204);
    expect((await ok<{ unreadCount: number }>(await req(carol, 'GET', '/notifications', undefined, wsB))).unreadCount).toBe(1);
  });

  it('ID-addressed endpoints ignore the header for members, and responses carry workspaceId', async () => {
    const b = await seedB();
    for (const url of [`/tasks/${b.task.id}`, `/projects/${b.project.id}`, `/teams/${b.team.id}`, `/goals/${b.goal.id}`]) {
      const res = await req(carol, 'GET', url, undefined, wsA);
      expect(res.statusCode, url).toBe(200);
      expect(res.json().workspaceId).toBe(wsB);
    }
  });

  it('personal tasks are created in the current workspace; subtasks in their parent’s', async () => {
    const mine = await ok<{ id: string; workspaceId: string }>(await req(carol, 'POST', '/tasks', { title: 'In B' }, wsB));
    expect(mine.workspaceId).toBe(wsB);
    const sub = await ok<{ workspaceId: string }>(await req(carol, 'POST', '/tasks', { title: 'Sub', parentId: mine.id }, wsA));
    expect(sub.workspaceId).toBe(wsB);
    expect((await ok<{ workspaceId: string }>(await req(carol, 'POST', '/tasks', { title: 'In A' }))).workspaceId).toBe(wsA);
  });

  it('a subtask of a personal task can’t be pulled into a project by a section (even in another workspace)', async () => {
    const team = await ok(await req(alice, 'POST', '/teams', { name: 'Alpha' }));
    const project = await ok<{ sections: { id: string }[] }>(
      await req(alice, 'POST', '/projects', { teamId: team.id, name: 'Alpha plan', privacy: 'PUBLIC' }),
    );
    const personalB = await ok<{ id: string }>(await req(carol, 'POST', '/tasks', { title: 'In B' }, wsB));
    const res = await req(carol, 'POST', '/tasks', { title: 'Sub', parentId: personalB.id, sectionId: project.sections[0]!.id });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details).toEqual([expect.objectContaining({ path: ['sectionId'] })]);
    expect(await prisma.task.count({ where: { parentId: personalB.id } })).toBe(0);
  });
});

describe('no cross-workspace references', () => {
  it('rejects B-only users as assignees, followers, team/project members, goal and KR owners, and mentions', async () => {
    const team = await ok(await req(alice, 'POST', '/teams', { name: 'Alpha' }));
    const project = await ok(await req(alice, 'POST', '/projects', { teamId: team.id, name: 'Alpha', privacy: 'PUBLIC' }));
    const task = await ok(await req(alice, 'POST', '/tasks', { title: 'T', projectId: project.id }));
    const goal = await ok(await req(alice, 'POST', '/goals', { title: 'G', timePeriod: '2026' }));
    const field = async (res: Awaited<ReturnType<typeof req>>) => {
      expect(res.statusCode, res.body).toBe(400);
      return res.json().error.details[0].path[0];
    };
    const bobId = bob.user.id;
    expect(await field(await req(alice, 'POST', '/tasks', { title: 'x', projectId: project.id, assigneeId: bobId }))).toBe('assigneeId');
    expect(await field(await req(alice, 'POST', '/tasks', { title: 'x', assigneeId: bobId }))).toBe('assigneeId');
    expect(await field(await req(alice, 'PATCH', `/tasks/${task.id}`, { assigneeId: bobId }))).toBe('assigneeId');
    expect(await field(await req(alice, 'POST', `/tasks/${task.id}/followers`, { userId: bobId }))).toBe('userId');
    expect(await field(await req(alice, 'POST', `/teams/${team.id}/members`, { userId: bobId }))).toBe('userId');
    expect(await field(await req(alice, 'POST', `/projects/${project.id}/members`, { userId: bobId }))).toBe('userId');
    expect(await field(await req(alice, 'POST', '/goals', { title: 'x', timePeriod: '2026', ownerId: bobId }))).toBe('ownerId');
    expect(await field(await req(alice, 'PATCH', `/goals/${goal.id}`, { ownerId: bobId }))).toBe('ownerId');
    expect(
      await field(await req(alice, 'POST', `/goals/${goal.id}/key-results`, { title: 'k', metricType: 'NUMBER', targetValue: 1, ownerId: bobId })),
    ).toBe('ownerId');
    expect(await field(await req(alice, 'POST', `/tasks/${task.id}/comments`, { body: `hey @[Bob](${bobId})` }))).toBe('body');
    // Mentioning a fellow member still works.
    expect((await req(alice, 'POST', `/tasks/${task.id}/comments`, { body: `hey @[Carol](${carol.user.id})` })).statusCode).toBe(201);
  });

  it('rejects moving a task or goal into another workspace, and linking a goal to a B project (404)', async () => {
    const b = await seedB();
    // Carol can edit both projects (both PUBLIC) and is a member of both workspaces.
    const teamA = await ok(await req(alice, 'POST', '/teams', { name: 'Alpha' }));
    await ok(await req(alice, 'POST', `/teams/${teamA.id}/members`, { userId: carol.user.id }));
    const projectA = await ok(await req(carol, 'POST', '/projects', { teamId: teamA.id, name: 'Alpha', privacy: 'PUBLIC' }));
    const taskA = await ok(await req(carol, 'POST', '/tasks', { title: 'T', projectId: projectA.id }));
    const moved = await req(carol, 'PATCH', `/tasks/${taskA.id}`, { projectId: b.project.id });
    expect(moved.statusCode).toBe(400);
    expect(moved.json().error.details[0].path).toEqual(['projectId']);
    // A project from another workspace in POST /projects' teamId is simply not found.
    expect((await req(carol, 'POST', '/projects', { teamId: b.team.id, name: 'x' })).statusCode).toBe(404);

    const goalA = await ok(await req(carol, 'POST', '/goals', { title: 'G', timePeriod: '2026' }));
    const parent = await req(carol, 'PATCH', `/goals/${goalA.id}`, { parentId: b.goal.id });
    expect(parent.statusCode).toBe(400);
    expect(parent.json().error.details[0].path).toEqual(['parentId']);
    expect((await req(carol, 'POST', '/goals', { title: 'x', timePeriod: '2026', parentId: b.goal.id })).statusCode).toBe(400);
    expect((await req(carol, 'POST', `/goals/${goalA.id}/projects`, { projectId: b.project.id })).statusCode).toBe(404);
  });
});

describe('/workspaces', () => {
  it('creates a workspace (caller ADMIN, becomes current) and lists mine by name', async () => {
    const res = await req(carol, 'POST', '/workspaces', { name: 'Aardvark', color: '#123456' });
    expect(res.statusCode).toBe(201);
    const created = res.json();
    expect(created).toEqual({
      id: expect.any(String),
      name: 'Aardvark',
      isOrganization: false,
      domain: null,
      color: '#123456',
      myRole: 'ADMIN',
      memberCount: 1,
      createdAt: expect.any(String),
    });
    expect((await ok<{ currentWorkspace: { id: string } }>(await req(carol, 'GET', '/auth/me'))).currentWorkspace.id).toBe(created.id);
    const list = await ok<{ data: { name: string }[] }>(await req(carol, 'GET', '/workspaces'));
    expect(list.data.map((w) => w.name)).toEqual(['Aardvark', 'Beta', 'Test workspace']);
    expect((await req(carol, 'POST', '/workspaces', { name: '' })).statusCode).toBe(400);
  });

  it('PATCH is admin-only; switch sets the current workspace', async () => {
    expect((await req(carol, 'PATCH', `/workspaces/${wsA}`, { name: 'Renamed' })).statusCode).toBe(403);
    expect(await ok(await req(alice, 'PATCH', `/workspaces/${wsA}`, { name: 'Renamed', color: '#abcdef' }))).toMatchObject({
      name: 'Renamed',
      color: '#abcdef',
      myRole: 'ADMIN',
    });
    expect(await ok(await req(carol, 'POST', `/workspaces/${wsB}/switch`))).toMatchObject({ id: wsB, myRole: 'MEMBER' });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: carol.user.id } })).lastWorkspaceId).toBe(wsB);
    expect((await ok<{ currentWorkspace: { id: string } }>(await req(carol, 'GET', '/auth/me'))).currentWorkspace.id).toBe(wsB);
  });

  it('DELETE needs the exact name and an admin, and removes everything in it', async () => {
    const b = await seedB();
    expect((await req(carol, 'DELETE', `/workspaces/${wsB}`, { confirmName: 'Beta' })).statusCode).toBe(403);
    expect((await req(bob, 'DELETE', `/workspaces/${wsB}`, { confirmName: 'beta' })).statusCode).toBe(400);
    expect((await req(bob, 'DELETE', `/workspaces/${wsB}`, { confirmName: 'Beta' })).statusCode).toBe(204);
    expect(await prisma.workspace.findUnique({ where: { id: wsB } })).toBeNull();
    for (const count of [
      prisma.team.count({ where: { id: b.team.id } }),
      prisma.project.count({ where: { id: b.project.id } }),
      prisma.task.count({ where: { id: { in: [b.task.id, b.personal.id] } } }),
      prisma.goal.count({ where: { id: b.goal.id } }),
      prisma.notification.count({ where: { workspaceId: wsB } }),
      prisma.workspaceMember.count({ where: { workspaceId: wsB } }),
    ]) {
      expect(await count).toBe(0);
    }
    // Users survive; Bob had only B, so he now has no workspace.
    expect((await req(bob, 'GET', '/projects')).statusCode).toBe(403);
    expect((await ok<{ currentWorkspace: null }>(await req(bob, 'GET', '/auth/me'))).currentWorkspace).toBeNull();
    // A is untouched.
    expect((await req(carol, 'GET', '/projects')).statusCode).toBe(200);
  });

  it('leave: the last active admin gets 409; others are cleaned up and their sole-owned projects pass on', async () => {
    expect((await req(alice, 'POST', `/workspaces/${wsA}/leave`)).statusCode).toBe(409);

    const team = await ok(await req(alice, 'POST', '/teams', { name: 'Alpha' }));
    await ok(await req(alice, 'POST', `/teams/${team.id}/members`, { userId: carol.user.id }));
    const project = await ok(await req(carol, 'POST', '/projects', { teamId: team.id, name: 'Carol’s', privacy: 'PRIVATE' }));
    const task = await ok(await req(carol, 'POST', '/tasks', { title: 'Mine', projectId: project.id, assigneeId: carol.user.id }));

    expect((await req(carol, 'POST', `/workspaces/${wsA}/leave`)).statusCode).toBe(204);
    expect(await prisma.workspaceMember.count({ where: { workspaceId: wsA, userId: carol.user.id } })).toBe(0);
    expect(await prisma.teamMember.count({ where: { userId: carol.user.id } })).toBe(0);
    const after = await prisma.project.findUniqueOrThrow({ where: { id: project.id }, include: { members: true } });
    expect(after.ownerId).toBe(alice.user.id);
    expect(after.members).toEqual([expect.objectContaining({ userId: alice.user.id, role: 'OWNER' })]);
    // Tasks keep their assignee; Carol's current workspace falls back to B.
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).assigneeId).toBe(carol.user.id);
    expect((await ok<{ currentWorkspace: { id: string } }>(await req(carol, 'GET', '/auth/me'))).currentWorkspace.id).toBe(wsB);
    expect((await req(carol, 'GET', `/projects/${project.id}`)).statusCode).toBe(404);

    // With a second admin, the first may leave.
    await prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId: wsB, userId: carol.user.id } }, data: { role: 'ADMIN' } });
    expect((await req(bob, 'POST', `/workspaces/${wsB}/leave`)).statusCode).toBe(204);
  });
});

describe('/admin/* in the current workspace', () => {
  it('lists the current workspace’s members incl. deactivated ones; non-admins get 403', async () => {
    await prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId: wsA, userId: carol.user.id } }, data: { isActive: false } });
    const list = await ok<{ data: { name: string; role: string; isActive: boolean }[] }>(await req(alice, 'GET', '/admin/users'));
    expect(list.data.map((u) => [u.name, u.role, u.isActive])).toEqual([
      ['Alice', 'ADMIN', true],
      ['Carol', 'MEMBER', false],
    ]);
    expect((await req(carol, 'GET', '/admin/users', undefined, wsB)).statusCode).toBe(403);
    expect((await req(alice, 'PATCH', `/admin/users/${bob.user.id}`, { role: 'MEMBER' })).statusCode).toBe(404);
  });

  it('deactivation removes team and project memberships, passes sole-owned projects to the acting admin, and blocks access', async () => {
    const team = await ok(await req(alice, 'POST', '/teams', { name: 'Alpha' }));
    await ok(await req(alice, 'POST', `/teams/${team.id}/members`, { userId: carol.user.id }));
    const project = await ok(await req(carol, 'POST', '/projects', { teamId: team.id, name: 'Carol’s', privacy: 'PRIVATE' }));
    const task = await ok(await req(carol, 'POST', '/tasks', { title: 'Mine', projectId: project.id, assigneeId: carol.user.id }));

    expect(await ok(await req(alice, 'PATCH', `/admin/users/${carol.user.id}`, { isActive: false }))).toMatchObject({ isActive: false });
    expect(await prisma.teamMember.count({ where: { userId: carol.user.id } })).toBe(0);
    const after = await prisma.project.findUniqueOrThrow({ where: { id: project.id }, include: { members: true } });
    expect(after.ownerId).toBe(alice.user.id);
    expect(after.members).toEqual([expect.objectContaining({ userId: alice.user.id, role: 'OWNER' })]);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).assigneeId).toBe(carol.user.id);

    // Hidden from pickers; locked out of A (header 404, ID-addressed 404) but B still works.
    expect((await ok<{ data: { name: string }[] }>(await req(alice, 'GET', '/users'))).data.map((u) => u.name)).toEqual(['Alice']);
    expect((await req(carol, 'GET', '/projects', undefined, wsA)).statusCode).toBe(404);
    expect((await req(carol, 'GET', `/tasks/${task.id}`)).statusCode).toBe(404);
    expect((await ok<{ currentWorkspace: { id: string } }>(await req(carol, 'GET', '/auth/me'))).currentWorkspace.id).toBe(wsB);
    expect(await login(ctx.app, (await prisma.user.findUniqueOrThrow({ where: { id: carol.user.id } })).email)).toMatch(/^sid=/);

    // Re-activation restores access, not the old memberships.
    await ok(await req(alice, 'PATCH', `/admin/users/${carol.user.id}`, { isActive: true }));
    expect((await req(carol, 'GET', '/projects', undefined, wsA)).statusCode).toBe(200);
    expect(await prisma.teamMember.count({ where: { userId: carol.user.id } })).toBe(0);
  });

  it('an admin deactivating themselves hands sole-owned projects to the senior other admin, not back to themselves', async () => {
    await ok(await req(alice, 'PATCH', `/admin/users/${carol.user.id}`, { role: 'ADMIN' }));
    const team = await ok(await req(alice, 'POST', '/teams', { name: 'Alpha' }));
    const project = await ok<{ id: string }>(await req(alice, 'POST', '/projects', { teamId: team.id, name: 'Alice’s', privacy: 'PRIVATE' }));

    expect(await ok(await req(alice, 'PATCH', `/admin/users/${alice.user.id}`, { isActive: false }))).toMatchObject({ isActive: false });
    const after = await prisma.project.findUniqueOrThrow({ where: { id: project.id }, include: { members: true } });
    expect(after.ownerId).toBe(carol.user.id);
    expect(after.members).toEqual([expect.objectContaining({ userId: carol.user.id, role: 'OWNER' })]);
  });

  it('re-activating a globally deactivated user edits the membership but does not let them log in', async () => {
    // e.g. deactivated before v1.2: the migration keeps User.isActive=false next to an inactive membership.
    const gone = await createUser({ name: 'Gone', email: 'gone@example.com', workspaceId: wsA, isActive: false, memberActive: false });
    expect(await ok(await req(alice, 'PATCH', `/admin/users/${gone.id}`, { isActive: true }))).toMatchObject({ isActive: true });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'gone@example.com', password: PASSWORD },
    });
    expect(res.statusCode).toBe(401);
  });

  it('invites carry the workspace; active members get 409, people from other workspaces can be invited', async () => {
    const carolEmail = (await prisma.user.findUniqueOrThrow({ where: { id: carol.user.id } })).email;
    const bobEmail = (await prisma.user.findUniqueOrThrow({ where: { id: bob.user.id } })).email;
    expect((await req(alice, 'POST', '/admin/invites', { email: carolEmail })).statusCode).toBe(409);
    const invite = await ok<{ workspaceId: string }>(await req(alice, 'POST', '/admin/invites', { email: bobEmail }));
    expect(invite.workspaceId).toBe(wsA);
    // Each workspace sees only its own invites.
    expect((await ok<{ data: unknown[] }>(await req(alice, 'GET', '/admin/invites'))).data).toHaveLength(1);
    expect((await ok<{ data: unknown[] }>(await req(bob, 'GET', '/admin/invites'))).data).toHaveLength(0);
  });

  it('accept-invite makes the invited workspace the new user’s current one', async () => {
    const invite = await ok<{ token: string }>(await req(bob, 'POST', '/admin/invites', { email: 'new@example.com' }));
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/accept-invite',
      payload: { token: invite.token, name: 'Newbie', password: 'password123' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      email: 'new@example.com',
      role: 'MEMBER',
      currentWorkspace: { id: wsB, name: 'Beta', myRole: 'MEMBER' },
      workspaces: [expect.objectContaining({ id: wsB })],
    });
  });

  it('GET /users/:id only finds members of the current workspace', async () => {
    expect((await req(alice, 'GET', `/users/${bob.user.id}`)).statusCode).toBe(404);
    expect(await ok(await req(carol, 'GET', `/users/${bob.user.id}`, undefined, wsB))).toMatchObject({ role: 'ADMIN', isActive: true });
    await createUser({ name: 'Zed' });
  });
});
