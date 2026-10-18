import type { FastifyRequest } from 'fastify';
import type { Prisma, PrismaClient, User, Workspace, WorkspaceRole } from '@prisma/client';
import { AppError, conflict, forbidden, notFound, validation } from '../errors.js';
import { toUser } from './serialize.js';
import { uuid } from './validate.js';

type Db = PrismaClient | Prisma.TransactionClient;

/** The caller (or any user) acting inside one workspace (SPEC §12). */
export type Member = { user: User; workspaceId: string; role: WorkspaceRole };

export const WORKSPACE_HEADER = 'x-workspace-id';

export const noWorkspace = () =>
  new AppError('FORBIDDEN', 'You are not a member of any workspace', [{ path: ['workspace'], message: 'NO_WORKSPACE' }]);

/** Users who are active members of a workspace (and not deactivated globally). */
export const activeMemberWhere = (workspaceId: string): Prisma.UserWhereInput => ({
  isActive: true,
  workspaceMemberships: { some: { workspaceId, isActive: true } },
});

/** Guests can't create teams or projects, see goals or use workload (SPEC §12 roles). */
export function requireNotGuest(member: Member, message = 'Guests can’t do that') {
  if (member.role === 'GUEST') throw forbidden(message);
}

/** The lowercase domain of an email address. */
export const emailDomain = (email: string) => email.slice(email.lastIndexOf('@') + 1).toLowerCase();

/** In an organization, people off its domain can only be guests (400 on `role`). */
export function assertRoleAllowed(workspace: Pick<Workspace, 'isOrganization' | 'domain'>, email: string, role: WorkspaceRole) {
  if (role !== 'GUEST' && workspace.isOrganization && workspace.domain && emailDomain(email) !== workspace.domain) {
    throw validation('External people can only be guests', [{ path: ['role'], message: 'External people can only be guests' }]);
  }
}

/**
 * People the member may see in pickers and `/users`: every active member, except that a GUEST
 * only sees people who share a project with them (SPEC §12).
 */
export function pickableUsersWhere(m: Member): Prisma.UserWhereInput {
  const base = activeMemberWhere(m.workspaceId);
  if (m.role !== 'GUEST') return base;
  return {
    AND: [
      base,
      {
        OR: [
          { id: m.user.id },
          {
            projectMemberships: {
              some: { project: { workspaceId: m.workspaceId, members: { some: { userId: m.user.id } } } },
            },
          },
        ],
      },
    ],
  };
}

/** The user's active membership in a workspace, or null. */
export async function findMember(db: Db, user: User, workspaceId: string): Promise<Member | null> {
  if (!user.isActive) return null;
  const m = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: user.id } },
    select: { role: true, isActive: true },
  });
  return m?.isActive ? { user, workspaceId, role: m.role } : null;
}

/**
 * For ID-addressed endpoints: the caller must be an active member of the resource's own workspace.
 * Otherwise the resource is reported as not found, so its existence doesn't leak.
 */
export async function requireMember(db: Db, user: User, workspaceId: string, what = 'Resource'): Promise<Member> {
  const member = await findMember(db, user, workspaceId);
  if (!member) throw notFound(what);
  return member;
}

/** Active memberships, oldest first (the fallback order for the current workspace). */
function activeMemberships(db: Db, userId: string) {
  return db.workspaceMember.findMany({
    where: { userId, isActive: true },
    include: { workspace: true },
    orderBy: [{ joinedAt: 'asc' }, { workspaceId: 'asc' }],
  });
}

function headerValue(req: FastifyRequest): string | undefined {
  const raw = req.headers[WORKSPACE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() || undefined;
}

/**
 * The current workspace: the `X-Workspace-Id` header, else `User.lastWorkspaceId`, else the oldest
 * active membership. With `strict`, a header naming a workspace the caller isn't an active member
 * of is a 404; otherwise it is ignored (used by `/auth/me`, so a stale header can't lock the FE out).
 */
async function resolveCurrent(db: Db, user: User, header: string | undefined, strict: boolean) {
  const memberships = user.isActive ? await activeMemberships(db, user.id) : [];
  if (header) {
    const hit = uuid.safeParse(header).success ? memberships.find((m) => m.workspaceId === header) : undefined;
    if (hit) return { memberships, current: hit };
    if (strict) throw notFound('Workspace');
  }
  const current = memberships.find((m) => m.workspaceId === user.lastWorkspaceId) ?? memberships[0] ?? null;
  return { memberships, current };
}

const memberCache = new WeakMap<FastifyRequest, Promise<Member>>();

/** The caller's membership in the current workspace, for scoped endpoints. 403 NO_WORKSPACE if none. */
export function currentMember(req: FastifyRequest): Promise<Member> {
  let pending = memberCache.get(req);
  if (!pending) {
    pending = resolveCurrent(req.server.db, req.user, headerValue(req), true).then(({ current }) => {
      if (!current) throw noWorkspace();
      return { user: req.user, workspaceId: current.workspaceId, role: current.role };
    });
    memberCache.set(req, pending);
  }
  return pending;
}

// --- shapes ----------------------------------------------------------------------------

/** Active members (incl. guests) per workspace. */
async function memberCounts(db: Db, workspaceIds: string[]) {
  if (workspaceIds.length === 0) return new Map<string, number>();
  const groups = await db.workspaceMember.groupBy({
    by: ['workspaceId'],
    where: { workspaceId: { in: workspaceIds }, isActive: true, user: { isActive: true } },
    _count: { _all: true },
  });
  return new Map(groups.map((g) => [g.workspaceId, g._count._all]));
}

export function toWorkspace(w: Workspace, myRole: WorkspaceRole, memberCount: number) {
  return {
    id: w.id,
    name: w.name,
    isOrganization: w.isOrganization,
    domain: w.domain,
    color: w.color,
    myRole,
    memberCount,
    createdAt: w.createdAt.toISOString(),
  };
}

export type WorkspaceShape = ReturnType<typeof toWorkspace>;

/** The `Workspace` shape for one workspace the user is an active member of (404 otherwise). */
export async function loadWorkspace(db: Db, user: User, workspaceId: string) {
  const member = await requireMember(db, user, workspaceId, 'Workspace');
  const [workspace, counts] = await Promise.all([
    db.workspace.findUniqueOrThrow({ where: { id: workspaceId } }),
    memberCounts(db, [workspaceId]),
  ]);
  return toWorkspace(workspace, member.role, counts.get(workspaceId) ?? 0);
}

const byName = (a: { name: string; id: string }, b: { name: string; id: string }) =>
  a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/** My active workspaces, by name. */
export async function listWorkspaces(db: Db, user: User) {
  const memberships = await activeMemberships(db, user.id);
  const counts = await memberCounts(db, memberships.map((m) => m.workspaceId));
  return memberships.map((m) => toWorkspace(m.workspace, m.role, counts.get(m.workspaceId) ?? 0)).sort(byName);
}

/**
 * The `Me` shape: the user with their role in the current workspace (MEMBER when there is none),
 * the current workspace and all their workspaces by name.
 */
export async function loadMe(db: Db, user: User, opts: { req?: FastifyRequest; workspaceId?: string } = {}) {
  const header = opts.workspaceId ?? (opts.req ? headerValue(opts.req) : undefined);
  const { memberships, current } = await resolveCurrent(db, user, header, false);
  const counts = await memberCounts(db, memberships.map((m) => m.workspaceId));
  const workspaces = memberships.map((m) => toWorkspace(m.workspace, m.role, counts.get(m.workspaceId) ?? 0)).sort(byName);
  return {
    ...toUser(user, { role: current?.role ?? 'MEMBER', isActive: user.isActive }),
    currentWorkspace: workspaces.find((w) => w.id === current?.workspaceId) ?? null,
    workspaces,
  };
}

// --- membership changes ----------------------------------------------------------------

/** 409 if the user is the workspace's last active ADMIN (they can't leave, be demoted or deactivated). */
export async function assertNotLastAdmin(db: Db, workspaceId: string, userId: string) {
  // Lock the workspace's admin rows, so two admins demoting each other at once can't both pass.
  await db.$queryRaw`SELECT 1 FROM "WorkspaceMember" WHERE "workspaceId" = ${workspaceId}::uuid AND "role" = 'ADMIN' FOR UPDATE`;
  const target = await db.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
  if (!target || target.role !== 'ADMIN' || !target.isActive) return;
  const others = await db.workspaceMember.count({
    where: { workspaceId, role: 'ADMIN', isActive: true, userId: { not: userId }, user: { isActive: true } },
  });
  if (others === 0) throw conflict('A workspace needs at least one active admin');
}

/** The longest-standing active ADMIN other than `exceptUserId`: inherits projects when someone leaves. */
export async function seniorAdminId(db: Db, workspaceId: string, exceptUserId: string) {
  const admin = await db.workspaceMember.findFirst({
    where: { workspaceId, role: 'ADMIN', isActive: true, userId: { not: exceptUserId }, user: { isActive: true } },
    orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }],
    select: { userId: true },
  });
  return admin?.userId ?? null;
}

/**
 * Deactivation / leave clean-up (SPEC §12): removes the user from the workspace's teams and project
 * memberships. Projects left without an OWNER pass to `heirId`. Assigned tasks keep their assignee.
 */
export async function removeFromWorkspaceContent(tx: Prisma.TransactionClient, workspaceId: string, userId: string, heirId: string | null) {
  await tx.teamMember.deleteMany({ where: { userId, team: { workspaceId } } });
  const memberOf = await tx.projectMember.findMany({
    where: { userId, project: { workspaceId } },
    select: { projectId: true },
  });
  await tx.projectMember.deleteMany({ where: { userId, project: { workspaceId } } });
  const ownerOf = await tx.project.findMany({ where: { workspaceId, ownerId: userId }, select: { id: true } });

  // Each project they were in or owned keeps an OWNER member, and Project.owner points at one.
  for (const projectId of new Set([...memberOf.map((m) => m.projectId), ...ownerOf.map((p) => p.id)])) {
    const project = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { ownerId: true } });
    const owners = await tx.projectMember.findMany({
      where: { projectId, role: 'OWNER' },
      orderBy: { user: { name: 'asc' } },
      select: { userId: true },
    });
    if (owners.length > 0) {
      if (!owners.some((o) => o.userId === project.ownerId)) {
        await tx.project.update({ where: { id: projectId }, data: { ownerId: owners[0]!.userId } });
      }
    } else if (heirId) {
      await tx.projectMember.upsert({
        where: { projectId_userId: { projectId, userId: heirId } },
        create: { projectId, userId: heirId, role: 'OWNER' },
        update: { role: 'OWNER' },
      });
      await tx.project.update({ where: { id: projectId }, data: { ownerId: heirId } });
    }
  }
}

/** Deletes a workspace and everything in it. */
export async function deleteWorkspace(tx: Prisma.TransactionClient, workspaceId: string) {
  const where = { workspaceId };
  await tx.notification.deleteMany({ where });
  await tx.goal.deleteMany({ where }); // KRs, links and updates cascade
  await tx.task.deleteMany({ where }); // comments, activity, followers cascade
  await tx.project.deleteMany({ where }); // sections and members cascade
  await tx.team.deleteMany({ where });
  // Invites and memberships cascade; users' lastWorkspaceId is set to null.
  await tx.workspace.delete({ where: { id: workspaceId } });
}
