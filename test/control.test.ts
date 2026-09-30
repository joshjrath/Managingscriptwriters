// Control Center: clocks, the sun, shifts and coverage, deadline orbits,
// anomalies, and the simulated network they run on.

import { describe, expect, it } from 'vitest';
import {
  anomaliesOf, bandOf, coverageOf, fmtCountdown, localClock, metricsOf, presenceOf, subsolarPoint, sunHeight,
  type CcWriter,
} from '../shared/control';
import { CITIES, findCity } from '../shared/cities';
import { simulatedWorld } from '../server/control/simulated';
import { deadlineInstant } from '../server/control/workspace';
import { isValidTimeZone } from '../shared/dates';

const AT = new Date('2026-09-30T05:24:18Z');

const writer = (over: Partial<CcWriter>): CcWriter => ({
  id: 'w', name: 'Test Writer', callsign: 'TEST', initials: 'TW', city: 'Toronto', cityCode: 'TOR', country: 'Canada',
  lat: 43.65, lon: -79.38, timezone: 'America/Toronto', role: 'writer', status: 'active', workHours: [9, 18],
  currentAssignment: null, projectId: null, clientId: null, progress: null, deadline: null, stage: null,
  weeklyOutput: 0, workload: 1, lastActivity: null, ...over,
});

describe('clocks', () => {
  it('computes local time and offset from the IANA zone', () => {
    const t = localClock('America/Toronto', AT);
    expect(t.time).toBe('01:24:18');
    expect(t.offset).toBe(-240);
    expect(t.offsetLabel).toBe('UTC−04:00');
    expect(t.date).toBe('WED 30 SEP');
    expect(localClock('Asia/Kolkata', AT).offsetLabel).toBe('UTC+05:30');
    expect(localClock('Asia/Kolkata', AT).short).toBe('10:54');
  });

  it('formats countdowns', () => {
    expect(fmtCountdown((4 * 60 + 36) * 60_000)).toBe('04H 36M');
    expect(fmtCountdown(50 * 3_600_000)).toBe('2D 02H');
    expect(fmtCountdown(-90 * 60_000)).toBe('01H 30M');
  });

  it('every city in the catalog has a valid timezone and coordinates', () => {
    for (const c of CITIES) {
      expect(isValidTimeZone(c.timezone), c.name).toBe(true);
      expect(Math.abs(c.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(c.lon)).toBeLessThanOrEqual(180);
      expect(c.code).toMatch(/^[A-Z]{3}$/);
    }
    expect(findCity('Toronto, Canada')?.code).toBe('TOR');
    expect(findCity('mumbai')?.timezone).toBe('Asia/Kolkata');
    expect(findCity('Atlantis')).toBeUndefined();
  });
});

describe('the sun', () => {
  it('sits over the Tropic of Cancer at the June solstice, near Greenwich at noon UTC', () => {
    const s = subsolarPoint(new Date('2026-06-21T12:00:00Z'));
    expect(s.lat).toBeCloseTo(23.44, 0);
    expect(Math.abs(s.lon)).toBeLessThan(1.5);
  });

  it('crosses the equator at the equinox and follows the clock around the planet', () => {
    expect(Math.abs(subsolarPoint(new Date('2026-03-20T14:46:00Z')).lat)).toBeLessThan(0.1);
    const midnight = subsolarPoint(new Date('2026-12-21T00:00:00Z'));
    expect(midnight.lat).toBeCloseTo(-23.44, 0);
    expect(Math.abs(Math.abs(midnight.lon) - 180)).toBeLessThan(2);
  });

  it('knows day from night', () => {
    // 01:24 in Toronto, 10:54 in Mumbai
    expect(sunHeight(43.65, -79.38, AT)).toBeLessThan(0);
    expect(sunHeight(19.08, 72.88, AT)).toBeGreaterThan(0.5);
  });
});

describe('presence', () => {
  const at = (iso: string) => new Date(iso);
  it('is on shift inside working hours and offline outside them', () => {
    expect(presenceOf(writer({}), at('2026-09-30T18:00:00Z')).phase).toBe('on'); // 14:00 local
    const night = presenceOf(writer({ status: 'deep_work' }), at('2026-09-30T07:00:00Z')); // 03:00
    expect(night.phase).toBe('off');
    expect(night.status).toBe('offline');
  });

  it('wakes in the hour before a shift, and shows late work', () => {
    const waking = presenceOf(writer({}), at('2026-09-30T12:30:00Z')); // 08:30
    expect(waking.phase).toBe('waking');
    expect(waking.untilStart).toBe(30 * 60_000);
    const late = presenceOf(writer({ status: 'deep_work', lastActivity: '2026-09-30T02:50:00Z' }), at('2026-09-30T03:00:00Z')); // 23:00
    expect(late.phase).toBe('late');
    expect(late.status).toBe('deep_work');
  });

  it('handles shifts that pass midnight', () => {
    const w = writer({ workHours: [20, 28] });
    expect(presenceOf(w, at('2026-09-30T06:00:00Z')).phase).toBe('on'); // 02:00
    expect(presenceOf(w, at('2026-09-30T09:00:00Z')).phase).toBe('off'); // 05:00
  });
});

describe('follow the sun: coverage', () => {
  it('adds up shifts across the UTC day and finds the gaps', () => {
    const tor = writer({ id: 'tor' }); // 13–22 UTC in EDT
    const tyo = writer({ id: 'tyo', timezone: 'Asia/Tokyo', lat: 35.7, lon: 139.7, workHours: [10, 19] }); // 01–10 UTC
    const c = coverageOf([tor, tyo], AT);
    expect(c.coveredMinutes).toBe(18 * 60);
    expect(c.windows.find((w) => w.writerId === 'tor')).toMatchObject({ start: 13, end: 22 });
    expect(c.gaps.map((g) => [g.start, g.end])).toEqual([[10, 13], [22, 25]]);
    expect(c.overlapNow).toBe(1); // 05:24 UTC: Tokyo is on
    expect(c.nextOnline?.writerId).toBe('tor');
    expect(c.nextOnline?.in).toBeCloseTo((7 * 60 + 35.7) * 60_000, -4);
    expect(c.nextHandoff?.writerId).toBe('tyo');
  });

  it('reports a quiet network', () => {
    const c = coverageOf([], AT);
    expect(c.coveredMinutes).toBe(0);
    expect(c.nextOnline).toBeNull();
  });
});

describe('deadline orbits', () => {
  const inH = (h: number) => new Date(AT.getTime() + h * 3_600_000).toISOString();
  it('puts closer deadlines on tighter orbits', () => {
    expect(bandOf(inH(10), AT)).toMatchObject({ band: '24H' });
    expect(bandOf(inH(10), AT).t).toBeCloseTo(10 / 24);
    expect(bandOf(inH(30), AT).band).toBe('48H');
    expect(bandOf(inH(100), AT).band).toBe('7D');
    expect(bandOf(inH(400), AT).band).toBe('30D');
    expect(bandOf(inH(900), AT).band).toBe('LATER');
    expect(bandOf(inH(-2), AT).band).toBe('OVERDUE');
    expect(bandOf(null, AT).band).toBe('LATER');
  });

  it('turns a calendar deadline into the organisation’s cutoff that day', () => {
    expect(deadlineInstant('2026-10-02', 'America/New_York', '23:59')).toBe('2026-10-03T03:59:00.000Z');
    expect(deadlineInstant('2026-01-15', 'America/New_York', '17:00')).toBe('2026-01-15T22:00:00.000Z');
  });
});

describe('the simulated network', () => {
  const world = simulatedWorld(AT, 'Scale Media');

  it('is complete and consistent', () => {
    expect(world.source.kind).toBe('simulated');
    expect(world.writers.map((w) => w.callsign)).toContain('JOSH');
    const ids = new Set(world.writers.map((w) => w.id));
    for (const s of world.scripts) {
      expect(world.projects.some((p) => p.id === s.projectId)).toBe(true);
      if (s.writerId) expect(ids.has(s.writerId)).toBe(true);
    }
    for (const h of world.handoffs) expect(ids.has(h.originNode) && ids.has(h.destinationNode)).toBe(true);
    for (const l of world.links) expect(ids.has(l.from) && ids.has(l.to)).toBe(true);
    expect(new Set(world.scripts.map((s) => s.code)).size).toBe(world.scripts.length);
  });

  it('matches the brief: Downtown Dental 14 / 20, Josh reviewing it with a deadline 4h36m out', () => {
    const dd = world.projects.find((p) => p.id === 'dd-master')!;
    expect(dd.progress).toEqual({ done: 14, total: 20 });
    expect(dd.stage).toBe('writing');
    const josh = world.writers.find((w) => w.id === 'josh')!;
    expect(josh.currentAssignment).toBe('Master Script Batch');
    expect(josh.progress).toEqual({ done: 14, total: 20 });
    const left = new Date(josh.deadline!).getTime() - AT.getTime();
    expect(left).toBeGreaterThan(4 * 3_600_000);
    expect(left).toBeLessThan(6 * 3_600_000);
  });

  it('detects operational pressure', () => {
    const kinds = anomaliesOf(world, AT).map((a) => `${a.kind}:${a.writerId ?? a.projectId ?? 'world'}`);
    expect(kinds).toContain('overload:arjun');
    expect(kinds).toContain('revision_pileup:arjun');
    expect(kinds).toContain('deadline_collision:josh');
    expect(anomaliesOf(world, AT).some((a) => a.kind === 'client_block' && a.projectId === 'ph-patient')).toBe(true);
    const load = anomaliesOf(world, AT).find((a) => a.kind === 'overload')!;
    expect(load.lines[0]).toEqual({ value: '154%', label: 'CAPACITY' });
  });

  it('has the archive to drift into', () => {
    const archived = world.projects.filter((p) => p.archived);
    expect(archived.length).toBeGreaterThan(5);
    expect(archived.every((p) => p.stage === 'delivered' && p.completedAt)).toBe(true);
    const m = metricsOf(world, AT);
    expect(m.nodes).toBe(8);
    expect(m.activeProjects).toBe(7);
    expect(m.scriptsInMotion).toBeGreaterThan(20);
  });
});
