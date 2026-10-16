import { describe, expect, it } from 'vitest';
import { csvCell, slugify, toCsv, UTF8_BOM } from '../../src/lib/csv.js';
import { weeklyTrend } from '../../src/routes/reports.js';
import { daysBetweenInclusive, zonedDate, zonedDayStart } from '../../src/lib/time.js';

describe('csvCell (RFC 4180 + formula-injection escaping)', () => {
  it('leaves plain values alone and blanks null', () => {
    expect(csvCell('Write copy')).toBe('Write copy');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(false)).toBe('false');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('quotes commas, quotes, CR and LF, doubling inner quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell('x\r\ny')).toBe('"x\r\ny"');
  });

  it('neutralises formula starters = + - @ TAB CR with a leading apostrophe', () => {
    expect(csvCell('=HYPERLINK("http://evil","x")')).toBe(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-5 items')).toBe("'-5 items");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\tcmd')).toBe("'\tcmd");
    expect(csvCell('\rcmd')).toBe(`"'\rcmd"`);
    expect(csvCell('a=b')).toBe('a=b'); // only a leading starter matters
  });

  it('writes a BOM, a header and CRLF-terminated lines', () => {
    expect(toCsv(['a', 'b'], [['1', 'x,y'], [null, '=1']])).toBe(`${UTF8_BOM}a,b\r\n1,"x,y"\r\n,'=1\r\n`);
  });
});

describe('slugify', () => {
  it('makes ASCII file-name slugs', () => {
    expect(slugify('Website Redesign')).toBe('website-redesign');
    expect(slugify('  Kampanye Natal — Q4!! ')).toBe('kampanye-natal-q4');
    expect(slugify('Café Déjà Vu')).toBe('cafe-deja-vu');
    expect(slugify('***')).toBe('project');
    expect(slugify('x'.repeat(100))).toHaveLength(60);
  });
});

describe('zonedDayStart', () => {
  it('finds the UTC instant a local day starts', () => {
    expect(zonedDayStart('2026-10-12', 'Asia/Jakarta').toISOString()).toBe('2026-10-11T17:00:00.000Z');
    expect(zonedDayStart('2026-10-12', 'UTC').toISOString()).toBe('2026-10-12T00:00:00.000Z');
  });

  it('handles DST days', () => {
    // New York: DST starts 2026-03-08 (EST → EDT), ends 2026-11-01.
    expect(zonedDayStart('2026-03-08', 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(zonedDayStart('2026-03-09', 'America/New_York').toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(zonedDayStart('2026-11-02', 'America/New_York').toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(zonedDate('America/New_York', zonedDayStart('2026-11-01', 'America/New_York'))).toBe('2026-11-01');
  });

  it('counts inclusive day spans', () => {
    expect(daysBetweenInclusive('2026-10-12', '2026-10-18')).toBe(7);
    expect(daysBetweenInclusive('2026-10-12', '2026-10-12')).toBe(1);
    expect(daysBetweenInclusive('2026-10-12', '2026-10-11')).toBe(0);
  });
});

describe('weeklyTrend', () => {
  it('buckets created/completed per Monday week and counts open tasks at each week end', () => {
    const tasks = [
      { created: '2026-09-30', completedOn: '2026-10-06' }, // created wk 09-28, done wk 10-05
      { created: '2026-10-05', completedOn: null }, // wk 10-05, still open
      { created: '2026-10-11', completedOn: '2026-10-12' }, // Sunday of wk 10-05, done Monday wk 10-12
      { created: '2026-10-14', completedOn: '2026-10-14' }, // wk 10-12
    ];
    expect(weeklyTrend(tasks, '2026-10-12', 3)).toEqual([
      { weekStart: '2026-09-28', created: 1, completed: 0, open: 1 },
      { weekStart: '2026-10-05', created: 2, completed: 1, open: 2 },
      { weekStart: '2026-10-12', created: 1, completed: 2, open: 1 },
    ]);
  });
});
