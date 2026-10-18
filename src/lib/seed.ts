import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { projectAccess } from './access.js';
import { hashPassword } from './password.js';
import { SESSION_COOKIE } from '../plugins/auth.js';
import { currentPeriods } from './time.js';
import { deleteWorkspace, WORKSPACE_HEADER } from './workspaces.js';

/**
 * Demo data for SPEC §7. It goes through the real API (app.inject), so followers, activity and
 * notifications look like real usage. Due dates are relative to today, so the views stay useful.
 */
export const SEED_PASSWORD = 'password123';

const USERS = [
  { key: 'admin', email: 'admin@example.com', name: 'Ada Admin', role: 'ADMIN', avatarColor: '#7a6ff0' },
  { key: 'alice', email: 'alice@example.com', name: 'Alice Johnson', role: 'MEMBER', avatarColor: '#e8384f' },
  { key: 'bob', email: 'bob@example.com', name: 'Bob Smith', role: 'MEMBER', avatarColor: '#20aaea' },
] as const;
type Who = (typeof USERS)[number]['key'];

type TaskSpec = {
  title: string;
  section: number;
  assignee?: Who;
  due?: number; // days from today
  start?: number;
  priority?: 'LOW' | 'MEDIUM' | 'HIGH';
  done?: boolean;
  description?: string;
  subtasks?: { title: string; assignee?: Who; done?: boolean }[];
  comments?: { by: Who; body: string }[];
};

type ProjectSpec = {
  team: 'Engineering' | 'Marketing';
  owner: Who;
  name: string;
  description: string;
  color: string;
  privacy: 'PUBLIC' | 'TEAM' | 'PRIVATE';
  defaultView: 'LIST' | 'BOARD' | 'CALENDAR';
  members?: { who: Who; role: 'EDITOR' | 'COMMENTER' }[];
  tasks: TaskSpec[];
};

const PROJECTS: ProjectSpec[] = [
  {
    team: 'Engineering',
    owner: 'alice',
    name: 'Website Redesign',
    description: 'New marketing site: design system, CMS migration and launch.',
    color: '#4186e0',
    privacy: 'TEAM',
    defaultView: 'BOARD',
    tasks: [
      {
        title: 'Audit current site analytics',
        section: 2,
        assignee: 'alice',
        due: -12,
        priority: 'MEDIUM',
        done: true,
        comments: [{ by: 'alice', body: 'Top 20 pages account for 80% of traffic. Notes in the drive.' }],
      },
      { title: 'Define design tokens', section: 2, assignee: 'bob', due: -5, priority: 'HIGH', done: true },
      {
        title: 'Build component library',
        section: 1,
        assignee: 'bob',
        start: -3,
        due: 6,
        priority: 'HIGH',
        description: 'Buttons, inputs, cards, nav. Storybook for each.',
        subtasks: [
          { title: 'Buttons & links', assignee: 'bob', done: true },
          { title: 'Form inputs', assignee: 'bob' },
          { title: 'Navigation', assignee: 'alice' },
        ],
        comments: [
          { by: 'alice', body: 'Can we ship the nav first? Marketing wants a preview. @[Bob Smith](bob)' },
          { by: 'bob', body: 'Sure, will reorder. Buttons are done already.' },
        ],
      },
      { title: 'Migrate blog posts to new CMS', section: 1, assignee: 'alice', due: 10, priority: 'MEDIUM' },
      { title: 'Write launch checklist', section: 0, assignee: 'alice', due: 14, priority: 'LOW' },
      { title: 'Set up redirects for old URLs', section: 0, assignee: 'bob', due: 18 },
      { title: 'Accessibility review', section: 0, due: 21, priority: 'MEDIUM' },
      { title: 'Performance budget & Lighthouse CI', section: 0, assignee: 'bob', due: 25 },
      { title: 'Stakeholder demo', section: 0, assignee: 'admin', due: 3, priority: 'HIGH' },
      { title: 'Update favicon & social images', section: 0 },
    ],
  },
  {
    team: 'Engineering',
    owner: 'bob',
    name: 'Mobile App v2',
    description: 'Offline mode, push notifications and the new onboarding flow.',
    color: '#62d26f',
    privacy: 'PUBLIC',
    defaultView: 'LIST',
    members: [{ who: 'alice', role: 'EDITOR' }],
    tasks: [
      {
        title: 'Offline sync spike',
        section: 2,
        assignee: 'bob',
        due: -8,
        priority: 'HIGH',
        done: true,
        comments: [{ by: 'bob', body: 'CRDTs are overkill for us; last-write-wins per field is fine.' }],
      },
      {
        title: 'Push notification service',
        section: 1,
        assignee: 'bob',
        start: -2,
        due: 4,
        priority: 'HIGH',
        subtasks: [
          { title: 'APNs certificates', assignee: 'admin', done: true },
          { title: 'FCM integration', assignee: 'bob' },
        ],
      },
      { title: 'Onboarding screens', section: 1, assignee: 'alice', due: 7, priority: 'MEDIUM' },
      { title: 'Crash reporting setup', section: 0, assignee: 'bob', due: 2, priority: 'MEDIUM' },
      { title: 'App Store screenshots', section: 0, assignee: 'alice', due: 20, priority: 'LOW' },
      { title: 'Beta tester recruitment', section: 0, assignee: 'admin', due: 12 },
      { title: 'Dark mode QA pass', section: 0, due: 16 },
      { title: 'Fix login spinner on slow networks', section: 0, assignee: 'bob', due: -1, priority: 'HIGH' },
      { title: 'Release notes for 2.0', section: 0, assignee: 'alice', due: 28 },
    ],
  },
  {
    team: 'Marketing',
    owner: 'alice',
    name: 'Q4 Campaign',
    description: 'Holiday campaign across email, social and paid.',
    color: '#fd9a00',
    privacy: 'TEAM',
    defaultView: 'CALENDAR',
    members: [{ who: 'bob', role: 'COMMENTER' }],
    tasks: [
      { title: 'Campaign brief', section: 2, assignee: 'alice', due: -15, priority: 'HIGH', done: true },
      {
        title: 'Creative concepts',
        section: 1,
        assignee: 'alice',
        due: 1,
        priority: 'HIGH',
        comments: [
          { by: 'admin', body: 'Love concept B. @[Alice Johnson](alice) can we test both in paid?' },
          { by: 'bob', body: 'From the eng side: landing page variants are easy with the new site.' },
        ],
      },
      { title: 'Email sequence copy', section: 1, assignee: 'alice', due: 5, priority: 'MEDIUM' },
      { title: 'Social calendar', section: 0, assignee: 'admin', due: 8 },
      { title: 'Paid budget approval', section: 0, assignee: 'admin', due: 2, priority: 'HIGH' },
      { title: 'Influencer outreach list', section: 0, assignee: 'alice', due: 11, priority: 'LOW' },
      { title: 'Landing page brief', section: 0, assignee: 'alice', due: 9 },
      { title: 'Post-campaign report template', section: 0, due: 35 },
      { title: 'Holiday promo codes', section: 0, assignee: 'admin', due: 13, priority: 'MEDIUM' },
    ],
  },
];

function dayOffset(days: number, today = new Date()): string {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + days));
  return d.toISOString().slice(0, 10);
}

/** `--reset` wipes everything; in production it also needs `--force-production`. */
export function resetRefusal(nodeEnv: string | undefined, forceProduction: boolean): string | null {
  if (nodeEnv === 'production' && !forceProduction) {
    return 'Refusing to --reset a production database. Pass --force-production as well if you really mean it.';
  }
  return null;
}

export async function databaseIsEmpty(db: PrismaClient) {
  return (await db.user.count()) === 0;
}

/** Empties every application table (keeps Prisma's migration bookkeeping). */
export async function resetDatabase(db: PrismaClient) {
  const rows = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (rows.length === 0) return;
  await db.$executeRawUnsafe(`TRUNCATE ${rows.map((r) => `"public"."${r.tablename}"`).join(', ')} CASCADE`);
}

export async function seed(app: FastifyInstance) {
  const db = app.db;
  const passwordHash = await hashPassword(SEED_PASSWORD);
  const ids = {} as Record<Who, string>;
  const cookies = {} as Record<Who, string>;

  // SPEC §12: all the v1 demo data lives in the default workspace, an organization on the seed
  // users' domain.
  const workspace = await db.workspace.create({
    data: { name: app.config.DEFAULT_WORKSPACE_NAME, color: '#4186e0', isOrganization: true, domain: 'example.com' },
  });
  for (const u of USERS) {
    const user = await db.user.create({
      data: {
        email: u.email,
        name: u.name,
        avatarColor: u.avatarColor,
        passwordHash,
        lastWorkspaceId: workspace.id,
        workspaceMemberships: { create: { workspaceId: workspace.id, role: u.role } },
      },
    });
    ids[u.key] = user.id;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: u.email, password: SEED_PASSWORD },
    });
    const sid = res.cookies.find((c) => c.name === 'sid');
    if (!sid) throw new Error(`Seed login failed for ${u.email}: ${res.body}`);
    cookies[u.key] = `sid=${sid.value}`;
  }

  const call = makeCaller(app, cookies, workspace.id);

  const mention = (body: string) => body.replace(/@\[([^\]]+)\]\((\w+)\)/g, (_m, name, key: Who) => `@[${name}](${ids[key]})`);

  const teams: Record<string, string> = {};
  for (const [name, description, members] of [
    ['Engineering', 'Product engineering: web and mobile.', ['alice', 'bob']],
    ['Marketing', 'Brand, content and campaigns.', ['alice']],
  ] as const) {
    const team = await call('admin', 'POST', '/teams', { name, description });
    for (const who of members) await call('admin', 'POST', `/teams/${team.id}/members`, { userId: ids[who] });
    teams[name] = team.id;
  }

  let taskCount = 0;
  const projectIds: Record<string, string> = {};
  for (const p of PROJECTS) {
    const project = await call<{ id: string; sections: { id: string }[] }>(p.owner, 'POST', '/projects', {
      teamId: teams[p.team],
      name: p.name,
      description: p.description,
      color: p.color,
      privacy: p.privacy,
      defaultView: p.defaultView,
    });
    projectIds[p.name] = project.id;
    for (const m of p.members ?? []) {
      await call(p.owner, 'POST', `/projects/${project.id}/members`, { userId: ids[m.who], role: m.role });
    }
    for (const t of p.tasks) {
      const task = await call(p.owner, 'POST', '/tasks', {
        title: t.title,
        projectId: project.id,
        sectionId: project.sections[t.section]!.id,
        description: t.description,
        assigneeId: t.assignee ? ids[t.assignee] : undefined,
        dueDate: t.due === undefined ? undefined : dayOffset(t.due),
        startDate: t.start === undefined ? undefined : dayOffset(t.start),
        priority: t.priority,
      });
      taskCount += 1;
      for (const s of t.subtasks ?? []) {
        const sub = await call(p.owner, 'POST', '/tasks', {
          title: s.title,
          parentId: task.id,
          assigneeId: s.assignee ? ids[s.assignee] : undefined,
        });
        taskCount += 1;
        if (s.done) await call(s.assignee ?? p.owner, 'PATCH', `/tasks/${sub.id}`, { completed: true });
      }
      for (const c of t.comments ?? []) {
        await call(c.by, 'POST', `/tasks/${task.id}/comments`, { body: mention(c.body) });
      }
      if (t.done) await call(t.assignee ?? p.owner, 'PATCH', `/tasks/${task.id}`, { completed: true });
    }
  }

  // A personal task, to show My Tasks content outside projects.
  await call('alice', 'POST', '/tasks', { title: 'Book dentist appointment', assigneeId: ids.alice, dueDate: dayOffset(4) });
  taskCount += 1;

  const goals = await seedGoals(call, ids, teams, projectIds, currentPeriods(app.config.APP_TIMEZONE)[2]!);
  const demo = await seedWorkspacesDemo(app);
  if ('skipped' in demo) throw new Error(`Seeding "${ACME}" failed: ${demo.skipped}`);

  return {
    workspaces: 2,
    users: USERS.length,
    teams: Object.keys(teams).length + 1,
    projects: PROJECTS.length + 1,
    tasks: taskCount + demo.tasks,
    goals,
  };
}

type Call = <T = { id: string }>(who: Who, method: 'POST' | 'PATCH', url: string, payload: object) => Promise<T>;

/** API calls as a seed user inside one workspace (sent as X-Workspace-Id). */
function makeCaller(
  app: FastifyInstance,
  cookies: Partial<Record<Who, string>>,
  workspaceId: string,
  onCreated?: (url: string, id: string) => void,
): Call {
  return async <T = { id: string }>(who: Who, method: 'POST' | 'PATCH', url: string, payload: object) => {
    const res = await app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { cookie: cookies[who] ?? '', [WORKSPACE_HEADER]: workspaceId },
      payload,
    });
    if (res.statusCode >= 300) throw new Error(`Seed ${method} ${url} failed (${res.statusCode}): ${res.body}`);
    const body = res.json();
    if (method === 'POST' && onCreated && body?.id) onCreated(url, body.id);
    return body as T;
  };
}

/**
 * `npm run seed -- --goals-only`: adds the §10 goal cascade to an existing database that was
 * seeded before goals existed (e.g. a live preview). Non-destructive. It runs only while there
 * are no goals, and only if the seed users, teams and project are still there and still have the
 * access the cascade needs. Otherwise it skips with a reason. Sessions are minted directly
 * (users may have changed their passwords). If a step fails, the goals it created are removed.
 */
export async function seedGoalsOnly(app: FastifyInstance): Promise<{ goals: number } | { skipped: string }> {
  const db = app.db;
  // The demo data's workspace: the oldest one admin@example.com is an active ADMIN of.
  const adminOf = await db.workspaceMember.findFirst({
    where: { user: { email: 'admin@example.com' }, role: 'ADMIN', isActive: true },
    orderBy: [{ joinedAt: 'asc' }, { workspaceId: 'asc' }],
    select: { workspaceId: true },
  });
  if (!adminOf) return { skipped: 'admin@example.com is missing or no longer an admin' };
  const { workspaceId } = adminOf;
  if ((await db.goal.count({ where: { workspaceId } })) > 0) return { skipped: 'goals already exist' };

  const users = await db.user.findMany({ where: { email: { in: USERS.map((u) => u.email) } } });
  const ids = {} as Record<Who, string>;
  for (const u of USERS) {
    const found = users.find((x) => x.email === u.email);
    if (!found?.isActive) return { skipped: `seed user ${u.email} is missing or inactive` };
    ids[u.key] = found.id;
  }

  const teams: Record<string, string> = {};
  for (const [name, member] of [['Engineering', 'bob'], ['Marketing', 'alice']] as const) {
    const team = await db.team.findFirst({ where: { name, workspaceId }, select: { id: true } });
    if (!team) return { skipped: `team "${name}" is missing` };
    const isMember = await db.teamMember.count({ where: { teamId: team.id, userId: ids[member] } });
    if (!isMember) return { skipped: `${member}@example.com is no longer in team "${name}"` };
    teams[name] = team.id;
  }

  const project = await db.project.findFirst({ where: { name: 'Mobile App v2', workspaceId }, select: { id: true } });
  if (!project) return { skipped: 'project "Mobile App v2" is missing' };
  const bob = users.find((u) => u.id === ids.bob)!;
  const bobSees = await projectAccess(db, bob, project.id).then(() => true, () => false);
  if (!bobSees) return { skipped: 'bob@example.com can no longer see "Mobile App v2"' };

  const cookies = {} as Record<Who, string>;
  for (const u of USERS) cookies[u.key] = `${SESSION_COOKIE}=${app.jwt.sign({ sub: ids[u.key] })}`;
  const createdGoals: string[] = [];
  const call = makeCaller(app, cookies, workspaceId, (url, id) => {
    if (url === '/goals') createdGoals.push(id);
  });
  try {
    const goals = await seedGoals(call, ids, teams, { 'Mobile App v2': project.id }, currentPeriods(app.config.APP_TIMEZONE)[2]!);
    return { goals };
  } catch (err) {
    // KRs, links and updates cascade with their goals.
    await db.goal.deleteMany({ where: { id: { in: createdGoals } } });
    throw err;
  }
}

/**
 * SPEC §10 seed: a 3-level cascade for the current quarter. One company goal (SUB_GOALS) has two
 * team goals under it (one on PROJECTS, linked to Mobile App v2) and 3 individual goals with KRs,
 * plus a few status updates. Everything is in one quarter so the default Goals view shows the
 * whole tree.
 */
async function seedGoals(
  call: Call,
  ids: Record<Who, string>,
  teams: Record<string, string>,
  projectIds: Record<string, string>,
  quarter: string,
) {
  const goal = (who: Who, body: object) => call(who, 'POST', '/goals', { timePeriod: quarter, ...body });
  const kr = (who: Who, goalId: string, body: object) => call(who, 'POST', `/goals/${goalId}/key-results`, body);
  const update = (who: Who, goalId: string, status: string, body: string) =>
    call(who, 'POST', `/goals/${goalId}/updates`, { status, body });

  const company = await goal('admin', {
    title: 'Grow ARR to $5M',
    description: 'Company objective for the quarter: ship the mobile app and land the holiday campaign.',
    isCompany: true,
    progressSource: 'SUB_GOALS',
  });

  const eng = await goal('bob', {
    title: 'Ship Mobile App v2',
    teamId: teams.Engineering,
    parentId: company.id,
    progressSource: 'PROJECTS',
    weight: 2,
  });
  await call('bob', 'POST', `/goals/${eng.id}/projects`, { projectId: projectIds['Mobile App v2'] });

  const marketing = await goal('alice', {
    title: 'Holiday campaign drives 2,000 sign-ups',
    teamId: teams.Marketing,
    parentId: company.id,
    progressSource: 'SUB_GOALS',
  });

  const crashes = await goal('bob', { title: 'Cut crash rate below 0.5%', parentId: eng.id });
  await kr('bob', crashes.id, {
    title: 'Crash rate',
    metricType: 'PERCENT',
    startValue: 2.5,
    targetValue: 0.5,
    currentValue: 1.2,
    unit: '%',
    ownerId: ids.bob,
  });

  const newsletter = await goal('alice', { title: 'Grow the newsletter list', parentId: marketing.id });
  await kr('alice', newsletter.id, {
    title: 'Subscribers',
    metricType: 'NUMBER',
    startValue: 10_000,
    targetValue: 15_000,
    currentValue: 12_000,
    unit: 'subscribers',
    ownerId: ids.alice,
  });
  await kr('alice', newsletter.id, { title: 'Launch referral program', metricType: 'BOOLEAN', targetValue: 1, ownerId: ids.alice });

  const pilots = await goal('admin', { title: 'Close enterprise pilots', parentId: marketing.id, weight: 2 });
  await kr('admin', pilots.id, {
    title: 'Pipeline closed',
    metricType: 'CURRENCY',
    startValue: 0,
    targetValue: 500_000,
    currentValue: 200_000,
    unit: 'USD',
    ownerId: ids.admin,
  });
  await kr('admin', pilots.id, { title: 'Pilots signed', metricType: 'NUMBER', startValue: 0, targetValue: 5, currentValue: 2 });

  await update('admin', company.id, 'ON_TRACK', 'Mid-quarter check-in: both team goals moving.');
  await update('bob', eng.id, 'AT_RISK', 'Push notification service is slipping about a week.');
  await update('alice', newsletter.id, 'ON_TRACK', 'Referral program design is done; launch next sprint.');

  return 6;
}

// --- SPEC §12: second demo workspace ------------------------------------------------------

export const ACME = 'Acme Pilot';
export const GUEST_EMAIL = 'guest@partner.test';

const ACME_TASKS: { title: string; section: number; assignee?: 'alice' | 'bob'; due?: number; priority?: 'LOW' | 'MEDIUM' | 'HIGH'; done?: boolean }[] = [
  { title: 'Kick-off call with Acme', section: 2, assignee: 'alice', due: -6, priority: 'HIGH', done: true },
  { title: 'Collect pilot success criteria', section: 2, assignee: 'alice', due: -2, priority: 'MEDIUM', done: true },
  { title: 'Provision pilot accounts', section: 1, assignee: 'bob', due: 1, priority: 'HIGH' },
  { title: 'Import Acme’s existing projects', section: 1, assignee: 'bob', due: 4, priority: 'MEDIUM' },
  { title: 'Admin training session', section: 0, assignee: 'alice', due: 6 },
  { title: 'Weekly check-in agenda', section: 0, assignee: 'alice', due: 8, priority: 'LOW' },
  { title: 'Pilot feedback survey', section: 0, assignee: 'bob', due: 15 },
  { title: 'Go / no-go review', section: 0, due: 21, priority: 'HIGH' },
];

/**
 * Adds the "Acme Pilot" workspace: alice ADMIN, bob MEMBER, guest@partner.test GUEST on its one
 * project, one team and that project with 8 tasks.
 * Used by the full seed and by `npm run seed -- --workspaces-demo` on a live database: idempotent
 * (skips if the workspace exists) and additive (nothing existing is changed, not even anyone's
 * current workspace). Sessions are minted directly. If a step fails, the workspace is removed again.
 */
export async function seedWorkspacesDemo(app: FastifyInstance): Promise<{ tasks: number } | { skipped: string }> {
  const db = app.db;
  if (await db.workspace.findFirst({ where: { name: ACME }, select: { id: true } })) {
    return { skipped: `workspace "${ACME}" already exists` };
  }
  const ids = {} as Record<'alice' | 'bob', string>;
  for (const key of ['alice', 'bob'] as const) {
    const user = await db.user.findUnique({ where: { email: `${key}@example.com` } });
    if (!user?.isActive) return { skipped: `seed user ${key}@example.com is missing or inactive` };
    ids[key] = user.id;
  }

  const workspace = await db.workspace.create({
    data: {
      name: ACME,
      color: '#f06a6a',
      members: { create: [{ userId: ids.alice, role: 'ADMIN' }, { userId: ids.bob, role: 'MEMBER' }] },
    },
  });
  // The guest's only workspace is Acme Pilot, so it is also their current one.
  const guest =
    (await db.user.findUnique({ where: { email: GUEST_EMAIL } })) ??
    (await db.user.create({
      data: {
        email: GUEST_EMAIL,
        name: 'Gita Guest',
        avatarColor: '#aa62e3',
        passwordHash: await hashPassword(SEED_PASSWORD),
        lastWorkspaceId: workspace.id,
      },
    }));
  await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: guest.id, role: 'GUEST' } });
  const cookie = (id: string) => `${SESSION_COOKIE}=${app.jwt.sign({ sub: id })}`;
  const call = makeCaller(app, { alice: cookie(ids.alice), bob: cookie(ids.bob) }, workspace.id);
  try {
    const team = await call('alice', 'POST', '/teams', { name: 'Pilot Team', description: 'Everyone running the Acme pilot.' });
    await call('alice', 'POST', `/teams/${team.id}/members`, { userId: ids.bob });
    const project = await call<{ id: string; sections: { id: string }[] }>('alice', 'POST', '/projects', {
      teamId: team.id,
      name: 'Pilot Rollout',
      description: 'Six-week pilot of Mekari Project with the Acme operations team.',
      color: '#f06a6a',
      privacy: 'TEAM',
      defaultView: 'BOARD',
    });
    await call('alice', 'POST', `/projects/${project.id}/members`, { userId: guest.id, role: 'EDITOR' });
    const taskIds: Record<string, string> = {};
    for (const t of ACME_TASKS) {
      const task = await call('alice', 'POST', '/tasks', {
        title: t.title,
        projectId: project.id,
        sectionId: project.sections[t.section]!.id,
        assigneeId: t.assignee ? ids[t.assignee] : undefined,
        dueDate: t.due === undefined ? undefined : dayOffset(t.due),
        priority: t.priority,
      });
      taskIds[t.title] = task.id;
      if (t.done) await call(t.assignee ?? 'alice', 'PATCH', `/tasks/${task.id}`, { completed: true });
    }
    await call('bob', 'POST', `/tasks/${taskIds['Provision pilot accounts']}/comments`, {
      body: 'Accounts are ready except SSO; waiting on Acme IT.',
    });
    return { tasks: ACME_TASKS.length };
  } catch (err) {
    await db.$transaction((tx) => deleteWorkspace(tx, workspace.id));
    throw err;
  }
}
