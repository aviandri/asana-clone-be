import type { Prisma, PrismaClient, ProjectRole, User } from '@prisma/client';
import { forbidden, notFound } from '../errors.js';
import { requireMember, type Member } from './workspaces.js';

/**
 * SPEC §4 within one workspace (§12). ADMIN sees every project in it. MEMBERs see a project if it
 * is PUBLIC, if it is TEAM and they are in its team, or if they are a ProjectMember.
 */
export function visibleProjectsWhere(m: Member): Prisma.ProjectWhereInput {
  if (m.role === 'ADMIN') return { workspaceId: m.workspaceId };
  const userId = m.user.id;
  // GUESTs see only projects they're a member of, whatever the privacy (§12).
  if (m.role === 'GUEST') return { workspaceId: m.workspaceId, members: { some: { userId } } };
  return {
    workspaceId: m.workspaceId,
    OR: [
      { privacy: 'PUBLIC' },
      { privacy: 'TEAM', team: { members: { some: { userId } } } },
      { members: { some: { userId } } },
    ],
  };
}

export type ProjectAccess = {
  projectId: string;
  /** The caller's membership in the project's workspace. */
  member: Member;
  /** The caller's ProjectMember role, or null when access comes from team/public/admin. */
  myRole: ProjectRole | null;
  /** Create/edit tasks and sections: everyone who can see it, except COMMENTERs. */
  canEdit: boolean;
  /** Rename, privacy, archive, delete, members: project OWNER or ADMIN. */
  canManage: boolean;
};

/**
 * Resolves a user's access to a project, in the project's own workspace (ID-addressed, SPEC §12).
 * Projects in workspaces they aren't an active member of, or can't see, are 404 so existence
 * doesn't leak.
 */
export async function projectAccess(db: PrismaClient, user: User, projectId: string): Promise<ProjectAccess> {
  const ref = await db.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } });
  if (!ref) throw notFound('Project');
  const member = await requireMember(db, user, ref.workspaceId, 'Project');
  const project = await db.project.findFirst({
    where: { AND: [{ id: projectId }, visibleProjectsWhere(member)] },
    select: { id: true, members: { where: { userId: user.id }, select: { role: true } } },
  });
  if (!project) throw notFound('Project');
  const myRole = project.members[0]?.role ?? null;
  const isAdmin = member.role === 'ADMIN';
  return {
    projectId: project.id,
    member,
    myRole,
    canEdit: isAdmin || myRole !== 'COMMENTER',
    canManage: isAdmin || myRole === 'OWNER',
  };
}

export function assertCanEdit(access: ProjectAccess) {
  if (!access.canEdit) throw forbidden('Commenters can only add comments in this project');
}

export function assertCanManage(access: ProjectAccess) {
  if (!access.canManage) throw forbidden('Only project owners can change project settings');
}
