import { createHash } from 'node:crypto';
import type { TokenScope } from '@prisma/client';

/**
 * OAuth 2.1 for the MCP server (SPEC §14): authorization code + PKCE (S256) for public clients, with
 * dynamic registration and client ID metadata documents. Pure helpers; the endpoints are in routes/oauth.ts.
 */

export const ACCESS_TOKEN_TTL_S = 60 * 60;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CODE_TTL_MS = 60 * 1000;
export const REQUEST_TTL_MS = 10 * 60 * 1000;
/** A refresh token reused this soon after its rotation is a client race, not theft (M20). */
export const REFRESH_REUSE_GRACE_MS = 30 * 1000;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

/** `read` / `write` → the token scope (`write` implies read). Null for an unknown scope; omitted = both. */
export function parseScope(raw: string | undefined): TokenScope | null {
  const parts = (raw ?? '').split(' ').filter(Boolean);
  if (parts.length === 0) return 'WRITE';
  if (!parts.every((p) => p === 'read' || p === 'write')) return null;
  return parts.includes('write') ? 'WRITE' : 'READ';
}

export function scopeString(scope: TokenScope): string {
  return scope === 'WRITE' ? 'read write' : 'read';
}

export function scopeList(scope: TokenScope): ('read' | 'write')[] {
  return scope === 'WRITE' ? ['read', 'write'] : ['read'];
}

/** `http://localhost` / `http://127.0.0.1`, any port (RFC 8252 loopback redirects). */
export function isLoopbackRedirect(url: URL): boolean {
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Why a redirect URI can't be registered, or null if it can: https, or http on loopback; absolute, no
 * fragment, no credentials, no wildcards.
 */
export function redirectUriProblem(raw: string): string | null {
  if (raw.length > 2000) return 'too long';
  if (raw.includes('*')) return 'wildcards are not allowed';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'not an absolute URL';
  }
  if (raw.includes('#')) return 'fragments are not allowed';
  if (url.username || url.password) return 'credentials are not allowed';
  if (url.protocol !== 'https:' && !isLoopbackRedirect(url)) return 'must be https (or http://localhost / http://127.0.0.1)';
  return null;
}

/**
 * Is `given` one of the `registered` redirect URIs? Exact string match, except that loopback URIs
 * ignore the port (M12): scheme, host, path and query still have to match.
 */
export function redirectUriMatches(given: string, registered: readonly string[]): boolean {
  if (registered.includes(given)) return true;
  let url: URL;
  try {
    url = new URL(given);
  } catch {
    return false;
  }
  if (!isLoopbackRedirect(url) || given.includes('#') || url.username || url.password) return false;
  const withoutPort = (u: URL) => `${u.protocol}//${u.hostname}${u.pathname}${u.search}`;
  return registered.some((r) => {
    try {
      const reg = new URL(r);
      return isLoopbackRedirect(reg) && withoutPort(reg) === withoutPort(url);
    } catch {
      return false;
    }
  });
}

/** RFC 7636 §4.1: 43–128 unreserved characters. */
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
/** An S256 challenge: base64url of a sha256, 43 characters. */
export const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!VERIFIER.test(verifier)) return false;
  return createHash('sha256').update(verifier).digest('base64url') === challenge;
}

/** `redirectUri` with the response parameters added (any query it already has is kept). */
export function withParams(redirectUri: string, params: Record<string, string | undefined | null>): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  return url.toString();
}

/** A client_id that names a metadata document (M11): an https URL with a path, no fragment or credentials. */
export function isMetadataClientId(clientId: string): boolean {
  if (!clientId.startsWith('https://')) return false;
  try {
    const url = new URL(clientId);
    return !url.hash && !clientId.includes('#') && !url.username && !url.password && url.pathname !== '/';
  } catch {
    return false;
  }
}

/** Escapes text for the HTML error page. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
