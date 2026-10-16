import type { Prisma } from '@prisma/client';
import { POSITION_STEP } from './projects.js';

/** Closer than this to a sibling means repeated midpoint inserts have used up the float gap. */
export const MIN_GAP = 1e-6;

type Tx = Prisma.TransactionClient;
type Positioned = { id: string; position: number };

/** True when the moved item sits within MIN_GAP of any sibling (siblings sorted by position). */
export function isCrowded(siblings: Positioned[], movedId: string): boolean {
  const moved = siblings.find((s) => s.id === movedId);
  if (!moved) return false;
  return siblings.some((s) => s.id !== movedId && Math.abs(s.position - moved.position) < MIN_GAP);
}

/** New positions 1000, 2000, … for siblings already in display order; only changed rows. */
export function renumber(siblings: Positioned[]): Positioned[] {
  return siblings
    .map((s, i) => ({ id: s.id, position: (i + 1) * POSITION_STEP }))
    .filter((next, i) => next.position !== siblings[i]!.position);
}

const ORDER = [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] as const;

/**
 * Renumbers a task's sibling group (same project + section + parent) when its position collides
 * with a neighbour. Personal top-level tasks are grouped per creator, as when appending.
 */
export async function renormaliseTaskSiblings(
  tx: Tx,
  task: { id: string; projectId: string | null; sectionId: string | null; parentId: string | null; creatorId: string },
) {
  const siblings = await tx.task.findMany({
    where: {
      projectId: task.projectId,
      sectionId: task.sectionId,
      parentId: task.parentId,
      ...(task.projectId || task.parentId ? {} : { creatorId: task.creatorId }),
    },
    select: { id: true, position: true },
    orderBy: [...ORDER],
  });
  if (!isCrowded(siblings, task.id)) return;
  for (const s of renumber(siblings)) {
    // updatedAt is left alone: renumbering isn't an edit of the siblings.
    await tx.$executeRaw`UPDATE "Task" SET "position" = ${s.position} WHERE "id" = ${s.id}::uuid`;
  }
}

/** Renumbers a project's sections when a section's position collides with a neighbour. */
export async function renormaliseSections(tx: Tx, section: { id: string; projectId: string }) {
  const siblings = await tx.section.findMany({
    where: { projectId: section.projectId },
    select: { id: true, position: true },
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
  });
  if (!isCrowded(siblings, section.id)) return;
  for (const s of renumber(siblings)) {
    await tx.section.update({ where: { id: s.id }, data: { position: s.position } });
  }
}
