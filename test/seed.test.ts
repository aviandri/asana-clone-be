import { describe, expect, it } from 'vitest';
import { databaseIsEmpty, resetDatabase, seed, seedGoalsOnly, seedWorkspacesDemo, SEED_PASSWORD } from '../src/lib/seed.js';
import { login, prisma, setupApp } from './helpers.js';
import { currentPeriods } from '../src/lib/time.js';
import { deleteWorkspace } from '../src/lib/workspaces.js';

const ctx = setupApp();

describe('seed (SPEC §7)', () => {
  it('creates the demo workspace through the API', async () => {
    expect(await databaseIsEmpty(prisma)).toBe(true);
    const counts = await seed(ctx.app);
    expect(counts).toEqual({ workspaces: 2, users: 3, teams: 3, projects: 4, tasks: 42, goals: 6 });

    const mekari = await prisma.workspace.findFirstOrThrow({ where: { name: 'Mekari' } });
    const roles = await prisma.workspaceMember.findMany({ where: { workspaceId: mekari.id }, include: { user: true } });
    expect(Object.fromEntries(roles.map((m) => [m.user.email, m.role]))).toEqual({
      'admin@example.com': 'ADMIN',
      'alice@example.com': 'MEMBER',
      'bob@example.com': 'MEMBER',
    });
    // The v1 data is all in Mekari, which stays everyone's current workspace.
    expect(await prisma.user.count({ where: { lastWorkspaceId: mekari.id } })).toBe(3);
    for (const email of ['admin@example.com', 'alice@example.com', 'bob@example.com']) {
      expect(await login(ctx.app, email, SEED_PASSWORD)).toMatch(/^sid=/);
    }
    expect((await prisma.team.findMany({ where: { workspaceId: mekari.id }, orderBy: { name: 'asc' } })).map((t) => t.name)).toEqual(['Engineering', 'Marketing']);
    expect(await prisma.section.count({ where: { project: { workspaceId: mekari.id } } })).toBe(9);
    expect(await prisma.task.count({ where: { workspaceId: mekari.id, parentId: { not: null } } })).toBe(5);
    expect(await prisma.task.count({ where: { completed: true } })).toBeGreaterThan(3);

    // SPEC §13: a PNG, a PDF, a text file, a READY link and a comment image, in each workspace.
    const attachments = await prisma.attachment.findMany({ where: { workspaceId: mekari.id }, orderBy: { createdAt: 'asc' } });
    expect(attachments.map((a) => [a.kind, a.mimeType ?? a.previewStatus, a.commentId !== null, a.hasThumbnail])).toEqual([
      ['FILE', 'image/png', false, true],
      ['FILE', 'application/pdf', false, false],
      ['FILE', 'text/plain', false, false],
      ['LINK', 'READY', false, false],
      ['FILE', 'image/png', true, true],
    ]);
    expect(attachments.some((a) => a.draft)).toBe(false);
    for (const a of attachments.filter((x) => x.storageKey)) {
      expect(await ctx.app.storage.stat(a.storageKey!), a.name ?? '').not.toBeNull();
    }
    expect(await prisma.attachment.count({ where: { workspace: { name: 'Acme Pilot' } } })).toBe(5);
    expect(await prisma.comment.count({ where: { task: { workspaceId: mekari.id } } })).toBe(7); // 6 + the one with an image
    expect(await prisma.notification.count({ where: { type: 'MENTIONED' } })).toBe(2);
    expect(new Set((await prisma.task.findMany({ where: { workspaceId: mekari.id }, select: { assigneeId: true } })).map((t) => t.assigneeId)).size).toBe(4); // 3 users + unassigned


    // §10 cascade: company → 2 team goals → 3 individual goals, all in the current quarter.
    const goals = await prisma.goal.findMany();
    const company = goals.find((g) => g.isCompany)!;
    const teamGoals = goals.filter((g) => g.teamId && g.parentId === company.id);
    expect(teamGoals).toHaveLength(2);
    const individual = goals.filter((g) => !g.isCompany && !g.teamId);
    expect(individual).toHaveLength(3);
    expect(individual.every((g) => teamGoals.some((t) => t.id === g.parentId))).toBe(true);
    expect(new Set(goals.map((g) => g.timePeriod))).toEqual(new Set([currentPeriods('Asia/Jakarta')[2]]));
    expect(await prisma.goalProject.count()).toBe(1);
    expect(await prisma.goalUpdate.count()).toBe(3);
    const adminCookie = await login(ctx.app, 'admin@example.com', SEED_PASSWORD);
    const detail = (await ctx.app.inject({ method: 'GET', url: `/api/v1/goals/${company.id}`, headers: { cookie: adminCookie } })).json();
    expect(detail.progress).toBeGreaterThan(0);
    expect(detail.progress).toBeLessThan(100);

    // §12: the default workspace is an organization on the seed users' domain.
    expect(await prisma.workspace.findFirstOrThrow({ where: { name: 'Mekari' } })).toMatchObject({ isOrganization: true, domain: 'example.com' });
    // Second workspace: alice ADMIN, bob MEMBER, a guest on its one project, one team, 8 tasks.
    const acme = await prisma.workspace.findFirstOrThrow({ where: { name: 'Acme Pilot' }, include: { members: { include: { user: true } } } });
    expect(Object.fromEntries(acme.members.map((m) => [m.user.email, m.role]))).toEqual({
      'alice@example.com': 'ADMIN',
      'bob@example.com': 'MEMBER',
      'guest@partner.test': 'GUEST',
    });
    const acmeProjects = await prisma.project.findMany({ where: { workspaceId: acme.id }, include: { members: { include: { user: true } } } });
    expect(acmeProjects.map((p) => p.name)).toEqual(['Pilot Rollout']);
    expect(acmeProjects[0]!.members.map((m) => m.user.email)).toContain('guest@partner.test');
    expect(await login(ctx.app, 'guest@partner.test', SEED_PASSWORD)).toMatch(/^sid=/);
    expect(await prisma.task.count({ where: { workspaceId: acme.id, project: { workspaceId: acme.id } } })).toBe(8);

    await resetDatabase(prisma);
    expect(await databaseIsEmpty(prisma)).toBe(true);
  });

  it('--goals-only adds the cascade to a seeded database without goals, and is otherwise a no-op', async () => {
    await seed(ctx.app);
    await prisma.goal.deleteMany();
    // Users may have changed passwords on a live DB; goals-only doesn't log in.
    await prisma.user.updateMany({ data: { passwordHash: 'changed' } });
    const tasksBefore = await prisma.task.count();

    expect(await seedGoalsOnly(ctx.app)).toEqual({ goals: 6 });
    expect(await prisma.goal.count()).toBe(6);
    expect(await prisma.goalProject.count()).toBe(1);
    expect(await prisma.task.count()).toBe(tasksBefore);

    expect(await seedGoalsOnly(ctx.app)).toEqual({ skipped: 'goals already exist' });
    expect(await prisma.goal.count()).toBe(6);
  });

  it('--workspaces-demo adds Acme Pilot to a v1.1-style database once, changing nothing else', async () => {
    await seed(ctx.app);
    const acme = await prisma.workspace.findFirstOrThrow({ where: { name: 'Acme Pilot' } });
    await prisma.$transaction((tx) => deleteWorkspace(tx, acme.id));
    await prisma.user.updateMany({ data: { passwordHash: 'changed' } });
    const before = { tasks: await prisma.task.count(), users: await prisma.user.findMany({ orderBy: { email: 'asc' } }) };

    expect(await seedWorkspacesDemo(ctx.app)).toEqual({ tasks: 8 });
    expect(await prisma.task.count()).toBe(before.tasks + 8);
    // Nobody's current workspace (or anything else about them) changes.
    expect(await prisma.user.findMany({ orderBy: { email: 'asc' } })).toEqual(before.users);

    expect(await seedWorkspacesDemo(ctx.app)).toEqual({ skipped: 'workspace "Acme Pilot" already exists' });
    expect(await prisma.workspace.count({ where: { name: 'Acme Pilot' } })).toBe(1);
  });

  it('--workspaces-demo skips without alice and bob', async () => {
    expect(await seedWorkspacesDemo(ctx.app)).toEqual({ skipped: 'seed user alice@example.com is missing or inactive' });
    expect(await prisma.workspace.count()).toBe(0);
  });

  it('--goals-only skips cleanly when the seed users, teams or project are gone', async () => {
    expect(await seedGoalsOnly(ctx.app)).toEqual({ skipped: 'admin@example.com is missing or no longer an admin' });
    await seed(ctx.app);
    await prisma.goal.deleteMany();
    await prisma.project.updateMany({ where: { name: 'Mobile App v2' }, data: { name: 'Renamed' } });
    expect(await seedGoalsOnly(ctx.app)).toEqual({ skipped: 'project "Mobile App v2" is missing' });
    expect(await prisma.goal.count()).toBe(0);
  });
});

