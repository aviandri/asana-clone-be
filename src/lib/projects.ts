import type { Prisma, PrismaClient, Section } from '@prisma/client';
import { notFound } from '../errors.js';
import { toUserSummary, userSummarySelect } from './serialize.js';

export const DEFAULT_SECTIONS = ['To do', 'In progress', 'Done'];
export const POSITION_STEP = 1000;

/** Prisma include for the `Project` shape; `members` is narrowed to the caller to derive `myRole`. */
export const projectInclude = (userId: string) =>
  ({
    owner: { select: userSummarySelect },
    members: { where: { userId }, select: { role: true } },
  }) satisfies Prisma.ProjectInclude;

type ProjectRow = Prisma.ProjectGetPayload<{ include: ReturnType<typeof projectInclude> }>;

export function toProject(p: ProjectRow) {
  return {
    id: p.id,
    teamId: p.teamId,
    name: p.name,
    description: p.description,
    color: p.color,
    privacy: p.privacy,
    archived: p.archived,
    defaultView: p.defaultView,
    owner: toUserSummary(p.owner),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    myRole: p.members[0]?.role ?? null,
  };
}

export function toSection(s: Section) {
  return { id: s.id, projectId: s.projectId, name: s.name, position: s.position };
}

/** Loads the `ProjectDetail` shape. Callers must have checked visibility already. */
export async function loadProjectDetail(db: PrismaClient, projectId: string, userId: string) {
  const p = await db.project.findUnique({
    where: { id: projectId },
    include: {
      owner: { select: userSummarySelect },
      team: { select: { id: true, name: true } },
      sections: { orderBy: [{ position: 'asc' }, { id: 'asc' }] },
      members: {
        include: { user: { select: userSummarySelect } },
        orderBy: { user: { name: 'asc' } },
      },
    },
  });
  if (!p) throw notFound('Project');
  return {
    ...toProject({ ...p, members: p.members.filter((m) => m.userId === userId) }),
    sections: p.sections.map(toSection),
    members: p.members.map((m) => ({ user: toUserSummary(m.user), role: m.role })),
    team: p.team,
  };
}
