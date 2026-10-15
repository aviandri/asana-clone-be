import type { User } from '@prisma/client';

export const userSummarySelect = { id: true, name: true, email: true, avatarColor: true } as const;

export type UserSummaryRow = Pick<User, 'id' | 'name' | 'email' | 'avatarColor'>;

export function toUserSummary(u: UserSummaryRow) {
  return { id: u.id, name: u.name, email: u.email, avatarColor: u.avatarColor };
}

export function toUser(u: User) {
  return {
    ...toUserSummary(u),
    role: u.role,
    isActive: u.isActive,
    createdAt: u.createdAt.toISOString(),
  };
}

/** Date-only columns are stored as UTC midnight; expose them as `YYYY-MM-DD`. */
export function toDateOnly(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

export function fromDateOnly(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}
