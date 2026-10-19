import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable } from 'node:stream';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import { isPublicAddress } from './ssrf.js';

/**
 * Link previews (SPEC §13): a server-side fetch that must never be turned against the server's own
 * network. Every hop resolves DNS once, checks EVERY address, and connects to the pinned one (no second
 * lookup a rebinding DNS could answer differently); redirects (≤ 3) are hops like any other.
 */

export type ResolvedAddress = { address: string; family: 4 | 6 };

export type FetchPolicy = {
  /** May the fetcher connect to this address? Default: public unicast only. */
  isAllowedAddress: (ip: string) => boolean;
  /** Ports other than 80/443 (tests' fixture servers). */
  allowAnyPort: boolean;
  resolve: (host: string) => Promise<ResolvedAddress[]>;
};

export const defaultPolicy: FetchPolicy = {
  isAllowedAddress: isPublicAddress,
  allowAnyPort: false,
  resolve: async (host) => (await dnsLookup(host, { all: true, verbatim: true })) as ResolvedAddress[],
};

/** LINK_PREVIEW_ALLOW_PRIVATE (tests only): any address, any port. */
export const permissivePolicy: FetchPolicy = { ...defaultPolicy, isAllowedAddress: () => true, allowAnyPort: true };

export const USER_AGENT = 'MekariProjectBot/1.0 (+link previews)';
export const BUDGET_MS = 6_000;
const MAX_REDIRECTS = 3;
const MAX_HTML_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export class BlockedError extends Error {
  override name = 'BlockedError';
}

type Response = { status: number; headers: http.IncomingHttpHeaders; body: Buffer; truncated: boolean };

/** Checks a URL before any connection: scheme, credentials, port, and every address its host resolves to. */
async function pin(url: URL, policy: FetchPolicy): Promise<ResolvedAddress> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BlockedError(`scheme ${url.protocol}`);
  if (url.username || url.password) throw new BlockedError('credentials in URL');
  if (url.port && !policy.allowAnyPort && url.port !== '80' && url.port !== '443') {
    throw new BlockedError(`port ${url.port}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(host);
  const addresses: ResolvedAddress[] = family ? [{ address: host, family: family as 4 | 6 }] : await policy.resolve(host);
  if (addresses.length === 0) throw new BlockedError('no address');
  // All of them: a host that also points somewhere private is refused outright.
  for (const a of addresses) if (!policy.isAllowedAddress(a.address)) throw new BlockedError(`address ${a.address}`);
  return addresses[0]!;
}

function decoded(res: http.IncomingMessage): Readable {
  switch ((res.headers['content-encoding'] ?? '').toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return res.pipe(createGunzip());
    case 'deflate':
      return res.pipe(createInflate());
    case 'br':
      return res.pipe(createBrotliDecompress());
    default:
      return res;
  }
}

/** One GET to a pinned address. Reads at most `maxBytes` of the decoded body (counted after decompression). */
async function get(url: URL, policy: FetchPolicy, signal: AbortSignal, accept: string, maxBytes: number): Promise<Response> {
  const target = await pin(url, policy);
  signal.throwIfAborted();
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        agent: false, // no pooled socket from another pin
        signal,
        // The connection goes to the address checked above, never a fresh lookup.
        lookup: (_host, options, callback) => {
          const cb = callback as (...args: unknown[]) => void;
          if ((options as { all?: boolean }).all) cb(null, [target]);
          else cb(null, target.address, target.family);
        },
        // No cookies, no auth: only what any anonymous visitor sends.
        headers: { 'User-Agent': USER_AGENT, Accept: accept, 'Accept-Encoding': 'gzip, deflate, br', 'Accept-Language': 'en' },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          res.resume();
          resolve({ status, headers: res.headers, body: Buffer.alloc(0), truncated: false });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        const body = decoded(res);
        body.on('data', (chunk: Buffer) => {
          if (truncated) return;
          const room = maxBytes - size;
          if (chunk.length >= room) {
            chunks.push(chunk.subarray(0, room));
            size = maxBytes;
            truncated = true;
            res.destroy();
            body.destroy();
            resolve({ status, headers: res.headers, body: Buffer.concat(chunks), truncated });
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        body.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks), truncated }));
        body.on('error', (err) => (truncated ? undefined : reject(err)));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** GET with redirects (each one a fully re-checked hop). Returns the final URL with the response. */
async function follow(start: URL, policy: FetchPolicy, signal: AbortSignal, accept: string, maxBytes: number) {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await get(url, policy, signal, accept, maxBytes);
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      url = new URL(res.headers.location, url);
      continue;
    }
    return { url, res };
  }
  throw new BlockedError('too many redirects');
}

// --- HTML ------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Plain text for display: no tags, no controls (bidi/format included), single spaces, at most `max` chars. */
export function cleanText(raw: string | undefined, max: number): string | null {
  if (!raw) return null;
  const text = decodeEntities(raw.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200B-\u200F\u202A-\u202E\u2066-\u2069\u061C\uFEFF]/g, '')
    .trim();
  if (!text) return null;
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
    const key = m[1]!.toLowerCase();
    if (!(key in out)) out[key] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

/** One `<name …>` tag; a `>` inside a quoted attribute value doesn't end it. */
const TAG = (name: string) => new RegExp(`<${name}\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, 'gi');

export type PageMeta = {
  title: string | null;
  description: string | null;
  siteName: string | null;
  image: string | null;
  icon: string | null;
};

/** og:*, twitter:*, <title>, <meta name=description> and <link rel=icon>, resolved against `base`. */
export function parsePage(html: string, base: URL): PageMeta {
  const meta = new Map<string, string>();
  for (const [tag] of html.matchAll(TAG('meta'))) {
    const a = attributes(tag);
    const key = (a.property ?? a.name ?? '').toLowerCase();
    if (key && a.content !== undefined && !meta.has(key)) meta.set(key, a.content);
  }
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  let icon: string | undefined;
  for (const [tag] of html.matchAll(TAG('link'))) {
    const a = attributes(tag);
    const rel = (a.rel ?? '').toLowerCase().split(/\s+/);
    if (a.href && (rel.includes('icon') || rel.includes('apple-touch-icon'))) {
      icon ??= a.href;
      if (rel.includes('icon')) break; // a plain icon wins over a touch icon
    }
  }
  const absolute = (href: string | undefined) => {
    if (!href) return null;
    try {
      const url = new URL(href.trim(), base);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
    } catch {
      return null;
    }
  };
  const first = (...keys: string[]) => keys.map((k) => meta.get(k)).find((v) => v && v.trim());
  return {
    title: cleanText(first('og:title', 'twitter:title') ?? titleTag, 300),
    description: cleanText(first('og:description', 'twitter:description', 'description'), 1000),
    siteName: cleanText(first('og:site_name'), 300),
    image: absolute(first('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src')),
    icon: absolute(icon) ?? new URL('/favicon.ico', base).toString(),
  };
}

// --- providers -------------------------------------------------------------------

/** SPEC §13 provider ids, from the final hostname (and path where one host serves several). Open set. */
export function providerFor(url: URL): string | null {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const is = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (host === 'docs.google.com') {
    if (url.pathname.startsWith('/document')) return 'google_docs';
    if (url.pathname.startsWith('/spreadsheets')) return 'google_sheets';
    if (url.pathname.startsWith('/presentation')) return 'google_slides';
    return 'google_drive';
  }
  if (host === 'drive.google.com') return 'google_drive';
  if (is('dropbox.com') || host === 'db.tt') return 'dropbox';
  if (is('onedrive.live.com') || host === '1drv.ms' || is('sharepoint.com')) return 'onedrive';
  if (is('box.com')) return 'box';
  if (is('figma.com')) return 'figma';
  if (is('youtube.com') || host === 'youtu.be') return 'youtube';
  if (is('loom.com')) return 'loom';
  if (is('github.com')) return 'github';
  if (is('gitlab.com')) return 'gitlab';
  if (is('notion.so') || is('notion.site')) return 'notion';
  if (is('miro.com')) return 'miro';
  if (is('atlassian.net')) return url.pathname.startsWith('/wiki') ? 'confluence' : 'jira';
  if (is('slack.com')) return 'slack';
  if (is('zoom.us')) return 'zoom';
  return null;
}

// --- images ----------------------------------------------------------------------

const RASTER = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/tiff']);

/** The largest PNG inside an .ico (modern favicons embed PNGs; sharp can't read ICO itself). */
function pngFromIco(ico: Buffer): Buffer | null {
  if (ico.length < 6 || ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) return null;
  const count = ico.readUInt16LE(4);
  let best: Buffer | null = null;
  for (let i = 0; i < count && 6 + i * 16 + 16 <= ico.length; i++) {
    const entry = 6 + i * 16;
    const size = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    if (offset + size > ico.length || size < 8) continue;
    const data = ico.subarray(offset, offset + size);
    if (data.readUInt32BE(0) === 0x89504e47 && (!best || data.length > best.length)) best = data;
  }
  return best;
}

/** Re-encodes a fetched image to WebP within `box` px; null if it isn't a raster image we can read. */
export async function reencode(bytes: Buffer, box: number): Promise<Buffer | null> {
  const type = await fileTypeFromBuffer(bytes);
  let input: Buffer | null = null;
  if (type && RASTER.has(type.mime)) input = bytes;
  else if (type?.mime === 'image/x-icon') input = pngFromIco(bytes);
  if (!input) return null;
  try {
    return await sharp(input, { limitInputPixels: 50_000_000, failOn: 'error' })
      .rotate()
      .resize({ width: box, height: box, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
  } catch {
    return null;
  }
}

// --- the preview -------------------------------------------------------------------

export type Preview = {
  status: 'READY' | 'FAILED';
  title: string | null;
  description: string | null;
  siteName: string | null;
  provider: string | null;
  icon: Buffer | null;
  image: Buffer | null;
  /** Why it failed (for logs; never shown). */
  reason?: string;
};

/** Fetches a preview within one 6 s budget. Never throws: a failure is `FAILED` (the card still works). */
export async function fetchPreview(rawUrl: string, policy: FetchPolicy = defaultPolicy, budgetMs = BUDGET_MS): Promise<Preview> {
  const start = new URL(rawUrl);
  const failed = (reason: string): Preview => ({
    status: 'FAILED',
    title: null,
    description: null,
    siteName: null,
    provider: providerFor(start),
    icon: null,
    image: null,
    reason,
  });
  const signal = AbortSignal.timeout(budgetMs);
  let page: { url: URL; res: Response };
  try {
    page = await follow(start, policy, signal, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', MAX_HTML_BYTES);
  } catch (err) {
    return failed(err instanceof Error ? `${err.name}: ${err.message}` : 'error');
  }
  const type = String(page.res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (page.res.status !== 200) return failed(`HTTP ${page.res.status}`);
  if (type !== 'text/html' && type !== 'application/xhtml+xml') return failed(`content type ${type || 'none'}`);

  const meta = parsePage(page.res.body.toString('utf8'), page.url);
  const image = async (href: string | null, box: number) => {
    if (!href) return null;
    try {
      const { res } = await follow(new URL(href), policy, signal, 'image/*', MAX_IMAGE_BYTES);
      if (res.status !== 200 || res.truncated) return null;
      return await reencode(res.body, box);
    } catch {
      return null;
    }
  };
  const [icon, picture] = await Promise.all([image(meta.icon, 64), image(meta.image, 1200)]);
  return {
    status: 'READY',
    title: meta.title,
    description: meta.description,
    siteName: meta.siteName,
    provider: providerFor(page.url),
    icon,
    image: picture,
  };
}
