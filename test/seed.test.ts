import { describe, expect, it } from 'vitest';
import { databaseIsEmpty, resetDatabase, seed, SEED_PASSWORD } from '../src/lib/seed.js';
import { login, prisma, setupApp } from './helpers.js';

const ctx = setupApp();

describe('seed (SPEC §7)', () => {
  it('creates the demo workspace through the API', async () => {
    expect(await databaseIsEmpty(prisma)).toBe(true);
    const counts = await seed(ctx.app);
    expect(counts).toEqual({ users: 3, teams: 2, projects: 3, tasks: 34 });

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

    await resetDatabase(prisma);
    expect(await databaseIsEmpty(prisma)).toBe(true);
  });
});
