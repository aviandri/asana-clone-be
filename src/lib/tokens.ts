import { createHash, randomBytes } from 'node:crypto';
import type { ApiToken, OAuthClient, Prisma, PrismaClient, TokenScope, User } from '@prisma/client';

/**
 * Personal access tokens and OAuth tokens for the MCP server (SPEC §14). Opaque: a type prefix and 32
 * random bytes (base64url). Only the sha256 is stored; the plaintext is shown once.
 */

export type TokenKind = 'mpat' | 'mpoa' | 'mpor';

type Db = PrismaClient | Prisma.TransactionClient;

/** How many leading characters (type prefix included) are kept for display. */
const PREFIX_LENGTH = 12;
export const MAX_ACTIVE_PATS = 20;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateToken(kind: TokenKind) {
  const token = `${kind}_${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashToken(token), prefix: token.slice(0, PREFIX_LENGTH) };
}

/** Not revoked and not expired. */
export const liveTokenWhere = (now: Date): Prisma.ApiTokenWhereInput => ({
  revokedAt: null,
  OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
});

export type ApiTokenInfo = {
  id: string;
  name: string;
  source: 'PAT' | 'OAUTH';
  scope: TokenScope;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
};

export function toTokenInfo(t: ApiToken): ApiTokenInfo {
  return {
    id: t.id,
    name: t.name,
    source: t.source,
    scope: t.scope,
    prefix: t.prefix,
    createdAt: t.createdAt.toISOString(),
    lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
    expiresAt: t.expiresAt?.toISOString() ?? null,
  };
}

/** The caller's live PATs and OAuth grants (one row per refresh family, M19), newest first. */
export async function listTokens(db: Db, userId: string, now: Date): Promise<ApiTokenInfo[]> {
  const [pats, refreshes] = await Promise.all([
    db.apiToken.findMany({ where: { AND: [{ userId, source: 'PAT' }, liveTokenWhere(now)] } }),
    // The live refresh token of each family: unused, unrevoked, unexpired.
    db.oAuthRefresh.findMany({
      where: { userId, usedAt: null, revokedAt: null, expiresAt: { gt: now } },
      include: { client: { select: { name: true } } },
    }),
  ]);
  const families = refreshes.map((r) => r.family);
  const [firsts, uses] = families.length
    ? await Promise.all([
        db.oAuthRefresh.groupBy({ by: ['family'], where: { family: { in: families } }, _min: { createdAt: true } }),
        db.apiToken.groupBy({ by: ['oauthFamily'], where: { oauthFamily: { in: families } }, _max: { lastUsedAt: true } }),
      ])
    : [[], []];
  const firstGrant = new Map(firsts.map((f) => [f.family, f._min.createdAt]));
  const lastUse = new Map(uses.map((u) => [u.oauthFamily, u._max.lastUsedAt]));
  const grants: ApiTokenInfo[] = refreshes.map((r) => ({
    id: r.family,
    name: r.client.name,
    source: 'OAUTH',
    scope: r.scope,
    prefix: r.prefix,
    createdAt: (firstGrant.get(r.family) ?? r.createdAt).toISOString(),
    lastUsedAt: lastUse.get(r.family)?.toISOString() ?? null,
    expiresAt: r.expiresAt.toISOString(),
  }));
  return [...pats.map(toTokenInfo), ...grants].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Revokes a whole OAuth grant: its refresh tokens and every access token issued in it. */
export async function revokeFamily(db: Db, family: string, now: Date) {
  await db.oAuthRefresh.updateMany({ where: { family, revokedAt: null }, data: { revokedAt: now } });
  await db.apiToken.updateMany({ where: { oauthFamily: family, revokedAt: null }, data: { revokedAt: now } });
}

/**
 * Revokes one of the user's PATs, or one of their OAuth grants by family id. False if neither is theirs
 * (another user's id is indistinguishable from an unknown one).
 */
export async function revokeToken(db: PrismaClient, userId: string, id: string, now: Date): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const pat = await tx.apiToken.findFirst({ where: { id, userId, source: 'PAT' }, select: { id: true } });
    if (pat) {
      await tx.apiToken.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: now } });
      return true;
    }
    const grant = await tx.oAuthRefresh.findFirst({ where: { family: id, userId }, select: { id: true } });
    if (!grant) return false;
    await revokeFamily(tx, id, now);
    return true;
  });
}

/**
 * A password change (M17): every token, grant and unused code of the user goes. Pending authorization
 * requests aren't bound to a user until the decision (M7), and a decided one lives on only as its code.
 */
export async function revokeEverything(db: Db, userId: string, now: Date) {
  await db.apiToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
  await db.oAuthRefresh.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
  await db.oAuthCode.deleteMany({ where: { userId, usedAt: null } });
}

// --- bearer authentication (only on /mcp) ---------------------------------------------------------

export type Principal = {
  user: User;
  token: Pick<ApiToken, 'id' | 'scope' | 'source'> & { client: Pick<OAuthClient, 'clientId' | 'name'> | null };
};

/** Bearer tokens the MCP endpoint accepts: PATs and OAuth access tokens (never a refresh token). */
const BEARER = /^[Bb][Ee][Aa][Rr][Ee][Rr] +(mp(?:at|oa)_[A-Za-z0-9_-]{43})$/;

/** The token in an Authorization header, or undefined (absent, another scheme, or not one of ours). */
export function bearerToken(header: string | undefined): string | undefined {
  return header ? BEARER.exec(header.trim())?.[1] : undefined;
}

/**
 * The user behind a token: unknown, revoked or expired tokens and deactivated users (M16) are null.
 * A token is never compared in JS: only its hash is looked up.
 */
export async function authenticateToken(db: PrismaClient, token: string, now: Date): Promise<Principal | null> {
  const row = await db.apiToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true, oauthClient: { select: { clientId: true, name: true } } },
  });
  if (!row || row.revokedAt || (row.expiresAt && row.expiresAt <= now) || !row.user.isActive) return null;
  return { user: row.user, token: { id: row.id, scope: row.scope, source: row.source, client: row.oauthClient } };
}

/** `lastUsedAt` is written at most once per interval per token (no write per request). In memory, per process. */
export class UsageThrottle {
  private readonly last = new Map<string, number>();

  constructor(
    private readonly intervalMs = 60_000,
    private readonly maxEntries = 10_000,
  ) {}

  /** True when the token's lastUsedAt is due for a write (and records it). */
  due(tokenId: string, now: number): boolean {
    const prev = this.last.get(tokenId);
    if (prev !== undefined && now - prev < this.intervalMs) return false;
    if (this.last.size >= this.maxEntries) {
      for (const [id, at] of this.last) if (now - at >= this.intervalMs) this.last.delete(id);
    }
    this.last.set(tokenId, now);
    return true;
  }
}
