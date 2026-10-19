# Deploying Mekari Project with docker-compose

Stack: `postgres` (16, named volume `pgdata`) → `be` (Fastify, port 3000, internal only; attachment
files on the named volume `attachments`) → `fe` (nginx on `${HTTP_PORT:-8080}`, serves the SPA and
proxies `/api/` + `/health` to `be`).

## Naming
The product is **Mekari Project**. Several technical identifiers keep the original `asana` names on
purpose, because renaming them would detach a running deployment from its data:

| Identifier | Value | Why it stays |
|---|---|---|
| Compose project | `asana-clone` | Container and network names derive from it |
| Postgres volume | `asana-clone_pgdata` (pinned with `name:`) | Holds all data; a new name means an empty DB |
| Attachments volume | `asana-clone_attachments` (pinned with `name:`) | Uploaded files; the DB rows point into it |
| DB user / database | `asana` / `asana` | Existing clusters were initialised with them |
| Repos | `asana-clone-be`, `asana-clone-fe` | Unchanged unless the GitHub repos are renamed |

If you ever rename the compose project, the pinned volume keeps the data attached. Compose will warn
that the volume "was created for project asana-clone"; that's expected, and it still uses it. Take a
`pg_dump` first anyway.

## First start
```sh
git clone git@github-personal:aviandri/asana-clone-be.git
git clone git@github-personal:aviandri/asana-clone-fe.git
cd asana-clone-be/deploy
cp .env.example .env          # set POSTGRES_PASSWORD, JWT_SECRET (openssl rand -hex 32), APP_URL
docker compose up -d --build
docker compose ps             # all three should become healthy
curl -fsS localhost:8080/health
```
The `be` container runs `prisma migrate deploy` on every start before launching the app
(set `SKIP_MIGRATIONS=true` on the service to disable).

Production: put TLS in front (or terminate it on a load balancer) and set `APP_URL` to the https
URL. With `NODE_ENV=production` the `sid` cookie is `Secure`, so plain http only works on
`localhost`.

`APP_TIMEZONE` (IANA name, default `Asia/Jakarta`) sets the day boundary for reporting: what
counts as "today" and "overdue", and where Monday-based weeks start. Stored timestamps are UTC
and unaffected; changing it only shifts how reports bucket them. Postgres and the container
clock can stay UTC.

## Creating the first admin
Users join only by admin invite, so the first admin has to be bootstrapped once:
```sh
docker compose exec be npm run create-admin -- \
  --email you@company.com --name "Your Name" --password 'a-strong-password'
```
Running it for an existing email promotes that user to ADMIN (`--name`/`--password` optional).
The user becomes ADMIN of the default workspace (`DEFAULT_WORKSPACE_NAME`, default `Mekari`),
which is created if the database has none. Then log in and invite everyone else from
**Workspace settings → Invites**.

For a demo/staging stack you can load sample data instead (`docker compose exec be npm run seed`,
once the backend ships a compiled seed script). The seed creates `admin@example.com` /
`password123`, so never use it on anything reachable.

## Backups
A backup is the database **and** the `attachments` volume (uploaded files, link preview images;
SPEC §13). Rows reference files by key, so back up and restore both from the same point in time:
a database without its files shows broken attachments, and the backend's hourly sweeper deletes
any file that has no row and is older than 24 h.

Back up (both safe while the stack runs; attachments are written to a temp name and renamed,
never changed in place). Take the attachments right after the dump; a file uploaded in between
just has no row yet:
```sh
docker compose exec -T postgres pg_dump -U asana -d asana -Fc > asana-$(date +%F).dump
docker run --rm -v asana-clone_attachments:/data:ro -v "$PWD":/backup alpine \
  tar czf /backup/attachments-$(date +%F).tgz -C /data .
```
Schedule both lines from cron and copy the files off the host.

Restore: one procedure, database first, then files, and **never start `be` between the two
restores**. `tar` keeps the files' original mtimes, so to a `be` that starts against an old or
empty database every restored file looks like an orphan older than 24 h, and its sweeper deletes
them all.
```sh
docker compose stop be                       # postgres keeps running; nothing reads or sweeps
docker compose exec -T postgres pg_restore -U asana -d asana --clean --if-exists < asana-YYYY-MM-DD.dump
docker run --rm -v asana-clone_attachments:/data -v "$PWD":/backup alpine \
  sh -c 'find /data -mindepth 1 -delete && tar xzf /backup/attachments-YYYY-MM-DD.tgz -C /data && chown -R 1000:1000 /data'
docker compose start be
```
(`1000:1000` is the `node` user the backend runs as.)

Raw volume snapshot of the database instead of `pg_dump` (stop the stack first; restore must use
the same Postgres major version). The restore rule is the same: put back `pgdata` and
`attachments` from the same point in time before `be` starts.
```sh
docker compose stop
docker run --rm -v asana-clone_pgdata:/data -v "$PWD":/backup alpine \
  tar czf /backup/pgdata-$(date +%F).tgz -C /data .
docker compose start
```

## Upgrades
```sh
git -C ../ pull && git -C ../../asana-clone-fe pull
docker compose up -d --build   # migrations apply automatically when be restarts
```
Take a `pg_dump` before upgrading anything that ships a migration.

### Upgrading to v1.2 (workspaces)
v1.2 adds workspaces (SPEC §12), and its migration rewrites existing data in place:
- creates one workspace named `DEFAULT_WORKSPACE_NAME` (default `Mekari`, not an organization);
- moves every team, project, task, goal, notification and invite into it;
- turns each user's role into a membership of that workspace (inactive users stay inactive);
- drops the old `User.role` column.

No data is deleted, but there's no down-migration, so **take a `pg_dump` first** (see Backups)
and keep it until you've checked the upgrade:
```sh
docker compose exec -T postgres pg_dump -U asana -d asana -Fc > asana-pre-v1.2-$(date +%F).dump
# set DEFAULT_WORKSPACE_NAME in .env now if you don't want "Mekari" (see below)
git -C ../ pull && git -C ../../asana-clone-fe pull
docker compose up -d --build
docker compose logs be | grep -i migrat   # the workspaces migration should be listed as applied
```
The migration is plain SQL, so it can't read env vars. It takes the name from the Postgres setting
`mekari.default_workspace_name`, and the `be` entrypoint sets that from `DEFAULT_WORKSPACE_NAME`
before migrating. Without the compose entrypoint (e.g. running `prisma migrate deploy` yourself),
set it by hand first: `ALTER DATABASE asana SET mekari.default_workspace_name = 'Your Name';`.
The name only matters at this moment: changing it afterwards does nothing (rename the workspace
in Workspace settings instead). If something looks wrong, restore the dump with the
v1.1 images. A fresh, empty database gets no workspace from the migration; `create-admin` (or
the seed) creates it. CI's `upgrade` job runs this migration against a database seeded with the
last pre-v1.2 release on every PR.

Users who were deactivated before v1.2 stay deactivated globally, so re-activating
them under Workspace settings › Members isn't enough on its own. To let one log in again,
re-enable their account in the database:
```sh
docker compose exec postgres psql -U asana -d asana \
  -c "UPDATE \"User\" SET \"isActive\" = true WHERE email = 'them@company.com';"
```
Use `npm run create-admin` only for people who should also become workspace admins: it re-enables
the account *and* makes them ADMIN of the default workspace.

### Upgrading to v1.3 (attachments)
v1.3 adds file and link attachments (SPEC §13). Its migration adds tables, columns and new
`ActivityType` enum values (Postgres can't drop enum values again), so take a `pg_dump` first as
usual. `docker compose up -d --build` creates the `asana-clone_attachments` volume on first start;
add it to your backups from then on (see Backups).

- **Size limit:** 100 MB per file. nginx accepts up to 105 MB on `/api/` (multipart overhead) and
  streams uploads to `be`, which answers `413 PAYLOAD_TOO_LARGE` above 100 MB. Other paths keep
  nginx's 2 MB limit.
- **Cloudflare:** Cloudflare proxies (including the quick tunnel used for the preview) cap request
  bodies at 100 MB *including* multipart overhead, so a file right at the limit can be rejected by
  Cloudflare with its own 413 before it reaches nginx. Direct and LAN deployments aren't affected.
- **Link previews:** `be` fetches titles and images for attached links from the internet (with
  SSRF protection). Set `LINK_PREVIEW_ENABLED=false` in `.env` if the server has no outbound
  access or you don't want it to make requests; link cards still work, without previews.
- **Disk:** files live on the Docker host's disk under the volume. Watch free space
  (`docker system df -v | grep attachments`).

## Logs
`docker compose logs -f be` / `fe` / `postgres`.
