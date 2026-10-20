import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { bearerToken, generateToken, hashToken, UsageThrottle } from '../../src/lib/tokens.js';

describe('tokens', () => {
  it('are a type prefix plus 32 random bytes, hashed with sha256', () => {
    const a = generateToken('mpat');
    const b = generateToken('mpat');
    expect(a.token).toMatch(/^mpat_[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.prefix).toBe(a.token.slice(0, 12));
    expect(a.hash).toBe(hashToken(a.token));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(generateToken('mpoa').token).toMatch(/^mpoa_/);
    expect(generateToken('mpor').token).toMatch(/^mpor_/);
  });

  it('reads only PATs and access tokens from a Bearer header', () => {
    const pat = generateToken('mpat').token;
    const access = generateToken('mpoa').token;
    expect(bearerToken(`Bearer ${pat}`)).toBe(pat);
    expect(bearerToken(`bearer ${access}`)).toBe(access);
    expect(bearerToken(` BEARER ${pat} `)).toBe(pat);
    for (const header of [undefined, '', pat, `Basic ${pat}`, `Bearer ${generateToken('mpor').token}`, `Bearer ${pat}x`, `Bearer ${pat.slice(0, -1)}`, `Bearer ${pat.toUpperCase()}`, `Bearer\t${pat}`]) {
      expect(bearerToken(header), String(header)).toBeUndefined();
    }
  });

  it('throttle lastUsedAt writes to one a minute per token', () => {
    const t = new UsageThrottle(60_000, 3);
    expect(t.due('a', 0)).toBe(true);
    expect(t.due('a', 59_999)).toBe(false);
    expect(t.due('b', 59_999)).toBe(true);
    expect(t.due('a', 60_000)).toBe(true);
    expect(t.due('a', 60_001)).toBe(false);
    // Full: entries older than the interval are dropped, recent ones kept.
    expect(t.due('c', 60_002)).toBe(true);
    expect(t.due('d', 119_999)).toBe(true);
    expect(t.due('a', 119_999), 'still throttled after the cleanup').toBe(false);
  });
});

describe('MCP config (SPEC §14 M1, M2)', () => {
  const base = { DATABASE_URL: 'postgresql://x', JWT_SECRET: 'x'.repeat(32) };
  it('needs an https APP_URL (or localhost) when MCP is on', () => {
    expect(loadConfig(base).MCP_ENABLED).toBe(false);
    expect(() => loadConfig({ ...base, MCP_ENABLED: 'true', APP_URL: 'http://project.example.com' })).toThrow(/APP_URL: MCP_ENABLED needs an https/);
    expect(loadConfig({ ...base, MCP_ENABLED: 'true', APP_URL: 'https://project.example.com/' }).APP_URL).toBe('https://project.example.com');
    for (const local of ['http://localhost:5173', 'http://127.0.0.1:8080', 'http://[::1]:3000']) {
      expect(loadConfig({ ...base, MCP_ENABLED: 'true', APP_URL: local }).MCP_ENABLED, local).toBe(true);
    }
    expect(loadConfig({ ...base, APP_URL: 'http://project.example.com' }).APP_URL, 'fine with MCP off').toBe('http://project.example.com');
  });

  it('trusts one proxy hop by default', () => {
    expect(loadConfig(base).TRUST_PROXY_HOPS).toBe(1);
    expect(loadConfig({ ...base, TRUST_PROXY_HOPS: '0' }).TRUST_PROXY_HOPS).toBe(0);
    expect(() => loadConfig({ ...base, TRUST_PROXY_HOPS: '-1' })).toThrow(/TRUST_PROXY_HOPS/);
  });
});
