// Two workspace-wide controls on one database: deleting a batch for good (managers), with everything that hangs off
// it, while its shoot, the client's resources and to-dos and the history stay; and the sidebar order the Admin
// arranges for everyone (applyNavOrder, PUT /api/settings/nav-order).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import type { Db } from '../server/db';
import type { Ctx } from '../server/core';
import type { BatchDetail, Bootstrap } from '../shared/types';
import { applyNavOrder, tidyNavOrder } from '../shared/workflow';
import { freshDb } from './db';

let db: Db;
let app: FastifyInstance;
let admin = '';
let manager = '';
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
  const ctx: Ctx = { db, now: () => new Date('2026-10-28T16:00:00Z'), secureCookies: false, allowSetup: true, uploadLimitBytes: 1024 * 1024 };
  app = await buildApp(ctx);
  const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0];
  const json = (url: string, body: unknown, cookie?: string) =>
    app.inject({ method: 'POST', url, headers: { 'x-scale-media': '1', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, payload: JSON.stringify(body) });
  admin = cookieOf(await json('/api/auth/setup', { name: 'Ada Admin', email: 'ada@scale.test', password: 'admin-password-1' }));
  for (const [name, email, role] of [['Max Manager', 'max@scale.test', 'manager'], ['Wes Writer', 'wes@scale.test', 'writer']]) {
    const added = JSON.parse((await json('/api/users', { name, email, role, password: 'team-password-1' }, admin)).body);
    if (role === 'writer') writerId = added.users.find((u: { email: string }) => u.email === email).id;
  }
  manager = cookieOf(await json('/api/auth/login', { email: 'max@scale.test', password: 'team-password-1' }));
  writer = cookieOf(await json('/api/auth/login', { email: 'wes@scale.test', password: 'team-password-1' }));
  clientId = JSON.parse((await json('/api/clients', { name: 'Acme' }, admin)).body).clientId;
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('deleting a batch', () => {
  it('removes it and everything hanging off it, for managers only; the shoot, resources, to-dos and history stay', async () => {
    const shoot = await send('POST', '/api/shoots', manager, { clientId, startDate: '2026-11-16', endDate: null, batch: { targetCount: 3, split: [{ writerId, count: 3 }], briefingIds: [], priority: 'normal' } });
    expect(shoot.status).toBe(200);
    const id = shoot.body.batchId as number;
    const shootId = shoot.body.shootId as number;
    const scripts = (await send('GET', `/api/batches/${id}`, writer)).body.scripts as BatchDetail['scripts'];
    const [one, two, three] = scripts.map((s) => s.id);
    // a full history: a document sent, sent back with a note, sent again, approved, delivered, the counter, a to-do and a resource
    const first = await send('POST', `/api/batches/${id}/submissions`, writer, { scriptIds: [one, two], url: 'https://docs.google.com/document/d/one' });
    expect(first.status).toBe(200);
    expect((await send('POST', `/api/batches/${id}/review`, manager, { action: 'revisions', scriptIds: [one], note: 'Tighten the hook' })).status).toBe(200);
    expect((await send('POST', `/api/batches/${id}/submissions`, writer, { scriptIds: [one], url: 'https://docs.google.com/document/d/two' })).status).toBe(200);
    expect((await send('POST', `/api/batches/${id}/review`, manager, { action: 'approve', scriptIds: [one, two] })).status).toBe(200);
    expect((await send('POST', `/api/batches/${id}/scripts/action`, manager, { action: 'deliver', scriptIds: [one], timelinerUrl: 'https://timeliner.io/x' })).status).toBe(200);
    expect((await send('POST', `/api/batches/${id}/written`, writer, { written: 3 })).status).toBe(200);
    const todo = await send('POST', '/api/todos', writer, { text: 'Read the brief', batchId: id });
    expect(todo.status).toBe(200);
    const res = await send('POST', '/api/resources', manager, { clientId, batchId: id, category: 'document', title: 'Brief', url: 'https://docs.example/brief' });
    expect(res.status).toBe(200);
    expect(await db.one<{ n: number }>(`select count(*)::int as n from deliveries where batch_id = $1`, [id])).toEqual({ n: 1 });

    // writers can't, and nothing changes
    expect((await send('DELETE', `/api/batches/${id}`, writer)).status).toBe(403);
    expect((await send('GET', `/api/batches/${id}`, manager)).status).toBe(200);

    const del = await send('DELETE', `/api/batches/${id}`, manager);
    expect([del.status, del.body]).toEqual([200, { ok: true, clientId, title: expect.any(String) }]);
    expect((await send('GET', `/api/batches/${id}`, manager)).status).toBe(404);
    expect((await send('DELETE', `/api/batches/${id}`, manager)).status).toBe(404);
    for (const table of ['scripts', 'submissions', 'reviews', 'revision_requests', 'deliveries', 'writer_progress', 'moments']) {
      expect([table, await db.one<{ n: number }>(`select count(*)::int as n from ${table} where batch_id = $1`, [id])]).toEqual([table, { n: 0 }]);
    }
    expect(await db.one<{ n: number }>(`select count(*)::int as n from scripts where id = any($1::bigint[])`, [[one, two, three]])).toEqual({ n: 0 });
    // the shoot stays, with no scripts planned; the resource and the to-do stay, no longer tied to it
    expect(await db.one(`select id from shoots where id = $1 and cancelled_at is null`, [shootId])).toBeTruthy();
    expect(await db.one<{ batch_id: number | null }>(`select batch_id from resources where client_id = $1 and title = 'Brief'`, [clientId])).toEqual({ batch_id: null });
    expect(await db.one<{ batch_id: number | null }>(`select batch_id from todos where text = 'Read the brief'`)).toEqual({ batch_id: null });
    // the history keeps its lines, without the batch, and says it was deleted
    expect(Number((await db.one<{ n: number }>(`select count(*)::int as n from activity where client_id = $1 and batch_id is null and action like 'batch.%'`, [clientId]))!.n)).toBeGreaterThan(0);
    expect(await db.one<{ summary: string }>(`select summary from activity where action = 'batch.deleted' and entity_id = $1`, [id])).toEqual({ summary: expect.stringMatching(/^Deleted the batch “.+” \(3 scripts\)$/) });
    // and the writer's lists move on
    expect((await send('GET', '/api/my-work', writer)).body.batches).toEqual([]);
  });
});

describe('arranging the sidebar', () => {
  const items = (...to: string[]) => to.map((x) => ({ to: x }));

  it('puts each menu’s items in the saved order, in their own slots, and leaves a home where it is', () => {
    const order = ['/calendar', '/content', '/scripts', '/clients', '/resources'];
    const editor = items('/editor', '/content', '/calendar', '/scripts', '/clients', '/resources');
    expect(applyNavOrder(editor, order).map((x) => x.to)).toEqual(['/editor', '/calendar', '/content', '/scripts', '/clients', '/resources']);
    // an item the order doesn't name (one added since) keeps its slot; no order is the usual one
    expect(applyNavOrder(items('/my-work', '/calendar', '/new', '/content'), ['/calendar', '/content', '/my-work']).map((x) => x.to)).toEqual(['/calendar', '/content', '/new', '/my-work']);
    expect(applyNavOrder(editor, null)).toBe(editor);
    expect(tidyNavOrder(['/calendar', '/nope', '/calendar', 3, '/content'])).toEqual(['/calendar', '/content']);
    expect(tidyNavOrder('x')).toBeNull();
    expect(tidyNavOrder([])).toBeNull();
  });

  it('only the Admin saves it, and everyone gets it', async () => {
    const order = ['/content', '/calendar', '/my-work', '/overview'];
    expect((await send('PUT', '/api/settings/nav-order', manager, { order })).status).toBe(403);
    const bad = await send('PUT', '/api/settings/nav-order', admin, { order: ['/content', '/hacked'] });
    expect(bad.status).toBe(400);
    expect((await send('PUT', '/api/settings/nav-order', admin, { order: ['/content', '/content'] })).status).toBe(400);
    const ok = await send('PUT', '/api/settings/nav-order', admin, { order });
    expect([ok.status, ok.body.settings.navOrder]).toEqual([200, order]);
    const boot = (await send('GET', '/api/bootstrap', writer)).body as Bootstrap;
    expect(boot.settings.navOrder).toEqual(order);
    // null puts it back
    expect((await send('PUT', '/api/settings/nav-order', admin, { order: null })).body.settings.navOrder).toBeNull();
    expect(((await send('GET', '/api/bootstrap', writer)).body as Bootstrap).settings.navOrder).toBeNull();
  });
});
