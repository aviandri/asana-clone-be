import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { conflict, forbidden, notFound } from '../errors.js';
import { toUserSummary, userSummarySelect } from '../lib/serialize.js';
import { idParams, parse, queryBool, uuid } from '../lib/validate.js';
import { requireAdmin } from '../plugins/auth.js';

const ListQuery = z.object({ mine: queryBool.optional() });
const CreateBody = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000).nullish(),
});
const UpdateBody = CreateBody.partial().strict();
const MemberBody = z.object({ userId: uuid });
const MemberParams = z.object({ id: uuid, userId: uuid });

export default async function teamRoutes(app: FastifyInstance) {
  async function loadTeamDetail(id: string) {
    const team = await app.db.team.findUnique({
      where: { id },
      include: {
        members: { include: { user: { select: userSummarySelect } }, orderBy: { user: { name: 'asc' } } },
      },
    });
    if (!team) throw notFound('Team');
    return {
      id: team.id,
      name: team.name,
      description: team.description,
      memberCount: team.members.length,
      createdAt: team.createdAt.toISOString(),
      members: team.members.map((m) => toUserSummary(m.user)),
    };
  }

  /** Team membership changes and edits: members of the team, or ADMIN. */
  async function assertTeamMemberOrAdmin(req: FastifyRequest, teamId: string) {
    const team = await app.db.team.findUnique({
      where: { id: teamId },
      select: { members: { where: { userId: req.user.id }, select: { userId: true } } },
    });
    if (!team) throw notFound('Team');
    if (req.user.role !== 'ADMIN' && team.members.length === 0) {
      throw forbidden('Only team members can change this team');
    }
  }

  app.get('/teams', async (req) => {
    const { mine } = parse(ListQuery, req.query);
    const teams = await app.db.team.findMany({
      where: mine ? { members: { some: { userId: req.user.id } } } : {},
      include: { _count: { select: { members: true } } },
      orderBy: { name: 'asc' },
    });
    return {
      data: teams.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        memberCount: t._count.members,
        createdAt: t.createdAt.toISOString(),
      })),
    };
  });

  app.post('/teams', async (req, reply) => {
    const body = parse(CreateBody, req.body);
    const team = await app.db.team.create({
      data: {
        name: body.name,
        description: body.description ?? null,
        members: { create: { userId: req.user.id } },
      },
    });
    return reply.status(201).send(await loadTeamDetail(team.id));
  });

  app.get('/teams/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    return loadTeamDetail(id);
  });

  app.patch('/teams/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(UpdateBody, req.body);
    await assertTeamMemberOrAdmin(req, id);
    await app.db.team.update({ where: { id }, data: body });
    return loadTeamDetail(id);
  });

  app.delete('/teams/:id', async (req, reply) => {
    requireAdmin(req);
    const { id } = parse(idParams, req.params);
    const team = await app.db.team.findUnique({ where: { id }, include: { _count: { select: { projects: true } } } });
    if (!team) throw notFound('Team');
    if (team._count.projects > 0) throw conflict('Move or delete this team’s projects first');
    await app.db.team.delete({ where: { id } });
    return reply.status(204).send();
  });

  app.post('/teams/:id/members', async (req) => {
    const { id } = parse(idParams, req.params);
    const { userId } = parse(MemberBody, req.body);
    await assertTeamMemberOrAdmin(req, id);
    const user = await app.db.user.findUnique({ where: { id: userId } });
    if (!user || !user.isActive) throw notFound('User');
    await app.db.teamMember.upsert({
      where: { teamId_userId: { teamId: id, userId } },
      create: { teamId: id, userId },
      update: {},
    });
    return loadTeamDetail(id);
  });

  app.delete('/teams/:id/members/:userId', async (req) => {
    const { id, userId } = parse(MemberParams, req.params);
    await assertTeamMemberOrAdmin(req, id);
    await app.db.teamMember.deleteMany({ where: { teamId: id, userId } });
    return loadTeamDetail(id);
  });
}
