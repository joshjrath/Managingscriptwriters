// Migration 43 (past thumbnails from YouTube), on a database upgraded from migration 42 on this engine (in-memory PGlite,
// or a schema of its own on PostgreSQL with TEST_DATABASE_URL): a brief already marked live with a YouTube link takes
// its video's id (the shared parser, any link shape); of two live briefs linking one video, the one made first keeps it
// and the later is left without (logged); a cancelled brief keeps its own; other links take none. Then a video is on at
// most one brief that isn't cancelled (thumbnail_briefs_youtube_key), and only 'youtube' is a place a brief came from.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { migrate, openPglite, openPostgres, type Db } from '../server/db';
import { MIGRATIONS } from '../server/schema';

const SCHEMA = 'youtube_upgrade';
let old: Db;
const ids = {} as Record<'user' | 'client' | 'first' | 'second' | 'cancelled' | 'vimeo' | 'other' | 'none', number>;
const warned: string[] = [];

beforeAll(async () => {
  // migration 43 is the 43rd, a function (so its columns, fill and index run in order in one transaction); later ones follow it
  expect(MIGRATIONS.length).toBeGreaterThanOrEqual(43);
  expect(typeof MIGRATIONS[42]).toBe('function');
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    await c.query(`drop schema if exists ${SCHEMA} cascade; create schema ${SCHEMA};`);
    await c.end();
  }
  old = url ? await openPostgres(url, { schema: SCHEMA }) : await openPglite();
  // migrations 1 to 42, as the runner applies them
  await old.query(`create table schema_migrations (version int primary key, applied_at timestamptz not null default now())`);
  for (const [i, sql] of MIGRATIONS.slice(0, 42).entries()) {
    await old.tx(async (t) => {
      if (typeof sql === 'function') await sql(t);
      else for (const stmt of sql.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) await t.query(stmt);
      await t.query(`insert into schema_migrations (version) values ($1)`, [i + 1]);
    });
  }
  const one = async (sql: string, params: unknown[] = []) => (await old.one<{ id: number }>(sql, params))!.id;
  ids.user = await one(`insert into users (email, name, role, password_hash) values ('m@x.test', 'M', 'manager', 'x') returning id`);
  ids.client = await one(`insert into clients (name, created_by) values ('C', $1) returning id`, [ids.user]);
  const brief = (title: string, url: string | null, at: string, cancelled = false) => one(
    `insert into thumbnail_briefs (client_id, title, created_by, created_at, published_url, published_on, cancelled_at)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [ids.client, title, ids.user, at, url, url ? '2026-10-01' : null, cancelled ? at : null],
  );
  // the same video three times (two link shapes), made in this order, the second made first
  ids.second = await brief('Second', 'https://youtu.be/dQw4w9WgXcQ?t=1', '2026-10-02T12:00:00Z');
  ids.first = await brief('First', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', '2026-10-01T12:00:00Z');
  ids.cancelled = await brief('Cancelled', 'https://m.youtube.com/shorts/dQw4w9WgXcQ', '2026-09-01T12:00:00Z', true);
  ids.vimeo = await brief('Vimeo', 'https://vimeo.com/123456', '2026-10-03T12:00:00Z');
  ids.other = await brief('Other', 'youtube.com/live/abcdefghijk', '2026-10-04T12:00:00Z');
  ids.none = await brief('None', null, '2026-10-05T12:00:00Z');
  // before 43 there's nowhere to keep a video
  await expect(old.query(`update thumbnail_briefs set youtube_video_id = 'x' where id = $1`, [ids.none])).rejects.toThrow();
  vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { warned.push(String(m)); });
  await migrate(old);
  vi.restoreAllMocks();
});

afterAll(async () => {
  await old?.close();
});

const videoOf = async (id: number) => (await old.one<{ v: string | null }>(`select youtube_video_id as v from thumbnail_briefs where id = $1`, [id]))!.v;

describe('migration 43', () => {
  it('runs every migration, with its index and check named the same on this engine', async () => {
    expect((await old.one<{ n: number }>(`select count(*)::int as n from schema_migrations`))?.n).toBe(MIGRATIONS.length);
    const checks = (await old.query<{ conname: string }>(
      `select conname from pg_constraint where conrelid = 'thumbnail_briefs'::regclass and contype = 'c' order by conname`,
    )).map((c) => c.conname);
    expect(checks).toContain('thumbnail_briefs_imported_from_check');
    // in this schema only: on PostgreSQL the public schema may hold another suite's copy
    const idx = await old.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where schemaname = current_schema() and tablename = 'thumbnail_briefs' and indexname = 'thumbnail_briefs_youtube_key'`,
    );
    expect(idx).toHaveLength(1);
    expect(idx[0].indexdef.replace(/\s+/g, ' ')).toMatch(/^CREATE UNIQUE INDEX thumbnail_briefs_youtube_key ON \S*thumbnail_briefs USING btree \(youtube_video_id\) WHERE \(cancelled_at IS NULL\)$/);
  });

  it('gives each brief already live on YouTube its video, the first made keeping one two share', async () => {
    expect(await Promise.all([ids.first, ids.second, ids.cancelled, ids.vimeo, ids.other, ids.none].map(videoOf))).toEqual([
      'dQw4w9WgXcQ', null, 'dQw4w9WgXcQ', null, 'abcdefghijk', null,
    ]);
    expect(warned.filter((w) => w.includes('migration 43'))).toEqual([
      `migration 43: thumbnail brief ${ids.second} links the same YouTube video (dQw4w9WgXcQ) as brief ${ids.first}, which keeps it; brief ${ids.second} is left without its video id`,
    ]);
    // every brief keeps everything else, and comes from the site
    expect(await old.one(`select title, published_url, imported_from, imported_at, imported_by, youtube_channel, youtube_channel_url from thumbnail_briefs where id = $1`, [ids.second])).toEqual({
      title: 'Second', published_url: 'https://youtu.be/dQw4w9WgXcQ?t=1', imported_from: null, imported_at: null, imported_by: null, youtube_channel: null, youtube_channel_url: null,
    });
  });

  it('keeps a video on one brief that isn’t cancelled, and only YouTube as where one came from', async () => {
    await expect(old.query(`update thumbnail_briefs set youtube_video_id = 'dQw4w9WgXcQ' where id = $1`, [ids.none])).rejects.toThrow(/thumbnail_briefs_youtube_key/);
    await expect(old.query(`update thumbnail_briefs set youtube_video_id = 'abcdefghijk' where id = $1`, [ids.vimeo])).rejects.toThrow(/thumbnail_briefs_youtube_key/);
    // a cancelled brief's video is free: another may take it while it stays cancelled, not once it's back
    await old.query(`update thumbnail_briefs set cancelled_at = now() where id = $1`, [ids.first]);
    await old.query(`update thumbnail_briefs set youtube_video_id = 'dQw4w9WgXcQ' where id = $1`, [ids.none]);
    await expect(old.query(`update thumbnail_briefs set cancelled_at = null where id = $1`, [ids.first])).rejects.toThrow(/thumbnail_briefs_youtube_key/);
    await expect(old.query(`update thumbnail_briefs set imported_from = 'vimeo' where id = $1`, [ids.none])).rejects.toThrow(/thumbnail_briefs_imported_from_check/);
    await old.query(`update thumbnail_briefs set imported_from = 'youtube', imported_at = now(), imported_by = $2 where id = $1`, [ids.none, ids.user]);
    await expect(old.query(`update thumbnail_briefs set imported_by = 999999 where id = $1`, [ids.none])).rejects.toThrow();
    expect(await old.one(`select imported_from from thumbnail_briefs where id = $1`, [ids.none])).toEqual({ imported_from: 'youtube' });
  });
});
