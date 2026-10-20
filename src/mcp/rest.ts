import type { FastifyInstance } from 'fastify';
import type { Principal } from '../lib/tokens.js';
import { INTERNAL_HEADER, withTicket } from './internal.js';

/** A tool failure shown to the model: the message starts with the REST error code (SPEC §14). */
export class ToolError extends Error {}

export type ToolContext = {
  app: FastifyInstance;
  principal: Principal;
};

type ErrorEnvelope = { error?: { code?: string; message?: string; details?: unknown } };

/** `VALIDATION: assigneeId: Not an active workspace member` and friends, from the REST error envelope. */
function toolError(status: number, body: string): ToolError {
  let envelope: ErrorEnvelope = {};
  try {
    envelope = JSON.parse(body) as ErrorEnvelope;
  } catch {
    // Not our envelope; fall through to the status.
  }
  const { code = `HTTP_${status}`, message = 'Request failed', details } = envelope.error ?? {};
  const issues = Array.isArray(details) ? (details as { path?: unknown[]; message?: string }[]) : [];
  // A caller with no workspace at all (M15).
  if (issues.some((d) => d.message === 'NO_WORKSPACE')) return new ToolError(`NO_WORKSPACE: ${message}`);
  if (code === 'VALIDATION' && issues.length) {
    const parts = issues.slice(0, 5).map((d) => (d.path?.length ? `${d.path.join('.')}: ${d.message}` : `${d.message}`));
    return new ToolError(`VALIDATION: ${parts.join('; ')}`);
  }
  return new ToolError(`${code}: ${message}`);
}

export type RestOptions = {
  payload?: unknown;
  /** Sent as X-Workspace-Id: strict, so a workspace the user isn't in is NOT_FOUND (M15). */
  workspaceId?: string;
  query?: Record<string, string | number | boolean | undefined | null>;
};

/**
 * One REST call as the token's user (M14), through the real route: same validation, permissions,
 * notifications and activity. Returns the JSON body (null for 204), or throws a ToolError.
 */
export async function rest<T = unknown>(
  ctx: ToolContext,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  opts: RestOptions = {},
): Promise<T> {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null) query.set(k, String(v));
  const url = `/api/v1${path}${query.size ? `?${query}` : ''}`;
  const { principal } = ctx;
  const res = await withTicket(
    { userId: principal.user.id, tokenId: principal.token.id, scope: principal.token.scope, client: principal.token.client?.name ?? null },
    (ticket) =>
      ctx.app.inject({
        method,
        url,
        headers: {
          [INTERNAL_HEADER]: ticket,
          ...(opts.workspaceId ? { 'x-workspace-id': opts.workspaceId } : {}),
          ...(opts.payload !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(opts.payload !== undefined ? { payload: JSON.stringify(opts.payload) } : {}),
      }),
  );
  if (res.statusCode >= 200 && res.statusCode < 300) return (res.statusCode === 204 || !res.body ? null : res.json()) as T;
  throw toolError(res.statusCode, res.body);
}
