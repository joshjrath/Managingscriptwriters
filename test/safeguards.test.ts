// Rules that keep scripts with writers, the database out of lock trouble, and settings coming from
// loadConfig. Each runs on its own database so it can't disturb the long scenario in api.test.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import type { Db } from '../server/db';
import type { Ctx } from '../server/core';
import { normaliseFeedUrl } from '../server/calendar-feeds';
import type { BatchDetail } from '../shared/types';
import { freshDb } from './db';

const NOW = new Date('2026-09-28T16:00:00Z');
let db: Db;
let app: FastifyInstance;
let admin = '';
let writer = '';
let writerId = 0;
let clientId = 0;
/** the SQL of every transaction run since the last reset, one list per transaction */
let txs: string[][] = [];

/** The database, keeping a note of what each transaction asks it. */
function watched(inner: Db, log?: string[]): Db {
  return {
    kind: inner.kind,
    query<T>(sql: string, params?: unknown[]) { log?.push(sql); return inner.query<T>(sql, params); },
    one<T>(sql: string, params?: unknown[]) { log?.push(sql); return inner.one<T>(sql, params); },
    tx<T>(fn: (t: Db) => Promise<T>) {
      return inner.tx((t) => {
        const mine: string[] = [];
        txs.push(mine);
        return fn(watched(t, mine));
      });
    },
    close: () => inner.close(),
    withSchema: (schema: string) => inner.withSchema(schema),
  };
}

const send = async (method: string, url: string, cookie: string, body?: unknown) => {
  const r = await app.inject({
    method: method as 'POST', url, headers: { 'x-scale-media': '1', cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0];
const signIn = async (email: string, password: string) =>
  cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-scale-media': '1', 'content-type': 'application/json' }, payload: JSON.stringify({ email, password }) }));
const addPerson = async (name: string, email: string, role: string) => {
  const r = await send('POST', '/api/users', admin, { name, email, role, password: 'team-password-1' });
  expect(r.status).toBe(200);
  return r.body.users.find((u: { email: string }) => u.email === email).id as number;
};
const scriptsOf = async (batchId: number) => ((await send('GET', `/api/batches/${batchId}`, admin)).body as BatchDetail).scripts;

beforeAll(async () => {
  db = await freshDb();
  const ctx: Ctx = { db: watched(db), now: () => NOW, secureCookies: false, allowSetup: true, uploadLimitBytes: 1024 * 1024, remindersEnabled: false };
  app = await buildApp(ctx);
  admin = cookieOf(await app.inject({
    method: 'POST', url: '/api/auth/setup', headers: { 'x-scale-media': '1', 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'Ada Admin', email: 'ada@scale.test', password: 'admin-password-1' }),
  }));
  writerId = await addPerson('Wes Writer', 'wes@scale.test', 'writer');
  writer = await signIn('wes@scale.test', 'team-password-1');
  clientId = (await send('POST', '/api/clients', admin, { name: 'Acme' })).body.clientId;
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('scripts brought back by raising a batch’s count', () => {
  it('never go to someone who has become an editor, and count as just given to their writer', async () => {
    const edId = await addPerson('Ed Former', 'ed@scale.test', 'writer');
    const batchId = (await send('POST', '/api/batches', admin, { clientId, title: 'Two for Ed', targetCount: 2, split: [{ writerId: edId, count: 2 }] })).body.batchId as number;
    const [one, two] = await scriptsOf(batchId);
    expect((await send('POST', `/api/batches/${batchId}/target`, admin, { targetCount: 1, removeScriptIds: [two.id] })).status).toBe(200);
    // Ed hands script 1 over and becomes an editor; script 2 is still his, but taken off the batch
    expect((await send('POST', `/api/batches/${batchId}/scripts/assign`, admin, { scriptIds: [one.id], assigneeId: writerId })).status).toBe(200);
    expect((await send('PATCH', `/api/users/${edId}`, admin, { role: 'editor' })).status).toBe(200);
    await db.query(`update scripts set assigned_at = '2026-01-05T12:00:00Z' where id = $1`, [two.id]);

    expect((await send('POST', `/api/batches/${batchId}/target`, admin, { targetCount: 2 })).status).toBe(200);
    expect(await db.one(`select assignee_id, assigned_at from scripts where id = $1`, [two.id])).toEqual({ assignee_id: null, assigned_at: null });

    expect((await send('POST', `/api/batches/${batchId}/target`, admin, { targetCount: 1, removeScriptIds: [two.id] })).status).toBe(200);
    await db.query(`update scripts set assigned_at = '2026-01-05T12:00:00Z' where id = $1`, [two.id]);
    expect((await send('POST', `/api/batches/${batchId}/target`, admin, { targetCount: 2, assigneeId: writerId })).status).toBe(200);
    const back = await db.one<{ assignee_id: number; assigned_at: string | Date }>(`select assignee_id, assigned_at from scripts where id = $1`, [two.id]);
    expect(Number(back!.assignee_id)).toBe(writerId);
    expect(new Date(back!.assigned_at).getTime()).toBeGreaterThan(Date.parse('2026-02-01'));
  });
});

describe('changes to several of a batch’s scripts', () => {
  /** which rows a transaction locks, in order */
  const locks = (sqls: string[]) => sqls.flatMap((s) =>
    /\bfrom batches\b[\s\S]*\bfor no key update\b/.test(s) ? ['batch']
      : /\bfrom scripts\b[\s\S]*\bfor update\b/.test(s) ? [/\border by number for update\b/.test(s) ? 'scripts in order' : 'scripts'] : []);
  const lockingScripts = () => txs.map(locks).filter((l) => l.some((x) => x.startsWith('scripts')));

  it('lock the batch first, then the scripts in number order, like every other batch change', async () => {
    const batchId = (await send('POST', '/api/batches', admin, { clientId, title: 'Three for Wes', targetCount: 3, split: [{ writerId, count: 3 }] })).body.batchId as number;
    const ids = (await scriptsOf(batchId)).map((s) => s.id);

    txs = [];
    expect((await send('POST', `/api/batches/${batchId}/scripts/assign`, admin, { scriptIds: [ids[2], ids[0]], assigneeId: writerId })).status).toBe(200);
    expect(lockingScripts()).toEqual([['batch', 'scripts in order']]);

    expect((await send('POST', `/api/batches/${batchId}/scripts/action`, writer, { action: 'submit', scriptIds: ids })).status).toBe(200);
    const approved = await send('POST', `/api/batches/${batchId}/scripts/action`, admin, { action: 'approve', scriptIds: ids });
    expect(approved.body.reviewId).toBeGreaterThan(0);
    txs = [];
    expect((await send('POST', `/api/reviews/${approved.body.reviewId}/undo`, admin, {})).status).toBe(200);
    expect(lockingScripts()).toEqual([['batch', 'scripts in order']]);
    expect((await scriptsOf(batchId)).map((s) => s.status)).toEqual(['ready_for_review', 'ready_for_review', 'ready_for_review']);
  });
});

describe('notes pasted in for import', () => {
  it('never give scripts to an editor named in them', async () => {
    await addPerson('Edna Cutter', 'edna@scale.test', 'editor');
    const plan = {
      summary: '', questions: [],
      clients: [{
        name: 'Cutter Co', existingClientId: null, status: 'active', description: null, brandVoice: null, guidance: null, briefings: [], shoots: [], notes: [],
        batches: [{ title: 'Cutter · 2 scripts', targetCount: 2, shootKey: null, plannedStart: null, draftDue: null, finalDue: null, brief: null, writerNames: ['Edna Cutter'], nextAction: null }],
      }],
    };
    const r = await send('POST', '/api/import/apply', admin, { plan });
    expect(r.status).toBe(200);
    expect(r.body.warnings.join(' ')).toMatch(/Edna Cutter/);
    const rows = await db.query<{ assignee_id: number | null }>(`select s.assignee_id from scripts s join batches b on b.id = s.batch_id where b.title = 'Cutter · 2 scripts'`);
    expect(rows).toEqual([{ assignee_id: null }, { assignee_id: null }]);
  });
});

describe('settings that come from the server’s configuration', () => {
  it('say reminders are off when this server doesn’t send them', async () => {
    expect((await send('GET', '/api/settings', admin)).body.settings.remindersEnabled).toBe(false);
    expect((await send('GET', '/api/bootstrap', admin)).body.settings.remindersEnabled).toBe(false);
  });

  it('let a synced calendar use a private address only when the server allows it', () => {
    expect(() => normaliseFeedUrl('http://127.0.0.1:8080/team.ics')).toThrow(/private address/);
    expect(normaliseFeedUrl('http://127.0.0.1:8080/team.ics', true)).toBe('http://127.0.0.1:8080/team.ics');
    expect(normaliseFeedUrl('webcal://calendar.example.com/team.ics')).toBe('https://calendar.example.com/team.ics');
  });
});

describe('Recording mode', () => {
  it('refuses a password change however its address is written', async () => {
    expect((await send('POST', '/api/admin/recording/start', admin, {})).status).toBe(200);
    try {
      for (const url of ['/api/me/password', '/%61pi/me/password']) {
        const r = await send('POST', url, admin, { current: 'admin-password-1', next: 'another-password-2' });
        expect([url, r.status, r.body.error?.code]).toEqual([url, 403, 'recording']);
      }
    } finally {
      await send('POST', '/api/admin/recording/stop', admin, {});
    }
    expect(await signIn('ada@scale.test', 'admin-password-1')).toMatch(/=/);
  });
});
