// The next shoot, estimated by Claude (a stand-in here) from every past shoot the site knows: its own and those on
// the synced calendars. A manager can change it or deny it, and a client filmed without scripts gets a date with no
// scripts due.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import type { Db } from '../server/db';
import type { Ctx } from '../server/core';
import type { EstimateRequest } from '../server/shoot-estimator';
import type { CalendarEvent, CalendarShoot, ShootForecast, ShootForecasts } from '../shared/types';
import { freshDb } from './db';

const NOW = new Date('2026-10-25T16:00:00Z'); // Sunday noon in New York

describe('next shoots estimated by AI, with a manager’s say', () => {
  let db: Db;
  let app: FastifyInstance;
  let admin = '';
  let writerId = 0;
  let feedId = 0;
  const asked: EstimateRequest[] = [];
  const ids = { daniel: 0, shimonov: 0, booked: 0 };

  const send = async (method: string, url: string, body?: unknown) => {
    const r = await app.inject({
      method: method as 'POST', url, headers: { 'x-scale-media': '1', cookie: admin, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };
  const forecast = async () => (await send('GET', '/api/shoot-forecast')).body as ShootForecasts;
  const of = (f: ShootForecasts, id: number) => f.forecasts.find((x) => x.clientId === id);
  /** an all-day event on the synced calendar */
  const event = (uid: string, title: string, date: string) => db.query(
    `insert into calendar_events (feed_id, uid, title, all_day, start_at, end_at, start_date, end_date) values ($1, $2, $3, true, $4::date, $4::date + 1, $4::date, $4::date)`,
    [feedId, uid, title, date]);

  beforeAll(async () => {
    db = await freshDb();
    const ctx: Ctx = {
      db, now: () => NOW, secureCookies: false, allowSetup: true, uploadLimitBytes: 1024 * 1024,
      // Claude: a date and count for each client it's asked about
      shootEstimator: {
        estimate: async (req) => {
          asked.push(req);
          return req.clients.filter((c) => c.estimate).map((c) => c.id === ids.daniel
            ? { clientId: c.id, shootDate: '2026-11-09', scripts: 5, confidence: 'medium' as const, reasoning: 'About every four weeks, like the last two shoots.' }
            : { clientId: c.id, shootDate: '2026-11-18', scripts: 32, confidence: 'high' as const, reasoning: 'Monthly, with 30 to 32 scripts each time.' });
        },
      },
    };
    app = await buildApp(ctx);
    const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0];
    const json = (url: string, body: unknown, cookie?: string) =>
      app.inject({ method: 'POST', url, headers: { 'x-scale-media': '1', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, payload: JSON.stringify(body) });
    admin = cookieOf(await json('/api/auth/setup', { name: 'Ada Admin', email: 'ada@scale.test', password: 'admin-password-1' }));
    const added = JSON.parse((await json('/api/users', { name: 'Wes Writer', email: 'wes@scale.test', role: 'writer', password: 'team-password-1' }, admin)).body);
    writerId = added.users.find((u: { email: string }) => u.email === 'wes@scale.test').id;
    const adminId = (await db.one<{ id: number }>(`select id from users where email = 'ada@scale.test'`))!.id;
    feedId = (await db.one<{ id: number }>(`insert into calendar_feeds (name, url, created_by) values ('Josh’s calendar', 'https://calendar.test/josh.ics', $1) returning id`, [adminId]))!.id;

    for (const [key, name] of [['daniel', 'Daniel Abrams'], ['shimonov', 'Shimonov Law'], ['booked', 'Booked Brand']] as const) {
      ids[key] = (await send('POST', '/api/clients', { name, status: 'active' })).body.clientId;
    }
    // Daniel Abrams: filmed without scripts, a shoot on the site and an earlier one only on the calendar
    expect((await send('PATCH', `/api/clients/${ids.daniel}`, { scriptsRequired: false })).status).toBe(200);
    expect((await send('POST', '/api/shoots', { clientId: ids.daniel, startDate: '2026-10-12', endDate: null })).status).toBe(200);
    await event('d1', 'Daniel Abrams Filming', '2026-09-14');
    // Shimonov Law: 30 scripts on the site's shoot (on the calendar too), an earlier shoot and a call only on the calendar
    expect((await send('POST', '/api/shoots', { clientId: ids.shimonov, startDate: '2026-10-19', endDate: null, batch: { targetCount: 30, split: [{ writerId, count: 30 }], briefingIds: [], priority: 'normal' } })).status).toBe(200);
    await event('s1', 'Shimonov Law Filming Session', '2026-09-18');
    await event('s2', 'Shimonov Law Filming Session', '2026-10-19');
    await event('s3', 'Shimonov Law call', '2026-10-02');
    // Booked Brand: its next shoot is on the calendar, so there's nothing to estimate
    expect((await send('POST', '/api/shoots', { clientId: ids.booked, startDate: '2026-10-05', endDate: null })).status).toBe(200);
    await event('b1', 'Booked Brand shoot', '2026-11-20');
  });
  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('counts the calendar’s past shoots, and estimates the site’s way until Claude answers', async () => {
    const f = await forecast();
    expect(f.forecasts.map((x) => x.clientName)).toEqual(['Daniel Abrams', 'Shimonov Law']);
    expect(f.estimates).toEqual({ stale: 2, canEstimate: true });
    // Daniel: Sep 14 (calendar) and Oct 12 (site), 28 days apart → Mon Nov 9; no scripts, so nothing due
    expect(of(f, ids.daniel)).toMatchObject({ scriptsRequired: false, pastShoots: 2, estimate: { shootDate: '2026-11-09', source: 'rule', scripts: null, finalDue: null, writers: [] } });
    // Shimonov: the Oct 19 shoot is on both (one shoot), Sep 18 only on the calendar
    expect(of(f, ids.shimonov)).toMatchObject({ pastShoots: 2, lastShoot: { startDate: '2026-10-19', onSite: true, scripts: 30 }, estimate: { source: 'rule' } });
  });

  it('asks Claude with the whole history, once, and shows its answer', async () => {
    const r = await send('POST', '/api/shoot-forecast/estimate');
    expect(r.body).toMatchObject({ estimated: 2, busy: false, estimates: { stale: 0 } });
    expect(asked).toHaveLength(1);
    const shimonov = asked[0].clients.find((c) => c.id === ids.shimonov)!;
    expect(shimonov.estimate).toBe(true);
    expect(shimonov.history).toContain('only on the calendar: "Shimonov Law Filming Session"');
    expect(shimonov.history).toContain('on the site and the calendar: "Shimonov Law Filming Session"): 30 scripts');
    expect(shimonov.history).toContain('Other calendar events: 2026-10-02 "Shimonov Law call"');
    expect(asked[0].clients.find((c) => c.id === ids.daniel)!.history).toContain('Needs scripts: no');
    expect(asked[0].clients.some((c) => c.id === ids.booked)).toBe(false);

    const f = r.body as ShootForecasts;
    // 30 scripts last time, all Wes's: all 32 go to him; due 3 days before the shoot
    expect(of(f, ids.shimonov)!.estimate).toMatchObject({
      shootDate: '2026-11-18', scripts: 32, source: 'ai', confidence: 'high', finalDue: '2026-11-15', draftDue: '2026-11-13',
      writers: [{ writerId, count: 32 }], unassigned: 0, why: 'Monthly, with 30 to 32 scripts each time.', updating: false,
    });
    // no scripts for Daniel, whatever the answer said
    expect(of(f, ids.daniel)!.estimate).toMatchObject({ shootDate: '2026-11-09', source: 'ai', scripts: null, finalDue: null });

    // the same history isn't asked about again
    expect((await send('POST', '/api/shoot-forecast/estimate')).body).toMatchObject({ estimated: 0 });
    expect(asked).toHaveLength(1);

    // the calendar: both tentative shoots, and Shimonov's scripts due date (Daniel has none)
    const events = ((await send('GET', '/api/calendar?from=2026-11-01&to=2026-11-30')).body.events as CalendarEvent[]).filter((e) => e.type === 'tentative');
    expect(events.map((e) => [e.clientName, e.tentative?.kind, e.start])).toEqual([
      ['Daniel Abrams', 'shoot', '2026-11-09'], ['Shimonov Law', 'shoot', '2026-11-18'], ['Shimonov Law', 'scripts', '2026-11-15'],
    ]);
  });

  it('keeps a manager’s change, and Claude leaves it alone', async () => {
    const early = await send('POST', `/api/shoot-forecast/${ids.shimonov}/change`, { shootDate: '2026-10-19', scripts: 30 });
    expect(early.status).toBe(400);
    expect(early.body.error.fields.shootDate).toMatch(/after/);
    const r = await send('POST', `/api/shoot-forecast/${ids.shimonov}/change`, { shootDate: '2026-11-23', scripts: 28 });
    expect(r.status).toBe(200);
    expect(of(r.body, ids.shimonov)!.estimate).toMatchObject({ shootDate: '2026-11-23', scripts: 28, source: 'manager', confidence: null, writers: [{ writerId, count: 28 }] });
    expect(of(r.body, ids.shimonov)!.estimate!.why).toMatch(/^Changed by Ada/);
    expect((r.body as ShootForecasts).estimates.stale).toBe(0);
  });

  it('hides a denied estimate until it’s brought back', async () => {
    let f = (await send('POST', `/api/shoot-forecast/${ids.daniel}/deny`, {})).body as ShootForecasts;
    expect(of(f, ids.daniel)).toBeUndefined();
    expect(f.denied.map((x: ShootForecast) => x.clientName)).toEqual(['Daniel Abrams']);
    expect(f.estimates.stale).toBe(0);
    const events = ((await send('GET', '/api/calendar?from=2026-11-01&to=2026-11-30')).body.events as CalendarEvent[]).filter((e) => e.type === 'tentative');
    expect(events.some((e) => e.clientName === 'Daniel Abrams')).toBe(false);

    f = (await send('POST', `/api/shoot-forecast/${ids.daniel}/deny`, { undo: true })).body as ShootForecasts;
    expect(f.denied).toEqual([]);
    // back as new: the site's estimate, and Claude is asked again
    expect(of(f, ids.daniel)!.estimate).toMatchObject({ source: 'rule', shootDate: '2026-11-09' });
    expect(f.estimates.stale).toBe(1);
  });

  it('never asks to plan scripts for a client filmed without them, and a booked shoot ends the estimate', async () => {
    await event('d2', 'Daniel Abrams Filming', '2026-11-30');
    const plan = (await send('GET', '/api/calendar-shoots')).body.shoots as CalendarShoot[];
    expect(plan.some((s) => s.client?.id === ids.daniel)).toBe(false);
    expect(of(await forecast(), ids.daniel)).toBeUndefined();
    // writers can't see or change any of it
    const writer = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-scale-media': '1', 'content-type': 'application/json' }, payload: JSON.stringify({ email: 'wes@scale.test', password: 'team-password-1' }) });
    const w = String(writer.headers['set-cookie']).split(';')[0];
    for (const [method, url] of [['GET', '/api/shoot-forecast'], ['POST', '/api/shoot-forecast/estimate'], ['POST', `/api/shoot-forecast/${ids.shimonov}/deny`]] as const) {
      expect((await app.inject({ method, url, headers: { 'x-scale-media': '1', cookie: w, 'content-type': 'application/json' }, payload: method === 'POST' ? '{}' : undefined })).statusCode).toBe(403);
    }
  });
});
