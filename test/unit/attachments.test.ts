import { describe, expect, it } from 'vitest';
import { contentDisposition, sanitizeFilename } from '../../src/lib/filenames.js';
import { imagesInProgress, isInline, sniffMimeType, withImageSlot } from '../../src/lib/media.js';
import { parseRange } from '../../src/routes/attachments.js';
import { baseKey, derivedKey, newStorageKey } from '../../src/lib/storage.js';

describe('sanitizeFilename', () => {
  it('keeps the basename and strips controls, bidi and format marks', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('a\\b\\c.txt')).toBe('c.txt');
    expect(sanitizeFilename('pay\u202Efdp.exe')).toBe('payfdp.exe');
    for (const mark of ['\u202A', '\u202B', '\u202C', '\u202D', '\u2066', '\u2067', '\u2068', '\u2069', '\u200E', '\u200F', '\u061C']) {
      expect(sanitizeFilename(`a${mark}b.txt`)).toBe('ab.txt');
    }
    expect(sanitizeFilename('tab\there\nnew\u0000line\u007f\u0085.txt')).toBe('tab here newline.txt');
    expect(sanitizeFilename('  lots   of\u00A0space  .md ')).toBe('lots of space .md');
    expect(sanitizeFilename('👍🏽 emoji\u200D✨.png')).toBe('👍🏽 emoji\u200D✨.png'); // ZWJ is part of emoji, kept
  });

  it('falls back to "file" and caps at 255 UTF-8 bytes keeping the extension', () => {
    for (const empty of [undefined, null, '', '   ', '.', '..', '/', '\u202E']) expect(sanitizeFilename(empty)).toBe('file');
    const long = sanitizeFilename(`${'日'.repeat(300)}.docx`);
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(255);
    expect(long.endsWith('日.docx')).toBe(true);
    const noExt = sanitizeFilename('x'.repeat(400));
    expect(noExt).toBe('x'.repeat(255));
    const silly = sanitizeFilename(`${'a'.repeat(300)}.${'b'.repeat(40)}`);
    expect(Buffer.byteLength(silly)).toBe(255); // an "extension" that long isn't kept whole
  });
});

describe('sanitizeFilename (A12)', () => {
  it('replaces lone surrogates and strips every invisible format character but ZWJ', () => {
    expect(sanitizeFilename('a\uD800b.txt')).toBe('a\uFFFDb.txt');
    expect(sanitizeFilename('a\uDC00.txt')).toBe('a\uFFFD.txt');
    expect(sanitizeFilename('ok\uD83D\uDE00.txt'), 'a real pair stays').toBe('ok\uD83D\uDE00.txt');
    for (const cf of ['\u00AD', '\u200B', '\u200C', '\u2060', '\u2064', '\uFEFF', '\u{E0041}', '\u{E007F}']) {
      expect(sanitizeFilename(`re${cf}port.pdf`)).toBe('report.pdf');
    }
    expect(sanitizeFilename('a\u200Db.png')).toBe('a\u200Db.png');
  });
});

describe('contentDisposition', () => {
  it('gives an ASCII fallback and the exact UTF-8 name', () => {
    expect(contentDisposition('inline', 'a.pdf')).toBe(`inline; filename="a.pdf"; filename*=UTF-8''a.pdf`);
    expect(contentDisposition('attachment', 'naïve "q"\\ 100%.txt')).toBe(
      `attachment; filename="na_ve _q__ 100_.txt"; filename*=UTF-8''na%C3%AFve%20%22q%22%5C%20100%25.txt`,
    );
    expect(contentDisposition('attachment', "it's (1)*.txt")).toBe(
      `attachment; filename="it's (1)*.txt"; filename*=UTF-8''it%27s%20%281%29%2A.txt`,
    );
  });
});

describe('media', () => {
  it('sniffs by bytes, text only by extension, everything else is a download', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    expect(await sniffMimeType(png, 'x.txt')).toBe('image/png');
    expect(await sniffMimeType(Buffer.from('<svg/>'), 'x.svg')).toBe('application/octet-stream');
    expect(await sniffMimeType(Buffer.from('<html>'), 'x.html')).toBe('application/octet-stream');
    for (const ext of ['txt', 'MD', 'csv', 'json', 'log']) {
      expect(await sniffMimeType(Buffer.from('a,b'), `x.${ext}`)).toBe('text/plain');
    }
    expect(await sniffMimeType(Buffer.from('plain'), 'noext')).toBe('application/octet-stream');
  });

  it('calls m4a audio/mp4 (voice memos preview)', async () => {
    const m4a = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(20)]);
    expect(await sniffMimeType(m4a, 'memo.m4a')).toBe('audio/mp4');
    expect(isInline('audio/mp4')).toBe(true);
  });

  it('decodes at most 2 images at once', async () => {
    let running = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        withImageSlot(async () => {
          running += 1;
          peak = Math.max(peak, running);
          await new Promise((r) => setTimeout(r, 20));
          running -= 1;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(imagesInProgress()).toBe(0);
  });

  it('inlines only the allowlist', () => {
    for (const t of ['image/png', 'application/pdf', 'video/mp4', 'audio/ogg', 'text/plain']) expect(isInline(t)).toBe(true);
    for (const t of ['text/html', 'image/svg+xml', 'application/xml', 'application/javascript', 'image/tiff', 'image/heic'])
      expect(isInline(t)).toBe(false);
  });
});

describe('parseRange', () => {
  const etag = '"abc"';
  it('reads one byte range and falls back to the whole file otherwise', () => {
    expect(parseRange('bytes=0-9', 100, undefined, etag)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100, undefined, etag)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100, undefined, etag)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-500', 100, undefined, etag)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=50-500', 100, undefined, etag)).toEqual({ start: 50, end: 99 });
    expect(parseRange('bytes=100-', 100, undefined, etag)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 100, undefined, etag)).toBe('unsatisfiable');
    for (const ignored of [undefined, 'bytes=0-1,5-6', 'items=0-1', 'bytes=9-1', 'bytes=-', 'junk']) {
      expect(parseRange(ignored, 100, undefined, etag)).toBeNull();
    }
    expect(parseRange('bytes=0-9', 100, '"abc"', etag)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=0-9', 100, '"old"', etag)).toBeNull();
  });
});

describe('storage keys', () => {
  it('are random, sharded and never a filename', () => {
    const a = newStorageKey();
    expect(a).toMatch(/^([0-9a-f]{2})\/([0-9a-f]{2})\/[0-9a-f-]{36}$/);
    expect(a.slice(0, 5).replace('/', '')).toBe(a.slice(6).replace(/-/g, '').slice(0, 4));
    expect(newStorageKey()).not.toBe(a);
    expect(baseKey(derivedKey(a, 's'))).toBe(a);
    expect(baseKey(a)).toBe(a);
  });
});
