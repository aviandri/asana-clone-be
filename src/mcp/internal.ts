import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { TokenScope } from '@prisma/client';

/**
 * Internal principal tickets (SPEC §14 M14). MCP tools call the REST handlers in-process with
 * `app.inject`, so permissions, validation, notifications and activity are the REST API's own. The
 * injected request carries a single-use ticket bound to {userId, tokenId, scope}. It is honoured only
 * on an injected request: those run on a mock socket whose remote address we set to a value no real
 * TCP connection can have (it isn't an IP), so a network request can never use one, even a leaked one.
 */

export const INTERNAL_HEADER = 'x-mcp-internal-ticket';
/** The injected request's socket address: not an IP, so never a real peer's. */
export const INTERNAL_REMOTE = 'mcp-internal';
const TTL_MS = 30_000;

/**
 * The only routes a ticket opens (M33): exactly what the tools call. Tokens, passwords, admin, invites,
 * memberships, OAuth and login stay out of reach even of a WRITE token. GET /auth/me is the one /auth
 * route: the caller's own profile and workspaces (whoami and the workspace default).
 */
export const INTERNAL_ROUTES: ReadonlySet<string> = new Set([
  'GET /api/v1/auth/me',
  'GET /api/v1/teams',
  'GET /api/v1/users',
  'GET /api/v1/projects',
  'GET /api/v1/projects/:id',
  'GET /api/v1/projects/:id/tasks',
  'GET /api/v1/projects/:id/report',
  'GET /api/v1/me/tasks',
  'GET /api/v1/tasks/:id',
  'GET /api/v1/tasks/:id/stories',
  'GET /api/v1/search',
  'GET /api/v1/goals',
  'GET /api/v1/goals/:id',
  'GET /api/v1/goals/:id/updates',
  'GET /api/v1/reports/workload',
  'GET /api/v1/notifications',
  'POST /api/v1/tasks',
  'PATCH /api/v1/tasks/:id',
  'POST /api/v1/tasks/:id/comments',
  'POST /api/v1/tasks/:id/attachments/link',
  'POST /api/v1/tasks/:id/followers',
  'DELETE /api/v1/tasks/:id/followers/:userId',
  'POST /api/v1/projects',
  'PATCH /api/v1/projects/:id',
  'POST /api/v1/projects/:id/sections',
  'PATCH /api/v1/sections/:id',
  'POST /api/v1/goals/:id/updates',
  'PATCH /api/v1/key-results/:id',
  'POST /api/v1/notifications/read-all',
  'POST /api/v1/notifications/:id/read',
]);

export type TicketClaim = { userId: string; tokenId: string; scope: TokenScope; client: string | null };

const tickets = new Map<string, TicketClaim & { expiresAt: number }>();

function prune(now: number) {
  for (const [t, c] of tickets) if (c.expiresAt <= now) tickets.delete(t);
}

/** Runs `fn` (an app.inject) with a fresh ticket for `claim`; the ticket is gone afterwards either way. */
export async function withTicket<T>(claim: TicketClaim, fn: (ticket: string) => Promise<T>): Promise<T> {
  const now = Date.now();
  if (tickets.size > 1000) prune(now);
  const ticket = randomBytes(32).toString('base64url');
  tickets.set(ticket, { ...claim, expiresAt: now + TTL_MS });
  try {
    return await fn(ticket);
  } finally {
    tickets.delete(ticket);
  }
}

/** Was this request injected by `rest` (and not received from the network)? */
export function isInternal(raw: IncomingMessage): boolean {
  return raw?.socket?.remoteAddress === INTERNAL_REMOTE;
}

/**
 * The claim behind an internal header, consumed. `undefined` = no header. `null` = present but not
 * honoured: not an internal request, unknown, expired or already used.
 */
export function takeTicket(header: string | string[] | undefined, internal: boolean, now = Date.now()): TicketClaim | null | undefined {
  if (header === undefined) return undefined;
  if (typeof header !== 'string' || !internal) return null;
  const claim = tickets.get(header);
  tickets.delete(header);
  if (!claim || claim.expiresAt <= now) return null;
  return { userId: claim.userId, tokenId: claim.tokenId, scope: claim.scope, client: claim.client };
}
