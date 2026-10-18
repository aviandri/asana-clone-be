import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Prisma, Task } from '@prisma/client';
import { z } from 'zod';
import { forbidden, notFound, validation } from '../errors.js';
import { assertCanEdit, projectAccess } from '../lib/access.js';
import { follow, notify, notifyFollowers, recordActivity } from '../lib/events.js';
import { renormaliseTaskSiblings } from '../lib/positions.js';
import { POSITION_STEP } from '../lib/projects.js';
import { fromDateOnly, toDateOnly } from '../lib/serialize.js';
import {
  findTaskWithAccess,
  loadTaskDetail,
  sortBySectionThenPosition,
  taskInclude,
  toTask,
  visibleTasksWhere,
} from '../lib/tasks.js';
import { dateOnly, idParams, parse, queryBool, uuid } from '../lib/validate.js';
import { currentMember, findMember } from '../lib/workspaces.js';

const priority = z.enum(['NONE', 'LOW', 'MEDIUM', 'HIGH']);

const writable = {
  title: z.string().trim().min(1).max(500),
  description: z.string().max(50_000).nullable(),
  assigneeId: uuid.nullable(),
  dueDate: dateOnly.nullable(),
  startDate: dateOnly.nullable(),
  priority,
  position: z.number().finite(),
  projectId: uuid.nullable(),
  sectionId: uuid.nullable(),
};

const CreateBody = z.object({
  title: writable.title,
  description: writable.description.optional(),
  assigneeId: writable.assigneeId.optional(),
  dueDate: writable.dueDate.optional(),
  startDate: writable.startDate.optional(),
  priority: writable.priority.optional(),
  position: writable.position.optional(),
  projectId: writable.projectId.optional(),
  sectionId: writable.sectionId.optional(),
  parentId: uuid.nullable().optional(),
});

// Unknown keys are stripped (not rejected) so clients can send back fields from a Task they hold.
const UpdateBody = z.object({ ...writable, completed: z.boolean() }).partial();

const ProjectTasksQuery = z.object({ completed: queryBool.optional(), assigneeId: uuid.optional() });
const MyTasksQuery = z.object({ completed: queryBool.optional() });
const FollowerBody = z.object({ userId: uuid });
const FollowerParams = z.object({ id: uuid, userId: uuid });

type Placement = { projectId: string | null; sectionId: string | null; parentId: string | null };

export default async function taskRoutes(app: FastifyInstance) {
  const db = app.db;

  /**
   * The user someone wants to assign or add as a follower: must exist, be active, be an active member
   * of the task's workspace (SPEC §12) and be able to see the project. Otherwise they'd get
   * notifications about a task they can't open. (Asana shares the project automatically instead; v1
   * rejects.)
   */
  async function assertCanBeInvolved(
    userId: string,
    workspaceId: string,
    projectId: string | null,
    field: 'assigneeId' | 'userId',
  ) {
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user || !user.isActive) throw notFound('User');
    if (!(await findMember(db, user, workspaceId))) {
      throw validation('User is not an active member of this workspace', [
        { path: [field], message: 'Not an active workspace member' },
      ]);
    }
    if (!projectId) return;
    const visible = await projectAccess(db, user, projectId).then(() => true, () => false);
    if (!visible) {
      throw validation('User has no access to this project', [{ path: [field], message: 'No access to this project' }]);
    }
  }

  /**
   * The caller must be able to edit tasks in the project (404 if invisible, 403 for commenters).
   * Returns the project's workspace.
   */
  async function assertCanEditProject(req: FastifyRequest, projectId: string) {
    const access = await projectAccess(db, req.user, projectId);
    assertCanEdit(access);
    return access.member.workspaceId;
  }

  /** Checks that a section exists and belongs to the project (adopting its project when none is given). */
  async function resolveSection(sectionId: string, projectId: string | null) {
    const section = await db.section.findUnique({ where: { id: sectionId }, select: { projectId: true } });
    if (!section) throw notFound('Section');
    if (projectId && section.projectId !== projectId) {
      throw validation('Section belongs to a different project', [{ path: ['sectionId'], message: 'Wrong project' }]);
    }
    return section.projectId;
  }

  async function nextPosition(p: Placement, creatorId: string) {
    const last = await db.task.aggregate({
      where: {
        projectId: p.projectId,
        sectionId: p.sectionId,
        parentId: p.parentId,
        ...(p.projectId ? {} : { creatorId }),
      },
      _max: { position: true },
    });
    return (last._max.position ?? 0) + POSITION_STEP;
  }

  // --- reads ----------------------------------------------------------------

  app.get('/projects/:id/tasks', async (req) => {
    const { id } = parse(idParams, req.params);
    const query = parse(ProjectTasksQuery, req.query);
    await projectAccess(db, req.user, id);
    const [tasks, sections] = await Promise.all([
      db.task.findMany({
        where: {
          projectId: id,
          parentId: null,
          ...(query.completed !== undefined ? { completed: query.completed } : {}),
          ...(query.assigneeId ? { assigneeId: query.assigneeId } : {}),
        },
        include: taskInclude,
      }),
      db.section.findMany({ where: { projectId: id }, select: { id: true, position: true } }),
    ]);
    const positions = new Map(sections.map((s) => [s.id, s.position]));
    return { data: sortBySectionThenPosition(tasks, positions).map(toTask) };
  });

  app.get('/me/tasks', async (req) => {
    const query = parse(MyTasksQuery, req.query);
    const member = await currentMember(req);
    const tasks = await db.task.findMany({
      where: {
        AND: [
          { assigneeId: req.user.id },
          query.completed !== undefined ? { completed: query.completed } : {},
          // Only the current workspace; tasks in projects the assignee can no longer see are left out.
          visibleTasksWhere(member),
        ],
      },
      include: taskInclude,
      orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
    });
    return { data: tasks.map(toTask) };
  });

  app.get('/tasks/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    await findTaskWithAccess(db, req.user, id);
    return loadTaskDetail(db, id);
  });

  // --- create ---------------------------------------------------------------

  app.post('/tasks', async (req, reply) => {
    const body = parse(CreateBody, req.body);
    const placement: Placement = {
      projectId: body.projectId ?? null,
      sectionId: body.sectionId ?? null,
      parentId: body.parentId ?? null,
    };

    // Subtasks live in their parent's workspace, project tasks in their project's, personal tasks
    // in the current workspace.
    let workspaceId: string | null = null;
    if (placement.parentId) {
      const { task: parent, access } = await findTaskWithAccess(db, req.user, placement.parentId).catch(() => {
        throw notFound('Parent task');
      });
      if (!access.canEdit) throw forbidden('Commenters can only add comments in this project');
      if (body.projectId !== undefined && body.projectId !== parent.projectId) {
        throw validation('Subtasks belong to their parent’s project', [{ path: ['projectId'], message: 'Must match parent' }]);
      }
      if (parent.parentId) {
        // One level of subtasks keeps project moves (which re-home direct subtasks) consistent.
        throw validation('Subtasks cannot have subtasks', [{ path: ['parentId'], message: 'Parent is a subtask' }]);
      }
      placement.projectId = parent.projectId;
      workspaceId = parent.workspaceId;
    }
    if (placement.sectionId) placement.projectId = await resolveSection(placement.sectionId, placement.projectId);
    if (placement.projectId) workspaceId = await assertCanEditProject(req, placement.projectId);
    workspaceId ??= (await currentMember(req)).workspaceId;
    if (body.assigneeId) await assertCanBeInvolved(body.assigneeId, workspaceId, placement.projectId, 'assigneeId');

    const position = body.position ?? (await nextPosition(placement, req.user.id));
    const actorId = req.user.id;

    const task = await db.$transaction(async (tx) => {
      const created = await tx.task.create({
        data: {
          ...placement,
          workspaceId,
          title: body.title,
          description: body.description ?? null,
          assigneeId: body.assigneeId ?? null,
          creatorId: actorId,
          dueDate: body.dueDate ? fromDateOnly(body.dueDate) : null,
          startDate: body.startDate ? fromDateOnly(body.startDate) : null,
          priority: body.priority ?? 'NONE',
          position,
        },
      });
      await follow(tx, created.id, [actorId, created.assigneeId]);
      await recordActivity(tx, created.id, actorId, 'CREATED');
      if (created.assigneeId) {
        await recordActivity(tx, created.id, actorId, 'ASSIGNED', { assigneeId: created.assigneeId });
        await notify(tx, 'ASSIGNED', actorId, created, [created.assigneeId]);
      }
      return created;
    });
    return reply.status(201).send(await loadTaskDetail(db, task.id));
  });

  // --- update ---------------------------------------------------------------

  app.patch('/tasks/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(UpdateBody, req.body);
    const { task, access } = await findTaskWithAccess(db, req.user, id);
    if (!access.canEdit) throw forbidden('Commenters can only add comments in this project');

    // Where the task ends up.
    const next: Placement = { projectId: task.projectId, sectionId: task.sectionId, parentId: task.parentId };
    if (body.projectId !== undefined && body.projectId !== task.projectId) {
      if (task.parentId) {
        throw validation('Subtasks belong to their parent’s project', [{ path: ['projectId'], message: 'Move the parent instead' }]);
      }
      next.projectId = body.projectId;
      next.sectionId = null; // the old section belongs to the old project
      if (next.projectId) {
        const target = await db.project.findUnique({ where: { id: next.projectId }, select: { workspaceId: true } });
        if (target && target.workspaceId !== task.workspaceId) {
          throw validation('Tasks can’t move to another workspace', [{ path: ['projectId'], message: 'Project is in another workspace' }]);
        }
        await assertCanEditProject(req, next.projectId);
      }
    }
    if (body.sectionId !== undefined) {
      next.sectionId = body.sectionId;
      if (body.sectionId) {
        if (!next.projectId) {
          throw validation('Personal tasks have no sections', [{ path: ['sectionId'], message: 'Set projectId too' }]);
        }
        await resolveSection(body.sectionId, next.projectId);
      }
    }
    // The assignee after this update must be able to see the project the task ends up in.
    const nextAssignee = body.assigneeId === undefined ? task.assigneeId : body.assigneeId;
    const assigneeChanged = body.assigneeId !== undefined && body.assigneeId !== task.assigneeId;
    if (nextAssignee && (assigneeChanged || next.projectId !== task.projectId)) {
      await assertCanBeInvolved(nextAssignee, task.workspaceId, next.projectId, 'assigneeId');
    }

    const data: Prisma.TaskUncheckedUpdateInput = {
      projectId: next.projectId,
      sectionId: next.sectionId,
      title: body.title,
      description: body.description,
      assigneeId: body.assigneeId,
      priority: body.priority,
      position: body.position,
      dueDate: body.dueDate === undefined ? undefined : body.dueDate && fromDateOnly(body.dueDate),
      startDate: body.startDate === undefined ? undefined : body.startDate && fromDateOnly(body.startDate),
    };
    if (body.completed !== undefined && body.completed !== task.completed) {
      data.completed = body.completed;
      data.completedAt = body.completed ? new Date() : null;
    }

    const actorId = req.user.id;
    await db.$transaction(async (tx) => {
      const updated = await tx.task.update({ where: { id }, data });
      if (next.projectId !== task.projectId) {
        await tx.task.updateMany({ where: { parentId: id }, data: { projectId: next.projectId, sectionId: null } });
      }
      if (body.position !== undefined || next.sectionId !== task.sectionId || next.projectId !== task.projectId) {
        await renormaliseTaskSiblings(tx, updated);
      }
      await recordChanges(tx, task, body, next, actorId);
    });
    return loadTaskDetail(db, id);
  });

  /** Activity records (SPEC §3) and the notifications that go with them. */
  async function recordChanges(
    tx: Prisma.TransactionClient,
    before: Task,
    body: z.infer<typeof UpdateBody>,
    next: Placement,
    actorId: string,
  ) {
    const log = (type: Parameters<typeof recordActivity>[3], data?: Prisma.InputJsonObject) =>
      recordActivity(tx, before.id, actorId, type, data);

    if (body.title !== undefined && body.title !== before.title) {
      await log('RENAMED', { from: before.title, to: body.title });
    }
    if (body.description !== undefined && body.description !== before.description) {
      await log('DESCRIPTION_CHANGED');
    }
    if (body.priority !== undefined && body.priority !== before.priority) {
      await log('PRIORITY_CHANGED', { from: before.priority, to: body.priority });
    }
    if (body.dueDate !== undefined && body.dueDate !== toDateOnly(before.dueDate)) {
      await log('DUE_DATE_CHANGED', { from: toDateOnly(before.dueDate), to: body.dueDate });
    }
    if (next.sectionId !== before.sectionId) {
      await log('MOVED_SECTION', { fromSectionId: before.sectionId, toSectionId: next.sectionId });
    }
    if (body.assigneeId !== undefined && body.assigneeId !== before.assigneeId) {
      if (body.assigneeId) {
        await log('ASSIGNED', { assigneeId: body.assigneeId });
        await follow(tx, before.id, [body.assigneeId]);
        await notify(tx, 'ASSIGNED', actorId, before, [body.assigneeId]);
      } else {
        await log('UNASSIGNED');
      }
    }
    if (body.completed !== undefined && body.completed !== before.completed) {
      await log(body.completed ? 'COMPLETED' : 'REOPENED');
      if (body.completed) await notifyFollowers(tx, 'COMPLETED', actorId, before);
    }
  }

  // --- delete ---------------------------------------------------------------

  app.delete('/tasks/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const { access } = await findTaskWithAccess(db, req.user, id);
    if (!access.canEdit) throw forbidden('Commenters can only add comments in this project');
    await db.task.delete({ where: { id } }); // subtasks cascade
    return reply.status(204).send();
  });

  // --- followers ------------------------------------------------------------
  // Anyone who can see a task (commenters included) can change who follows it.

  app.post('/tasks/:id/followers', async (req) => {
    const { id } = parse(idParams, req.params);
    const { userId } = parse(FollowerBody, req.body);
    const { task } = await findTaskWithAccess(db, req.user, id);
    await assertCanBeInvolved(userId, task.workspaceId, task.projectId, 'userId');
    await follow(db, id, [userId]);
    return loadTaskDetail(db, id);
  });

  app.delete('/tasks/:id/followers/:userId', async (req) => {
    const { id, userId } = parse(FollowerParams, req.params);
    await findTaskWithAccess(db, req.user, id);
    await db.taskFollower.deleteMany({ where: { taskId: id, userId } });
    return loadTaskDetail(db, id);
  });
}
