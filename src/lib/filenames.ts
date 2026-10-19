/**
 * Upload filenames (SPEC §13): what the user sees, never a path. Sanitised once on upload; the stored
 * `name` is shown as given and only ever reaches HTTP through [contentDisposition].
 */

// Every invisible format character (\p{Cf}: bidi controls that can disguise an extension,
// "invoice\u202Etxt.exe" showing as "invoiceexe.txt", zero-width spaces, soft hyphens, BOM, tags), except
// ZWJ, which joins emoji (A12). Removed first: JS counts U+FEFF as whitespace.
const FORMAT = /(?!\u200D)\p{Cf}/gu;
// Controls (C0, C1, DEL): after whitespace (tabs, newlines) has become spaces.
const CONTROLS = /\p{Cc}/gu;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const MAX_BYTES = 255;

const utf8Length = (s: string) => Buffer.byteLength(s, 'utf8');

/** Cuts `s` to at most `bytes` UTF-8 bytes without splitting a character. */
function cutToBytes(s: string, bytes: number): string {
  let out = '';
  for (const ch of s) {
    if (utf8Length(out + ch) > bytes) break;
    out += ch;
  }
  return out;
}

export function sanitizeFilename(raw: string | undefined | null): string {
  // Lone surrogates (a broken UTF-16 filename*) become U+FFFD: they aren't valid UTF-8 for the DB.
  const base = (raw ?? '').replace(LONE_SURROGATE, '\uFFFD').split(/[/\\]/).pop() ?? '';
  // Format characters go; whitespace (tabs, newlines included) collapses to one space; other controls go.
  const name = base.replace(FORMAT, '').replace(/\s+/g, ' ').replace(CONTROLS, '').replace(/ {2,}/g, ' ').trim();
  if (name === '' || name === '.' || name === '..') return 'file';
  if (utf8Length(name) <= MAX_BYTES) return name;
  // Too long: keep the extension (if it's a sensible one) and shorten the stem.
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
  const stem = cutToBytes(ext ? name.slice(0, dot) : name, MAX_BYTES - utf8Length(ext)).trimEnd();
  return (stem || 'file') + ext;
}

/** RFC 6266 + 5987: an ASCII fallback for old clients and the exact UTF-8 name. */
export function contentDisposition(type: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
