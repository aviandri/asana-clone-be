import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { S3Storage } from '../../src/lib/s3-storage.js';
import { derivedKey, newStorageKey } from '../../src/lib/storage.js';

const client = new S3Client({
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  requestChecksumCalculation: 'WHEN_REQUIRED',
});
const s3 = mockClient(client);
const MiB = 1024 * 1024;

/** `total` bytes of a repeating pattern, in 1 MiB chunks, produced lazily. */
function bytes(total: number): Readable {
  let sent = 0;
  return new Readable({
    read() {
      if (sent >= total) return this.push(null);
      const n = Math.min(MiB, total - sent);
      const chunk = Buffer.alloc(n);
      for (let i = 0; i < n; i++) chunk[i] = (sent + i) % 251;
      sent += n;
      this.push(chunk);
    },
  });
}

async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

// The driver only needs a Node Readable; the SDK's mixin type is irrelevant here.
const body = (buf: Buffer) => Readable.from([buf]) as never;
const notFound = () => new NotFound({ message: 'Not Found', $metadata: { httpStatusCode: 404 } });

beforeEach(() => s3.reset());
afterEach(() => s3.reset());

describe('S3Storage.put', () => {
  it('stores a small file with one PutObject and returns size, sha256 and head', async () => {
    const storage = new S3Storage(client, 'bucket', 'attachments/');
    const key = newStorageKey();
    const content = Buffer.from('hello, object storage');
    let stored: Buffer | undefined;
    s3.on(PutObjectCommand).callsFake(async (input) => {
      stored = Buffer.from(input.Body as Uint8Array);
      return {};
    });
    const result = await storage.put(key, Readable.from([content]), { headBytes: 5 });
    expect(result.size).toBe(content.length);
    expect(result.sha256).toBe(createHash('sha256').update(content).digest('hex'));
    expect(result.head.toString()).toBe('hello');
    expect(stored?.equals(content)).toBe(true);
    const put = s3.commandCalls(PutObjectCommand)[0]!.args[0].input;
    expect(put.Bucket).toBe('bucket');
    expect(put.Key).toBe(`attachments/${key}`);
  });

  it('streams a large file as a multipart upload with the same size/sha256 as the bytes', async () => {
    const storage = new S3Storage(client, 'bucket');
    const total = 17 * MiB + 123;
    const parts: Buffer[] = [];
    s3.on(CreateMultipartUploadCommand).resolves({ UploadId: 'up-1' });
    s3.on(UploadPartCommand).callsFake(async (input) => {
      parts[input.PartNumber! - 1] = Buffer.from(input.Body as Uint8Array);
      return { ETag: `"${input.PartNumber}"` };
    });
    s3.on(CompleteMultipartUploadCommand).resolves({});
    const result = await storage.put(newStorageKey(), bytes(total), { maxBytes: 100 * MiB });
    const all = Buffer.concat(parts);
    expect(all.length).toBe(total);
    expect(result.size).toBe(total);
    expect(result.sha256).toBe(createHash('sha256').update(all).digest('hex'));
    expect(s3.commandCalls(CompleteMultipartUploadCommand)).toHaveLength(1);
    expect(s3.commandCalls(AbortMultipartUploadCommand)).toHaveLength(0);
  });

  it('over maxBytes in the first part: 413 and nothing is written', async () => {
    const storage = new S3Storage(client, 'bucket');
    s3.on(PutObjectCommand).resolves({});
    await expect(storage.put(newStorageKey(), bytes(3 * MiB), { maxBytes: 2 * MiB })).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
    });
    expect(s3.calls()).toHaveLength(0);
  });

  it('over maxBytes mid-multipart: 413, the upload is aborted and never completed', async () => {
    const storage = new S3Storage(client, 'bucket');
    s3.on(CreateMultipartUploadCommand).resolves({ UploadId: 'up-2' });
    s3.on(UploadPartCommand).resolves({ ETag: '"x"' });
    s3.on(AbortMultipartUploadCommand).resolves({});
    await expect(storage.put(newStorageKey(), bytes(30 * MiB), { maxBytes: 20 * MiB })).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
    });
    expect(s3.commandCalls(CreateMultipartUploadCommand)).toHaveLength(1);
    expect(s3.commandCalls(AbortMultipartUploadCommand)).toHaveLength(1);
    expect(s3.commandCalls(AbortMultipartUploadCommand)[0]!.args[0].input.UploadId).toBe('up-2');
    expect(s3.commandCalls(CompleteMultipartUploadCommand)).toHaveLength(0);
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  it('a store failure mid-stream rejects put and stops reading the source', async () => {
    const storage = new S3Storage(client, 'bucket');
    s3.on(CreateMultipartUploadCommand).rejects(new Error('boom'));
    const source = bytes(1000 * MiB);
    await expect(storage.put(newStorageKey(), source)).rejects.toThrow('boom');
    expect(source.destroyed).toBe(true);
  });

  it('refuses keys that are not ours', async () => {
    const storage = new S3Storage(client, 'bucket');
    await expect(storage.put('../etc/passwd', Readable.from([Buffer.from('x')]))).rejects.toThrow('Invalid storage key');
    expect(() => storage.get('nope')).toThrow('Invalid storage key');
  });
});

describe('S3Storage.get', () => {
  it('sends an inclusive Range and streams the body', async () => {
    const storage = new S3Storage(client, 'bucket', 'p/');
    const key = newStorageKey();
    s3.on(GetObjectCommand).resolves({ Body: body(Buffer.from('bcd')) });
    const out = await drain(storage.get(key, { start: 1, end: 3 }));
    expect(out.toString()).toBe('bcd');
    const input = s3.commandCalls(GetObjectCommand)[0]!.args[0].input;
    expect(input).toMatchObject({ Bucket: 'bucket', Key: `p/${key}`, Range: 'bytes=1-3' });
  });

  it('without a range there is no Range header', async () => {
    const storage = new S3Storage(client, 'bucket');
    s3.on(GetObjectCommand).resolves({ Body: body(Buffer.from('whole')) });
    expect((await drain(storage.get(newStorageKey()))).toString()).toBe('whole');
    expect(s3.commandCalls(GetObjectCommand)[0]!.args[0].input.Range).toBeUndefined();
  });

  it('a missing object errors the stream with ENOENT, like the disk driver', async () => {
    const storage = new S3Storage(client, 'bucket');
    s3.on(GetObjectCommand).rejects(new NoSuchKey({ message: 'missing', $metadata: { httpStatusCode: 404 } }));
    await expect(drain(storage.get(newStorageKey()))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('other errors are propagated with destroy(err)', async () => {
    const storage = new S3Storage(client, 'bucket');
    s3.on(GetObjectCommand).rejects(new Error('denied'));
    await expect(drain(storage.get(newStorageKey()))).rejects.toThrow('denied');
  });
});

describe('S3Storage.stat / delete', () => {
  it('stat returns size and mtime, or null when missing', async () => {
    const storage = new S3Storage(client, 'bucket');
    const key = newStorageKey();
    const when = new Date('2026-01-02T03:04:05Z');
    s3.on(HeadObjectCommand).resolvesOnce({ ContentLength: 42, LastModified: when }).rejectsOnce(notFound());
    expect(await storage.stat(key)).toEqual({ key, size: 42, modifiedAt: when });
    expect(await storage.stat(key)).toBeNull();
  });

  it('stat rethrows anything but not-found', async () => {
    const storage = new S3Storage(client, 'bucket');
    s3.on(HeadObjectCommand).rejects(new Error('forbidden'));
    await expect(storage.stat(newStorageKey())).rejects.toThrow('forbidden');
  });

  it('delete of a missing object is fine', async () => {
    const storage = new S3Storage(client, 'bucket', 'a/');
    const key = newStorageKey();
    s3.on(DeleteObjectCommand).resolvesOnce({}).rejectsOnce(notFound());
    await storage.delete(key);
    await storage.delete(key);
    expect(s3.commandCalls(DeleteObjectCommand)[0]!.args[0].input).toEqual({ Bucket: 'bucket', Key: `a/${key}` });
  });
});

describe('S3Storage.list', () => {
  it('pages through ListObjectsV2 under the prefix and skips keys that are not ours', async () => {
    const storage = new S3Storage(client, 'bucket', 'attachments/');
    const [a, b, c] = [newStorageKey(), newStorageKey(), newStorageKey()];
    const when = new Date('2026-05-06T00:00:00Z');
    s3.on(ListObjectsV2Command, { ContinuationToken: undefined }).resolves({
      Contents: [
        { Key: `attachments/${a}`, Size: 1, LastModified: when },
        { Key: 'attachments/notes.txt', Size: 9, LastModified: when },
        { Key: `attachments/${derivedKey(a, 's')}`, Size: 2, LastModified: when },
      ],
      IsTruncated: true,
      NextContinuationToken: 't2',
    });
    s3.on(ListObjectsV2Command, { ContinuationToken: 't2' }).resolves({
      Contents: [
        { Key: `attachments/${b}`, Size: 3, LastModified: when },
        { Key: `attachments/nested/${c}`, Size: 4, LastModified: when },
      ],
      IsTruncated: true,
      NextContinuationToken: 't3',
    });
    s3.on(ListObjectsV2Command, { ContinuationToken: 't3' }).resolves({
      Contents: [{ Key: `attachments/${c}`, Size: 5, LastModified: when }],
      IsTruncated: false,
    });
    const listed = [];
    for await (const o of storage.list()) listed.push(o);
    expect(listed).toEqual([
      { key: a, size: 1, modifiedAt: when },
      { key: derivedKey(a, 's'), size: 2, modifiedAt: when },
      { key: b, size: 3, modifiedAt: when },
      { key: c, size: 5, modifiedAt: when },
    ]);
    const calls = s3.commandCalls(ListObjectsV2Command);
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call.args[0].input.Prefix).toBe('attachments/');
  });

  it('without a prefix lists the whole bucket', async () => {
    const storage = new S3Storage(client, 'bucket');
    const a = newStorageKey();
    s3.on(ListObjectsV2Command).resolves({ Contents: [{ Key: a, Size: 1 }, { Key: `x/${a}`, Size: 1 }] });
    const listed = [];
    for await (const o of storage.list()) listed.push(o.key);
    expect(listed).toEqual([a]);
    expect(s3.commandCalls(ListObjectsV2Command)[0]!.args[0].input.Prefix).toBeUndefined();
  });
});

describe('config: STORAGE_DRIVER=s3', () => {
  const base = { DATABASE_URL: 'postgresql://x', JWT_SECRET: 'x'.repeat(32), NODE_ENV: 'test' } as NodeJS.ProcessEnv;

  it('defaults to disk and needs no S3 vars', () => {
    expect(loadConfig(base).STORAGE_DRIVER).toBe('disk');
  });

  it('requires bucket and credentials with a clear message', () => {
    expect(() => loadConfig({ ...base, STORAGE_DRIVER: 's3' })).toThrow(
      'STORAGE_DRIVER: STORAGE_DRIVER=s3 needs S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY',
    );
    expect(() => loadConfig({ ...base, STORAGE_DRIVER: 's3', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: '' })).toThrow(
      'S3_SECRET_ACCESS_KEY',
    );
  });

  it('parses the optional settings with defaults', () => {
    const s3Env = { ...base, STORAGE_DRIVER: 's3', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' };
    const minimal = loadConfig({ ...s3Env, S3_ENDPOINT: '' });
    expect(minimal).toMatchObject({ S3_FORCE_PATH_STYLE: false, S3_PREFIX: '' });
    expect(minimal.S3_ENDPOINT).toBeUndefined();
    expect(minimal.S3_REGION).toBeUndefined(); // the driver signs for us-east-1 (AWS)
    const full = loadConfig({
      ...s3Env,
      S3_ENDPOINT: 'https://s3.oss-ap-southeast-5.aliyuncs.com',
      S3_REGION: 'ap-southeast-5',
      S3_FORCE_PATH_STYLE: 'true',
      S3_PREFIX: '/attachments',
    });
    expect(full).toMatchObject({
      S3_ENDPOINT: 'https://s3.oss-ap-southeast-5.aliyuncs.com',
      S3_REGION: 'ap-southeast-5',
      S3_FORCE_PATH_STYLE: true,
      S3_PREFIX: 'attachments/',
    });
    expect(() => loadConfig({ ...s3Env, S3_ENDPOINT: 'not a url' })).toThrow('S3_ENDPOINT');
  });

  it('requires S3_REGION with a custom endpoint (a guessed region fails every signature)', () => {
    const s3Env = { ...base, STORAGE_DRIVER: 's3', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' };
    expect(() => loadConfig({ ...s3Env, S3_ENDPOINT: 'https://s3.oss-ap-southeast-5.aliyuncs.com' })).toThrow('S3_REGION');
    expect(() => loadConfig(s3Env)).not.toThrow(); // AWS: region defaults to us-east-1 in the driver
  });
});
