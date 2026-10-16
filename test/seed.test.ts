import { describe, expect, it } from 'vitest';
import { databaseIsEmpty, resetDatabase, seed, SEED_PASSWORD } from '../src/lib/seed.js';
import { login, prisma, setupApp } from './helpers.js';
import { currentPeriods } from '../src/lib/time.js';

const ctx = setupApp();

describe('seed (SPEC §7)', () => {
  it('creates the demo workspace through the API', async () => {
    expect(await databaseIsEmpty(prisma)).toBe(true);
    const counts = await seed(ctx.app);
    expect(counts).toEqual({ users: 3, teams: 2, projects: 3, tasks: 34, goals: 6 });

    const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@example.com' } });
    expect(admin.role).toBe('ADMIN');
    for (const email of ['admin@example.com', 'alice@example.com', 'bob@example.com']) {
      expect(await login(ctx.app, email, SEED_PASSWORD)).toMatch(/^sid=/);
    }
    expect((await prisma.team.findMany({ orderBy: { name: 'asc' } })).map((t) => t.name)).toEqual(['Engineering', 'Marketing']);
    expect(await prisma.section.count()).toBe(9);
    expect(await prisma.task.count({ where: { parentId: { not: null } } })).toBe(5);
    expect(await prisma.task.count({ where: { completed: true } })).toBeGreaterThan(3);
    expect(await prisma.comment.count()).toBe(6);
    expect(await prisma.notification.count({ where: { type: 'MENTIONED' } })).toBe(2);
    expect(new Set((await prisma.task.findMany({ select: { assigneeId: true } })).map((t) => t.assigneeId)).size).toBe(4); // 3 users + unassigned


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

    await resetDatabase(prisma);
    expect(await databaseIsEmpty(prisma)).toBe(true);
  });
});
