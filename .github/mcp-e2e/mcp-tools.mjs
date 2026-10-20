// The tool half of the MCP e2e (SPEC §14), run by mcp-e2e.mjs with MCP_TOOLS=1. The official SDK
// Client talks to /mcp over Streamable HTTP with the OAuth grants the first half obtained:
// tools/list, every read tool, every write tool against the e2e's own data, the READ-token rules,
// and the transport rules. With INSPECTOR_BIN it also runs the MCP Inspector CLI with a PAT.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const READ_TOOLS = ['whoami', 'list_workspaces', 'list_teams', 'list_people', 'list_projects', 'get_project', 'list_tasks', 'my_tasks',
  'get_task', 'search', 'list_goals', 'get_goal', 'project_report', 'workload', 'list_notifications'];
const WRITE_TOOLS = ['create_task', 'update_task', 'add_comment', 'add_link', 'follow_task', 'create_project', 'update_project',
  'create_section', 'rename_section', 'post_goal_update', 'update_key_result', 'mark_notifications_read'];
// Nothing destructive or administrative is reachable through MCP (§14 "no deletes").
const FORBIDDEN_NAME = /delete|archive|remove|privacy|role|invite|upload/i;

export async function mcpChecks({ BASE, MCP_URL, rest, check, same, projectId, providers }) {
  const connect = async (authProvider, name) => {
    const client = new Client({ name, version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider }));
    return client;
  };
  const extra = []; // ids made over MCP outside our project, removed over REST at the end
  let goalId;
  const w = await connect(providers.write, 'mcp-e2e write');
  try {
    // ---- server info and tools/list ----
    same('server info (name, title)', [w.getServerVersion()?.name, w.getServerVersion()?.title], ['mekari-project', 'Mekari Project']);
    check('server instructions are set', (w.getInstructions() ?? '').length > 50);
    const tools = (await w.listTools()).tools;
    const names = tools.map((t) => t.name).sort();
    same('WRITE token: tools/list = the 27 §14 tools', names, [...READ_TOOLS, ...WRITE_TOOLS].sort());
    same(`no tool name matches ${FORBIDDEN_NAME}`, names.filter((n) => FORBIDDEN_NAME.test(n)), []);
    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations ?? {}]));
    same('read tools: readOnlyHint true', READ_TOOLS.filter((n) => hints[n]?.readOnlyHint !== true), []);
    same('write tools: readOnlyHint false, destructiveHint false', WRITE_TOOLS.filter((n) => hints[n]?.readOnlyHint !== false || hints[n]?.destructiveHint !== false), []);
    same('every tool has an inputSchema and an outputSchema', tools.filter((t) => !t.inputSchema || !t.outputSchema).map((t) => t.name), []);

    // ---- tool calls ----
    const called = new Set();
    const call = async (name, args = {}) => {
      called.add(name);
      const r = await w.callTool({ name, arguments: args });
      const text = r.content?.find((c) => c.type === 'text')?.text ?? '';
      return { ok: !r.isError, sc: r.structuredContent, text, raw: r };
    };
    const ok = async (name, args, pick = (sc) => sc, label = name) => {
      const r = await call(name, args);
      check(`tool ${label}`, r.ok && r.sc && pick(r.sc) !== undefined, r.ok ? JSON.stringify(r.sc).slice(0, 160) : r.text.slice(0, 200));
      return r.sc;
    };

    const who = await ok('whoami', {}, (sc) => sc.user?.id);
    same('whoami: tokenScope WRITE', who?.tokenScope, 'WRITE');
    const ws = await ok('list_workspaces', {}, (sc) => sc.workspaces?.length || undefined);
    const wsId = who?.currentWorkspaceId ?? ws?.workspaces?.[0]?.id;
    const teams = await ok('list_teams', { workspaceId: wsId }, (sc) => sc.teams?.length || undefined);
    await ok('list_people', { query: 'admin' }, (sc) => sc.people?.find((p) => p.email === who?.user?.email));
    await ok('list_projects', { workspaceId: wsId }, (sc) => sc.projects?.find((p) => p.id === projectId), 'list_projects (includes the e2e project)');
    const proj = await ok('get_project', { projectId }, (sc) => sc.project?.sections?.length || undefined);
    check('get_project url is an APP_URL deep link', proj?.project?.url?.startsWith(`${BASE}/projects/${projectId}`), proj?.project?.url);
    const sectionId = proj?.project?.sections?.[0]?.id;

    // Writes, all inside the e2e project (and one goal of its own).
    const sec = await ok('create_section', { projectId, name: 'MCP section' }, (sc) => sc.section?.id);
    await ok('rename_section', { sectionId: sec?.section?.id, name: 'MCP section (renamed)' }, (sc) => (sc.section?.name === 'MCP section (renamed)' ? 1 : undefined));
    const t = await ok('create_task', { title: 'Made over MCP', projectId, sectionId, assignee: 'me', dueDate: '2026-12-31', priority: 'HIGH', description: 'From the e2e' }, (sc) => sc.task?.id);
    const taskId = t?.task?.id;
    check('create_task url → /projects/<id>/list?task=<id>', t?.task?.url?.startsWith(`${BASE}/projects/${projectId}/list?task=${taskId}`), t?.task?.url);
    const sub = await ok('create_task', { title: 'A subtask', parentId: taskId }, (sc) => sc.task?.id, 'create_task (subtask)');
    const up = await ok('update_task', { taskId, title: 'Made over MCP (edited)', priority: 'LOW', sectionId: sec?.section?.id }, (sc) => sc.changed);
    same('update_task reports what changed', [...(up?.changed ?? [])].sort(), ['priority', 'sectionId', 'title']);
    await ok('add_comment', { taskId, body: `Hello from MCP, @[Me](${who?.user?.id})` }, (sc) => sc.comment?.id);
    await ok('add_link', { taskId, url: 'https://example.com/spec', title: 'Spec' }, (sc) => sc.link?.id);
    await ok('follow_task', { taskId, follow: false }, (sc) => (sc.following === false ? 1 : undefined), 'follow_task (unfollow)');
    await ok('follow_task', { taskId, follow: true }, (sc) => (sc.following === true ? 1 : undefined), 'follow_task (follow)');
    await ok('update_project', { projectId, description: 'Edited over MCP', color: '#4186e0' }, (sc) => sc.project?.id);
    const np = await ok('create_project', { name: '[mcp-e2e] made over MCP', teamId: teams?.teams?.find((x) => x.isMember)?.id, privacy: 'PRIVATE' }, (sc) => sc.project?.id);
    if (np?.project?.id) extra.push(['DELETE', `/projects/${np.project.id}`]);

    const goal = await rest('POST', '/goals', { title: '[mcp-e2e] goal', timePeriod: '2026-Q4' }, { 'x-workspace-id': wsId });
    goalId = goal.json?.id;
    const kr = await rest('POST', `/goals/${goalId}/key-results`, { title: 'KR', metricType: 'NUMBER', targetValue: 10 });
    await ok('post_goal_update', { goalId, status: 'ON_TRACK', body: 'Going well' }, (sc) => sc.update?.id);
    await ok('update_key_result', { keyResultId: kr.json?.id, currentValue: 5 }, (sc) => (sc.keyResult?.currentValue === 5 ? 1 : undefined));
    await ok('mark_notifications_read', { workspaceId: wsId }, (sc) => sc.marked);

    // Reads over what was just written.
    const lt = await ok('list_tasks', { projectId }, (sc) => sc.tasks?.find((x) => x.id === taskId));
    check('list_tasks: top-level only (M22)', !lt?.tasks?.some((x) => x.id === sub?.task?.id), '');
    await ok('my_tasks', { workspaceId: wsId }, (sc) => sc.tasks?.find((x) => x.id === taskId));
    const gt = await ok('get_task', { taskId }, (sc) => sc.task?.id);
    same('get_task shows the comment, the link and the subtask', [gt?.task?.comments?.length > 0, gt?.task?.attachments?.some((a) => a.kind === 'LINK'), gt?.task?.subtasks?.length], [true, true, 1]);
    await ok('search', { query: 'Made over MCP' }, (sc) => sc.tasks?.find((x) => x.id === taskId));
    await ok('list_goals', { workspaceId: wsId }, (sc) => sc.goals?.find((g) => g.id === goalId));
    await ok('get_goal', { goalId }, (sc) => sc.goal?.id);
    await ok('project_report', { projectId, weeks: 4 }, (sc) => sc.report);
    await ok('workload', { workspaceId: wsId }, (sc) => sc.report);
    await ok('list_notifications', { workspaceId: wsId, unreadOnly: false }, (sc) => sc.notifications);
    same('every tool was called', [...READ_TOOLS, ...WRITE_TOOLS].filter((n) => !called.has(n)), []);

    // Tool errors are results, starting with the REST code.
    const nf = await call('get_task', { taskId: '00000000-0000-4000-8000-000000000000' });
    check('unknown task → tool error NOT_FOUND:', !nf.ok && nf.raw.isError && nf.text.startsWith('NOT_FOUND:'), nf.text.slice(0, 80));
    const val = await call('update_task', { taskId, assignee: 'nobody-here@example.invalid' });
    check('unknown person → tool error', !val.ok && /^(VALIDATION|NOT_FOUND):/.test(val.text), val.text.slice(0, 80));
  } finally {
    await w.close().catch(() => {});
  }

  // ---- READ token ----
  const r = await connect(providers.read, 'mcp-e2e read');
  try {
    const tools = (await r.listTools()).tools;
    same('READ token: tools/list = the 15 read tools', tools.map((t) => t.name).sort(), [...READ_TOOLS].sort());
    same('READ token: every listed tool has readOnlyHint', tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name), []);
    same('READ token: whoami tokenScope READ', (await r.callTool({ name: 'whoami', arguments: {} })).structuredContent?.tokenScope, 'READ');
    const denied = await r.callTool({ name: 'create_task', arguments: { title: 'should not exist', projectId } });
    same('READ token calling a write tool → FORBIDDEN tool error', [denied.isError, denied.content?.[0]?.text], [true, 'FORBIDDEN: this token is read-only']);
  } finally {
    await r.close().catch(() => {});
  }

  // ---- transport rules ----
  const bearer = (await providers.write.tokens())?.access_token;
  const post = (headers) => fetch(MCP_URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${bearer}`, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  const plain = await post({});
  same('stateless JSON responses: application/json, no Mcp-Session-Id (M24)', [plain.status, plain.headers.get('content-type')?.split(';')[0], plain.headers.get('mcp-session-id')], [200, 'application/json', null]);
  same('GET /mcp → 405, DELETE /mcp → 405', [(await fetch(MCP_URL, { headers: { authorization: `Bearer ${bearer}` } })).status, (await fetch(MCP_URL, { method: 'DELETE', headers: { authorization: `Bearer ${bearer}` } })).status], [405, 405]);
  same('foreign Origin → 403; claude.ai Origin allowed', [(await post({ origin: 'https://evil.example' })).status, (await post({ origin: 'https://claude.ai' })).status], [403, 200]);
  const bad = await post({ authorization: 'Bearer mpat_not-a-real-token' });
  check('invalid token → 401 with error="invalid_token"', bad.status === 401 && /error="invalid_token"/.test(bad.headers.get('www-authenticate') ?? ''), bad.headers.get('www-authenticate'));

  // ---- PAT + the MCP Inspector CLI ----
  const pat = await rest('POST', '/me/tokens', { name: 'mcp-e2e PAT', scope: 'READ', expiresInDays: 30 });
  same('POST /me/tokens → 201 mpat_…', [pat.status, /^mpat_/.test(pat.json?.token ?? '')], [201, true]);
  if (process.env.INSPECTOR_BIN && pat.json?.token) {
    try {
      const { stdout } = await promisify(execFile)(process.env.INSPECTOR_BIN, ['--cli', MCP_URL, '--transport', 'http', '--header', `Authorization: Bearer ${pat.json.token}`, '--method', 'tools/list'], { timeout: 60_000 });
      const listed = JSON.parse(stdout).tools?.map((t) => t.name).sort();
      same('Inspector CLI with a READ PAT: tools/list = the 15 read tools', listed, [...READ_TOOLS].sort());
      const { stdout: who } = await promisify(execFile)(process.env.INSPECTOR_BIN, ['--cli', MCP_URL, '--transport', 'http', '--header', `Authorization: Bearer ${pat.json.token}`, '--method', 'tools/call', '--tool-name', 'whoami'], { timeout: 60_000 });
      same('Inspector CLI: tools/call whoami → tokenScope READ', JSON.parse(who).structuredContent?.tokenScope, 'READ');
    } catch (e) {
      check('Inspector CLI', false, String(e?.stderr || e?.message || e).slice(0, 400));
    }
  } else console.log('SKIP  Inspector CLI (no INSPECTOR_BIN)');
  if (pat.json?.info?.id) same('cleanup: DELETE the PAT', (await rest('DELETE', `/me/tokens/${pat.json.info.id}`)).status, 204);

  for (const [m, p] of extra) await rest(m, p);
  if (goalId) await rest('DELETE', `/goals/${goalId}`);
}
