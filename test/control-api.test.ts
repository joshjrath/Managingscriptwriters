// Control Center access and data, through the real HTTP routes: nothing is
// served without clearance, clearance is for admins only, and the world is the
// real workspace (the simulated network only when the server asks for it).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { openDb, type Db } from '../server/db';
import type { Ctx } from '../server/core';
import { loadWorld } from '../server/control/routes';
import type { ControlStatus, ControlWorld } from '../shared/control';

let NOW = new Date('2026-09-28T16:00:00Z');
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

describe('clearance', () => {
  it('serves nothing to someone who isn’t signed in', async () => {
    expect((await call('GET', '/api/control/world')).status).toBe(403);
    const s = (await call<ControlStatus>('GET', '/api/control/status')).body;
    expect(s).toMatchObject({ signedIn: false, eligible: false, cleared: false, operator: null });
  });

  it('a signed-in admin still needs to authorize', async () => {
    const s = (await call<ControlStatus>('GET', '/api/control/status', { cookie: manager })).body;
    expect(s).toMatchObject({ signedIn: true, eligible: true, cleared: false, operator: { callsign: 'JOSH' } });
    const w = await call('GET', '/api/control/world', { cookie: manager });
    expect(w.status).toBe(403);
    expect(w.body.error.code).toBe('control_locked');
  });

  it('rejects a wrong key, and requires the CSRF header', async () => {
    const r = await call('POST', '/api/control/authorize', { cookie: manager, body: { password: 'nope-nope-nope' } });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('rejected');
    const csrf = await app.inject({ method: 'POST', url: '/api/control/authorize', headers: { cookie: manager, 'content-type': 'application/json' }, payload: JSON.stringify({ password: 'correct-horse-battery' }) });
    expect(csrf.statusCode).toBe(403);
    expect((await call('GET', '/api/control/world', { cookie: manager })).status).toBe(403);
  });

  it('clears the admin with their own password, and serves the world', async () => {
    const r = await call('POST', '/api/control/authorize', { cookie: manager, body: { password: 'correct-horse-battery' } });
    expect(r.status).toBe(200);
    expect(new Date(r.body.clearedUntil).getTime()).toBe(NOW.getTime() + 12 * 3_600_000);
    expect((await call<ControlStatus>('GET', '/api/control/status', { cookie: manager })).body.cleared).toBe(true);
    const w = await call<ControlWorld>('GET', '/api/control/world', { cookie: manager });
    expect(w.status).toBe(200);
    // nobody has a city yet: the real, empty workspace (never sample people or clients)
    expect(w.body.source).toMatchObject({ kind: 'workspace', label: 'LIVE WORKSPACE', unplaced: 3 });
    expect(w.body.writers).toEqual([]);
    expect(w.body.clients).toEqual([]);
  });

  it('never clears a writer, even with the right password', async () => {
    const r = await call('POST', '/api/control/authorize', { cookie: writer, body: { password: 'writer-password-1' } });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('clearance');
    expect((await call('GET', '/api/control/world', { cookie: writer })).status).toBe(403);
    expect((await call<ControlStatus>('GET', '/api/control/status', { cookie: writer })).body.eligible).toBe(false);
  });

  it('never clears a manager who isn’t the admin', async () => {
    expect((await call<ControlStatus>('GET', '/api/control/status', { cookie: lead })).body.eligible).toBe(false);
    const r = await call('POST', '/api/control/authorize', { cookie: lead, body: { password: 'manager-password-1' } });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('clearance');
    const portal = await call('POST', '/api/control/authorize', { body: { email: 'maya@scale.test', password: 'manager-password-1' } });
    expect(portal.status).toBe(403);
    expect((await call('GET', '/api/control/world', { cookie: lead })).status).toBe(403);
  });

  it('signs the admin in from the portal itself', async () => {
    const noEmail = await call('POST', '/api/control/authorize', { body: { password: 'correct-horse-battery' } });
    expect(noEmail.status).toBe(400);
    const r = await call('POST', '/api/control/authorize', { body: { email: 'JOSH@scale.test', password: 'correct-horse-battery' } });
    expect(r.status).toBe(200);
    expect(r.cookie).toBeTruthy();
    expect((await call('GET', '/api/control/world', { cookie: r.cookie! })).status).toBe(200);
    expect((await call('GET', '/api/bootstrap', { cookie: r.cookie! })).status).toBe(200);
  });

  it('locks again on request, and when the clearance runs out', async () => {
    const r = await call('POST', '/api/control/authorize', { body: { email: 'josh@scale.test', password: 'correct-horse-battery' } });
    const cookie = r.cookie!;
    expect((await call('POST', '/api/control/lock', { cookie })).status).toBe(200);
    expect((await call('GET', '/api/control/world', { cookie })).status).toBe(403);
    // the app itself stays signed in
    expect((await call('GET', '/api/bootstrap', { cookie })).status).toBe(200);

    await call('POST', '/api/control/authorize', { cookie, body: { password: 'correct-horse-battery' } });
    expect((await call('GET', '/api/control/world', { cookie })).status).toBe(200);
    const was = NOW;
    NOW = new Date(NOW.getTime() + 13 * 3_600_000);
    expect((await call('GET', '/api/control/world', { cookie })).status).toBe(403);
    NOW = was;
  });

  it('records clearances in the master log', async () => {
    const log = (await call('GET', '/api/audit?kind=auth', { cookie: manager })).body.entries.map((e: any) => e.summary);
    expect(log).toContain('Opened the Control Center');
    expect(log).toContain('Failed Control Center authorization');
    const denied = (await call('GET', '/api/audit?kind=denied', { cookie: manager })).body.entries.map((e: any) => e.summary);
    expect(denied.some((s: string) => /Control Center/.test(s))).toBe(true);
  });

  it('throttles repeated wrong keys', async () => {
    for (let i = 0; i < 8; i++) await call('POST', '/api/control/authorize', { body: { email: 'nobody@scale.test', password: `wrong-${i}` } });
    const r = await call('POST', '/api/control/authorize', { body: { email: 'nobody@scale.test', password: 'wrong-again' } });
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('throttled');
  });
});

describe('the live workspace', () => {
  it('places team members in cities, with working hours', async () => {
    const bad = await call('PATCH', `/api/users/${ids.sarah}`, { cookie: manager, body: { city: 'Atlantis' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields.city).toBeTruthy();
    const r = await call('PATCH', `/api/users/${ids.sarah}`, { cookie: manager, body: { city: 'London, United Kingdom', workStart: 20, workEnd: 4 } });
    expect(r.status).toBe(200);
    const sarah = r.body.users.find((u: any) => u.id === ids.sarah);
    expect(sarah.city).toBe('London, United Kingdom');
    expect(sarah.workHours).toEqual([20, 28]);
    // on the globe straight away
    const w = (await call<ControlWorld>('GET', '/api/control/world', { cookie: manager })).body;
    expect(w.source).toMatchObject({ kind: 'workspace', unplaced: 2 });
    expect(w.writers.map((x) => [x.callsign, x.timezone, x.workHours])).toEqual([['SARAH', 'Europe/London', [20, 28]]]);
  });

  it('shows real batches, scripts and handoffs between the people placed', async () => {
    await call('PATCH', `/api/users/${ids.josh}`, { cookie: manager, body: { city: 'Toronto, Canada', workStart: 9, workEnd: 18 } });
    const client = (await call('POST', '/api/clients', { cookie: manager, body: { name: 'Downtown Dental' } })).body.clientId;
    const b = await call('POST', '/api/batches', { cookie: manager, body: { clientId: client, title: 'Master Script Batch', targetCount: 6, draftDue: '2026-10-02', finalDue: '2026-10-05', split: [{ writerId: ids.sarah, count: 6 }] } });
    expect(b.status).toBe(200);
    const batchId = b.body.id ?? b.body.batch?.id;
    const scripts = (await call('GET', `/api/batches/${batchId}`, { cookie: manager })).body.scripts as { id: number }[];
    expect((await call('POST', `/api/batches/${batchId}/scripts/action`, { cookie: writer, body: { action: 'submit', scriptIds: scripts.slice(0, 3).map((s) => s.id) } })).status).toBe(200);
    expect((await call('POST', `/api/batches/${batchId}/scripts/action`, { cookie: manager, body: { action: 'approve', scriptIds: [scripts[0].id] } })).status).toBe(200);

    const w = (await call<ControlWorld>('GET', '/api/control/world', { cookie: manager })).body;
    expect(w.source).toMatchObject({ kind: 'workspace', label: 'LIVE WORKSPACE', unplaced: 1 }) // Maya has no city yet;
    expect(w.writers.map((x) => [x.callsign, x.cityCode, x.timezone])).toEqual(expect.arrayContaining([['JOSH', 'TOR', 'America/Toronto'], ['SARAH', 'LON', 'Europe/London']]));
    const project = w.projects.find((p) => p.title === 'Master Script Batch')!;
    expect(project.client).toBe('Downtown Dental');
    expect(project.progress).toEqual({ done: 1, total: 6 });
    expect(w.scripts.filter((s) => s.projectId === project.id).map((s) => s.state).sort()).toEqual(['approved', 'internal_review', 'internal_review', 'research', 'research', 'research']);
    const sarah = w.writers.find((x) => x.callsign === 'SARAH')!;
    expect(sarah.currentAssignment).toBe('Master Script Batch');
    expect(sarah.workHours).toEqual([20, 28]);
    // the submission and the review travel between the two cities
    expect(w.handoffs.map((h) => [h.originNode, h.destinationNode, h.state])).toEqual(expect.arrayContaining([
      [sarah.id, `u${ids.josh}`, 'REVIEW QUEUED'], [`u${ids.josh}`, sarah.id, 'APPROVED'],
    ]));
    expect(w.links).toEqual(expect.arrayContaining([expect.objectContaining({ from: sarah.id, to: `u${ids.josh}`, kind: 'review', active: true })]));
    expect(w.activity.length).toBeGreaterThan(0);
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
    const w = (await call<ControlWorld>('GET', '/api/control/world', { cookie: manager })).body;
    expect(w.writers.find((x) => x.callsign === 'SARAH')!.timezone).toBe('Europe/Dublin');
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

  it('uses the simulated network only when the server asks for it', async () => {
    const w = await loadWorld({ ...ctx, controlData: 'simulated' });
    expect(w.source).toMatchObject({ kind: 'simulated', label: 'SIMULATED NETWORK' });
    expect((await loadWorld(ctx)).source.kind).toBe('workspace');
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
    const w = (await call<ControlWorld>('GET', '/api/control/world', { cookie: manager })).body;
    expect(w.writers.find((x) => x.id === `e${tomas.id}`)).toMatchObject({ timezone: 'Asia/Ho_Chi_Minh', workHours: [0, 24] });
    expect((await call('POST', '/api/editors', { cookie: manager, body: { name: 'X', city: 'Paris, France', timezone: 'Nowhere/Land' } })).status).toBe(400);
    await call('DELETE', `/api/editors/${tomas.id}`, { cookie: manager });
  });

  it('appear in the Control Center with their local time, but never as users', async () => {
    const [priya] = (await call('GET', '/api/editors', { cookie: manager })).body.editors;
    const w = (await call<ControlWorld>('GET', '/api/control/world', { cookie: manager })).body;
    const node = w.writers.find((x) => x.id === `e${priya.id}`)!;
    expect(node).toMatchObject({ role: 'editor', timezone: 'Asia/Kolkata', workHours: [22, 30] });
    expect(w.scripts.some((s) => s.writerId === node.id)).toBe(false);
    const users = (await call('GET', '/api/users', { cookie: manager })).body.users as { name: string }[];
    expect(users.some((u) => u.name === 'Priya Editor')).toBe(false);
    expect((await call('POST', '/api/auth/login', { body: { email: 'priya@scale.test', password: 'anything-at-all' } })).status).toBe(401);
  });

  it('can be edited and removed', async () => {
    const [priya] = (await call('GET', '/api/editors', { cookie: manager })).body.editors;
    const e = await call('PATCH', `/api/editors/${priya.id}`, { cookie: manager, body: { name: 'Priya Editor', city: 'Berlin, Germany', workStart: 9, workEnd: 17 } });
    expect(e.body.editors[0]).toMatchObject({ city: 'Berlin, Germany', workHours: [9, 17] });
    expect((await call('DELETE', `/api/editors/${priya.id}`, { cookie: manager })).body.editors).toEqual([]);
    const w = (await call<ControlWorld>('GET', '/api/control/world', { cookie: manager })).body;
    expect(w.writers.some((x) => x.id === `e${priya.id}`)).toBe(false);
    expect((await call('DELETE', `/api/editors/${priya.id}`, { cookie: manager })).status).toBe(404);
  });
});
