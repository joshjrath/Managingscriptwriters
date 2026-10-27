import { describe, expect, it } from 'vitest';
import {
  computeDeadlines, DEFAULT_RULES, describeDue, dueState, isISODate, makeClock, nowInZone, subtractWorkingDays, suggestStart, workingDaysBetween,
} from '../shared/dates';
import { fmtRange } from '../shared/format';

const rules = DEFAULT_RULES;

describe('deadline calculation (calendar days)', () => {
  it('a two-day shoot on Oct 12–13, 2026 anchors to the first day: drafts Oct 7, final Oct 9', () => {
    const d = computeDeadlines('2026-10-12', rules);
    expect(d.draftDue).toBe('2026-10-07');
    expect(d.finalDue).toBe('2026-10-09');
    expect(d.draftRule).toBe('5 calendar days before shoot starts');
    expect(d.finalRule).toBe('3 calendar days before shoot starts');
  });

  it('a one-day shoot on Oct 13, 2026: drafts Oct 8, final Oct 10', () => {
    const d = computeDeadlines('2026-10-13', rules);
    expect(d.draftDue).toBe('2026-10-08');
    expect(d.finalDue).toBe('2026-10-10');
  });

  it('crosses month boundaries', () => {
    expect(computeDeadlines('2026-11-02', rules)).toMatchObject({ draftDue: '2026-10-28', finalDue: '2026-10-30' });
    expect(computeDeadlines('2026-03-01', rules)).toMatchObject({ draftDue: '2026-02-24', finalDue: '2026-02-26' });
  });

  it('crosses year boundaries', () => {
    expect(computeDeadlines('2027-01-02', rules)).toMatchObject({ draftDue: '2026-12-28', finalDue: '2026-12-30' });
    expect(computeDeadlines('2027-01-04', rules)).toMatchObject({ draftDue: '2026-12-30', finalDue: '2027-01-01' });
  });

  it('handles leap days', () => {
    expect(computeDeadlines('2028-03-03', rules)).toMatchObject({ draftDue: '2028-02-27', finalDue: '2028-02-29' });
  });

  it('does not shift weekend deadlines in calendar mode', () => {
    // Oct 13 2026 is a Tuesday; final delivery lands on Saturday Oct 10 and stays there
    expect(computeDeadlines('2026-10-13', rules).finalDue).toBe('2026-10-10');
  });

  it('is unaffected by daylight-saving changes (US clocks change on Nov 1, 2026)', () => {
    expect(computeDeadlines('2026-11-04', rules)).toMatchObject({ draftDue: '2026-10-30', finalDue: '2026-11-01' });
    expect(computeDeadlines('2027-03-16', rules)).toMatchObject({ draftDue: '2027-03-11', finalDue: '2027-03-13' });
  });

  it('respects configured offsets', () => {
    expect(computeDeadlines('2026-10-12', { ...rules, draftOffsetDays: 7, finalOffsetDays: 2 })).toMatchObject({ draftDue: '2026-10-05', finalDue: '2026-10-10' });
  });
});

describe('business-day mode', () => {
  const biz = { ...rules, dayMode: 'business' as const };
  it('counts only the working week and lands on working days', () => {
    // Monday Oct 12: 5 working days back = Mon Oct 5, 3 back = Wed Oct 7
    const d = computeDeadlines('2026-10-12', biz);
    expect(d).toMatchObject({ draftDue: '2026-10-05', finalDue: '2026-10-07' });
    expect(d.draftRule).toBe('5 working days before shoot starts');
  });
  it('uses a custom working week', () => {
    // Mon–Sat week
    expect(subtractWorkingDays('2026-10-12', 1, [1, 2, 3, 4, 5, 6])).toBe('2026-10-10');
    expect(subtractWorkingDays('2026-10-12', 1, [1, 2, 3, 4, 5])).toBe('2026-10-09');
  });
  it('counts working days in a range', () => {
    expect(workingDaysBetween('2026-09-28', '2026-10-04', [1, 2, 3, 4, 5])).toBe(5);
  });
});

describe('timezone and cutoff', () => {
  it('works out today in the organisation timezone, not UTC', () => {
    const now = new Date('2026-09-28T03:30:00Z'); // 11:30 PM Sep 27 in New York
    expect(nowInZone('America/New_York', now).date).toBe('2026-09-27');
    expect(nowInZone('Asia/Tokyo', now).date).toBe('2026-09-28');
    expect(nowInZone('UTC', now).date).toBe('2026-09-28');
  });

  it('a deadline is due until the cutoff, then overdue', () => {
    const before = makeClock('America/New_York', '17:00', new Date('2026-10-09T20:59:00Z')); // 4:59 PM EDT
    const after = makeClock('America/New_York', '17:00', new Date('2026-10-09T21:01:00Z')); // 5:01 PM EDT
    expect(dueState('2026-10-09', before)).toMatchObject({ dueToday: true, overdue: false });
    expect(dueState('2026-10-09', after)).toMatchObject({ dueToday: false, overdue: true, daysOverdue: 0 });
    expect(describeDue(dueState('2026-10-09', after))).toBe('Overdue today');
  });

  it('says exactly how late something is', () => {
    const clock = makeClock('America/New_York', '23:59', new Date('2026-10-11T16:00:00Z'));
    expect(describeDue(dueState('2026-10-09', clock))).toBe('2 days overdue');
    expect(describeDue(dueState('2026-10-12', clock))).toBe('Due tomorrow');
    expect(describeDue(dueState('2026-10-16', clock))).toBe('Due in 5 days');
  });
});

describe('helpers', () => {
  it('validates real calendar dates', () => {
    expect(isISODate('2026-02-29')).toBe(false);
    expect(isISODate('2028-02-29')).toBe(true);
    expect(isISODate('2026-13-01')).toBe(false);
  });
  it('formats shoot ranges', () => {
    expect(fmtRange('2026-10-12', '2026-10-13')).toBe('Oct 12–13, 2026');
    expect(fmtRange('2026-10-13', null)).toBe('Oct 13, 2026');
    expect(fmtRange('2026-12-30', '2027-01-02')).toBe('Dec 30, 2026 – Jan 2, 2027');
  });
  it('estimates a start date from capacity, ending on the draft deadline', () => {
    // 10 scripts at 3/day = 4 working days ending Wed Oct 7 → Fri Oct 2 (skips the weekend)
    expect(suggestStart('2026-10-07', 10, 3, [1, 2, 3, 4, 5])).toBe('2026-10-02');
    expect(suggestStart('2026-10-07', 10, 0, [1, 2, 3, 4, 5])).toBeNull();
  });
});

describe('drafts from a final delivery date', () => {
  it('keeps the same gap as the shoot rules', async () => {
    const { draftFromFinal, DEFAULT_RULES } = await import('../shared/dates');
    // drafts 5 days and final 3 days before a shoot → drafts 2 days before final
    expect(draftFromFinal('2026-10-10', { ...DEFAULT_RULES, draftOffsetDays: 5, finalOffsetDays: 3, dayMode: 'calendar' })).toEqual({ date: '2026-10-08', rule: '2 calendar days before final delivery' });
    // working days skip the weekend: Monday Oct 12 → Thursday Oct 8
    expect(draftFromFinal('2026-10-12', { ...DEFAULT_RULES, draftOffsetDays: 5, finalOffsetDays: 3, dayMode: 'business', workingDays: [1, 2, 3, 4, 5] }).date).toBe('2026-10-08');
    // no gap: same day
    expect(draftFromFinal('2026-10-10', { ...DEFAULT_RULES, draftOffsetDays: 3, finalOffsetDays: 3 }).rule).toBe('same day as final delivery');
  });
});

describe('final delivery from a drafts date', () => {
  it('adds the same gap forward', async () => {
    const { finalFromDraft, DEFAULT_RULES } = await import('../shared/dates');
    expect(finalFromDraft('2026-10-08', DEFAULT_RULES).date).toBe('2026-10-10');
    // Thursday + 2 working days → Monday
    expect(finalFromDraft('2026-10-08', { ...DEFAULT_RULES, dayMode: 'business' }).date).toBe('2026-10-12');
  });
});

describe('months, for a thumbnail portfolio', () => {
  it('takes only a real month as a filter', async () => {
    const { isYearMonth } = await import('../shared/dates');
    expect(['2026-10', '2026-01', '1999-12'].map(isYearMonth)).toEqual([true, true, true]);
    expect(['2026-1', '2026-13', '2026-00', '0026-10', '2026-10-01', '', 202610, null].map(isYearMonth)).toEqual([false, false, false, false, false, false, false, false]);
  });

  it('puts a moment in its month in the workspace’s time zone', async () => {
    const { monthOf } = await import('../shared/dates');
    // 11pm on Oct 31 in New York is already Nov 1 in UTC
    expect(monthOf('2026-11-01T03:00:00.000Z', 'America/New_York')).toBe('2026-10');
    expect(monthOf('2026-11-01T03:00:00.000Z', 'UTC')).toBe('2026-11');
    expect(monthOf('not a time', 'UTC')).toBeNull();
    expect(monthOf(null, 'UTC')).toBeNull();
  });

  it('lists the last months up to this one, oldest first, across a new year', async () => {
    const { lastMonths } = await import('../shared/dates');
    expect(lastMonths('2026-10-26', 6)).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    expect(lastMonths('2027-02-28', 3)).toEqual(['2026-12', '2027-01', '2027-02']);
    expect(lastMonths('2026-03-31', 1)).toEqual(['2026-03']);
    expect(lastMonths('2026-03-31', 0)).toEqual([]);
  });

  it('names a month in full, or short with the year only when it isn’t this one', async () => {
    const { fmtYearMonth } = await import('../shared/format');
    expect(fmtYearMonth('2026-10')).toBe('October 2026');
    expect(fmtYearMonth('2026-10', { short: true, today: '2026-10-26' })).toBe('Oct');
    expect(fmtYearMonth('2025-12', { short: true, today: '2026-01-04' })).toBe('Dec 2025');
    expect(fmtYearMonth('nonsense')).toBe('nonsense');
  });
});

describe('days and wall-clock times, for past thumbnails from YouTube', () => {
  it('puts YouTube’s publish date on the workspace’s day', async () => {
    const { dayOf } = await import('../shared/dates');
    // a plain date is that day, never moved by a zone
    expect(dayOf('2026-10-20', 'America/New_York')).toBe('2026-10-20');
    expect(dayOf(' 2026-10-20 ', 'Pacific/Auckland')).toBe('2026-10-20');
    // an instant falls on its day in the zone: 3am UTC on the 20th is still the 19th in New York
    expect(dayOf('2026-10-20T03:00:00Z', 'America/New_York')).toBe('2026-10-19');
    expect(dayOf('2026-10-20T03:00:00Z', 'Asia/Kolkata')).toBe('2026-10-20');
    expect(dayOf('2026-10-20T15:00:03.000Z', 'America/New_York')).toBe('2026-10-20');
    // the watch page's own offsets
    expect(dayOf('2026-10-20T08:00:03-07:00', 'America/New_York')).toBe('2026-10-20');
    expect(dayOf('2026-10-20T23:30:00-07:00', 'America/New_York')).toBe('2026-10-21');
    expect(dayOf('2026-10-20T23:30:00-0700', 'America/New_York')).toBe('2026-10-21');
    // a time with no zone is the day it's written on
    expect(dayOf('2026-10-20T23:30:00', 'Asia/Kolkata')).toBe('2026-10-20');
    for (const bad of ['Oct 20, 2026', '2026-02-30', '2026-13-01T00:00:00Z', '20261020', 'not a date', '', null, undefined]) {
      expect(dayOf(bad, 'UTC'), String(bad)).toBeNull();
    }
  });

  it('finds the moment a wall clock reads a time on a day, across daylight saving', async () => {
    const { atWallTime, nowInZone } = await import('../shared/dates');
    expect(atWallTime('2026-10-20', 12 * 60, 'America/New_York')).toBe('2026-10-20T16:00:00.000Z');
    expect(atWallTime('2026-10-20', 12 * 60, 'UTC')).toBe('2026-10-20T12:00:00.000Z');
    // the days the clocks change in New York: noon is EDT after spring forward, EST after fall back
    expect(atWallTime('2026-03-08', 12 * 60, 'America/New_York')).toBe('2026-03-08T16:00:00.000Z');
    expect(atWallTime('2026-11-01', 12 * 60, 'America/New_York')).toBe('2026-11-01T17:00:00.000Z');
    expect(atWallTime('2026-10-20', 9 * 60 + 15, 'Asia/Kolkata')).toBe('2026-10-20T03:45:00.000Z');
    // and back again
    expect(nowInZone('Pacific/Auckland', new Date(atWallTime('2026-10-01', 12 * 60, 'Pacific/Auckland')))).toEqual({ date: '2026-10-01', minutes: 720 });
    expect(() => atWallTime('2026-02-30', 720, 'UTC')).toThrow();
  });
});
