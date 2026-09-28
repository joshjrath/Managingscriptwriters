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
import { runReminders } from '../server/reminders';
import type { Ctx } from '../server/core';
import type { BatchDetail, Dashboard } from '../shared/types';

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
    expect(queue.revisions.map((r: any) => r.note)).toContain('Tighten the hook');
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
    expect(notes.some((n: any) => n.type === 'delivery' && /writer-confirmed/.test(n.body))).toBe(true);
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
