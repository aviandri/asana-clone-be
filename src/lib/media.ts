import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';

/** How many leading bytes [sniffMimeType] needs (file-type's sample size). */
export const SNIFF_BYTES = 4100;

const TEXT_EXTENSIONS = new Set(['txt', 'md', 'csv', 'json', 'log']);

/**
 * SPEC §13: the type comes from the magic bytes; the client's Content-Type is never used. Text has no
 * magic, so a few text extensions become `text/plain`; everything else unknown is a plain download.
 */
export async function sniffMimeType(head: Buffer, filename: string): Promise<string> {
  const detected = await fileTypeFromBuffer(head);
  // file-type calls m4a (voice memos) audio/x-m4a; it's MP4 audio, which the allowlist previews.
  if (detected) return detected.mime === 'audio/x-m4a' ? 'audio/mp4' : detected.mime;
  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
  return TEXT_EXTENSIONS.has(ext) ? 'text/plain' : 'application/octet-stream';
}

/** Served `inline`; anything else is `attachment` (SPEC §13 Serving). */
const INLINE = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'application/pdf',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/ogg',
  'audio/webm',
  'text/plain',
]);

export function isInline(mimeType: string): boolean {
  return INLINE.has(mimeType);
}

/** The Content-Type header for a stored type: text is always declared UTF-8. */
export function contentType(mimeType: string): string {
  return mimeType === 'text/plain' ? 'text/plain; charset=utf-8' : mimeType;
}

/** Raster types that get dimensions and thumbnails (never SVG: it's a document, not an image). */
const RASTER = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/avif',
  'image/bmp',
  'image/tiff',
]);

export function isRasterImage(mimeType: string): boolean {
  return RASTER.has(mimeType);
}

export const THUMBNAIL_SIZES = { small: 240, large: 1600 } as const;

/** A decompression bomb guard: ~ 50 megapixels (a 403 KB PNG can claim 100 MP and cost 150 MB to decode). */
const MAX_PIXELS = 50_000_000;

/** At most this many images are decoded at once, process-wide (A12): sharp work is CPU and memory heavy. */
const IMAGE_SLOTS = 2;
let busy = 0;
const waiting: (() => void)[] = [];

/** Runs `work` once an image slot is free (FIFO). */
export async function withImageSlot<T>(work: () => Promise<T>): Promise<T> {
  if (busy >= IMAGE_SLOTS) await new Promise<void>((resolve) => waiting.push(resolve));
  else busy += 1;
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next) next(); // the slot passes straight on
    else busy -= 1;
  }
}

/** Images being decoded right now (tests). */
export const imagesInProgress = () => busy;

export type ImageInfo = {
  width: number;
  height: number;
  thumbnails: { small: Buffer; large: Buffer };
};

/**
 * Dimensions (as displayed, after EXIF rotation) and WebP thumbnails, or null if sharp can't decode it
 * (HEIC and BMP with the prebuilt sharp, corrupt files): still a valid file, just without a preview.
 */
export function processImage(input: Buffer | string): Promise<ImageInfo | null> {
  return withImageSlot(async () => {
    try {
      const options = { limitInputPixels: MAX_PIXELS, failOn: 'error' as const, sequentialRead: true };
      const meta = await sharp(input, options).metadata();
      if (!meta.width || !meta.height) return null;
      const rotated = (meta.orientation ?? 1) >= 5;
      const fit = (size: number) => ({ width: size, height: size, fit: 'inside' as const, withoutEnlargement: true });
      // The original is decoded once: the large thumbnail from it, the small one from the large.
      const large = await sharp(input, options).rotate().resize(fit(THUMBNAIL_SIZES.large)).webp({ quality: 80 }).toBuffer();
      const small = await sharp(large).resize(fit(THUMBNAIL_SIZES.small)).webp({ quality: 80 }).toBuffer();
      return {
        width: rotated ? meta.height : meta.width,
        height: rotated ? meta.width : meta.height,
        thumbnails: { small, large },
      };
    } catch {
      return null;
    }
  });
}
