import 'dotenv/config';
import { z } from 'zod';

function isValidTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** https, or plain http on a loopback host (dev and tests). */
function isSecureOrLocal(url: string) {
  const u = new URL(url);
  return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
}

const envBool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(fallback ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  /** The public origin of the app (SPEC §14 M1: also the OAuth issuer, the MCP resource base and deep links). */
  APP_URL: z
    .string()
    .url()
    .default('http://localhost:5173')
    .transform((u) => u.replace(/\/+$/, '')),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  /**
   * Proxies in front of the BE that set X-Forwarded-For (SPEC §14 M2). Each overwrites it with one entry, so only
   * that many hops are trusted and a client-sent XFF can't pick its own rate-limit bucket. 0 = no proxy.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().nonnegative().default(1),
  /** Per-IP attempts per minute on POST /auth/login and /auth/accept-invite. */
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  /** IANA zone for "today", current goal periods and report bucketing (SPEC §11). */
  APP_TIMEZONE: z
    .string()
    .default('Asia/Jakarta')
    .refine(isValidTimeZone, 'APP_TIMEZONE must be an IANA time zone, e.g. Asia/Jakarta'),
  /** Name of the workspace `create-admin` and `seed` create when none exists (SPEC §12). */
  DEFAULT_WORKSPACE_NAME: z.string().trim().min(1).max(100).default('Mekari'),
  /** Attachments (SPEC §13): only `disk` in v1.3; `s3` is a later drop-in. */
  STORAGE_DRIVER: z.enum(['disk']).default('disk'),
  /** Where the disk driver keeps files (`/data/attachments` in docker, on the `attachments` volume). */
  STORAGE_DIR: z.string().min(1).default('./data/attachments'),
  /** Per-file upload limit in bytes (SPEC §13 A1: 100 MB = 104,857,600). */
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(104_857_600),
  /** Uploads (files and links) per user per 10 minutes. */
  UPLOAD_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  /** Uploads are refused (507) when they could leave less than this free on STORAGE_DIR (A12: 2 GiB). */
  STORAGE_MIN_FREE_BYTES: z.coerce.number().int().nonnegative().default(2 * 1024 ** 3),
  /**
   * The longest a whole request may take, in ms (Fastify's requestTimeout; 0 = none). 15 minutes lets a
   * 100 MB upload through at ~0.9 Mbit/s. nginx's timeouts are per read/write, so this is the only total.
   */
  REQUEST_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(900_000),
  /** Fetch link previews (SPEC §13). Off: links are created with previewStatus FAILED; cards still work. */
  LINK_PREVIEW_ENABLED: envBool(true),
  /** TESTS ONLY: let the preview fetcher reach private addresses and any port. Refused in production. */
  LINK_PREVIEW_ALLOW_PRIVATE: envBool(false),
  /** The MCP server, its OAuth endpoints and personal access tokens (SPEC §14). Needs an https APP_URL. */
  MCP_ENABLED: envBool(false),
})
  .refine((c) => !c.MCP_ENABLED || isSecureOrLocal(c.APP_URL), {
    message: 'MCP_ENABLED needs an https APP_URL (http only for localhost / 127.0.0.1)',
    path: ['APP_URL'],
  })
  .refine((c) => !(c.NODE_ENV === 'production' && c.LINK_PREVIEW_ALLOW_PRIVATE), {
  message: 'must not be set in production (it lets link previews reach the internal network)',
  path: ['LINK_PREVIEW_ALLOW_PRIVATE'],
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  return parsed.data;
}
