# Deploying with docker-compose

Stack: `postgres` (16, named volume `pgdata`) → `be` (Fastify, port 3000, internal only) →
`fe` (nginx on `${HTTP_PORT:-8080}`, serves the SPA and proxies `/api/` + `/health` to `be`).

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

## Creating the first admin
Users join only by admin invite, so the first admin has to be bootstrapped once.

**Option A (demo/staging only):** load the seed data. This creates `admin@example.com` /
`password123`, so change that password immediately or don't use it on anything reachable.
```sh
docker compose exec be npm run seed
```

**Option B (production):** insert the admin row directly. Hash the password with the backend's own
hashing library (run inside the `be` container, so it matches what login checks):
```sh
# argon2 (swap for bcrypt's `hash(pw, 12)` if the backend uses bcrypt)
HASH=$(docker compose exec -T be node -e "require('argon2').hash(process.argv[1]).then(console.log)" 'S3cure-Passw0rd')
docker compose exec -T postgres psql -U asana -d asana -c \
  "INSERT INTO \"User\" (id, email, name, \"passwordHash\", role, \"isActive\", \"avatarColor\", \"createdAt\")
   VALUES (gen_random_uuid(), 'you@company.com', 'Your Name', '$HASH', 'ADMIN', true, '#6366f1', now());"
```
Then log in and invite everyone else from **Admin → Users**. (Table/column names assume Prisma's
default mapping of the `User` model; check `prisma/schema.prisma` if the insert fails.)

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

## Logs
`docker compose logs -f be` / `fe` / `postgres`.
