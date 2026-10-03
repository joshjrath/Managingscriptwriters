// Workspace-wide operations, each on its own database so they can't disturb
// the long scenario in api.test.ts: recalculating deadlines when the rules
// change, archiving a batch, and seeding the demo workspace.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { openDb, type Db } from '../server/db';
import type { Ctx } from '../server/core';
import { seedDemo } from '../server/seed-demo';
import type { BatchDetail } from '../shared/types';
import { freshDb } from './db';

const NOW = new Date('2026-09-28T16:00:00Z'); // Monday noon in New York
let db: Db;
let app: FastifyInstance;
let admin = '';
let writer = '';
let writerId = 0;
let clientId = 0;

const send = async (method: string, url: string, cookie: string, body?: unknown) => {
  const r = await app.inject({
    method: method as 'POST', url, headers: { 'x-scale-media': '1', cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
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
  clientId = JSON.parse((await json('/api/clients', { name: 'Acme' }, admin)).body).clientId;
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('changing the deadline rules', () => {
  it('moves automatic deadlines only, and tells the writers', async () => {
    const shoot = (start: string) => send('POST', '/api/shoots', admin, { clientId, startDate: start, endDate: null, batch: { targetCount: 2, split: [{ writerId, count: 2 }], briefingIds: [], priority: 'normal' } });
    const auto = (await shoot('2026-11-16')).body.batchId as number;
    const manual = (await shoot('2026-11-23')).body.batchId as number;
    expect((await send('PATCH', `/api/batches/${manual}`, admin, { finalDue: { mode: 'manual', date: '2026-11-21' } })).status).toBe(200);

    const r = await send('PATCH', '/api/settings', admin, { draftOffsetDays: 6, recalculate: true });
    expect(r.status).toBe(200);
    expect(r.body.recalculated).toBe(2);
    const get = async (id: number) => (await send('GET', `/api/batches/${id}`, admin)).body as BatchDetail;
    // drafts were 5 days before the shoot, now 6; final delivery stays 3 days before, or where it was set by hand
    expect(await get(auto)).toMatchObject({ draftDue: '2026-11-10', finalDue: '2026-11-13' });
    expect(await get(manual)).toMatchObject({ draftDue: '2026-11-17', finalDue: '2026-11-21', finalDueMode: 'manual' });
    const notes = (await send('GET', '/api/notifications', writer)).body.notifications;
    expect(notes.filter((n: { type: string }) => n.type === 'deadline_change').length).toBeGreaterThanOrEqual(2);
  });
});

describe('archiving a batch', () => {
  it('takes it out of the live lists and brings it back on restore', async () => {
    const b = await send('POST', '/api/batches', admin, { clientId, title: 'Old work', targetCount: 1, draftDue: '2026-09-28', finalDue: '2026-09-30', split: [{ writerId, count: 1 }] });
    const id = b.body.batchId as number;
    const listed = async (q = '') => (await send('GET', `/api/batches${q}`, admin)).body.batches.some((x: { id: number }) => x.id === id);
    const onToday = async () => (await send('GET', '/api/today', writer)).body.items.some((i: { batchId: number }) => i.batchId === id);
    expect([await listed(), await onToday()]).toEqual([true, true]);
    expect((await send('POST', `/api/batches/${id}/archive`, admin, { archived: true })).status).toBe(200);
    expect([await listed(), await onToday(), await listed('?archived=only')]).toEqual([false, false, true]);
    expect((await send('POST', `/api/batches/${id}/archive`, admin, { archived: false })).status).toBe(200);
    expect([await listed(), await onToday()]).toEqual([true, true]);
  });
});

describe('the demo workspace', () => {
  it('seeds an empty database once, and never one that has people in it', async () => {
    const demo = await openDb({ memory: true });
    try {
      expect(await seedDemo(demo, NOW)).toBe(true);
      expect((await demo.one<{ n: number }>(`select count(*) as n from batches`))!.n).toBeGreaterThan(0);
      expect(await seedDemo(demo, NOW)).toBe(false);
    } finally {
      await demo.close();
    }
  });
});
