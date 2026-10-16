import type { PrismaClient, User } from '@prisma/client';
import { z } from 'zod';
import { hashPassword, randomAvatarColor } from './password.js';
import { email, password } from './validate.js';

const UpsertAdminInput = z.object({
  email,
  name: z.string().trim().min(1).max(100).optional(),
  password: password.optional(),
});

/**
 * Creates an ADMIN, or promotes (and reactivates) an existing user. A given password replaces the
 * existing one. Used by `npm run create-admin` to bootstrap a fresh deployment.
 */
export async function upsertAdmin(
  db: PrismaClient,
  input: z.input<typeof UpsertAdminInput>,
): Promise<{ user: User; created: boolean }> {
  const { email: addr, name, password: plain } = UpsertAdminInput.parse(input);
  const existing = await db.user.findUnique({ where: { email: addr } });
  const passwordHash = plain ? await hashPassword(plain) : undefined;
  if (existing) {
    const user = await db.user.update({
      where: { id: existing.id },
      data: { role: 'ADMIN', isActive: true, name, passwordHash },
    });
    return { user, created: false };
  }
  if (!name || !passwordHash) throw new Error('--name and --password are required to create a new user');
  const user = await db.user.create({
    data: { email: addr, name, passwordHash, role: 'ADMIN', avatarColor: randomAvatarColor() },
  });
  return { user, created: true };
}
