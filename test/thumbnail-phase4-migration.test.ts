// Migration 42 (Thumbnail Studio, phase 4), on a database upgraded from migration 41 on this engine (in-memory PGlite,
// or a schema of its own on PostgreSQL with TEST_DATABASE_URL): a brief made before it keeps everything and starts
// with nothing marked live and no Timeliner video, anything marked live needs the day it went live, clearing is every
// field back to null, and the Test & Compare winner and who marked it must exist.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrate, openPglite, openPostgres, type Db } from '../server/db';
import { MIGRATIONS } from '../server/schema';

const SCHEMA = 'phase4_upgrade';
let old: Db;
let ids: { user: number; brief: number; variant: number };

beforeAll(async () => {
  const at = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes('thumbnail_briefs_published_check'));
  expect(at).toBe(41);
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    await c.query(`drop schema if exists ${SCHEMA} cascade; create schema ${SCHEMA};`);
    await c.end();
  }
  old = url ? await openPostgres(url, { schema: SCHEMA }) : await openPglite();
  // migrations 1 to 41, as the runner applies them
  await old.query(`create table schema_migrations (version int primary key, applied_at timestamptz not null default now())`);
  for (const [i, sql] of MIGRATIONS.slice(0, at).entries()) {
    await old.tx(async (t) => {
      if (typeof sql === 'function') await sql(t);
      else for (const stmt of sql.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) await t.query(stmt);
      await t.query(`insert into schema_migrations (version) values ($1)`, [i + 1]);
    });
  }
  const one = async (sql: string, params: unknown[] = []) => (await old.one<{ id: number }>(sql, params))!.id;
  const user = await one(`insert into users (email, name, role, editor_kind, password_hash) values ('d@x.test', 'D', 'editor', 'thumbnail', 'x') returning id`);
  const client = await one(`insert into clients (name, created_by) values ('C', $1) returning id`, [user]);
  const file = await one(`insert into files (filename, mime, size, sha256, data, uploaded_by) values ('a.png', 'image/png', 1, 'x', '\\x00'::bytea, $1) returning id`, [user]);
  const brief = await one(`insert into thumbnail_briefs (client_id, title, designer_id, created_by) values ($1, 'T', $2, $2) returning id`, [client, user]);
  const round = await one(`insert into thumbnail_rounds (brief_id, number, created_by, sent_at) values ($1, 1, $2, now()) returning id`, [brief, user]);
  const variant = await one(`insert into thumbnail_variants (round_id, letter, file_id, mime, width, height, uploaded_by) values ($1, 'A', $2, 'image/png', 1280, 720, $3) returning id`, [round, file, user]);
  // before 42 a brief can't be marked live
  await expect(old.query(`update thumbnail_briefs set published_on = '2026-10-26' where id = $1`, [brief])).rejects.toThrow();
  ids = { user, brief, variant };
  await migrate(old);
});

afterAll(async () => {
  await old?.close();
});

describe('the phase 4 migration', () => {
  it('runs every migration and names its check the same on this engine', async () => {
    expect((await old.one<{ n: number }>(`select count(*)::int as n from schema_migrations`))?.n).toBe(MIGRATIONS.length);
    const names = (await old.query<{ conname: string }>(
      `select conname from pg_constraint where conrelid = 'thumbnail_briefs'::regclass and contype = 'c' order by conname`,
    )).map((c) => c.conname);
    expect(names).toContain('thumbnail_briefs_published_check');
    // in this schema only: on PostgreSQL the database's public schema may hold another suite's copy of the index
    const idx = await old.query<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = current_schema() and tablename = 'thumbnail_briefs' and indexname = 'thumbnail_briefs_timeliner_idx'`,
    );
    expect(idx).toHaveLength(1);
  });

  it('keeps a brief made before it, with nothing marked live and no video', async () => {
    expect(await old.one(
      `select title, published_url, published_on, published_by, published_at, timeliner_task_id, test_winner_variant_id, test_note from thumbnail_briefs where id = $1`, [ids.brief],
    )).toEqual({
      title: 'T', published_url: null, published_on: null, published_by: null, published_at: null, timeliner_task_id: null, test_winner_variant_id: null, test_note: null,
    });
  });

  it('needs the day for anything marked live, and clears back to nothing', async () => {
    const set = (cols: string, vals: unknown[]) =>
      old.query(`update thumbnail_briefs set ${cols.split(', ').map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1`, [ids.brief, ...vals]);
    await expect(set('published_url', ['https://youtu.be/abc'])).rejects.toThrow();
    await expect(set('test_winner_variant_id', [ids.variant])).rejects.toThrow();
    await expect(set('test_note', ['B won'])).rejects.toThrow();
    // the day alone, then everything
    await set('published_on', ['2026-10-26']);
    await set('published_url, test_winner_variant_id, test_note, published_by, published_at', ['https://youtu.be/abc', ids.variant, 'B won', ids.user, new Date().toISOString()]);
    // the day can't go while the rest stays
    await expect(set('published_on', [null])).rejects.toThrow();
    await set('published_url, published_on, test_winner_variant_id, test_note, published_by, published_at', [null, null, null, null, null, null]);
    expect(await old.one(`select published_on, published_url from thumbnail_briefs where id = $1`, [ids.brief])).toEqual({ published_on: null, published_url: null });
  });

  it('names a Timeliner video without a foreign key, and only real options and people', async () => {
    // the copy of Timeliner can lose a video, so the brief keeps its id regardless
    await old.query(`update thumbnail_briefs set timeliner_task_id = 'gone-from-the-copy' where id = $1`, [ids.brief]);
    expect(await old.one(`select timeliner_task_id from thumbnail_briefs where id = $1`, [ids.brief])).toEqual({ timeliner_task_id: 'gone-from-the-copy' });
    await expect(old.query(`update thumbnail_briefs set published_on = '2026-10-26', test_winner_variant_id = 999999 where id = $1`, [ids.brief])).rejects.toThrow();
    await expect(old.query(`update thumbnail_briefs set published_on = '2026-10-26', published_by = 999999 where id = $1`, [ids.brief])).rejects.toThrow();
  });
});
