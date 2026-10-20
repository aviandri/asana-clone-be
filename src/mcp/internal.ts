import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { TokenScope } from '@prisma/client';

/**
 * Internal principal tickets (SPEC §14 M14). MCP tools call the REST handlers in-process with
 * `app.inject`, so permissions, validation, notifications and activity are the REST API's own. The
 * injected request carries a single-use ticket bound to {userId, tokenId, scope}. It is honoured only
 * on a request injected from inside `withTicket` (the async context must hold the same ticket), so a
 * network request can never use one, even a leaked one.
 */

export const INTERNAL_HEADER = 'x-mcp-internal-ticket';
const TTL_MS = 30_000;

export type TicketClaim = { userId: string; tokenId: string; scope: TokenScope; client: string | null };

const tickets = new Map<string, TicketClaim & { expiresAt: number }>();
const context = new AsyncLocalStorage<{ ticket: string }>();

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
    return await context.run({ ticket }, () => fn(ticket));
  } finally {
    tickets.delete(ticket);
  }
}

/**
 * The claim behind an internal header, consumed. `undefined` = no header. `null` = present but not
 * honoured: not inside the matching injection, unknown, expired or already used.
 */
export function takeTicket(header: string | string[] | undefined, now = Date.now()): TicketClaim | null | undefined {
  if (header === undefined) return undefined;
  const store = context.getStore();
  if (typeof header !== 'string' || !store || store.ticket !== header) return null;
  const claim = tickets.get(header);
  tickets.delete(header);
  if (!claim || claim.expiresAt <= now) return null;
  return { userId: claim.userId, tokenId: claim.tokenId, scope: claim.scope, client: claim.client };
}
