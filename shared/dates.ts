// Calendar-date arithmetic for shoots and deadlines.
//
// Shoot dates and deadlines are local calendar dates ("2026-10-12"), never
// instants, so no timezone conversion can move them to another day. All maths
// here runs on UTC midnights purely as a vehicle for day counting.
//
// "Now" is the only thing that needs a timezone: the organisation's timezone
// and daily cutoff decide what "today" is and when a deadline has passed.

export type ISODate = string; // YYYY-MM-DD

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export function isISODate(value: unknown): value is ISODate {
  if (typeof value !== 'string') return false;
  const m = ISO_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function toUTC(date: ISODate): Date {
  const m = ISO_RE.exec(date);
  if (!m) throw new Error(`Invalid date: ${date}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

export function fromUTC(dt: Date): ISODate {
  return dt.toISOString().slice(0, 10);
}

export function makeDate(y: number, month: number, day: number): ISODate {
  return fromUTC(new Date(Date.UTC(y, month - 1, day)));
}

export function addDays(date: ISODate, n: number): ISODate {
  return fromUTC(new Date(toUTC(date).getTime() + n * DAY_MS));
}

/** a − b in whole days. */
export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round((toUTC(a).getTime() - toUTC(b).getTime()) / DAY_MS);
}

/** 0 = Sunday … 6 = Saturday */
export function weekday(date: ISODate): number {
  return toUTC(date).getUTCDay();
}

export function maxDate(a: ISODate, b: ISODate): ISODate {
  return a > b ? a : b;
}

export function minDate(a: ISODate, b: ISODate): ISODate {
  return a < b ? a : b;
}

/** Monday of the week containing `date`. */
export function startOfWeek(date: ISODate): ISODate {
  const wd = weekday(date);
  return addDays(date, wd === 0 ? -6 : 1 - wd);
}

export function startOfMonth(date: ISODate): ISODate {
  return date.slice(0, 8) + '01';
}

export function addMonths(date: ISODate, n: number): ISODate {
  const d = toUTC(date);
  return fromUTC(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)));
}

export function eachDay(from: ISODate, to: ISODate): ISODate[] {
  const out: ISODate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// ── deadline rules ───────────────────────────────────────────────────────

export type DayMode = 'calendar' | 'business';

export interface DeadlineRules {
  draftOffsetDays: number;
  finalOffsetDays: number;
  dayMode: DayMode;
  /** Working week used by business-day mode and capacity estimates. 0 = Sunday. */
  workingDays: number[];
}

export const DEFAULT_RULES: DeadlineRules = {
  draftOffsetDays: 5,
  finalOffsetDays: 3,
  dayMode: 'calendar',
  workingDays: [1, 2, 3, 4, 5],
};

/** Count back `n` working days from `date` (exclusive of `date`). */
export function subtractWorkingDays(date: ISODate, n: number, workingDays: number[]): ISODate {
  if (!workingDays.length) throw new Error('The working week has no days');
  let d = date;
  let left = n;
  while (left > 0) {
    d = addDays(d, -1);
    if (workingDays.includes(weekday(d))) left--;
  }
  return d;
}

export function offsetBefore(anchor: ISODate, days: number, rules: Pick<DeadlineRules, 'dayMode' | 'workingDays'>): ISODate {
  return rules.dayMode === 'business'
    ? subtractWorkingDays(anchor, days, rules.workingDays)
    : addDays(anchor, -days);
}

export interface ComputedDeadlines {
  anchor: ISODate;
  draftDue: ISODate;
  finalDue: ISODate;
  draftRule: string;
  finalRule: string;
}

/**
 * Deadlines are anchored to the first shoot day. A shoot on October 12–13
 * anchors to October 12: drafts October 7, final delivery October 9.
 */
export function computeDeadlines(shootStart: ISODate, rules: DeadlineRules): ComputedDeadlines {
  return {
    anchor: shootStart,
    draftDue: offsetBefore(shootStart, rules.draftOffsetDays, rules),
    finalDue: offsetBefore(shootStart, rules.finalOffsetDays, rules),
    draftRule: ruleText(rules.draftOffsetDays, rules.dayMode),
    finalRule: ruleText(rules.finalOffsetDays, rules.dayMode),
  };
}

/**
 * Drafts due when only the final delivery date is known: the same gap the
 * shoot rules leave between them. With drafts 5 days and final 3 days before
 * a shoot, drafts are due 2 days before final delivery (working days in
 * business-day mode).
 */
export function draftFromFinal(finalDue: ISODate, rules: DeadlineRules): { date: ISODate; rule: string } {
  const gap = Math.max(0, rules.draftOffsetDays - rules.finalOffsetDays);
  const unit = rules.dayMode === 'business' ? 'working day' : 'calendar day';
  return {
    date: gap ? offsetBefore(finalDue, gap, rules) : finalDue,
    rule: gap ? `${gap} ${unit}${gap === 1 ? '' : 's'} before final delivery` : 'same day as final delivery',
  };
}

export function ruleText(days: number, mode: DayMode): string {
  const unit = mode === 'business' ? 'working day' : 'calendar day';
  return `${days} ${unit}${days === 1 ? '' : 's'} before shoot starts`;
}

// ── "now" in the organisation's timezone ─────────────────────────────────

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function nowInZone(tz: string, now: Date = new Date()): { date: ISODate; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

export function parseCutoff(cutoff: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(cutoff);
  if (!m) throw new Error(`Invalid cutoff: ${cutoff}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * A snapshot of "now" for deadline checks. A deadline on day D is due until
 * the cutoff time on D in the organisation's timezone, and overdue after it.
 */
export interface Clock {
  today: ISODate;
  afterCutoff: boolean;
  timezone: string;
  cutoff: string;
}

export function makeClock(timezone: string, cutoff: string, now: Date = new Date()): Clock {
  const { date, minutes } = nowInZone(timezone, now);
  return { today: date, afterCutoff: minutes > parseCutoff(cutoff), timezone, cutoff };
}

export interface DueState {
  overdue: boolean;
  dueToday: boolean;
  /** days from today until the deadline (negative when past) */
  daysUntil: number;
  daysOverdue: number;
}

export function dueState(date: ISODate, clock: Clock): DueState {
  const daysUntil = diffDays(date, clock.today);
  const overdue = daysUntil < 0 || (daysUntil === 0 && clock.afterCutoff);
  return {
    overdue,
    dueToday: daysUntil === 0 && !clock.afterCutoff,
    daysUntil,
    daysOverdue: overdue ? Math.max(0, -daysUntil) : 0,
  };
}

/** "2 days overdue", "Overdue today", "Due today", "Due tomorrow", "Due in 5 days" */
export function describeDue(state: DueState): string {
  if (state.overdue) {
    if (state.daysOverdue === 0) return 'Overdue today';
    return `${state.daysOverdue} day${state.daysOverdue === 1 ? '' : 's'} overdue`;
  }
  if (state.dueToday) return 'Due today';
  if (state.daysUntil === 1) return 'Due tomorrow';
  return `Due in ${state.daysUntil} days`;
}

// ── capacity estimates ───────────────────────────────────────────────────

/** Working days in the inclusive range [from, to]. */
export function workingDaysBetween(from: ISODate, to: ISODate, workingDays: number[]): number {
  if (to < from) return 0;
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (workingDays.includes(weekday(d))) n++;
  return n;
}

/**
 * An estimated writing start: enough working days, ending on the draft
 * deadline, to write `scripts` at `perDay` scripts per working day.
 * This is only an estimate from configured capacity.
 */
export function suggestStart(draftDue: ISODate, scripts: number, perDay: number, workingDays: number[]): ISODate | null {
  if (!(perDay > 0) || scripts <= 0 || !workingDays.length) return null;
  let needed = Math.ceil(scripts / perDay);
  let d = draftDue;
  // walk back to the last working day on or before the deadline
  while (!workingDays.includes(weekday(d))) d = addDays(d, -1);
  needed--;
  while (needed > 0) {
    d = addDays(d, -1);
    if (workingDays.includes(weekday(d))) needed--;
  }
  return d;
}
