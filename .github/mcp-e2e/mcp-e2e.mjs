#!/usr/bin/env node
// MCP + OAuth end-to-end check (SPEC §14) with the official @modelcontextprotocol/sdk client.
//
// The SDK client does the real OAuth flows against a running BE: discovery from the 401, DCR, and
// CIMD (a client_id metadata document served here over https). The consent step goes through the
// cookie API the FE consent page uses (§14 M7). Then come the token exchange, refresh rotation and
// revoke, plus the negative cases a client can reach. When the BE serves /mcp, it also lists and
// calls every tool.
//
//   BASE_URL=http://localhost:3000 node mcp-e2e.mjs
//
// Env:
//   BASE_URL        the BE's APP_URL (default http://localhost:3000). OAuth issuer = BASE_URL; MCP = BASE_URL/mcp
//   ADMIN_EMAIL     default admin@example.com; SEED_PASSWORD default password123 (seed user, any role)
//   CIMD_CERT/KEY   leaf cert + key for https://127.0.0.1 (gen-test-ca.sh). The BE must trust the CA
//                   (NODE_EXTRA_CA_CERTS) and run with LINK_PREVIEW_ALLOW_PRIVATE=true. Unset: CIMD skipped.
//   MCP_TOOLS       "1" also lists and calls every tool over /mcp (mcp-tools.mjs); unset = OAuth checks only.
//
// Data: a "[mcp-e2e]" PRIVATE project in the admin's first team, deleted at the end (also on failure).
// The grants it creates are revoked at the end.
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { auth, refreshAuthorization, discoverAuthorizationServerMetadata } from '@modelcontextprotocol/sdk/client/auth.js';

const BASE = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const MCP_URL = `${BASE}/mcp`;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@example.com';
const PASSWORD = process.env.SEED_PASSWORD ?? 'password123';
const RUN = randomUUID().slice(0, 8);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
};
const same = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);

// ---- a cookie session for the REST API, as the web app has ----
let cookie = '';
async function rest(method, path, body, headers = {}) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    redirect: 'manual',
    headers: { ...(body !== undefined && { 'content-type': 'application/json' }), ...(cookie && { cookie }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const c of res.headers.getSetCookie()) if (c.startsWith('sid=')) cookie = c.split(';')[0];
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

/** An in-memory OAuthClientProvider; redirectToAuthorization records the URL instead of opening a browser. */
function provider({ redirectUrl, clientMetadataUrl, name, scope }) {
  const p = {
    authorizationUrl: undefined, saved: {},
    get redirectUrl() { return redirectUrl; },
    clientMetadataUrl,
    get clientMetadata() {
      return { client_name: name, redirect_uris: [redirectUrl], grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'], token_endpoint_auth_method: 'none', ...(scope && { scope }) };
    },
    state: () => (p.saved.state = `st-${randomUUID()}`),
    clientInformation: () => p.saved.client,
    saveClientInformation: (c) => { p.saved.client = c; },
    tokens: () => p.saved.tokens,
    saveTokens: (t) => { p.saved.tokens = t; },
    redirectToAuthorization: (url) => { p.authorizationUrl = url; },
    saveCodeVerifier: (v) => { p.saved.verifier = v; },
    codeVerifier: () => p.saved.verifier,
  };
  return p;
}

/** Follow the authorize URL to the consent request, decide it over the cookie API, return the callback URL. */
async function consent(authorizationUrl, decision = { approve: true }) {
  const res = await fetch(authorizationUrl, { redirect: 'manual' });
  const loc = res.headers.get('location') ?? '';
  const m = loc.match(/\/connect\/authorize\?request=([^&]+)/);
  if (res.status !== 302 || !m) return { error: `authorize → ${res.status} ${loc || (await res.text()).slice(0, 120)}` };
  const id = decodeURIComponent(m[1]);
  const info = await rest('GET', `/oauth/requests/${id}`);
  const dec = await rest('POST', `/oauth/requests/${id}/decision`, decision);
  return { id, info, dec, callback: dec.json?.redirectUrl ? new URL(dec.json.redirectUrl) : undefined };
}

/** Full authorization-code flow with the SDK's auth(): discovery (+DCR or CIMD) → consent → token. */
async function authorize(p, decision) {
  const first = await auth(p, { serverUrl: MCP_URL });
  if (first !== 'REDIRECT' || !p.authorizationUrl) return { error: `auth() → ${first}` };
  const c = await consent(p.authorizationUrl, decision);
  if (c.error || !c.callback) return { ...c, error: c.error ?? `decision → ${c.dec?.status} ${c.dec?.text?.slice(0, 120)}` };
  const code = c.callback.searchParams.get('code');
  if (!code) return { ...c, denied: c.callback.searchParams.get('error') };
  const second = await auth(p, { serverUrl: MCP_URL, authorizationCode: code });
  return { ...c, code, result: second };
}

async function token(form) {
  const res = await fetch(`${BASE}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
  let json; try { json = await res.json(); } catch {}
  return { status: res.status, json, headers: res.headers };
}

const grants = []; // [refresh token, client_id]: each grant is revoked at the end
let projectId;
let cimdServer;

try {
  // ---- setup: a session and our own data ----
  const login = await rest('POST', '/auth/login', { email: ADMIN_EMAIL, password: PASSWORD });
  check('login (cookie session)', login.status === 200, `${login.status}`);
  const teams = (await rest('GET', '/teams?mine=true')).json?.data ?? [];
  const proj = await rest('POST', '/projects', { teamId: teams[0]?.id, name: `[mcp-e2e] ${RUN}`, privacy: 'PRIVATE' });
  check('create a PRIVATE [mcp-e2e] project', proj.status === 201, `${proj.status}`);
  projectId = proj.json?.id;

  // ---- discovery ----
  const unauth = await fetch(MCP_URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
  const hasMcp = unauth.status === 401;
  const wantTools = process.env.MCP_TOOLS === '1';
  if (hasMcp || wantTools) {
    same('POST /mcp without a token → 401', unauth.status, 401);
    same('401 WWW-Authenticate points at the protected resource metadata', unauth.headers.get('www-authenticate'),
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
  } else console.log(`SKIP  /mcp checks (POST /mcp → ${unauth.status}; set MCP_TOOLS=1 to require them)`);
  const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
  same('protected resource metadata', [prm.resource, prm.authorization_servers], [MCP_URL, [BASE]]);
  const asm = await discoverAuthorizationServerMetadata(BASE);
  same('authorization server metadata (via the SDK)', [asm?.issuer, asm?.code_challenge_methods_supported, asm?.token_endpoint_auth_methods_supported, asm?.client_id_metadata_document_supported],
    [BASE, ['S256'], ['none'], true]);
  // Behind nginx a non-OAuth /.well-known path is nginx's own 404 (M5); direct to the BE, or for an
  // unknown /.well-known/oauth-* path through nginx, it is the BE's RFC 6749 body.
  const oidc = await fetch(`${BASE}/.well-known/openid-configuration`);
  check('other /.well-known paths → 404, not the SPA', oidc.status === 404 && !/<div id="root"/.test(await oidc.text()), `${oidc.status}`);
  const unk = await fetch(`${BASE}/.well-known/oauth-unknown`);
  same('unknown /.well-known/oauth-* → 404 {error: "not_found"} (RFC 6749 shape)', [unk.status, (await unk.json().catch(() => ({}))).error], [404, 'not_found']);

  // ---- DCR + a loopback redirect on a random port ----
  const port = 20000 + Math.floor(Math.random() * 40000);
  const dcr = provider({ redirectUrl: `http://127.0.0.1:${port}/callback`, name: `mcp-e2e DCR ${RUN}` });
  const a = await authorize(dcr);
  check('DCR: the SDK registered a client', typeof dcr.saved.client?.client_id === 'string' && !dcr.saved.client.client_id.startsWith('https://'), dcr.saved.client?.client_id);
  same('consent request info (M7)', [a.info?.status, a.info?.json?.client?.name, a.info?.json?.isLocalRedirect, a.info?.json?.requestedScopes],
    [200, `mcp-e2e DCR ${RUN}`, true, ['read', 'write']]);
  same('callback carries state and iss', [a.callback?.searchParams.get('state'), a.callback?.searchParams.get('iss'), a.callback?.port], [dcr.saved.state, BASE, String(port)]);
  same('authorization codes are mpoc_…', /^mpoc_/.test(a.code ?? ''), true);
  same('DCR: auth() exchanges the code → AUTHORIZED', a.result ?? a.error, 'AUTHORIZED');
  const t1 = dcr.saved.tokens;
  same('token response shape', [t1?.token_type?.toLowerCase(), t1?.expires_in, t1?.scope, /^mpoa_/.test(t1?.access_token ?? ''), /^mpor_/.test(t1?.refresh_token ?? '')],
    ['bearer', 3600, 'read write', true, true]);
  if (t1) grants.push([t1.refresh_token, dcr.saved.client?.client_id]);
  same('a decided request can\'t be decided again → 409', (await rest('POST', `/oauth/requests/${a.id}/decision`, { approve: true })).status, 409);
  same('reusing the code → invalid_grant', (await token({ grant_type: 'authorization_code', code: a.code, redirect_uri: dcr.redirectUrl, client_id: dcr.saved.client?.client_id, code_verifier: dcr.saved.verifier, resource: MCP_URL })).json?.error, 'invalid_grant');
  same('…and revokes what that code issued', (await token({ grant_type: 'refresh_token', refresh_token: t1?.refresh_token, client_id: dcr.saved.client?.client_id })).json?.error, 'invalid_grant');

  // Loopback match ignores the port (M12): authorize with another port than the registered one.
  const otherPort = port + 1;
  const dcr2 = provider({ redirectUrl: `http://127.0.0.1:${otherPort}/callback`, name: `mcp-e2e port ${RUN}` });
  dcr2.saved.client = dcr.saved.client; // same registration, different port
  const a2 = await authorize(dcr2);
  same('loopback redirect on another port is accepted (M12)', [a2.result ?? a2.error, a2.callback?.port], ['AUTHORIZED', String(otherPort)]);
  if (dcr2.saved.tokens) grants.push([dcr2.saved.tokens.refresh_token, dcr.saved.client?.client_id]);
  const nonLoop = new URL(dcr.authorizationUrl);
  nonLoop.searchParams.set('redirect_uri', 'https://evil.example/callback');
  const bad = await fetch(nonLoop, { redirect: 'manual' });
  check('unregistered redirect_uri → an error page, never a redirect', bad.status >= 400 && !bad.headers.get('location'), `${bad.status} ${bad.headers.get('location') ?? ''}`);

  // Negative cases that come back to the (verified) client.
  const back = async (mutate) => {
    const u = new URL(dcr.authorizationUrl); mutate(u.searchParams);
    const r = await fetch(u, { redirect: 'manual' });
    return new URL(r.headers.get('location') ?? 'about:blank').searchParams.get('error');
  };
  same('plain PKCE → invalid_request', await back((s) => s.set('code_challenge_method', 'plain')), 'invalid_request');
  same('wrong resource → invalid_target', await back((s) => s.set('resource', `${BASE}/other`)), 'invalid_target');
  same('unknown scope → invalid_scope', await back((s) => s.set('scope', 'read admin')), 'invalid_scope');

  // PKCE mismatch at the token endpoint.
  const dcr3 = provider({ redirectUrl: `http://127.0.0.1:${port}/callback`, name: `mcp-e2e pkce ${RUN}` });
  dcr3.saved.client = dcr.saved.client;
  await auth(dcr3, { serverUrl: MCP_URL });
  const c3 = await consent(dcr3.authorizationUrl);
  const bad3 = await token({ grant_type: 'authorization_code', code: c3.callback?.searchParams.get('code'), redirect_uri: dcr3.redirectUrl, client_id: dcr.saved.client?.client_id, code_verifier: 'x'.repeat(43), resource: MCP_URL });
  same('PKCE verifier mismatch → 400 invalid_grant, no-store', [bad3.status, bad3.json?.error, bad3.headers.get('cache-control')], [400, 'invalid_grant', 'no-store']);

  // Deny, and read-only downgrade.
  const deny = provider({ redirectUrl: `http://127.0.0.1:${port}/callback`, name: `mcp-e2e deny ${RUN}` });
  deny.saved.client = dcr.saved.client;
  same('Cancel → access_denied back to the client', (await authorize(deny, { approve: false })).denied, 'access_denied');
  const ro = provider({ redirectUrl: `http://127.0.0.1:${port}/callback`, name: `mcp-e2e ro ${RUN}` });
  ro.saved.client = dcr.saved.client;
  const aro = await authorize(ro, { approve: true, scope: 'READ' });
  same('read-only downgrade → scope "read"', [aro.result ?? aro.error, ro.saved.tokens?.scope], ['AUTHORIZED', 'read']);
  if (ro.saved.tokens) grants.push([ro.saved.tokens.refresh_token, dcr.saved.client?.client_id]);

  // ---- refresh rotation, on a grant of its own ----
  const rf = provider({ redirectUrl: `http://127.0.0.1:${port}/callback`, name: `mcp-e2e refresh ${RUN}` });
  rf.saved.client = dcr.saved.client;
  await authorize(rf);
  const t2 = rf.saved.tokens;
  const r1 = await refreshAuthorization(BASE, { metadata: asm, clientInformation: dcr.saved.client, refreshToken: t2?.refresh_token, resource: new URL(MCP_URL) });
  check('refresh (SDK refreshAuthorization) rotates both tokens', r1.refresh_token && r1.refresh_token !== t2?.refresh_token && r1.access_token !== t2?.access_token);
  const reuse = await token({ grant_type: 'refresh_token', refresh_token: t2?.refresh_token, client_id: dcr.saved.client?.client_id });
  same('reusing the old refresh token within 30 s → invalid_grant (M20)', reuse.json?.error, 'invalid_grant');
  const r2 = await token({ grant_type: 'refresh_token', refresh_token: r1.refresh_token, client_id: dcr.saved.client?.client_id });
  same('…and the grant survives that race (M20)', [r2.status, typeof r2.json?.access_token], [200, 'string']);
  

  // ---- Bearer is only for /mcp ----
  const me = await fetch(`${BASE}/api/v1/auth/me`, { headers: { authorization: `Bearer ${r2.json?.access_token}` } });
  same('Bearer on /api/v1 → 401 (cookie-only REST)', me.status, 401);

  // ---- grants show in Settings → tokens, and revoke ----
  const listed = (await rest('GET', '/me/tokens')).json?.data ?? [];
  const row = listed.find((t) => t.source === 'OAUTH' && t.name === `mcp-e2e DCR ${RUN}`);
  // (the DCR grant was revoked by the code reuse above; the port and read-only grants are live)
  check('the OAuth grant is listed in /me/tokens', !!row, `${listed.length} rows`);
  const rv = await fetch(`${BASE}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: r2.json?.refresh_token ?? '', client_id: dcr.saved.client?.client_id ?? '' }) });
  same('POST /oauth/revoke → 200', rv.status, 200);
  same('revoked refresh token → invalid_grant', (await token({ grant_type: 'refresh_token', refresh_token: r2.json?.refresh_token, client_id: dcr.saved.client?.client_id })).json?.error, 'invalid_grant');

  // ---- CIMD: client_id is an https URL to a metadata document we serve (M11) ----
  if (process.env.CIMD_CERT && process.env.CIMD_KEY) {
    let fetched = 0;
    const cimdRedirect = `http://localhost:${port}/callback`;
    cimdServer = createServer({ cert: readFileSync(process.env.CIMD_CERT), key: readFileSync(process.env.CIMD_KEY) }, (req, res) => {
      fetched++;
      const self = `https://127.0.0.1:${cimdServer.address().port}${req.url}`;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ client_id: self, client_name: `mcp-e2e CIMD ${RUN}`, redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }));
    });
    await new Promise((r) => cimdServer.listen(0, '127.0.0.1', r));
    const docUrl = `https://127.0.0.1:${cimdServer.address().port}/client.json?run=${RUN}`;
    const cimd = provider({ redirectUrl: cimdRedirect, clientMetadataUrl: docUrl, name: 'unused' });
    const ac = await authorize(cimd);
    same('CIMD: the SDK used the metadata URL as client_id', cimd.saved.client?.client_id ?? new URL(cimd.authorizationUrl ?? 'about:blank').searchParams.get('client_id'), docUrl);
    same('CIMD: the BE fetched the document; consent shows its name and host', [fetched > 0, ac.info?.json?.client?.name, ac.info?.json?.client?.clientIdHost], [true, `mcp-e2e CIMD ${RUN}`, `127.0.0.1:${cimdServer.address().port}`]);
    same('CIMD: a port-less localhost redirect in the doc matches a random port (M12) → AUTHORIZED', ac.result ?? ac.error, 'AUTHORIZED');
    if (cimd.saved.tokens) grants.push([cimd.saved.tokens.refresh_token, docUrl]);
  } else console.log('SKIP  CIMD (no CIMD_CERT/CIMD_KEY)');

  if (wantTools) {
    const { mcpChecks } = await import('./mcp-tools.mjs');
    await mcpChecks({ BASE, MCP_URL, rest, check, same, projectId, providers: { write: dcr2, read: ro } });
  }
} catch (e) {
  check('UNCAUGHT', false, String(e?.stack ?? e));
} finally {
  for (const [t, client_id] of grants) {
    await fetch(`${BASE}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: t ?? '', client_id: client_id ?? '' }) }).catch(() => {});
  }
  if (projectId) same('cleanup: DELETE the [mcp-e2e] project', (await rest('DELETE', `/projects/${projectId}`)).status, 204);
  cimdServer?.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
