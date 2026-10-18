import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { conflict, forbidden, notFound, validation } from '../errors.js';
import { assertCanEdit, assertCanManage, projectAccess, visibleProjectsWhere } from '../lib/access.js';
import {
  DEFAULT_SECTIONS,
  POSITION_STEP,
  loadProjectDetail,
  projectInclude,
  toProject,
  toSection,
} from '../lib/projects.js';
import { hexColor, idParams, parse, queryBool, uuid } from '../lib/validate.js';
import { currentMember, findMember } from '../lib/workspaces.js';

const privacy = z.enum(['PUBLIC', 'TEAM', 'PRIVATE']);
const defaultView = z.enum(['LIST', 'BOARD', 'CALENDAR']);
const projectRole = z.enum(['OWNER', 'EDITOR', 'COMMENTER']);

const ListQuery = z.object({
  teamId: uuid.optional(),
  archived: queryBool.default('false'),
  q: z.string().trim().max(100).optional(),
});
const CreateBody = z.object({
  teamId: uuid,
  name: z.string().trim().min(1).max(200),
  description: z.string().max(10_000).nullish(),
  color: hexColor.default('#4186e0'),
  privacy: privacy.default('TEAM'),
  defaultView: defaultView.default('LIST'),
});
const UpdateBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(10_000).nullable(),
    color: hexColor,
    privacy,
    archived: z.boolean(),
    defaultView,
  })
  .partial()
  .strict();
const AddMemberBody = z.object({ userId: uuid, role: projectRole.default('EDITOR') });
const UpdateMemberBody = z.object({ role: projectRole });
const MemberParams = z.object({ id: uuid, userId: uuid });
const CreateSectionBody = z.object({ name: z.string().trim().min(1).max(200), position: z.number().finite().optional() });

export default async function projectRoutes(app: FastifyInstance) {
  app.get('/projects', async (req) => {
    const query = parse(ListQuery, req.query);
    const member = await currentMember(req);
    const projects = await app.db.project.findMany({
      where: {
        AND: [
          visibleProjectsWhere(member),
          { archived: query.archived },
          query.teamId ? { teamId: query.teamId } : {},
          query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {},
        ],
      },
      include: projectInclude(req.user.id),
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return { data: projects.map(toProject) };
  });

  app.post('/projects', async (req, reply) => {
    const body = parse(CreateBody, req.body);
    const member = await currentMember(req);
    // The team must be in the current workspace; the project inherits it.
    const team = await app.db.team.findFirst({
      where: { id: body.teamId, workspaceId: member.workspaceId },
      select: { members: { where: { userId: req.user.id }, select: { userId: true } } },
    });
    if (!team) throw notFound('Team');
    if (member.role !== 'ADMIN' && team.members.length === 0) {
      throw forbidden('Join this team to create projects in it');
    }
    const project = await app.db.project.create({
      data: {
        workspaceId: member.workspaceId,
        teamId: body.teamId,
        ownerId: req.user.id,
        name: body.name,
        description: body.description ?? null,
        color: body.color,
        privacy: body.privacy,
        defaultView: body.defaultView,
        members: { create: { userId: req.user.id, role: 'OWNER' } },
        sections: {
          create: DEFAULT_SECTIONS.map((name, i) => ({ name, position: (i + 1) * POSITION_STEP })),
        },
      },
    });
    return reply.status(201).send(await loadProjectDetail(app.db, project.id, req.user.id));
  });

  app.get('/projects/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    await projectAccess(app.db, req.user, id);
    return loadProjectDetail(app.db, id, req.user.id);
  });

  app.patch('/projects/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(UpdateBody, req.body);
    assertCanManage(await projectAccess(app.db, req.user, id));
    await app.db.project.update({ where: { id }, data: body });
    return loadProjectDetail(app.db, id, req.user.id);
  });

  app.delete('/projects/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    assertCanManage(await projectAccess(app.db, req.user, id));
    await app.db.project.delete({ where: { id } });
    return reply.status(204).send();
  });

  // --- members --------------------------------------------------------------

  app.post('/projects/:id/members', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(AddMemberBody, req.body);
    const access = await projectAccess(app.db, req.user, id);
    assertCanManage(access);
    const user = await app.db.user.findUnique({ where: { id: body.userId } });
    if (!user || !user.isActive) throw notFound('User');
    if (!(await findMember(app.db, user, access.member.workspaceId))) {
      throw validation('User is not an active member of this workspace', [
        { path: ['userId'], message: 'Not an active workspace member' },
      ]);
    }
    const existing = await app.db.projectMember.findUnique({
      where: { projectId_userId: { projectId: id, userId: body.userId } },
    });
    if (existing) throw conflict('User is already a member of this project');
    await app.db.projectMember.create({ data: { projectId: id, userId: body.userId, role: body.role } });
    return loadProjectDetail(app.db, id, req.user.id);
  });

  /** A project always keeps at least one OWNER member, so its settings stay manageable. */
  async function assertKeepsAnOwner(projectId: string, userId: string) {
    const owners = await app.db.projectMember.findMany({
      where: { projectId, role: 'OWNER' },
      select: { userId: true },
    });
    if (owners.length === 1 && owners[0]!.userId === userId) {
      throw conflict('A project needs at least one owner');
    }
  }

  /** Keeps Project.owner pointing at a current OWNER member after roles change. */
  async function syncOwner(projectId: string) {
    const project = await app.db.project.findUniqueOrThrow({ where: { id: projectId }, select: { ownerId: true } });
    const owners = await app.db.projectMember.findMany({
      where: { projectId, role: 'OWNER' },
      select: { userId: true },
      orderBy: { user: { name: 'asc' } },
    });
    if (owners.length > 0 && !owners.some((o) => o.userId === project.ownerId)) {
      await app.db.project.update({ where: { id: projectId }, data: { ownerId: owners[0]!.userId } });
    }
  }

  app.patch('/projects/:id/members/:userId', async (req) => {
    const { id, userId } = parse(MemberParams, req.params);
    const { role } = parse(UpdateMemberBody, req.body);
    assertCanManage(await projectAccess(app.db, req.user, id));
    const member = await app.db.projectMember.findUnique({ where: { projectId_userId: { projectId: id, userId } } });
    if (!member) throw notFound('Project member');
    if (member.role === 'OWNER' && role !== 'OWNER') await assertKeepsAnOwner(id, userId);
    await app.db.projectMember.update({ where: { projectId_userId: { projectId: id, userId } }, data: { role } });
    await syncOwner(id);
    return loadProjectDetail(app.db, id, req.user.id);
  });

  app.delete('/projects/:id/members/:userId', async (req) => {
    const { id, userId } = parse(MemberParams, req.params);
    assertCanManage(await projectAccess(app.db, req.user, id));
    const member = await app.db.projectMember.findUnique({ where: { projectId_userId: { projectId: id, userId } } });
    if (!member) throw notFound('Project member');
    if (member.role === 'OWNER') await assertKeepsAnOwner(id, userId);
    await app.db.projectMember.delete({ where: { projectId_userId: { projectId: id, userId } } });
    await syncOwner(id);
    return loadProjectDetail(app.db, id, req.user.id);
  });

  // --- sections -------------------------------------------------------------

  app.post('/projects/:id/sections', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const body = parse(CreateSectionBody, req.body);
    assertCanEdit(await projectAccess(app.db, req.user, id));
    let position = body.position;
    if (position === undefined) {
      const last = await app.db.section.aggregate({ where: { projectId: id }, _max: { position: true } });
      position = (last._max.position ?? 0) + POSITION_STEP;
    }
    const section = await app.db.section.create({ data: { projectId: id, name: body.name, position } });
    return reply.status(201).send(toSection(section));
  });
}
