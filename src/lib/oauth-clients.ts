import type { OAuthClient, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { plainText } from './filenames.js';
import { fetchDocument, type FetchPolicy } from './link-preview.js';
import { isMetadataClientId, redirectUriProblem } from './oauth.js';

/** CIMD (M11): fetched with the link-preview SSRF rules, cached a day, a stale copy usable for a week. */
const CIMD_FRESH_MS = 24 * 60 * 60 * 1000;
const CIMD_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const CIMD_MAX_BYTES = 64 * 1024;
const CIMD_BUDGET_MS = 5_000;

export const MAX_REDIRECT_URIS = 5;
/** Clients at most, per source (DCR and cached CIMD documents each; M32); see pruneOAuthClients. */
export const MAX_CLIENTS = 1000;

/** A display name: cleaned like a filename (no controls or bidi tricks), ≤ 100 chars. */
export const clientName = z
  .string()
  .max(1000)
  .transform((s) => [...plainText(s)].slice(0, 100).join(''))
  .refine((s) => s.length > 0, 'client_name is empty');

const redirectUris = z
  .array(z.string())
  .min(1)
  .max(MAX_REDIRECT_URIS)
  .superRefine((uris, ctx) => {
    uris.forEach((uri, i) => {
      const problem = redirectUriProblem(uri);
      if (problem) ctx.addIssue({ code: 'custom', path: [i], message: `${uri.slice(0, 100)}: ${problem}` });
    });
  });

/** The fields of a client metadata document we use (RFC 7591 names). */
const MetadataDocument = z.object({
  client_id: z.string(),
  client_name: clientName,
  redirect_uris: redirectUris,
  token_endpoint_auth_method: z.literal('none').optional(),
});

export type ResolvedClient = OAuthClient;

/** Reads and checks a CIMD document; throws with the reason. */
async function fetchMetadata(url: string, policy: FetchPolicy) {
  const { body } = await fetchDocument(url, policy, { accept: 'application/json', maxBytes: CIMD_MAX_BYTES, budgetMs: CIMD_BUDGET_MS });
  const doc = MetadataDocument.parse(JSON.parse(body.toString('utf8')));
  if (doc.client_id !== url) throw new Error('client_id in the document does not match its URL');
  return doc;
}

/**
 * The client for a `client_id`: a registered (DCR) one, or a metadata document URL, fetched or from the
 * cache. Null if unknown, or if the document can't be read and no copy younger than a week is cached.
 */
export async function resolveClient(
  db: PrismaClient,
  policy: FetchPolicy,
  clientId: string,
  now: Date,
  log?: { info: (obj: object, msg: string) => void },
  /** Makes room at the client cap; a new CIMD client is refused if there is none. */
  prune?: () => Promise<unknown>,
): Promise<ResolvedClient | null> {
  if (!isMetadataClientId(clientId)) {
    if (clientId.length > 200) return null;
    const client = await db.oAuthClient.findUnique({ where: { clientId } });
    return client?.source === 'DCR' ? client : null;
  }
  const cached = await db.oAuthClient.findUnique({ where: { clientId } });
  if (cached?.source === 'CIMD' && cached.cachedAt && now.getTime() - cached.cachedAt.getTime() < CIMD_FRESH_MS) return cached;
  // Its own cap, separate from DCR's (M32).
  if (!cached && (await db.oAuthClient.count({ where: { source: 'CIMD' } })) >= MAX_CLIENTS) {
    await prune?.();
    if ((await db.oAuthClient.count({ where: { source: 'CIMD' } })) >= MAX_CLIENTS) return null;
  }
  try {
    const doc = await fetchMetadata(clientId, policy);
    const data = { name: doc.client_name, redirectUris: doc.redirect_uris, cachedAt: now };
    return await db.oAuthClient.upsert({ where: { clientId }, create: { clientId, source: 'CIMD', ...data }, update: data });
  } catch (err) {
    log?.info({ clientId, reason: err instanceof Error ? err.message : String(err) }, 'Client metadata document unusable');
    const usable = cached?.source === 'CIMD' && cached.cachedAt && now.getTime() - cached.cachedAt.getTime() < CIMD_STALE_MS;
    return usable ? cached : null;
  }
}
