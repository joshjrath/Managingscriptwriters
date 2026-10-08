// Where people work from, through the real HTTP routes: team members' cities,
// time zones and working hours, and the editors list (admin only).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { openDb, type Db } from '../server/db';
import type { Ctx } from '../server/core';
import { CITIES, findCity } from '../shared/cities';
import { isValidTimeZone } from '../shared/dates';

const NOW = new Date('2026-09-28T16:00:00Z');
let db: Db;
let app: FastifyInstance;
let ctx: Ctx;

type Res<T = any> = { status: number; body: T; cookie: string | null };
async function call<T = any>(method: string, url: string, opts: { body?: unknown; cookie?: string } = {}): Promise<Res<T>> {
  const headers: Record<string, string> = { 'x-scale-media': '1' };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const r = await app.inject({ method: method as 'GET', url, headers, payload: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  let body: any = r.body;
  try { body = JSON.parse(r.body); } catch { /* not json */ }
  const set = r.headers['set-cookie'];
  return { status: r.statusCode, body, cookie: set ? String(set).split(';')[0] : null };
}

let manager = '';
let writer = '';
let lead = '';
const ids: Record<string, number> = {};

beforeAll(async () => {
  db = await openDb({ memory: true });
  ctx = { db, now: () => NOW, secureCookies: false, allowSetup: true, uploadLimitBytes: 1024 * 1024 };
  app = await buildApp(ctx);
  const setup = await call('POST', '/api/auth/setup', { body: { name: 'Josh Rath', email: 'josh@scale.test', password: 'correct-horse-battery' } });
  manager = setup.cookie!;
  expect((await call('POST', '/api/users', { cookie: manager, body: { name: 'Sarah Chen', email: 'sarah@scale.test', role: 'writer', password: 'writer-password-1' } })).status).toBe(200);
  const users = (await call('GET', '/api/users', { cookie: manager })).body.users as { id: number; name: string }[];
  ids.josh = users.find((u) => u.name === 'Josh Rath')!.id;
  ids.sarah = users.find((u) => u.name === 'Sarah Chen')!.id;
  writer = (await call('POST', '/api/auth/login', { body: { email: 'sarah@scale.test', password: 'writer-password-1' } })).cookie!;
  expect((await call('POST', '/api/users', { cookie: manager, body: { name: 'Maya Lead', email: 'maya@scale.test', role: 'manager', password: 'manager-password-1' } })).status).toBe(200);
  lead = (await call('POST', '/api/auth/login', { body: { email: 'maya@scale.test', password: 'manager-password-1' } })).cookie!;
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('the city catalog', () => {
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

describe('team members', () => {
  it('are placed in cities, with working hours', async () => {
    const bad = await call('PATCH', `/api/users/${ids.sarah}`, { cookie: manager, body: { city: 'Atlantis' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields.city).toBeTruthy();
    const r = await call('PATCH', `/api/users/${ids.sarah}`, { cookie: manager, body: { city: 'London, United Kingdom', workStart: 20, workEnd: 4 } });
    expect(r.status).toBe(200);
    const sarah = r.body.users.find((u: any) => u.id === ids.sarah);
    expect(sarah.city).toBe('London, United Kingdom');
    expect(sarah.workHours).toEqual([20, 28]);
    const josh = await call('PATCH', `/api/users/${ids.josh}`, { cookie: manager, body: { city: 'Toronto, Canada', workStart: 9, workEnd: 18 } });
    expect(josh.body.users.find((u: any) => u.id === ids.josh)).toMatchObject({ city: 'Toronto, Canada', timezone: 'America/Toronto', workHours: [9, 18] });
  });
});

describe('time zones and shifts', () => {
  it('follow the city unless one is chosen, and a chosen one survives edits that keep the city', async () => {
    const sarah = () => call('GET', '/api/users', { cookie: manager }).then((r) => r.body.users.find((u: any) => u.id === ids.sarah));
    expect((await sarah()).timezone).toBe('Europe/London');
    const bad = await call('PATCH', `/api/users/${ids.sarah}`, { cookie: manager, body: { timezone: 'Mars/Olympus' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields.timezone).toBeTruthy();
    await call('PATCH', `/api/users/${ids.sarah}`, { cookie: manager, body: { city: 'London, United Kingdom', timezone: 'Europe/Dublin', workStart: 20, workEnd: 4 } });
    expect((await sarah()).timezone).toBe('Europe/Dublin');
    await call('PATCH', `/api/users/${ids.sarah}`, { cookie: manager, body: { city: 'London, United Kingdom', workStart: 20, workEnd: 4 } });
    expect((await sarah()).timezone).toBe('Europe/Dublin');
    // moving city goes back to the new city's zone
    await call('PATCH', `/api/users/${ids.sarah}`, { cookie: manager, body: { city: 'Lisbon, Portugal' } });
    expect((await sarah()).timezone).toBe('Europe/Lisbon');
    await call('PATCH', `/api/users/${ids.sarah}`, { cookie: manager, body: { city: 'London, United Kingdom', workStart: 20, workEnd: 4 } });
  });

  it('can be any length, up to around the clock', async () => {
    const hours = async (workStart: number, workEnd: number) => {
      const r = await call('PATCH', `/api/users/${ids.josh}`, { cookie: manager, body: { workStart, workEnd } });
      expect(r.status).toBe(200);
      return r.body.users.find((u: any) => u.id === ids.josh).workHours;
    };
    expect(await hours(0, 10)).toEqual([0, 10]);
    expect(await hours(6, 4)).toEqual([6, 28]);
    expect(await hours(0, 24)).toEqual([0, 24]);
    expect(await hours(9, 9)).toEqual([9, 33]);
    expect(await hours(9, 18)).toEqual([9, 18]);
  });
});

describe('editors', () => {
  it('are managed by the admin only', async () => {
    expect((await call('GET', '/api/editors', { cookie: lead })).status).toBe(403);
    expect((await call('POST', '/api/editors', { cookie: writer, body: { name: 'Ed', city: 'Paris, France' } })).status).toBe(403);
    const bad = await call('POST', '/api/editors', { cookie: manager, body: { name: 'Ed', city: 'Atlantis' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields.city).toBeTruthy();
    const r = await call('POST', '/api/editors', { cookie: manager, body: { name: 'Priya Editor', city: 'Mumbai, India', workStart: 22, workEnd: 6 } });
    expect(r.status).toBe(200);
    expect(r.body.editors).toEqual([expect.objectContaining({ name: 'Priya Editor', city: 'Mumbai, India', timezone: 'Asia/Kolkata', workHours: [22, 30] })]);
  });

  it('can have their own time zone and a shift of any length', async () => {
    const r = await call('POST', '/api/editors', { cookie: manager, body: { name: 'Tomas Night', city: 'Bangkok, Thailand', timezone: 'Asia/Ho_Chi_Minh', workStart: 9, workEnd: 9 } });
    const tomas = r.body.editors.find((e: any) => e.name === 'Tomas Night');
    expect(tomas).toMatchObject({ timezone: 'Asia/Ho_Chi_Minh', workHours: [9, 33] });
    // an edit that keeps the city keeps the chosen zone
    const e = await call('PATCH', `/api/editors/${tomas.id}`, { cookie: manager, body: { name: 'Tomas Night', city: 'Bangkok, Thailand', workStart: 0, workEnd: 24 } });
    expect(e.body.editors.find((x: any) => x.id === tomas.id)).toMatchObject({ timezone: 'Asia/Ho_Chi_Minh', workHours: [0, 24] });
    expect((await call('POST', '/api/editors', { cookie: manager, body: { name: 'X', city: 'Paris, France', timezone: 'Nowhere/Land' } })).status).toBe(400);
    await call('DELETE', `/api/editors/${tomas.id}`, { cookie: manager });
  });

  it('keep their local time and hours, but are never users', async () => {
    const [priya] = (await call('GET', '/api/editors', { cookie: manager })).body.editors;
    expect(priya).toMatchObject({ timezone: 'Asia/Kolkata', workHours: [22, 30] });
    const users = (await call('GET', '/api/users', { cookie: manager })).body.users as { name: string }[];
    expect(users.some((u) => u.name === 'Priya Editor')).toBe(false);
    expect((await call('POST', '/api/auth/login', { body: { email: 'priya@scale.test', password: 'anything-at-all' } })).status).toBe(401);
  });

  it('can be edited and removed', async () => {
    const [priya] = (await call('GET', '/api/editors', { cookie: manager })).body.editors;
    const e = await call('PATCH', `/api/editors/${priya.id}`, { cookie: manager, body: { name: 'Priya Editor', city: 'Berlin, Germany', workStart: 9, workEnd: 17 } });
    expect(e.body.editors[0]).toMatchObject({ city: 'Berlin, Germany', workHours: [9, 17] });
    expect((await call('DELETE', `/api/editors/${priya.id}`, { cookie: manager })).body.editors).toEqual([]);
    expect((await call('DELETE', `/api/editors/${priya.id}`, { cookie: manager })).status).toBe(404);
  });
});
