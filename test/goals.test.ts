import { beforeEach, describe, expect, it } from 'vitest';
import type { User } from '@prisma/client';
import { currentPeriods } from '../src/lib/time.js';
import { prisma, setupApp, signedIn } from './helpers.js';

const ctx = setupApp();

type Session = { user: User; cookie: string };
let admin: Session;
let alice: Session; // Engineering member
let bob: Session; // Engineering member
let carol: Session; // not in Engineering
let engId: string;

beforeEach(async () => {
  admin = await signedIn(ctx.app, { name: 'Admin', role: 'ADMIN' });
  alice = await signedIn(ctx.app, { name: 'Alice' });
  bob = await signedIn(ctx.app, { name: 'Bob' });
  carol = await signedIn(ctx.app, { name: 'Carol' });
  const eng = await prisma.team.create({
    data: { name: 'Engineering', members: { create: [{ userId: alice.user.id }, { userId: bob.user.id }] } },
  });
  engId = eng.id;
});

function req(s: Session, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) {
  return ctx.app.inject({ method, url: `/api/v1${url}`, headers: { cookie: s.cookie }, payload });
}

async function createGoal(s: Session, body: object) {
  const res = await req(s, 'POST', '/goals', { title: 'Goal', timePeriod: '2026-Q4', ...body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function addKr(s: Session, goalId: string, body: object) {
  const res = await req(s, 'POST', `/goals/${goalId}/key-results`, { title: 'KR', metricType: 'NUMBER', ...body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

describe('create and levels', () => {
  it('creates a personal goal owned by the caller and returns GoalDetail', async () => {
    const g = await createGoal(carol, { title: 'Learn Go', description: 'Basics' });
    expect(g).toEqual({
      id: expect.any(String),
      title: 'Learn Go',
      description: 'Basics',
      owner: expect.objectContaining({ id: carol.user.id, name: 'Carol' }),
      team: null,
      isCompany: false,
      parentId: null,
      timePeriod: '2026-Q4',
      status: 'NO_STATUS',
      progressSource: 'KEY_RESULTS',
      progress: 0,
      weight: 1,
      keyResultCount: 0,
      childCount: 0,
      canEdit: true,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      parent: null,
      keyResults: [],
      children: [],
      projects: [],
      hiddenProjectCount: 0,
      latestUpdate: null,
    });
  });

  it('company goals are admin-only; team goals need team membership', async () => {
    expect((await req(alice, 'POST', '/goals', { title: 'Co', timePeriod: '2026', isCompany: true })).statusCode).toBe(403);
    const co = await createGoal(admin, { title: 'Co', timePeriod: '2026', isCompany: true });
    expect(co).toMatchObject({ isCompany: true, team: null });

    const team = await createGoal(alice, { title: 'Eng goal', teamId: engId });
    expect(team.team).toEqual({ id: engId, name: 'Engineering' });
    expect((await req(carol, 'POST', '/goals', { title: 'x', timePeriod: '2026', teamId: engId })).statusCode).toBe(403);
    expect((await req(alice, 'POST', '/goals', { title: 'x', timePeriod: '2026', teamId: '00000000-0000-0000-0000-000000000000' })).statusCode).toBe(403);
    expect((await req(admin, 'POST', '/goals', { title: 'x', timePeriod: '2026', teamId: '00000000-0000-0000-0000-000000000000' })).statusCode).toBe(404);
  });

  it('rejects isCompany together with teamId, bad periods and inactive owners', async () => {
    const both = await req(admin, 'POST', '/goals', { title: 'x', timePeriod: '2026', isCompany: true, teamId: engId });
    expect(both.statusCode).toBe(400);
    expect(both.json().error.details[0].path).toEqual(['isCompany']);
    for (const timePeriod of ['26', '2026-Q5', '2026-H3', '2026Q1', '2026-q1']) {
      expect((await req(alice, 'POST', '/goals', { title: 'x', timePeriod })).statusCode).toBe(400);
    }
    await prisma.user.update({ where: { id: bob.user.id }, data: { isActive: false } });
    const inactive = await req(alice, 'POST', '/goals', { title: 'x', timePeriod: '2026', ownerId: bob.user.id });
    expect(inactive.statusCode).toBe(400);
    expect(inactive.json().error.details[0].path).toEqual(['ownerId']);
  });
});

describe('edit permissions per level', () => {
  it('personal goal: owner or admin', async () => {
    const g = await createGoal(carol, {});
    expect((await req(alice, 'PATCH', `/goals/${g.id}`, { title: 'x' })).statusCode).toBe(403);
    expect((await req(alice, 'GET', `/goals/${g.id}`)).json().canEdit).toBe(false);
    expect((await req(carol, 'PATCH', `/goals/${g.id}`, { title: 'Mine' })).json().title).toBe('Mine');
    expect((await req(admin, 'PATCH', `/goals/${g.id}`, { title: 'Admin' })).json().canEdit).toBe(true);
  });

  it('team goal: any member of the team, not outsiders', async () => {
    const g = await createGoal(alice, { teamId: engId });
    expect((await req(bob, 'PATCH', `/goals/${g.id}`, { status: 'AT_RISK' })).json()).toMatchObject({ status: 'AT_RISK', canEdit: true });
    expect((await req(carol, 'PATCH', `/goals/${g.id}`, { title: 'x' })).statusCode).toBe(403);
    expect((await req(carol, 'DELETE', `/goals/${g.id}`)).statusCode).toBe(403);
    expect((await req(bob, 'POST', `/goals/${g.id}/key-results`, { title: 'k', metricType: 'NUMBER', targetValue: 1 })).statusCode).toBe(201);
  });

  it('company goal: its owner or admins', async () => {
    const g = await createGoal(admin, { isCompany: true, ownerId: alice.user.id });
    expect((await req(alice, 'PATCH', `/goals/${g.id}`, { title: 'Owner edit' })).statusCode).toBe(200);
    expect((await req(bob, 'PATCH', `/goals/${g.id}`, { title: 'x' })).statusCode).toBe(403);
  });

  it('changing level needs create rights at the new level', async () => {
    const g = await createGoal(alice, { teamId: engId });
    // Promote to company: admin only.
    expect((await req(alice, 'PATCH', `/goals/${g.id}`, { isCompany: true, teamId: null })).statusCode).toBe(403);
    // isCompany alone while the goal still has a team: both set → 400.
    expect((await req(admin, 'PATCH', `/goals/${g.id}`, { isCompany: true })).statusCode).toBe(400);
    const promoted = await req(admin, 'PATCH', `/goals/${g.id}`, { isCompany: true, teamId: null });
    expect(promoted.json()).toMatchObject({ isCompany: true, team: null });

    const personal = await createGoal(carol, {});
    expect((await req(carol, 'PATCH', `/goals/${personal.id}`, { teamId: engId })).statusCode).toBe(403);
  });

  it('everyone sees every goal', async () => {
    const g = await createGoal(admin, { isCompany: true });
    const list = (await req(carol, 'GET', '/goals')).json().data;
    expect(list.map((x: { id: string }) => x.id)).toEqual([g.id]);
    expect((await req(carol, 'GET', `/goals/${g.id}`)).statusCode).toBe(200);
  });
});

describe('cascade (parentId)', () => {
  it('links children, rejects self/cyclic parents and deep chains', async () => {
    const a = await createGoal(admin, { title: 'A', isCompany: true, progressSource: 'SUB_GOALS' });
    const b = await createGoal(alice, { title: 'B', teamId: engId, parentId: a.id });
    const c = await createGoal(alice, { title: 'C', parentId: b.id });

    const detail = (await req(alice, 'GET', `/goals/${a.id}`)).json();
    expect(detail.childCount).toBe(1);
    expect(detail.children.map((g: { title: string }) => g.title)).toEqual(['B']);
    expect((await req(alice, 'GET', `/goals/${c.id}`)).json().parent).toEqual({ id: b.id, title: 'B' });

    const self = await req(alice, 'PATCH', `/goals/${b.id}`, { parentId: b.id });
    expect(self.statusCode).toBe(400);
    expect(self.json().error.details[0].path).toEqual(['parentId']);
    expect((await req(admin, 'PATCH', `/goals/${a.id}`, { parentId: c.id })).statusCode).toBe(400);
    expect((await req(alice, 'POST', '/goals', { title: 'x', timePeriod: '2026', parentId: '00000000-0000-0000-0000-000000000000' })).statusCode).toBe(400);

    // Chain to 6 levels: A > B > C > D > E > F works, a 7th level doesn't.
    let parentId = c.id;
    for (const title of ['D', 'E', 'F']) parentId = (await createGoal(alice, { title, parentId })).id;
    const tooDeep = await req(alice, 'POST', '/goals', { title: 'G', timePeriod: '2026', parentId });
    expect(tooDeep.statusCode).toBe(400);
    expect(tooDeep.json().error.message).toMatch(/at most 6/);
  });

  it('deleting a goal detaches children and removes KRs, links and updates', async () => {
    const parent = await createGoal(alice, { title: 'P' });
    const child = await createGoal(alice, { title: 'C', parentId: parent.id });
    await addKr(alice, parent.id, { targetValue: 10 });
    await req(alice, 'POST', `/goals/${parent.id}/updates`, { status: 'ON_TRACK' });
    expect((await req(alice, 'DELETE', `/goals/${parent.id}`)).statusCode).toBe(204);
    expect((await prisma.goal.findUniqueOrThrow({ where: { id: child.id } })).parentId).toBeNull();
    expect(await prisma.keyResult.count()).toBe(0);
    expect(await prisma.goalUpdate.count()).toBe(0);
    expect((await req(alice, 'GET', `/goals/${parent.id}`)).statusCode).toBe(404);
  });
});

describe('progress', () => {
  it('KEY_RESULTS: mean of KR progress, including decreasing KRs', async () => {
    const g = await createGoal(alice, {});
    await addKr(alice, g.id, { startValue: 0, targetValue: 200, currentValue: 50 }); // 25
    const dec = await addKr(alice, g.id, { title: 'Crash rate', metricType: 'PERCENT', startValue: 2.5, targetValue: 0.5, currentValue: 1.2, unit: '%' });
    expect(dec).toMatchObject({ progress: 65, unit: '%', position: 2000, owner: null });
    expect((await req(alice, 'GET', `/goals/${g.id}`)).json()).toMatchObject({ progress: 45, keyResultCount: 2 });
  });

  it('SUB_GOALS: weighted average of children, recursively; MANUAL uses manualProgress', async () => {
    const top = await createGoal(admin, { isCompany: true, progressSource: 'SUB_GOALS' });
    const mid = await createGoal(alice, { teamId: engId, parentId: top.id, progressSource: 'SUB_GOALS', weight: 3 });
    const leaf1 = await createGoal(alice, { parentId: mid.id, progressSource: 'MANUAL' });
    const leaf2 = await createGoal(bob, { parentId: mid.id });
    await createGoal(carol, { parentId: top.id, progressSource: 'MANUAL', weight: 1 }); // 0%

    await req(alice, 'PATCH', `/goals/${leaf1.id}`, { manualProgress: 80 });
    await addKr(bob, leaf2.id, { targetValue: 10, currentValue: 5 }); // 50
    // mid = 65, top = (3×65 + 1×0) / 4 = 48.75 → 48.8
    const list = (await req(carol, 'GET', '/goals')).json().data;
    const byId = Object.fromEntries(list.map((g: { id: string; progress: number }) => [g.id, g.progress]));
    expect(byId[mid.id]).toBe(65);
    expect(byId[top.id]).toBe(48.8);
    expect((await req(alice, 'PATCH', `/goals/${leaf1.id}`, { manualProgress: 101 })).statusCode).toBe(400);
  });

  it('PROJECTS: all tasks incl. subtasks of linked projects; hidden projects still count', async () => {
    const pub = await prisma.project.create({ data: { teamId: engId, ownerId: alice.user.id, name: 'Public', color: '#000000', privacy: 'PUBLIC' } });
    const secret = await prisma.project.create({
      data: { teamId: engId, ownerId: alice.user.id, name: 'Secret', color: '#000000', privacy: 'PRIVATE', members: { create: { userId: alice.user.id, role: 'OWNER' } } },
    });
    const parent = await prisma.task.create({ data: { projectId: pub.id, title: 'P', creatorId: alice.user.id, completed: true } });
    await prisma.task.create({ data: { projectId: pub.id, parentId: parent.id, title: 'S', creatorId: alice.user.id } });
    await prisma.task.create({ data: { projectId: secret.id, title: 'X', creatorId: alice.user.id, completed: true } });
    await prisma.task.create({ data: { projectId: secret.id, title: 'Y', creatorId: alice.user.id } });

    const g = await createGoal(alice, { progressSource: 'PROJECTS' });
    await req(alice, 'POST', `/goals/${g.id}/projects`, { projectId: pub.id });
    const linked = (await req(alice, 'POST', `/goals/${g.id}/projects`, { projectId: secret.id })).json();
    expect(linked.progress).toBe(50);
    expect(linked.projects).toHaveLength(2);

    // Carol can't see Secret: it's hidden but still counts.
    const asCarol = (await req(carol, 'GET', `/goals/${g.id}`)).json();
    expect(asCarol).toMatchObject({ progress: 50, hiddenProjectCount: 1 });
    expect(asCarol.projects).toEqual([{ project: { id: pub.id, name: 'Public', color: '#000000' }, total: 2, completed: 1 }]);

    // Carol can't link a project she can't see (404); unlinking works for editors.
    const mine = await createGoal(carol, { progressSource: 'PROJECTS' });
    expect((await req(carol, 'POST', `/goals/${mine.id}/projects`, { projectId: secret.id })).statusCode).toBe(404);
    const unlinked = (await req(alice, 'DELETE', `/goals/${g.id}/projects/${secret.id}`)).json();
    expect(unlinked).toMatchObject({ progress: 50, hiddenProjectCount: 0 });
    expect(unlinked.projects).toHaveLength(1);
  });
});

describe('key results', () => {
  it('normalises BOOLEAN KRs to 0 → 1 and validates current values', async () => {
    const g = await createGoal(alice, {});
    const kr = await addKr(alice, g.id, { metricType: 'BOOLEAN', startValue: 5, targetValue: 9 });
    expect(kr).toMatchObject({ startValue: 0, targetValue: 1, currentValue: 0, progress: 0 });
    expect((await req(alice, 'PATCH', `/key-results/${kr.id}`, { currentValue: 1 })).json().progress).toBe(100);
    expect((await req(alice, 'PATCH', `/key-results/${kr.id}`, { currentValue: 0.5 })).statusCode).toBe(400);
    expect((await req(alice, 'POST', `/goals/${g.id}/key-results`, { title: 'b', metricType: 'BOOLEAN', targetValue: 1, currentValue: 2 })).statusCode).toBe(400);
  });

  it('lets the KR owner update only currentValue', async () => {
    const g = await createGoal(alice, {});
    const kr = await addKr(alice, g.id, { targetValue: 100, ownerId: carol.user.id });
    expect(kr.owner.id).toBe(carol.user.id);
    expect((await req(carol, 'PATCH', `/key-results/${kr.id}`, { currentValue: 40 })).json().progress).toBe(40);
    expect((await req(carol, 'PATCH', `/key-results/${kr.id}`, { currentValue: 50, targetValue: 50 })).statusCode).toBe(403);
    expect((await req(carol, 'DELETE', `/key-results/${kr.id}`)).statusCode).toBe(403);
    expect((await req(bob, 'PATCH', `/key-results/${kr.id}`, { currentValue: 1 })).statusCode).toBe(403);
    expect((await req(alice, 'DELETE', `/key-results/${kr.id}`)).statusCode).toBe(204);
  });

  it('lists KRs by position', async () => {
    const g = await createGoal(alice, {});
    await addKr(alice, g.id, { title: 'second', targetValue: 1 });
    await addKr(alice, g.id, { title: 'first', targetValue: 1, position: 1 });
    const detail = (await req(alice, 'GET', `/goals/${g.id}`)).json();
    expect(detail.keyResults.map((k: { title: string }) => k.title)).toEqual(['first', 'second']);
  });
});

describe('status updates', () => {
  it('sets the goal status, snapshots progress and lists newest first', async () => {
    const g = await createGoal(alice, {});
    await addKr(alice, g.id, { targetValue: 4, currentValue: 1 });
    const first = await req(alice, 'POST', `/goals/${g.id}/updates`, { status: 'ON_TRACK', body: 'Good start' });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ goalId: g.id, status: 'ON_TRACK', progress: 25, body: 'Good start', author: { id: alice.user.id } });
    await req(alice, 'POST', `/goals/${g.id}/updates`, { status: 'AT_RISK' });

    const detail = (await req(bob, 'GET', `/goals/${g.id}`)).json();
    expect(detail.status).toBe('AT_RISK');
    expect(detail.latestUpdate).toMatchObject({ status: 'AT_RISK', body: null });
    const list = (await req(bob, 'GET', `/goals/${g.id}/updates`)).json().data;
    expect(list.map((u: { status: string }) => u.status)).toEqual(['AT_RISK', 'ON_TRACK']);
  });

  it('allows editors and KR owners, nobody else', async () => {
    const g = await createGoal(alice, {});
    expect((await req(bob, 'POST', `/goals/${g.id}/updates`, { status: 'ON_TRACK' })).statusCode).toBe(403);
    await addKr(alice, g.id, { targetValue: 1, ownerId: bob.user.id });
    expect((await req(bob, 'POST', `/goals/${g.id}/updates`, { status: 'OFF_TRACK' })).statusCode).toBe(201);
    expect((await req(bob, 'POST', `/goals/${g.id}/updates`, { status: 'DONE' })).statusCode).toBe(400);
  });
});

describe('listing', () => {
  it('filters by timePeriod, teamId, ownerId, company and q', async () => {
    const co = await createGoal(admin, { title: 'Grow revenue', isCompany: true, timePeriod: '2026' });
    const team = await createGoal(alice, { title: 'Ship app', teamId: engId });
    const mine = await createGoal(bob, { title: 'Grow skills', timePeriod: '2026-Q3' });
    const ids = async (qs: string) => (await req(carol, 'GET', `/goals${qs}`)).json().data.map((g: { id: string }) => g.id);
    expect(await ids('')).toEqual([co.id, team.id, mine.id]);
    expect(await ids('?timePeriod=2026-Q4')).toEqual([team.id]);
    expect(await ids(`?teamId=${engId}`)).toEqual([team.id]);
    expect(await ids(`?ownerId=${bob.user.id}`)).toEqual([mine.id]);
    expect(await ids('?company=true')).toEqual([co.id]);
    expect(await ids('?q=GROW')).toEqual([co.id, mine.id]);
  });

  it('lists time periods in use plus the current year, half and quarter', async () => {
    await createGoal(alice, { timePeriod: '2024-Q2' });
    const periods = (await req(alice, 'GET', '/goals/time-periods')).json().data;
    const current = currentPeriods('Asia/Jakarta');
    expect(periods).toEqual(expect.arrayContaining([...current, '2024-Q2']));
    expect(periods.at(-1)).toBe('2024-Q2');
    expect(new Set(periods).size).toBe(periods.length);
  });

  it('blocks deleting a team that still has goals', async () => {
    const g = await createGoal(alice, { teamId: engId });
    expect((await req(admin, 'DELETE', `/teams/${engId}`)).statusCode).toBe(409);
    await req(alice, 'DELETE', `/goals/${g.id}`);
    expect((await req(admin, 'DELETE', `/teams/${engId}`)).statusCode).toBe(204);
  });
});
