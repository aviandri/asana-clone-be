# Deploying Mekari Project on Mekari OneDeploy

[Mekari OneDeploy](https://mekarionedeploy.mekari.io) is Mekari's internal Kubernetes PaaS. Each repo
becomes one **service**: OneDeploy builds the repo-root `Dockerfile` with BuildKit, then applies a
Deployment, Service, Ingress, ConfigMap and HPA. The web app is two services plus a managed
PostgreSQL:

```
browser ──VPN──▶ ingress ─▶ fe  (nginx :80, project.mekari.io)  ── /api, /mcp, /oauth ──▶ be (:3000) ─▶ PostgreSQL 17 (RDS)
                                                                                           └────────▶ OSS/S3 bucket (attachments)
```

Platform facts this guide relies on (checked 2026-11-23, OneDeploy v2.21.0):
- **Bitbucket only.** GitHub URLs are rejected, so `main` is mirrored to Bitbucket (below).
- **No persistent volumes**, no exec shell, no release command, no health-check field. So:
  - attachments go to an S3-compatible bucket (`STORAGE_DRIVER=s3`),
  - the first admin comes from `BOOTSTRAP_ADMIN_*`,
  - migrations run on container start (already the case),
  - probes are fixed in the manifest review step.
- **Ingress is on a private load balancer.** The app is reachable on the Mekari network/VPN only, so
  claude.ai MCP connectors (Anthropic's cloud) can't reach `/mcp`. MCP clients on the VPN can.

## 0. Once: mirror the repos to Bitbucket

1. In the Mekari Bitbucket workspace, create empty repos `asana-clone-be` and `asana-clone-fe`.
2. Create a **repository access token** with *write* on each (Repository settings → Access tokens).
3. In each GitHub repo (Settings → Secrets and variables → Actions), add:
   - variable `BITBUCKET_REPO` = `<workspace>/asana-clone-be` (or `-fe`)
   - secret `BITBUCKET_TOKEN` = that repo's token
4. Run the **Mirror to Bitbucket** workflow once by hand (Actions → Run workflow). After that, every
   push to `main` that passes CI is mirrored.

## 1. Attachments bucket

Ask the OneDeploy/infra team for a **private** Alibaba OSS bucket (or any S3-compatible one) and an
access key limited to it. Add a lifecycle rule that aborts incomplete multipart uploads after 1 day,
and turn on versioning (that's the attachment backup). See the README's S3 storage section.

Without a bucket the backend still runs on the default `disk` driver, but **every redeploy or
restart deletes all uploaded files**. Only acceptable for a throwaway trial.

## 2. Backend service

Project **Mekari Project** → **Deploy Service**:

| Field | Value |
|---|---|
| Git Repository | `https://bitbucket.org/<workspace>/asana-clone-be` |
| Deploy from | Branch `main` |
| Application Name | `mekari-project-be` (namespaces become `sandbox-` / `production-mekari-project-be`) |
| Subdomain Production | `project-api` + `.mekari.io` |
| Application Port | `3000` |
| Use database for this service | ✔ PostgreSQL 17, name `mekari_project`, env format **Single DATABASE_URL** |

Environment variables (🔒 = toggle **Secret**):

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `3000` |
| `APP_URL` | `https://project.mekari.io` (the **frontend** URL: OAuth issuer, deep links) |
| 🔒 `JWT_SECRET` | `openssl rand -hex 32` |
| `APP_TIMEZONE` | `Asia/Jakarta` |
| `DEFAULT_WORKSPACE_NAME` | `Mekari` |
| `TRUST_PROXY_HOPS` | `1` (the frontend's nginx is the one hop in front) |
| `BOOTSTRAP_ADMIN_EMAIL` | your email |
| `BOOTSTRAP_ADMIN_NAME` | your name |
| 🔒 `BOOTSTRAP_ADMIN_PASSWORD` | a strong password (at least 8 characters) |
| `STORAGE_DRIVER` | `s3` |
| `S3_BUCKET` | the bucket name |
| `S3_ENDPOINT` | e.g. `https://oss-ap-southeast-5.aliyuncs.com` |
| `S3_REGION` | e.g. `oss-ap-southeast-5`. Check against the bucket; see the S3 section of the README |
| `S3_PREFIX` | `attachments/` |
| 🔒 `S3_ACCESS_KEY_ID` / 🔒 `S3_SECRET_ACCESS_KEY` | the bucket key |

`DATABASE_URL` is injected by the database checkbox, so don't add it by hand.

**Manifest review step** (after the build, before apply), edit:
- **HPA**: `maxReplicas: 1`. Rate limits are kept in memory per pod, and with the disk driver files live
  in one pod. Scale only after moving to S3 and accepting per-pod rate limits.
- **Deployment probes**: point liveness/readiness `httpGet.path` at `/health`, port 3000. The backend
  has no `/` route, so a probe on `/` fails. Give startup ~60 s (migrations run first).
- **Resources**: memory request 256Mi, limit 768Mi (thumbnails use sharp).

## 3. Frontend service

| Field | Value |
|---|---|
| Git Repository | `https://bitbucket.org/<workspace>/asana-clone-fe` |
| Application Name | `mekari-project-fe` |
| Subdomain Production | `project` + `.mekari.io` |
| Application Port | `80` |
| Use database | ✘ |

| Key | Value |
|---|---|
| `BACKEND_URL` | `http://mekari-project-be.production-mekari-project-be.svc.cluster.local:3000` (see below) |
| `REAL_IP_FROM` | the cluster's pod/node CIDR(s) the ingress connects from, e.g. `10.0.0.0/8` (ask the platform team) |

`BACKEND_URL`: the in-cluster address keeps the client IP intact (ingress → fe → be). It assumes the
Service is named after the app and no NetworkPolicy blocks cross-namespace traffic; neither is
documented. If the frontend logs `502` / `host not found`, use `https://project-api.mekari.io`
instead. That works too, but the backend ingress then reports the frontend pod as the client, so all
users share one login rate-limit bucket.

The frontend is stateless, so the default HPA is fine. Its probes can stay on `/`.

## 4. Verify

1. `https://project.mekari.io/health` → `{"ok":true}`.
2. The backend log shows `bootstrap-admin: created admin …`. Log in with it.
3. **Remove `BOOTSTRAP_ADMIN_PASSWORD`** from the backend env and redeploy. Once a user exists it's
   ignored anyway, but it shouldn't sit in a Secret.
4. Upload an attachment, redeploy the backend, check it still opens (proves S3 works).
5. Log in from two machines and check the backend log's `remoteAddress` differs per user, not one
   ingress/pod IP (proves `REAL_IP_FROM` and `TRUST_PROXY_HOPS`).
6. Invite the team from **Workspace settings → Invites**.

## 5. Auto-deploy and operations

- Per service: service page → **Webhook** (owner/admin) adds a Bitbucket webhook, so a mirrored push to
  `main` redeploys. Deploy the backend before the frontend when a release changes the API.
- Logs, restarts and rollbacks are on the service page. Rollback re-applies an earlier image, but
  migrations are not rolled back.
- Backups: the managed RDS instance's backups plus bucket versioning. Restore DB and bucket from the
  same point in time (see README → Backups for why).
- Sandbox: the platform also creates `sandbox-<app>` namespaces. Give a sandbox its own database,
  bucket prefix and `APP_URL`; never point it at production's.
