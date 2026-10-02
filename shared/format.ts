// Display formatting shared by server messages and the UI.
// Calendar dates are formatted in UTC so they never shift a day.

import { diffDays, type ISODate } from './dates';

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' });
const F = {
  short: fmt({ month: 'short', day: 'numeric' }),
  shortYear: fmt({ month: 'short', day: 'numeric', year: 'numeric' }),
  weekday: fmt({ weekday: 'short', month: 'short', day: 'numeric' }),
  long: fmt({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
  dow: fmt({ weekday: 'short' }),
  month: fmt({ month: 'long', year: 'numeric' }),
};

const d = (iso: ISODate) => new Date(iso + 'T00:00:00Z');

/** "Oct 7" (adds the year when it differs from `today`'s) */
export function fmtDate(iso: ISODate | null | undefined, today?: ISODate): string {
  if (!iso) return '—';
  if (today && iso.slice(0, 4) !== today.slice(0, 4)) return F.shortYear.format(d(iso));
  return F.short.format(d(iso));
}

export const fmtDateYear = (iso: ISODate) => F.shortYear.format(d(iso));
export const fmtWeekday = (iso: ISODate) => F.weekday.format(d(iso));
export const fmtLong = (iso: ISODate) => F.long.format(d(iso));
export const fmtDow = (iso: ISODate) => F.dow.format(d(iso));
export const fmtMonth = (iso: ISODate) => F.month.format(d(iso));

/** "Oct 12–13, 2026" / "Oct 30 – Nov 2, 2026" / "Oct 13, 2026" */
export function fmtRange(start: ISODate, end?: ISODate | null): string {
  if (!end || end === start) return F.shortYear.format(d(start));
  const [sy, sm] = [start.slice(0, 4), start.slice(5, 7)];
  const [ey, em] = [end.slice(0, 4), end.slice(5, 7)];
  if (sy === ey && sm === em) return `${F.short.format(d(start))}–${Number(end.slice(8, 10))}, ${sy}`;
  if (sy === ey) return `${F.short.format(d(start))} – ${F.short.format(d(end))}, ${sy}`;
  return `${F.shortYear.format(d(start))} – ${F.shortYear.format(d(end))}`;
}

/** Relative day text: "today", "tomorrow", "in 3 days", "2 days ago" */
export function relDay(iso: ISODate, today: ISODate): string {
  const n = diffDays(iso, today);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}

/** Timestamp in the organisation's timezone: "Oct 3, 4:12 PM" */
export function fmtStamp(isoTs: string | null | undefined, timeZone: string): string {
  if (!isoTs) return '—';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone }).format(new Date(isoTs));
}

/** How long ago: "just now", "12 min ago", "3 h ago", "yesterday", "4 days ago" */
export function fmtAgo(isoTs: string, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - Date.parse(isoTs)) / 60000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

export function fmtTimeZoneAbbr(timeZone: string, now = new Date()): string {
  const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(now).find((p) => p.type === 'timeZoneName');
  return part?.value ?? timeZone;
}

export function fmtCutoff(cutoff: string): string {
  const [h, m] = cutoff.split(':').map(Number);
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * The workspace's daily cutoff as a time in someone else's zone, on a given day:
 * 11:59 PM in New York is "9:29 AM (next day)" in Bengaluru. Null when it's the same.
 */
export function cutoffIn(cutoff: string, orgTz: string, tz: string, day: string): string | null {
  if (orgTz === tz) return null;
  try {
    const [h, m] = cutoff.split(':').map(Number);
    const [y, mo, d] = day.split('-').map(Number);
    // the instant when the org's wall clock reads `day cutoff` (two passes settle DST edges)
    const wall = Date.UTC(y, mo - 1, d, h, m);
    const offset = (at: number) => {
      const p = new Intl.DateTimeFormat('en-CA', { timeZone: orgTz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at));
      const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
      return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute')) - at;
    };
    let at = wall - offset(wall);
    at = wall - offset(at);
    const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(at));
    const theirDay = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
    const shift = theirDay > day ? ' (next day)' : theirDay < day ? ' (day before)' : '';
    return `${time}${shift}`;
  } catch {
    return null;
  }
}

export const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
