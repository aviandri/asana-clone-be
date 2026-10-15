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

### v2 (later, do NOT build yet)
Attachments, tags, custom fields, real-time (WebSocket), Google SSO, email notifications,
multi-project tasks, timeline/Gantt, portfolios/goals.

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
- Errors: `{ "error": { "code": "NOT_FOUND" | "VALIDATION" | "UNAUTHORIZED" | "FORBIDDEN" | "CONFLICT" | "INTERNAL", "message": string, "details"?: any } }`
  with matching HTTP status (404/400/401/403/409/500).
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
| GET | `/teams` | `?mine=true` | `{data: Team[]}` |
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
| POST | `/projects` | `{teamId, name, description?, color?, privacy?='TEAM', defaultView?='LIST'}` creates sections "To do","In progress","Done"; creator = OWNER | `ProjectDetail` |
| GET | `/projects/:id` | | `ProjectDetail` |
| PATCH | `/projects/:id` | `{name?, description?, color?, privacy?, archived?, defaultView?}` | `ProjectDetail` |
| DELETE | `/projects/:id` | | `204` |
| POST | `/projects/:id/members` | `{userId, role}` | `ProjectDetail` |
| PATCH | `/projects/:id/members/:userId` | `{role}` | `ProjectDetail` |
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
