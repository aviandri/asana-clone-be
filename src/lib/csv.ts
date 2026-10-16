/**
 * CSV writing per RFC 4180 (CRLF lines, quotes doubled inside quoted fields), with protection
 * against spreadsheet formula injection (OWASP). Cells starting with = + - @ TAB or CR get a
 * leading apostrophe, so Excel/Sheets treat them as text.
 */

/** UTF-8 byte order mark, so Excel opens non-ASCII names (e.g. Indonesian) correctly. */
export const UTF8_BOM = '﻿';

const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return NEEDS_QUOTES.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: (string | number | boolean | null | undefined)[][]): string {
  const lines = [header, ...rows].map((row) => row.map(csvCell).join(','));
  return `${UTF8_BOM}${lines.join('\r\n')}\r\n`;
}

/** ASCII file-name slug: "Kampanye Natal Q4!" → "kampanye-natal-q4". */
export function slugify(name: string, fallback = 'project'): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || fallback;
}
