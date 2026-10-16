/** Calendar helpers that work in an IANA time zone (APP_TIMEZONE), with no dependencies. */

/** `YYYY-MM-DD` of the calendar day `at` falls on in `tz`. */
export function zonedDate(tz: string, at: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** Adds days to a `YYYY-MM-DD` date (calendar arithmetic, no time zone involved). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Monday of the week containing `date` (`YYYY-MM-DD`). */
export function mondayOf(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
}

// --- goal time periods (SPEC §10) --------------------------------------------

export const TIME_PERIOD = /^\d{4}(-(H[12]|Q[1-4]))?$/;

/** The year, half and quarter that contain today in `tz`, e.g. ['2026', '2026-H2', '2026-Q4']. */
export function currentPeriods(tz: string, at: Date = new Date()): string[] {
  const [year, month] = zonedDate(tz, at).split('-').map(Number) as [number, number];
  return [`${year}`, `${year}-H${month <= 6 ? 1 : 2}`, `${year}-Q${Math.ceil(month / 3)}`];
}

/** Sort key: newest year first; within a year by start month, longer spans first (Y, H1, Q1, Q2, H2, Q3, Q4). */
function periodKey(p: string): [number, number, number] {
  const [y, part] = p.split('-');
  const year = Number(y);
  if (!part) return [-year, 1, -12];
  const n = Number(part.slice(1));
  const startMonth = part[0] === 'H' ? (n - 1) * 6 + 1 : (n - 1) * 3 + 1;
  return [-year, startMonth, part[0] === 'H' ? -6 : -3];
}

export function sortPeriods(periods: Iterable<string>): string[] {
  return [...new Set(periods)].sort((a, b) => {
    const ka = periodKey(a);
    const kb = periodKey(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
  });
}

// --- zone ↔ UTC instants -----------------------------------------------------

/** Offset of `tz` from UTC at instant `at`, in ms (e.g. +7h for Asia/Jakarta). */
function zoneOffsetMs(tz: string, at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** The UTC instant at which calendar day `date` (`YYYY-MM-DD`) starts in `tz`. DST-safe. */
export function zonedDayStart(date: string, tz: string): Date {
  const naive = Date.parse(`${date}T00:00:00Z`);
  let instant = naive - zoneOffsetMs(tz, naive);
  // A DST change between the guess and the answer shifts the offset; one correction settles it.
  const corrected = naive - zoneOffsetMs(tz, instant);
  if (corrected !== instant) instant = corrected;
  return new Date(instant);
}

/** Inclusive day count from `from` to `to` (`YYYY-MM-DD`). */
export function daysBetweenInclusive(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}
