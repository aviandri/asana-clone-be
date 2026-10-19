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
  if (detected) return detected.mime;
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

/** A decompression bomb guard: ~ 100 megapixels. */
const MAX_PIXELS = 100_000_000;

export type ImageInfo = {
  width: number;
  height: number;
  thumbnails: { small: Buffer; large: Buffer };
};

/**
 * Dimensions (as displayed, after EXIF rotation) and WebP thumbnails, or null if sharp can't decode it
 * (HEIC and BMP with the prebuilt sharp, corrupt files): still a valid file, just without a preview.
 */
export async function processImage(input: Buffer | string): Promise<ImageInfo | null> {
  try {
    const options = { limitInputPixels: MAX_PIXELS, failOn: 'error' as const };
    const meta = await sharp(input, options).metadata();
    if (!meta.width || !meta.height) return null;
    const rotated = (meta.orientation ?? 1) >= 5;
    const thumb = (size: number) =>
      sharp(input, options)
        .rotate()
        .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
    const [small, large] = await Promise.all([thumb(THUMBNAIL_SIZES.small), thumb(THUMBNAIL_SIZES.large)]);
    return {
      width: rotated ? meta.height : meta.width,
      height: rotated ? meta.width : meta.height,
      thumbnails: { small, large },
    };
  } catch {
    return null;
  }
}
