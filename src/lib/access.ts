import type { Prisma, PrismaClient, ProjectRole, User } from '@prisma/client';
import { forbidden, notFound } from '../errors.js';

/**
 * SPEC §4. ADMIN sees everything. Others see a project if it is PUBLIC, if it is TEAM and they
 * are in its team, or if they are a ProjectMember.
 */
export function visibleProjectsWhere(user: User): Prisma.ProjectWhereInput {
  if (user.role === 'ADMIN') return {};
  return {
    OR: [
      { privacy: 'PUBLIC' },
      { privacy: 'TEAM', team: { members: { some: { userId: user.id } } } },
      { members: { some: { userId: user.id } } },
    ],
  };
}

export type ProjectAccess = {
  projectId: string;
  /** The caller's ProjectMember role, or null when access comes from team/public/admin. */
  myRole: ProjectRole | null;
  /** Create/edit tasks and sections: everyone who can see it, except COMMENTERs. */
  canEdit: boolean;
  /** Rename, privacy, archive, delete, members: project OWNER or ADMIN. */
  canManage: boolean;
};

/** Resolves the caller's access to a project; invisible projects are 404 so existence doesn't leak. */
export async function projectAccess(db: PrismaClient, user: User, projectId: string): Promise<ProjectAccess> {
  const project = await db.project.findFirst({
    where: { AND: [{ id: projectId }, visibleProjectsWhere(user)] },
    select: { id: true, members: { where: { userId: user.id }, select: { role: true } } },
  });
  if (!project) throw notFound('Project');
  const myRole = project.members[0]?.role ?? null;
  const isAdmin = user.role === 'ADMIN';
  return {
    projectId: project.id,
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
