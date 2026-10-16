import { beforeEach, describe, expect, it } from 'vitest';
import type { User } from '@prisma/client';
import { prisma, setupApp, signedIn } from './helpers.js';

const ctx = setupApp();

type Session = { user: User; cookie: string };
let alice: Session; // team member, project owner
let bob: Session; // team member
let outsider: Session; // not in the team
let teamId: string;
let project: { id: string; sections: { id: string; name: string }[] };

beforeEach(async () => {
  alice = await signedIn(ctx.app, { name: 'Alice' });
  bob = await signedIn(ctx.app, { name: 'Bob' });
  outsider = await signedIn(ctx.app, { name: 'Outsider' });
  const team = await prisma.team.create({
    data: { name: 'Eng', members: { create: [{ userId: alice.user.id }, { userId: bob.user.id }] } },
  });
  teamId = team.id;
  project = await createProject();
});

async function createProject(body: object = {}, s: Session = alice) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    headers: { cookie: s.cookie },
    payload: { teamId, name: 'Website', ...body },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

function req(s: Session, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) {
  return ctx.app.inject({ method, url: `/api/v1${url}`, headers: { cookie: s.cookie }, payload });
}

async function createTask(body: object, s: Session = alice) {
  const res = await req(s, 'POST', '/tasks', body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

const activityTypes = async (taskId: string) =>
  (await prisma.activity.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } })).map((a) => a.type);

describe('POST /tasks', () => {
  it('creates a task and returns TaskDetail; the creator follows it', async () => {
    const t = await createTask({
      title: 'Write copy',
      projectId: project.id,
      sectionId: project.sections[0]!.id,
      description: '**bold**',
      dueDate: '2026-11-01',
      startDate: '2026-10-20',
      priority: 'HIGH',
    });
    expect(t).toEqual({
      id: expect.any(String),
      projectId: project.id,
      sectionId: project.sections[0]!.id,
      parentId: null,
      title: 'Write copy',
      description: '**bold**',
      assignee: null,
      creator: { id: alice.user.id, name: 'Alice', email: alice.user.email, avatarColor: '#4186e0' },
      dueDate: '2026-11-01',
      startDate: '2026-10-20',
      priority: 'HIGH',
      completed: false,
      completedAt: null,
      position: 1000,
      subtaskCount: 0,
      completedSubtaskCount: 0,
      commentCount: 0,
      project: { id: project.id, name: 'Website', color: '#4186e0' },
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      followers: [expect.objectContaining({ id: alice.user.id })],
      subtasks: [],
      parent: null,
    });
    expect(await activityTypes(t.id)).toEqual(['CREATED']);
  });

  it('appends positions per section and infers the project from sectionId', async () => {
    const sectionId = project.sections[1]!.id;
    const a = await createTask({ title: 'A', sectionId });
    const b = await createTask({ title: 'B', sectionId });
    expect([a.projectId, a.position, b.position]).toEqual([project.id, 1000, 2000]);
    const explicit = await createTask({ title: 'C', sectionId, position: 1500 });
    expect(explicit.position).toBe(1500);
  });

  it('rejects a section from another project', async () => {
    const other = await createProject({ name: 'Other' });
    const res = await req(alice, 'POST', '/tasks', { title: 'x', projectId: project.id, sectionId: other.sections[0].id });
    expect(res.statusCode).toBe(400);
  });

  it('assigning someone else makes them follow and notifies them; self-assignment does not notify', async () => {
    const t = await createTask({ title: 'For Bob', projectId: project.id, assigneeId: bob.user.id });
    expect(t.assignee.id).toBe(bob.user.id);
    expect(t.followers.map((f: { id: string }) => f.id).sort()).toEqual([alice.user.id, bob.user.id].sort());
    expect(await prisma.notification.findMany({ where: { userId: bob.user.id } })).toEqual([
      expect.objectContaining({ type: 'ASSIGNED', actorId: alice.user.id, taskId: t.id, read: false }),
    ]);
    expect(await activityTypes(t.id)).toEqual(['CREATED', 'ASSIGNED']);

    await createTask({ title: 'Mine', projectId: project.id, assigneeId: alice.user.id });
    expect(await prisma.notification.count({ where: { userId: alice.user.id } })).toBe(0);
  });

  it('rejects unknown or inactive assignees', async () => {
    const res = await req(alice, 'POST', '/tasks', {
      title: 'x',
      projectId: project.id,
      assigneeId: '00000000-0000-0000-0000-000000000000',
    });
    expect(res.statusCode).toBe(404);
  });

  it('validates dates and priority', async () => {
    for (const payload of [
      { title: 'x', dueDate: '01/11/2026' },
      { title: 'x', priority: 'URGENT' },
      { title: '' },
    ]) {
      expect((await req(alice, 'POST', '/tasks', payload)).statusCode).toBe(400);
    }
  });

  it('enforces project permissions: 404 when invisible, 403 for commenters', async () => {
    expect((await req(outsider, 'POST', '/tasks', { title: 'x', projectId: project.id })).statusCode).toBe(404);
    await prisma.projectMember.create({ data: { projectId: project.id, userId: outsider.user.id, role: 'COMMENTER' } });
    expect((await req(outsider, 'POST', '/tasks', { title: 'x', projectId: project.id })).statusCode).toBe(403);
  });
});

describe('subtasks', () => {
  it('inherit the parent’s project and show up in counts and detail', async () => {
    const parent = await createTask({ title: 'Parent', projectId: project.id, sectionId: project.sections[0]!.id });
    const s1 = await createTask({ title: 'Sub 1', parentId: parent.id });
    const s2 = await createTask({ title: 'Sub 2', parentId: parent.id });
    expect(s1).toMatchObject({ projectId: project.id, parentId: parent.id, parent: { id: parent.id, title: 'Parent' } });

    await req(alice, 'PATCH', `/tasks/${s2.id}`, { completed: true });
    const detail = (await req(alice, 'GET', `/tasks/${parent.id}`)).json();
    expect(detail).toMatchObject({ subtaskCount: 2, completedSubtaskCount: 1 });
    expect(detail.subtasks.map((s: { title: string }) => s.title)).toEqual(['Sub 1', 'Sub 2']);

    const list = (await req(alice, 'GET', `/projects/${project.id}/tasks`)).json();
    expect(list.data.map((t: { title: string }) => t.title)).toEqual(['Parent']);
  });

  it('cannot be created in a different project than the parent, or moved out of it', async () => {
    const other = await createProject({ name: 'Other' });
    const parent = await createTask({ title: 'Parent', projectId: project.id });
    expect((await req(alice, 'POST', '/tasks', { title: 's', parentId: parent.id, projectId: other.id })).statusCode).toBe(400);
    const sub = await createTask({ title: 's', parentId: parent.id });
    expect((await req(alice, 'PATCH', `/tasks/${sub.id}`, { projectId: other.id })).statusCode).toBe(400);
  });

  it('are deleted with their parent', async () => {
    const parent = await createTask({ title: 'Parent', projectId: project.id });
    const sub = await createTask({ title: 'Sub', parentId: parent.id });
    expect((await req(alice, 'DELETE', `/tasks/${parent.id}`)).statusCode).toBe(204);
    expect(await prisma.task.findUnique({ where: { id: sub.id } })).toBeNull();
    expect((await req(alice, 'GET', `/tasks/${parent.id}`)).statusCode).toBe(404);
  });
});

describe('GET /projects/:id/tasks', () => {
  it('orders by section position then task position, with section-less tasks last', async () => {
    const [todo, doing] = project.sections;
    await createTask({ title: 'doing-2', sectionId: doing!.id, position: 2 });
    await createTask({ title: 'todo-1', sectionId: todo!.id, position: 1 });
    await createTask({ title: 'none', projectId: project.id });
    await createTask({ title: 'doing-1', sectionId: doing!.id, position: 1 });
    // Moving the "In progress" section above "To do" reorders the list.
    await req(alice, 'PATCH', `/sections/${doing!.id}`, { position: 1 });

    const titles = (await req(bob, 'GET', `/projects/${project.id}/tasks`)).json().data.map((t: { title: string }) => t.title);
    expect(titles).toEqual(['doing-1', 'doing-2', 'todo-1', 'none']);
  });

  it('filters by completed and assigneeId', async () => {
    const done = await createTask({ title: 'done', projectId: project.id, assigneeId: bob.user.id });
    await req(alice, 'PATCH', `/tasks/${done.id}`, { completed: true });
    await createTask({ title: 'open', projectId: project.id });

    const titles = async (qs: string) =>
      (await req(alice, 'GET', `/projects/${project.id}/tasks${qs}`)).json().data.map((t: { title: string }) => t.title);
    expect(await titles('?completed=false')).toEqual(['open']);
    expect(await titles('?completed=true')).toEqual(['done']);
    expect(await titles(`?assigneeId=${bob.user.id}`)).toEqual(['done']);
    expect((await titles('')).sort()).toEqual(['done', 'open']);
  });

  it('is 404 for users who cannot see the project', async () => {
    expect((await req(outsider, 'GET', `/projects/${project.id}/tasks`)).statusCode).toBe(404);
  });
});

describe('GET /me/tasks', () => {
  it('returns top-level tasks and subtasks assigned to me, ordered by due date', async () => {
    const parent = await createTask({ title: 'Parent', projectId: project.id, assigneeId: bob.user.id, dueDate: '2026-12-01' });
    await createTask({ title: 'Sub', parentId: parent.id, assigneeId: bob.user.id, dueDate: '2026-11-01' });
    await createTask({ title: 'No date', projectId: project.id, assigneeId: bob.user.id });
    const done = await createTask({ title: 'Done', projectId: project.id, assigneeId: bob.user.id });
    await req(bob, 'PATCH', `/tasks/${done.id}`, { completed: true });
    await createTask({ title: 'Not mine', projectId: project.id, assigneeId: alice.user.id });

    const all = (await req(bob, 'GET', '/me/tasks')).json().data.map((t: { title: string }) => t.title);
    expect(all.slice(0, 2)).toEqual(['Sub', 'Parent']);
    expect(all.sort()).toEqual(['Done', 'No date', 'Parent', 'Sub']);
    const open = (await req(bob, 'GET', '/me/tasks?completed=false')).json().data.map((t: { title: string }) => t.title);
    expect(open).toEqual(['Sub', 'Parent', 'No date']);
  });

  it('includes my personal tasks', async () => {
    await createTask({ title: 'Personal', assigneeId: bob.user.id }, bob);
    const titles = (await req(bob, 'GET', '/me/tasks')).json().data.map((t: { title: string }) => t.title);
    expect(titles).toEqual(['Personal']);
  });
});

describe('personal tasks (no project)', () => {
  it('are visible only to creator, assignee and followers', async () => {
    const t = await createTask({ title: 'Private todo' }, alice);
    expect(t).toMatchObject({ projectId: null, sectionId: null, project: null, position: 1000 });
    expect((await req(bob, 'GET', `/tasks/${t.id}`)).statusCode).toBe(404);
    expect((await req(bob, 'PATCH', `/tasks/${t.id}`, { title: 'hack' })).statusCode).toBe(404);

    await req(alice, 'POST', `/tasks/${t.id}/followers`, { userId: bob.user.id });
    expect((await req(bob, 'GET', `/tasks/${t.id}`)).statusCode).toBe(200);

    // Subtasks inherit visibility from the top-level task.
    const sub = await createTask({ title: 'Sub', parentId: t.id }, alice);
    expect((await req(bob, 'GET', `/tasks/${sub.id}`)).statusCode).toBe(200);
    expect((await req(outsider, 'GET', `/tasks/${sub.id}`)).statusCode).toBe(404);
  });

  it('cannot have a section', async () => {
    const t = await createTask({ title: 'Personal' });
    expect((await req(alice, 'PATCH', `/tasks/${t.id}`, { sectionId: project.sections[0]!.id })).statusCode).toBe(400);
  });
});

describe('PATCH /tasks/:id', () => {
  it('records an activity for each tracked change', async () => {
    const t = await createTask({ title: 'Old', projectId: project.id, sectionId: project.sections[0]!.id });
    const res = await req(bob, 'PATCH', `/tasks/${t.id}`, {
      title: 'New',
      description: 'Now with details',
      priority: 'LOW',
      dueDate: '2026-11-15',
      startDate: '2026-11-01',
      sectionId: project.sections[1]!.id,
      position: 42,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      title: 'New',
      description: 'Now with details',
      priority: 'LOW',
      dueDate: '2026-11-15',
      startDate: '2026-11-01',
      sectionId: project.sections[1]!.id,
      position: 42,
    });
    const acts = await prisma.activity.findMany({ where: { taskId: t.id, type: { not: 'CREATED' } } });
    const byType = Object.fromEntries(acts.map((a) => [a.type, a.data]));
    expect(byType).toEqual({
      RENAMED: { from: 'Old', to: 'New' },
      DESCRIPTION_CHANGED: {},
      PRIORITY_CHANGED: { from: 'NONE', to: 'LOW' },
      DUE_DATE_CHANGED: { from: null, to: '2026-11-15' },
      MOVED_SECTION: { fromSectionId: project.sections[0]!.id, toSectionId: project.sections[1]!.id },
    });
    expect(acts.every((a) => a.actorId === bob.user.id)).toBe(true);
  });

  it('records nothing for no-op updates and clears nullable fields with null', async () => {
    const t = await createTask({ title: 'Same', projectId: project.id, dueDate: '2026-11-15', description: 'd' });
    await req(alice, 'PATCH', `/tasks/${t.id}`, { title: 'Same', priority: 'NONE' });
    expect(await activityTypes(t.id)).toEqual(['CREATED']);

    const cleared = (await req(alice, 'PATCH', `/tasks/${t.id}`, { dueDate: null, description: null })).json();
    expect(cleared).toMatchObject({ dueDate: null, description: null });
    expect(await activityTypes(t.id)).toEqual(['CREATED', 'DESCRIPTION_CHANGED', 'DUE_DATE_CHANGED']);
  });

  it('completing sets completedAt and notifies followers except the actor; reopening clears it', async () => {
    const t = await createTask({ title: 'Ship', projectId: project.id, assigneeId: bob.user.id });
    await prisma.notification.deleteMany();
    const done = (await req(bob, 'PATCH', `/tasks/${t.id}`, { completed: true })).json();
    expect(done.completed).toBe(true);
    expect(Date.parse(done.completedAt)).not.toBeNaN();
    const notes = await prisma.notification.findMany();
    expect(notes.map((n) => [n.userId, n.type])).toEqual([[alice.user.id, 'COMPLETED']]);

    const reopened = (await req(bob, 'PATCH', `/tasks/${t.id}`, { completed: false })).json();
    expect(reopened).toMatchObject({ completed: false, completedAt: null });
    expect(await activityTypes(t.id)).toEqual(['CREATED', 'ASSIGNED', 'COMPLETED', 'REOPENED']);
  });

  it('reassigning notifies the new assignee and unassigning records UNASSIGNED', async () => {
    const t = await createTask({ title: 'T', projectId: project.id });
    await req(alice, 'PATCH', `/tasks/${t.id}`, { assigneeId: bob.user.id });
    expect(await prisma.notification.count({ where: { userId: bob.user.id, type: 'ASSIGNED' } })).toBe(1);
    const res = (await req(alice, 'PATCH', `/tasks/${t.id}`, { assigneeId: null })).json();
    expect(res.assignee).toBeNull();
    expect(res.followers.map((f: { id: string }) => f.id)).toContain(bob.user.id); // still follows
    expect(await activityTypes(t.id)).toEqual(['CREATED', 'ASSIGNED', 'UNASSIGNED']);
  });

  it('moves a task (and its subtasks) to another project, requiring edit access to both', async () => {
    const other = await createProject({ name: 'Other' });
    const t = await createTask({ title: 'Move me', projectId: project.id, sectionId: project.sections[0]!.id });
    const sub = await createTask({ title: 'Sub', parentId: t.id });

    const moved = (await req(alice, 'PATCH', `/tasks/${t.id}`, { projectId: other.id, sectionId: other.sections[2].id })).json();
    expect(moved).toMatchObject({ projectId: other.id, sectionId: other.sections[2].id, project: { name: 'Other' } });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: sub.id } })).projectId).toBe(other.id);

    const resetSection = (await req(alice, 'PATCH', `/tasks/${t.id}`, { projectId: project.id })).json();
    expect(resetSection.sectionId).toBeNull();

    // Bob can edit `project`, but `secret` is invisible to him: 404, nothing moves.
    const secret = await createProject({ name: 'Secret', privacy: 'PRIVATE' });
    expect((await req(bob, 'PATCH', `/tasks/${t.id}`, { projectId: secret.id })).statusCode).toBe(404);
    // A commenter on the target project can't move tasks into it.
    await prisma.projectMember.create({ data: { projectId: secret.id, userId: bob.user.id, role: 'COMMENTER' } });
    expect((await req(bob, 'PATCH', `/tasks/${t.id}`, { projectId: secret.id })).statusCode).toBe(403);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).projectId).toBe(project.id);
  });

  it('rejects a sectionId from another project', async () => {
    const other = await createProject({ name: 'Other' });
    const t = await createTask({ title: 'T', projectId: project.id });
    expect((await req(alice, 'PATCH', `/tasks/${t.id}`, { sectionId: other.sections[0].id })).statusCode).toBe(400);
  });

  it('is 404 for outsiders and 403 for commenters (who can still view and follow)', async () => {
    const t = await createTask({ title: 'T', projectId: project.id });
    expect((await req(outsider, 'GET', `/tasks/${t.id}`)).statusCode).toBe(404);
    expect((await req(outsider, 'PATCH', `/tasks/${t.id}`, { title: 'x' })).statusCode).toBe(404);
    expect((await req(outsider, 'DELETE', `/tasks/${t.id}`)).statusCode).toBe(404);

    await prisma.projectMember.create({ data: { projectId: project.id, userId: outsider.user.id, role: 'COMMENTER' } });
    expect((await req(outsider, 'GET', `/tasks/${t.id}`)).statusCode).toBe(200);
    expect((await req(outsider, 'PATCH', `/tasks/${t.id}`, { title: 'x' })).statusCode).toBe(403);
    expect((await req(outsider, 'DELETE', `/tasks/${t.id}`)).statusCode).toBe(403);
    expect((await req(outsider, 'POST', '/tasks', { title: 's', parentId: t.id })).statusCode).toBe(403);
    expect((await req(outsider, 'POST', `/tasks/${t.id}/followers`, { userId: outsider.user.id })).statusCode).toBe(200);
  });

  it('ignores unknown fields', async () => {
    const t = await createTask({ title: 'T', projectId: project.id });
    const res = await req(alice, 'PATCH', `/tasks/${t.id}`, { ...t, title: 'Renamed' });
    expect(res.statusCode).toBe(200);
    expect(res.json().title).toBe('Renamed');
  });
});

describe('followers', () => {
  it('adds and removes followers', async () => {
    const t = await createTask({ title: 'T', projectId: project.id });
    const added = (await req(alice, 'POST', `/tasks/${t.id}/followers`, { userId: bob.user.id })).json();
    expect(added.followers.map((f: { name: string }) => f.name)).toEqual(['Alice', 'Bob']);
    const again = (await req(alice, 'POST', `/tasks/${t.id}/followers`, { userId: bob.user.id })).json();
    expect(again.followers).toHaveLength(2);
    const removed = (await req(bob, 'DELETE', `/tasks/${t.id}/followers/${bob.user.id}`)).json();
    expect(removed.followers.map((f: { name: string }) => f.name)).toEqual(['Alice']);
  });
});
