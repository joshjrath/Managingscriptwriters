// End-to-end API tests through the real HTTP routes, on embedded Postgres
// (PGlite) by default, or on a real PostgreSQL when TEST_DATABASE_URL is set:
//   TEST_DATABASE_URL=postgres://… npm test
// Each test file gets a clean database and a fixed clock.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { openDb, type Db } from '../server/db';
import { MIGRATIONS } from '../server/schema';
import { runReminders } from '../server/reminders';
import type { Ctx } from '../server/core';
import type { BatchDetail, Dashboard, Moment } from '../shared/types';

// Monday Sep 28, 2026, noon in New York
let NOW = new Date('2026-09-28T16:00:00Z');

async function freshDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return openDb({ memory: true });
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('drop schema public cascade; create schema public;');
  await c.end();
  return openDb({ databaseUrl: url });
}

let db: Db;
let app: FastifyInstance;
let ctx: Ctx;

type Res<T = any> = { status: number; body: T; headers: Record<string, unknown> };
async function call<T = any>(method: string, url: string, opts: { body?: unknown; cookie?: string; noCsrf?: boolean } = {}): Promise<Res<T>> {
  const headers: Record<string, string> = {};
  if (!opts.noCsrf) headers['x-scale-media'] = '1';
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const r = await app.inject({ method: method as 'GET', url, headers, payload: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  let body: any = r.body;
  try { body = JSON.parse(r.body); } catch { /* not json */ }
  return { status: r.statusCode, body, headers: r.headers };
}
const as = (cookie: string) => ({
  cookie,
  get: <T = any>(u: string) => call<T>('GET', u, { cookie }),
  post: <T = any>(u: string, body: unknown = {}) => call<T>('POST', u, { cookie, body }),
  patch: <T = any>(u: string, body: unknown) => call<T>('PATCH', u, { cookie, body }),
  del: <T = any>(u: string) => call<T>('DELETE', u, { cookie }),
});
async function login(email: string, password: string) {
  const r = await call('POST', '/api/auth/login', { body: { email, password } });
  expect(r.status).toBe(200);
  return String(r.headers['set-cookie']).split(';')[0];
}

let manager: ReturnType<typeof as>;
let sarah: ReturnType<typeof as>;
let marcus: ReturnType<typeof as>;
let ids: { sarah: number; marcus: number; josh: number };
let acmeId: number;

beforeAll(async () => {
  db = await freshDb();
  ctx = { db, now: () => NOW, secureCookies: false, allowSetup: true, uploadLimitBytes: 5 * 1024 * 1024 };
  app = await buildApp(ctx);
  const setup = await call('POST', '/api/auth/setup', { body: { name: 'Josh Rath', email: 'josh@scale.test', password: 'correct-horse-battery' } });
  expect(setup.status).toBe(200);
  manager = as(String(setup.headers['set-cookie']).split(';')[0]);
  for (const [name, email] of [['Sarah Chen', 'sarah@scale.test'], ['Marcus Webb', 'marcus@scale.test']]) {
    const r = await manager.post('/api/users', { name, email, role: 'writer', password: 'writer-password-1' });
    expect(r.status).toBe(200);
  }
  const users = (await manager.get('/api/users')).body.users as { id: number; name: string }[];
  ids = { josh: users.find((u) => u.name === 'Josh Rath')!.id, sarah: users.find((u) => u.name === 'Sarah Chen')!.id, marcus: users.find((u) => u.name === 'Marcus Webb')!.id };
  sarah = as(await login('sarah@scale.test', 'writer-password-1'));
  marcus = as(await login('marcus@scale.test', 'writer-password-1'));
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('clients and briefing materials', () => {
  it('a manager creates a client with a recording and a document, and uploads a file', async () => {
    const r = await manager.post('/api/clients', {
      name: 'Acme Outdoor Co.', brandVoice: 'Warm and dry', guidance: 'One product per script',
      briefing: { title: 'Ideation call', callDate: '2026-09-22', recordingUrl: 'https://app.phantom.example/rec/1', documentUrl: 'https://docs.example/brief', summary: 'Autumn range', instructions: 'Under 40s' },
      links: [{ title: 'Brand folder', url: 'https://drive.example/acme', category: 'folder' }],
    });
    expect(r.status).toBe(200);
    acmeId = r.body.clientId;
    expect(r.body.briefingId).toBeTruthy();
    const c = (await manager.get(`/api/clients/${acmeId}`)).body;
    expect(c.brandVoice).toBe('Warm and dry');
    expect(c.resources.map((x: any) => x.title)).toContain('Brand folder');
  });

  it('stores uploads privately: signed-in users can open them, anonymous requests cannot', async () => {
    const cookie = manager.cookie;
    const detail = await as(cookie).get(`/api/clients/${acmeId}`);
    const briefing = detail.body.briefings[0];
    expect(briefing.recordingUrl).toBe('https://app.phantom.example/rec/1');
    expect(briefing.documentUrl).toBe('https://docs.example/brief');

    const boundary = '----smtest2';
    const payload = [
      `--${boundary}\r\nContent-Disposition: form-data; name="clientId"\r\n\r\n${acmeId}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="briefingId"\r\n\r\n${briefing.id}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="call-notes.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4 hello`,
      `--${boundary}--\r\n`,
    ].join('\r\n');
    const up = await app.inject({ method: 'POST', url: '/api/resources/upload', headers: { 'x-scale-media': '1', cookie, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
    expect(up.statusCode).toBe(200);
    const fileId = JSON.parse(up.body).resource.fileId;
    const got = await app.inject({ method: 'GET', url: `/api/files/${fileId}`, headers: { cookie } });
    expect(got.statusCode).toBe(200);
    expect(got.body).toContain('%PDF-1.4 hello');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    const anon = await app.inject({ method: 'GET', url: `/api/files/${fileId}` });
    expect(anon.statusCode).toBe(401);
    const withBriefing = await as(cookie).get(`/api/clients/${acmeId}`);
    expect(withBriefing.body.briefings[0].resources.map((r: any) => r.fileName)).toContain('call-notes.pdf');
  });

  it('refuses duplicate client names', async () => {
    const r = await manager.post('/api/clients', { name: 'acme outdoor co.' });
    expect(r.status).toBe(409);
    expect(r.body.error.fields.name).toBeTruthy();
  });
});

let batchId: number;

describe('shoots and deadlines', () => {
  it('an Oct 12–13, 2026 shoot generates Oct 7 and Oct 9 deadlines, split 20/25 across two writers', async () => {
    const r = await manager.post('/api/shoots', {
      clientId: acmeId, startDate: '2026-10-12', endDate: '2026-10-13',
      batch: { targetCount: 45, split: [{ writerId: ids.sarah, count: 20 }, { writerId: ids.marcus, count: 25 }] },
    });
    expect(r.status).toBe(200);
    batchId = r.body.batchId;
    const b = r.body.batch;
    expect(b.draftDue).toBe('2026-10-07');
    expect(b.finalDue).toBe('2026-10-09');
    expect(b.draftDueMode).toBe('auto');
    expect(b.shootStart).toBe('2026-10-12');
    expect(b.shootEnd).toBe('2026-10-13');
    expect(b.progress.total).toBe(45);
    expect(b.progress.unassigned).toBe(0);
    expect(b.writers.map((w: any) => [w.name, w.ranges, w.count])).toEqual([['Sarah Chen', '1–20', 20], ['Marcus Webb', '21–45', 25]]);
    const detail = (await manager.get(`/api/batches/${batchId}`)).body as BatchDetail;
    expect(detail.draftRule).toBe('5 calendar days before shoot starts');
    // every script has exactly one owner: no double counting
    expect(new Set(detail.scripts.map((s) => s.id)).size).toBe(45);
    expect(detail.scripts.filter((s) => s.assigneeId === ids.sarah)).toHaveLength(20);
    expect(detail.scripts.filter((s) => s.assigneeId === ids.marcus)).toHaveLength(25);
  });

  it('an Oct 13, 2026 shoot generates Oct 8 and Oct 10 deadlines', async () => {
    const r = await manager.post('/api/shoots', { clientId: acmeId, startDate: '2026-10-13', batch: { targetCount: 5, split: [] } });
    expect(r.body.batch).toMatchObject({ draftDue: '2026-10-08', finalDue: '2026-10-10' });
    expect(r.body.warnings.join(' ')).toMatch(/5 scripts unassigned/);
  });

  it('flags deadlines already in the past', async () => {
    const r = await manager.post('/api/shoots', { clientId: acmeId, startDate: '2026-09-30', batch: { targetCount: 2, split: [{ writerId: ids.sarah, count: 2 }] } });
    expect(r.body.warnings.join(' ')).toMatch(/already passed/);
    expect(r.body.batch.draft.overdue).toBe(true);
  });

  it('a batch can exist without a shoot, with manual deadlines', async () => {
    const r = await manager.post('/api/batches', { clientId: acmeId, title: 'Initial 5 scripts', targetCount: 5, draftDue: '2026-10-02', finalDue: '2026-10-05', split: [] });
    expect(r.status).toBe(200);
    expect(r.body.batch).toMatchObject({ shootId: null, draftDue: '2026-10-02', draftDueMode: 'manual', finalDue: '2026-10-05' });
    expect(r.body.batch.progress.unassigned).toBe(5);
  });

  it('validates fields and reports them individually', async () => {
    const r = await manager.post('/api/shoots', { clientId: acmeId, startDate: '2026-10-12', endDate: '2026-10-10', batch: { targetCount: 0, split: [] } });
    expect(r.status).toBe(400);
    expect(r.body.error.fields).toHaveProperty(['batch.targetCount']);
  });
});

describe('progress, review and Timeliner delivery', () => {
  const scriptsOf = async (who = manager) => ((await who.get(`/api/batches/${batchId}`)).body as BatchDetail).scripts;

  it('twenty draft-ready scripts display as 20 / 45 and 44%', async () => {
    const s = await scriptsOf();
    const sarahs = s.filter((x) => x.assigneeId === ids.sarah).map((x) => x.id);
    const r = await sarah.post(`/api/batches/${batchId}/scripts/action`, { action: 'submit', scriptIds: sarahs });
    expect(r.status).toBe(200);
    expect(r.body.batch.progress).toMatchObject({ draftReady: 20, total: 45, pctDraft: 44, approved: 0, delivered: 0 });
    expect(r.body.batch.stage).toBe('writing');
  });

  it('draft completion does not mark anything approved or delivered', async () => {
    const s = await scriptsOf();
    const r = await marcus.post(`/api/batches/${batchId}/scripts/action`, { action: 'submit', scriptIds: s.filter((x) => x.assigneeId === ids.marcus).map((x) => x.id) });
    expect(r.body.batch.progress).toMatchObject({ draftReady: 45, approved: 0, delivered: 0 });
    expect(r.body.batch.stage).toBe('in_review');
    expect(r.body.batch.final.complete).toBe(false);
  });

  it('supports partial review and revision requests', async () => {
    const s = await scriptsOf();
    const first10 = s.filter((x) => x.number <= 10).map((x) => x.id);
    const a = await manager.post(`/api/batches/${batchId}/scripts/action`, { action: 'approve', scriptIds: first10 });
    expect(a.body.batch.progress).toMatchObject({ approved: 10, inReview: 35 });
    const rev = await manager.post(`/api/batches/${batchId}/scripts/action`, { action: 'request_revisions', scriptIds: [s.find((x) => x.number === 21)!.id], note: 'Tighten the hook' });
    expect(rev.status).toBe(200);
    expect(rev.body.batch.progress).toMatchObject({ revisions: 1, draftReady: 44 });
    expect(rev.body.batch.unresolvedRevisions).toBe(1);
    const noNote = await manager.post(`/api/batches/${batchId}/scripts/action`, { action: 'request_revisions', scriptIds: [s[30].id] });
    expect(noNote.status).toBe(400);
    const queue = (await manager.get('/api/review')).body;
    expect(queue.sentBack.map((g: any) => g.review?.note)).toContain('Tighten the hook');
  });

  it('records writer-confirmed deliveries with who and when, and keeps partial delivery visible', async () => {
    const s = await scriptsOf();
    const five = s.filter((x) => x.number <= 5).map((x) => x.id);
    const r = await sarah.post(`/api/batches/${batchId}/scripts/action`, { action: 'deliver', scriptIds: five, timelinerUrl: 'https://timeliner.io/x', note: 'Scheduled' });
    expect(r.status).toBe(200);
    const b = r.body.batch as BatchDetail;
    expect(b.progress.delivered).toBe(5);
    expect(b.stage).not.toBe('delivered');
    expect(b.final.complete).toBe(false);
    expect(b.deliveries[0]).toMatchObject({ confirmedByName: 'Sarah Chen', scriptNumbers: [1, 2, 3, 4, 5], timelinerUrl: 'https://timeliner.io/x', verification: 'writer_confirmed' });
    expect(new Date(b.deliveries[0].confirmedAt).getTime()).toBeGreaterThan(0);
    const notes = (await manager.get('/api/notifications')).body.notifications;
    expect(notes.some((n: any) => n.type === 'delivery' && /Sarah Chen confirmed scripts .* in Timeliner\./.test(n.body))).toBe(true);
  });

  it('cannot deliver scripts that are not approved', async () => {
    const s = await scriptsOf();
    const r = await sarah.post(`/api/batches/${batchId}/scripts/action`, { action: 'deliver', scriptIds: [s.find((x) => x.number === 15)!.id] });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/approved/);
  });

  it('the quick count control moves real script records and detects stale counts', async () => {
    const b = await manager.post('/api/batches', { clientId: acmeId, title: 'Quick count', targetCount: 6, draftDue: '2026-10-20', finalDue: '2026-10-22', split: [{ writerId: ids.marcus, count: 6 }] });
    const id = b.body.batchId;
    const up = await marcus.post(`/api/batches/${id}/quick-progress`, { draftReady: 3, expected: 0 });
    expect(up.status).toBe(200);
    expect(up.body.batch.progress.draftReady).toBe(3);
    expect(up.body.batch.scripts.filter((s: any) => s.status === 'ready_for_review').map((s: any) => s.number)).toEqual([1, 2, 3]);
    const stale = await marcus.post(`/api/batches/${id}/quick-progress`, { draftReady: 4, expected: 0 });
    expect(stale.status).toBe(409);
    const down = await marcus.post(`/api/batches/${id}/quick-progress`, { draftReady: 2, expected: 3 });
    expect(down.body.batch.progress.draftReady).toBe(2);
    expect(down.body.batch.progress.approved).toBe(0);
    const other = await sarah.post(`/api/batches/${id}/quick-progress`, { draftReady: 1, expected: 0 });
    expect(other.status).toBe(403);
  });

  it('rejects edits based on a stale version', async () => {
    const s = (await scriptsOf()).find((x) => x.number === 30)!;
    const ok = await marcus.patch(`/api/scripts/${s.id}`, { version: s.version, docUrl: 'https://docs.example/30' });
    expect(ok.status).toBe(200);
    const stale = await marcus.patch(`/api/scripts/${s.id}`, { version: s.version, title: 'Old view' });
    expect(stale.status).toBe(409);
  });
});

describe('moving a shoot', () => {
  it('previews, recalculates automatic dates, keeps manual overrides and flags them', async () => {
    await manager.patch(`/api/batches/${batchId}`, { finalDue: { mode: 'manual', date: '2026-10-09' } });
    const shootId = (await manager.get(`/api/batches/${batchId}`)).body.shootId;
    const pv = await manager.post(`/api/shoots/${shootId}/reschedule-preview`, { startDate: '2026-10-19', endDate: '2026-10-20' });
    expect(pv.status).toBe(200);
    const draft = pv.body.changes.find((c: any) => c.batchId === batchId && c.field === 'draftDue');
    const final = pv.body.changes.find((c: any) => c.batchId === batchId && c.field === 'finalDue');
    expect(draft).toMatchObject({ from: '2026-10-07', to: '2026-10-14', kept: false });
    expect(final).toMatchObject({ from: '2026-10-09', to: '2026-10-09', kept: true });
    expect(pv.body.affectedWriters).toEqual(expect.arrayContaining(['Marcus Webb', 'Sarah Chen']));
    // preview changes nothing
    expect((await manager.get(`/api/batches/${batchId}`)).body.draftDue).toBe('2026-10-07');

    const r = await manager.post(`/api/shoots/${shootId}/reschedule`, { startDate: '2026-10-19', endDate: '2026-10-20' });
    expect(r.status).toBe(200);
    const b = (await manager.get(`/api/batches/${batchId}`)).body as BatchDetail;
    expect(b.draftDue).toBe('2026-10-14');
    expect(b.finalDue).toBe('2026-10-09');
    expect(b.needsDateReview).toBe(true);
    expect(b.dateReviewNote).toMatch(/kept/);
    expect(b.activity.some((a) => /Shoot moved/.test(a.summary))).toBe(true);
    const notes = (await sarah.get('/api/notifications')).body.notifications;
    expect(notes.some((n: any) => n.type === 'deadline_change' && /Shoot moved/.test(n.title))).toBe(true);
  });

  it('moves everything with it: writing start, the batch name, and manual dates when asked', async () => {
    const created = await manager.post('/api/shoots', {
      clientId: acmeId, startDate: '2026-11-10', endDate: '2026-11-11',
      batch: { targetCount: 4, plannedStart: '2026-11-01', finalDue: '2026-11-06', split: [{ writerId: ids.sarah, count: 4 }] },
    });
    expect(created.status).toBe(200);
    const id = created.body.batchId as number;
    const shootId = created.body.shootId as number;
    expect(created.body.batch.title).toBe('Acme Outdoor Co. · Nov 10–11, 2026'); // named after the client when the shoot has no name
    const pv = (await manager.post(`/api/shoots/${shootId}/reschedule-preview`, { startDate: '2026-11-17', endDate: '2026-11-18' })).body;
    expect(pv).toMatchObject({ days: 7, manualCount: 1 });
    expect(pv.plannedStarts).toEqual([expect.objectContaining({ batchId: id, from: '2026-11-01', to: '2026-11-08' })]);
    expect(pv.renames).toEqual([{ batchId: id, from: 'Acme Outdoor Co. · Nov 10–11, 2026', to: 'Acme Outdoor Co. · Nov 17–18, 2026' }]);
    expect(pv.changes.find((c: any) => c.field === 'finalDue')).toMatchObject({ kept: true, to: '2026-11-06' });
    const withManual = (await manager.post(`/api/shoots/${shootId}/reschedule-preview`, { startDate: '2026-11-17', endDate: '2026-11-18', shiftManual: true })).body;
    expect(withManual.changes.find((c: any) => c.field === 'finalDue')).toMatchObject({ kept: false, mode: 'manual', to: '2026-11-13' });

    expect((await manager.post(`/api/shoots/${shootId}/reschedule`, { startDate: '2026-11-17', endDate: '2026-11-18', shiftManual: true })).status).toBe(200);
    const b = (await manager.get(`/api/batches/${id}`)).body as BatchDetail;
    expect(b).toMatchObject({ title: 'Acme Outdoor Co. · Nov 17–18, 2026', plannedStart: '2026-11-08', draftDue: '2026-11-12', finalDue: '2026-11-13', finalDueMode: 'manual', needsDateReview: false });
    expect(b.activity[0].summary).toMatch(/Writing start Nov 1 → Nov 8.*Renamed to “Acme Outdoor Co. · Nov 17–18, 2026”/);
  });
});

describe('dashboard', () => {
  it('makes overdue, blocked and unassigned work easy to find', async () => {
    const blocked = await sarah.post(`/api/batches/${batchId}/blocker`, { blocked: true, note: 'Waiting on product photos' });
    expect(blocked.status).toBe(200);
    const d = (await manager.get('/api/dashboard')).body as Dashboard;
    expect(d.cards.overdueBatches).toBeGreaterThanOrEqual(1); // the Sep 30 shoot's drafts were due Sep 25
    expect(d.unassignedScripts).toBeGreaterThanOrEqual(10);
    const kinds = d.attention.flatMap((a) => a.issues.map((i) => i.kind));
    expect(kinds).toEqual(expect.arrayContaining(['overdue', 'blocked', 'unassigned', 'revisions', 'date_review']));
    expect(d.due.final[0].date).toBe('overdue');
    expect(d.due.final).toHaveLength(15);
    // each batch on the chart says which deadline it's counted against and whose scripts are in the count
    const items = [...d.due.final, ...d.due.draft].flatMap((x) => x.items.map((it) => ({ ...it, day: x.date })));
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) {
      expect(it.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (it.day === 'overdue') expect(it.dueDate < d.clock.today).toBe(true);
      else expect(it.dueDate).toBe(it.day);
      expect(new Set(it.writerIds).size).toBe(it.writerIds.length);
    }
    const people = new Set(Object.values(ids));
    expect(items.flatMap((it) => it.writerIds).every((id) => people.has(id))).toBe(true);
    expect(items.some((it) => it.writerIds.length > 0)).toBe(true);
    // numbers come from records: the chart total equals undelivered scripts due in the window
    const flagged = await manager.get('/api/batches?flag=blocked');
    expect(flagged.body.batches.map((b: any) => b.id)).toEqual([batchId]);
  });
});

describe('permissions are enforced on the server', () => {
  it('writers cannot bypass permissions through direct requests', async () => {
    const s = ((await manager.get(`/api/batches/${batchId}`)).body as BatchDetail).scripts;
    const marcusScript = s.find((x) => x.assigneeId === ids.marcus && x.status === 'ready_for_review')!;
    const checks: [string, Res][] = [
      ['approve', await sarah.post(`/api/batches/${batchId}/scripts/action`, { action: 'approve', scriptIds: [marcusScript.id] })],
      ['edit another writer’s script', await sarah.patch(`/api/scripts/${marcusScript.id}`, { version: marcusScript.version, title: 'x' })],
      ['submit another writer’s script', await sarah.post(`/api/batches/${batchId}/scripts/action`, { action: 'withdraw', scriptIds: [marcusScript.id] })],
      ['reassign', await sarah.post(`/api/batches/${batchId}/scripts/assign`, { scriptIds: [marcusScript.id], assigneeId: ids.sarah })],
      ['edit batch deadlines', await sarah.patch(`/api/batches/${batchId}`, { draftDue: { mode: 'manual', date: '2026-12-01' } })],
      ['change target', await sarah.post(`/api/batches/${batchId}/target`, { targetCount: 50 })],
      ['create a client', await sarah.post('/api/clients', { name: 'Sneaky Co' })],
      ['archive a client', await sarah.post(`/api/clients/${acmeId}/archive`, { archived: true })],
      ['change global deadline settings', await sarah.patch('/api/settings', { draftOffsetDays: 1 })],
      ['create users', await sarah.post('/api/users', { name: 'X', email: 'x@x.test', role: 'manager', password: 'aaaaaaaaaaaa' })],
      ['move a shoot', await sarah.post(`/api/shoots/1/reschedule`, { startDate: '2026-12-01' })],
    ];
    for (const [what, r] of checks) expect(r.status, what).toBe(403);
    // and nothing changed
    const after = ((await manager.get(`/api/batches/${batchId}`)).body as BatchDetail);
    expect(after.scripts.find((x) => x.id === marcusScript.id)).toMatchObject({ status: 'ready_for_review', assigneeId: ids.marcus });
    expect(after.draftDue).toBe('2026-10-14');
  });

  it('writers can still read shared data and update their own work', async () => {
    expect((await sarah.get('/api/dashboard')).status).toBe(200);
    expect((await sarah.get('/api/batches')).status).toBe(200);
    const res = await sarah.post('/api/resources', { clientId: acmeId, batchId, category: 'example', title: 'Reference', url: 'https://example.com/ref' });
    expect(res.status).toBe(200);
    const notMine = await manager.post('/api/batches', { clientId: acmeId, title: 'Not Sarah’s', targetCount: 1, split: [{ writerId: ids.marcus, count: 1 }] });
    const res2 = await sarah.post('/api/resources', { clientId: acmeId, batchId: notMine.body.batchId, category: 'example', title: 'Nope', url: 'https://example.com/n' });
    expect(res2.status).toBe(403);
  });

  it('requires a session and the CSRF header', async () => {
    expect((await call('GET', '/api/dashboard')).status).toBe(401);
    const cookie = await login('sarah@scale.test', 'writer-password-1');
    expect((await call('POST', '/api/notifications/read', { cookie, body: { all: true }, noCsrf: true })).status).toBe(403);
    const bad = await call('POST', '/api/auth/login', { body: { email: 'sarah@scale.test', password: 'wrong-password' } });
    expect(bad.status).toBe(401);
  });
});

describe('target changes preserve work', () => {
  it('requires an explicit choice and refuses to remove submitted work', async () => {
    const tooFew = await manager.post(`/api/batches/${batchId}/target`, { targetCount: 40 });
    expect(tooFew.status).toBe(409);
    expect(tooFew.body.error.code).toBe('resolution_required');
    const pv = await manager.get(`/api/batches/${batchId}/target-preview?count=40`);
    expect(pv.body.possible).toBe(false); // every script has been submitted
    const grow = await manager.post(`/api/batches/${batchId}/target`, { targetCount: 47, assigneeId: ids.sarah });
    expect(grow.status).toBe(200);
    expect(grow.body.progress.total).toBe(47);
    const shrink = await manager.get(`/api/batches/${batchId}/target-preview?count=46`);
    expect(shrink.body.possible).toBe(true);
    const done = await manager.post(`/api/batches/${batchId}/target`, { targetCount: 46, removeScriptIds: shrink.body.defaultRemove });
    expect(done.body.progress.total).toBe(46);
    expect(done.body.activity[0].summary).toMatch(/removed scripts 47/);
  });
});

describe('reminders', () => {
  it('sends approaching, due-today and overdue reminders once', async () => {
    const first = await runReminders(ctx);
    expect(first.created).toBeGreaterThan(0);
    const second = await runReminders(ctx);
    expect(second.created).toBe(0);
    NOW = new Date('2026-10-12T16:00:00Z');
    const later = await runReminders(ctx);
    expect(later.created).toBeGreaterThan(0);
    const notes = (await marcus.get('/api/notifications')).body.notifications;
    expect(notes.some((n: any) => n.type === 'overdue')).toBe(true);
    NOW = new Date('2026-09-28T16:00:00Z');
  });
});

describe('persistence', () => {
  it('keeps data across restarts', async () => {
    if (process.env.TEST_DATABASE_URL) return; // the shared database is persistent by definition
    const dir = mkdtempSync(path.join(tmpdir(), 'sm-persist-'));
    try {
      const d1 = await openDb({ dataDir: dir });
      await d1.query(`insert into users (email, name, role, password_hash) values ('p@x.test', 'Persisted', 'writer', 'x')`);
      await d1.close();
      const d2 = await openDb({ dataDir: dir });
      const r = await d2.one<{ name: string }>(`select name from users where email = 'p@x.test'`);
      expect(r?.name).toBe('Persisted');
      await d2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('team: roles, temporary passwords, removal', () => {
  it('the first account is the Admin; managers run the team but can’t take over the Admin role', async () => {
    const team = (await manager.get('/api/users')).body.users;
    expect(team.find((u: any) => u.id === ids.josh).role).toBe('owner');
    const add = await manager.post('/api/users', { name: 'Mia Park', email: 'mia@scale.test', role: 'manager', password: 'manager-temp-1' });
    expect(add.status).toBe(200);
    const mia = as(await login('mia@scale.test', 'manager-temp-1'));
    const miaId = add.body.users.find((u: any) => u.email === 'mia@scale.test').id;
    // a manager manages the team and settings…
    expect((await mia.patch('/api/settings', { reminderLeadDays: 3 })).status).toBe(200);
    expect((await mia.post('/api/users', { name: 'Writer Two', email: 'w2@scale.test', role: 'writer', password: 'writer-two-temp' })).status).toBe(200);
    // …but can't make an Admin, promote themselves, or change the Admin's account
    expect((await mia.post('/api/users', { name: 'Owner Two', email: 'o2@scale.test', role: 'owner', password: 'owner-two-temp' })).status).toBe(403);
    expect((await mia.patch(`/api/users/${miaId}`, { role: 'owner' })).status).toBe(403);
    expect((await mia.patch(`/api/users/${ids.josh}`, { role: 'writer' })).status).toBe(403);
    expect((await mia.patch(`/api/users/${ids.josh}`, { password: 'taken-over-pass' })).status).toBe(403);
    expect((await mia.post(`/api/users/${ids.josh}/remove`, {})).status).toBe(403);
    expect((await mia.get('/api/users')).body.users.find((u: any) => u.id === ids.josh).tempPassword).toBeNull();
    // the Admin can make another Admin, and the log says what changed
    const o2 = await manager.post('/api/users', { name: 'Owner Two', email: 'o2@scale.test', role: 'owner', password: 'owner-two-temp' });
    expect(o2.status).toBe(200);
    expect((await manager.patch(`/api/users/${miaId}`, { role: 'writer' })).status).toBe(200);
    const log = (await db.query<{ summary: string }>(`select summary from activity where action = 'user.updated' order by id desc limit 1`))[0];
    expect(log.summary).toBe('Mia Park: role Manager → Writer');
    await manager.patch(`/api/users/${miaId}`, { role: 'manager' });
  });

  it('deactivating someone can hand their unfinished scripts to someone else, and flags any left behind', async () => {
    const add = await manager.post('/api/users', { name: 'Dee Active', email: 'dee@scale.test', role: 'writer', password: 'dee-temp-pass1' });
    const deeId = add.body.users.find((u: any) => u.email === 'dee@scale.test').id;
    const b1 = await manager.post('/api/batches', { clientId: acmeId, title: 'Dee hand-over', targetCount: 2, split: [{ writerId: deeId, count: 2 }] });
    const r = await manager.patch(`/api/users/${deeId}`, { active: false, reassignTo: ids.marcus });
    expect(r.status).toBe(200);
    expect(r.body.moved).toBe(2);
    const d1 = (await manager.get(`/api/batches/${b1.body.batchId}`)).body as BatchDetail;
    expect(d1.writers.map((w) => w.name)).toEqual(['Marcus Webb']);
    // no one chosen: they're unassigned, which Needs attention shows
    await manager.patch(`/api/users/${deeId}`, { active: true });
    const b2 = await manager.post('/api/batches', { clientId: acmeId, title: 'Dee left behind', targetCount: 1, split: [{ writerId: deeId, count: 1 }] });
    await manager.patch(`/api/users/${deeId}`, { active: false });
    let item = (await manager.get('/api/dashboard')).body.attention.find((a: any) => a.batch.id === b2.body.batchId);
    expect(item.issues.map((i: any) => i.text)).toContain('1 script unassigned');
    // scripts still held by someone who can't sign in (older data) are flagged by name
    await manager.patch(`/api/users/${deeId}`, { active: true });
    const b3 = await manager.post('/api/batches', { clientId: acmeId, title: 'Dee legacy', targetCount: 1, split: [{ writerId: deeId, count: 1 }] });
    await db.query(`update users set active = false where id = $1`, [deeId]);
    item = (await manager.get('/api/dashboard')).body.attention.find((a: any) => a.batch.id === b3.body.batchId);
    expect(item.issues.map((i: any) => i.text)).toContain('1 script still with Dee Active, who’s deactivated · reassign them');
  });

  it('keeps the temporary password readable for managers until the person sets their own', async () => {
    await manager.post('/api/users', { name: 'Tess Lane', email: 'tess@scale.test', role: 'writer', password: 'tess-temp-pass' });
    const find = async (who = manager) => (await who.get('/api/users')).body.users.find((u: any) => u.email === 'tess@scale.test');
    expect((await find()).tempPassword).toBe('tess-temp-pass');
    expect((await find(sarah)).tempPassword).toBeNull(); // writers never see it
    const tess = as(await login('tess@scale.test', 'tess-temp-pass'));
    // first sign-in asks for their own password, and the temporary one can't be kept
    expect((await tess.get('/api/bootstrap')).body.mustChangePassword).toBe(true);
    const same = await tess.post('/api/me/password', { current: 'tess-temp-pass', next: 'tess-temp-pass' });
    expect(same.status).toBe(400);
    expect(same.body.error.fields.next).toMatch(/new password/);
    expect((await tess.post('/api/me/password', { current: 'tess-temp-pass', next: 'tess-own-password' })).status).toBe(200);
    expect((await tess.get('/api/bootstrap')).body.mustChangePassword).toBe(false);
    expect((await find()).tempPassword).toBeNull();
    // a reset makes a new readable temporary password
    await manager.patch(`/api/users/${(await find()).id}`, { password: 'tess-reset-pass' });
    expect((await find()).tempPassword).toBe('tess-reset-pass');
  });

  it('removing someone signs them out and hands their unfinished scripts to someone else', async () => {
    const leo = await manager.post('/api/users', { name: 'Leo Test', email: 'leo@scale.test', role: 'writer', password: 'leo-temp-pass' });
    const leoId = leo.body.users.find((u: any) => u.email === 'leo@scale.test').id;
    const b = await manager.post('/api/batches', { clientId: acmeId, title: 'Leo’s batch', targetCount: 3, split: [{ writerId: leoId, count: 3 }] });
    const leoSession = as(await login('leo@scale.test', 'leo-temp-pass'));
    const work = await manager.get(`/api/users/${leoId}/open-work`);
    expect(work.body.scripts).toBe(3);
    expect((await sarah.post(`/api/users/${leoId}/remove`, {})).status).toBe(403);
    const r = await manager.post(`/api/users/${leoId}/remove`, { reassignTo: ids.marcus });
    expect(r.status).toBe(200);
    expect(r.body.moved).toBe(3);
    expect(r.body.users.find((u: any) => u.id === leoId).removed).toBe(true);
    const detail = (await manager.get(`/api/batches/${b.body.batchId}`)).body as BatchDetail;
    expect(detail.writers.map((w) => [w.name, w.ranges])).toEqual([['Marcus Webb', '1–3']]);
    expect(detail.activity[0].summary).toMatch(/Leo Test was removed from the team/);
    expect((await leoSession.get('/api/bootstrap')).status).toBe(401);
    expect((await call('POST', '/api/auth/login', { body: { email: 'leo@scale.test', password: 'leo-temp-pass' } })).status).toBe(401);
    expect((await manager.post(`/api/users/${ids.josh}/remove`, {})).status).toBe(400); // not yourself
    // adding them back restores the same account and history
    const back = await manager.post('/api/users', { name: 'Leo Test', email: 'leo@scale.test', role: 'writer', password: 'leo-back-pass' });
    expect(back.status).toBe(200);
    expect(back.body.users.find((u: any) => u.email === 'leo@scale.test').id).toBe(leoId);
  });
});


describe('scripts sent as one document', () => {
  let docBatch: number;
  const multipart = (fields: Record<string, string>, file?: { name: string; body: string }) => {
    const boundary = '----smdoc' + Math.random().toString(16).slice(2);
    const parts = Object.entries(fields).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}`);
    if (file) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/pdf\r\n\r\n${file.body}`);
    return { payload: parts.join('\r\n') + `\r\n--${boundary}--\r\n`, type: `multipart/form-data; boundary=${boundary}` };
  };
  const send = async (cookie: string, url: string, fields: Record<string, string>, file?: { name: string; body: string }) => {
    const m = multipart(fields, file);
    const r = await app.inject({ method: 'POST', url, headers: { 'x-scale-media': '1', cookie, 'content-type': m.type }, payload: m.payload });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };

  it('a writer sends all ten scripts as one PDF, and the queue shows one item, not ten', async () => {
    const b = await manager.post('/api/batches', { clientId: acmeId, title: 'Ten in one', targetCount: 10, finalDue: '2026-10-20', split: [{ writerId: ids.marcus, count: 10 }] });
    docBatch = b.body.batchId;
    const scripts = b.body.batch ? (await marcus.get(`/api/batches/${docBatch}`)).body.scripts : [];
    const r = await send(marcus.cookie, `/api/batches/${docBatch}/submissions`, {
      scriptIds: JSON.stringify(scripts.map((s: any) => s.id)),
      titles: JSON.stringify([{ number: 1, title: 'Rain shell hook' }, { number: 2, title: 'Trail pack' }]),
      note: 'All ten in one PDF',
    }, { name: 'ten-scripts.pdf', body: '%PDF-1.4 ten' });
    expect(r.status).toBe(200);
    const detail = r.body.batch as BatchDetail;
    expect(detail.progress.inReview).toBe(10);
    expect(detail.scripts.find((s) => s.number === 1)!.title).toBe('Rain shell hook');
    expect(detail.submissions).toHaveLength(1);
    expect(detail.submissions[0]).toMatchObject({ version: 1, state: 'in_review', fileName: 'ten-scripts.pdf', writerName: 'Marcus Webb', currentNumbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
    const queue = (await manager.get('/api/review')).body;
    const mine = queue.waiting.filter((g: any) => g.batch.id === docBatch);
    expect(mine).toHaveLength(1);
    expect(mine[0].scripts).toHaveLength(10);
    expect(mine[0].submission.fileName).toBe('ten-scripts.pdf');
    // the document opens for signed-in people
    const f = await app.inject({ method: 'GET', url: `/api/files/${detail.submissions[0].fileId}`, headers: { cookie: manager.cookie } });
    expect(f.statusCode).toBe(200);
  });

  it('sending back with marked-up changes is one request, and the writer sees it once', async () => {
    const detail = (await manager.get(`/api/batches/${docBatch}`)).body as BatchDetail;
    const sub = detail.submissions[0];
    const r = await send(manager.cookie, `/api/batches/${docBatch}/review`, {
      action: 'revisions', scriptIds: JSON.stringify(detail.scripts.map((s) => s.id)), submissionId: String(sub.id),
      note: 'Tighten every opening line — see my notes', url: 'https://docs.google.com/document/d/marked-up',
    });
    expect(r.status).toBe(200);
    expect(r.body.batch.progress.revisions).toBe(10);
    const work = (await marcus.get('/api/my-work')).body;
    const back = work.sentBack.filter((g: any) => g.batch.id === docBatch);
    expect(back).toHaveLength(1);
    expect(back[0].review).toMatchObject({ note: 'Tighten every opening line — see my notes', url: 'https://docs.google.com/document/d/marked-up', reviewedByName: 'Josh Rath' });
    expect(back[0].scripts).toHaveLength(10);
    const sentBack = (await manager.get('/api/review')).body.sentBack.filter((g: any) => g.batch.id === docBatch);
    expect(sentBack).toHaveLength(1);
  });

  it('a revised version becomes version 2, and approving it approves all ten at once', async () => {
    const detail = (await marcus.get(`/api/batches/${docBatch}`)).body as BatchDetail;
    const v2 = await marcus.post(`/api/batches/${docBatch}/submissions`, { scriptIds: detail.scripts.map((s) => s.id), url: 'https://drive.google.com/file/d/v2' });
    expect(v2.status).toBe(200);
    const subs = (v2.body.batch as BatchDetail).submissions;
    expect(subs.map((s) => [s.version, s.state])).toEqual([[1, 'superseded'], [2, 'in_review']]);
    expect(subs[1].previousId).toBe(subs[0].id);
    const ok = await manager.post(`/api/batches/${docBatch}/review`, { action: 'approve', scriptIds: detail.scripts.map((s) => s.id), submissionId: subs[1].id });
    expect(ok.status).toBe(200);
    const after = ok.body.batch as BatchDetail;
    expect(after.progress.approved).toBe(10);
    expect(after.submissions[1].state).toBe('approved');
    expect(after.submissions[1].reviews.map((r) => r.action)).toEqual(['approved']);
    expect(after.revisions.filter((r) => !r.resolvedAt)).toHaveLength(0);
  });

  it('only the writer (or a manager) can send scripts, and only managers can review', async () => {
    const b = await manager.post('/api/batches', { clientId: acmeId, title: 'Permission doc', targetCount: 2, split: [{ writerId: ids.marcus, count: 2 }] });
    const sids = (await manager.get(`/api/batches/${b.body.batchId}`)).body.scripts.map((s: any) => s.id);
    expect((await sarah.post(`/api/batches/${b.body.batchId}/submissions`, { scriptIds: sids, url: 'https://example.com/x' })).status).toBe(403);
    expect((await marcus.post(`/api/batches/${b.body.batchId}/submissions`, { scriptIds: sids })).status).toBe(400); // needs a document
    expect((await marcus.post(`/api/batches/${b.body.batchId}/submissions`, { scriptIds: sids, url: 'https://example.com/x' })).status).toBe(200);
    expect((await marcus.post(`/api/batches/${b.body.batchId}/review`, { action: 'approve', scriptIds: sids })).status).toBe(403);
    expect((await sarah.post(`/api/batches/${b.body.batchId}/titles`, { titles: [{ number: 1, title: 'Hijack' }] })).status).toBe(403);
    const t = await marcus.post(`/api/batches/${b.body.batchId}/titles`, { titles: [{ number: 1, title: 'Opening' }, { number: 2, title: null }] });
    expect(t.status).toBe(200);
    expect(t.body.batch.scripts[0].title).toBe('Opening');
  });
});

describe('master log', () => {
  it('records views once per 10 minutes, changes, sign-ins and blocked attempts; only owners can read it', async () => {
    const tessish = await login('sarah@scale.test', 'writer-password-1');
    await as(tessish).get(`/api/batches/${batchId}`);
    await as(tessish).get(`/api/batches/${batchId}`);
    await as(tessish).post(`/api/batches/${batchId}/scripts/assign`, { scriptIds: [1], assigneeId: ids.sarah }); // blocked
    await call('POST', '/api/auth/login', { body: { email: 'sarah@scale.test', password: 'nope-nope-nope' } });
    const log = await manager.get('/api/audit');
    expect(log.status).toBe(200);
    const entries = log.body.entries as { kind: string; summary: string; userName: string | null }[];
    const views = entries.filter((e) => e.kind === 'view' && e.userName === 'Sarah Chen' && /Viewed batch/.test(e.summary));
    expect(views).toHaveLength(1);
    expect(entries.some((e) => e.kind === 'denied' && e.userName === 'Sarah Chen' && /assign scripts/.test(e.summary))).toBe(true);
    expect(entries.some((e) => e.kind === 'auth' && /Failed sign-in/.test(e.summary))).toBe(true);
    expect(entries.some((e) => e.kind === 'auth' && e.summary === 'Signed in')).toBe(true);
    expect(entries.some((e) => e.kind === 'change')).toBe(true);
    const onlyViews = (await manager.get('/api/audit?kind=view')).body.entries;
    expect(onlyViews.every((e: any) => e.kind === 'view')).toBe(true);
    // managers and writers can't read it
    const mia = as(await login('mia@scale.test', 'manager-temp-1'));
    expect((await mia.get('/api/audit')).status).toBe(403);
    expect((await sarah.get('/api/audit')).status).toBe(403);
  });
});

describe('celebration moments', () => {
  let batchId: number;
  let scripts: { id: number; number: number }[];
  const clear = async (who: typeof manager) => {
    const all = (await who.get('/api/moments')).body as Moment[];
    await who.post('/api/moments/seen', { ids: all.map((m) => m.id) });
  };

  it('finishing your drafts is celebrated once for you and for the managers', async () => {
    await clear(manager); await clear(sarah);
    const b = await manager.post('/api/batches', { clientId: acmeId, title: 'Party batch', targetCount: 3, finalDue: '2026-10-21', split: [{ writerId: ids.sarah, count: 3 }] });
    batchId = b.body.batchId;
    scripts = (await sarah.get(`/api/batches/${batchId}`)).body.scripts;
    await sarah.post(`/api/batches/${batchId}/submissions`, { scriptIds: [scripts[0].id], url: 'https://docs.google.com/document/d/one' });
    expect((await sarah.get('/api/moments')).body).toHaveLength(0); // not done yet
    await sarah.post(`/api/batches/${batchId}/submissions`, { scriptIds: scripts.slice(1).map((s) => s.id), url: 'https://docs.google.com/document/d/rest' });
    const mine = (await sarah.get('/api/moments')).body as Moment[];
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: 'drafts_done', batchTitle: 'Party batch', count: 3, self: true });
    const boss = (await manager.get('/api/moments')).body as Moment[];
    expect(boss.filter((m) => m.batchId === batchId)).toEqual([expect.objectContaining({ kind: 'team_drafts_done', byName: 'Sarah Chen', count: 3 })]);
    // once seen, it's gone
    await sarah.post('/api/moments/seen', { ids: mine.map((m) => m.id) });
    expect((await sarah.get('/api/moments')).body).toHaveLength(0);
  });

  it('the writer gets a congrats when their scripts are approved, and a heads-up when sent back', async () => {
    await clear(manager);
    await manager.post(`/api/batches/${batchId}/review`, { action: 'revisions', scriptIds: [scripts[2].id], note: 'Shorter hook please' });
    await manager.post(`/api/batches/${batchId}/review`, { action: 'approve', scriptIds: scripts.slice(0, 2).map((s) => s.id) });
    const got = (await sarah.get('/api/moments')).body as Moment[];
    expect(got.map((m) => m.kind)).toEqual(['revisions', 'approved']);
    expect(got[0]).toMatchObject({ numbers: [3], note: 'Shorter hook please', byName: 'Josh Rath' });
    expect(got[1]).toMatchObject({ numbers: [1, 2], count: 2, allMine: false, byName: 'Josh Rath' });
    // the reviewer isn't congratulated on their own decision
    expect(((await manager.get('/api/moments')).body as Moment[]).filter((m) => m.batchId === batchId)).toHaveLength(0);
    // resubmitting after revisions doesn't celebrate finished drafts a second time
    await clear(sarah);
    await sarah.post(`/api/batches/${batchId}/submissions`, { scriptIds: [scripts[2].id], url: 'https://docs.google.com/document/d/v2' });
    expect((await sarah.get('/api/moments')).body).toHaveLength(0);
    await manager.post(`/api/batches/${batchId}/review`, { action: 'approve', scriptIds: [scripts[2].id] });
    expect(((await sarah.get('/api/moments')).body as Moment[])[0]).toMatchObject({ kind: 'approved', allMine: true });
  });

  it('delivering the last scripts celebrates the finished batch', async () => {
    await clear(sarah); await clear(manager);
    const r = await sarah.post(`/api/batches/${batchId}/scripts/action`, { action: 'deliver', scriptIds: scripts.map((s) => s.id), timelinerUrl: null, note: null });
    expect(r.status).toBe(200);
    expect(((await sarah.get('/api/moments')).body as Moment[]).map((m) => [m.kind, m.self])).toEqual([['batch_done', true]]);
    expect(((await manager.get('/api/moments')).body as Moment[]).filter((m) => m.batchId === batchId).map((m) => m.kind)).toEqual(['team_batch_done']);
    // people can only dismiss their own
    const theirs = (await manager.get('/api/moments')).body as Moment[];
    await sarah.post('/api/moments/seen', { ids: theirs.map((m) => m.id) });
    expect(((await manager.get('/api/moments')).body as Moment[]).length).toBe(theirs.length);
  });

  it('remembers the newest What’s new entry each person has opened', async () => {
    expect((await sarah.get('/api/bootstrap')).body.whatsNewSeen).toBeNull();
    expect((await sarah.post('/api/me/whats-new', { seen: '2026-09-28-animations' })).status).toBe(200);
    expect((await sarah.get('/api/bootstrap')).body.whatsNewSeen).toBe('2026-09-28-animations');
    expect((await manager.get('/api/bootstrap')).body.whatsNewSeen).toBeNull();
  });
});

describe('writer progress counter', () => {
  it('is only an update: it never changes script statuses, and stays between what was sent and the total', async () => {
    const b = await manager.post('/api/batches', { clientId: acmeId, title: 'Counter batch', targetCount: 10, finalDue: '2026-10-22', split: [{ writerId: ids.sarah, count: 10 }] });
    const id = b.body.batchId as number;
    const r = await sarah.post(`/api/batches/${id}/written`, { written: 4 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ written: 4, total: 10, sent: 0 });
    let d = (await manager.get(`/api/batches/${id}`)).body as BatchDetail;
    expect(d.written).toBe(4);
    expect(d.writers[0]).toMatchObject({ name: 'Sarah Chen', written: 4, draftReady: 0 });
    expect(d.progress.draftReady).toBe(0);
    expect(d.scripts.every((s) => s.status === 'not_started')).toBe(true);
    // more than they have is capped; sending scripts raises the floor
    expect((await sarah.post(`/api/batches/${id}/written`, { written: 99 })).body.written).toBe(10);
    await sarah.post(`/api/batches/${id}/submissions`, { scriptIds: d.scripts.slice(0, 6).map((s) => s.id), url: 'https://docs.google.com/document/d/counter' });
    expect((await sarah.post(`/api/batches/${id}/written`, { written: 2 })).body.written).toBe(6);
    d = (await manager.get(`/api/batches/${id}`)).body as BatchDetail;
    expect(d.written).toBe(6);
    // several taps are one line in the history
    const lines = d.activity.filter((a) => a.action === 'progress.written');
    expect(lines).toHaveLength(1);
    expect(lines[0].summary).toBe('Progress update: 6 of 10 scripts written');
    // other writers can't touch it; managers can, on the writer's behalf
    expect((await marcus.post(`/api/batches/${id}/written`, { written: 8, writerId: ids.sarah })).status).toBe(403);
    expect((await marcus.post(`/api/batches/${id}/written`, { written: 8 })).status).toBe(400);
    const onBehalf = await manager.post(`/api/batches/${id}/written`, { written: 8, writerId: ids.sarah });
    expect(onBehalf.body.written).toBe(8);
    expect(((await manager.get(`/api/batches/${id}`)).body as BatchDetail).activity.find((a) => a.action === 'progress.written' && a.summary.includes('for Sarah Chen'))).toBeTruthy();
  });

  it('shows how far each writer went today', async () => {
    const b = await manager.post('/api/batches', { clientId: acmeId, title: 'Today counter', targetCount: 10, finalDue: '2026-10-22', split: [{ writerId: ids.sarah, count: 6 }, { writerId: ids.marcus, count: 4 }] });
    const id = b.body.batchId as number;
    await sarah.post(`/api/batches/${id}/written`, { written: 2 });
    await sarah.post(`/api/batches/${id}/written`, { written: 3 });
    let d = (await manager.get(`/api/batches/${id}`)).body as BatchDetail;
    const her = () => d.writers.find((w) => w.userId === ids.sarah)!;
    expect(her()).toMatchObject({ written: 3, writtenToday: 3, approved: 0 });
    expect(d.writers.find((w) => w.userId === ids.marcus)!.writtenToday).toBe(0);
    expect(d.writtenToday).toBe(3);
    // going back down counts down too, never below zero
    await sarah.post(`/api/batches/${id}/written`, { written: 1 });
    d = (await manager.get(`/api/batches/${id}`)).body as BatchDetail;
    expect(her().writtenToday).toBe(1);
    // a new day starts from where the counter stood
    await db.query(`update writer_progress set day = day - 1 where batch_id = $1`, [id]);
    d = (await manager.get(`/api/batches/${id}`)).body as BatchDetail;
    expect(her()).toMatchObject({ written: 1, writtenToday: 0 });
    await sarah.post(`/api/batches/${id}/written`, { written: 4 });
    d = (await manager.get(`/api/batches/${id}`)).body as BatchDetail;
    expect(her()).toMatchObject({ written: 4, writtenToday: 3 });
    // it shows on the Overview's batches too
    const dash = (await manager.get('/api/dashboard')).body;
    expect(dash.activeBatches.find((x: any) => x.id === id).writers.find((w: any) => w.userId === ids.sarah)).toMatchObject({ writtenToday: 3 });
  });
});

describe('scheduling a shoot before its scripts are planned', () => {
  it('books the shoot with no scripts, then reminds managers ahead of time until scripts are planned and assigned', async () => {
    const r = await manager.post('/api/shoots', { clientId: acmeId, title: 'Winter lookbook', startDate: '2026-11-30' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ batchId: null, batch: null });
    expect(r.body.warnings.join(' ')).toMatch(/No scripts planned yet.*reminder on Nov 16/);
    const shootId = r.body.shootId as number;
    const cal = (await manager.get('/api/calendar?from=2026-11-01&to=2026-12-31')).body.events;
    expect(cal.some((e: any) => e.shootId === shootId && e.type === 'shoot')).toBe(true);

    const planning = async (who = manager) => ((await who.get('/api/notifications')).body.notifications as any[]).filter((n) => n.type === 'planning' && /Winter lookbook|Acme/.test(n.body + n.title));
    const before = (await planning()).length;
    try {
      NOW = new Date('2026-11-10T16:00:00Z'); // 20 days out: too early
      await runReminders(ctx);
      expect((await planning()).length).toBe(before);
      NOW = new Date('2026-11-18T16:00:00Z'); // 12 days out: first nudge, once
      await runReminders(ctx);
      await runReminders(ctx);
      const first = await planning();
      expect(first.length).toBe(before + 1);
      expect(first[0].title).toMatch(/Shoot in 12 days · Acme Outdoor Co.: no scripts planned/);
      expect(first[0].body).toMatch(/drafts \(due Nov 25\)/);
      expect((await planning(sarah)).length).toBe(0); // writers aren't nagged about planning
      NOW = new Date('2026-11-24T16:00:00Z'); // 6 days out: second nudge
      await runReminders(ctx);
      expect((await planning()).length).toBe(before + 2);

      // scripts planned but not assigned: still reminded
      const b = await manager.post('/api/batches', { clientId: acmeId, shootId, title: 'Winter lookbook scripts', targetCount: 6, split: [] });
      expect(b.status).toBe(200);
      NOW = new Date('2026-11-27T16:00:00Z');
      await runReminders(ctx);
      const unassigned = ((await manager.get('/api/notifications')).body.notifications as any[]).filter((n) => n.type === 'planning' && /Winter lookbook scripts/.test(n.body));
      expect(unassigned[0]?.title).toMatch(/6 scripts unassigned/);
      // once assigned, no more planning reminders
      const detail = (await manager.get(`/api/batches/${b.body.batchId}`)).body as BatchDetail;
      await manager.post(`/api/batches/${b.body.batchId}/scripts/assign`, { scriptIds: detail.scripts.map((s) => s.id), assigneeId: ids.sarah });
      NOW = new Date('2026-11-29T16:00:00Z');
      const count = (await manager.get('/api/notifications')).body.notifications.filter((n: any) => n.type === 'planning').length;
      await runReminders(ctx);
      expect((await manager.get('/api/notifications')).body.notifications.filter((n: any) => n.type === 'planning').length).toBe(count);
    } finally {
      NOW = new Date('2026-09-28T16:00:00Z');
    }
  });

  it('lets managers choose how far ahead the planning reminder comes', async () => {
    expect((await manager.patch('/api/settings', { planReminderDays: 21 })).status).toBe(200);
    expect((await manager.get('/api/settings')).body.settings?.planReminderDays ?? (await manager.get('/api/bootstrap')).body.settings.planReminderDays).toBe(21);
    expect((await manager.patch('/api/settings', { planReminderDays: 1 })).status).toBe(400);
    await manager.patch('/api/settings', { planReminderDays: 14 });
  });
});

describe('potential clients', () => {
  it('tracks potential clients separately and turns them into clients when they sign', async () => {
    const r = await manager.post('/api/clients', { name: 'Sunny Side Bakery', prospect: true, description: 'Met at the expo — wants 20 scripts a month' });
    expect(r.status).toBe(200);
    const id = r.body.clientId as number;
    const prospects = (await manager.get('/api/clients?status=prospect')).body.clients;
    expect(prospects.map((c: any) => c.name)).toContain('Sunny Side Bakery');
    expect((await manager.get('/api/clients?status=active')).body.clients.some((c: any) => c.id === id)).toBe(false);
    const current = (await manager.get('/api/clients?status=current')).body.clients.find((c: any) => c.id === id);
    expect(current).toMatchObject({ status: 'prospect', becameClientAt: null });

    // it's only a label: potential clients can have shoots and batches like anyone
    const shoot = await manager.post('/api/shoots', { clientId: id, startDate: '2026-12-01' });
    expect(shoot.status).toBe(200);
    expect((await sarah.post(`/api/clients/${id}/stage`, { stage: 'client' })).status).toBe(403);

    const conv = await manager.post(`/api/clients/${id}/stage`, { stage: 'client' });
    expect(conv.body).toMatchObject({ ok: true, changed: true });
    const detail = (await manager.get(`/api/clients/${id}`)).body;
    expect(detail.status ?? detail.client?.status).toBe('active');
    expect((await manager.get('/api/clients?status=current')).body.clients.find((c: any) => c.id === id).becameClientAt).toBeTruthy();
    const log = (await manager.get(`/api/clients/${id}`)).body;
    expect(JSON.stringify(log)).toMatch(/Sunny Side Bakery became a client/);
  });

  it('moving a client with work to Potential clients changes nothing but the label', async () => {
    const shootsBefore = (await manager.get('/api/shoots?from=2026-09-01&to=2026-12-31')).body.shoots.filter((x: any) => x.clientId === acmeId);
    const batchesBefore = (await manager.get('/api/batches')).body.batches.filter((b: any) => b.clientId === acmeId);
    expect(shootsBefore.length + batchesBefore.length).toBeGreaterThan(0);
    const cal = async () => JSON.stringify((await manager.get('/api/calendar?from=2026-09-01&to=2026-12-31')).body);
    const calBefore = await cal();

    const moved = await manager.post(`/api/clients/${acmeId}/stage`, { stage: 'prospect' });
    expect(moved.status).toBe(200);
    expect(moved.body.changed).toBe(true);
    expect((await manager.get('/api/clients?status=prospect')).body.clients.some((c: any) => c.id === acmeId)).toBe(true);
    // the calendar, shoots and batches are exactly as they were
    expect(await cal()).toBe(calBefore);
    expect((await manager.get('/api/shoots?from=2026-09-01&to=2026-12-31')).body.shoots.filter((x: any) => x.clientId === acmeId)).toEqual(shootsBefore);
    expect((await manager.get('/api/batches')).body.batches.filter((b: any) => b.clientId === acmeId).map((b: any) => b.id)).toEqual(batchesBefore.map((b: any) => b.id));
    // and work can still be added
    expect((await manager.post('/api/shoots', { clientId: acmeId, startDate: '2026-12-10' })).status).toBe(200);

    expect((await manager.post(`/api/clients/${acmeId}/stage`, { stage: 'client' })).body.changed).toBe(true);
  });
});

describe('paste notes (AI import)', () => {
  const fakePlan = {
    summary: 'Five clients: two with scripts to write, one shoot, posting and filming notes.',
    questions: [{ clientName: 'Elegant Jeweler', question: 'Does “next Wednesday” mean Sep 30 or Oct 7?', assumed: 'Wednesday Oct 7; filming Friday Oct 9' }],
    clients: [
      { name: 'Shimonov Law', status: 'active' as const, description: 'Brand-new Instagram account.', brandVoice: null, guidance: 'Start around Oct 5–7. Test formats to see what performs.', briefings: [], shoots: [], batches: [], notes: ['No script count given yet.'] },
      { name: 'Dentist Mike', status: 'active' as const, description: null, brandVoice: null, guidance: 'Schedule all videos on his main Instagram; collab with his other account daily.', briefings: [], shoots: [], batches: [], notes: [] },
      { name: 'Elon Layliev', status: 'active' as const, description: null, brandVoice: 'Educational.', guidance: 'Formats: education, myth vs fact, rankings. Suggestions: do this not that; FAQ answers.', briefings: [], shoots: [],
        batches: [{ title: 'Elon Layliev · 45 scripts', targetCount: 45, shootKey: null, plannedStart: null, draftDue: null, finalDue: null, brief: 'Education, myth vs fact, rankings', writerNames: ['Sarah'], nextAction: null }], notes: [] },
      { name: 'Daniel Abrams', status: 'active' as const, description: null, brandVoice: null, guidance: 'No scripts — we film his life.', shoots: [], batches: [], notes: [],
        briefings: [{ title: 'An engagement ring from start to finish', summary: 'Number of videos TBD.', instructions: 'Plan about half of each filming day around the ring; the rest is his day.' }] },
      { name: 'Elegant Jeweler', status: 'active' as const, description: null, brandVoice: null, guidance: 'Short turnaround.', briefings: [], notes: ['Drafts and final both due Oct 8 because writing starts Oct 7.'],
        shoots: [{ key: 's1', title: 'Filming session', startDate: '2026-10-09', endDate: null }],
        batches: [{ title: 'Elegant Jeweler · 8 scripts', targetCount: 8, shootKey: 's1', plannedStart: '2026-10-07', draftDue: '2026-10-08', finalDue: '2026-10-08', brief: null, writerNames: ['Nobody Known'], nextAction: 'Assign a writer' }] },
      { name: 'acme outdoor co.', status: 'active' as const, description: null, brandVoice: null, guidance: 'Post Reels at 6pm.', briefings: [], shoots: [], batches: [], notes: [] },
    ],
  };
  let lastInput: any = null;

  it('explains how to turn it on when no AI key is set, and only managers can use it', async () => {
    ctx.notesReader = null;
    const r = await manager.post('/api/import/read', { text: 'hello' });
    expect(r.status).toBe(503);
    expect(r.body.error.message).toMatch(/ANTHROPIC_API_KEY/);
    expect((await manager.get('/api/bootstrap')).body.notesImport).toBe(false);
    ctx.notesReader = { read: async (input) => { lastInput = input; return JSON.parse(JSON.stringify(fakePlan)); } };
    expect((await manager.get('/api/bootstrap')).body.notesImport).toBe(true);
    expect((await sarah.post('/api/import/read', { text: 'hello' })).status).toBe(403);
    expect((await manager.post('/api/import/read', { text: '   ' })).status).toBe(400);
  });

  it('reads notes into a preview without saving anything, matching existing clients', async () => {
    const before = (await manager.get('/api/clients?status=all')).body.clients.length;
    const r = await manager.post('/api/import/read', { text: 'Shimonov law … Elegant Jeweler next Wednesday …', answers: null });
    expect(r.status).toBe(200);
    expect(lastInput.text).toMatch(/Shimonov/);
    const plan = r.body.plan;
    expect(plan.clients.find((c: any) => c.name === 'Acme Outdoor Co.').existingClientId).toBe(acmeId);
    expect(plan.clients.find((c: any) => c.name === 'Elon Layliev').existingClientId).toBeNull();
    expect(plan.questions[0].assumed).toMatch(/Oct 7/);
    expect((await manager.get('/api/clients?status=all')).body.clients.length).toBe(before); // nothing saved
  });

  it('saves the confirmed plan into the right places, once', async () => {
    const plan = (await manager.post('/api/import/read', { text: 'notes' })).body.plan;
    const acmeBefore = (await manager.get(`/api/clients/${acmeId}`)).body;
    const r = await manager.post('/api/import/apply', { plan });
    expect(r.status).toBe(200);
    const byName = Object.fromEntries(r.body.clients.map((c: any) => [c.name, c]));
    expect(byName['Elon Layliev'].created).toBe(true);
    expect(byName['Acme Outdoor Co.'].created).toBe(false);
    expect(r.body.warnings.join(' ')).toMatch(/Nobody Known/);

    const all = (await manager.get('/api/clients?status=all')).body.clients;
    const id = (n: string) => all.find((c: any) => c.name === n).id;
    const detail = async (n: string) => (await manager.get(`/api/clients/${id(n)}`)).body;
    // Elegant Jeweler: shoot Oct 9 with 8 unassigned scripts, writing from Oct 7, drafts & final Oct 8
    const ej = await detail('Elegant Jeweler');
    expect(ej.shoots.map((s: any) => s.startDate)).toEqual(['2026-10-09']);
    expect(ej.batches[0]).toMatchObject({ targetCount: 8, plannedStart: '2026-10-07', draftDue: '2026-10-08', finalDue: '2026-10-08', draftDueMode: 'manual' });
    expect(ej.batches[0].progress.unassigned).toBe(8);
    // Elon: 45 scripts, all to Sarah, no shoot
    const el = await detail('Elon Layliev');
    expect(el.batches[0]).toMatchObject({ targetCount: 45, shootId: null });
    expect(el.batches[0].writers[0]).toMatchObject({ name: 'Sarah Chen', count: 45 });
    expect(el.brandVoice).toBe('Educational.');
    // Daniel: a briefing, no scripts; Dentist Mike and Shimonov: guidance only
    const da = await detail('Daniel Abrams');
    expect(da.briefings[0].title).toBe('An engagement ring from start to finish');
    expect(da.batches).toHaveLength(0);
    expect((await detail('Dentist Mike')).guidance).toMatch(/main Instagram/);
    expect((await detail('Shimonov Law')).batches).toHaveLength(0);
    // an existing client keeps what it had; the new note is added underneath
    const acme = (await manager.get(`/api/clients/${acmeId}`)).body;
    expect(acme.guidance).toContain('Post Reels at 6pm.');
    if (acmeBefore.guidance) expect(acme.guidance.startsWith(acmeBefore.guidance)).toBe(true);

    // saving the same notes again doesn't duplicate anything
    const again = await manager.post('/api/import/apply', { plan });
    expect(again.status).toBe(200);
    expect((await detail('Elegant Jeweler')).shoots).toHaveLength(1);
    expect((await detail('Elon Layliev')).batches).toHaveLength(1);
    expect((await detail('Daniel Abrams')).briefings).toHaveLength(1);
    expect(((await manager.get(`/api/clients/${acmeId}`)).body.guidance.match(/Post Reels at 6pm/g) ?? []).length).toBe(1);
  });

  it('saves all or nothing', async () => {
    const old = (await manager.post('/api/clients', { name: 'Old Archived Co' })).body.clientId;
    await manager.post(`/api/clients/${old}/archive`, { archived: true });
    const plan = { summary: '', questions: [], clients: [
      { name: 'Fresh Start Co', existingClientId: null, status: 'active', description: 'x', brandVoice: null, guidance: null, briefings: [], shoots: [], batches: [], notes: [] },
      { name: 'Old Archived Co', existingClientId: old, status: 'active', description: null, brandVoice: null, guidance: null, briefings: [], notes: [],
        shoots: [{ key: 's1', title: null, startDate: '2026-11-02', endDate: null }], batches: [] },
    ] };
    const r = await manager.post('/api/import/apply', { plan });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/archived/);
    expect((await manager.get('/api/clients?status=all')).body.clients.some((c: any) => c.name === 'Fresh Start Co')).toBe(false);
  });
});

describe('view as and recording mode', () => {
  it('lets the admin see the site as someone else, view only', async () => {
    expect((await sarah.post('/api/admin/view-as', { userId: ids.marcus })).status).toBe(403);
    expect((await sarah.get('/api/bootstrap')).body.mode).toBeNull();

    const start = await manager.post('/api/admin/view-as', { userId: ids.sarah });
    expect(start.status).toBe(200);
    expect(start.body.viewingAs).toMatchObject({ id: ids.sarah, name: 'Sarah Chen', roleLabel: 'Writer' });
    const boot = (await manager.get('/api/bootstrap')).body;
    expect(boot.me).toMatchObject({ id: ids.sarah, role: 'writer' });
    expect(boot.mode).toMatchObject({ realId: ids.josh, realName: 'Josh Rath', recording: null });
    expect(boot.whatsNewSeen).toBe('2026-09-28-animations');
    // what she sees, including what writers can't open
    expect((await manager.get('/api/audit')).status).toBe(403);
    // changes are off; background writes quietly do nothing
    const blocked = await manager.post('/api/clients', { name: 'Should Not Exist' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('viewing_as');
    expect((await manager.post('/api/me/whats-new', { seen: 'something-else' })).status).toBe(200);
    expect((await sarah.get('/api/bootstrap')).body.whatsNewSeen).toBe('2026-09-28-animations');
    expect((await manager.get('/api/moments')).body).toEqual([]);
    // her own sign-in is untouched
    expect((await sarah.get('/api/bootstrap')).body.mode).toBeNull();

    const stop = await manager.post('/api/admin/view-as/stop');
    expect(stop.body.viewingAs).toBeNull();
    expect((await manager.get('/api/bootstrap')).body.me.id).toBe(ids.josh);
    const log = (await manager.get('/api/audit?kind=auth')).body.entries.map((e: any) => e.summary);
    expect(log).toContain('Started viewing as Sarah Chen');
    expect(log).toContain('Stopped viewing as Sarah Chen');
  });

  it('recording mode works on a practice copy that’s thrown away when it’s turned off', async () => {
    const clientsBefore = (await manager.get('/api/clients?status=all')).body.clients.length;
    const on = await manager.post('/api/admin/recording/start');
    expect(on.status).toBe(200);
    expect(on.body.recording).not.toBeNull();
    expect((await manager.get('/api/bootstrap')).body.mode.recording).not.toBeNull();

    // everything is there and anything goes
    expect((await manager.get('/api/clients?status=all')).body.clients.length).toBe(clientsBefore);
    const made = await manager.post('/api/clients', { name: 'Practice Client' });
    expect(made.status).toBe(200);
    expect((await manager.get('/api/clients?status=all')).body.clients.some((c: any) => c.name === 'Practice Client')).toBe(true);
    // new rows don't collide with copied ones
    expect(made.body.clientId).toBeGreaterThan(acmeId);
    // copied files still open
    const file = await db.one<{ id: number }>(`select f.id from files f join resources r on r.file_id = f.id where r.removed_at is null order by f.id limit 1`);
    const got = await app.inject({ method: 'GET', url: `/api/files/${file!.id}`, headers: { cookie: manager.cookie } });
    expect(got.statusCode).toBe(200);
    expect(got.body).toContain('%PDF-1.4 hello');

    // act as a writer too
    await manager.post('/api/admin/view-as', { userId: ids.sarah });
    expect((await manager.get('/api/bootstrap')).body.me.id).toBe(ids.sarah);
    expect((await manager.post('/api/me/whats-new', { seen: 'practice-only' })).status).toBe(200);
    expect((await manager.get('/api/bootstrap')).body.whatsNewSeen).toBe('practice-only');

    // nobody else sees any of it
    expect((await sarah.get('/api/bootstrap')).body.whatsNewSeen).toBe('2026-09-28-animations');
    expect((await sarah.get('/api/clients?status=all')).body.clients.some((c: any) => c.name === 'Practice Client')).toBe(false);
    expect(await db.one(`select id from clients where name = 'Practice Client'`)).toBeUndefined();

    const off = await manager.post('/api/admin/recording/stop');
    expect(off.body.recording).toBeNull();
    // still viewing as Sarah (she's real), on the real workspace, view only
    expect(off.body.viewingAs?.id).toBe(ids.sarah);
    expect((await manager.get('/api/bootstrap')).body.whatsNewSeen).toBe('2026-09-28-animations');
    await manager.post('/api/admin/view-as/stop');
    expect((await manager.get('/api/clients?status=all')).body.clients.some((c: any) => c.name === 'Practice Client')).toBe(false);
    const log = (await manager.get('/api/audit?kind=auth')).body.entries.map((e: any) => e.summary);
    expect(log.some((s: string) => s.startsWith('Turned on Recording mode'))).toBe(true);
    expect(log.some((s: string) => s.startsWith('Turned off Recording mode'))).toBe(true);
  });

  it('signing out ends recording mode', async () => {
    const cookie = await login('josh@scale.test', 'correct-horse-battery');
    const josh = as(cookie);
    await josh.post('/api/admin/recording/start');
    expect((await josh.get('/api/bootstrap')).body.mode.recording).not.toBeNull();
    expect((await josh.post('/api/auth/logout')).status).toBe(200);
    expect((await josh.get('/api/bootstrap')).status).toBe(401);
  });
});

describe('script bank', () => {
  it('lists one entry per document, each script under the newest document it was sent in', async () => {
    const all = (await sarah.get('/api/script-bank?limit=200')).body;
    // every script sits under the newest document that includes it
    const current = await db.query<{ submission_id: number; n: number }>(
      `select latest as submission_id, count(*)::int as n from (
         select sc.id, (select s.id from submission_scripts ss2 join submissions s on s.id = ss2.submission_id
                         where ss2.script_id = sc.id order by s.created_at desc, s.id desc limit 1) as latest
           from scripts sc where sc.removed_at is null) x
        where latest is not null group by latest`,
    );
    const fromSubs = all.deliverables.filter((d: any) => d.key.startsWith('s'));
    expect(fromSubs.length).toBe(current.length);
    expect(current.length).toBeGreaterThan(0);
    for (const c of current) expect(fromSubs.find((x: any) => x.key === `s${c.submission_id}`).scripts.length).toBe(c.n);
    expect(all.scriptCount).toBe(all.deliverables.reduce((n: number, d: any) => n + d.scripts.length, 0));

    // "#N" finds the document the script is in
    const d0 = fromSubs[0];
    const n0 = d0.scripts[0].number;
    const hit = (await manager.get(`/api/script-bank?q=%23${n0}&clientId=${d0.clientId}&limit=200`)).body;
    expect(hit.deliverables.some((d: any) => d.key === d0.key)).toBe(true);
    expect(hit.deliverables.every((d: any) => d.scripts.some((s: any) => s.number === n0))).toBe(true);

    // filters
    const acme = (await manager.get(`/api/script-bank?clientId=${acmeId}&limit=200`)).body;
    expect(acme.deliverables.every((d: any) => d.clientId === acmeId)).toBe(true);
    const hers = (await manager.get(`/api/script-bank?writerId=${ids.sarah}&limit=200`)).body;
    expect(hers.deliverables.every((d: any) => d.writerId === ids.sarah)).toBe(true);
    const done = (await manager.get('/api/script-bank?status=finished&limit=200')).body;
    expect(done.deliverables.every((d: any) => d.past || d.scripts.some((s: any) => s.status === 'approved' || s.status === 'delivered'))).toBe(true);
    const byName = (await manager.get(`/api/script-bank?q=${encodeURIComponent(d0.clientName.toLowerCase())}`)).body;
    expect(byName.deliverables.some((d: any) => d.key === d0.key)).toBe(true);
    expect((await call('GET', '/api/script-bank')).status).toBe(401);
  });

  it('keeps finished scripts findable after a partial resend, lists scripts with no document, and puts the edited version first', async () => {
    const b = await manager.post('/api/batches', { clientId: acmeId, title: 'Bank keeps everything', targetCount: 4, split: [{ writerId: ids.sarah, count: 4 }] });
    const id = b.body.batchId;
    const sc = (await manager.get(`/api/batches/${id}`)).body.scripts as { id: number; number: number }[];
    const [s1, s2, s3, s4] = sc.map((x) => x.id);
    const v1 = await sarah.post(`/api/batches/${id}/submissions`, { scriptIds: [s1, s2, s3], url: 'https://docs.google.com/document/d/bank-v1' });
    expect(v1.status).toBe(200);
    // approve 1–2 with an edited version, send 3 back, and the writer resends only 3
    expect((await manager.post(`/api/batches/${id}/review`, { action: 'approve', scriptIds: [s1, s2], submissionId: v1.body.submissionId, url: 'https://docs.google.com/document/d/bank-edit', note: 'Tightened the hooks' })).status).toBe(200);
    await manager.post(`/api/batches/${id}/review`, { action: 'revisions', scriptIds: [s3], submissionId: v1.body.submissionId, note: 'Rework the ending' });
    expect((await sarah.post(`/api/batches/${id}/submissions`, { scriptIds: [s3], url: 'https://docs.google.com/document/d/bank-v2' })).status).toBe(200);
    // script 4 is marked ready without any document, then approved
    await manager.post(`/api/batches/${id}/scripts/action`, { action: 'submit', scriptIds: [s4], timelinerUrl: null, note: null });
    await manager.post(`/api/batches/${id}/scripts/action`, { action: 'approve', scriptIds: [s4], timelinerUrl: null, note: null });

    const list = (await manager.get(`/api/script-bank?clientId=${acmeId}&limit=200`)).body.deliverables.filter((d: any) => d.batchId === id);
    const byKind = (k: string) => list.filter((d: any) => d.kind === k);
    const first = list.find((d: any) => d.href === 'https://docs.google.com/document/d/bank-v1');
    expect(first.scripts.map((x: any) => x.number)).toEqual([1, 2]); // still here after the resend of 3
    expect(first.edited).toMatchObject({ href: 'https://docs.google.com/document/d/bank-edit', by: 'Josh Rath', note: 'Tightened the hooks', ranges: '1–2' });
    expect(list.find((d: any) => d.href === 'https://docs.google.com/document/d/bank-v2').scripts.map((x: any) => x.number)).toEqual([3]);
    expect(byKind('none')).toHaveLength(1);
    expect(byKind('none')[0]).toMatchObject({ ranges: '4', href: null, finished: 1 });
    // "#1" still finds script 1
    const hit = (await manager.get(`/api/script-bank?q=%231&clientId=${acmeId}&limit=200`)).body.deliverables;
    expect(hit.some((d: any) => d.key === first.key)).toBe(true);

    // an editor sees finished scripts even when others in the same document aren't
    const ed = await manager.post('/api/users', { name: 'Bank Editor', email: 'bank-editor@scale.test', role: 'editor', password: 'bank-editor-pass' });
    expect(ed.status).toBe(200);
    const editor = as(await login('bank-editor@scale.test', 'bank-editor-pass'));
    await manager.post(`/api/batches/${id}/review`, { action: 'revisions', scriptIds: [s1], note: 'One more pass' });
    const seen = (await editor.get(`/api/script-bank?clientId=${acmeId}&limit=200`)).body.deliverables.filter((d: any) => d.batchId === id);
    const v1Row = seen.find((d: any) => d.href === 'https://docs.google.com/document/d/bank-v1');
    expect(v1Row).toMatchObject({ finished: 1 });
    expect(seen.some((d: any) => d.href === 'https://docs.google.com/document/d/bank-v2')).toBe(false); // nothing finished in it
  });
});

describe('overview for each viewer', () => {
  it('admins see the whole team; writers see only their own scripts', async () => {
    const team = (await manager.get('/api/dashboard')).body;
    expect(team.scope).toBe('team');
    const hers = (await sarah.get('/api/dashboard')).body;
    expect(hers.scope).toBe('mine');
    const own = await db.query<{ batch_id: number; status: string; n: number }>(
      `select s.batch_id, s.status, count(*)::int as n from scripts s join batches b on b.id = s.batch_id
        where s.assignee_id = $1 and s.removed_at is null and b.archived_at is null group by 1, 2`, [ids.sarah],
    );
    const inReview = own.filter((r) => r.status === 'ready_for_review').reduce((n, r) => n + r.n, 0);
    expect(hers.cards.awaitingReviewScripts).toBe(inReview);
    const myBatches = new Set(own.map((r) => r.batch_id));
    expect(hers.activeBatches.every((b: any) => myBatches.has(b.id))).toBe(true);
    // every batch shows only her share
    for (const b of hers.activeBatches) expect(b.writers.every((w: any) => w.userId === ids.sarah)).toBe(true);
    expect(hers.unassignedScripts).toBe(0);
    expect(hers.workload.every((w: any) => w.userId === ids.sarah)).toBe(true);
    expect(hers.recentDeliveries.every((d: any) => d.confirmedById === ids.sarah)).toBe(true);
    const dueTotal = (d: any) => d.due.final.reduce((n: number, x: any) => n + x.total, 0);
    expect(dueTotal(hers)).toBeLessThanOrEqual(dueTotal(team));
  });
});

describe('today pill', () => {
  it('counts what’s due today, marks drafts done once sent, and scopes to the viewer', async () => {
    const before = (await sarah.get('/api/today')).body;
    expect(before.scope).toBe('me');
    const b = await manager.post('/api/batches', { clientId: acmeId, title: 'Due today batch', targetCount: 3, draftDue: '2026-09-28', finalDue: '2026-10-09', split: [{ writerId: ids.sarah, count: 3 }] });
    expect(b.status).toBe(200);
    const batchId = b.body.batchId ?? b.body.batch?.id;
    const t1 = (await sarah.get('/api/today')).body;
    const item = t1.items.find((i: any) => i.batchId === batchId);
    expect(item).toMatchObject({ kind: 'draft', total: 3, done: 0, overdue: false });
    expect(t1.total).toBe(before.total + 3);

    // not in anyone else's day
    expect((await marcus.get('/api/today')).body.items.some((i: any) => i.batchId === batchId)).toBe(false);
    // managers see the team, or one person
    expect((await manager.get('/api/today')).body.scope).toBe('team');
    expect((await manager.get('/api/today')).body.items.some((i: any) => i.batchId === batchId)).toBe(true);
    const one = (await manager.get(`/api/today?userId=${ids.sarah}`)).body;
    expect(one.scope).toBe('person');
    expect(one.total).toBe(t1.total);
    // writers can't peek at someone else's day
    expect((await sarah.get(`/api/today?userId=${ids.marcus}`)).body.scope).toBe('me');

    const detail = (await sarah.get(`/api/batches/${batchId}`)).body;
    const sent = await sarah.post(`/api/batches/${batchId}/submissions`, { scriptIds: detail.scripts.map((s: any) => s.id), url: 'https://docs.example/today' });
    expect(sent.status).toBe(200);
    const t2 = (await sarah.get('/api/today')).body;
    expect(t2.items.find((i: any) => i.batchId === batchId)).toMatchObject({ total: 3, done: 3 });
    expect(t2.done).toBe(t1.done + 3);
  });
});

describe('past scripts in the script bank', () => {
  it('lets managers file old PDFs and links under a client, shown and searchable in the bank', async () => {
    const boundary = '----smpast';
    const payload = [
      `--${boundary}\r\nContent-Disposition: form-data; name="clientId"\r\n\r\n${acmeId}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="writerName"\r\n\r\nsarah chen`,
      `--${boundary}\r\nContent-Disposition: form-data; name="scriptCount"\r\n\r\n12`,
      `--${boundary}\r\nContent-Disposition: form-data; name="writtenOn"\r\n\r\n2025-03-14`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="Spring 2025 hooks.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4 old scripts`,
      `--${boundary}--\r\n`,
    ].join('\r\n');
    const up = await app.inject({ method: 'POST', url: '/api/script-bank/past', headers: { 'x-scale-media': '1', cookie: manager.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
    expect(up.statusCode).toBe(200);
    const link = await manager.post('/api/script-bank/past', { clientId: acmeId, url: 'https://docs.google.com/document/d/old-batch', title: 'Launch scripts 2024', writerName: 'A freelancer' });
    expect(link.status).toBe(200);
    // writers can't add them
    expect((await sarah.post('/api/script-bank/past', { clientId: acmeId, url: 'https://example.com/x' })).status).toBe(403);
    // needs a file or a link, and a client
    expect((await manager.post('/api/script-bank/past', { clientId: acmeId })).status).toBe(400);
    expect((await manager.post('/api/script-bank/past', { url: 'https://example.com/x' })).status).toBe(400);

    const bank = (await sarah.get(`/api/script-bank?clientId=${acmeId}&limit=200`)).body;
    const pdf = bank.deliverables.find((d: any) => d.batchTitle === 'Spring 2025 hooks');
    expect(pdf).toMatchObject({ kind: 'file', batchId: null, writerId: ids.sarah, writerName: 'Sarah Chen', state: 'delivered' });
    expect(pdf.past).toMatchObject({ scriptCount: 12, writtenOn: '2025-03-14' });
    const got = await app.inject({ method: 'GET', url: pdf.href, headers: { cookie: sarah.cookie } });
    expect(got.statusCode).toBe(200);
    expect(got.body).toContain('%PDF-1.4 old scripts');
    const other = bank.deliverables.find((d: any) => d.batchTitle === 'Launch scripts 2024');
    expect(other).toMatchObject({ kind: 'link', href: 'https://docs.google.com/document/d/old-batch', writerId: null, writerName: 'A freelancer' });
    // found by title, counted with the rest, and filtered by writer
    expect((await manager.get('/api/script-bank?q=spring%202025')).body.deliverables.some((d: any) => d.key === pdf.key)).toBe(true);
    expect((await manager.get(`/api/script-bank?writerId=${ids.sarah}&limit=200`)).body.deliverables.some((d: any) => d.key === pdf.key)).toBe(true);
    expect((await manager.get('/api/script-bank?status=finished&limit=200')).body.deliverables.some((d: any) => d.key === pdf.key)).toBe(true);

    // removing takes it out of the bank and its file stops being served
    expect((await sarah.del(`/api/script-bank/past/${pdf.past.id}`)).status).toBe(403);
    expect((await manager.del(`/api/script-bank/past/${pdf.past.id}`)).status).toBe(200);
    expect((await manager.get(`/api/script-bank?clientId=${acmeId}&limit=200`)).body.deliverables.some((d: any) => d.key === pdf.key)).toBe(false);
    expect((await app.inject({ method: 'GET', url: pdf.href, headers: { cookie: sarah.cookie } })).statusCode).toBe(404);
  });
});

describe('a manager delivering a shared batch', () => {
  it('delivers every approved script for everyone, and tells the other writers', async () => {
    const b = await manager.post('/api/batches', { clientId: acmeId, title: 'Shared delivery', targetCount: 6, finalDue: '2026-10-21', split: [{ writerId: ids.sarah, count: 3 }, { writerId: ids.josh, count: 2 }, { writerId: ids.marcus, count: 1 }] });
    const batchId = b.body.batchId;
    const scripts = (await manager.get(`/api/batches/${batchId}`)).body.scripts as { id: number; assigneeId: number; number: number }[];
    const of = (uid: number) => scripts.filter((s) => s.assigneeId === uid).map((s) => s.id);
    await sarah.post(`/api/batches/${batchId}/submissions`, { scriptIds: of(ids.sarah), url: 'https://docs.google.com/document/d/sarah' });
    await manager.post(`/api/batches/${batchId}/submissions`, { scriptIds: of(ids.josh), url: 'https://docs.google.com/document/d/josh' });
    await manager.post(`/api/batches/${batchId}/review`, { action: 'approve', scriptIds: [...of(ids.sarah), ...of(ids.josh)] });
    // the manager confirms only their own two…
    const r = await manager.post(`/api/batches/${batchId}/scripts/action`, { action: 'deliver', scriptIds: of(ids.josh), timelinerUrl: null, note: null });
    expect(r.status).toBe(200);
    // …and the whole batch goes: Sarah's approved scripts too, Marcus's unwritten one stays
    expect(r.body.changed).toHaveLength(5);
    const after = r.body.batch.scripts as { assigneeId: number; status: string }[];
    expect(after.filter((s) => s.assigneeId !== ids.marcus).every((s) => s.status === 'delivered')).toBe(true);
    expect(after.find((s) => s.assigneeId === ids.marcus)!.status).toBe('not_started');
    expect(r.body.batch.activity[0].summary).toMatch(/on behalf of Sarah Chen/);
    const notes = (await sarah.get('/api/notifications')).body.notifications;
    expect(notes[0].title).toMatch(/^Delivered · .+ · Shared delivery$/);
    // only Sarah's own scripts, not Josh's
    const sarahNums = scripts.filter((s) => s.assigneeId === ids.sarah).map((s) => s.number);
    expect(notes[0].body).toContain(`Josh Rath marked your scripts ${sarahNums[0]}–${sarahNums[sarahNums.length - 1]} delivered`);
    // a writer confirming delivers only their own
    const b2 = await manager.post('/api/batches', { clientId: acmeId, title: 'Writer delivery', targetCount: 2, finalDue: '2026-10-21', split: [{ writerId: ids.sarah, count: 1 }, { writerId: ids.marcus, count: 1 }] });
    const s2 = (await manager.get(`/api/batches/${b2.body.batchId}`)).body.scripts as { id: number; assigneeId: number }[];
    await manager.post(`/api/batches/${b2.body.batchId}/submissions`, { scriptIds: s2.map((s) => s.id), url: 'https://docs.google.com/document/d/both' });
    await manager.post(`/api/batches/${b2.body.batchId}/review`, { action: 'approve', scriptIds: s2.map((s) => s.id) });
    const w = await sarah.post(`/api/batches/${b2.body.batchId}/scripts/action`, { action: 'deliver', scriptIds: s2.filter((s) => s.assigneeId === ids.sarah).map((s) => s.id) });
    expect(w.body.changed).toHaveLength(1);
  });
});

describe('catching up batches a manager delivered before the whole-batch rule', () => {
  it('delivers the other writers’ approved scripts, and leaves unapproved ones alone', async () => {
    const b = await manager.post('/api/batches', { clientId: acmeId, title: 'Stuck delivery', targetCount: 6, finalDue: '2026-10-21', split: [{ writerId: ids.sarah, count: 3 }, { writerId: ids.josh, count: 2 }, { writerId: ids.marcus, count: 1 }] });
    const batchId = b.body.batchId;
    const scripts = (await manager.get(`/api/batches/${batchId}`)).body.scripts as { id: number; assigneeId: number }[];
    const of = (uid: number) => scripts.filter((s) => s.assigneeId === uid).map((s) => s.id);
    await manager.post(`/api/batches/${batchId}/submissions`, { scriptIds: [...of(ids.sarah), ...of(ids.josh)], url: 'https://docs.google.com/document/d/stuck' });
    await manager.post(`/api/batches/${batchId}/review`, { action: 'approve', scriptIds: [...of(ids.sarah), ...of(ids.josh)] });
    // the old behaviour: the manager's delivery covered only their own scripts
    const d = await db.one<{ id: number }>(`insert into deliveries (batch_id, confirmed_by, timeliner_url) values ($1, $2, 'https://timeliner.io/stuck') returning id`, [batchId, ids.josh]);
    await db.query(`update scripts set status = 'delivered', delivered_at = now(), delivered_by = $1, delivery_id = $2 where id = any($3::bigint[])`, [ids.josh, d!.id, of(ids.josh)]);
    // a batch only a writer delivered is not touched
    const w = await manager.post('/api/batches', { clientId: acmeId, title: 'Writer only', targetCount: 2, finalDue: '2026-10-21', split: [{ writerId: ids.sarah, count: 1 }, { writerId: ids.marcus, count: 1 }] });
    const ws = (await manager.get(`/api/batches/${w.body.batchId}`)).body.scripts as { id: number; assigneeId: number }[];
    await manager.post(`/api/batches/${w.body.batchId}/submissions`, { scriptIds: ws.map((s) => s.id), url: 'https://docs.google.com/document/d/w' });
    await manager.post(`/api/batches/${w.body.batchId}/review`, { action: 'approve', scriptIds: ws.map((s) => s.id) });
    await sarah.post(`/api/batches/${w.body.batchId}/scripts/action`, { action: 'deliver', scriptIds: ws.filter((s) => s.assigneeId === ids.sarah).map((s) => s.id) });

    await db.tx(async (t) => { for (const stmt of (MIGRATIONS[8] as string).split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) await t.query(stmt); });

    const after = (await manager.get(`/api/batches/${batchId}`)).body;
    expect(after.scripts.filter((s: any) => s.assigneeId === ids.sarah).map((s: any) => s.status)).toEqual(['delivered', 'delivered', 'delivered']);
    expect(after.scripts.find((s: any) => s.assigneeId === ids.marcus).status).toBe('not_started');
    expect(after.activity[0].summary).toMatch(/Delivered the rest of the batch: 3 approved scripts/);
    const writerOnly = (await manager.get(`/api/batches/${w.body.batchId}`)).body.scripts as { assigneeId: number; status: string }[];
    expect(writerOnly.find((s) => s.assigneeId === ids.marcus)!.status).toBe('approved');
  });
});

describe('colour palette', () => {
  it('only the admin can change it; everyone, signed in or not, gets it', async () => {
    expect((await call('GET', '/api/auth/status')).body.theme).toBeNull();
    const put = (who: string, body: unknown) => call('PUT', '/api/settings/theme', { cookie: who, body });
    // writers and managers can't
    expect((await put(sarah.cookie, { preset: 'sunset' })).status).toBe(403);
    await manager.post('/api/users', { name: 'Pal Manager', email: 'pal@scale.test', role: 'manager', password: 'pal-manager-temp' });
    const pal = await login('pal@scale.test', 'pal-manager-temp');
    expect((await put(pal, { preset: 'sunset' })).status).toBe(403);
    // unknown presets and colours too dark for dark text are refused
    expect((await put(manager.cookie, { preset: 'neon' })).status).toBe(400);
    const dark = await put(manager.cookie, { preset: 'scale', colors: { brand: '#202020' } });
    expect(dark.status).toBe(400);
    expect(JSON.stringify(dark.body.error)).toMatch(/Too dark/);
    // a preset with a tweak keeps only what differs
    const ok = await put(manager.cookie, { preset: 'glacier', surfaces: 'cool', colors: { brand: '#ffc2a8', action: '#EFEA86' } });
    expect(ok.status).toBe(200);
    expect(ok.body.settings.theme).toEqual({ preset: 'glacier', colors: { brand: '#FFC2A8' } });
    expect((await sarah.get('/api/bootstrap')).body.settings.theme).toEqual({ preset: 'glacier', colors: { brand: '#FFC2A8' } });
    expect((await call('GET', '/api/auth/status')).body.theme.preset).toBe('glacier');
    expect((await manager.get('/api/master-log')).status).toBeLessThan(500);
    // back to the original
    expect((await put(manager.cookie, { preset: 'scale' })).body.settings.theme).toEqual({ preset: 'scale' });
  });
});

describe('to-dos', () => {
  it('a manager gives a writer a to-do; the writer sees it, ticks it off, and the manager is told', async () => {
    const b = await manager.post('/api/batches', { clientId: acmeId, title: 'Todo batch', targetCount: 2, finalDue: '2026-10-22', split: [{ writerId: ids.sarah, count: 2 }] });
    const add = await manager.post('/api/todos', { userId: ids.sarah, text: 'Rewrite the hook on script 2', due: '2026-10-05', batchId: b.body.batchId });
    expect(add.status).toBe(200);
    expect(add.body.todo).toMatchObject({ userId: ids.sarah, createdByName: 'Josh Rath', batchTitle: 'Todo batch', due: '2026-10-05', doneAt: null });
    const id = add.body.todo.id;
    // it's on her list and she's notified; Marcus doesn't see it
    const hers = (await sarah.get('/api/todos')).body.todos;
    expect(hers.map((t: any) => t.id)).toContain(id);
    expect(hers.find((t: any) => t.id === id).canEdit).toBe(false);
    expect((await sarah.get('/api/notifications')).body.notifications[0]).toMatchObject({ type: 'todo', title: 'New to-do from Josh Rath' });
    expect((await marcus.get('/api/todos')).body.todos.some((t: any) => t.id === id)).toBe(false);
    expect((await marcus.get(`/api/todos?userId=${ids.sarah}`)).body.todos.some((t: any) => t.id === id)).toBe(false);
    // managers see everyone's, and per batch
    expect((await manager.get('/api/todos?all=1')).body.todos.some((t: any) => t.id === id)).toBe(true);
    expect((await manager.get(`/api/todos?batchId=${b.body.batchId}`)).body.todos).toHaveLength(1);
    // writers can't give others to-dos, or change or remove one they were given
    expect((await sarah.post('/api/todos', { userId: ids.marcus, text: 'Do my work' })).status).toBe(403);
    expect((await sarah.patch(`/api/todos/${id}`, { text: 'Never mind' })).status).toBe(403);
    expect((await sarah.del(`/api/todos/${id}`)).status).toBe(403);
    expect((await marcus.patch(`/api/todos/${id}`, { done: true })).status).toBe(403);
    // she ticks it off and the manager hears about it
    const done = await sarah.patch(`/api/todos/${id}`, { done: true });
    expect(done.body.todo.doneAt).toBeTruthy();
    expect((await manager.get('/api/notifications')).body.notifications[0]).toMatchObject({ type: 'todo_done', title: 'To-do done · Sarah Chen' });
    // anyone can keep their own list
    const own = await marcus.post('/api/todos', { text: 'Read the brief' });
    expect(own.body.todo).toMatchObject({ userId: ids.marcus, canEdit: true });
    expect((await marcus.del(`/api/todos/${own.body.todo.id}`)).status).toBe(200);
    expect((await marcus.get('/api/todos')).body.todos.some((t: any) => t.id === own.body.todo.id)).toBe(false);
  });

  it('approved scripts can be sent back for revisions from the batch page', async () => {
    const b = await manager.post('/api/batches', { clientId: acmeId, title: 'Send back batch', targetCount: 3, finalDue: '2026-10-22', split: [{ writerId: ids.sarah, count: 3 }] });
    const s = (await manager.get(`/api/batches/${b.body.batchId}`)).body.scripts as { id: number }[];
    await sarah.post(`/api/batches/${b.body.batchId}/submissions`, { scriptIds: s.map((x) => x.id), url: 'https://docs.google.com/document/d/sb' });
    await manager.post(`/api/batches/${b.body.batchId}/review`, { action: 'approve', scriptIds: s.map((x) => x.id) });
    const r = await manager.post(`/api/batches/${b.body.batchId}/scripts/action`, { action: 'request_revisions', scriptIds: [s[0].id, s[1].id], note: 'Tighter openings please' });
    expect(r.status).toBe(200);
    expect(r.body.batch.scripts.map((x: any) => x.status)).toEqual(['revisions_needed', 'revisions_needed', 'approved']);
  });
});


describe('client resources picked for a batch', () => {
  it('picked on creation, shown to the writers on My work, and attachable or detachable later', async () => {
    const client = (await manager.get(`/api/clients/${acmeId}`)).body;
    const folder = client.resources.find((r: any) => r.title === 'Brand folder' && r.batchId == null);
    expect(folder).toBeTruthy();
    const extra = (await manager.post('/api/resources', { clientId: acmeId, category: 'example', title: 'Winning hooks', url: 'https://example.com/hooks' })).body;
    const extraId = extra.resource?.id ?? extra.id;
    expect(extraId).toBeTruthy();
    // another client's resources can't be picked
    const other = await manager.post('/api/clients', { name: 'Pick Test Other Co.', links: [{ title: 'Other folder', url: 'https://drive.example/o', category: 'folder' }] });
    const otherRes = (await manager.get(`/api/clients/${other.body.clientId}`)).body.resources[0];
    const bad = await manager.post('/api/batches', { clientId: acmeId, title: 'Bad pick', targetCount: 1, resourceIds: [otherRes.id], split: [{ writerId: ids.sarah, count: 1 }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields.resourceIds).toBeTruthy();
    // pick one when creating the batch
    const b = await manager.post('/api/batches', { clientId: acmeId, title: 'Picked resources', targetCount: 2, finalDue: '2026-10-22', resourceIds: [folder.id], split: [{ writerId: ids.sarah, count: 2 }] });
    expect(b.status).toBe(200);
    const id = b.body.batchId;
    let d = (await manager.get(`/api/batches/${id}`)).body;
    expect(d.resources.find((r: any) => r.id === folder.id)).toMatchObject({ attached: true });
    expect(d.resources.filter((r: any) => r.id === folder.id)).toHaveLength(1);
    expect(d.resources.find((r: any) => r.id === extraId).attached).toBeUndefined();
    // the writer gets it on My work; the unpicked one isn't there
    const mine = (await sarah.get('/api/my-work')).body.batches.find((e: any) => e.batch.id === id);
    expect(mine.resources.map((r: any) => r.id)).toEqual([folder.id]);
    // add the other one from the batch page, then take the first off
    expect((await manager.patch(`/api/batches/${id}`, { resourceIds: [folder.id, extraId] })).status).toBe(200);
    expect((await manager.patch(`/api/batches/${id}`, { resourceIds: [extraId] })).status).toBe(200);
    d = (await manager.get(`/api/batches/${id}`)).body;
    expect(d.resources.filter((r: any) => r.attached).map((r: any) => r.id)).toEqual([extraId]);
    expect(d.resources.some((r: any) => r.id === folder.id)).toBe(true); // still listed as a client resource
    expect(d.activity[0].summary).toMatch(/client resources 1 detached/);
    // writers can't change the picks
    expect((await sarah.patch(`/api/batches/${id}`, { resourceIds: [] })).status).toBe(403);
  });
});

describe('your own time zone', () => {
  it('starts unconfirmed, is set by the person, and shows in their bootstrap only', async () => {
    let boot = (await marcus.get('/api/bootstrap')).body;
    expect(boot.timezone.confirmed).toBe(false);
    expect((await marcus.post('/api/me/timezone', { timezone: 'Mars/Olympus' })).status).toBe(400);
    const r = await marcus.post('/api/me/timezone', { timezone: 'Asia/Kolkata' });
    expect(r.status).toBe(200);
    boot = (await marcus.get('/api/bootstrap')).body;
    expect(boot.timezone).toEqual({ mine: 'Asia/Kolkata', confirmed: true });
    // the workspace's time zone (deadlines) is unchanged, and nobody else's moves
    expect(boot.settings.timezone).not.toBe('Asia/Kolkata');
    expect((await sarah.get('/api/bootstrap')).body.timezone.mine).not.toBe('Asia/Kolkata');
    // it's what the team sees for them too
    expect((await manager.get('/api/users')).body.users.find((u: any) => u.id === ids.marcus).timezone).toBe('Asia/Kolkata');
  });
});

describe('final delivery sets drafts due', () => {
  it('a batch given only a final date gets drafts by the rules’ gap', async () => {
    const s = (await manager.get('/api/settings')).body.settings;
    const r = await manager.post('/api/batches', { clientId: acmeId, title: 'Final only', targetCount: 1, finalDue: '2026-11-20', split: [] });
    expect(r.status).toBe(200);
    const d = (await manager.get(`/api/batches/${r.body.batchId}`)).body;
    const { draftFromFinal } = await import('../shared/dates');
    expect(d.finalDue).toBe('2026-11-20');
    expect(d.draftDue).toBe(draftFromFinal('2026-11-20', s).date);
    // a drafts date you give is kept as it is
    const own = await manager.post('/api/batches', { clientId: acmeId, title: 'Both dates', targetCount: 1, draftDue: '2026-11-10', finalDue: '2026-11-20', split: [] });
    expect((await manager.get(`/api/batches/${own.body.batchId}`)).body.draftDue).toBe('2026-11-10');
  });
});

describe('filling in missing deadlines on existing batches', () => {
  it('gives each batch the date it was missing, by the shoot or by the rules’ gap', async () => {
    const { fillMissingDeadlines } = await import('../server/backfill');
    const { draftFromFinal, finalFromDraft } = await import('../shared/dates');
    const s = (await manager.get('/api/settings')).body.settings;
    const mk = async (title: string, extra: Record<string, unknown> = {}) => (await manager.post('/api/batches', { clientId: acmeId, title, targetCount: 1, finalDue: '2026-12-10', split: [], ...extra })).body.batchId as number;
    const onlyFinal = await mk('Backfill only final');
    const onlyDraft = await mk('Backfill only draft');
    const both = await mk('Backfill both', { draftDue: '2026-12-01' });
    // the old state: one of the two missing
    await db.query(`update batches set draft_due = null where id = $1`, [onlyFinal]);
    await db.query(`update batches set final_due = null, draft_due = '2026-12-03' where id = $1`, [onlyDraft]);
    await db.tx((t) => fillMissingDeadlines(t));
    const get = async (id: number) => (await manager.get(`/api/batches/${id}`)).body;
    const a = await get(onlyFinal);
    expect(a.draftDue).toBe(draftFromFinal('2026-12-10', s).date);
    expect(a.activity[0].summary).toMatch(/Drafts due set to .* it was missing/);
    const b = await get(onlyDraft);
    expect(b.finalDue).toBe(finalFromDraft('2026-12-03', s).date);
    expect(b.activity[0].summary).toMatch(/Final delivery set to/);
    const c = await get(both);
    expect([c.draftDue, c.finalDue]).toEqual(['2026-12-01', '2026-12-10']);
    // a batch on a shoot gets the shoot's rule
    const sh = await manager.post('/api/shoots', { clientId: acmeId, startDate: '2026-12-20', batch: { targetCount: 1, split: [] } });
    await db.query(`update batches set final_due = null where id = $1`, [sh.body.batchId]);
    await db.tx((t) => fillMissingDeadlines(t));
    const d = await get(sh.body.batchId);
    expect(d.finalDueMode).toBe('auto');
    expect(d.finalDue).toBe((await import('../shared/dates')).computeDeadlines('2026-12-20', s).finalDue);
    // running again changes nothing
    const before = (await db.query(`select count(*)::int as n from activity where action = 'batch.deadlines_filled'`))[0];
    await db.tx((t) => fillMissingDeadlines(t));
    expect((await db.query(`select count(*)::int as n from activity where action = 'batch.deadlines_filled'`))[0]).toEqual(before);
  });
});

describe('synced Google Calendars', () => {
  const ICS = (summary: string) => ['BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT', 'UID:shoot@g', 'DTSTART;VALUE=DATE:20261015', 'DTEND;VALUE=DATE:20261017', `SUMMARY:${summary}`, 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:call@g', 'DTSTART;TZID=America/New_York:20261014T100000', 'DTEND;TZID=America/New_York:20261014T103000', 'SUMMARY:Ideation call', 'LOCATION:https://meet.google.com/x', 'END:VEVENT',
    'END:VCALENDAR'].join('\r\n');
  const URL_OK = 'https://calendar.google.com/calendar/ical/joshua%40example.com/private-abc123/basic.ics';
  let feedText = ICS('Shoot – Dentist Mike');

  it('adds a calendar by its secret address, shows its events, and keeps them in sync', async () => {
    ctx.fetchCalendar = async (u) => { if (u !== URL_OK) throw new Error('Google refused the link.'); return feedText; };
    // the page link and private addresses are refused; writers can't add one
    expect((await manager.post('/api/calendar-feeds', { name: 'Joshua', url: 'https://calendar.google.com/calendar/r' })).body.error.fields.url).toMatch(/Secret address/);
    expect((await manager.post('/api/calendar-feeds', { name: 'Joshua', url: 'http://127.0.0.1/x.ics' })).status).toBe(400);
    // an embed code (or link, or the address) reads the calendar's public iCal address; a private calendar says what to do
    const asked: string[] = [];
    ctx.fetchCalendar = async (u) => { asked.push(u); if (u === URL_OK) return feedText; throw new Error('That calendar isn’t public, so Google won’t share it this way.'); };
    const embed = await manager.post('/api/calendar-feeds', { name: 'Joshua', url: '<iframe src="https://calendar.google.com/calendar/embed?src=jshalamov4%40gmail.com&amp;ctz=America%2FToronto" style="border: 0"></iframe>' });
    expect(asked).toEqual(['https://calendar.google.com/calendar/ical/jshalamov4%40gmail.com/public/basic.ics']);
    expect(embed.status).toBe(400);
    expect(embed.body.error.fields.url).toMatch(/isn’t public/);
    expect((await sarah.post('/api/calendar-feeds', { name: 'Joshua', url: URL_OK })).status).toBe(403);
    const add = await manager.post('/api/calendar-feeds', { name: 'Joshua’s calendar', url: URL_OK.replace('https://', 'webcal://'), color: '#60D1BE' });
    expect(add.status).toBe(200);
    expect(add.body.result).toMatchObject({ ok: true, count: 2 });
    expect(add.body.feed.urlHint).toBe('calendar.google.com · joshua@example.com');
    expect(JSON.stringify(add.body)).not.toContain('private-abc123'); // the secret isn't sent back
    const id = add.body.feed.id;
    // managers see the events on the Calendar
    let cal = (await manager.get('/api/calendar?from=2026-10-01&to=2026-10-31')).body.events.filter((e: any) => e.type === 'external');
    expect(cal.map((e: any) => [e.title, e.start, e.end])).toEqual([['Ideation call', '2026-10-14', '2026-10-14'], ['Shoot – Dentist Mike', '2026-10-15', '2026-10-16']]);
    expect(cal[0].external).toMatchObject({ feedName: 'Joshua’s calendar', color: '#60D1BE', allDay: false, startAt: '2026-10-14T14:00:00.000Z', location: 'https://meet.google.com/x' });
    // writers don't, until it's shared with everyone
    expect((await sarah.get('/api/calendar?from=2026-10-01&to=2026-10-31')).body.events.some((e: any) => e.type === 'external')).toBe(false);
    await manager.patch(`/api/calendar-feeds/${id}`, { visibility: 'everyone' });
    expect((await sarah.get('/api/calendar?from=2026-10-01&to=2026-10-31')).body.events.filter((e: any) => e.type === 'external')).toHaveLength(2);
    // a change in Google shows up on the next sync
    feedText = ICS('Shoot – Dentist Mike (moved to studio B)');
    expect((await manager.post(`/api/calendar-feeds/${id}/sync`)).body.result).toMatchObject({ ok: true, count: 2 });
    cal = (await manager.get('/api/calendar?from=2026-10-01&to=2026-10-31')).body.events.filter((e: any) => e.type === 'external');
    expect(cal.map((e: any) => e.title)).toContain('Shoot – Dentist Mike (moved to studio B)');
    // a failed sync keeps the last events and says why
    ctx.fetchCalendar = async () => { throw new Error('Google refused the link. It may have been reset: copy the secret address again.'); };
    const bad = (await manager.post(`/api/calendar-feeds/${id}/sync`)).body;
    expect(bad.result.ok).toBe(false);
    expect(bad.feed.lastError).toMatch(/reset/);
    expect((await manager.get('/api/calendar?from=2026-10-01&to=2026-10-31')).body.events.filter((e: any) => e.type === 'external')).toHaveLength(2);
    // removing it removes its events
    expect((await manager.del(`/api/calendar-feeds/${id}`)).status).toBe(200);
    expect((await manager.get('/api/calendar?from=2026-10-01&to=2026-10-31')).body.events.some((e: any) => e.type === 'external')).toBe(false);
    expect((await db.query(`select count(*)::int as n from calendar_events`))[0]).toEqual({ n: 0 });
  });
});

describe('shoots on a synced calendar that need writers', () => {
  it('finds them, prompts managers once, and drops each one as it gets planned', async () => {
    const ICS = ['BEGIN:VCALENDAR', 'VERSION:2.0',
      'BEGIN:VEVENT', 'UID:a@g', 'DTSTART;VALUE=DATE:20270112', 'DTEND;VALUE=DATE:20270114', 'SUMMARY:Shoot – Acme Outdoor', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:b@g', 'DTSTART;VALUE=DATE:20270118', 'DTEND;VALUE=DATE:20270119', 'SUMMARY:Shoot – mystery brand', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:c@g', 'DTSTART:20270113T170000Z', 'DTEND:20270113T180000Z', 'SUMMARY:Lunch with Mike', 'END:VEVENT',
      'END:VCALENDAR'].join('\r\n');
    ctx.fetchCalendar = async () => ICS;
    const before = (await manager.get('/api/notifications')).body.notifications.length;
    const add = await manager.post('/api/calendar-feeds', { name: 'Joshua’s calendar', url: 'https://calendar.google.com/calendar/ical/j%40example.com/private-x/basic.ics' });
    expect(add.status).toBe(200);
    let list = (await manager.get('/api/calendar-shoots')).body.shoots;
    expect(list.map((s: any) => [s.title, s.client?.name ?? null, s.status, s.start, s.end])).toEqual([
      ['Shoot – Acme Outdoor', 'Acme Outdoor Co.', 'no_shoot', '2027-01-12', '2027-01-13'],
      ['Shoot – mystery brand', null, 'no_shoot', '2027-01-18', '2027-01-18'],
    ]);
    expect(list[0].suggested.count).toBeGreaterThan(0); // last time's numbers to start from
    // managers were told once
    const notes = (await manager.get('/api/notifications')).body.notifications;
    expect(notes.length).toBe(before + 1);
    expect(notes[0]).toMatchObject({ type: 'planning', title: '2 shoots on Joshua’s calendar need writers' });
    expect((await sarah.get('/api/calendar-shoots')).status).toBe(403);
    // the shoot is booked on the site, scripts not planned yet
    const sh = await manager.post('/api/shoots', { clientId: acmeId, startDate: '2027-01-12', endDate: '2027-01-13' });
    list = (await manager.get('/api/calendar-shoots')).body.shoots;
    expect(list[0]).toMatchObject({ status: 'no_scripts', shootId: sh.body.shootId });
    // scripts planned but nobody writing them
    const b = await manager.post('/api/batches', { clientId: acmeId, shootId: sh.body.shootId, title: 'Dec shoot', targetCount: 4, split: [{ writerId: ids.sarah, count: 1 }] });
    list = (await manager.get('/api/calendar-shoots')).body.shoots;
    expect(list[0]).toMatchObject({ status: 'unassigned', unassigned: 3, total: 4, batchId: b.body.batchId });
    // all assigned: it's done
    const scripts = (await manager.get(`/api/batches/${b.body.batchId}`)).body.scripts.filter((s: any) => !s.assigneeId).map((s: any) => s.id);
    await manager.post(`/api/batches/${b.body.batchId}/scripts/assign`, { scriptIds: scripts, assigneeId: ids.marcus });
    list = (await manager.get('/api/calendar-shoots')).body.shoots;
    expect(list.map((s: any) => s.title)).toEqual(['Shoot – mystery brand']);
    // not ours: hide it
    await manager.post('/api/calendar-shoots/dismiss', { uid: list[0].uid });
    expect((await manager.get('/api/calendar-shoots')).body.shoots).toEqual([]);
    // syncing again doesn't notify again
    await manager.post(`/api/calendar-feeds/${add.body.feed.id}/sync`);
    expect((await manager.get('/api/notifications')).body.notifications.length).toBe(before + 1);
    await manager.del(`/api/calendar-feeds/${add.body.feed.id}`);
  });

  it('counts a batch planned without a shoot, and looks past the calendar owner’s name', async () => {
    const owner = await manager.post('/api/clients', { name: 'Joshua Shalamov' });
    const lawId = (await db.query<{ id: number }>(`select id from clients where name = 'Shimonov Law'`))[0].id; // from the notes import above
    ctx.fetchCalendar = async () => ['BEGIN:VCALENDAR', 'VERSION:2.0',
      'BEGIN:VEVENT', 'UID:law@g', 'DTSTART;VALUE=DATE:20270208', 'DTEND;VALUE=DATE:20270209', 'SUMMARY:Shimonov Law Filming Session and Joshua Shalamov', 'END:VEVENT',
      'END:VCALENDAR'].join('\r\n');
    const add = await manager.post('/api/calendar-feeds', { name: 'Joshua Shalamov’s Calendar', url: 'https://calendar.google.com/calendar/ical/j%40example.com/private-y/basic.ics' });
    let list = (await manager.get('/api/calendar-shoots')).body.shoots;
    expect(list.map((s: any) => [s.client?.name, s.status])).toEqual([['Shimonov Law', 'no_shoot']]);
    // scripts planned as a batch on its own, due before the filming, everyone writing: nothing to do
    const b = await manager.post('/api/batches', { clientId: lawId, title: 'February filming', targetCount: 3, finalDue: '2027-02-04', split: [{ writerId: ids.sarah, count: 3 }] });
    expect(b.status).toBe(200);
    list = (await manager.get('/api/calendar-shoots')).body.shoots;
    expect(list).toEqual([]);
    await manager.del(`/api/calendar-feeds/${add.body.feed.id}`);
    expect(owner.status).toBe(200);
  });
});

describe('editors', () => {
  const pdf = async (cookie: string, url: string, fields: Record<string, string>) => {
    const boundary = '----smed' + Math.random().toString(16).slice(2);
    const parts = Object.entries(fields).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}`);
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="scripts.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4 draft`);
    const r = await app.inject({ method: 'POST', url, headers: { 'x-scale-media': '1', cookie, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: parts.join('\r\n') + `\r\n--${boundary}--\r\n` });
    return JSON.parse(r.body);
  };

  it('sign in to a read-only view: calendar, finished scripts, clients, resources and to-dos', async () => {
    const add = await manager.post('/api/users', { name: 'Eddie Cut', email: 'eddie@scale.test', role: 'editor', password: 'editor-password-1' });
    expect([add.status, add.body?.error]).toEqual([200, undefined]);
    const eddieId = add.body.users.find((u: any) => u.name === 'Eddie Cut').id;
    const eddie = as(await login('eddie@scale.test', 'editor-password-1'));
    expect((await eddie.get('/api/bootstrap')).body.me.role).toBe('editor');

    // a batch with one finished document and one still in review
    const b = await manager.post('/api/batches', { clientId: acmeId, title: 'Editor batch', targetCount: 4, finalDue: '2026-11-25', split: [{ writerId: ids.sarah, count: 4 }] });
    const s = (await manager.get(`/api/batches/${b.body.batchId}`)).body.scripts as { id: number }[];
    const done = await pdf(sarah.cookie, `/api/batches/${b.body.batchId}/submissions`, { scriptIds: JSON.stringify([s[0].id, s[1].id]) });
    await pdf(sarah.cookie, `/api/batches/${b.body.batchId}/submissions`, { scriptIds: JSON.stringify([s[2].id, s[3].id]) });
    await manager.post(`/api/batches/${b.body.batchId}/review`, { action: 'approve', scriptIds: [s[0].id, s[1].id] });
    const subs = (await manager.get(`/api/batches/${b.body.batchId}`)).body.submissions as any[];
    const draftFile = subs.find((x) => x.scriptNumbers.includes(3))?.fileId;
    const doneFile = subs.find((x) => x.scriptNumbers.includes(1))?.fileId;
    expect(done).toBeTruthy();

    // Script bank: only the finished document
    const bank = (await eddie.get(`/api/script-bank?clientId=${acmeId}&q=Editor%20batch`)).body.deliverables;
    expect(bank).toHaveLength(1);
    expect(bank[0].state).toBe('approved');
    expect((await manager.get(`/api/script-bank?clientId=${acmeId}&q=Editor%20batch`)).body.deliverables).toHaveLength(2);
    // and only that document's file opens
    expect(doneFile && draftFile).toBeTruthy();
    expect((await app.inject({ method: 'GET', url: `/api/files/${doneFile}`, headers: { cookie: eddie.cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/files/${draftFile}`, headers: { cookie: eddie.cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/files/${draftFile}`, headers: { cookie: manager.cookie } })).statusCode).toBe(200);

    // Calendar: shoots and final delivery, not the writing in between
    const cal = (await eddie.get('/api/calendar?from=2026-11-01&to=2026-11-30')).body.events as any[];
    expect(cal.some((e) => e.type === 'final' && e.batchId === b.body.batchId)).toBe(true);
    expect(cal.every((e) => ['shoot', 'final', 'external'].includes(e.type))).toBe(true);
    // Clients: the brand material, not the team's history
    const client = (await eddie.get(`/api/clients/${acmeId}`)).body;
    expect(client.brandVoice).toBeTruthy();
    expect(client.activity).toEqual([]);
    expect(client.batches).toEqual([]);
    expect((await eddie.get('/api/resources')).status).toBe(200);
    // their own to-dos work
    expect((await manager.post('/api/todos', { userId: eddieId, text: 'Cut the Acme reels by Friday' })).status).toBe(200);
    expect((await eddie.get('/api/todos')).body.todos.map((t: any) => t.text)).toContain('Cut the Acme reels by Friday');

    // everything else is closed, whatever the address
    for (const [method, url] of [['GET', '/api/dashboard'], ['GET', '/api/batches'], ['GET', `/api/batches/${b.body.batchId}`], ['GET', '/api/review'], ['GET', '/api/my-work'],
      ['GET', '/api/settings'], ['GET', '/api/users'], ['GET', '/api/calendar-shoots'], ['POST', '/api/resources'],
      ['POST', `/api/batches/${b.body.batchId}/scripts/action`], ['PATCH', `/api/clients/${acmeId}`], ['POST', '/api/clients']] as const) {
      const r = await call(method, url, { cookie: eddie.cookie, body: method === 'GET' ? undefined : {} });
      expect([method, url, r.status]).toEqual([method, url, 403]);
    }
  });

  it('are never given scripts, and see a synced calendar only when it’s shared with editors', async () => {
    const eddieId = (await manager.get('/api/users')).body.users.find((u: any) => u.name === 'Eddie Cut').id;
    const bad = await manager.post('/api/batches', { clientId: acmeId, title: 'No editors', targetCount: 2, split: [{ writerId: eddieId, count: 2 }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/editor/);
    const b = await manager.post('/api/batches', { clientId: acmeId, title: 'Assign test', targetCount: 1, split: [] });
    const sid = (await manager.get(`/api/batches/${b.body.batchId}`)).body.scripts[0].id;
    expect((await manager.post(`/api/batches/${b.body.batchId}/scripts/assign`, { scriptIds: [sid], assigneeId: eddieId })).status).toBe(400);
    // a writer with unfinished scripts can't become an editor until they're moved
    await manager.post(`/api/batches/${b.body.batchId}/scripts/assign`, { scriptIds: [sid], assigneeId: ids.marcus });
    expect((await manager.patch(`/api/users/${ids.marcus}`, { role: 'editor' })).status).toBe(400);

    const eddie = as(await login('eddie@scale.test', 'editor-password-1'));
    ctx.fetchCalendar = async () => ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:ed@g', 'DTSTART;VALUE=DATE:20261118', 'DTEND;VALUE=DATE:20261119', 'SUMMARY:Shoot – Acme Outdoor', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const feed = (await manager.post('/api/calendar-feeds', { name: 'Joshua', url: 'https://calendar.google.com/calendar/ical/j%40example.com/private-ed/basic.ics' })).body.feed;
    const has = async (who: typeof eddie) => (await who.get('/api/calendar?from=2026-11-01&to=2026-11-30')).body.events.some((e: any) => e.type === 'external');
    expect(await has(eddie)).toBe(false);
    await manager.patch(`/api/calendar-feeds/${feed.id}`, { visibility: 'editors' });
    expect(await has(eddie)).toBe(true);
    expect(await has(sarah)).toBe(false);
    await manager.del(`/api/calendar-feeds/${feed.id}`);
  });
});

describe('new work on My work', () => {
  it('marks work given to a writer this week as new until they start it, and counts it for the menu', async () => {
    const before = (await sarah.get('/api/counts')).body.myNewWork;
    const b = await manager.post('/api/batches', { clientId: acmeId, title: 'Fresh batch', targetCount: 4, finalDue: '2027-03-05', split: [{ writerId: ids.sarah, count: 4 }] });
    expect(b.status).toBe(200);
    const id = b.body.batchId;
    expect((await sarah.get('/api/counts')).body.myNewWork).toBe(before + 1);
    const entry = (await sarah.get('/api/my-work')).body.batches.find((e: any) => e.batch.id === id);
    expect(entry.mine).toHaveLength(4);
    expect(entry.mine.every((s: any) => typeof s.assignedAt === 'string')).toBe(true);
    // once they put a number on the counter it isn't new any more
    expect((await sarah.post(`/api/batches/${id}/written`, { written: 1 })).status).toBe(200);
    expect((await sarah.get('/api/counts')).body.myNewWork).toBe(before);
    // scripts handed to someone else are new for them, with a fresh assignment time
    const scripts = (await manager.get(`/api/batches/${id}`)).body.scripts;
    const first = scripts.find((s: any) => s.number === 4);
    const was = first.assignedAt;
    const mBefore = (await marcus.get('/api/counts')).body.myNewWork;
    await new Promise((r) => setTimeout(r, 15));
    expect((await manager.post(`/api/batches/${id}/scripts/assign`, { scriptIds: [first.id], assigneeId: ids.marcus })).status).toBe(200);
    const moved = (await manager.get(`/api/batches/${id}`)).body.scripts.find((s: any) => s.id === first.id);
    expect(moved.assigneeId).toBe(ids.marcus);
    expect(Date.parse(moved.assignedAt)).toBeGreaterThan(Date.parse(was));
    expect((await marcus.get('/api/counts')).body.myNewWork).toBe(mBefore + 1);
    // unassigned scripts have no assignment time
    await manager.post(`/api/batches/${id}/scripts/assign`, { scriptIds: [first.id], assigneeId: null });
    expect((await manager.get(`/api/batches/${id}`)).body.scripts.find((s: any) => s.id === first.id).assignedAt).toBeNull();
  });
});

describe('round 1 safety checks', () => {
  it('refuses a decision on a version that has been replaced, and can undo a decision', async () => {
    const b = await manager.post('/api/batches', { clientId: acmeId, title: 'Stale and undo', targetCount: 2, split: [{ writerId: ids.sarah, count: 2 }] });
    const id = b.body.batchId;
    const sc = (await manager.get(`/api/batches/${id}`)).body.scripts.map((s: any) => s.id);
    const v1 = await sarah.post(`/api/batches/${id}/submissions`, { scriptIds: sc, url: 'https://docs.google.com/document/d/stale-v1' });
    const v2 = await sarah.post(`/api/batches/${id}/submissions`, { scriptIds: sc, url: 'https://docs.google.com/document/d/stale-v2' });
    expect(v2.status).toBe(200);
    const stale = await manager.post(`/api/batches/${id}/review`, { action: 'approve', scriptIds: sc, submissionId: v1.body.submissionId });
    expect(stale.status).toBe(409);
    expect(stale.body.error.message).toMatch(/newer version \(version 2\)/);
    const ok = await manager.post(`/api/batches/${id}/review`, { action: 'approve', scriptIds: sc, submissionId: v2.body.submissionId });
    expect(ok.status).toBe(200);
    expect(ok.body.reviewId).toBeTruthy();
    const before = (await sarah.get('/api/notifications')).body.notifications.filter((n: any) => n.type === 'approval').length;
    const undo = await manager.post(`/api/reviews/${ok.body.reviewId}/undo`, {});
    expect(undo.status).toBe(200);
    expect(undo.body.batch.scripts.every((s: any) => s.status === 'ready_for_review')).toBe(true);
    // the approval notice the writer hadn't read is gone, and it can't be undone twice
    expect((await sarah.get('/api/notifications')).body.notifications.filter((n: any) => n.type === 'approval').length).toBe(before - 1);
    expect((await manager.post(`/api/reviews/${ok.body.reviewId}/undo`, {})).status).toBe(404);
    expect((await sarah.post(`/api/reviews/1/undo`, {})).status).toBe(403);
    // a send-back undone takes its revision requests with it
    const back = await manager.post(`/api/batches/${id}/review`, { action: 'revisions', scriptIds: [sc[0]], submissionId: v2.body.submissionId, note: 'Shorter' });
    await manager.post(`/api/reviews/${back.body.reviewId}/undo`, {});
    const after = (await manager.get(`/api/batches/${id}`)).body.scripts;
    expect(after.find((s: any) => s.id === sc[0])).toMatchObject({ status: 'ready_for_review', openRevision: null });
  });

  it('says when a chosen writer has no scripts instead of dropping them', async () => {
    const r = await manager.post('/api/batches', { clientId: acmeId, title: 'Zero writer', targetCount: 4, split: [{ writerId: ids.sarah, count: 4 }, { writerId: ids.marcus, count: 0 }] });
    expect(r.status).toBe(400);
    expect(r.body.error.fields.split).toBe('Marcus Webb has no scripts. Give them some, split evenly, or remove them.');
  });

  it('won’t confirm deadlines that put drafts after final delivery, and previews rule changes before saving', async () => {
    const b = await manager.post('/api/batches', { clientId: acmeId, title: 'Out of order', targetCount: 1, draftDue: '2027-04-10', finalDue: '2027-04-12' });
    await db.query(`update batches set draft_due = '2027-04-14', needs_date_review = true where id = $1`, [b.body.batchId]);
    const r = await manager.post(`/api/batches/${b.body.batchId}/dates-reviewed`, {});
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/Drafts are due after final delivery/);
    const bad = await manager.patch('/api/settings', { draftOffsetDays: 3, finalOffsetDays: 5 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields.finalOffsetDays).toMatch(/Use 3 or fewer/);
    const p = await manager.post('/api/settings/recalculate-preview', { draftOffsetDays: 9, finalOffsetDays: 4 });
    expect(p.status).toBe(200);
    expect(typeof p.body.batches).toBe('number');
    expect((await sarah.post('/api/settings/recalculate-preview', {})).status).toBe(403);
  });

  it('remembers which calendar event a shoot was planned from, can create the client with it, and keeps hidden ones', async () => {
    ctx.fetchCalendar = async () => ['BEGIN:VCALENDAR', 'VERSION:2.0',
      'BEGIN:VEVENT', 'UID:planned@g', 'DTSTART;VALUE=DATE:20270310', 'DTEND;VALUE=DATE:20270311', 'SUMMARY:Shoot – Fresh Faces Studio', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:other@g', 'DTSTART;VALUE=DATE:20270320', 'DTEND;VALUE=DATE:20270321', 'SUMMARY:Shoot – Not Ours', 'END:VEVENT',
      'END:VCALENDAR'].join('\r\n');
    const feed = await manager.post('/api/calendar-feeds', { name: 'Planning calendar', url: 'https://calendar.google.com/calendar/ical/p%40example.com/private-z/basic.ics' });
    expect(feed.status).toBe(200);
    let res = (await manager.get('/api/calendar-shoots')).body;
    const fresh = res.shoots.find((s: any) => s.uid.startsWith('planned@g'));
    const other = res.shoots.find((s: any) => s.uid.startsWith('other@g')).uid;
    expect(fresh).toMatchObject({ status: 'no_shoot', client: null });
    // planned under a brand-new client straight from the event
    const made = await manager.post('/api/shoots', { newClientName: 'Bright Smiles Dental', calendarUid: fresh.uid, startDate: '2027-03-10', endDate: null, batch: { targetCount: 3, split: [{ writerId: ids.sarah, count: 3 }] } });
    expect(made.status).toBe(200);
    expect((await manager.get(`/api/clients/${made.body.clientId}`)).body.name).toBe('Bright Smiles Dental');
    expect(made.body.batch.title).toBe('Bright Smiles Dental · Mar 10, 2027');
    res = (await manager.get('/api/calendar-shoots')).body;
    expect(res.shoots.some((s: any) => s.uid === fresh.uid)).toBe(false); // planned, even though the title names no client
    // hiding one keeps it in the hidden list, and it can come back
    await manager.post('/api/calendar-shoots/dismiss', { uid: other });
    res = (await manager.get('/api/calendar-shoots')).body;
    expect(res.shoots.some((s: any) => s.uid === other)).toBe(false);
    expect(res.hidden.map((s: any) => s.uid)).toContain(other);
    await manager.post('/api/calendar-shoots/dismiss', { uid: other, undo: true });
    expect((await manager.get('/api/calendar-shoots')).body.shoots.some((s: any) => s.uid === other)).toBe(true);
    await manager.del(`/api/calendar-feeds/${feed.body.feed.id}`);
  });
});

describe('round 2: writers never miss work', () => {
  it('remembers when a writer has seen new work, and shows scripts added after that as new', async () => {
    const b = await manager.post('/api/batches', { clientId: acmeId, title: 'Seen work', targetCount: 2, draftDue: '2026-10-20', finalDue: '2026-10-22', split: [{ writerId: ids.sarah, count: 2 }] });
    const id = b.body.batchId;
    const before = (await sarah.get('/api/bootstrap')).body.counts.myNewWork;
    let mine = (await sarah.get('/api/my-work')).body.batches.find((e: any) => e.batch.id === id);
    expect(mine.seenAt).toBeNull();
    expect(mine.myNext).toMatchObject({ kind: 'draft', date: '2026-10-20', remaining: 2 });
    const seen = await sarah.post(`/api/batches/${id}/seen`, {});
    expect(seen.body).toMatchObject({ ok: true, seen: true });
    expect((await sarah.get('/api/bootstrap')).body.counts.myNewWork).toBe(before - 1);
    mine = (await sarah.get('/api/my-work')).body.batches.find((e: any) => e.batch.id === id);
    expect(mine.seenAt).toBeTruthy();
    // someone not on the batch can't mark it
    expect((await marcus.post(`/api/batches/${id}/seen`, {})).body.seen).toBe(false);
  });

  it('measures deadlines on the writer’s own scripts and puts sent-back work first', async () => {
    const b = await manager.post('/api/batches', { clientId: acmeId, title: 'Own deadlines', targetCount: 2, draftDue: '2026-10-25', finalDue: '2026-10-28', split: [{ writerId: ids.sarah, count: 1 }, { writerId: ids.marcus, count: 1 }] });
    const id = b.body.batchId;
    const sc = (await manager.get(`/api/batches/${id}`)).body.scripts;
    const hers = sc.find((s: any) => s.assigneeId === ids.sarah).id;
    const sent = await sarah.post(`/api/batches/${id}/submissions`, { scriptIds: [hers], url: 'https://docs.google.com/document/d/own-v1' });
    let e = (await sarah.get('/api/my-work')).body.batches.find((x: any) => x.batch.id === id);
    // her drafts are done even though Marcus hasn't sent his
    expect(e.myDraft.complete).toBe(true);
    expect(e.batch.draft.complete).toBe(false);
    expect(e.myNext.kind).toBe('final');
    await manager.post(`/api/batches/${id}/review`, { action: 'revisions', scriptIds: [hers], submissionId: sent.body.submissionId, note: 'Punchier hook' });
    const list = (await sarah.get('/api/my-work')).body.batches;
    expect(list[0].myProgress.revisions).toBeGreaterThan(0);
    // the revised version says which feedback it answers
    const v2 = await sarah.post(`/api/batches/${id}/submissions`, { scriptIds: [hers], url: 'https://docs.google.com/document/d/own-v2' });
    expect(v2.status).toBe(200);
    const detail = (await manager.get(`/api/batches/${id}`)).body;
    const doc = detail.submissions.find((s: any) => s.id === v2.body.submissionId);
    expect(doc.afterFeedback).toMatchObject({ note: 'Punchier hook' });
    expect(detail.submissions.find((s: any) => s.id === sent.body.submissionId).afterFeedback).toBeNull();
    // a sent-back script still counts as written
    expect(detail.writers.find((w: any) => w.userId === ids.sarah).written).toBe(1);
  });

  it('lets a writer undo their own delivery the same day, and tells managers', async () => {
    const b = await manager.post('/api/batches', { clientId: acmeId, title: 'Undo my delivery', targetCount: 1, split: [{ writerId: ids.sarah, count: 1 }] });
    const id = b.body.batchId;
    const s = (await manager.get(`/api/batches/${id}`)).body.scripts[0].id;
    await sarah.post(`/api/batches/${id}/scripts/action`, { action: 'submit', scriptIds: [s] });
    await manager.post(`/api/batches/${id}/scripts/action`, { action: 'approve', scriptIds: [s] });
    await sarah.post(`/api/batches/${id}/scripts/action`, { action: 'deliver', scriptIds: [s] });
    // someone else's delivery isn't theirs to undo
    expect((await marcus.post(`/api/batches/${id}/scripts/action`, { action: 'undo_delivery', scriptIds: [s] })).status).toBe(403);
    const undo = await sarah.post(`/api/batches/${id}/scripts/action`, { action: 'undo_delivery', scriptIds: [s], note: 'Not in Timeliner yet' });
    expect(undo.status).toBe(200);
    expect((await manager.get(`/api/batches/${id}`)).body.scripts[0].status).toBe('approved');
    const n = (await manager.get('/api/notifications')).body.notifications.find((x: any) => x.title.startsWith('Delivery undone'));
    expect(n.body).toMatch(/took back their delivery/);
    // an older delivery needs a manager
    await sarah.post(`/api/batches/${id}/scripts/action`, { action: 'deliver', scriptIds: [s] });
    await db.query(`update scripts set delivered_at = delivered_at - interval '3 days' where id = $1`, [s]);
    const late = await sarah.post(`/api/batches/${id}/scripts/action`, { action: 'undo_delivery', scriptIds: [s] });
    expect(late.status).toBe(403);
    expect(late.body.error.message).toMatch(/Only a manager can undo/);
  });

  it('counts dated to-dos in the Today pill, overdue ones included', async () => {
    const before = (await sarah.get('/api/today')).body;
    const t = await manager.post('/api/todos', { userId: ids.sarah, text: 'Send the hook ideas', due: '2026-01-05' });
    expect(t.status).toBe(200);
    const after = (await sarah.get('/api/today')).body;
    expect(after.total).toBe(before.total + 1);
    expect(after.items.find((i: any) => i.kind === 'todo' && i.text === 'Send the hook ideas')).toMatchObject({ overdue: true, done: 0 });
  });

  it('keeps notes about potential clients and the client history for managers', async () => {
    const p = await manager.post('/api/clients', { name: 'Quiet Prospect Co', prospect: true, description: 'Budget is tight, push the bundle' });
    const pid = p.body.clientId ?? p.body.client?.id ?? p.body.id;
    const asWriter = (await sarah.get('/api/clients?status=all')).body.clients.find((c: any) => c.name === 'Quiet Prospect Co');
    expect(asWriter.description).toBeNull();
    expect((await manager.get('/api/clients?status=all')).body.clients.find((c: any) => c.name === 'Quiet Prospect Co').description).toMatch(/bundle/);
    const one = (await sarah.get(`/api/clients/${pid}`)).body;
    expect(one.description).toBeNull();
    expect((await sarah.get(`/api/clients/${acmeId}`)).body.activity).toEqual([]);
    expect((await manager.get(`/api/clients/${acmeId}`)).body.activity.length).toBeGreaterThan(0);
  });
});

describe('round 3: manager and editor screens', () => {
  it('tells editors whether each shoot’s scripts are ready, and when they’re final', async () => {
    await manager.post('/api/users', { name: 'Readiness Editor', email: 'ready-ed@scale.test', role: 'editor', password: 'ready-editor-pass' });
    const ed = as(await login('ready-ed@scale.test', 'ready-editor-pass'));
    const today = (await manager.get('/api/bootstrap')).body.clock.today as string;
    const start = new Date(Date.parse(today) + 20 * 86400_000).toISOString().slice(0, 10);
    const r = await manager.post('/api/shoots', { clientId: acmeId, startDate: start, batch: { targetCount: 2, split: [{ writerId: ids.sarah, count: 2 }] } });
    expect(r.status).toBe(200);
    const shootId = r.body.shootId ?? r.body.shoot?.id;
    let row = (await ed.get('/api/shoot-readiness')).body.shoots.find((x: any) => x.shoot.id === shootId);
    expect(row).toMatchObject({ total: 2, finished: 0, state: 'on_track' });
    const sc = (await manager.get(`/api/batches/${r.body.batchId}`)).body.scripts.map((s: any) => s.id);
    await sarah.post(`/api/batches/${r.body.batchId}/scripts/action`, { action: 'submit', scriptIds: sc });
    await manager.post(`/api/batches/${r.body.batchId}/scripts/action`, { action: 'approve', scriptIds: sc });
    row = (await ed.get('/api/shoot-readiness')).body.shoots.find((x: any) => x.shoot.id === shootId);
    expect(row).toMatchObject({ finished: 2, state: 'ready' });
    const n = (await ed.get('/api/notifications')).body.notifications;
    expect(n.some((x: any) => x.title.startsWith('Scripts final · '))).toBe(true);
    // editors can search, but only find what they can open
    const found = (await ed.get('/api/search?q=acme')).body;
    expect(found.batches).toEqual([]);
    expect(found.clients.length).toBeGreaterThan(0);
  });

  it('searches people, shoots, script numbers and briefing calls', async () => {
    const people = (await manager.get('/api/search?q=sarah')).body.people;
    expect(people.some((p: any) => p.id === ids.sarah)).toBe(true);
    const nums = (await manager.get(`/api/search?q=${encodeURIComponent('#1')}`)).body.scripts;
    expect(nums.length).toBeGreaterThan(0);
    expect(nums.every((x: any) => x.number === 1)).toBe(true);
    // writers only find their own script numbers
    const hers = (await sarah.get(`/api/search?q=${encodeURIComponent('script 1')}`)).body.scripts;
    const all = (await manager.get(`/api/search?q=${encodeURIComponent('script 1')}`)).body.scripts;
    expect(hers.length).toBeLessThanOrEqual(all.length);
    const shoots = (await manager.get('/api/search?q=acme')).body.shoots;
    expect(Array.isArray(shoots)).toBe(true);
  });

  it('names both missed deadlines the same way when drafts and final delivery are late', async () => {
    const b = await manager.post('/api/batches', { clientId: acmeId, title: 'Both late', targetCount: 1, draftDue: '2026-01-05', finalDue: '2026-01-07', split: [{ writerId: ids.sarah, count: 1 }] });
    const att = (await manager.get('/api/dashboard')).body.attention.find((a: any) => a.batch.id === b.body.batchId);
    expect(att.issues[0].text).toMatch(/^Drafts \d+ days overdue · Final delivery \d+ days overdue/);
  });

  it('names the document version in the history when deciding on it', async () => {
    const b = await manager.post('/api/batches', { clientId: acmeId, title: 'Versioned log', targetCount: 1, split: [{ writerId: ids.sarah, count: 1 }] });
    const id = b.body.batchId;
    const sc = (await manager.get(`/api/batches/${id}`)).body.scripts.map((s: any) => s.id);
    const v = await sarah.post(`/api/batches/${id}/submissions`, { scriptIds: sc, url: 'https://docs.google.com/document/d/log-v1' });
    await manager.post(`/api/batches/${id}/review`, { action: 'approve', scriptIds: sc, submissionId: v.body.submissionId });
    const act = (await manager.get(`/api/batches/${id}`)).body.activity;
    expect(act.some((a: any) => /\(document version 1\)/.test(a.summary))).toBe(true);
  });
});


describe('overview cards', () => {
  it('gives the cards their footers: deliveries per day this week and the review queue’s age', async () => {
    const c = (await manager.get('/api/dashboard')).body.cards;
    expect(c.deliveredByDay).toHaveLength(7);
    expect(c.deliveredByDay.reduce((n: number, x: number) => n + x, 0)).toBe(c.deliveredThisWeekScripts);
    if (c.awaitingReviewScripts > 0) expect(typeof c.oldestInReviewAt).toBe('string');
    else expect(c.oldestInReviewAt).toBeNull();
    expect(c.lastReviewAt === null || typeof c.lastReviewAt === 'string').toBe(true);
  });
});

describe('revised after feedback', () => {
  it('only quotes a send-back on the same scripts in the same batch, and only for the version that answered it', async () => {
    const a = await manager.post('/api/batches', { clientId: acmeId, title: 'Feedback batch A', targetCount: 2, split: [{ writerId: ids.sarah, count: 2 }] });
    const b = await manager.post('/api/batches', { clientId: acmeId, title: 'Feedback batch B', targetCount: 2, split: [{ writerId: ids.marcus, count: 2 }] });
    const sa = (await manager.get(`/api/batches/${a.body.batchId}`)).body.scripts.map((s: any) => s.id);
    const sb = (await manager.get(`/api/batches/${b.body.batchId}`)).body.scripts.map((s: any) => s.id);
    const a1 = await sarah.post(`/api/batches/${a.body.batchId}/submissions`, { scriptIds: sa, url: 'https://docs.google.com/document/d/fb-a1' });
    await manager.post(`/api/batches/${a.body.batchId}/review`, { action: 'revisions', scriptIds: sa, submissionId: a1.body.submissionId, note: 'Only for batch A' });
    // batch B has scripts 1–2 too, but nobody gave it feedback
    const b1 = await marcus.post(`/api/batches/${b.body.batchId}/submissions`, { scriptIds: sb, url: 'https://docs.google.com/document/d/fb-b1' });
    // the Review queue loads every batch at once, which is where the numbers used to collide
    const queue = (await manager.get('/api/review')).body;
    const subB = queue.waiting.find((g: any) => g.submission?.id === b1.body.submissionId).submission;
    expect(subB.afterFeedback).toBeNull();
    // batch A's revised version answers it; a newer version after that, with no new feedback, doesn't repeat it
    const a2 = await sarah.post(`/api/batches/${a.body.batchId}/submissions`, { scriptIds: sa, url: 'https://docs.google.com/document/d/fb-a2' });
    const a3 = await sarah.post(`/api/batches/${a.body.batchId}/submissions`, { scriptIds: sa, url: 'https://docs.google.com/document/d/fb-a3' });
    const subsA = (await manager.get(`/api/batches/${a.body.batchId}`)).body.submissions;
    expect(subsA.find((s: any) => s.id === a2.body.submissionId).afterFeedback).toMatchObject({ note: 'Only for batch A' });
    expect(subsA.find((s: any) => s.id === a3.body.submissionId).afterFeedback).toBeNull();
  });
});
