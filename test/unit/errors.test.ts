import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors.js';
import { fromDateOnly, toDateOnly } from '../../src/lib/serialize.js';
import { dateOnly, parse } from '../../src/lib/validate.js';
import { loadConfig } from '../../src/config.js';

describe('AppError', () => {
  it('maps codes to HTTP statuses', () => {
    expect(new AppError('NOT_FOUND', 'x').statusCode).toBe(404);
    expect(new AppError('CONFLICT', 'x').statusCode).toBe(409);
    expect(new AppError('GONE', 'x').statusCode).toBe(410);
  });
});

describe('date-only helpers', () => {
  it('round-trips YYYY-MM-DD regardless of local timezone', () => {
    expect(toDateOnly(fromDateOnly('2026-03-01'))).toBe('2026-03-01');
    expect(toDateOnly(null)).toBeNull();
  });

  it('validates the format', () => {
    expect(parse(dateOnly, '2026-12-31')).toBe('2026-12-31');
    expect(() => parse(dateOnly, '12/31/2026')).toThrow(AppError);
  });
});

describe('loadConfig', () => {
  it('applies defaults and rejects a short JWT secret', () => {
    const cfg = loadConfig({ DATABASE_URL: 'postgres://x', JWT_SECRET: 'x'.repeat(16) });
    expect(cfg).toMatchObject({ PORT: 3000, HOST: '0.0.0.0', APP_URL: 'http://localhost:5173' });
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x', JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });
});
