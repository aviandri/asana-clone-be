import { randomBytes } from 'node:crypto';
import type { Invite } from '@prisma/client';
import { toUserSummary, type UserSummaryRow } from './serialize.js';

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const newInviteToken = () => randomBytes(24).toString('base64url');

export function toInvite(invite: Invite & { invitedBy?: UserSummaryRow }, appUrl: string) {
  return {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    token: invite.token,
    inviteUrl: `${appUrl.replace(/\/+$/, '')}/invite/${invite.token}`,
    expiresAt: invite.expiresAt.toISOString(),
    createdAt: invite.createdAt.toISOString(),
    ...(invite.invitedBy ? { invitedBy: toUserSummary(invite.invitedBy) } : {}),
  };
}
