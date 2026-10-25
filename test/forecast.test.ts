// The next shoot, estimated: the pacing rules in shared/dates.ts, and the Overview's list and the Calendar's
// tentative shoots built from them (admins and managers only).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import type { Db } from '../server/db';
import type { Ctx } from '../server/core';
import { DEFAULT_RULES, estimateNextShoot, mergeShoots, shootPaces } from '../shared/dates';
import type { CalendarEvent, ShootForecast } from '../shared/types';
import { freshDb } from './db';

const rules = { ...DEFAULT_RULES, dayMode: 'calendar' as const, draftOffsetDays: 5, finalOffsetDays: 3 };

describe('pacing shoots', () => {
  it('counts shoots within a week as one and leaves out shoots with no scripts', () => {
    expect(mergeShoots([{ start: '2026-09-01', scripts: 20 }, { start: '2026-09-03', scripts: 11 }, { start: '2026-09-20', scripts: 0 }, { start: '2026-10-02', scripts: 40 }]))
      .toEqual([{ start: '2026-09-01', scripts: 31 }, { start: '2026-10-02', scripts: 40 }]);
  });
  it('is the days until the next shoot per script the first one had', () => {
    // 31 scripts lasted 31 days; 45 scripts lasted 90 days
    expect(shootPaces([{ start: '2026-07-03', scripts: 45 }, { start: '2026-09-01', scripts: 31 }, { start: '2026-10-02', scripts: 31 }].reverse())).toEqual([60 / 45, 1]);
  });
  it('waits longer after a bigger shoot, and lands on a working day', () => {
    // 1 day a script: 31 scripts after Oct 2 → Mon Nov 2; 45 scripts → Mon Nov 16
    const past = [{ start: '2026-09-01', scripts: 31 }];
    expect(estimateNextShoot([...past, { start: '2026-10-02', scripts: 31 }], [], rules)).toMatchObject({ shootDate: '2026-11-02', draftDue: '2026-10-28', finalDue: '2026-10-30', scripts: 31, basis: 'client', daysPerScript: 1 });
    expect(estimateNextShoot([...past, { start: '2026-10-02', scripts: 45 }], [], rules)?.shootDate).toBe('2026-11-16');
    // 36 days after Oct 2 is Sat Nov 7: moved back to Fri Nov 6, never later
    expect(estimateNextShoot([...past, { start: '2026-10-02', scripts: 36 }], [], rules)?.shootDate).toBe('2026-11-06');
  });
  it('uses the team’s pace for a client with one shoot, and gives up with no history', () => {
    // the median of 2, 3 and 4 days a script: 30 days after Oct 2 is Sun Nov 1, so Fri Oct 30
    expect(estimateNextShoot([{ start: '2026-10-02', scripts: 10 }], [2, 3, 4], rules)).toMatchObject({ shootDate: '2026-10-30', basis: 'team', gaps: 3 });
    expect(estimateNextShoot([{ start: '2026-10-02', scripts: 10 }], [], rules)).toBeNull();
    expect(estimateNextShoot([{ start: '2026-10-02', scripts: 0 }], [1], rules)).toBeNull();
  });
});

describe('next shoots to book', () => {
  const NOW = new Date('2026-10-25T16:00:00Z'); // Sunday noon in New York
  let db: Db;
  let app: FastifyInstance;
  let admin = '';
  let writer = '';
  let writerId = 0;
  const send = async (method: string, url: string, cookie: string, body?: unknown) => {
    const r = await app.inject({
      method: method as 'POST', url, headers: { 'x-scale-media': '1', cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };
  const client = async (name: string) => (await send('POST', '/api/clients', admin, { name, status: 'active' })).body.clientId as number;
  const shoot = async (clientId: number, startDate: string, count: number) => {
    const r = await send('POST', '/api/shoots', admin, { clientId, startDate, endDate: null, batch: { targetCount: count, split: [{ writerId, count }], briefingIds: [], priority: 'normal' } });
    expect(r.status).toBe(200);
  };

  beforeAll(async () => {
    db = await freshDb();
    const ctx: Ctx = { db, now: () => NOW, secureCookies: false, allowSetup: true, uploadLimitBytes: 1024 * 1024 };
    app = await buildApp(ctx);
    const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0];
    const json = (url: string, body: unknown, cookie?: string) =>
      app.inject({ method: 'POST', url, headers: { 'x-scale-media': '1', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, payload: JSON.stringify(body) });
    admin = cookieOf(await json('/api/auth/setup', { name: 'Ada Admin', email: 'ada@scale.test', password: 'admin-password-1' }));
    const added = JSON.parse((await json('/api/users', { name: 'Wes Writer', email: 'wes@scale.test', role: 'writer', password: 'team-password-1' }, admin)).body);
    writerId = added.users.find((u: { email: string }) => u.email === 'wes@scale.test').id;
    writer = cookieOf(await json('/api/auth/login', { email: 'wes@scale.test', password: 'team-password-1' }));
  });
  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('estimates the next shoot only for clients with nothing booked, with who to give the scripts to', async () => {
    const acme = await client('Acme');
    await shoot(acme, '2026-09-01', 31);
    await shoot(acme, '2026-10-02', 45);
    const beta = await client('Beta');
    await shoot(beta, '2026-10-12', 10);
    const booked = await client('Gamma');
    await shoot(booked, '2026-10-01', 20);
    await shoot(booked, '2026-11-10', 20);

    const r = await send('GET', '/api/shoot-forecast', admin);
    expect(r.status).toBe(200);
    const list = r.body.forecasts as ShootForecast[];
    expect(list.map((f) => f.clientName)).toEqual(['Beta', 'Acme']);
    // Acme: 31 scripts lasted 31 days, so 45 scripts after Oct 2 → Mon Nov 16, scripts due 3 days before
    expect(list.find((f) => f.clientId === acme)!.estimate).toMatchObject({
      shootDate: '2026-11-16', finalDue: '2026-11-13', draftDue: '2026-11-11', scripts: 45, basis: 'client', late: false,
      writers: [{ writerId, name: 'Wes Writer', count: 45 }], unassigned: 0,
    });
    // Beta has had one shoot: the team's pace (Acme's 1 day a script; Gamma's next shoot hasn't happened, so it
    // has no gap yet) → 10 days after Oct 12 is Thu Oct 22, so its scripts were due Oct 19: it's behind
    expect(list.find((f) => f.clientId === beta)!.estimate).toMatchObject({ shootDate: '2026-10-22', finalDue: '2026-10-19', basis: 'team', late: true });
    expect(list.find((f) => f.clientId === beta)!.lastShoot).toMatchObject({ startDate: '2026-10-12', scripts: 10 });

    // on the calendar, for managers only: the tentative shoot and the day its scripts are due
    const cal = async (cookie: string) => ((await send('GET', '/api/calendar?from=2026-11-01&to=2026-11-30', cookie)).body.events as CalendarEvent[]).filter((e) => e.type === 'tentative');
    expect((await cal(admin)).map((e) => [e.clientName, e.tentative?.kind, e.start])).toEqual([['Acme', 'shoot', '2026-11-16'], ['Acme', 'scripts', '2026-11-13']]);
    expect(await cal(writer)).toEqual([]);
    expect((await send('GET', '/api/shoot-forecast', writer)).status).toBe(403);

    // booking Acme's next shoot takes it off the list
    await shoot(acme, '2026-11-20', 45);
    expect(((await send('GET', '/api/shoot-forecast', admin)).body.forecasts as ShootForecast[]).map((f) => f.clientName)).toEqual(['Beta']);
  });
});
