// Keeping the workspace's data safe: an edit keeps what it overwrote (in the activity entry, and so in the
// backups), the tests can't wipe a database that isn't a throwaway one, and Recording mode refuses to start
// when its practice copy would really be the real workspace.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import type { Db } from '../server/db';
import type { Ctx } from '../server/core';
import { cloneDb } from '../server/recording';
import type { BatchDetail } from '../shared/types';
import { freshDb, wipeAllowed } from './db';

let db: Db;
let app: FastifyInstance;
let admin = '';
let clientId = 0;

const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0];
const send = async (method: string, url: string, body?: unknown) => {
  const r = await app.inject({
    method: method as 'POST', url, headers: { 'x-scale-media': '1', cookie: admin, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
/** what the newest activity entry of this kind says changed */
const lastChanges = async (action: string) => {
  const r = await db.one<{ detail: { changes: Record<string, { from: unknown; to: unknown }> } | string }>(`select detail from activity where action = $1 order by id desc limit 1`, [action]);
  const d = typeof r?.detail === 'string' ? JSON.parse(r.detail) : r?.detail;
  return d?.changes;
};

beforeAll(async () => {
  db = await freshDb();
  const ctx: Ctx = { db, now: () => new Date('2026-10-16T12:00:00Z'), secureCookies: false, allowSetup: true, uploadLimitBytes: 1024 * 1024, remindersEnabled: false };
  app = await buildApp(ctx);
  admin = cookieOf(await app.inject({
    method: 'POST', url: '/api/auth/setup', headers: { 'x-scale-media': '1', 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'Ada Admin', email: 'ada@scale.test', password: 'admin-password-1' }),
  }));
  clientId = (await send('POST', '/api/clients', { name: 'Acme' })).body.clientId;
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('an edit keeps what it overwrote', () => {
  it('a client’s brand voice and guidance', async () => {
    expect((await send('PATCH', `/api/clients/${clientId}`, { brandVoice: 'Warm and plain.', guidance: 'Never say synergy.' })).status).toBe(200);
    expect((await send('PATCH', `/api/clients/${clientId}`, { brandVoice: 'Loud!', guidance: 'Never say synergy.' })).status).toBe(200);
    // only what changed, with what it was
    expect(await lastChanges('client.updated')).toEqual({ brand_voice: { from: 'Warm and plain.', to: 'Loud!' } });
    expect((await send('PATCH', `/api/clients/999999`, { brandVoice: 'x' })).status).toBe(404);
  });

  it('a briefing’s notes', async () => {
    const b = (await send('POST', `/api/clients/${clientId}/briefings`, { title: 'Kick-off', instructions: 'Hooks in the first line.' })).body.briefing;
    expect((await send('PATCH', `/api/briefings/${b.id}`, { instructions: 'Hooks in the first three words.' })).status).toBe(200);
    expect(await lastChanges('briefing.updated')).toEqual({ instructions: { from: 'Hooks in the first line.', to: 'Hooks in the first three words.' } });
  });

  it('a batch’s brief, and its deadlines with the deadline entry', async () => {
    const batchId = (await send('POST', '/api/batches', { clientId, title: 'Oct', targetCount: 2, brief: 'Five hooks each.' })).body.batchId as number;
    expect((await send('PATCH', `/api/batches/${batchId}`, { brief: 'Ten hooks each.', finalDue: { mode: 'manual', date: '2026-11-20' } })).status).toBe(200);
    expect(await lastChanges('batch.updated')).toEqual({ brief: { from: 'Five hooks each.', to: 'Ten hooks each.' } });
    expect(await lastChanges('batch.deadlines')).toMatchObject({ final_due: { to: '2026-11-20' } });
  });

  it('a script’s notes and link', async () => {
    const batchId = (await send('POST', '/api/batches', { clientId, title: 'Nov', targetCount: 1 })).body.batchId as number;
    const s = ((await send('GET', `/api/batches/${batchId}`)).body as BatchDetail).scripts[0];
    const first = (await send('PATCH', `/api/scripts/${s.id}`, { version: s.version, notes: 'Open on the product.', docUrl: 'https://docs.google.com/document/d/one' })).body.script;
    expect((await send('PATCH', `/api/scripts/${s.id}`, { version: first.version, notes: 'Open on the founder.', docUrl: 'https://docs.google.com/document/d/one' })).status).toBe(200);
    expect(await lastChanges('script.edited')).toEqual({ notes: { from: 'Open on the product.', to: 'Open on the founder.' } });
  });
});

describe('the tests’ own database', () => {
  it('is wiped only when it’s on this machine or named for tests, and never when it’s the app’s', () => {
    expect(wipeAllowed('postgres://postgres:postgres@localhost:5432/postgres', undefined)).toBe(true);
    expect(wipeAllowed('postgres://u:p@127.0.0.1/app', undefined)).toBe(true);
    expect(wipeAllowed('postgres://u:p@db.internal:5432/scripts_test', undefined)).toBe(true);
    expect(wipeAllowed('postgres://u:p@dpg-abc123-a.oregon-postgres.render.com/scale_media_db', undefined)).toBe(false);
    expect(wipeAllowed('postgres://u:p@dpg-abc123-a/scale_media_db', undefined)).toBe(false);
    expect(wipeAllowed('not a url', undefined)).toBe(false);
    const app = 'postgres://u:p@localhost:5432/scale';
    expect(wipeAllowed(app, app)).toBe(false);
  });

  it('refuses before connecting to anything else', async () => {
    const was = process.env.TEST_DATABASE_URL;
    process.env.TEST_DATABASE_URL = 'postgres://u:p@dpg-abc123-a.oregon-postgres.render.com/scale_media_db';
    try {
      await expect(freshDb()).rejects.toThrow(/throwaway database/);
    } finally {
      if (was === undefined) delete process.env.TEST_DATABASE_URL;
      else process.env.TEST_DATABASE_URL = was;
    }
  });
});

describe('Recording mode', () => {
  it('won’t start when its practice copy would be the real workspace', async () => {
    const users = await db.query(`select id, name from users order by id`);
    // what a connection pooler that drops the schema setting does: the copy's own connections reach the real workspace
    const pooled: Db = { ...db, withSchema: async () => ({ ...db, close: async () => {} }) };
    await expect(cloneDb(pooled)).rejects.toThrow(/wasn’t started/);
    expect(await db.query(`select id, name from users order by id`)).toEqual(users);
    expect(await db.query(`select nspname from pg_namespace where nspname like 'rec\\_%'`)).toEqual([]);
    // and a real copy still works
    const copy = await cloneDb(db);
    expect(await copy.query(`select id, name from users order by id`)).toEqual(users);
    await copy.close();
  });
});
