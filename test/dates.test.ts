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
