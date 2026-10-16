import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { hashPassword } from './password.js';
import { currentPeriods } from './time.js';

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

  for (const u of USERS) {
    const user = await db.user.create({
      data: { email: u.email, name: u.name, role: u.role, avatarColor: u.avatarColor, passwordHash },
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

  async function call<T = { id: string }>(who: Who, method: 'POST' | 'PATCH', url: string, payload: object): Promise<T> {
    const res = await app.inject({ method, url: `/api/v1${url}`, headers: { cookie: cookies[who] }, payload });
    if (res.statusCode >= 300) throw new Error(`Seed ${method} ${url} failed (${res.statusCode}): ${res.body}`);
    return res.json() as T;
  }

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

  return { users: USERS.length, teams: Object.keys(teams).length, projects: PROJECTS.length, tasks: taskCount, goals };
}

type Call = <T = { id: string }>(who: Who, method: 'POST' | 'PATCH', url: string, payload: object) => Promise<T>;

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
