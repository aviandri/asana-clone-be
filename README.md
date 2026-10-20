# asana-clone-be

Backend API for **Mekari Project**, the internal project-management tool. See [docs/SPEC.md](docs/SPEC.md) for the product scope and API contract.

Node 20 · TypeScript (strict) · Fastify 4 · Prisma 5 · PostgreSQL 16 · zod · Vitest

## Setup

```sh
cp .env.example .env      # defaults point at the shared dev Postgres on 127.0.0.1:5433
npm install               # also runs `prisma generate`
npm run db:migrate        # prisma migrate deploy against DATABASE_URL
npm run build && npm run seed   # optional demo data
npm run dev               # http://localhost:3000 (GET /health)
```

On the shared dev box, wrap heavy commands in the lock: `../heavy.sh npm test`.

## Scripts

| Script | |
|---|---|
| `dev` | run from source with tsx |
| `build` / `start` | compile to `dist/` / run `node dist/server.js` |
| `typecheck` / `lint` | `tsc --noEmit` / the same plus unused-code checks |
| `test` | Vitest integration tests via `app.inject` against `TEST_DATABASE_URL` (must be a `*_test` DB; it is migrated and truncated) |
| `db:migrate` / `db:migrate:dev` | `prisma migrate deploy` / `prisma migrate dev` |
| `seed` | demo data per SPEC §7/§12 (admin/alice/bob @example.com in the "Mekari" organization, plus "Acme Pilot" with guest `guest@partner.test`; password `password123` for all). Refuses if the DB has users; `npm run seed -- --reset` **wipes everything** first. With `NODE_ENV=production`, `--reset` is refused unless `--force-production` is also passed. `npm run seed -- --goals-only` is non-destructive: it adds the demo goal cascade to an already seeded DB that has no goals yet, and skips if the seed users, teams or project are gone. `npm run seed -- --workspaces-demo` is also non-destructive: it adds just "Acme Pilot" (and its guest) once. Runs from `dist/`; `seed:dev` runs from source. |
| `create-admin` | `npm run create-admin -- --email you@co.com --name "You" --password '…'`: creates an ADMIN, or promotes and reactivates an existing user (then name/password are optional). Runs from `dist/`, so it works in the production image. `create-admin:dev` runs it from source. |

## Bootstrapping a deployment

```sh
npm run db:migrate
npm run create-admin -- --email admin@company.com --name "Admin" --password 'a-strong-password'
```
The admin then invites everyone else from the Admin page. Invite links are `${APP_URL}/invite/<token>`; no email is sent.

## Layout

```
src/app.ts          buildApp() factory: error format, db + auth plugins, routes under /api/v1
src/server.ts       entrypoint (listens on HOST:PORT)
src/config.ts       env parsing (zod)
src/errors.ts       AppError + { error: { code, message, details? } } handler
src/plugins/auth.ts sid cookie (signed JWT, 7d); every route needs a session unless config.public
src/lib/access.ts   project visibility + edit/manage rules (SPEC §4)
src/lib/goal-progress.ts  goal progress maths + cycle/depth checks (SPEC §10), pure and unit-tested
src/lib/time.ts     APP_TIMEZONE-aware dates, weeks and goal periods
src/lib/csv.ts      RFC 4180 CSV with formula-injection escaping and a UTF-8 BOM
src/routes/reports.ts  project report, overview, workload, CSV export (SPEC §11)
src/routes/attachments.ts  uploads, serving (Range/ETag, sandbox headers), delete (SPEC §13)
src/lib/storage.ts  StorageDriver + the disk driver (temp file + rename, random keys)
src/lib/attachments.ts  Attachment shape, visibility, post-commit file removal, the hourly sweeper
src/lib/media.ts    magic-byte type sniffing, the inline allowlist, sharp dimensions/thumbnails
src/lib/filenames.ts  filename sanitising, RFC 6266 Content-Disposition
src/lib/link-preview.ts  link previews: the SSRF-safe fetcher, og/twitter parsing, providers, image re-encoding
src/lib/ssrf.ts     the address policy (private, link-local, CGNAT, ULA, mapped forms, …)
src/routes/*        one file per resource
src/scripts/*       CLI entrypoints, compiled to dist/scripts
prisma/             schema (full v1 data model) + migrations
test/               integration tests (one worker, files run in sequence)
```

## Security notes and known v1 limitations

- `POST /auth/login` and `/auth/accept-invite` are rate-limited per IP (`AUTH_RATE_LIMIT_MAX`, default 10/min). Over the limit they return `429` with code `RATE_LIMITED`. The client IP comes from `X-Forwarded-For`, trusting exactly `TRUST_PROXY_HOPS` proxies (default 1, nginx, which overwrites the header), so a client-sent XFF can't choose its own rate-limit bucket.
- **Attachments are user content on our own origin** (SPEC §13). Types are sniffed from bytes (the client's Content-Type is ignored), and only an allowlist (raster images, PDF, audio/video, plain text) is served `inline`; everything else (HTML, SVG, XML, …) is `attachment`. Every byte response carries `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self'; media-src 'self'` and `Cross-Origin-Resource-Policy: same-origin`. Filenames are sanitised (bidi/format controls stripped) and never used for storage paths. Files are removed after the DB commit that deletes their rows; an hourly in-process sweeper removes drafts older than 24 h and unreferenced objects older than 24 h. Uploads are limited per user (`UPLOAD_RATE_LIMIT_MAX` per 10 min) and per file (`MAX_UPLOAD_BYTES`); `REQUEST_TIMEOUT_MS` (15 min) caps any request in total, since nginx streams bodies through unbuffered and only times out per read/write.
- **Link previews are fetched by the server** (SPEC §13), so the fetcher must never reach the internal network: only http(s) on ports 80/443; DNS is resolved once per hop and **every** address checked (loopback, RFC 1918, link-local incl. 169.254.169.254, CGNAT, 0/8, multicast, reserved, IPv6 loopback/ULA/link-local/multicast, NAT64, 6to4, and IPv4-mapped forms of all of them); the connection goes to that pinned address (no second lookup); at most 3 redirects, each a fully re-checked hop; one 6 s budget for the page and its images; HTML read capped at 1 MB and images at 5 MB, both counted after decompression; no cookies or credentials sent. Fetched images are re-encoded to WebP and served from our origin, so clients never contact third parties. `LINK_PREVIEW_ENABLED=false` turns fetching off; `LINK_PREVIEW_ALLOW_PRIVATE` exists for tests only and is refused with `NODE_ENV=production`.
- `npm run seed -- --reset` empties the database but not `STORAGE_DIR`: the sweeper deletes the now-unreferenced files a day later (or empty the directory by hand).
- **Personal access tokens and OAuth tokens** (SPEC §14, with `MCP_ENABLED=true`) are accepted only as `Authorization: Bearer` on `/mcp`; `/api/v1` stays cookie-only, so a leaked token can't drive the REST API. Tokens are 32 random bytes and only their sha256 is stored. A deactivated user's tokens stop working at once; changing a password revokes all of the user's tokens and connected apps. `lastUsedAt` is written at most once a minute per token.
- **OAuth for MCP clients** (SPEC §14): authorization code + PKCE (S256 only) for public clients, dynamic registration (rate-limited per IP, at most 1000 clients) and client ID metadata documents (fetched with the link-preview SSRF rules, same-origin redirects only, ≤ 64 KB, cached 24 h). Unknown clients and unregistered redirect URIs get an error page, never a redirect; loopback redirect URIs match with any port. Refresh tokens rotate; reusing one more than 30 s after its rotation revokes the whole grant. Grant changes lock the user's row, so a refresh can't outrun a revocation or password change. Only hashes of codes and tokens are stored.
- **The MCP server** (`POST /mcp`, SPEC §14) lets Claude work as the user. It's stateless Streamable HTTP with plain JSON responses: a fresh `McpServer` per request, from the pinned `@modelcontextprotocol/sdk`. Every tool calls the REST handlers **in-process** (`app.inject`) as the token's user, so permissions, validation, notifications and activity are exactly the REST API's. Those calls carry a single-use internal ticket, honoured only on injected requests; from the network, that header is a 400. READ tokens see and can call only the 15 read tools. There are no delete, archive or remove tools. Browser `Origin`s other than the app, claude.ai/claude.com and anthropic.com get a 403. Each token is limited to 120 requests a minute. Each tool call is logged with `via: "mcp"`, the token id and the client name (never the token itself).
- Sessions are stateless JWTs. **Changing a password or role doesn't revoke existing sessions** until they expire (7 days). Deactivating a user does take effect immediately, because every request reloads the user.
