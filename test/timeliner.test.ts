// Timeliner: a script document uploaded there marks its batch delivered by itself. Timeliner itself is a
// stand-in here (no network); the messages are signed the way Timeliner signs them.

import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import type { Db } from '../server/db';
import type { Ctx } from '../server/core';
import { clientFit, isScriptDocument, pickBatch, timelinerClient, verifySignature, type TimelinerApi } from '../server/timeliner';
import type { BatchDetail, TimelinerStatus } from '../shared/types';
import { freshDb } from './db';

const NOW = new Date('2026-10-08T16:00:00Z');
const SECRET = `whsec_${'ab'.repeat(32)}`;
let db: Db;
let app: FastifyInstance;
let admin = '';
let writer = '';
let writerId = 0;
let acme = 0;
let lumen = 0;

const calls: string[] = [];
const fake: TimelinerApi = {
  project: async (id) => ({ p_acme: { id, name: 'Acme Outdoor · Nov shoot' }, p_lumen: { id, name: 'Lumen Skincare launch' }, p_odd: { id, name: 'Misc uploads' } } as Record<string, { id: string; name: string }>)[id] ?? null,
  brand: async (id) => ({ b_acme: { id, name: 'Acme Outdoor' }, b_lumen: { id, name: 'Lumen' }, b_odd: { id, name: 'Somebody Else' } } as Record<string, { id: string; name: string }>)[id] ?? null,
  task: async () => null,
  tasks: async () => ({ data: [], nextBefore: null }),
  brands: async () => ({ data: [], nextBefore: null }),
  brandMembers: async () => [],
  lastMove: async () => null,
  members: async () => [{ id: 'm_wes', email: 'wes@scale.test', firstName: 'Wes', lastName: 'Writer' }, { id: 'm_ed', email: 'editor@agency.test', firstName: 'Ed', lastName: null }],
  webhooks: async () => [],
  createWebhook: async (url, events) => { calls.push(`create ${url} ${events.join(',')}`); return { id: 'wh_1', secret: SECRET }; },
  updateWebhook: async () => {},
  rotateSecret: async () => ({ secret: SECRET }),
  testWebhook: async () => ({ ok: true, statusCode: 200, error: null }),
};

const send = async (method: string, url: string, cookie: string, body?: unknown) => {
  const r = await app.inject({
    method: method as 'POST', url, headers: { 'x-scale-media': '1', cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
const sign = (raw: string, t = Math.floor(NOW.getTime() / 1000), secret = SECRET) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
let n = 0;
const upload = (data: Record<string, unknown>, opts: { id?: string; type?: string; signature?: (raw: string) => string; test?: boolean } = {}) => {
  const raw = JSON.stringify({ id: opts.id ?? `evt_${++n}`, type: opts.type ?? 'version.uploaded', apiVersion: '2026-06-02', createdAt: NOW.toISOString(), workspaceId: 'ws_1', ...(opts.test ? { test: true } : {}), data });
  // no x-scale-media header: Timeliner isn't our page, the signature is what counts
  return app.inject({ method: 'POST', url: '/hooks/timeliner', headers: { 'content-type': 'application/json', 'x-timeliner-signature': (opts.signature ?? sign)(raw) }, payload: raw });
};
/** an upload to its own Timeliner task, unless `taskId` says it's a version of one uploaded before */
let tasksMade = 0;
const doc = (projectId: string, brandId: string, fileName = 'Scripts 1-3.pdf', o: { taskId?: string; version?: number } = {}) => ({
  taskId: o.taskId ?? `t_${++tasksMade}`, projectId, brandId, taskTitle: 'Scripts', fileId: `f_${++tasksMade}`, fileName, mimeType: fileName.endsWith('.pdf') ? 'application/pdf' : 'video/mp4',
  size: 1000, versionNumber: o.version ?? 1, uploadedBy: 'm_wes', source: 'app', uploadedAt: NOW.toISOString(),
});
/** a batch of `count` scripts for the writer, sent as one document and approved */
async function approvedBatch(clientId: number, title: string, count = 3, approve = true): Promise<number> {
  const b = await send('POST', '/api/batches', admin, { clientId, title, targetCount: count, split: [{ writerId, count }] });
  expect(b.status).toBe(200);
  const id = b.body.batchId as number;
  const ids = ((await send('GET', `/api/batches/${id}`, admin)).body as BatchDetail).scripts.map((s) => s.id);
  expect((await send('POST', `/api/batches/${id}/submissions`, writer, { scriptIds: ids, url: 'https://docs.example/all' })).status).toBe(200);
  if (approve) expect((await send('POST', `/api/batches/${id}/review`, admin, { action: 'approve', scriptIds: ids })).status).toBe(200);
  return id;
}
const detail = async (id: number) => (await send('GET', `/api/batches/${id}`, admin)).body as BatchDetail;

beforeAll(async () => {
  db = await freshDb();
  const ctx: Ctx = { db, now: () => NOW, secureCookies: false, allowSetup: true, uploadLimitBytes: 1024 * 1024, timeliner: fake, publicUrl: 'https://scripts.example.com' };
  app = await buildApp(ctx);
  const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0];
  const json = (url: string, body: unknown, cookie?: string) =>
    app.inject({ method: 'POST', url, headers: { 'x-scale-media': '1', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, payload: JSON.stringify(body) });
  admin = cookieOf(await json('/api/auth/setup', { name: 'Ada Admin', email: 'ada@scale.test', password: 'admin-password-1' }));
  const added = JSON.parse((await json('/api/users', { name: 'Wes Writer', email: 'wes@scale.test', role: 'writer', password: 'team-password-1' }, admin)).body);
  writerId = added.users.find((u: { email: string }) => u.email === 'wes@scale.test').id;
  writer = cookieOf(await json('/api/auth/login', { email: 'wes@scale.test', password: 'team-password-1' }));
  acme = JSON.parse((await json('/api/clients', { name: 'Acme Outdoor Co.' }, admin)).body).clientId;
  lumen = JSON.parse((await json('/api/clients', { name: 'Lumen Skincare' }, admin)).body).clientId;
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('talking to Timeliner', () => {
  it('says which permissions the key needs when Timeliner refuses it', async () => {
    const refusing = (async () => new Response(JSON.stringify({ error: 'Insufficient scope', code: 'insufficient_scope', requiredScope: 'write:webhooks', grantedScopes: ['read:projects'] }), { status: 403 })) as typeof fetch;
    const api = timelinerClient('tlsk_test', 'https://timeliner.test', refusing);
    await expect(api.createWebhook('https://scripts.example.com/hooks/timeliner', ['version.uploaded'])).rejects.toThrow(
      'The Timeliner key isn’t allowed to write webhooks. In Timeliner → Settings → Developers, make a key with Tasks (read), Projects (read), Workspace (read) and Webhooks (read & write), put it in TIMELINER_API_KEY, and connect again.',
    );
  });

  it('reads the videos a page at a time and a video’s last step move, waiting when Timeliner asks', async () => {
    const asked: string[] = [];
    let limited = true;
    const answer = (async (url: string | URL | Request) => {
      const path = String(url).replace('https://timeliner.test/api/v1', '');
      asked.push(path);
      if (path.startsWith('/tasks?') && limited) { limited = false; return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), { status: 429, headers: { 'retry-after': '0' } }); }
      if (path.includes('/activity')) return new Response(JSON.stringify({ data: [{ id: 'a1', createdAt: '2026-10-07T17:15:00Z', action: 'moved', movedTo: 'Needs review', actor: { id: 'm_leo' } }], hasMore: true }));
      return new Response(JSON.stringify({ data: [{ id: 't1', title: 'Organic 01' }], nextBefore: null }));
    }) as typeof fetch;
    const api = timelinerClient('tlsk_test', 'https://timeliner.test', answer);
    expect(await api.tasks('2026-10-01T00:00:00.000Z')).toEqual({ data: [{ id: 't1', title: 'Organic 01' }], nextBefore: null });
    expect(await api.lastMove('t1')).toEqual({ at: '2026-10-07T17:15:00Z', to: 'Needs review', byId: 'm_leo' });
    const page = '/tasks?limit=100&before=2026-10-01T00%3A00%3A00.000Z';
    expect(asked).toEqual([page, page, '/tasks/t1/activity?action=moved&limit=1']);
  });
  it('says what Timeliner answered, and never takes an answer that isn’t a list for an empty one', async () => {
    const answer = (status: number, body: unknown) => (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as typeof fetch;
    const tl = (f: typeof fetch) => timelinerClient('tlsk_test', 'https://timeliner.test', f);
    await expect(tl(answer(500, { error: 'Internal server error' })).tasks(null)).rejects.toThrow('Timeliner answered 500: Internal server error.');
    // an error in another shape still says what it was
    await expect(tl(answer(502, { error: { message: 'Upstream  timed out.' } })).tasks(null)).rejects.toThrow('Timeliner answered 502: Upstream timed out.');
    await expect(tl(answer(503, '<html>down</html>')).tasks(null)).rejects.toThrow('Timeliner answered 503.');
    // a 200 that isn't a list (or a list that isn't there) would read as "nothing in Timeliner" and empty the copy
    await expect(tl(answer(200, {})).tasks(null)).rejects.toThrow('Timeliner’s answer for /tasks wasn’t a list, so the last copy is kept.');
    await expect(tl(answer(200, '<html>sign in</html>')).brands(null)).rejects.toThrow('Timeliner’s answer for /brands wasn’t a list');
    await expect(tl(answer(404, {})).tasks(null)).rejects.toThrow('wasn’t a list');
    await expect(tl(answer(200, { data: { id: 'm1' } })).members()).rejects.toThrow('Timeliner’s answer for /members wasn’t a list');
    // a step move with odd fields: only what can be used
    expect(await tl(answer(200, { data: [{ createdAt: '2026-10-07T17:15:00Z', movedTo: { name: 'x' }, actor: null }] })).lastMove('t1')).toEqual({ at: '2026-10-07T17:15:00Z', to: null, byId: null });
    expect(await tl(answer(200, { data: [{ createdAt: 12 }] })).lastMove('t1')).toBeNull();
  });
});

describe('matching helpers', () => {
  it('checks Timeliner’s signature, and refuses an old or altered message', () => {
    const t = 1_800_000_000;
    const raw = '{"id":"x"}';
    expect(verifySignature(SECRET, sign(raw, t), raw, t + 10)).toBe(true);
    expect(verifySignature(SECRET, sign(raw, t), '{"id":"y"}', t)).toBe(false);
    expect(verifySignature(SECRET, sign(raw, t, `whsec_${'cd'.repeat(32)}`), raw, t)).toBe(false);
    expect(verifySignature(SECRET, sign(raw, t), raw, t + 301)).toBe(false);
    expect(verifySignature(SECRET, undefined, raw, t)).toBe(false);
    expect(verifySignature(SECRET, 'v1=abc', raw, t)).toBe(false);
  });
  it('counts documents, not videos', () => {
    expect(isScriptDocument('Scripts 1-12.pdf', null)).toBe(true);
    expect(isScriptDocument('scripts', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true);
    expect(isScriptDocument('cut v3.mp4', 'video/mp4')).toBe(false);
    expect(isScriptDocument('thumb.png', 'image/png')).toBe(false);
  });
  it('fits a Timeliner brand or project name to a client', () => {
    expect(clientFit('Lumen Skincare', 'Lumen')).toBeGreaterThan(0);
    expect(clientFit('Old Mill Bakery', 'Old Mill Bakery · Winter specials')).toBeGreaterThan(0);
    expect(clientFit('Acme Outdoor Co.', 'ACME outdoor')).toBeGreaterThan(0);
    expect(clientFit('Lumen Skincare', 'Northwind Coffee')).toBe(0);
  });
  it('picks the batch a project name points at, and doesn’t guess between equals', () => {
    const c = (id: number, title: string, shoot: string | null) => ({ id, title, client_id: 1, client_name: 'Acme', shoot_date: shoot, final_due: null, approved: 1 });
    expect(pickBatch([c(1, 'Acme · Oct 12 shoot', '2026-10-12'), c(2, 'Acme · Nov 17 shoot', '2026-11-17')], 'Acme Nov 17 scripts')?.id).toBe(2);
    expect(pickBatch([c(1, 'Spring', null), c(2, 'Autumn', null)], 'Acme scripts')).toBeNull();
    expect(pickBatch([c(3, 'Only one', null)], 'anything')?.id).toBe(3);
  });
});

describe('Timeliner uploads deliver batches', () => {
  it('connects by registering the webhook with Timeliner', async () => {
    const r = await send('POST', '/api/timeliner/connect', admin, {});
    expect(r.status).toBe(200);
    expect(calls).toEqual(['create https://scripts.example.com/hooks/timeliner version.uploaded,file.uploaded,task.created,task.updated,task.status_changed,task.trashed,project.trashed']);
    const s = r.body as TimelinerStatus;
    expect(s).toMatchObject({ keySet: true, webhookUrl: 'https://scripts.example.com/hooks/timeliner', connected: { byName: 'Ada Admin' } });
    // writers can't see or change it
    expect((await send('GET', '/api/timeliner', writer)).status).toBe(403);
  });

  it('refuses a message that isn’t signed by Timeliner, or is too old', async () => {
    const id = await approvedBatch(acme, 'Acme · Nov shoot');
    expect((await upload(doc('p_acme', 'b_acme'), { signature: () => 't=1,v1=' + '0'.repeat(64) })).statusCode).toBe(401);
    expect((await upload(doc('p_acme', 'b_acme'), { signature: (raw) => sign(raw, Math.floor(NOW.getTime() / 1000) - 600) })).statusCode).toBe(401);
    expect((await detail(id)).progress.delivered).toBe(0);
  });

  it('delivers the batch when its script PDF lands in the client’s Timeliner project, once', async () => {
    const id = (await db.one<{ id: number }>(`select id from batches where title = 'Acme · Nov shoot'`))!.id;
    const r = await upload(doc('p_acme', 'b_acme'), { id: 'evt_acme' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).outcome).toBe('delivered');
    const b = await detail(id);
    expect(b.progress.delivered).toBe(3);
    expect(b.deliveries).toHaveLength(1);
    // recorded under the uploader (on the team by email) and labelled as Timeliner's confirmation
    expect(b.deliveries[0]).toMatchObject({ verification: 'timeliner', confirmedByName: 'Wes Writer', scriptNumbers: [1, 2, 3] });
    expect(b.activity[0].summary).toMatch(/^Timeliner confirmed delivery of scripts 1–3: “Scripts 1-3\.pdf” landed in Timeliner, uploaded by Wes Writer/);
    // Timeliner may send the same message twice: it's acted on once
    const again = await upload(doc('p_acme', 'b_acme'), { id: 'evt_acme' });
    expect(JSON.parse(again.body).outcome).toBe('duplicate');
    expect((await detail(id)).deliveries).toHaveLength(1);
    // and the batch now knows its Timeliner project
    expect((await db.one<{ p: string }>(`select timeliner_project_id as p from batches where id = $1`, [id]))?.p).toBe('p_acme');
  });

  it('ignores videos and images (the editors’ uploads)', async () => {
    const id = await approvedBatch(lumen, 'Lumen launch');
    const r = await upload(doc('p_lumen', 'b_lumen', 'launch cut v2.mp4'));
    expect(JSON.parse(r.body).outcome).toBe('ignored');
    expect((await detail(id)).progress.delivered).toBe(0);
  });

  it('keeps an upload it can’t place for a manager, who picks the batch', async () => {
    const lumenBatch = (await db.one<{ id: number }>(`select id from batches where title = 'Lumen launch'`))!.id;
    const r = await upload(doc('p_odd', 'b_odd', 'Final scripts.pdf', { taskId: 't_odd' }), { id: 'evt_odd' });
    expect(JSON.parse(r.body).outcome).toBe('unmatched');
    const notes = (await send('GET', '/api/notifications', admin)).body.notifications;
    expect(notes[0]).toMatchObject({ title: 'Timeliner upload needs a batch', link: '/settings#timeliner' });
    const s = (await send('GET', '/api/timeliner', admin)).body as TimelinerStatus;
    expect(s.events.find((e) => e.id === 'evt_odd')).toMatchObject({ outcome: 'unmatched', fileName: 'Final scripts.pdf', where: 'Somebody Else › Misc uploads › Scripts', uploader: 'Wes Writer' });
    expect(s.openBatches.map((b) => b.id)).toContain(lumenBatch);

    expect((await send('POST', '/api/timeliner/events/evt_odd/assign', writer, { batchId: lumenBatch })).status).toBe(403);
    const placed = await send('POST', '/api/timeliner/events/evt_odd/assign', admin, { batchId: lumenBatch });
    expect(placed.status).toBe(200);
    expect((placed.body as TimelinerStatus).events.find((e) => e.id === 'evt_odd')).toMatchObject({ outcome: 'delivered', batch: { id: lumenBatch, title: 'Lumen launch' } });
    const b = await detail(lumenBatch);
    expect(b.progress.delivered).toBe(3);
    expect(b.deliveries[0]).toMatchObject({ verification: 'timeliner', confirmedByName: 'Ada Admin' });
    // placed once is enough: the PDF is linked to that batch, and its next version follows by itself
    expect((await send('POST', '/api/timeliner/events/evt_odd/assign', admin, { batchId: lumenBatch })).status).toBe(409);
    const next = await upload(doc('p_odd', 'b_odd', 'Final scripts v2.pdf', { taskId: 't_odd', version: 2 }));
    expect(JSON.parse(next.body).outcome).toBe('new_version');
  });

  it('delivers nothing when the batch’s scripts aren’t approved yet, and says so', async () => {
    const id = await approvedBatch(acme, 'Acme · Dec shoot', 2, false);
    // a second Acme batch would be ambiguous by name alone, so link this one as if placed before
    await db.query(`update batches set timeliner_project_id = 'p_acme_dec' where id = $1`, [id]);
    const r = await upload(doc('p_acme_dec', 'b_acme', 'Dec scripts.pdf'));
    expect(JSON.parse(r.body).outcome).toBe('nothing_approved');
    expect((await detail(id)).progress.delivered).toBe(0);
    expect((await send('GET', '/api/notifications', admin)).body.notifications[0].title).toBe('In Timeliner, not approved yet · Acme Outdoor Co.');
  });

  it('records Timeliner’s test message', async () => {
    const r = await upload({ fileName: 'sample.pdf' }, { test: true });
    expect(JSON.parse(r.body).outcome).toBe('test');
    expect((await send('GET', '/api/timeliner', admin)).body.testAt).toBe(NOW.toISOString());
  });
});
