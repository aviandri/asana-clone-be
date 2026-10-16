# asana-clone-be

Backend API for the internal Asana clone. See [docs/SPEC.md](docs/SPEC.md) for the product scope and API contract.

Node 20 · TypeScript (strict) · Fastify 4 · Prisma 5 · PostgreSQL 16 · zod · Vitest

## Setup

```sh
cp .env.example .env      # defaults point at the shared dev Postgres on 127.0.0.1:5433
npm install               # also runs `prisma generate`
npm run db:migrate        # prisma migrate deploy against DATABASE_URL
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

## Layout

```
src/app.ts          buildApp() factory: error format, db + auth plugins, routes under /api/v1
src/server.ts       entrypoint (listens on HOST:PORT)
src/config.ts       env parsing (zod)
src/errors.ts       AppError + { error: { code, message, details? } } handler
src/plugins/auth.ts sid cookie (signed JWT, 7d); every route needs a session unless config.public
src/routes/*        one file per resource
prisma/             schema (full v1 data model) + migrations
test/               integration tests (one worker, files run in sequence)
```
