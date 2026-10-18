# Deploying Mekari Project with docker-compose

Stack: `postgres` (16, named volume `pgdata`) → `be` (Fastify, port 3000, internal only) →
`fe` (nginx on `${HTTP_PORT:-8080}`, serves the SPA and proxies `/api/` + `/health` to `be`).

## Naming
The product is **Mekari Project**. Several technical identifiers keep the original `asana` names on
purpose, because renaming them would detach a running deployment from its data:

| Identifier | Value | Why it stays |
|---|---|---|
| Compose project | `asana-clone` | Container and network names derive from it |
| Postgres volume | `asana-clone_pgdata` (pinned with `name:`) | Holds all data; a new name means an empty DB |
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
Logical dump (consistent while running, preferred):
```sh
docker compose exec -T postgres pg_dump -U asana -d asana -Fc > asana-$(date +%F).dump
```
Restore into a running stack (stop `be` first so nothing writes during restore):
```sh
docker compose stop be
docker compose exec -T postgres pg_restore -U asana -d asana --clean --if-exists < asana-YYYY-MM-DD.dump
docker compose start be
```
Raw volume snapshot (stop the stack first; restore must use the same Postgres major version):
```sh
docker compose stop
docker run --rm -v asana-clone_pgdata:/data -v "$PWD":/backup alpine \
  tar czf /backup/pgdata-$(date +%F).tgz -C /data .
docker compose start
```
Schedule the `pg_dump` line from cron and copy the dumps off the host.

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
# set DEFAULT_WORKSPACE_NAME in .env now if you don't want "Mekari"
git -C ../ pull && git -C ../../asana-clone-fe pull
docker compose up -d --build
docker compose logs be | grep -i migrat   # the workspaces migration should be listed as applied
```
`DEFAULT_WORKSPACE_NAME` only matters at this moment: changing it afterwards does nothing (rename
the workspace in Workspace settings instead). If something looks wrong, restore the dump with the
v1.1 images. CI's `upgrade` job runs this migration against a database seeded with the
last pre-v1.2 release on every PR.

## Logs
`docker compose logs -f be` / `fe` / `postgres`.
