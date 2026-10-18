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

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  APP_URL: z.string().url().default('http://localhost:5173'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  /** Per-IP attempts per minute on POST /auth/login and /auth/accept-invite. */
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  /** IANA zone for "today", current goal periods and report bucketing (SPEC §11). */
  APP_TIMEZONE: z
    .string()
    .default('Asia/Jakarta')
    .refine(isValidTimeZone, 'APP_TIMEZONE must be an IANA time zone, e.g. Asia/Jakarta'),
  /** Name of the workspace `create-admin` and `seed` create when none exists (SPEC §12). */
  DEFAULT_WORKSPACE_NAME: z.string().trim().min(1).max(100).default('Mekari'),
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
