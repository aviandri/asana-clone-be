import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { User } from '@prisma/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { generateToken } from '../src/lib/tokens.js';
import { takeTicket, withTicket } from '../src/mcp/internal.js';
import { originAllowed, MCP_RATE_LIMIT } from '../src/routes/mcp.js';
import { READ_TOOLS, WRITE_TOOLS } from '../src/mcp/tools.js';
import { addMember, createUser, prisma, signedIn } from './helpers.js';

const APP_URL = 'http://localhost:5173';

let app: FastifyInstance;
let base: URL;

beforeAll(async () => {
  app = await buildApp({ config: { ...loadConfig(), APP_URL, MCP_ENABLED: true }, prisma, logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`);
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${rows.map((r) => `"public"."${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
});

// --- helpers ---------------------------------------------------------------------------------------

type Session = { user: User; cookie: string };

async function api<T = any>(s: Session, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object): Promise<T> {
  const res = await app.inject({ method, url: `/api/v1${url}`, headers: { cookie: s.cookie }, payload });
  expect(res.statusCode, `${method} ${url}: ${res.body}`).toBeLessThan(300);
  return res.json() as T;
}

/** A PAT row for `user` (as POST /me/tokens makes it). */
async function pat(user: User, scope: 'READ' | 'WRITE' = 'WRITE') {
  const t = generateToken('mpat');
  await prisma.apiToken.create({ data: { userId: user.id, name: 'test', source: 'PAT', scope, prefix: t.prefix, tokenHash: t.hash } });
  return t.token;
}

const clients: Client[] = [];
async function connect(token: string) {
  const client = new Client({ name: 'mcp-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(base, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  clients.push(client);
  return client;
}

type CallResult = { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: any };
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return (await client.callTool({ name, arguments: args })) as CallResult;
}
async function ok(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await call(client, name, args);
  expect(res.isError, `${name}: ${res.content[0]?.text}`).toBeFalsy();
  return res.structuredContent;
}
async function fails(client: Client, name: string, args: Record<string, unknown>, prefix: string) {
  const res = await call(client, name, args);
  expect(res.isError, `${name} should fail`).toBe(true);
  expect(res.content[0]!.text, name).toMatch(new RegExp(`^${prefix}`));
  return res.content[0]!.text;
}

function rpc(token: string | null, body: object, headers: Record<string, string> = {}) {
  return fetch(base, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/**
 * The world: alice and bob share team Eng and its TEAM project "Launch". alice also owns a PRIVATE
 * project "Secret" and a PUBLIC one "Open" where bob is a COMMENTER. carol is a GUEST. A second
 * workspace has only alice.
 */
async function world() {
  const alice = await signedIn(app, { name: 'Alice', email: 'alice@example.com' });
  const bob = await signedIn(app, { name: 'Bob', email: 'bob@example.com' });
  const carol = await signedIn(app, { name: 'Carol', email: 'carol@example.com', role: 'GUEST' });
  const ws = alice.user.lastWorkspaceId!;
  const team = await prisma.team.create({ data: { workspaceId: ws, name: 'Eng', members: { create: [{ userId: alice.user.id }, { userId: bob.user.id }] } } });
  const launch = await api(alice, 'POST', '/projects', { teamId: team.id, name: 'Launch' });
  const secret = await api(alice, 'POST', '/projects', { teamId: team.id, name: 'Secret', privacy: 'PRIVATE' });
  const open = await api(alice, 'POST', '/projects', { teamId: team.id, name: 'Open', privacy: 'PUBLIC' });
  await prisma.projectMember.create({ data: { projectId: open.id, userId: bob.user.id, role: 'COMMENTER' } });
  await prisma.projectMember.create({ data: { projectId: launch.id, userId: carol.user.id, role: 'EDITOR' } });
  const t1 = await api(alice, 'POST', '/tasks', { projectId: launch.id, title: 'Write the plan', assigneeId: bob.user.id, dueDate: '2026-11-01' });
  const hidden = await api(alice, 'POST', '/tasks', { projectId: secret.id, title: 'Secret plan' });
  const openTask = await api(alice, 'POST', '/tasks', { projectId: open.id, title: 'Open task' });
  const personal = await api(alice, 'POST', '/tasks', { title: 'Personal errand' });
  const other = await prisma.workspace.create({ data: { name: 'Other', color: '#000000' } });
  await addMember(other.id, alice.user.id);
  return { alice, bob, carol, ws, team, launch, secret, open, t1, hidden, openTask, personal, other };
}

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
});

// --- the endpoint ----------------------------------------------------------------------------------

describe('the /mcp endpoint', () => {
  it('lists 27 tools for WRITE tokens and only the 15 read tools for READ tokens', async () => {
    const alice = await createUser();
    const write = await connect(await pat(alice, 'WRITE'));
    expect(write.getServerVersion()).toMatchObject({ name: 'mekari-project', title: 'Mekari Project' });
    expect(write.getInstructions()).toMatch(/user-written content/);
    const all = (await write.listTools()).tools;
    expect(all.map((t) => t.name).sort()).toEqual([...READ_TOOLS(), ...WRITE_TOOLS()].sort());
    expect(all).toHaveLength(27);
    expect(all.map((t) => t.name).filter((n) => /delete|archive|remove|destroy|purge/i.test(n))).toEqual([]);
    for (const t of all) {
      expect(t.outputSchema, t.name).toBeDefined();
      const write = WRITE_TOOLS().includes(t.name);
      expect(t.annotations, t.name).toMatchObject(write ? { readOnlyHint: false, destructiveHint: false } : { readOnlyHint: true });
    }

    const read = await connect(await pat(alice, 'READ'));
    const readNames = (await read.listTools()).tools.map((t) => t.name);
    expect(readNames.sort()).toEqual(READ_TOOLS().sort());
    expect(readNames).toHaveLength(15);
    // Called anyway: our FORBIDDEN, not the SDK's "not found".
    for (const name of ['create_task', 'update_task', 'mark_notifications_read']) {
      await fails(read, name, { title: 'x' }, 'FORBIDDEN: this token is read-only');
    }
    await fails(read, 'no_such_tool', {}, 'MCP error');
  });

  it('is stateless JSON: no session id, no initialize needed', async () => {
    const token = await pat(await createUser());
    const res = await rpc(token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    expect((await res.json()).result.tools).toHaveLength(27);
  });

  it('405 for GET and DELETE; 401 without a token', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(base, { method });
      expect([res.status, res.headers.get('allow')], method).toEqual([405, 'POST']);
    }
    const res = await rpc(null, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/resource_metadata=/);
  });

  it('refuses browsers from other origins (DNS rebinding)', async () => {
    const token = await pat(await createUser());
    for (const origin of ['https://evil.example', 'http://claude.ai', 'https://claude.ai.evil.example', 'https://evilclaude.ai', 'null']) {
      expect((await rpc(token, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { origin })).status, origin).toBe(403);
    }
    for (const origin of ['https://claude.ai', 'https://www.claude.ai', 'https://claude.com', 'https://x.claude.com', 'https://console.anthropic.com', APP_URL]) {
      expect((await rpc(token, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { origin })).status, origin).toBe(200);
    }
    expect(originAllowed('https://anthropic.com.evil.example', APP_URL)).toBe(false);
    expect(originAllowed('https://claude.ai:8443', APP_URL)).toBe(false);
  });

  it(`rate-limits each token to ${MCP_RATE_LIMIT} requests a minute`, async () => {
    const user = await createUser();
    const [a, b] = [await pat(user), await pat(user)];
    const statuses: number[] = [];
    for (let i = 0; i <= MCP_RATE_LIMIT; i++) statuses.push((await rpc(a, { jsonrpc: '2.0', id: i, method: 'ping' })).status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(MCP_RATE_LIMIT);
    const limited = await rpc(a, { jsonrpc: '2.0', id: 0, method: 'ping' });
    expect(limited.status).toBe(429);
    expect((await limited.json()).error.code).toBe(-32000);
    expect((await rpc(b, { jsonrpc: '2.0', id: 0, method: 'ping' })).status, 'per token').toBe(200);
  }, 60_000);

  it('refuses the internal ticket header from the network (M14)', async () => {
    const alice = await signedIn(app);
    for (const url of ['/api/v1/auth/me', '/api/v1/health', '/api/v1/projects']) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie: alice.cookie, 'x-mcp-internal-ticket': 'anything' } });
      expect(res.statusCode, url).toBe(400);
    }
    // A real ticket, but replayed outside the injection it was made for.
    let leaked = '';
    await withTicket({ userId: alice.user.id, tokenId: 'x', scope: 'WRITE', client: null }, async (ticket) => {
      leaked = ticket;
      expect(takeTicket(ticket), 'consumed once').toMatchObject({ userId: alice.user.id });
      expect(takeTicket(ticket), 'single use').toBeNull();
    });
    expect(takeTicket(leaked), 'outside its context').toBeNull();
    const res = await fetch(new URL('/api/v1/auth/me', base), { headers: { 'x-mcp-internal-ticket': leaked } });
    expect(res.status).toBe(400);
  });
});

// --- permission parity --------------------------------------------------------------------------------

describe('permission parity with REST', () => {
  it('a project the user can’t see is NOT_FOUND everywhere', async () => {
    const w = await world();
    const bob = await connect(await pat(w.bob.user));
    for (const [tool, args] of [
      ['get_project', { projectId: w.secret.id }],
      ['list_tasks', { projectId: w.secret.id }],
      ['project_report', { projectId: w.secret.id }],
      ['get_task', { taskId: w.hidden.id }],
      ['update_task', { taskId: w.hidden.id, title: 'mine now' }],
      ['add_comment', { taskId: w.hidden.id, body: 'hi' }],
      ['add_link', { taskId: w.hidden.id, url: 'https://example.com' }],
      ['follow_task', { taskId: w.hidden.id, follow: true }],
      ['create_task', { projectId: w.secret.id, title: 'x' }],
      ['create_section', { projectId: w.secret.id, name: 'x' }],
      ['rename_section', { sectionId: w.secret.sections[0].id, name: 'x' }],
      ['update_project', { projectId: w.secret.id, name: 'x' }],
      ['get_task', { taskId: w.personal.id }],
    ] as const) {
      await fails(bob, tool, args, 'NOT_FOUND');
    }
    const found = await ok(bob, 'search', { query: 'plan' });
    expect(found.tasks.map((t: { title: string }) => t.title)).toEqual(['Write the plan']);
    const projects = (await ok(bob, 'list_projects', {})).projects.map((p: { name: string }) => p.name);
    expect(projects.sort()).toEqual(['Launch', 'Open']);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: w.hidden.id } })).title).toBe('Secret plan');
  });

  it('a COMMENTER can comment but not edit; only owners manage the project', async () => {
    const w = await world();
    const bob = await connect(await pat(w.bob.user));
    await fails(bob, 'create_task', { projectId: w.open.id, title: 'x' }, 'FORBIDDEN');
    await fails(bob, 'update_task', { taskId: w.openTask.id, completed: true }, 'FORBIDDEN');
    await fails(bob, 'add_link', { taskId: w.openTask.id, url: 'https://example.com' }, 'FORBIDDEN');
    await fails(bob, 'create_section', { projectId: w.open.id, name: 'x' }, 'FORBIDDEN');
    expect((await ok(bob, 'add_comment', { taskId: w.openTask.id, body: 'Looks good' })).comment.body).toBe('Looks good');
    expect((await ok(bob, 'follow_task', { taskId: w.openTask.id, follow: true })).following).toBe(true);
    // Launch: bob edits tasks but doesn't own the project.
    expect((await ok(bob, 'update_task', { taskId: w.t1.id, priority: 'HIGH' })).changed).toEqual(['priority']);
    await fails(bob, 'update_project', { projectId: w.launch.id, name: 'Mine' }, 'FORBIDDEN');
    const alice = await connect(await pat(w.alice.user));
    expect((await ok(alice, 'update_project', { projectId: w.launch.id, name: 'Launch v2' })).project.name).toBe('Launch v2');
  });

  it('guests get exactly what REST gives them', async () => {
    const w = await world();
    const goal = await api(w.alice, 'POST', '/goals', { title: 'Ship it', timePeriod: '2026' });
    const carol = await connect(await pat(w.carol.user));
    expect((await ok(carol, 'list_teams')).teams).toEqual([]);
    expect((await ok(carol, 'list_goals')).goals).toEqual([]);
    await fails(carol, 'get_goal', { goalId: goal.id }, 'NOT_FOUND');
    await fails(carol, 'create_project', { name: 'x', teamId: w.team.id }, 'FORBIDDEN');
    await fails(carol, 'workload', {}, 'FORBIDDEN');
    expect((await ok(carol, 'list_projects')).projects.map((p: { name: string }) => p.name)).toEqual(['Launch']);
  });

  it('a READ token can only read, even through a write tool’s REST path', async () => {
    const w = await world();
    const read = await connect(await pat(w.alice.user, 'READ'));
    expect((await ok(read, 'get_task', { taskId: w.t1.id })).task.title).toBe('Write the plan');
    const res = await rpc(await pat(w.alice.user, 'READ'), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'update_task', arguments: { taskId: w.t1.id, title: 'x' } } });
    expect((await res.json()).result.content[0].text).toBe('FORBIDDEN: this token is read-only');
    expect((await prisma.task.findUniqueOrThrow({ where: { id: w.t1.id } })).title).toBe('Write the plan');
  });
});

// --- workspaces -------------------------------------------------------------------------------------

describe('workspaces (M15)', () => {
  it('defaults like REST, takes workspaceId strictly, never moves lastWorkspaceId', async () => {
    const w = await world();
    const alice = await connect(await pat(w.alice.user));
    const who = await ok(alice, 'whoami');
    expect(who).toMatchObject({ user: { id: w.alice.user.id }, currentWorkspaceId: w.ws, tokenScope: 'WRITE' });
    expect(who.workspaces).toHaveLength(2);
    expect((await ok(alice, 'list_workspaces')).workspaces.find((x: { isCurrent: boolean }) => x.isCurrent).id).toBe(w.ws);

    expect((await ok(alice, 'list_projects')).workspaceId).toBe(w.ws);
    const other = await ok(alice, 'list_projects', { workspaceId: w.other.id });
    expect([other.workspaceId, other.projects]).toEqual([w.other.id, []]);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: w.alice.user.id } })).lastWorkspaceId, 'unchanged').toBe(w.ws);

    const bob = await connect(await pat(w.bob.user));
    await fails(bob, 'list_projects', { workspaceId: w.other.id }, 'NOT_FOUND');
    const loner = await createUser({ workspaceId: null });
    const lonely = await connect(await pat(loner));
    expect((await ok(lonely, 'whoami')).currentWorkspaceId).toBeNull();
    await fails(lonely, 'list_projects', {}, 'NO_WORKSPACE');
    await fails(lonely, 'my_tasks', {}, 'NO_WORKSPACE');
  });
});

// --- read tools ------------------------------------------------------------------------------------

describe('read tools', () => {
  it('shape tasks with deep links (M6, M25)', async () => {
    const w = await world();
    const alice = await connect(await pat(w.alice.user));
    const sub = await api(w.alice, 'POST', '/tasks', { parentId: w.t1.id, title: 'Sub step' });
    await api(w.alice, 'POST', `/tasks/${w.t1.id}/comments`, { body: 'First!' });
    const detail = (await ok(alice, 'get_task', { taskId: w.t1.id })).task;
    expect(detail).toMatchObject({
      title: 'Write the plan',
      truncated: false,
      assignee: { id: w.bob.user.id, name: 'Bob' },
      dueDate: '2026-11-01',
      project: { id: w.launch.id, name: 'Launch' },
      section: { id: w.launch.sections[0].id, name: 'To do' },
      url: `${APP_URL}/projects/${w.launch.id}/list?task=${w.t1.id}&workspace=${w.ws}`,
    });
    expect(detail.subtasks).toEqual([expect.objectContaining({ id: sub.id, url: `${APP_URL}/projects/${w.launch.id}/list?task=${sub.id}&workspace=${w.ws}` })]);
    expect(detail.comments).toEqual([expect.objectContaining({ body: 'First!', author: { id: w.alice.user.id, name: 'Alice' }, attachmentNames: [] })]);

    const personal = (await ok(alice, 'get_task', { taskId: w.personal.id })).task;
    expect(personal.url).toBe(`${APP_URL}/my-tasks?task=${w.personal.id}&workspace=${w.ws}`);
    expect((await ok(alice, 'get_project', { projectId: w.launch.id })).project).toMatchObject({
      url: `${APP_URL}/projects/${w.launch.id}?workspace=${w.ws}`,
      reportUrl: `${APP_URL}/projects/${w.launch.id}/dashboard?workspace=${w.ws}`,
      counts: { total: 1, completed: 0, overdue: 0 },
    });
    const file = await prisma.attachment.create({
      data: { workspaceId: w.ws, taskId: w.t1.id, uploaderId: w.alice.user.id, kind: 'FILE', name: 'plan.pdf', size: 10, mimeType: 'application/pdf', storageKey: 'k' },
    });
    const withFile = (await ok(alice, 'get_task', { taskId: w.t1.id, includeComments: false })).task;
    expect(withFile.attachments).toEqual([{ id: file.id, kind: 'FILE', name: 'plan.pdf', size: 10, url: `${APP_URL}/api/v1/attachments/${file.id}/content?download=1&workspace=${w.ws}` }]);
    expect(withFile.comments).toEqual([]);
  });

  it('truncates long descriptions in get_task', async () => {
    const w = await world();
    await prisma.task.update({ where: { id: w.t1.id }, data: { description: 'x'.repeat(25_000) } });
    const t = (await ok(await connect(await pat(w.alice.user)), 'get_task', { taskId: w.t1.id })).task;
    expect([t.description.length, t.truncated]).toEqual([20_000, true]);
  });

  it('paginates with an opaque cursor and filters MCP-side (M22)', async () => {
    const w = await world();
    for (let i = 0; i < 29; i++) await api(w.alice, 'POST', '/tasks', { projectId: w.launch.id, title: `Task ${i}`, dueDate: i < 3 ? '2026-10-01' : null });
    const alice = await connect(await pat(w.alice.user));
    const first = await ok(alice, 'list_tasks', { projectId: w.launch.id });
    expect(first.tasks).toHaveLength(25);
    const second = await ok(alice, 'list_tasks', { projectId: w.launch.id, cursor: first.nextCursor });
    expect([second.tasks.length, second.nextCursor]).toEqual([5, null]);
    expect(new Set([...first.tasks, ...second.tasks].map((t: { id: string }) => t.id)).size).toBe(30);
    await fails(alice, 'list_tasks', { projectId: w.launch.id, cursor: 'garbage' }, 'VALIDATION: cursor');
    expect((await ok(alice, 'list_tasks', { projectId: w.launch.id, dueBefore: '2026-10-15' })).tasks).toHaveLength(3);
    expect((await ok(alice, 'list_tasks', { projectId: w.launch.id, assignee: 'bob@example.com' })).tasks.map((t: { id: string }) => t.id)).toEqual([w.t1.id]);
    expect((await ok(await connect(await pat(w.bob.user)), 'my_tasks', {})).tasks.map((t: { id: string }) => t.id)).toEqual([w.t1.id]);
  });

  it('resolves people by id, exact email or "me", and lists candidates otherwise', async () => {
    const w = await world();
    const alice = await connect(await pat(w.alice.user));
    expect((await ok(alice, 'list_tasks', { projectId: w.launch.id, assignee: 'me' })).tasks).toEqual([]);
    expect((await ok(alice, 'list_tasks', { projectId: w.launch.id, assignee: w.bob.user.id })).tasks).toHaveLength(1);
    const text = await fails(alice, 'list_tasks', { projectId: w.launch.id, assignee: 'example.com' }, 'VALIDATION: assignee');
    expect(text).toMatch(/Candidates: .*bob@example.com/);
    await fails(alice, 'list_tasks', { projectId: w.launch.id, assignee: 'nobody@nowhere.example' }, 'NOT_FOUND: assignee');
  });

  it('every read tool answers with structured content', async () => {
    const w = await world();
    const goal = await api(w.alice, 'POST', '/goals', { title: 'Ship it', timePeriod: '2026' });
    await api(w.alice, 'POST', `/goals/${goal.id}/key-results`, { title: 'Users', metricType: 'NUMBER', targetValue: 100 });
    const alice = await connect(await pat(w.alice.user));
    const results = {
      whoami: await ok(alice, 'whoami'),
      list_workspaces: await ok(alice, 'list_workspaces'),
      list_teams: await ok(alice, 'list_teams'),
      list_people: await ok(alice, 'list_people', { query: 'bob' }),
      list_projects: await ok(alice, 'list_projects', { includeArchived: true }),
      get_project: await ok(alice, 'get_project', { projectId: w.launch.id }),
      list_tasks: await ok(alice, 'list_tasks', { projectId: w.launch.id }),
      my_tasks: await ok(alice, 'my_tasks'),
      get_task: await ok(alice, 'get_task', { taskId: w.t1.id }),
      search: await ok(alice, 'search', { query: 'plan' }),
      list_goals: await ok(alice, 'list_goals', { owner: 'me' }),
      get_goal: await ok(alice, 'get_goal', { goalId: goal.id }),
      project_report: await ok(alice, 'project_report', { projectId: w.launch.id, weeks: 4 }),
      workload: await ok(alice, 'workload', { teamId: w.team.id }),
      list_notifications: await ok(alice, 'list_notifications', { unreadOnly: false }),
    };
    expect(Object.keys(results).sort()).toEqual(READ_TOOLS().sort());
    expect(results.list_teams.teams).toEqual([expect.objectContaining({ name: 'Eng', isMember: true, url: `${APP_URL}/teams/${w.team.id}?workspace=${w.ws}` })]);
    expect(results.list_people.people).toEqual([expect.objectContaining({ email: 'bob@example.com' })]);
    expect(results.get_goal.goal).toMatchObject({ title: 'Ship it', url: `${APP_URL}/goals/${goal.id}?workspace=${w.ws}`, keyResults: [expect.objectContaining({ title: 'Users' })] });
    expect(results.workload.url).toBe(`${APP_URL}/reporting?workspace=${w.ws}`);
    expect(results.list_notifications.url).toBe(`${APP_URL}/inbox?workspace=${w.ws}`);
    for (const [name, r] of Object.entries(results)) {
      if (name !== 'whoami' && name !== 'list_workspaces' && name !== 'get_goal') expect(r.workspaceId, name).toBe(w.ws);
    }
  });
});

// --- write tools -----------------------------------------------------------------------------------

describe('write tools', () => {
  it('create and update tasks with REST rules, notifications and activity', async () => {
    const w = await world();
    const alice = await connect(await pat(w.alice.user));
    const created = (await ok(alice, 'create_task', { title: 'From Claude', projectId: w.launch.id, assignee: 'bob@example.com', dueDate: '2026-12-01', priority: 'HIGH' })).task;
    expect(created).toMatchObject({ title: 'From Claude', assignee: { id: w.bob.user.id }, priority: 'HIGH', section: { name: 'To do' } });
    expect(created.url).toBe(`${APP_URL}/projects/${w.launch.id}/list?task=${created.id}&workspace=${w.ws}`);
    // The REST side effects happened: bob was notified, the activity was recorded.
    const inbox = await ok(await connect(await pat(w.bob.user)), 'list_notifications');
    expect(inbox.notifications.map((n: { type: string; task: { id: string } }) => [n.type, n.task.id])).toContainEqual(['ASSIGNED', created.id]);
    const stories = await api(w.alice, 'GET', `/tasks/${created.id}/stories`);
    expect(stories.data.some((s: { kind: string; type?: string }) => s.kind === 'activity' && s.type === 'CREATED')).toBe(true);

    const updated = await ok(alice, 'update_task', { taskId: created.id, completed: true, assignee: null, sectionId: w.launch.sections[2].id });
    expect(updated.changed.sort()).toEqual(['assignee', 'completed', 'sectionId']);
    expect(updated.task).toMatchObject({ completed: true, assignee: null, section: { name: 'Done' } });
    expect((await ok(alice, 'update_task', { taskId: created.id, completed: true })).changed).toEqual([]);
    await fails(alice, 'update_task', { taskId: created.id }, 'VALIDATION: give at least one field');
    await fails(alice, 'create_task', { title: 'x', projectId: w.launch.id, assignee: 'carol@example.com', sectionId: w.secret.sections[0].id }, 'VALIDATION|NOT_FOUND');

    const personal = (await ok(alice, 'create_task', { title: 'Mine', workspaceId: w.other.id })).task;
    expect(personal.url).toBe(`${APP_URL}/my-tasks?task=${personal.id}&workspace=${w.other.id}`);
    const sub = (await ok(alice, 'create_task', { title: 'Sub', parentId: created.id })).task;
    expect([sub.parentId, sub.project.id]).toEqual([created.id, w.launch.id]);
  });

  it('comments with mentions, links, follows', async () => {
    const w = await world();
    const alice = await connect(await pat(w.alice.user));
    const c = (await ok(alice, 'add_comment', { taskId: w.t1.id, body: `Over to you @[Bob](${w.bob.user.id})` })).comment;
    expect(c.url).toBe(`${APP_URL}/projects/${w.launch.id}/list?task=${w.t1.id}&workspace=${w.ws}`);
    expect((await prisma.notification.findMany({ where: { userId: w.bob.user.id, type: 'MENTIONED' } })).length).toBe(1);
    await fails(alice, 'add_comment', { taskId: w.t1.id, body: '' }, 'MCP error -32602');

    const link = (await ok(alice, 'add_link', { taskId: w.t1.id, url: 'https://example.invalid/doc', title: 'Spec' })).link;
    expect(link).toMatchObject({ url: 'https://example.invalid/doc', title: 'Spec', previewStatus: 'FAILED' });

    expect((await ok(alice, 'follow_task', { taskId: w.t1.id, follow: false })).following).toBe(false);
    expect((await ok(alice, 'follow_task', { taskId: w.t1.id, follow: true })).following).toBe(true);
  });

  it('projects and sections', async () => {
    const w = await world();
    const alice = await connect(await pat(w.alice.user));
    const p = (await ok(alice, 'create_project', { name: 'Roadmap', teamId: w.team.id })).project;
    expect(p.sections.map((s: { name: string }) => s.name)).toEqual(['To do', 'In progress', 'Done']);
    expect((await prisma.projectMember.findFirstOrThrow({ where: { projectId: p.id } })).role).toBe('OWNER');
    const s = (await ok(alice, 'create_section', { projectId: p.id, name: 'Review', afterSectionId: p.sections[1].id })).section;
    const renamed = (await ok(alice, 'rename_section', { sectionId: s.id, name: 'QA' })).section;
    expect(renamed).toMatchObject({ name: 'QA', projectUrl: `${APP_URL}/projects/${p.id}?workspace=${w.ws}` });
    const order = (await ok(alice, 'get_project', { projectId: p.id })).project.sections.map((x: { name: string }) => x.name);
    expect(order).toEqual(['To do', 'In progress', 'QA', 'Done']);
    await fails(alice, 'create_section', { projectId: p.id, name: 'x', afterSectionId: w.launch.sections[0].id }, 'NOT_FOUND: afterSectionId');
    await fails(alice, 'update_project', { projectId: p.id, archived: true } as never, 'VALIDATION');
  });

  it('goal updates, key results and notifications', async () => {
    const w = await world();
    const goal = await api(w.alice, 'POST', '/goals', { title: 'Ship it', timePeriod: '2026' });
    const kr = await api(w.alice, 'POST', `/goals/${goal.id}/key-results`, { title: 'Users', metricType: 'NUMBER', targetValue: 100 });
    const alice = await connect(await pat(w.alice.user));
    expect((await ok(alice, 'post_goal_update', { goalId: goal.id, status: 'AT_RISK', body: 'Slipping' })).update).toMatchObject({ status: 'AT_RISK' });
    expect((await prisma.goal.findUniqueOrThrow({ where: { id: goal.id } })).status).toBe('AT_RISK');
    expect((await ok(alice, 'update_key_result', { keyResultId: kr.id, currentValue: 40 })).keyResult).toMatchObject({ currentValue: 40, progress: 40 });
    await fails(await connect(await pat(w.bob.user)), 'update_key_result', { keyResultId: kr.id, currentValue: 99 }, 'FORBIDDEN');

    await api(w.bob, 'POST', `/tasks/${w.t1.id}/comments`, { body: `ping @[Alice](${w.alice.user.id})` });
    const inbox = await ok(alice, 'list_notifications');
    expect(inbox.unreadCount).toBeGreaterThan(0);
    expect((await ok(alice, 'mark_notifications_read', { ids: [inbox.notifications[0].id] })).marked).toBe(1);
    expect((await ok(alice, 'mark_notifications_read')).marked).toBe('all');
    expect((await ok(alice, 'list_notifications')).unreadCount).toBe(0);
  });
});
