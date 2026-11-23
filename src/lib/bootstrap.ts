import type { PrismaClient, User, Workspace } from '@prisma/client';
import { z } from 'zod';
import { hashPassword, randomAvatarColor } from './password.js';
import { email, password } from './validate.js';

const UpsertAdminInput = z.object({
  email,
  name: z.string().trim().min(1).max(100).optional(),
  password: password.optional(),
  workspaceName: z.string().trim().min(1).max(100).default('Mekari'),
});

/**
 * Creates a user, or reactivates an existing one (a given password replaces theirs), and makes
 * them an active ADMIN of the default workspace: the oldest workspace named `workspaceName`, else
 * the oldest workspace (it may have been renamed), created only if there is none (SPEC §12). Used by `npm run create-admin` to bootstrap a deployment.
 */
export async function upsertAdmin(
  db: PrismaClient,
  input: z.input<typeof UpsertAdminInput>,
): Promise<{ user: User; created: boolean; workspace: Workspace }> {
  const { email: addr, name, password: plain, workspaceName } = UpsertAdminInput.parse(input);
  const existing = await db.user.findUnique({ where: { email: addr } });
  if (!existing && (!name || !plain)) throw new Error('--name and --password are required to create a new user');
  const passwordHash = plain ? await hashPassword(plain) : undefined;

  return db.$transaction(async (tx) => {
    const workspace =
      (await tx.workspace.findFirst({ where: { name: workspaceName }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })) ??
      (await tx.workspace.findFirst({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })) ??
      (await tx.workspace.create({ data: { name: workspaceName, color: '#4186e0' } }));
    const user = existing
      ? await tx.user.update({ where: { id: existing.id }, data: { isActive: true, name, passwordHash } })
      : await tx.user.create({ data: { email: addr, name: name!, passwordHash: passwordHash!, avatarColor: randomAvatarColor() } });
    await tx.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
      create: { workspaceId: workspace.id, userId: user.id, role: 'ADMIN' },
      update: { role: 'ADMIN', isActive: true },
    });
    const updated = user.lastWorkspaceId
      ? user
      : await tx.user.update({ where: { id: user.id }, data: { lastWorkspaceId: workspace.id } });
    return { user: updated, created: !existing, workspace };
  });
}

/**
 * Creates the first admin on an empty database (BOOTSTRAP_ADMIN_* on a platform without a shell for
 * `npm run create-admin`). Does nothing once any user exists, so restarts never reset a password or
 * re-promote anyone; two replicas racing on a fresh database end with one admin (the unique email
 * makes the loser fail, which counts as "already there").
 */
export async function bootstrapFirstAdmin(
  db: PrismaClient,
  input: { email: string; name: string; password: string; workspaceName?: string },
): Promise<{ status: 'created'; user: User; workspace: Workspace } | { status: 'skipped' }> {
  if ((await db.user.count()) > 0) return { status: 'skipped' };
  try {
    const { user, workspace } = await upsertAdmin(db, input);
    return { status: 'created', user, workspace };
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002' && (await db.user.count()) > 0) return { status: 'skipped' };
    throw err;
  }
}
