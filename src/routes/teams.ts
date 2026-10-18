import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { conflict, forbidden, notFound, validation } from '../errors.js';
import { toUserSummary, userSummarySelect } from '../lib/serialize.js';
import { idParams, parse, queryBool, uuid } from '../lib/validate.js';
import { requireAdmin } from '../plugins/auth.js';
import { currentMember, findMember, requireMember, requireNotGuest } from '../lib/workspaces.js';

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
      workspaceId: team.workspaceId,
      name: team.name,
      description: team.description,
      memberCount: team.members.length,
      createdAt: team.createdAt.toISOString(),
      members: team.members.map((m) => toUserSummary(m.user)),
    };
  }

  /** ID-addressed: the caller must be an active member of the team's workspace (else 404). */
  async function findTeam(req: FastifyRequest, teamId: string) {
    const team = await app.db.team.findUnique({
      where: { id: teamId },
      select: { workspaceId: true, members: { where: { userId: req.user.id }, select: { userId: true } } },
    });
    if (!team) throw notFound('Team');
    const member = await requireMember(app.db, req.user, team.workspaceId, 'Team');
    // Guests are never in teams and don't browse them (SPEC §12).
    if (member.role === 'GUEST') throw notFound('Team');
    return { team, member };
  }

  /** Team membership changes and edits: members of the team, or ADMIN. */
  async function assertTeamMemberOrAdmin(req: FastifyRequest, teamId: string) {
    const found = await findTeam(req, teamId);
    if (found.member.role !== 'ADMIN' && found.team.members.length === 0) {
      throw forbidden('Only team members can change this team');
    }
    return found;
  }

  app.get('/teams', async (req) => {
    const { mine } = parse(ListQuery, req.query);
    const { workspaceId, role } = await currentMember(req);
    if (role === 'GUEST') return { data: [] };
    const teams = await app.db.team.findMany({
      where: { workspaceId, ...(mine ? { members: { some: { userId: req.user.id } } } : {}) },
      include: { _count: { select: { members: true } } },
      orderBy: { name: 'asc' },
    });
    return {
      data: teams.map((t) => ({
        id: t.id,
        workspaceId: t.workspaceId,
        name: t.name,
        description: t.description,
        memberCount: t._count.members,
        createdAt: t.createdAt.toISOString(),
      })),
    };
  });

  app.post('/teams', async (req, reply) => {
    const body = parse(CreateBody, req.body);
    const member = await currentMember(req);
    requireNotGuest(member, 'Guests can’t create teams');
    const { workspaceId } = member;
    const team = await app.db.team.create({
      data: {
        workspaceId,
        name: body.name,
        description: body.description ?? null,
        members: { create: { userId: req.user.id } },
      },
    });
    return reply.status(201).send(await loadTeamDetail(team.id));
  });

  app.get('/teams/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    await findTeam(req, id);
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
    const { id } = parse(idParams, req.params);
    requireAdmin((await findTeam(req, id)).member);
    const team = await app.db.team.findUnique({ where: { id }, include: { _count: { select: { projects: true, goals: true } } } });
    if (!team) throw notFound('Team');
    if (team._count.projects > 0 || team._count.goals > 0) {
      throw conflict('Move or delete this team’s projects and goals first');
    }
    await app.db.team.delete({ where: { id } });
    return reply.status(204).send();
  });

  app.post('/teams/:id/members', async (req) => {
    const { id } = parse(idParams, req.params);
    const { userId } = parse(MemberBody, req.body);
    const { team } = await assertTeamMemberOrAdmin(req, id);
    const user = await app.db.user.findUnique({ where: { id: userId } });
    if (!user || !user.isActive) throw notFound('User');
    const target = await findMember(app.db, user, team.workspaceId);
    if (!target) {
      throw validation('User is not an active member of this workspace', [
        { path: ['userId'], message: 'Not an active workspace member' },
      ]);
    }
    if (target.role === 'GUEST') {
      throw validation('Guests can’t join teams', [{ path: ['userId'], message: 'Guests can’t join teams' }]);
    }
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
