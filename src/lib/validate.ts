import { z } from 'zod';
import { validation } from '../errors.js';

export function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input ?? {});
  if (!result.success) throw validation('Invalid request', result.error.issues);
  return result.data;
}

export const uuid = z.string().uuid();
export const idParams = z.object({ id: uuid });

export const email = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(254);

export const password = z.string().min(8, 'Password must be at least 8 characters').max(200);

export const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Expected a hex color like #aabbcc');

export const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Invalid date');

/** Query-string boolean: accepts `true` / `false`. */
export const queryBool = z.enum(['true', 'false']).transform((v) => v === 'true');
