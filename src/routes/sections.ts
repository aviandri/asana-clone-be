import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { notFound } from '../errors.js';
import { assertCanEdit, projectAccess } from '../lib/access.js';
import { renormaliseSections } from '../lib/positions.js';
import { toSection } from '../lib/projects.js';
import { idParams, parse } from '../lib/validate.js';

const UpdateBody = z
  .object({ name: z.string().trim().min(1).max(200), position: z.number().finite() })
  .partial()
  .strict();

export default async function sectionRoutes(app: FastifyInstance) {
  /** Sections in projects the caller can't see are 404, like the project itself. */
  async function editableSection(req: FastifyRequest, id: string) {
    const section = await app.db.section.findUnique({ where: { id } });
    if (!section) throw notFound('Section');
    const access = await projectAccess(app.db, req.user, section.projectId).catch(() => {
      throw notFound('Section');
    });
    assertCanEdit(access);
    return section;
  }

  app.patch('/sections/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(UpdateBody, req.body);
    await editableSection(req, id);
    const section = await app.db.$transaction(async (tx) => {
      const updated = await tx.section.update({ where: { id }, data: body });
      if (body.position === undefined) return updated;
      await renormaliseSections(tx, updated);
      return tx.section.findUniqueOrThrow({ where: { id } });
    });
    return toSection(section);
  });

  app.delete('/sections/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    await editableSection(req, id);
    // FK is ON DELETE SET NULL: the section's tasks stay in the project with sectionId = null.
    await app.db.section.delete({ where: { id } });
    return reply.status(204).send();
  });
}
