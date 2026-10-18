import { beforeEach, describe, expect, it } from 'vitest';
import type { User } from '@prisma/client';
import { prisma, setupApp, signedIn, defaultWorkspaceId } from './helpers.js';

const ctx = setupApp();

type Session = { user: User; cookie: string };
let owner: Session; // team member, creates the projects
let teammate: Session; // same team
let outsider: Session; // not in the team
let admin: Session;
let teamId: string;

beforeEach(async () => {
  owner = await signedIn(ctx.app, { name: 'Owner' });
  teammate = await signedIn(ctx.app, { name: 'Teammate' });
  outsider = await signedIn(ctx.app, { name: 'Outsider' });
  admin = await signedIn(ctx.app, { name: 'Admin', role: 'ADMIN' });
  const team = await prisma.team.create({
    data: { workspaceId: await defaultWorkspaceId(), name: 'Eng', members: { create: [{ userId: owner.user.id }, { userId: teammate.user.id }] } },
  });
  teamId = team.id;
});

async function createProject(body: Record<string, unknown> = {}, cookie = owner.cookie) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    headers: { cookie },
    payload: { teamId, name: 'Website', ...body },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

const get = (url: string, s: Session) => ctx.app.inject({ method: 'GET', url, headers: { cookie: s.cookie } });

describe('create / read', () => {
  it('creates a TEAM project with default sections and the creator as OWNER', async () => {
    const p = await createProject({ description: 'Marketing site', color: '#ff0000' });
    expect(p).toMatchObject({
      teamId,
      name: 'Website',
      description: 'Marketing site',
      color: '#ff0000',
      privacy: 'TEAM',
      archived: false,
      defaultView: 'LIST',
      owner: { id: owner.user.id, name: 'Owner' },
      myRole: 'OWNER',
      team: { id: teamId, name: 'Eng' },
      members: [{ user: { id: owner.user.id }, role: 'OWNER' }],
    });
    expect(p.sections.map((s: { name: string }) => s.name)).toEqual(['To do', 'In progress', 'Done']);
    expect(p.sections.map((s: { position: number }) => s.position)).toEqual([1000, 2000, 3000]);
  });

  it('requires team membership to create a project (admins exempt)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie: outsider.cookie },
      payload: { teamId, name: 'Nope' },
    });
    expect(res.statusCode).toBe(403);
    await createProject({ name: 'Admin project' }, admin.cookie);
  });

  it('applies visibility rules and hides invisible projects with 404', async () => {
    const team = await createProject({ name: 'Team project' });
    const pub = await createProject({ name: 'Public project', privacy: 'PUBLIC' });
    const priv = await createProject({ name: 'Private project', privacy: 'PRIVATE' });

    const names = async (s: Session) =>
      (await get('/api/v1/projects', s)).json().data.map((p: { name: string }) => p.name);
    expect(await names(owner)).toEqual(['Private project', 'Public project', 'Team project']);
    expect(await names(teammate)).toEqual(['Public project', 'Team project']);
    expect(await names(outsider)).toEqual(['Public project']);
    expect(await names(admin)).toEqual(['Private project', 'Public project', 'Team project']);

    expect((await get(`/api/v1/projects/${priv.id}`, teammate)).statusCode).toBe(404);
    expect((await get(`/api/v1/projects/${team.id}`, outsider)).statusCode).toBe(404);
    const viaPublic = await get(`/api/v1/projects/${pub.id}`, outsider);
    expect(viaPublic.statusCode).toBe(200);
    expect(viaPublic.json().myRole).toBeNull();
  });

  it('shows a private project to its explicit members', async () => {
    const priv = await createProject({ privacy: 'PRIVATE' });
    await prisma.projectMember.create({ data: { projectId: priv.id, userId: outsider.user.id, role: 'COMMENTER' } });
    const res = await get(`/api/v1/projects/${priv.id}`, outsider);
    expect(res.statusCode).toBe(200);
    expect(res.json().myRole).toBe('COMMENTER');
  });

  it('filters by teamId, archived and q', async () => {
    await createProject({ name: 'Alpha launch' });
    const beta = await createProject({ name: 'Beta' });
    await prisma.project.update({ where: { id: beta.id }, data: { archived: true } });

    const active = await get(`/api/v1/projects?teamId=${teamId}`, owner);
    expect(active.json().data.map((p: { name: string }) => p.name)).toEqual(['Alpha launch']);
    const archived = await get('/api/v1/projects?archived=true', owner);
    expect(archived.json().data.map((p: { name: string }) => p.name)).toEqual(['Beta']);
    const q = await get('/api/v1/projects?q=LAUNCH', owner);
    expect(q.json().data).toHaveLength(1);
    expect(q.json().data[0]).not.toHaveProperty('sections');
  });
});

describe('settings', () => {
  it('lets the OWNER and ADMIN change settings; editors get 403', async () => {
    const p = await createProject();
    const patch = (s: Session, payload: object) =>
      ctx.app.inject({ method: 'PATCH', url: `/api/v1/projects/${p.id}`, headers: { cookie: s.cookie }, payload });

    expect((await patch(teammate, { name: 'Renamed' })).statusCode).toBe(403);
    const ok = await patch(owner, { name: 'Renamed', privacy: 'PUBLIC', archived: true, defaultView: 'BOARD', description: null });
    expect(ok.json()).toMatchObject({ name: 'Renamed', privacy: 'PUBLIC', archived: true, defaultView: 'BOARD', description: null });
    expect((await patch(admin, { color: '#00ff00' })).json().color).toBe('#00ff00');
    expect((await patch(owner, { privacy: 'SECRET' })).statusCode).toBe(400);
  });

  it('deletes a project and cascades its sections and tasks', async () => {
    const p = await createProject();
    await prisma.task.create({ data: { workspaceId: await defaultWorkspaceId(), projectId: p.id, sectionId: p.sections[0].id, title: 'T', creatorId: owner.user.id } });
    const denied = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/projects/${p.id}`, headers: { cookie: teammate.cookie } });
    expect(denied.statusCode).toBe(403);
    const res = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/projects/${p.id}`, headers: { cookie: owner.cookie } });
    expect(res.statusCode).toBe(204);
    expect(await prisma.section.count({ where: { projectId: p.id } })).toBe(0);
    expect(await prisma.task.count({ where: { projectId: p.id } })).toBe(0);
  });
});

describe('members', () => {
  it('adds, re-roles and removes members, keeping at least one owner', async () => {
    const p = await createProject({ privacy: 'PRIVATE' });
    const url = `/api/v1/projects/${p.id}/members`;
    const headers = { cookie: owner.cookie };

    const added = await ctx.app.inject({ method: 'POST', url, headers, payload: { userId: outsider.user.id, role: 'EDITOR' } });
    expect(added.json().members).toEqual([
      { user: expect.objectContaining({ id: outsider.user.id }), role: 'EDITOR' },
      { user: expect.objectContaining({ id: owner.user.id }), role: 'OWNER' },
    ]);
    const dup = await ctx.app.inject({ method: 'POST', url, headers, payload: { userId: outsider.user.id, role: 'EDITOR' } });
    expect(dup.statusCode).toBe(409);

    const rerole = await ctx.app.inject({
      method: 'PATCH',
      url: `${url}/${outsider.user.id}`,
      headers,
      payload: { role: 'COMMENTER' },
    });
    expect(rerole.json().members[0].role).toBe('COMMENTER');

    const demoteLastOwner = await ctx.app.inject({
      method: 'PATCH',
      url: `${url}/${owner.user.id}`,
      headers,
      payload: { role: 'EDITOR' },
    });
    expect(demoteLastOwner.statusCode).toBe(409);
    const removeLastOwner = await ctx.app.inject({ method: 'DELETE', url: `${url}/${owner.user.id}`, headers });
    expect(removeLastOwner.statusCode).toBe(409);

    const removed = await ctx.app.inject({ method: 'DELETE', url: `${url}/${outsider.user.id}`, headers });
    expect(removed.json().members).toHaveLength(1);
    expect((await get(`/api/v1/projects/${p.id}`, outsider)).statusCode).toBe(404);
  });

  it('moves Project.owner to a remaining OWNER when the owner steps down', async () => {
    const p = await createProject();
    const url = `/api/v1/projects/${p.id}/members`;
    const headers = { cookie: owner.cookie };
    await ctx.app.inject({ method: 'POST', url, headers, payload: { userId: teammate.user.id, role: 'OWNER' } });
    const res = await ctx.app.inject({ method: 'PATCH', url: `${url}/${owner.user.id}`, headers, payload: { role: 'EDITOR' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().owner.id).toBe(teammate.user.id);
    expect(res.json().myRole).toBe('EDITOR');
  });

  it('forbids non-owners from managing members', async () => {
    const p = await createProject();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${p.id}/members`,
      headers: { cookie: teammate.cookie },
      payload: { userId: outsider.user.id, role: 'EDITOR' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('sections', () => {
  it('creates sections at the end by default, or at a given position', async () => {
    const p = await createProject();
    const url = `/api/v1/projects/${p.id}/sections`;
    const last = await ctx.app.inject({ method: 'POST', url, headers: { cookie: teammate.cookie }, payload: { name: 'Later' } });
    expect(last.statusCode).toBe(201);
    expect(last.json()).toEqual({ id: expect.any(String), projectId: p.id, name: 'Later', position: 4000 });

    await ctx.app.inject({ method: 'POST', url, headers: { cookie: owner.cookie }, payload: { name: 'First', position: 500 } });
    const detail = await get(`/api/v1/projects/${p.id}`, owner);
    expect(detail.json().sections.map((s: { name: string }) => s.name)).toEqual([
      'First',
      'To do',
      'In progress',
      'Done',
      'Later',
    ]);
  });

  it('renames/moves and deletes sections, leaving their tasks section-less', async () => {
    const p = await createProject();
    const section = p.sections[0];
    const task = await prisma.task.create({
      data: { workspaceId: await defaultWorkspaceId(), projectId: p.id, sectionId: section.id, title: 'T', creatorId: owner.user.id },
    });
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/sections/${section.id}`,
      headers: { cookie: teammate.cookie },
      payload: { name: 'Backlog', position: 2500 },
    });
    expect(patched.json()).toMatchObject({ name: 'Backlog', position: 2500 });

    const del = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/sections/${section.id}`, headers: { cookie: owner.cookie } });
    expect(del.statusCode).toBe(204);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).sectionId).toBeNull();
  });

  it('returns 403 to commenters and 404 to users who cannot see the project', async () => {
    const p = await createProject({ privacy: 'PRIVATE' });
    await prisma.projectMember.create({ data: { projectId: p.id, userId: teammate.user.id, role: 'COMMENTER' } });
    const section = p.sections[0];

    const asCommenter = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/sections/${section.id}`,
      headers: { cookie: teammate.cookie },
      payload: { name: 'x' },
    });
    expect(asCommenter.statusCode).toBe(403);
    const create = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${p.id}/sections`,
      headers: { cookie: teammate.cookie },
      payload: { name: 'x' },
    });
    expect(create.statusCode).toBe(403);

    const asOutsider = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/sections/${section.id}`, headers: { cookie: outsider.cookie } });
    expect(asOutsider.statusCode).toBe(404);
  });
});
