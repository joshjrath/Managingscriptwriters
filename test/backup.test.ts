// The daily backup to Google Sheets (server/backup.ts): only the backup key opens it, every table is in it
// except sign-ins, no secret ever leaves, tables and files come in pieces that add up to the whole, and the
// Admins hear when backups stop arriving.

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import type { Db } from '../server/db';
import type { Ctx } from '../server/core';
import { bufferFile, storeFile } from '../server/files';
import { runReminders } from '../server/reminders';
import { BACKUP_LATE_HOURS, SECRET_COLUMN } from '../server/backup';
import type { BackupStatus, Me } from '../shared/types';
import { freshDb } from './db';

let now = new Date('2026-10-16T12:00:00Z');
let db: Db;
let ctx: Ctx;
let app: FastifyInstance;
let admin = '';
let manager = '';
let adminId = 0;
let key = '';

const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0];
const send = async (method: string, url: string, cookie: string, body?: unknown) => {
  const r = await app.inject({
    method: method as 'POST', url, headers: { 'x-scale-media': '1', cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
/** what the backup sheet calls, with the key it was given */
const pull = async (url: string, withKey = key) => app.inject({ method: 'GET', url, headers: withKey ? { authorization: `Bearer ${withKey}` } : {} });
const done = (body: unknown, withKey = key) => app.inject({ method: 'POST', url: '/hooks/backup/done', headers: { authorization: `Bearer ${withKey}`, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

interface Manifest { tables: { name: string; columns: string[]; key: string[]; rows: number }[]; files: { count: number; bytes: number } }
interface Page { columns: string[]; rows: unknown[][]; next: (string | number)[] | null }

/** every row of a table, page by page, the way the sheet reads it */
const readAll = async (table: string, limit: number) => {
  const rows: unknown[][] = [];
  let after: unknown = null;
  for (let i = 0; i < 100; i++) {
    const r = await pull(`/hooks/backup/tables/${table}?limit=${limit}${after ? `&after=${encodeURIComponent(JSON.stringify(after))}` : ''}`);
    expect(r.statusCode).toBe(200);
    const page = r.json<Page>();
    rows.push(...page.rows);
    if (!page.next) return { columns: page.columns, rows };
    after = page.next;
  }
  throw new Error('never reached the last page');
};

beforeAll(async () => {
  db = await freshDb();
  ctx = { db, now: () => now, secureCookies: false, allowSetup: true, uploadLimitBytes: 1024 * 1024, remindersEnabled: false };
  app = await buildApp(ctx);
  const setup = await app.inject({
    method: 'POST', url: '/api/auth/setup', headers: { 'x-scale-media': '1', 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'Ada Admin', email: 'ada@scale.test', password: 'admin-password-1' }),
  });
  admin = cookieOf(setup);
  adminId = (await db.one<{ id: number }>(`select id from users where email = 'ada@scale.test'`))!.id;
  expect((await send('POST', '/api/users', admin, { name: 'Max Manager', email: 'max@scale.test', role: 'manager', password: 'team-password-1' })).status).toBe(200);
  manager = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-scale-media': '1', 'content-type': 'application/json' }, payload: JSON.stringify({ email: 'max@scale.test', password: 'team-password-1' }) }));
  // a temporary password, a synced calendar's secret link and a Timeliner signing secret: none may leave
  await db.query(`update users set temp_password = 'temp-secret-1' where email = 'max@scale.test'`);
  await db.query(`insert into calendar_feeds (name, url, created_by) values ('Shoots', 'https://calendar.google.com/calendar/ical/secret-link/basic.ics', $1)`, [adminId]);
  await db.query(`update settings set timeliner_webhook_secret = 'whsec-secret-1' where id = 1`);
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('the backup key', () => {
  it('nothing opens without it, and only an Admin can make one', async () => {
    expect((await pull('/hooks/backup', '')).statusCode).toBe(401);
    expect((await pull('/hooks/backup', 'smb_guess')).statusCode).toBe(401);
    expect((await send('POST', '/api/admin/backup/key', manager, {})).status).toBe(403);
    const made = await send('POST', '/api/admin/backup/key', admin, {});
    expect(made.status).toBe(200);
    key = made.body.key;
    expect(key).toMatch(/^smb_[\w-]{40,}$/);
    // only its hash is kept
    expect(JSON.stringify(await db.one(`select * from settings where id = 1`))).not.toContain(key);
    expect((made.body.status as BackupStatus).keyCreated?.byName).toBe('Ada Admin');
    expect((await pull('/hooks/backup')).statusCode).toBe(200);
    expect((await pull('/hooks/backup', `${key}x`)).statusCode).toBe(401);
  });

  it('a new key stops the old one, and turning backups off stops every key', async () => {
    const old = key;
    key = (await send('POST', '/api/admin/backup/key', admin, {})).body.key;
    expect((await pull('/hooks/backup', old)).statusCode).toBe(401);
    expect((await pull('/hooks/backup')).statusCode).toBe(200);
    expect((await send('DELETE', '/api/admin/backup/key', admin)).body.keySet).toBe(false);
    expect((await pull('/hooks/backup')).statusCode).toBe(401);
    key = (await send('POST', '/api/admin/backup/key', admin, {})).body.key;
    const log = await db.query<{ action: string }>(`select action from activity where action like 'backup.%' order by id`);
    expect(log.map((r) => r.action)).toEqual(['backup.key', 'backup.key', 'backup.key_removed', 'backup.key']);
  });

  it('can’t be made in Recording mode, the practice copy', async () => {
    expect((await send('POST', '/api/admin/recording/start', admin, {})).status).toBe(200);
    try {
      const r = await send('POST', '/api/admin/backup/key', admin, {});
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('recording');
      expect((await pull('/hooks/backup')).statusCode).toBe(200);
    } finally {
      await send('POST', '/api/admin/recording/stop', admin, {});
    }
  });
});

describe('what the backup holds', () => {
  it('every table except sign-ins, so a new table is backed up without anyone adding it', async () => {
    const m = (await pull('/hooks/backup')).json<Manifest>();
    const all = (await db.query<{ t: string }>(`select table_name as t from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE' order by 1`)).map((r) => r.t);
    expect(m.tables.map((t) => t.name).sort()).toEqual(all.filter((t) => t !== 'sessions'));
    const clients = m.tables.find((t) => t.name === 'clients')!;
    expect(clients.columns).toEqual(expect.arrayContaining(['id', 'name', 'brand_voice', 'guidance']));
    expect(m.tables.find((t) => t.name === 'users')!.rows).toBe(2);
  });

  it('no secret: no password, temporary password, signing secret, key, file contents or secret calendar link', async () => {
    const m = (await pull('/hooks/backup')).json<Manifest>();
    const cols = (name: string) => m.tables.find((t) => t.name === name)!.columns;
    expect(cols('users')).not.toEqual(expect.arrayContaining(['password_hash']));
    expect(cols('users')).not.toContain('temp_password');
    expect(cols('settings')).not.toContain('timeliner_webhook_secret');
    expect(cols('settings')).not.toContain('backup_key_hash');
    expect(cols('files')).not.toContain('data');
    expect(cols('calendar_feeds')).not.toContain('url');
    expect(m.tables.flatMap((t) => t.columns).filter((c) => SECRET_COLUMN.test(c))).toEqual([]);
    // and none of the values make it out either
    let everything = '';
    for (const t of m.tables) everything += JSON.stringify((await readAll(t.name, 1000)).rows);
    for (const secret of ['temp-secret-1', 'secret-link', 'whsec-secret-1', 'scrypt']) expect(everything).not.toContain(secret);
  });

  it('a table comes in pages that add up to all of it, whatever its key', async () => {
    const c = (await db.one<{ id: number }>(`insert into clients (name) values ('Acme') returning id`))!.id;
    const batch = (await db.one<{ id: number }>(`insert into batches (client_id, title, target_count) values ($1, 'Acme Oct', 3) returning id`, [c]))!.id;
    for (const title of ['One', 'Two', 'Three']) {
      const b = (await db.one<{ id: number }>(`insert into briefings (client_id, title) values ($1, $2) returning id`, [c, title]))!.id;
      await db.query(`insert into batch_briefings (batch_id, briefing_id) values ($1, $2)`, [batch, b]);
    }
    for (let i = 0; i < 7; i++) await db.query(`insert into activity (entity_type, action, summary) values ('client', 'client.updated', $1)`, [`Change ${i}`]);
    const total = (await db.one<{ n: number }>(`select count(*) as n from activity`))!.n;
    const activity = await readAll('activity', 2);
    expect(activity.rows).toHaveLength(total);
    const ids = activity.rows.map((r) => r[activity.columns.indexOf('id')] as number);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    // two columns make its key: still every row, once
    const links = await readAll('batch_briefings', 1);
    expect(links.rows).toHaveLength(3);
    expect(new Set(links.rows.map((r) => JSON.stringify(r))).size).toBe(3);
    // and text keys
    await db.query(`insert into timeliner_removed (id, removed_at) values ('b', now()), ('a', now()), ('c', now())`);
    expect((await readAll('timeliner_removed', 2)).rows.map((r) => r[0])).toEqual(['a', 'b', 'c']);
  });

  it('refuses a table it doesn’t have, and a page cursor that isn’t one', async () => {
    expect((await pull('/hooks/backup/tables/sessions')).statusCode).toBe(404);
    expect((await pull('/hooks/backup/tables/no_such_table')).statusCode).toBe(404);
    expect((await pull(`/hooks/backup/tables/clients?after=${encodeURIComponent('[1,2]')}`)).statusCode).toBe(400);
    expect((await pull(`/hooks/backup/tables/clients?after=${encodeURIComponent('drop')}`)).statusCode).toBe(400);
  });

  it('a file comes whole, or in pieces that put back together are the same bytes', async () => {
    const me = { id: adminId, name: 'Ada Admin', email: 'ada@scale.test', role: 'owner' } as Me;
    const data = Buffer.alloc(1_300_000);
    for (let i = 0; i < data.length; i++) data[i] = (i * 7919) % 251;
    const id = await db.tx((t) => storeFile(t, me, bufferFile('brief.pdf', 'application/pdf', data)));
    const whole = await pull(`/hooks/backup/files/${id}`);
    expect(whole.statusCode).toBe(200);
    expect(whole.headers['x-file-size']).toBe(String(data.length));
    expect(sha(whole.rawPayload)).toBe(sha(data));
    const parts: Buffer[] = [];
    for (let from = 0; from < data.length; from += 500_000) parts.push((await pull(`/hooks/backup/files/${id}?from=${from}&length=500000`)).rawPayload);
    expect(parts.map((p) => p.length)).toEqual([500_000, 500_000, 300_000]);
    expect(sha(Buffer.concat(parts))).toBe(sha(data));
    expect((await pull(`/hooks/backup/files/${id}`, '')).statusCode).toBe(401);
    expect((await pull('/hooks/backup/files/999999')).statusCode).toBe(404);
  });
});

describe('when backups stop arriving', () => {
  const notices = async () => (await db.query<{ title: string; body: string }>(`select title, body from notifications where user_id = $1 and type = 'backup' order by id`, [adminId]));

  it('the Admins hear once a day until one arrives, and Settings says so', async () => {
    // the key was made just now: not late yet
    await runReminders(ctx);
    expect(await notices()).toEqual([]);
    expect((await send('GET', '/api/admin/backup', admin)).body.late).toBe(false);

    now = new Date(now.getTime() + (BACKUP_LATE_HOURS + 1) * 3600_000);
    await runReminders(ctx);
    await runReminders(ctx);
    expect(await notices()).toHaveLength(1);
    expect((await notices())[0].body).toContain('No backup has arrived');
    expect((await send('GET', '/api/admin/backup', admin)).body.late).toBe(true);
    // managers aren't told: backups are the Admins'
    expect((await db.query(`select 1 from notifications n join users u on u.id = n.user_id where n.type = 'backup' and u.role <> 'owner'`))).toEqual([]);

    // the sheet finishes
    expect((await done({ sheetUrl: 'https://docs.google.com/spreadsheets/d/abc123/edit', tables: 40, rows: 120, files: 1, filesSaved: 1 })).statusCode).toBe(200);
    const s = (await send('GET', '/api/admin/backup', admin)).body as BackupStatus;
    expect(s.late).toBe(false);
    expect(s.sheetUrl).toBe('https://docs.google.com/spreadsheets/d/abc123/edit');
    expect(s.last).toMatchObject({ tables: 40, rows: 120, files: 1, filesSaved: 1, filesWaiting: 0, problems: [] });
    expect(s.database.files).toBe(1);

    now = new Date(now.getTime() + 24 * 3600_000);
    await runReminders(ctx);
    expect(await notices()).toHaveLength(1);
    now = new Date(now.getTime() + 24 * 3600_000);
    await runReminders(ctx);
    expect(await notices()).toHaveLength(2);
    expect((await notices())[1].body).toContain('The last backup arrived 2 days ago');
  });

  it('only a Google Sheets address is kept as the sheet’s link, and only with the key', async () => {
    expect((await done({ sheetUrl: 'https://evil.example/phish', tables: 1, rows: 1, files: 0, filesSaved: 0 })).statusCode).toBe(200);
    expect(((await send('GET', '/api/admin/backup', admin)).body as BackupStatus).sheetUrl).toBe('https://docs.google.com/spreadsheets/d/abc123/edit');
    expect((await done({ tables: 1, rows: 1, files: 0, filesSaved: 0 }, 'smb_wrong')).statusCode).toBe(401);
  });

  it('no alert while backups are off', async () => {
    await send('DELETE', '/api/admin/backup/key', admin);
    now = new Date(now.getTime() + 5 * 24 * 3600_000);
    const before = (await notices()).length;
    await runReminders(ctx);
    expect(await notices()).toHaveLength(before);
    expect(((await send('GET', '/api/admin/backup', admin)).body as BackupStatus).late).toBe(false);
  });
});
