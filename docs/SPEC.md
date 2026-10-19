# Mekari Project — Product & API Spec (v1)

Internal project-management tool for a ~100-employee company. Multi-workspace since v1.2 (§12);
the company is the default workspace.
This file is the **contract** between `asana-clone-be` and `asana-clone-fe`. The copy in the BE repo
(`docs/SPEC.md`) is canonical; the FE repo mirrors it. Changes to the contract go through the
orchestrator — do not silently diverge.

## 1. Scope

### v1 (MVP)
- Auth: email + password, httpOnly cookie session. Admin invites users (invite link, no email sending).
- Users & roles: `ADMIN`, `MEMBER`. Admin can deactivate users and change roles.
- Teams: create/edit, add/remove members.
- Projects: belong to a team; privacy `PUBLIC` | `TEAM` | `PRIVATE`; color; archive.
- Sections inside projects (ordered).
- Tasks: title, description (markdown), assignee, due date, start date, priority, completed,
  section, ordering, subtasks (one level deep is enough for UI; API allows parentId), followers.
- Views: **List** (grouped by section, inline edit), **Board** (Kanban by section, drag & drop),
  **Calendar** (by due date, month view). Task detail side panel.
- My Tasks (assigned to me, grouped by due-date buckets in FE).
- Comments + activity feed ("stories") on tasks.
- Inbox: notifications (assigned, commented, completed, mentioned via `@[Name](userId)`).
- Global search (tasks, projects, users).

### v1.1: see §10 Goals/OKRs and §11 Reporting

### v1.2: see §12 Workspaces

### v1.3 (in progress): see §13 Attachments & links

### Later (do NOT build yet)
Tags, custom fields, real-time (WebSocket), Google SSO, email notifications,
multi-project tasks, timeline/Gantt, portfolios, goal notifications.

## 2. Tech stack & conventions

| | |
|---|---|
| Backend | Node 20, TypeScript (strict), Fastify 4, Prisma 5, PostgreSQL 16, zod, argon2 (or bcrypt), Vitest |
| Frontend | React 18, Vite, TypeScript (strict), React Router 6, TanStack Query 5, Tailwind 3, dnd-kit, date-fns, Vitest + Testing Library |
| Ports (dev) | BE `3000`; FE `5173` with Vite proxy `/api` → `http://localhost:3000`; Postgres `5433` |
| DB (dev) | `postgresql://postgres:postgres@localhost:5433/asana` ; tests use `asana_test` |

No Docker on the dev box. A shared Postgres is run via `embedded-postgres` from
`/home/claude/projects/asana-clone/devdb` (owned by the platform worker). Deployment target is
docker-compose (postgres + be + fe/nginx).

**API conventions**
- Base path `/api/v1`. JSON, camelCase. IDs are UUID strings. Timestamps ISO-8601 UTC.
  `dueDate`/`startDate` are date-only strings `YYYY-MM-DD` (or `null`).
- Auth: cookie `sid` (httpOnly, SameSite=Lax, Secure in prod) holding a signed JWT (7d).
  Every endpoint except `/auth/login`, `/auth/accept-invite`, `/health` requires auth → `401`.
- List responses: `{ "data": [...] }`. Single resources: the object itself.
- Errors: `{ "error": { "code": "NOT_FOUND" | "VALIDATION" | "UNAUTHORIZED" | "FORBIDDEN" | "CONFLICT" | "GONE" | "RATE_LIMITED" | "PAYLOAD_TOO_LARGE" | "INTERNAL", "message": string, "details"?: any } }`
  with matching HTTP status (404/400/401/403/409/410/429/413/500). `GONE` = used or expired invite; `RATE_LIMITED` = too many login / accept-invite attempts.
- `error.details` (when present, e.g. on `VALIDATION`) is a zod-style issue array: `[{ "path": ["assigneeId"], "message": "..." }]`.
- `POST` endpoints that create a resource return `201` (FE: treat any 2xx as success)..
- Ordering uses float `position`. Clients compute a position between neighbours
  (`(prev+next)/2`, or `last+1000` when appending). Server may renormalise.
- `PATCH` accepts any subset of the writable fields; `null` clears a nullable field.

## 3. Data model (Prisma-level)

```
User          id, email(unique, lowercased), name, passwordHash, role(ADMIN|MEMBER), isActive, avatarColor, createdAt
Invite        id, email, role, token(unique), invitedById, expiresAt, acceptedAt?
Team          id, name, description?, createdAt
TeamMember    teamId, userId  (PK both)
Project       id, teamId, ownerId, name, description?, color, privacy(PUBLIC|TEAM|PRIVATE), archived, defaultView(LIST|BOARD|CALENDAR), createdAt, updatedAt
ProjectMember projectId, userId, role(OWNER|EDITOR|COMMENTER)  (PK both)
Section       id, projectId, name, position(float)
Task          id, projectId?, sectionId?, parentId?, title, description?, assigneeId?, creatorId,
              dueDate?(date), startDate?(date), priority(NONE|LOW|MEDIUM|HIGH), completed, completedAt?,
              position(float), createdAt, updatedAt
TaskFollower  taskId, userId  (PK both)
Comment       id, taskId, authorId, body, createdAt, editedAt?
Activity      id, taskId, actorId, type, data(json), createdAt
Notification  id, userId(recipient), actorId, taskId?, type(ASSIGNED|COMMENTED|COMPLETED|MENTIONED), read, createdAt
```
Deleting a project cascades sections/tasks. Deleting a section moves its tasks to `sectionId=null`.
Subtasks inherit nothing automatically; they have `parentId` and `projectId` of the parent.

Activity `type` values: `CREATED`, `COMPLETED`, `REOPENED`, `ASSIGNED` (`{assigneeId}`),
`UNASSIGNED`, `DUE_DATE_CHANGED` (`{from,to}`), `MOVED_SECTION` (`{fromSectionId,toSectionId}`),
`RENAMED` (`{from,to}`), `PRIORITY_CHANGED` (`{from,to}`), `DESCRIPTION_CHANGED`.

Notifications: assignee gets `ASSIGNED` when assigned by someone else; followers (minus actor) get
`COMMENTED` / `COMPLETED`; mentioned users get `MENTIONED`. Assignee and creator auto-follow;
commenting auto-follows.

## 4. Permissions
- `ADMIN`: everything.
- A user can **see** a project if: privacy `PUBLIC`; or `TEAM` and they're in the team; or they're
  a `ProjectMember`. Not visible → `404` (don't leak existence).
- Anyone who can see a project can create/edit tasks, sections and comments in it, **except**
  `ProjectMember.role=COMMENTER` (comments only → `403` on other writes).
- Project settings (rename, privacy, archive, delete, members): project `OWNER`, or ADMIN.
- Tasks with `projectId=null` (personal tasks) are visible to creator, assignee, followers.

## 5. Shared object shapes (responses)

```ts
type UserSummary = { id: string; name: string; email: string; avatarColor: string };
type User = UserSummary & { role: 'ADMIN'|'MEMBER'; isActive: boolean; createdAt: string };

type Team = { id: string; name: string; description: string|null; memberCount: number; createdAt: string };
type TeamDetail = Team & { members: UserSummary[] };

type Section = { id: string; projectId: string; name: string; position: number };

type Project = {
  id: string; teamId: string; name: string; description: string|null; color: string;
  privacy: 'PUBLIC'|'TEAM'|'PRIVATE'; archived: boolean; defaultView: 'LIST'|'BOARD'|'CALENDAR';
  owner: UserSummary; createdAt: string; updatedAt: string;
  myRole: 'OWNER'|'EDITOR'|'COMMENTER'|null;   // null = access via team/public
};
type ProjectDetail = Project & {
  sections: Section[];   // ordered by position
  members: { user: UserSummary; role: 'OWNER'|'EDITOR'|'COMMENTER' }[];
  team: { id: string; name: string };
};

type Task = {
  id: string; projectId: string|null; sectionId: string|null; parentId: string|null;
  title: string; description: string|null;
  assignee: UserSummary|null; creator: UserSummary;
  dueDate: string|null; startDate: string|null;
  priority: 'NONE'|'LOW'|'MEDIUM'|'HIGH';
  completed: boolean; completedAt: string|null; position: number;
  subtaskCount: number; completedSubtaskCount: number; commentCount: number;
  project: { id: string; name: string; color: string } | null;
  createdAt: string; updatedAt: string;
};
type TaskDetail = Task & { followers: UserSummary[]; subtasks: Task[]; parent: { id: string; title: string } | null };

type Story =
  | { kind: 'comment'; id: string; author: UserSummary; body: string; createdAt: string; editedAt: string|null }
  | { kind: 'activity'; id: string; actor: UserSummary; type: string; data: any; createdAt: string };

type Notification = {
  id: string; type: 'ASSIGNED'|'COMMENTED'|'COMPLETED'|'MENTIONED'; read: boolean; createdAt: string;
  actor: UserSummary; task: { id: string; title: string; projectId: string|null } | null;
};
```

## 6. Endpoints (`/api/v1`)

### Health & auth
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/health` | | `{ok:true}` (no auth, not under /api/v1 also OK at `/health`) |
| POST | `/auth/login` | `{email,password}` | `User`, sets cookie. 401 on bad creds / inactive |
| POST | `/auth/logout` | | `204`, clears cookie |
| GET | `/auth/me` | | `User` |
| GET | `/auth/invites/:token` | | `{email, role}` or 404/410 (no auth) |
| POST | `/auth/accept-invite` | `{token,name,password}` | `User`, sets cookie |

### Users & admin
| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | `/users` | `?q=` (name/email contains, active only) | `{data: (UserSummary & {role: WorkspaceRole})[]}` (role in the current workspace, §12 W8) |
| GET | `/users/:id` | | `User` |
| PATCH | `/users/me` | `{name?, avatarColor?, currentPassword?, newPassword?}` | `User` |
| GET | `/admin/users` | ADMIN | `{data: User[]}` (incl. inactive) |
| PATCH | `/admin/users/:id` | `{role?, isActive?}` ADMIN | `User` |
| POST | `/admin/invites` | `{email, role}` ADMIN | `{id, email, role, token, inviteUrl, expiresAt}` (`inviteUrl` = `${APP_URL}/invite/${token}`) |
| GET | `/admin/invites` | ADMIN | `{data: Invite[]}` (pending) |
| DELETE | `/admin/invites/:id` | ADMIN | `204` |

### Teams
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/teams` | `?mine=true` (omit = all teams in the workspace) | `{data: Team[]}` |
| POST | `/teams` | `{name, description?}` (creator becomes member) | `TeamDetail` |
| GET | `/teams/:id` | | `TeamDetail` |
| PATCH | `/teams/:id` | `{name?, description?}` (team member or ADMIN) | `TeamDetail` |
| DELETE | `/teams/:id` | ADMIN; 409 if it has projects | `204` |
| POST | `/teams/:id/members` | `{userId}` | `TeamDetail` |
| DELETE | `/teams/:id/members/:userId` | | `TeamDetail` |

### Projects & sections
| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | `/projects` | `?teamId=&archived=false&q=` (visible only) | `{data: Project[]}` |
| POST | `/projects` | `{teamId, name, description?, color?, privacy?='TEAM', defaultView?='LIST'}` creates sections "To do","In progress","Done"; creator = OWNER. Caller must be a member of the team (ADMIN exempt) → else `403` | `ProjectDetail` |
| GET | `/projects/:id` | | `ProjectDetail` |
| PATCH | `/projects/:id` | `{name?, description?, color?, privacy?, archived?, defaultView?}` | `ProjectDetail` |
| DELETE | `/projects/:id` | | `204` |
| POST | `/projects/:id/members` | `{userId, role}` | `ProjectDetail` |
| PATCH | `/projects/:id/members/:userId` | `{role}` — demoting/removing the last OWNER → `409` | `ProjectDetail` |
| DELETE | `/projects/:id/members/:userId` | | `ProjectDetail` |
| POST | `/projects/:id/sections` | `{name, position?}` | `Section` |
| PATCH | `/sections/:id` | `{name?, position?}` | `Section` |
| DELETE | `/sections/:id` | | `204` |

### Tasks
| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | `/projects/:id/tasks` | `?completed=true|false` (omit = all), `?assigneeId=` — top-level only (`parentId=null`), ordered by section position then task position | `{data: Task[]}` |
| GET | `/me/tasks` | `?completed=false` — top-level & subtasks assigned to me | `{data: Task[]}` |
| POST | `/tasks` | `{title, projectId?, sectionId?, parentId?, description?, assigneeId?, dueDate?, startDate?, priority?, position?}` | `TaskDetail` |
| GET | `/tasks/:id` | | `TaskDetail` |
| PATCH | `/tasks/:id` | any writable field incl. `sectionId`, `position`, `completed`, `assigneeId`, `projectId` | `TaskDetail` |
| DELETE | `/tasks/:id` | (deletes subtasks too) | `204` |
| POST | `/tasks/:id/followers` | `{userId}` | `TaskDetail` |
| DELETE | `/tasks/:id/followers/:userId` | | `TaskDetail` |

### Stories / comments
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/tasks/:id/stories` | | `{data: Story[]}` oldest first |
| POST | `/tasks/:id/comments` | `{body}` (markdown; mentions as `@[Name](userId)`) | `Story` (kind comment) |
| PATCH | `/comments/:id` | `{body}` author only | `Story` |
| DELETE | `/comments/:id` | author or ADMIN | `204` |

### Notifications & search
| Method | Path | Query/Body | Returns |
|---|---|---|---|
| GET | `/notifications` | `?unread=true&limit=50` newest first | `{data: Notification[], unreadCount: number}` |
| POST | `/notifications/:id/read` | | `204` |
| POST | `/notifications/read-all` | | `204` |
| GET | `/search` | `?q=` (min 2 chars, case-insensitive contains, visible only, 10 each) | `{tasks: Task[], projects: Project[], users: UserSummary[]}` |

## 7. Seed data (`npm run seed`)
Admin `admin@example.com` / `password123`; members `alice@example.com`, `bob@example.com`
(same password). Teams "Engineering", "Marketing". 3 projects with sections and ~30 tasks
(mixed assignees, due dates, priorities, a few subtasks and comments).

## 8. Repo / workflow rules
- Work on feature branches, open PRs with `gh pr create`; the orchestrator reviews & merges.
- Remotes use the SSH alias `git@github-personal:aviandri/<repo>.git` (the default github.com key
  has no access).
- Keep processes lean — the box has little free RAM. Don't leave watchers/dev servers running
  when not needed; one dev server per worker max.

## 9. Build & deployment conventions (BE)
The platform session writes the Dockerfile and CI against these, so keep to them:
- package.json scripts: `build` (tsc → `dist/`), `start` = `node dist/server.js`, `typecheck`, `lint`, `test` (vitest), `seed`.
- Prisma schema at `prisma/schema.prisma`; `prisma` goes in `dependencies` (runtime image runs `prisma migrate deploy`).
- Env: `DATABASE_URL`, `TEST_DATABASE_URL`, `JWT_SECRET`, `APP_URL`, `PORT=3000`, `HOST=0.0.0.0`, `NODE_ENV`, `APP_TIMEZONE` (IANA, default `Asia/Jakarta`, used by reports).
- `GET /health` → `{ok:true}` on :3000 (outside `/api/v1`). FE nginx proxies `/api/` and `/health` to `be:3000`.
- Dev DBs: `postgresql://postgres:postgres@localhost:5433/asana` and `.../asana_test` (already running).
- Run heavy commands via `/home/claude/projects/asana-clone/heavy.sh <cmd>` (shared lock; low RAM).

## 10. Goals / OKRs (v1.1)

Asana-style goals. A **goal** is an Objective with optional **key results** (KRs). Goals
**cascade**: a goal may align to a parent goal (company → team → individual), and progress can
roll up from sub-goals, key results or linked projects.

### Data model
```
Goal        id, title, description?, ownerId, isCompany(bool), teamId?, parentId? (→ Goal),
            timePeriod, status, progressSource, manualProgress(float 0–100, default 0),
            weight(int ≥1, default 1), createdAt, updatedAt
KeyResult   id, goalId, title, metricType(NUMBER|PERCENT|CURRENCY|BOOLEAN), startValue, targetValue,
            currentValue (floats), unit?, ownerId?, position(float), createdAt, updatedAt
GoalProject goalId, projectId (PK both)
GoalUpdate  id, goalId, authorId, status, progress(float snapshot), body?, createdAt
```
- `timePeriod`: `YYYY` | `YYYY-H1|H2` | `YYYY-Q1..Q4` (validated by regex).
- `status`: `NO_STATUS` (default) | `ON_TRACK` | `AT_RISK` | `OFF_TRACK` | `ACHIEVED` | `PARTIAL` | `MISSED` | `DROPPED`.
- `progressSource`: `KEY_RESULTS` (default) | `SUB_GOALS` | `PROJECTS` | `MANUAL`.
- Deleting a goal deletes its KRs, links and updates; its children get `parentId = null`.
- `parentId` must not create a cycle (→ `400 VALIDATION` on `parentId`); max depth 6. A goal can't
  be its own parent.
- `BOOLEAN` KRs: start 0, target 1, current 0 or 1.

### Clarifications (agreed)
- Changing level via PATCH (`isCompany` / `teamId`) also requires *create* permission for the new
  level (403 otherwise). Exclusivity is checked on the resulting state: send `teamId: null` with `isCompany: true`.
- Max depth 6 = at most 6 goals in a chain (root = 1); re-parenting checks ancestor depth + moved subtree height.
- Roll-ups use unrounded values; rounding to 1 decimal happens once, at output.
- A KR owner who can't edit the goal may PATCH only `currentValue` (other fields → 403). BOOLEAN KRs
  force start/target to 0/1; `currentValue` must be 0 or 1 (400 otherwise).
- `/goals/time-periods`: newest year first; within a year `YYYY, H1, Q1, Q2, H2, Q3, Q4`; "current" uses `APP_TIMEZONE`.
- Bad `ownerId`/`parentId` → 400 VALIDATION on that path; unknown `teamId` → 404; linking a project you can't see → 404.

### Progress (computed by the server on every read, 0–100, rounded to 1 decimal)
- **KR progress** = clamp((current − start) / (target − start) × 100, 0, 100); if target == start → 100 when current ≥ target, else 0. Works for decreasing targets (start > target).
- `KEY_RESULTS`: mean of its KRs' progress (0 if none).
- `SUB_GOALS`: weight-averaged progress of its direct children (recursive; 0 if none).
- `PROJECTS`: completed ÷ total over **all** tasks (incl. subtasks) of linked projects (0 if no tasks).
- `MANUAL`: `manualProgress`.

### Permissions
- Every active user can **see** every goal (goals are company-wide).
- Goal **levels**: *company* (`isCompany = true`, `teamId = null`), *team* (`teamId` set), or
  *personal* (`isCompany = false`, `teamId = null`). `isCompany` and `teamId` are mutually exclusive (→ 400).
- **Create**: company goals → ADMIN only; team goals → members of that team or ADMIN; personal
  goals → anyone. `ownerId` defaults to the caller and must be an active user.
- **Edit / delete / manage KRs, links**: goal owner, ADMIN, or (team goals) any member of its team.
- **Update a KR's `currentValue`**: additionally the KR's owner.
- **Post a status update**: anyone who can edit the goal, or owns one of its KRs.
- Linked projects the viewer can't see are omitted from `projects` and counted in
  `hiddenProjectCount` (their task counts still feed `PROJECTS` progress).
Responses include `canEdit: boolean` for the caller.

### Shapes
```ts
type GoalStatus = 'NO_STATUS'|'ON_TRACK'|'AT_RISK'|'OFF_TRACK'|'ACHIEVED'|'PARTIAL'|'MISSED'|'DROPPED';
type Goal = {
  id: string; title: string; description: string|null;
  owner: UserSummary; team: { id: string; name: string } | null; isCompany: boolean;
  parentId: string|null; timePeriod: string; status: GoalStatus;
  progressSource: 'KEY_RESULTS'|'SUB_GOALS'|'PROJECTS'|'MANUAL';
  progress: number; weight: number; keyResultCount: number; childCount: number;
  canEdit: boolean; createdAt: string; updatedAt: string;
};
type KeyResult = {
  id: string; goalId: string; title: string; metricType: 'NUMBER'|'PERCENT'|'CURRENCY'|'BOOLEAN';
  startValue: number; targetValue: number; currentValue: number; unit: string|null;
  owner: UserSummary|null; progress: number; position: number; updatedAt: string;
};
type GoalUpdate = { id: string; goalId: string; author: UserSummary; status: GoalStatus; progress: number; body: string|null; createdAt: string };
type GoalDetail = Goal & {
  parent: { id: string; title: string } | null;
  keyResults: KeyResult[];               // by position
  children: Goal[];                      // direct sub-goals
  projects: { project: { id: string; name: string; color: string }; total: number; completed: number }[];
  hiddenProjectCount: number;
  latestUpdate: GoalUpdate | null;
};
```

### Endpoints
| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | `/goals` | `?timePeriod=&teamId=&ownerId=&company=true&q=` — flat list, FE builds the tree from `parentId` | `{data: Goal[]}` |
| POST | `/goals` | `{title, timePeriod, description?, ownerId?, teamId?, isCompany?, parentId?, progressSource?, weight?}` | `201 GoalDetail` |
| GET | `/goals/:id` | | `GoalDetail` |
| PATCH | `/goals/:id` | any of `title, description, ownerId, teamId, isCompany, parentId, timePeriod, status, progressSource, manualProgress, weight` | `GoalDetail` |
| DELETE | `/goals/:id` | | `204` |
| POST | `/goals/:id/key-results` | `{title, metricType, startValue?=0, targetValue, currentValue?=startValue, unit?, ownerId?, position?}` | `201 KeyResult` |
| PATCH | `/key-results/:id` | any writable KR field | `KeyResult` |
| DELETE | `/key-results/:id` | | `204` |
| POST | `/goals/:id/projects` | `{projectId}` (caller must see the project) | `GoalDetail` |
| DELETE | `/goals/:id/projects/:projectId` | | `GoalDetail` |
| GET | `/goals/:id/updates` | newest first | `{data: GoalUpdate[]}` |
| POST | `/goals/:id/updates` | `{status, body?}` — also sets the goal's `status`, snapshots `progress` | `201 GoalUpdate` |
| GET | `/goals/time-periods` | distinct periods in use + current quarter/half/year | `{data: string[]}` |

Seed: add a 3-level cascade for the current year/quarter (1 company goal with SUB_GOALS → 2 team goals
→ 2–3 individual goals with KRs; one goal on PROJECTS linked to a seeded project), with a few updates.

## 11. Reporting (v1.1)

Dashboards computed on the fly from tasks. **Time zone**: all date bucketing uses BE env
`APP_TIMEZONE` (IANA, default `Asia/Jakarta`); weeks start **Monday**; "today" is in that zone.
"Overdue" = incomplete and `dueDate < today`. Reports count **all tasks incl. subtasks** unless
stated. Only projects/tasks the caller can see are included (same rules as §4).

### Shapes
```ts
type Counts = { total: number; completed: number; incomplete: number; overdue: number };
type ProjectReport = {
  project: { id: string; name: string; color: string };
  totals: Counts & { unassigned: number; percentComplete: number };
  bySection: { sectionId: string|null; name: string; total: number; completed: number; overdue: number }[]; // section order, "No section" last
  byAssignee: { assignee: UserSummary|null; incomplete: number; completed: number; overdue: number }[];   // by incomplete desc
  byPriority: { priority: 'NONE'|'LOW'|'MEDIUM'|'HIGH'; total: number; incomplete: number }[];
  trend: { weekStart: string; created: number; completed: number; open: number }[]; // oldest→newest, `open` = incomplete at week end
  upcoming: Task[];   // incomplete, due today..+14d, by dueDate, max 20
};
type OverviewReport = {
  totals: Counts & { projects: number };
  projects: (Counts & { project: Project; percentComplete: number; lastActivityAt: string|null })[]; // by name
};
type WorkloadReport = {
  from: string; to: string;   // YYYY-MM-DD, inclusive
  data: { user: UserSummary; open: number; overdue: number; dueInRange: number; completedInRange: number }[]; // by open desc
};
```

### Clarifications (agreed)
- Subtasks count under their **parent's section** (in `bySection` and the CSV `section` column).
- Workload follows §4 visibility strictly: a task (incl. personal tasks and private-project tasks)
  counts only if the **caller** can see it. Admins therefore see the full picture.
- `dueInRange` = **incomplete** tasks with `dueDate` in `[from, to]` ("still to do this period").
- `byPriority` always lists all four, ordered `HIGH, MEDIUM, LOW, NONE`.
- `lastActivityAt` = latest Activity or Comment on any of the project's tasks (`null` if none).
- CSV: UTF-8 **with BOM** (Excel), CRLF line endings, rows = top-level tasks in list order each
  followed by its subtasks; formula-injection prefix `'` for cells starting with `= + - @ TAB CR`.

### Endpoints
| Method | Path | Query | Returns |
|---|---|---|---|
| GET | `/projects/:id/report` | `?weeks=12` (1–52) | `ProjectReport` |
| GET | `/reports/overview` | `?teamId=` (omit = all visible, non-archived projects) | `OverviewReport` |
| GET | `/reports/workload` | `?teamId=&from=&to=` (default: this Monday..Sunday; max 92 days). `teamId` limits users to team members and tasks to the team's projects. Personal tasks count for their assignee only when no `teamId`. | `WorkloadReport` |
| GET | `/projects/:id/tasks.csv` | | `text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="<project-slug>-tasks.csv"`. Columns: `id,title,section,parent_task_id,assignee_name,assignee_email,priority,start_date,due_date,completed,completed_at,created_at` (RFC 4180 quoting; prefix cells starting with `= + - @` with `'` to prevent CSV formula injection) |

### FE (v1.1)
- Sidebar: **Goals** and **Reporting** entries.
- **Goals page** `/goals`: time-period picker (default current quarter), filter (All / Company / My
  team / Mine), collapsible **tree** by `parentId` with progress bars + status pill + owner avatar;
  "New goal" dialog (pick parent to align = cascade). Goal detail at `/goals/:id` (side panel or
  page): KRs with inline current-value update, sub-goals, linked projects, progress-source switcher,
  status update composer + history.
- **Project Dashboard** tab next to List/Board/Calendar (`/projects/:id/dashboard`): KPI tiles,
  tasks by section/assignee/priority bar charts, created-vs-completed trend, upcoming list, "Export CSV".
- **Reporting page** `/reporting`: Overview (project table with % complete, overdue; team filter),
  Workload (people × open/overdue/due-in-range, date range), Goals summary (count by status, average
  progress for a period — computed from `GET /goals`).
- Charts: Recharts (or similar, ≤ ~120 KB gz). Accessible: every chart has a text/table alternative.

## 12. Workspaces (v1.2)

Modelled on Asana's *workspaces & organizations*: a **workspace** is a shared space with its own
members, teams, projects, tasks, goals and inbox. A user can belong to several and switches between
them. An **organization** is a workspace tied to a company email domain: people with that domain can
join it themselves, and anyone outside the domain can only be a **guest**. Everything in §4–§11 now
applies *within one workspace*; "ADMIN" there means **admin of that workspace**.

Deliberate deviation from Asana: teams exist in every workspace (not only organizations), so all
v1 features keep working everywhere.

### Data model
```
Workspace        id, name, isOrganization(bool, default false), domain?(unique, lowercase, e.g. "mekari.com"),
                 color, createdAt
WorkspaceMember  workspaceId, userId (PK both), role(ADMIN|MEMBER|GUEST), isActive(default true), joinedAt
User             + lastWorkspaceId?            − role   (role moves to WorkspaceMember)
Invite           + workspaceId; role may be GUEST; unique pending (workspaceId, email)
Team, Project, Task, Goal, Notification   + workspaceId (required, indexed)
```
- `Task.workspaceId` is set for every task (incl. personal tasks); a task in a project always has
  the project's workspace. `Project.workspaceId` = its team's workspace.
- `domain` is required when `isOrganization = true`, and must be null otherwise.
- **Migration (must be non-destructive — the preview DB holds real data):** create one workspace
  (`DEFAULT_WORKSPACE_NAME`, default `"Mekari"`, not an organization), backfill every row's
  `workspaceId` with it, copy each user's old `role` into a `WorkspaceMember` (inactive users →
  `isActive=false`), set `lastWorkspaceId`, then drop `User.role`.
- `User.isActive = false` still blocks login globally (only settable by `npm run create-admin` /
  DB); workspace admins manage `WorkspaceMember.isActive` instead.

### Current workspace
- Workspace-scoped requests use the header **`X-Workspace-Id`**. If it's absent, the server uses
  `User.lastWorkspaceId`, then the user's oldest active membership. A header naming a workspace the
  caller isn't an active member of → `404`.
- No workspace at all (new user who left everything) → scoped endpoints return
  `403 FORBIDDEN` with `details: [{ path: ["workspace"], message: "NO_WORKSPACE" }]`.
- **Scoped** (lists, creates, search, reports): `/users`, `/admin/*`, `GET/POST /teams`,
  `GET/POST /projects`, `/me/tasks`, `POST /tasks` (personal tasks), `/notifications*`, `/search`,
  `GET/POST /goals`, `/goals/time-periods`, `/reports/*`.
- **ID-addressed** endpoints (`/tasks/:id`, `/projects/:id…`, `/sections/:id`, `/comments/:id`,
  `/teams/:id…`, `/goals/:id…`, `/key-results/:id`, `/notifications/:id/read`) ignore the header.
  They resolve the resource's own workspace and require active membership there (else `404`), so
  links always work. `Team`, `Project`, `Task`, `Goal` and `Notification` responses gain
  `workspaceId` so the FE can switch to the right workspace.
- **No cross-workspace references.** Assignee, follower, project or team member, goal owner, KR
  owner, mentions → must be an active member of that workspace (`400 VALIDATION` on the field).
  Moving a task to a project in another workspace, or a goal parent in another workspace →
  `400 VALIDATION`. Linking a goal to a project in another workspace → `404`.

### Roles
| | ADMIN | MEMBER | GUEST |
|---|---|---|---|
| See projects | per §4 (admin: all) | per §4 | **only projects where they're a `ProjectMember`** (privacy ignored) |
| See tasks | per §4 | per §4 | tasks in those projects + personal tasks they created / are assigned / follow |
| Create projects / teams | yes | yes | `403` |
| Join or be added to teams | yes | yes | `400 VALIDATION` |
| Goals (§10) | see all, create company goals | see all | can't see or create any (`GET /goals` → empty list, `GET /goals/:id` → `404`, `POST` → `403`) |
| `/users`, `@mention` picker | all active members | all active members | only people who share a project with them |
| Reports | per §11 | per §11 | project report on visible projects only; `/reports/workload` → `403` |
| Workspace settings & `/admin/*` | yes | `403` | `403` |

- **Organizations:** inviting an email outside `domain` as `ADMIN`/`MEMBER` → `400 VALIDATION`
  (`role`, "External people can only be guests"). A user whose email matches `domain` can **join**
  it as `MEMBER` without an invite.
- **Converting to an organization** (`PATCH {isOrganization:true, domain}`): the caller's email
  must be on `domain` (`400`); a domain already used by another workspace → `409`. Every active
  member whose email is off-domain becomes `GUEST`. The response reports how many changed.
  Turning it back off (`isOrganization:false`) clears `domain` and leaves roles as they are.
- The last active ADMIN can't leave, be demoted or be deactivated → `409 CONFLICT`.
- **Deactivating a member** (`isActive=false`) removes them from the workspace's teams and
  project memberships (a project's last OWNER passes to the acting admin) and hides them from
  pickers. Their tasks keep the assignee. Re-inviting or re-activating restores access (not
  their old team or project memberships).

### Shapes
```ts
type WorkspaceRole = 'ADMIN'|'MEMBER'|'GUEST';
type Workspace = {
  id: string; name: string; isOrganization: boolean; domain: string|null; color: string;
  myRole: WorkspaceRole; memberCount: number;   // active members incl. guests
  createdAt: string;
};
// User.role is now the role in the *current* workspace; for /admin/users, isActive = membership.
type User = UserSummary & { role: WorkspaceRole; isActive: boolean; createdAt: string };
type Me = User & { currentWorkspace: Workspace|null; workspaces: Workspace[] };   // workspaces by name
type PendingInvite = { id: string; workspace: { id: string; name: string; color: string };
  role: WorkspaceRole; invitedBy: UserSummary; expiresAt: string };
```

### Endpoints
| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | `/auth/me` (and `POST /auth/login`, `/auth/accept-invite`) | | `Me` |
| GET | `/auth/invites/:token` | (no auth) | `{id, email, role, workspace:{id,name,color}, existingUser: boolean}` or 404/410 |
| POST | `/auth/accept-invite` | `{token, name, password}`, **new users only** (`409` if the email already has an account → FE asks them to log in) | `Me`, sets cookie, current = invited workspace |
| GET | `/workspaces` | my active memberships | `{data: Workspace[]}` |
| POST | `/workspaces` | `{name, color?}`. Any user; caller becomes ADMIN and it becomes current | `201 Workspace` |
| GET | `/workspaces/:id` | member | `Workspace` |
| PATCH | `/workspaces/:id` | `{name?, color?, isOrganization?, domain?}` ADMIN | `Workspace & { convertedToGuests?: number }` |
| DELETE | `/workspaces/:id` | `{confirmName}` must equal its name (`400`). ADMIN. Deletes everything in it | `204` |
| POST | `/workspaces/:id/switch` | active member; sets `lastWorkspaceId` | `Workspace` |
| POST | `/workspaces/:id/leave` | last active admin → `409`; same clean-up as deactivation | `204` |
| GET | `/workspaces/joinable` | organizations whose `domain` matches my email and where I'm not an active member | `{data: {id,name,color,memberCount}[]}` |
| POST | `/workspaces/:id/join` | domain must match (else `403`) | `201 Workspace` |
| GET | `/me/invites` | pending, unexpired invites to my email | `{data: PendingInvite[]}` |
| POST | `/me/invites/:id/accept` | email must match (else `404`); marks it accepted, adds or reactivates membership with the invite's role | `Workspace` |
| DELETE | `/me/invites/:id` | decline | `204` |
| POST | `/admin/invites` | `{email, role}` role ∈ ADMIN/MEMBER/GUEST; already an active member → `409` | as before + `workspaceId` |
| GET/PATCH | `/admin/users`, `/admin/users/:id` | members of the current workspace incl. inactive; `PATCH {role?, isActive?}` edits the membership | `User` |

`npm run create-admin` creates (or reuses) the user and makes them ADMIN of the default workspace,
creating that workspace if none exists. `npm run seed` builds the default workspace
"Mekari" (organization, domain `example.com`) with all the existing data, plus a second
workspace **"Acme Pilot"**: alice ADMIN, bob MEMBER, guest `guest@partner.test` (password123)
on one project, one team, one project with ~8 tasks. `npm run seed -- --workspaces-demo` adds just
"Acme Pilot" idempotently, without touching existing data (for the preview DB).

### FE (v1.2)
- **Workspace switcher (Slack-style).** The workspace name and tile sit at the top of the sidebar,
  and clicking them opens a menu:
  - workspaces with a ✓ on the current one
  - pending invites (Accept / Decline)
  - "Join *Org* (n members)" entries from `/workspaces/joinable`
  - "Create workspace"
  - "Workspace settings" (admins)

  Also in the profile menu, as in Asana. With ≥ 2 workspaces, a narrow **workspace rail**
  (coloured initial tiles, unread dot) appears left of the sidebar; `Ctrl/⌘ + 1…9` switches.
- **Switching.** The FE sends `X-Workspace-Id` on every request, from per-tab state seeded from
  localStorage `mekari-project:workspace`, and calls `POST /workspaces/:id/switch`. It resets the
  TanStack Query cache, navigates to Home / My Tasks and shows a toast ("Switched to Acme Pilot").
  The content cross-fades; with reduced motion it's a plain fade.
- **Deep links.** If a loaded task, project or goal has another `workspaceId` the user belongs to,
  switch automatically with a toast ("Switched to X to open this task").
- **Onboarding.** When `currentWorkspace` is null, show a friendly screen: accept an invite, join
  a matching organization, or create a workspace.
- **Invite page.** For an existing account, "Log in to join *X*" → after login,
  `POST /me/invites/:id/accept`.
- **Workspace settings** `/workspace/settings` (replaces the Admin page; ADMIN only):
  - *General*: name, colour
  - *Organization*: domain, and convert with a confirm dialog showing who becomes a guest
  - *Members*: role select incl. Guest, deactivate, a Guest badge
  - *Invites*: role incl. Guest; external emails in an org are forced to Guest in the UI
  - *Danger zone*: delete, by typing the name
  - plus "Leave workspace" for everyone
- **Guest experience.** A "Guest" pill next to the workspace name. Hide Teams browse, Goals,
  Workload and "New project", and show a small "You're a guest in X" note in the sidebar.

### Clarifications (agreed, W1–W8)
- **W1** Guests: `GET /teams` → `{data: []}`; `/teams/:id…` → `404` (guests are never team members).
- **W2** Guests can't own goals or key results: `ownerId` naming a GUEST → `400 VALIDATION` on `ownerId`.
- **W3** A member an admin deactivated can't rejoin through the domain: `POST /workspaces/:id/join` →
  `403`, and the organization isn't listed in `/workspaces/joinable`. Only a re-invite or re-activation
  restores access.
- **W4** Becoming a GUEST (role change or organization conversion) removes the person's team
  memberships in that workspace; project memberships stay.
- **W5** Converting to an organization (or changing its domain) also demotes *inactive* off-domain
  memberships and turns pending off-domain invites into GUEST invites, so a later re-activation or
  invite accept can't bring an external MEMBER back. `convertedToGuests` counts active members only.
- **W6** Accepting an invite to a workspace you're already an active member of keeps your role
  unchanged; the invite is still marked accepted, so it leaves `/me/invites`.
- **W7** Guests never manage projects: `canManage` is false for a GUEST even with an OWNER membership,
  and making a GUEST a project OWNER (`POST`/`PATCH /projects/:id/members`) → `400 VALIDATION` on
  `role`. When someone becomes a GUEST (role change or organization conversion), their OWNER project
  memberships become EDITOR; a project left without an OWNER passes to the acting admin (to the
  longest-standing other admin if the admin demoted themselves), as with deactivation. Guests also
  only find people who share a project with them by id (`GET /users/:id` → `404` otherwise).
- **W8** `GET /users` entries include `role` (`UserSummary & { role: WorkspaceRole }`), the person's
  role in the current workspace, for every caller incl. guests (who only see co-members). Guests are
  badged in pickers, and the FE doesn't offer them Owner (W7) or goal ownership (W2).

## 13. Attachments & links (v1.3)

Modelled on Asana: any file type up to **100 MB** can be attached to a **task** or to a **comment**,
and so can a **link** (URL) with a rich preview card. Comment attachments also appear in the task's
attachment list, as in Asana. Clients preview what they can and offer "Open in browser", "Open
with another app" (native apps) and "Download".

### Data model
```
enum AttachmentKind { FILE LINK }

Attachment  id, workspaceId, taskId (cascade), commentId? (cascade), uploaderId (restrict), kind,
            draft(bool, default false), createdAt,
            -- FILE
            name (display filename), mimeType (server-sniffed), size (bytes), storageKey (opaque,
            never returned), sha256, width?, height? (images), hasThumbnail(bool),
            -- LINK
            url, title?, description?, siteName?, provider?, previewStatus(PENDING|READY|FAILED),
            iconKey?, imageKey? (server-cached favicon / og:image, stored like files)
            @@index([taskId, createdAt]) @@index([commentId]) @@index([draft, createdAt])
```
- New `ActivityType` values: `ATTACHMENT_ADDED` (`{attachmentId, kind, name}`; `name` is the
  filename or link title/URL) and `ATTACHMENT_REMOVED` (`{kind, name}`). Only for **task-level**
  attachments; comment attachments appear inside their comment, not as separate activity.
- `Task` gains `attachmentCount` (non-draft, task + comment). `TaskDetail` gains
  `attachments: Attachment[]` (non-draft, task-level **and** comment ones, newest first).
  The comment `Story` gains `attachments: Attachment[]` (oldest first).

### Storage
- `StorageDriver` interface: `put(key, stream) → {size, sha256}`, `get(key, range?) → stream`,
  `delete(key)`, `stat(key)`. **`STORAGE_DRIVER=disk`** (default) writes under
  **`STORAGE_DIR`** (default `./data/attachments` in dev, `/data/attachments` in docker, a named
  volume **`attachments`**, backed up alongside `pgdata`). An `s3` driver (S3/R2/MinIO, env
  `S3_*`) is a later drop-in, no API change.
- Keys are random (`ab/cd/<uuid>`), never derived from the filename. Writes go to a temp file then
  rename, so a half-upload is never visible. Files are deleted **after** the DB commit that removes
  their row(s) (task/comment/attachment delete, cascades included); a **sweeper** (hourly, in-process)
  deletes drafts older than 24 h, and storage objects with no row older than 24 h.

### Uploads
- `POST /tasks/:id/attachments` — `multipart/form-data`, **one** part `file` (+ optional field
  `draft=true`). Streams to storage; over **100 MB** → abort, `413` with new error code
  **`PAYLOAD_TOO_LARGE`** (clients treat unknown codes generically). `201` → `Attachment`.
  - `draft=true` is for the comment composer: invisible to everyone but the uploader, not in
    `attachmentCount`, no activity. It becomes part of a comment when that comment is posted with its
    id, else the sweeper removes it.
  - Without `draft`: a task-level attachment, `ATTACHMENT_ADDED` activity, `updatedAt` bumped.
- `POST /tasks/:id/attachments/link` — `{url, title?, draft?}`. `url`: absolute `http`/`https`,
  ≤ 2048 chars, no credentials (`user:pass@`) → else `400 VALIDATION` on `url`. The preview is fetched
  **synchronously with a 6 s budget**; on timeout/failure the link is still created with
  `previewStatus: FAILED` (the card falls back to domain + provider icon). `201` → `Attachment`.
- `POST /attachments/:id/refresh-preview` → re-fetches a LINK preview → `Attachment`.
- `POST /tasks/:id/comments` gains `attachmentIds?: string[]` (≤ **20**). Each must be a draft
  **uploaded by the caller on this task** (else `400 VALIDATION` on `attachmentIds`); they become
  non-draft with this `commentId`. A comment may have an empty `body` **if** it has attachments.
  `PATCH /comments/:id` can't change attachments in v1.3 (delete the attachment instead).
- **Filename sanitising** (server, on upload): basename only; strip control chars and Unicode
  bidi/format controls (U+202A–202E, U+2066–2069, U+200E/F, U+061C); collapse whitespace; ≤ 255
  bytes UTF-8 keeping the extension; empty → `file`. Clients show `name` as given.
- **Type detection:** `mimeType` is **sniffed from magic bytes** (`file-type`), falling back to the
  extension only for text-like types (`txt md csv json log`, served as `text/plain`), else
  `application/octet-stream`. The client-sent type is ignored.
- Images (`png jpeg gif webp heic avif bmp tiff`; **not SVG**) get `width`/`height` and server
  thumbnails via `sharp`. HEIC/AVIF that sharp can't decode → no thumbnail, still a valid file.

### Serving (security-critical: files are user content on the app's own origin)
- `GET /attachments/:id` → `Attachment`.
- `GET /attachments/:id/content` → the bytes. **Range requests** (`206`, `Accept-Ranges: bytes`)
  so video/audio seek. Headers always: `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self'; media-src 'self'`,
  `Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: private, max-age=0, must-revalidate`,
  strong `ETag` (= sha256). `Content-Disposition`:
  - `inline` **only** for the allowlist: `image/png|jpeg|gif|webp|avif|bmp`, `application/pdf`,
    `video/mp4|webm|quicktime`, `audio/mpeg|mp4|wav|ogg|webm`, `text/plain` (charset utf-8);
  - `attachment` for everything else (HTML, SVG, XML, JS, Office, archives, executables…) and when
    `?download=1`. Filename via RFC 6266/5987 (`filename="<ascii fallback>"; filename*=UTF-8''…`).
- `GET /attachments/:id/thumbnail?size=small|large` (small: fit 240 px, large: fit 1600 px; WebP;
  `404` if none). LINK attachments: `GET /attachments/:id/icon`, `GET /attachments/:id/image`
  (server-cached, so clients never contact third-party hosts).
- **These GET endpoints are ID-addressed and ignore `X-Workspace-Id`** (a web `<img>`/`<video>`
  can't send headers): visible iff the caller can see the task (§4) and is an active member of its
  workspace; drafts only to their uploader; else `404`.
- `DELETE /attachments/:id` → `204`. Allowed: the uploader, the project `OWNER`, or a workspace
  `ADMIN` (personal tasks: uploader or the task creator). Task-level → `ATTACHMENT_REMOVED` activity.

### Permissions
- See: can see the task. Add **task-level**: can edit the task (`COMMENTER` → `403`).
  Add **comment** attachments (drafts / `attachmentIds`): can comment, so `COMMENTER`s can.
  Guests follow the same rules on the projects they can see.
- Rate limit uploads: 60 / 10 min per user (`429 RATE_LIMITED`).

### Link previews (SSRF-safe fetcher)
- Only `http`/`https`, ports 80/443. Resolve DNS **once** and connect to that pinned IP; reject
  loopback, private (RFC 1918), link-local (incl. 169.254.169.254), CGNAT 100.64/10, `0.0.0.0/8`,
  multicast, broadcast, IPv6 `::1`, `fc00::/7`, `fe80::/10`, IPv4-mapped forms of all of these.
  Max **3 redirects**, each re-validated. Total budget 6 s; HTML read capped at **1 MB**
  (only `text/html`/`application/xhtml+xml`); no cookies or auth sent; UA `MekariProjectBot/1.0`.
  Env **`LINK_PREVIEW_ENABLED`** (default true) turns fetching off (→ `FAILED`, cards still work);
  **`LINK_PREVIEW_ALLOW_PRIVATE`** (default false) only for tests.
- Parse `og:title|description|site_name|image`, `twitter:*`, `<title>`, `<link rel=icon>`, falling
  back to `/favicon.ico`. Strip tags/controls; title ≤ 300, description ≤ 1000 chars. `og:image`
  and icon fetched under the same rules (≤ 5 MB, raster image types only, re-encoded by sharp to
  WebP ≤ 1200 px / 64 px), stored as `imageKey`/`iconKey`.
- `provider` (from the final hostname; clients bundle the icons; open string — unknown = generic):
  `google_drive`, `google_docs`, `google_sheets`, `google_slides`, `dropbox`, `onedrive`
  (incl. SharePoint), `box`, `figma`, `youtube`, `loom`, `github`, `gitlab`, `notion`, `miro`,
  `jira`, `confluence`, `slack`, `zoom`. User-entered `title` wins over the fetched one.

### Shape
```ts
type Attachment = {
  id: string; workspaceId: string; taskId: string; commentId: string|null;
  kind: 'FILE'|'LINK';            // open enum on clients
  draft: boolean; uploader: UserSummary; createdAt: string;
  // FILE (null for LINK)
  name: string|null; mimeType: string|null; size: number|null;
  width: number|null; height: number|null; hasThumbnail: boolean;
  // LINK (null for FILE)
  url: string|null; title: string|null; description: string|null; siteName: string|null;
  provider: string|null; previewStatus: 'PENDING'|'READY'|'FAILED'|null;
  hasIcon: boolean; hasImage: boolean;
  // Relative paths (prefix with server origin); clients never build them by hand.
  contentPath: string|null;  // /api/v1/attachments/:id/content (FILE)
  thumbnailPath: string|null; // …/thumbnail (FILE with hasThumbnail); append ?size=
};
```

### Deployment
- Fastify multipart (`@fastify/multipart`, streamed, per-route limit 100 MB + overhead); global
  `bodyLimit` unchanged for JSON. nginx: `client_max_body_size 105m` and
  `proxy_request_buffering off` on `/api/`; `proxy_read_timeout 300s`. compose: `attachments`
  volume mounted at `/data/attachments`, `STORAGE_DIR` set. Note: Cloudflare (incl. the quick
  tunnel used for the preview) caps request bodies at 100 MB, so files right at the limit can fail
  there; not a concern for direct/LAN deployments.
- Seed (`--workspaces-demo` and the default seed): one PNG, one PDF, one text file and one LINK with
  preset `READY` metadata (no network) on a demo task, plus one comment with an image.

### Clients (all three)
- **Task detail:** an *Attachments* section (grid of thumbnails/cards, newest first; count in the
  header) with **Attach file** and **Add link**. Files: image thumbnail, else a type icon by
  `mimeType`/extension, name, size. Links: card with image, icon (provider icon if known), title,
  site/domain, description (2 lines).
- **Comments:** composer gets attach (files + link) with chips showing upload progress, cancel and
  remove; Send is disabled while uploads are running; posts `attachmentIds`. Comment stories render
  their attachments under the body.
- **Preview:** images (zoomable, arrow through the task's images), PDF, video/audio, plain text are
  previewed in-app; everything else shows the type icon + actions. Actions everywhere: **Open in
  browser** (web: `contentPath` in a new tab; native: the task's web URL with `?workspace=`), **Open
  with another app** (native), **Download / Save as…**, **Copy link** (LINK: the URL), **Delete**
  (when allowed). Links open in the browser by default.
- **Add** via picker, drag-and-drop onto task detail or composer, and paste of image/file from the
  clipboard (web + Mac). Client-side check of 100 MB before upload; show `413` message if it slips
  through. Uploads show progress, can be cancelled, failures offer Retry.
- Never render file content as HTML; never put `url` in an `<a>`/open call unless it is
  `http`/`https`.

### Clarifications (agreed, A1–A10)
- **A1** 100 MB = **104,857,600 bytes** (`MAX_UPLOAD_BYTES`, default that). Clients pre-check the same number.
- **A2** `StorageDriver` also has `list() → {key, mtime}` for the orphan sweep. Thumbnails use derived keys (`<key>.s.webp`, `<key>.l.webp`).
- **A3** Draft uploads are marked with the **query parameter `?draft=true`** (`POST /tasks/:id/attachments?draft=true`), so permission is decided before the body streams. A multipart `draft` field is also accepted.
- **A4** Formats sharp can't decode (BMP, HEIC…) → valid file, no thumbnail, `width`/`height` null.
- **A5** The upload rate limit (60 / 10 min per user) counts file and link creations together.
- **A6** `DELETE /attachments/:id` and `POST /attachments/:id/refresh-preview` are ID-addressed (ignore `X-Workspace-Id`); a non-member → `404`.
- **A7** Personal tasks: delete by the uploader, the task creator, or a workspace `ADMIN`.
- **A8** Removing a task-level attachment also bumps the task's `updatedAt`.
- **A9** `PATCH /comments/:id` may leave `body` empty when the comment has attachments.
- **A10** Seeded LINKs use preset `READY` metadata, with no network access.
