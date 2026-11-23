import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { PassThrough, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '../errors.js';
import { KEY, meter, type ByteRange, type PutOptions, type PutResult, type StorageDriver, type StoredObject } from './storage.js';

export type S3Settings = {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Any S3-compatible endpoint (Alibaba OSS, MinIO, R2, …); unset = AWS for `region`. */
  endpoint?: string;
  region?: string;
  /** MinIO usually needs path-style; OSS only accepts virtual-hosted style. */
  forcePathStyle?: boolean;
  /** Prepended to every key, e.g. `attachments/`. */
  prefix?: string;
};

/** The SDK client for S3-compatible stores. */
export function s3Client(s: S3Settings): S3Client {
  return new S3Client({
    region: s.region ?? 'us-east-1',
    endpoint: s.endpoint,
    forcePathStyle: s.forcePathStyle ?? false,
    credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
    // The SDK's default CRC32 checksums (and aws-chunked bodies) are AWS-only; OSS and older MinIO reject them.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

/** 5 MiB is S3's smallest part; 8 MiB × 2 in flight bounds memory per upload at ~16 MiB. */
const PART_SIZE = 8 * 1024 * 1024;
const QUEUE_SIZE = 2;

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.Code === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

/** A missing object looks like the disk driver's: an error with code ENOENT. */
function enoent(key: string, cause: unknown): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such object '${key}'`, { cause }), { code: 'ENOENT' });
}

/**
 * `STORAGE_DRIVER=s3`: objects in a bucket (AWS S3, Alibaba OSS, MinIO). Uploads stream through a multipart
 * `Upload`, so the object appears only on CompleteMultipartUpload (or the single PutObject of a small file).
 * There is no localPath/freeBytes/sweepTemps: a crashed upload leaves only multipart parts, which the bucket's
 * lifecycle rule (abort incomplete multipart uploads after 1 day) removes.
 */
export class S3Storage implements StorageDriver {
  readonly prefix: string;

  constructor(
    readonly client: S3Client,
    readonly bucket: string,
    prefix = '',
  ) {
    this.prefix = prefix;
  }

  static fromSettings(s: S3Settings): S3Storage {
    return new S3Storage(s3Client(s), s.bucket, s.prefix ?? '');
  }

  private objectKey(key: string) {
    // Keys are ours, but a bad one must never reach the bucket.
    if (!KEY.test(key)) throw new Error('Invalid storage key');
    return this.prefix + key;
  }

  async put(key: string, stream: Readable, options: PutOptions = {}): Promise<PutResult> {
    const Key = this.objectKey(key);
    const { transform, result } = meter(options);
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key, Body: transform, ContentType: 'application/octet-stream' },
      partSize: PART_SIZE,
      queueSize: QUEUE_SIZE,
      // On any failure (413 from the meter included) the Upload sends AbortMultipartUpload before done() rejects.
      leavePartsOnError: false,
    });
    // Whichever side fails first is the real cause (the other only sees an abort or an echo of it); a 413 always wins.
    let failure: { err: unknown } | undefined;
    const fail = (err: unknown) => {
      if (!failure || (err instanceof AppError && !(failure.err instanceof AppError))) failure = { err };
      throw err;
    };
    // If the store fails, stop reading the request so the pipeline below settles too.
    const uploaded = upload.done().catch((err: unknown) => {
      transform.destroy(err as Error);
      return fail(err);
    });
    const [piped, stored] = await Promise.allSettled([pipeline(stream, transform).catch(fail), uploaded]);
    if (failure) {
      // The source failed after the Upload had already completed: don't leave the object behind.
      if (stored.status === 'fulfilled') await this.delete(key).catch(() => {});
      throw failure.err;
    }
    if (piped.status === 'rejected') throw piped.reason;
    if (stored.status === 'rejected') throw stored.reason;
    return result();
  }

  get(key: string, range?: ByteRange): Readable {
    const Key = this.objectKey(key);
    const out = new PassThrough();
    const abort = new AbortController();
    out.once('close', () => abort.abort());
    this.client
      .send(
        new GetObjectCommand({ Bucket: this.bucket, Key, Range: range ? `bytes=${range.start}-${range.end}` : undefined }),
        { abortSignal: abort.signal },
      )
      .then(
        (res) => {
          const body = res.Body as Readable | undefined;
          if (!body) return void out.end();
          // pipeline destroys both sides on error (and the body if `out` was closed meanwhile).
          pipeline(body, out).catch((err: unknown) => out.destroy(err as Error));
        },
        (err: unknown) => out.destroy(isNotFound(err) ? enoent(key, err) : (err as Error)),
      );
    return out;
  }

  async delete(key: string) {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  async stat(key: string): Promise<StoredObject | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
      return { key, size: res.ContentLength ?? 0, modifiedAt: res.LastModified ?? new Date() };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async *list(): AsyncIterable<StoredObject> {
    let ContinuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.prefix || undefined, ContinuationToken }),
      );
      for (const object of page.Contents ?? []) {
        if (!object.Key?.startsWith(this.prefix)) continue;
        const key = object.Key.slice(this.prefix.length);
        if (!KEY.test(key)) continue; // anything else in the bucket isn't ours
        // No LastModified: treat it as new, so the sweeper never deletes it early.
        yield { key, size: object.Size ?? 0, modifiedAt: object.LastModified ?? new Date() };
      }
      ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (ContinuationToken);
  }
}
