// Reading a calendar feed (iCalendar / .ics), such as a Google Calendar's
// "secret address in iCal format". Handles all-day and timed events, time
// zones (TZID), recurring events (RRULE with EXDATE and moved/cancelled
// single occurrences) and cancelled events. Only occurrences inside the
// requested window are returned, so a long-running weekly call doesn't
// produce thousands of rows.

export interface FeedEvent {
  uid: string;
  title: string;
  location: string | null;
  description: string | null;
  allDay: boolean;
  /** UTC instants; for all-day events, midnight UTC of the first day and of the day after the last */
  start: Date;
  end: Date;
  /** all-day events: the calendar dates (end inclusive) */
  startDate: string | null;
  endDate: string | null;
}

interface Prop { name: string; params: Record<string, string>; value: string }
interface Raw { props: Prop[] }

// Outlook and Exchange feeds use Windows zone names
const WINDOWS_ZONES: Record<string, string> = {
  'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago', 'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles', 'GMT Standard Time': 'Europe/London', 'W. Europe Standard Time': 'Europe/Berlin',
  'Israel Standard Time': 'Asia/Jerusalem', 'India Standard Time': 'Asia/Kolkata', 'AUS Eastern Standard Time': 'Australia/Sydney', UTC: 'UTC',
};

const validZone = (tz: string) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

function unfold(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function parseLine(line: string): Prop | null {
  // NAME;PARAM=VALUE;PARAM="VALUE":value  (a colon inside quotes isn't the separator)
  let i = 0; let quoted = false;
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ':' && !quoted) break;
  }
  if (i >= line.length) return null;
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const parts = head.split(';');
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: parts[0].toUpperCase(), params, value };
}

const unescape = (v: string) => v.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\').trim();

/** Offset (ms) of a zone from UTC at an instant. */
function zoneOffset(tz: string, at: number): number {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at));
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') === 24 ? 0 : g('hour'), g('minute'), g('second')) - at;
}

/** The instant when a zone's wall clock shows the given time. */
function wallToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const wall = Date.UTC(y, mo, d, h, mi, s);
  if (tz === 'UTC') return wall;
  let at = wall - zoneOffset(tz, wall);
  at = wall - zoneOffset(tz, at);
  return at;
}

interface When { allDay: boolean; utc: number; tz: string; parts: [number, number, number, number, number, number] }

function parseWhen(p: Prop | undefined, fallbackTz: string): When | null {
  if (!p) return null;
  const v = p.value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  if (!m[4] || p.params.VALUE === 'DATE') return { allDay: true, utc: Date.UTC(y, mo, d), tz: 'UTC', parts: [y, mo, d, 0, 0, 0] };
  const [h, mi, s] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  if (m[7]) return { allDay: false, utc: Date.UTC(y, mo, d, h, mi, s), tz: 'UTC', parts: [y, mo, d, h, mi, s] };
  const raw = p.params.TZID ?? '';
  const tz = validZone(raw) ? raw : WINDOWS_ZONES[raw] ?? fallbackTz;
  return { allDay: false, utc: wallToUtc(y, mo, d, h, mi, s, tz), tz, parts: [y, mo, d, h, mi, s] };
}

function parseDuration(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const ms = ((Number(m[2] ?? 0) * 7 + Number(m[3] ?? 0)) * 86400 + Number(m[4] ?? 0) * 3600 + Number(m[5] ?? 0) * 60 + Number(m[6] ?? 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const MAX_OCCURRENCES = 2000;

/** Occurrence starts (as wall-clock parts in the event's zone) of a recurring event, up to `until`. */
function expand(start: When, rule: string, untilMs: number): When[] {
  const r: Record<string, string> = {};
  for (const part of rule.split(';')) { const [k, v] = part.split('='); if (k && v) r[k.toUpperCase()] = v; }
  const freq = r.FREQ;
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return [start];
  const interval = Math.max(1, Number(r.INTERVAL ?? 1) || 1);
  const count = r.COUNT ? Number(r.COUNT) : Infinity;
  const until = r.UNTIL ? parseWhen({ name: 'UNTIL', params: {}, value: r.UNTIL }, start.tz) : null;
  const stop = Math.min(untilMs, until ? until.utc + (until.allDay ? 86400000 - 1 : 0) : Infinity);
  const byDay = (r.BYDAY ?? '').split(',').filter(Boolean).map((x) => { const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(x); return m ? { n: m[1] ? Number(m[1]) : null, wd: DAYS.indexOf(m[2]) } : null; }).filter((x): x is { n: number | null; wd: number } => !!x && x.wd >= 0);
  const byMonthDay = (r.BYMONTHDAY ?? '').split(',').filter(Boolean).map(Number).filter((n) => n && Math.abs(n) <= 31);
  const [y0, mo0, d0, h, mi, s] = start.parts;
  const make = (y: number, mo: number, d: number): When => {
    const utc = start.allDay ? Date.UTC(y, mo, d) : wallToUtc(y, mo, d, h, mi, s, start.tz);
    return { allDay: start.allDay, utc, tz: start.tz, parts: [y, mo, d, h, mi, s] };
  };
  const out: When[] = [];
  let made = 0;
  const push = (w: When) => {
    if (w.utc < start.utc) return true;
    if (w.utc > stop || made >= count || out.length >= MAX_OCCURRENCES) return false;
    made++; out.push(w); return true;
  };
  const day = (y: number, mo: number, d: number) => new Date(Date.UTC(y, mo, d));
  for (let step = 0; step < 5000; step++) {
    if (freq === 'DAILY') {
      const dt = day(y0, mo0, d0 + step * interval);
      if (byDay.length && !byDay.some((b) => b.wd === dt.getUTCDay())) { if (dt.getTime() > stop) break; continue; }
      if (!push(make(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()))) break;
    } else if (freq === 'WEEKLY') {
      // the week (starting Monday, as Google does) that holds the first occurrence, moved on by the interval
      const first = day(y0, mo0, d0);
      const monday = day(y0, mo0, d0 - ((first.getUTCDay() + 6) % 7) + step * 7 * interval);
      const wds = byDay.length ? byDay.map((b) => b.wd) : [first.getUTCDay()];
      const dates = wds.map((wd) => day(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + ((wd + 6) % 7))).sort((a, b) => a.getTime() - b.getTime());
      let go = true;
      for (const dt of dates) if (!(go = push(make(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate())))) break;
      if (!go) break;
    } else if (freq === 'MONTHLY') {
      const base = day(y0, mo0 + step * interval, 1);
      const y = base.getUTCFullYear(); const mo = base.getUTCMonth();
      const last = day(y, mo + 1, 0).getUTCDate();
      let ds: number[] = [];
      if (byDay.length) {
        for (const b of byDay) {
          const all: number[] = [];
          for (let d = 1; d <= last; d++) if (day(y, mo, d).getUTCDay() === b.wd) all.push(d);
          if (b.n == null) ds.push(...all);
          else { const pick = b.n > 0 ? all[b.n - 1] : all[all.length + b.n]; if (pick) ds.push(pick); }
        }
      } else if (byMonthDay.length) ds = byMonthDay.map((n) => (n > 0 ? n : last + n + 1)).filter((n) => n >= 1 && n <= last);
      else if (d0 <= last) ds = [d0];
      let go = true;
      for (const d of [...new Set(ds)].sort((a, b) => a - b)) if (!(go = push(make(y, mo, d)))) break;
      if (!go) break;
      if (day(y, mo, 1).getTime() > stop) break;
    } else {
      const y = y0 + step * interval;
      const last = day(y, mo0 + 1, 0).getUTCDate();
      if (d0 <= last && !push(make(y, mo0, d0))) break;
      if (day(y, 0, 1).getTime() > stop) break;
    }
  }
  return out;
}

/**
 * Parse a feed and return the occurrences that overlap [from, to].
 * `fallbackTz` is used for "floating" times that name no zone.
 */
export function parseIcs(text: string, from: Date, to: Date, fallbackTz = 'UTC'): FeedEvent[] {
  const lines = unfold(text);
  if (!lines.some((l) => l.trim().toUpperCase() === 'BEGIN:VCALENDAR')) throw new Error('That link didn’t return a calendar. Use the “Secret address in iCal format”.');
  const raws: Raw[] = [];
  let cur: Raw | null = null;
  let depth = 0;
  for (const line of lines) {
    const up = line.trim().toUpperCase();
    if (up === 'BEGIN:VEVENT') { cur = { props: [] }; depth = 0; continue; }
    if (!cur) continue;
    if (up.startsWith('BEGIN:')) { depth++; continue; } // VALARM and friends
    if (up.startsWith('END:') && depth > 0) { depth--; continue; }
    if (up === 'END:VEVENT') { raws.push(cur); cur = null; continue; }
    if (depth > 0) continue;
    const p = parseLine(line);
    if (p) cur.props.push(p);
  }

  const get = (r: Raw, n: string) => r.props.find((p) => p.name === n);
  const all = (r: Raw, n: string) => r.props.filter((p) => p.name === n);
  const fromMs = from.getTime(); const toMs = to.getTime();

  // single occurrences that were moved or cancelled, by uid and original start
  const overrides = new Map<string, Map<number, Raw>>();
  for (const r of raws) {
    const rid = parseWhen(get(r, 'RECURRENCE-ID'), fallbackTz);
    const uid = get(r, 'UID')?.value;
    if (rid && uid) {
      const m = overrides.get(uid) ?? new Map<number, Raw>();
      m.set(rid.utc, r); overrides.set(uid, m);
    }
  }

  const out: FeedEvent[] = [];
  const emit = (r: Raw, start: When, lengthMs: number) => {
    const end = start.utc + lengthMs;
    if (end < fromMs || start.utc > toMs) return;
    const uid = get(r, 'UID')?.value ?? `${start.utc}`;
    const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    out.push({
      uid: `${uid}@${start.utc}`,
      title: unescape(get(r, 'SUMMARY')?.value ?? '') || '(No title)',
      location: unescape(get(r, 'LOCATION')?.value ?? '') || null,
      description: unescape(get(r, 'DESCRIPTION')?.value ?? '').slice(0, 4000) || null,
      allDay: start.allDay,
      start: new Date(start.utc), end: new Date(end),
      startDate: start.allDay ? iso(start.utc) : null,
      endDate: start.allDay ? iso(Math.max(start.utc, end - 86400000)) : null,
    });
  };

  for (const r of raws) {
    if (get(r, 'RECURRENCE-ID')) continue;
    if ((get(r, 'STATUS')?.value ?? '').toUpperCase() === 'CANCELLED') continue;
    const start = parseWhen(get(r, 'DTSTART'), fallbackTz);
    if (!start) continue;
    const endW = parseWhen(get(r, 'DTEND'), fallbackTz);
    const length = endW ? Math.max(0, endW.utc - start.utc) : parseDuration(get(r, 'DURATION')?.value) ?? (start.allDay ? 86400000 : 0);
    const rule = get(r, 'RRULE')?.value;
    const uid = get(r, 'UID')?.value ?? '';
    if (!rule) { emit(r, start, length); continue; }
    const ex = new Set<number>();
    for (const p of all(r, 'EXDATE')) for (const v of p.value.split(',')) { const w = parseWhen({ ...p, value: v }, fallbackTz); if (w) ex.add(w.utc); }
    const moved = overrides.get(uid);
    for (const occ of expand(start, rule, toMs)) {
      if (ex.has(occ.utc)) continue;
      const o = moved?.get(occ.utc);
      if (o) continue; // emitted on its own below
      emit(r, occ, length);
    }
  }
  // the moved single occurrences themselves
  for (const m of overrides.values()) for (const r of m.values()) {
    if ((get(r, 'STATUS')?.value ?? '').toUpperCase() === 'CANCELLED') continue;
    const start = parseWhen(get(r, 'DTSTART'), fallbackTz);
    if (!start) continue;
    const endW = parseWhen(get(r, 'DTEND'), fallbackTz);
    emit(r, start, endW ? Math.max(0, endW.utc - start.utc) : start.allDay ? 86400000 : 0);
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}
