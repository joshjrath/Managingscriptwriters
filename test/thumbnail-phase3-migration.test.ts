// Migration 41 (Thumbnail Studio, phase 3), on a database upgraded from migration 40 on this engine (in-memory PGlite,
// or a schema of its own on PostgreSQL with TEST_DATABASE_URL): resources keep their categories and take the new ones,
// a client's brand kit holds at most 12 colours and 6 fonts, a reference is exactly one of an upload, a winner or a
// resource, and an entry in Settings → Editors takes only a known kind.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrate, openPglite, openPostgres, type Db } from '../server/db';
import { MIGRATIONS } from '../server/schema';

const SCHEMA = 'phase3_upgrade';
let old: Db;
let ids: { user: number; client: number; resource: number; file: number; variant: number; editor: number };

beforeAll(async () => {
  const at = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes('create table client_brand'));
  expect(at).toBe(40);
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    await c.query(`drop schema if exists ${SCHEMA} cascade; create schema ${SCHEMA};`);
    await c.end();
  }
  old = url ? await openPostgres(url, { schema: SCHEMA }) : await openPglite();
  // migrations 1 to 40, as the runner applies them
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
  const resource = await one(`insert into resources (client_id, kind, category, title, file_id, created_by) values ($1, 'file', 'asset', 'Logo', $2, $3) returning id`, [client, file, user]);
  // before 41 a resource can't be a logo
  await expect(old.query(`insert into resources (client_id, kind, category, title, url, created_by) values ($1, 'link', 'logo', 'L', 'https://x.test', $2)`, [client, user])).rejects.toThrow();
  const brief = await one(`insert into thumbnail_briefs (client_id, title, designer_id, created_by) values ($1, 'T', $2, $2) returning id`, [client, user]);
  const round = await one(`insert into thumbnail_rounds (brief_id, number, created_by, sent_at) values ($1, 1, $2, now()) returning id`, [brief, user]);
  const variant = await one(`insert into thumbnail_variants (round_id, letter, file_id, mime, width, height, uploaded_by) values ($1, 'A', $2, 'image/png', 1280, 720, $3) returning id`, [round, file, user]);
  const editor = await one(`insert into editors (name, city, city_code, country, lat, lon, timezone, work_start, work_end) values ('E', 'London', 'LON', 'United Kingdom', 51.5, -0.1, 'Europe/London', 9, 18) returning id`);
  ids = { user, client, resource, file, variant, editor };
  await migrate(old);
});

afterAll(async () => {
  await old?.close();
});

describe('the phase 3 migration', () => {
  it('names its constraints the same on this engine', async () => {
    const names = (await old.query<{ conname: string }>(
      `select conname from pg_constraint where conrelid in ('resources'::regclass, 'client_brand'::regclass, 'thumbnail_refs'::regclass, 'editors'::regclass) and contype = 'c' order by conname`,
    )).map((c) => c.conname);
    expect(names).toEqual(expect.arrayContaining([
      'client_brand_colours_check', 'client_brand_fonts_check', 'editors_editor_kind_check', 'resources_category_check', 'thumbnail_refs_source_check',
    ]));
    // the old inline check was swapped, not joined by a second one
    expect(names.filter((n) => n.startsWith('resources_category'))).toEqual(['resources_category_check']);
    expect((await old.one<{ n: number }>(`select count(*)::int as n from schema_migrations`))?.n).toBe(MIGRATIONS.length);
  });

  it('keeps every resource, and takes logos, references and fonts', async () => {
    expect(await old.one(`select category from resources where id = $1`, [ids.resource])).toEqual({ category: 'asset' });
    for (const category of ['logo', 'reference', 'font', 'folder', 'other']) {
      await old.query(`insert into resources (client_id, kind, category, title, url, created_by) values ($1, 'link', $2, 'L', 'https://x.test', $3)`, [ids.client, category, ids.user]);
    }
    await expect(old.query(`insert into resources (client_id, kind, category, title, url, created_by) values ($1, 'link', 'banner', 'L', 'https://x.test', $2)`, [ids.client, ids.user])).rejects.toThrow();
  });

  it('keeps one brand kit per client, with at most 12 colours and 6 fonts', async () => {
    await old.query(`insert into client_brand (client_id, updated_by) values ($1, $2)`, [ids.client, ids.user]);
    expect(await old.one(`select colours, fonts, dos, donts from client_brand where client_id = $1`, [ids.client])).toEqual({ colours: [], fonts: [], dos: null, donts: null });
    await expect(old.query(`insert into client_brand (client_id) values ($1)`, [ids.client])).rejects.toThrow();
    const colours = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ name: `C${i}`, hex: '#E53935' })));
    await old.query(`update client_brand set colours = $2::jsonb where client_id = $1`, [ids.client, colours(12)]);
    await expect(old.query(`update client_brand set colours = $2::jsonb where client_id = $1`, [ids.client, colours(13)])).rejects.toThrow();
    await expect(old.query(`update client_brand set colours = '{"name": "Red"}'::jsonb where client_id = $1`, [ids.client])).rejects.toThrow();
    const fonts = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ name: `F${i}` })));
    await old.query(`update client_brand set fonts = $2::jsonb where client_id = $1`, [ids.client, fonts(6)]);
    await expect(old.query(`update client_brand set fonts = $2::jsonb where client_id = $1`, [ids.client, fonts(7)])).rejects.toThrow();
    // a kit is for a client that exists
    await expect(old.query(`insert into client_brand (client_id) values (999999)`)).rejects.toThrow();
  });

  it('makes each reference exactly one of an upload, a winner or a resource', async () => {
    const add = (cols: string, vals: unknown[]) =>
      old.query(`insert into thumbnail_refs (user_id, client_id, ${cols}) values ($1, $2, ${vals.map((_, i) => `$${i + 3}`).join(', ')})`, [ids.user, ids.client, ...vals]);
    await add('file_id', [ids.file]);
    await add('variant_id', [ids.variant]);
    await add('resource_id', [ids.resource]);
    // on the general board (no client)
    await old.query(`insert into thumbnail_refs (user_id, resource_id, caption) values ($1, $2, 'general')`, [ids.user, ids.resource]);
    await expect(add('caption', ['nothing'])).rejects.toThrow();
    await expect(add('file_id, variant_id', [ids.file, ids.variant])).rejects.toThrow();
    await expect(add('file_id, variant_id, resource_id', [ids.file, ids.variant, ids.resource])).rejects.toThrow();
    const rows = await old.query<{ n: number }>(`select count(*)::int as n from thumbnail_refs where user_id = $1 and removed_at is null`, [ids.user]);
    expect(rows[0].n).toBe(4);
  });

  it('gives Settings → Editors entries a kind, checked by value only', async () => {
    expect(await old.one(`select editor_kind from editors where id = $1`, [ids.editor])).toEqual({ editor_kind: null });
    await old.query(`update editors set editor_kind = 'thumbnail' where id = $1`, [ids.editor]);
    await old.query(`update editors set editor_kind = 'short_form' where id = $1`, [ids.editor]);
    await old.query(`update editors set editor_kind = null where id = $1`, [ids.editor]);
    await expect(old.query(`update editors set editor_kind = 'long_form' where id = $1`, [ids.editor])).rejects.toThrow();
  });
});
