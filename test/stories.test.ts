import { beforeEach, describe, expect, it } from 'vitest';
import type { User } from '@prisma/client';
import { extractMentionIds } from '../src/lib/mentions.js';
import { createUser, prisma, setupApp, signedIn, defaultWorkspaceId } from './helpers.js';

const ctx = setupApp();

type Session = { user: User; cookie: string };
let alice: Session; // project owner
let bob: Session; // team member
let carol: Session; // team member
let outsider: Session;
let projectId: string;

beforeEach(async () => {
  alice = await signedIn(ctx.app, { name: 'Alice' });
  bob = await signedIn(ctx.app, { name: 'Bob' });
  carol = await signedIn(ctx.app, { name: 'Carol' });
  outsider = await signedIn(ctx.app, { name: 'Outsider' });
  const team = await prisma.team.create({
    data: { workspaceId: await defaultWorkspaceId(),
      name: 'Eng',
      members: { create: [{ userId: alice.user.id }, { userId: bob.user.id }, { userId: carol.user.id }] },
    },
  });
  const res = await req(alice, 'POST', '/projects', { teamId: team.id, name: 'Website' });
  projectId = res.json().id;
});

function req(s: Session, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) {
  return ctx.app.inject({ method, url: `/api/v1${url}`, headers: { cookie: s.cookie }, payload });
}

async function createTask(body: object, s: Session = alice) {
  const res = await req(s, 'POST', '/tasks', body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

const mentionOf = (s: Session) => `@[${s.user.name}](${s.user.id})`;
const notificationsOf = async (userId: string) =>
  (await prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } })).map((n) => n.type);

describe('extractMentionIds', () => {
  it('finds distinct ids in @[Name](id) syntax', () => {
    const a = '11111111-1111-1111-1111-111111111111';
    const b = '22222222-2222-2222-2222-222222222222';
    expect(extractMentionIds(`hi @[A](${a}) and @[B b](${b.toUpperCase()}), again @[A](${a}) [x](${b})`)).toEqual([a, b]);
    expect(extractMentionIds('no mentions @alice')).toEqual([]);
  });
});

describe('comments', () => {
  it('creates a comment story; the author follows and followers get COMMENTED', async () => {
    const task = await createTask({ title: 'T', projectId, assigneeId: bob.user.id });
    await prisma.notification.deleteMany();

    const res = await req(carol, 'POST', `/tasks/${task.id}/comments`, { body: 'Looks good' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      kind: 'comment',
      id: expect.any(String),
      author: expect.objectContaining({ id: carol.user.id, name: 'Carol' }),
      body: 'Looks good',
      attachments: [],
      createdAt: expect.any(String),
      editedAt: null,
    });
    expect(await notificationsOf(alice.user.id)).toEqual(['COMMENTED']);
    expect(await notificationsOf(bob.user.id)).toEqual(['COMMENTED']);
    expect(await notificationsOf(carol.user.id)).toEqual([]);

    const detail = (await req(alice, 'GET', `/tasks/${task.id}`)).json();
    expect(detail.followers.map((f: { name: string }) => f.name)).toEqual(['Alice', 'Bob', 'Carol']);
    expect(detail.commentCount).toBe(1);
  });

  it('notifies mentioned users once (MENTIONED rather than COMMENTED) if they can see the task', async () => {
    const task = await createTask({ title: 'T', projectId, assigneeId: bob.user.id });
    await prisma.notification.deleteMany();
    const body = `${mentionOf(bob)} ${mentionOf(carol)} ${mentionOf(outsider)} ${mentionOf(alice)}`;
    await req(alice, 'POST', `/tasks/${task.id}/comments`, { body });

    expect(await notificationsOf(bob.user.id)).toEqual(['MENTIONED']); // follower, but mentioned
    expect(await notificationsOf(carol.user.id)).toEqual(['MENTIONED']);
    expect(await notificationsOf(outsider.user.id)).toEqual([]); // can't see the project
    expect(await notificationsOf(alice.user.id)).toEqual([]); // self-mention
  });

  it('lets project commenters comment', async () => {
    const task = await createTask({ title: 'T', projectId });
    await prisma.projectMember.create({ data: { projectId, userId: outsider.user.id, role: 'COMMENTER' } });
    expect((await req(outsider, 'POST', `/tasks/${task.id}/comments`, { body: 'hi' })).statusCode).toBe(201);
  });

  it('is 404 for users who cannot see the task, and 400 for an empty body', async () => {
    const task = await createTask({ title: 'T', projectId });
    expect((await req(outsider, 'POST', `/tasks/${task.id}/comments`, { body: 'hi' })).statusCode).toBe(404);
    expect((await req(bob, 'POST', `/tasks/${task.id}/comments`, { body: '   ' })).statusCode).toBe(400);
  });

  it('only the author edits (sets editedAt, notifies new mentions only); author or admin deletes', async () => {
    const task = await createTask({ title: 'T', projectId });
    const c = (await req(bob, 'POST', `/tasks/${task.id}/comments`, { body: `cc ${mentionOf(carol)}` })).json();
    await prisma.notification.deleteMany();

    expect((await req(alice, 'PATCH', `/comments/${c.id}`, { body: 'hijack' })).statusCode).toBe(403);
    const edited = await req(bob, 'PATCH', `/comments/${c.id}`, { body: `cc ${mentionOf(carol)} and ${mentionOf(alice)}` });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().editedAt).not.toBeNull();
    expect(await notificationsOf(carol.user.id)).toEqual([]);
    expect(await notificationsOf(alice.user.id)).toEqual(['MENTIONED']);

    expect((await req(carol, 'DELETE', `/comments/${c.id}`)).statusCode).toBe(403);
    expect((await req(outsider, 'DELETE', `/comments/${c.id}`)).statusCode).toBe(404);
    expect((await req(bob, 'DELETE', `/comments/${c.id}`)).statusCode).toBe(204);

    const c2 = (await req(bob, 'POST', `/tasks/${task.id}/comments`, { body: 'again' })).json();
    const admin = await signedIn(ctx.app, { role: 'ADMIN' });
    expect((await req(admin, 'DELETE', `/comments/${c2.id}`)).statusCode).toBe(204);
    expect((await req(admin, 'DELETE', `/comments/${c2.id}`)).statusCode).toBe(404);
  });
});

describe('GET /tasks/:id/stories', () => {
  it('merges comments and activity, oldest first', async () => {
    const task = await createTask({ title: 'T', projectId });
    await req(bob, 'POST', `/tasks/${task.id}/comments`, { body: 'first' });
    await req(alice, 'PATCH', `/tasks/${task.id}`, { title: 'T2' });
    await req(carol, 'POST', `/tasks/${task.id}/comments`, { body: 'second' });

    const res = await req(bob, 'GET', `/tasks/${task.id}/stories`);
    const stories = res.json().data;
    expect(stories.map((s: { kind: string; type?: string; body?: string }) => s.type ?? s.body)).toEqual([
      'CREATED',
      'first',
      'RENAMED',
      'second',
    ]);
    expect(stories[2]).toEqual({
      kind: 'activity',
      id: expect.any(String),
      actor: expect.objectContaining({ id: alice.user.id }),
      type: 'RENAMED',
      data: { from: 'T', to: 'T2' },
      createdAt: expect.any(String),
    });
    expect((await req(outsider, 'GET', `/tasks/${task.id}/stories`)).statusCode).toBe(404);
  });
});

describe('notifications', () => {
  it('lists newest first with unreadCount, marks one or all read', async () => {
    const t1 = await createTask({ title: 'First', projectId, assigneeId: bob.user.id });
    await createTask({ title: 'Second', projectId, assigneeId: bob.user.id });
    await req(alice, 'POST', `/tasks/${t1.id}/comments`, { body: 'ping' });

    const list = (await req(bob, 'GET', '/notifications')).json();
    expect(list.unreadCount).toBe(3);
    expect(list.data.map((n: { type: string; task: { title: string } }) => [n.type, n.task.title])).toEqual([
      ['COMMENTED', 'First'],
      ['ASSIGNED', 'Second'],
      ['ASSIGNED', 'First'],
    ]);
    expect(list.data[0]).toEqual({
      id: expect.any(String),
      workspaceId: expect.any(String),
      type: 'COMMENTED',
      read: false,
      createdAt: expect.any(String),
      actor: expect.objectContaining({ id: alice.user.id }),
      task: { id: t1.id, title: 'First', projectId },
    });

    expect((await req(bob, 'POST', `/notifications/${list.data[0].id}/read`)).statusCode).toBe(204);
    // Someone else's notification is 404.
    expect((await req(alice, 'POST', `/notifications/${list.data[1].id}/read`)).statusCode).toBe(404);
    const unread = (await req(bob, 'GET', '/notifications?unread=true&limit=1')).json();
    expect(unread).toMatchObject({ unreadCount: 2, data: [{ type: 'ASSIGNED', read: false }] });

    expect((await req(bob, 'POST', '/notifications/read-all')).statusCode).toBe(204);
    expect((await req(bob, 'GET', '/notifications')).json().unreadCount).toBe(0);
  });

  it('hides notifications about tasks the user can no longer see', async () => {
    const priv = (await req(alice, 'POST', '/projects', { teamId: (await prisma.team.findFirstOrThrow()).id, name: 'Secret', privacy: 'PRIVATE' })).json();
    await req(alice, 'POST', `/projects/${priv.id}/members`, { userId: bob.user.id, role: 'EDITOR' });
    await createTask({ title: 'Secret plan', projectId: priv.id, assigneeId: bob.user.id });
    expect((await req(bob, 'GET', '/notifications')).json().unreadCount).toBe(1);

    await req(alice, 'DELETE', `/projects/${priv.id}/members/${bob.user.id}`);
    const after = (await req(bob, 'GET', '/notifications')).json();
    expect(after).toEqual({ data: [], unreadCount: 0 });
  });
});

describe('search', () => {
  it('finds visible tasks, projects and active users (case-insensitive, min 2 chars)', async () => {
    const team = await prisma.team.findFirstOrThrow();
    await createTask({ title: 'Launch rocket', projectId });
    const priv = (await req(alice, 'POST', '/projects', { teamId: team.id, name: 'Launch secret', privacy: 'PRIVATE' })).json();
    await createTask({ title: 'Launch hidden thing', projectId: priv.id });
    await createTask({ title: 'Personal launch prep' }, carol);
    await createUser({ name: 'Launchy McLaunchface' });
    await createUser({ name: 'Launch Gone', isActive: false });

    const res = await req(bob, 'GET', '/search?q=LAUNCH');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tasks.map((t: { title: string }) => t.title)).toEqual(['Launch rocket']);
    expect(body.tasks[0]).toHaveProperty('subtaskCount');
    expect(body.projects).toEqual([]);
    expect(body.users.map((u: { name: string }) => u.name)).toEqual(['Launchy McLaunchface']);

    const asAlice = (await req(alice, 'GET', '/search?q=launch')).json();
    expect(asAlice.tasks.map((t: { title: string }) => t.title).sort()).toEqual(['Launch hidden thing', 'Launch rocket']);
    expect(asAlice.projects.map((p: { name: string; myRole: string }) => [p.name, p.myRole])).toEqual([['Launch secret', 'OWNER']]);

    expect((await req(bob, 'GET', '/search?q=l')).statusCode).toBe(400);
  });
});

describe('who can be involved in a task (PR 3 review follow-ups)', () => {
  it('rejects assignees and followers who cannot see the project', async () => {
    const res = await req(alice, 'POST', '/tasks', { title: 'T', projectId, assigneeId: outsider.user.id });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details[0].path).toEqual(['assigneeId']);

    const task = await createTask({ title: 'T', projectId });
    expect((await req(alice, 'PATCH', `/tasks/${task.id}`, { assigneeId: outsider.user.id })).statusCode).toBe(400);
    const follow = await req(alice, 'POST', `/tasks/${task.id}/followers`, { userId: outsider.user.id });
    expect(follow.statusCode).toBe(400);
    expect(follow.json().error.details[0].path).toEqual(['userId']);
    expect(await prisma.notification.count({ where: { userId: outsider.user.id } })).toBe(0);
  });

  it('rejects a move that would leave the assignee without access', async () => {
    const team = await prisma.team.findFirstOrThrow();
    const priv = (await req(alice, 'POST', '/projects', { teamId: team.id, name: 'Secret', privacy: 'PRIVATE' })).json();
    const task = await createTask({ title: 'T', projectId, assigneeId: bob.user.id });
    expect((await req(alice, 'PATCH', `/tasks/${task.id}`, { projectId: priv.id })).statusCode).toBe(400);
    // Reassigning to someone with access in the same request is fine.
    const ok = await req(alice, 'PATCH', `/tasks/${task.id}`, { projectId: priv.id, assigneeId: alice.user.id });
    expect(ok.statusCode).toBe(200);
  });

  it('allows only one level of subtasks', async () => {
    const parent = await createTask({ title: 'P', projectId });
    const sub = await createTask({ title: 'S', parentId: parent.id });
    const res = await req(alice, 'POST', '/tasks', { title: 'SS', parentId: sub.id });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details[0].path).toEqual(['parentId']);
  });
});
