# Asana Clone — Product & API Spec (v1)

Internal project-management tool for a ~100-employee company. One workspace (the company).
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

### v1.1 (in progress): see §10 Goals/OKRs and §11 Reporting

### Later (do NOT build yet)
Attachments, tags, custom fields, real-time (WebSocket), Google SSO, email notifications,
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
- Errors: `{ "error": { "code": "NOT_FOUND" | "VALIDATION" | "UNAUTHORIZED" | "FORBIDDEN" | "CONFLICT" | "GONE" | "RATE_LIMITED" | "INTERNAL", "message": string, "details"?: any } }`
  with matching HTTP status (404/400/401/403/409/410/429/500). `GONE` = used or expired invite; `RATE_LIMITED` = too many login / accept-invite attempts.
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
| GET | `/users` | `?q=` (name/email contains, active only) | `{data: UserSummary[]}` |
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
