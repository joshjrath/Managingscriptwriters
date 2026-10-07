import { describe, expect, it } from 'vitest';
import { parseIcs } from '../server/ical';

const FEED = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN', 'X-WR-CALNAME:Joshua Shalamov', 'X-WR-TIMEZONE:America/New_York',
  'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261012', 'DTEND;VALUE=DATE:20261014', 'UID:shoot-1@google.com', 'SUMMARY:Shoot – Dentist Mike', 'LOCATION:Brooklyn\\, NY', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART;TZID=America/New_York:20261008T100000', 'DTEND;TZID=America/New_York:20261008T103000', 'UID:call-1@google.com',
  'SUMMARY:Ideation call with Elegant Jeweler', 'DESCRIPTION:Join: https://meet.google.com/abc\\nAgenda: hooks', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT10M', 'END:VALARM', 'END:VEVENT',
  // weekly Monday standup 9:00 New York, through the DST change on Nov 1, one week skipped, one moved
  'BEGIN:VEVENT', 'DTSTART;TZID=America/New_York:20261005T090000', 'DTEND;TZID=America/New_York:20261005T091500', 'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=6',
  'EXDATE;TZID=America/New_York:20261012T090000', 'UID:standup@google.com', 'SUMMARY:Team standup', 'END:VEVENT',
  'BEGIN:VEVENT', 'RECURRENCE-ID;TZID=America/New_York:20261019T090000', 'DTSTART;TZID=America/New_York:20261020T110000', 'DTEND;TZID=America/New_York:20261020T111500',
  'UID:standup@google.com', 'SUMMARY:Team standup (moved)', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART:20261009T150000Z', 'DTEND:20261009T160000Z', 'UID:gone@google.com', 'STATUS:CANCELLED', 'SUMMARY:Cancelled thing', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART:20261009T150000Z', 'DTEND:20261009T160000Z', 'UID:long-summ', 'SUMMARY:A very long title that Google folds onto the', '  next line', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('reading a Google Calendar feed', () => {
  const ev = parseIcs(FEED, new Date('2026-10-01T00:00:00Z'), new Date('2026-12-31T00:00:00Z'), 'America/New_York');
  it('reads all-day and timed events with their details', () => {
    const shoot = ev.find((e) => e.title.startsWith('Shoot'))!;
    expect(shoot).toMatchObject({ allDay: true, startDate: '2026-10-12', endDate: '2026-10-13', location: 'Brooklyn, NY' });
    const call = ev.find((e) => e.title.startsWith('Ideation'))!;
    expect(call.start.toISOString()).toBe('2026-10-08T14:00:00.000Z'); // 10:00 EDT
    expect(call.description).toBe('Join: https://meet.google.com/abc\nAgenda: hooks');
    expect(ev.some((e) => e.title === 'Cancelled thing')).toBe(false);
    expect(ev.find((e) => e.uid.startsWith('long-summ'))!.title).toBe('A very long title that Google folds onto the next line');
  });
  it('expands repeating events, skipping removed weeks and moving changed ones, through the clock change', () => {
    const standups = ev.filter((e) => e.title.startsWith('Team standup')).map((e) => [e.start.toISOString(), e.title]);
    expect(standups).toEqual([
      ['2026-10-05T13:00:00.000Z', 'Team standup'],
      ['2026-10-20T15:00:00.000Z', 'Team standup (moved)'],
      ['2026-10-26T13:00:00.000Z', 'Team standup'],
      ['2026-11-02T14:00:00.000Z', 'Team standup'], // 9:00 EST after the change
      ['2026-11-09T14:00:00.000Z', 'Team standup'],
    ]);
  });
  it('only returns what overlaps the window', () => {
    const narrow = parseIcs(FEED, new Date('2026-11-01T00:00:00Z'), new Date('2026-11-05T00:00:00Z'), 'America/New_York');
    expect(narrow.map((e) => e.title)).toEqual(['Team standup']);
  });
  it('refuses something that isn’t a calendar', () => {
    expect(() => parseIcs('<html>Sign in</html>', new Date(), new Date())).toThrow(/Secret address/);
  });
});
