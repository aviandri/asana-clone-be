import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { User } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { addDays, mondayOf, zonedDate, zonedDayStart } from '../src/lib/time.js';
import { UTF8_BOM } from '../src/lib/csv.js';
import { prisma, setupApp, signedIn, defaultWorkspaceId } from './helpers.js';

const ctx = setupApp();
const TZ = 'Asia/Jakarta'; // the default APP_TIMEZONE

type Session = { user: User; cookie: string };
let admin: Session;
let alice: Session; // Engineering, owns the projects
let bob: Session; // Engineering
let carol: Session; // no team
let engId: string;
let project: { id: string; workspaceId: string; sections: { id: string; name: string }[] };
const today = () => zonedDate(TZ);

beforeEach(async () => {
  admin = await signedIn(ctx.app, { name: 'Admin', role: 'ADMIN' });
  alice = await signedIn(ctx.app, { name: 'Alice' });
  bob = await signedIn(ctx.app, { name: 'Bob' });
  carol = await signedIn(ctx.app, { name: 'Carol' });
  engId = (
    await prisma.team.create({
      data: { workspaceId: await defaultWorkspaceId(), name: 'Engineering', members: { create: [{ userId: alice.user.id }, { userId: bob.user.id }] } },
    })
  ).id;
  project = (await req(alice, 'POST', '/projects', { teamId: engId, name: 'Website Redesign', color: '#112233' })).json();
});

function req(s: Session, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object, app = ctx.app) {
  return app.inject({ method, url: `/api/v1${url}`, headers: { cookie: s.cookie }, payload });
}

type TaskInput = {
  title?: string;
  projectId?: string | null;
  sectionId?: string | null;
  parentId?: string;
  assigneeId?: string;
  priority?: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';
  dueDate?: string;
  completedAt?: Date;
  createdAt?: Date;
};

/** Inserts a task directly so timestamps can be set precisely. */
async function task(t: TaskInput) {
  return prisma.task.create({
    data: {
      workspaceId: project.workspaceId,
      title: t.title ?? 'Task',
      projectId: t.projectId === undefined ? project.id : t.projectId,
      sectionId: t.sectionId ?? null,
      parentId: t.parentId,
      assigneeId: t.assigneeId,
      creatorId: alice.user.id,
      priority: t.priority ?? 'NONE',
      dueDate: t.dueDate ? new Date(`${t.dueDate}T00:00:00Z`) : null,
      completed: !!t.completedAt,
      completedAt: t.completedAt ?? null,
      ...(t.createdAt ? { createdAt: t.createdAt } : {}),
    },
  });
}

describe('GET /projects/:id/report', () => {
  it('computes totals and slices by section, assignee and priority', async () => {
    const [todo, doing] = project.sections;
    const yesterday = addDays(today(), -1);
    const parent = await task({ sectionId: todo!.id, assigneeId: bob.user.id, priority: 'HIGH', dueDate: yesterday }); // overdue
    await task({ parentId: parent.id, assigneeId: alice.user.id }); // subtask → counts under "To do"
    await task({ sectionId: doing!.id, assigneeId: bob.user.id, completedAt: new Date(), priority: 'LOW' });
    await task({ sectionId: doing!.id }); // unassigned, incomplete
    await task({ sectionId: null, priority: 'HIGH', completedAt: new Date() }); // no section

    const res = await req(bob, 'GET', `/projects/${project.id}/report`);
    expect(res.statusCode).toBe(200);
    const r = res.json();
    expect(r.project).toEqual({ id: project.id, name: 'Website Redesign', color: '#112233' });
    expect(r.totals).toEqual({ total: 5, completed: 2, incomplete: 3, overdue: 1, unassigned: 1, percentComplete: 40 });
    expect(r.bySection).toEqual([
      { sectionId: todo!.id, name: 'To do', total: 2, completed: 0, overdue: 1 },
      { sectionId: doing!.id, name: 'In progress', total: 2, completed: 1, overdue: 0 },
      { sectionId: project.sections[2]!.id, name: 'Done', total: 0, completed: 0, overdue: 0 },
      { sectionId: null, name: 'No section', total: 1, completed: 1, overdue: 0 },
    ]);
    expect(r.byAssignee.map((a: { assignee: { name: string } | null; incomplete: number; completed: number; overdue: number }) => [a.assignee?.name ?? null, a.incomplete, a.completed, a.overdue])).toEqual([
      ['Alice', 1, 0, 0],
      ['Bob', 1, 1, 1],
      [null, 1, 1, 0],
    ]);
    expect(r.byPriority).toEqual([
      { priority: 'HIGH', total: 2, incomplete: 1 },
      { priority: 'MEDIUM', total: 0, incomplete: 0 },
      { priority: 'LOW', total: 1, incomplete: 0 },
      { priority: 'NONE', total: 2, incomplete: 2 },
    ]);
  });

  it('lists upcoming incomplete tasks due today..+14 days, by due date, max 20', async () => {
    await task({ title: 'in 3 days', dueDate: addDays(today(), 3) });
    await task({ title: 'today', dueDate: today() });
    await task({ title: 'in 14 days', dueDate: addDays(today(), 14) });
    await task({ title: 'in 15 days', dueDate: addDays(today(), 15) });
    await task({ title: 'overdue', dueDate: addDays(today(), -1) });
    await task({ title: 'done', dueDate: today(), completedAt: new Date() });
    for (let i = 0; i < 20; i++) await task({ title: `bulk ${i}`, dueDate: addDays(today(), 10) });

    const upcoming = (await req(alice, 'GET', `/projects/${project.id}/report`)).json().upcoming;
    expect(upcoming).toHaveLength(20);
    expect(upcoming.slice(0, 2).map((t: { title: string }) => t.title)).toEqual(['today', 'in 3 days']);
    expect(upcoming[0]).toHaveProperty('subtaskCount'); // full Task shape
    expect(upcoming.map((t: { title: string }) => t.title)).not.toContain('in 15 days');
  });

  it('buckets the weekly trend by APP_TIMEZONE Monday weeks', async () => {
    const monday = mondayOf(today());
    const weekStartUtc = zonedDayStart(monday, TZ).getTime();
    // 00:30 Monday in Jakarta = 17:30 Sunday UTC: this week in Jakarta, last week in UTC.
    await task({ title: 'just after', createdAt: new Date(weekStartUtc + 30 * 60_000) });
    // 23:30 Sunday in Jakarta: last week in both zones.
    await task({ title: 'just before', createdAt: new Date(weekStartUtc - 30 * 60_000), completedAt: new Date(weekStartUtc + 60_000) });

    const trend = (await req(alice, 'GET', `/projects/${project.id}/report?weeks=2`)).json().trend;
    expect(trend).toEqual([
      { weekStart: addDays(monday, -7), created: 1, completed: 0, open: 1 },
      { weekStart: monday, created: 1, completed: 1, open: 1 },
    ]);

    // The same data in a UTC app: both tasks were created in the previous UTC week.
    const utcApp: FastifyInstance = await buildApp({ config: { ...loadConfig(), APP_TIMEZONE: 'UTC' }, prisma, logger: false });
    try {
      const utcMonday = mondayOf(zonedDate('UTC'));
      const utcTrend = (await req(alice, 'GET', `/projects/${project.id}/report?weeks=2`, undefined, utcApp)).json().trend;
      const created = Object.fromEntries(utcTrend.map((w: { weekStart: string; created: number }) => [w.weekStart, w.created]));
      // When UTC and Jakarta are in the same week, the "just after" task moves to the earlier week.
      if (utcMonday === monday) expect(created).toEqual({ [addDays(monday, -7)]: 2, [monday]: 0 });
    } finally {
      await utcApp.close();
    }
  });

  it('validates weeks and hides invisible projects', async () => {
    expect((await req(alice, 'GET', `/projects/${project.id}/report?weeks=53`)).statusCode).toBe(400);
    expect((await req(alice, 'GET', `/projects/${project.id}/report?weeks=0`)).statusCode).toBe(400);
    expect((await req(alice, 'GET', `/projects/${project.id}/report`)).json().trend).toHaveLength(12);
    expect((await req(carol, 'GET', `/projects/${project.id}/report`)).statusCode).toBe(404);
  });
});

describe('GET /reports/overview', () => {
  it('summarises visible, non-archived projects by name with last activity', async () => {
    const other = (await req(alice, 'POST', '/projects', { teamId: engId, name: 'Apps', privacy: 'PUBLIC' })).json();
    const archived = (await req(alice, 'POST', '/projects', { teamId: engId, name: 'Old', privacy: 'PUBLIC' })).json();
    await req(alice, 'PATCH', `/projects/${archived.id}`, { archived: true });

    await task({ dueDate: addDays(today(), -2) }); // overdue in Website Redesign
    await task({ completedAt: new Date() });
    const t = (await req(alice, 'POST', '/tasks', { title: 'via API', projectId: other.id })).json(); // CREATED activity
    await req(bob, 'POST', `/tasks/${t.id}/comments`, { body: 'hi' });

    const r = (await req(bob, 'GET', '/reports/overview')).json();
    expect(r.totals).toEqual({ total: 3, completed: 1, incomplete: 2, overdue: 1, projects: 2 });
    expect(r.projects.map((p: { project: { name: string } }) => p.project.name)).toEqual(['Apps', 'Website Redesign']);
    const [apps, web] = r.projects;
    expect(apps).toMatchObject({ total: 1, completed: 0, incomplete: 1, overdue: 0, percentComplete: 0 });
    expect(Date.parse(apps.lastActivityAt)).not.toBeNaN();
    expect(apps.project).toHaveProperty('myRole');
    expect(web).toMatchObject({ total: 2, completed: 1, percentComplete: 50, lastActivityAt: null });

    // Carol only sees the PUBLIC project; a team filter narrows the list.
    const asCarol = (await req(carol, 'GET', '/reports/overview')).json();
    expect(asCarol.projects.map((p: { project: { name: string } }) => p.project.name)).toEqual(['Apps']);
    const otherTeam = await prisma.team.create({ data: { workspaceId: await defaultWorkspaceId(), name: 'Marketing' } });
    expect((await req(bob, 'GET', `/reports/overview?teamId=${otherTeam.id}`)).json()).toEqual({
      totals: { total: 0, completed: 0, incomplete: 0, overdue: 0, projects: 0 },
      projects: [],
    });
  });
});

describe('GET /reports/workload', () => {
  it('defaults to this Monday..Sunday and counts open/overdue/due/completed per user', async () => {
    const monday = mondayOf(today());
    const start = zonedDayStart(monday, TZ).getTime();
    await task({ assigneeId: bob.user.id, dueDate: addDays(monday, -30) }); // open + overdue, before the range
    await task({ assigneeId: bob.user.id, dueDate: addDays(monday, 6) }); // open + due in range (Sunday: never overdue this week)
    await task({ assigneeId: bob.user.id, dueDate: addDays(monday, 7) }); // open, due after range
    await task({ assigneeId: bob.user.id, dueDate: monday, completedAt: new Date(start + 60_000) }); // completed in range (not due-in-range: done)
    await task({ assigneeId: bob.user.id, completedAt: new Date(start - 60_000) }); // completed just before the range (Sunday 23:59 local)
    await task({ assigneeId: alice.user.id });

    const r = (await req(alice, 'GET', '/reports/workload')).json();
    expect([r.from, r.to]).toEqual([monday, addDays(monday, 6)]);
    const rows = Object.fromEntries(r.data.map((d: { user: { name: string } }) => [d.user.name, d]));
    expect(rows.Bob).toMatchObject({ open: 3, overdue: 1, dueInRange: 1, completedInRange: 1 });
    expect(rows.Alice).toMatchObject({ open: 1, overdue: 0, dueInRange: 0, completedInRange: 0 });
    expect(r.data.map((d: { user: { name: string } }) => d.user.name)).toEqual(['Bob', 'Alice', 'Admin', 'Carol']);
  });

  it('follows §4 visibility for the caller and narrows to a team', async () => {
    const secret = (await req(alice, 'POST', '/projects', { teamId: engId, name: 'Secret', privacy: 'PRIVATE' })).json();
    await task({ projectId: secret.id, assigneeId: bob.user.id });
    await task({ projectId: null, assigneeId: bob.user.id }); // bob's personal task (created by alice → visible to alice and bob)
    await task({ assigneeId: bob.user.id }); // TEAM project

    const open = async (s: Session, qs = '') =>
      (await req(s, 'GET', `/reports/workload${qs}`)).json().data.find((d: { user: { id: string } }) => d.user.id === bob.user.id)?.open;
    expect(await open(admin)).toBe(3);
    expect(await open(alice)).toBe(3); // owner of Secret, creator of the personal task
    expect(await open(carol)).toBe(0); // sees none of them
    // With teamId: team members only, and only the team's projects (no personal tasks).
    const team = (await req(admin, 'GET', `/reports/workload?teamId=${engId}`)).json();
    expect(team.data.map((d: { user: { name: string } }) => d.user.name).sort()).toEqual(['Alice', 'Bob']);
    expect(await open(admin, `?teamId=${engId}`)).toBe(2);
  });

  it('validates the range', async () => {
    expect((await req(alice, 'GET', '/reports/workload?from=2026-10-10&to=2026-10-01')).statusCode).toBe(400);
    expect((await req(alice, 'GET', '/reports/workload?from=2026-01-01&to=2026-04-03')).statusCode).toBe(400); // 93 days
    const ok = await req(alice, 'GET', '/reports/workload?from=2026-01-01&to=2026-04-02'); // exactly 92 days
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ from: '2026-01-01', to: '2026-04-02' });
    expect((await req(alice, 'GET', '/reports/workload?from=01-01-2026')).statusCode).toBe(400);
    expect((await req(alice, 'GET', '/reports/workload?teamId=00000000-0000-0000-0000-000000000000')).statusCode).toBe(404);
  });
});

describe('GET /projects/:id/tasks.csv', () => {
  it('exports tasks with subtasks after their parent, escaped, as an attachment', async () => {
    const [todo] = project.sections;
    const parent = await task({ title: 'Launch, "v2"', sectionId: todo!.id, assigneeId: bob.user.id, priority: 'HIGH', dueDate: '2026-11-01' });
    await task({ title: '=cmd|calc', parentId: parent.id });
    await task({ title: 'Loose end', sectionId: null, completedAt: new Date('2026-10-01T10:00:00Z') });

    const res = await req(alice, 'GET', `/projects/${project.id}/tasks.csv`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="website-redesign-tasks.csv"');
    expect(res.body.startsWith(UTF8_BOM)).toBe(true);
    const lines = res.body.slice(1).split('\r\n');
    expect(lines.at(-1)).toBe(''); // trailing CRLF
    expect(lines[0]).toBe('id,title,section,parent_task_id,assignee_name,assignee_email,priority,start_date,due_date,completed,completed_at,created_at');
    expect(lines[1]).toMatch(new RegExp(`^${parent.id},"Launch, ""v2""",To do,,Bob,${bob.user.email.replace('.', '\\.')},HIGH,,2026-11-01,false,,\\d{4}-`));
    expect(lines[2]).toMatch(new RegExp(`^[0-9a-f-]+,'=cmd\\|calc,To do,${parent.id},,,NONE,,,false,,`));
    expect(lines[3]).toMatch(/,Loose end,,,,,NONE,,,true,2026-10-01T10:00:00\.000Z,/);
    expect(lines).toHaveLength(5);
  });

  it('is 404 for users who cannot see the project', async () => {
    expect((await req(carol, 'GET', `/projects/${project.id}/tasks.csv`)).statusCode).toBe(404);
  });
});
