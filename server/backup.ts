// Backups to Google Sheets. Once a day a Google Sheet (scripts/google-sheets-backup.gs, set up from
// Settings → Backups) pulls a copy of the whole workspace through the routes under /hooks/backup: every table,
// a tab each, and every uploaded file into a Drive folder; then it keeps a dated copy of itself and tells the
// site it finished. It's a second copy away from the database host, whose own backups go back only 3–7 days.
//
// The routes are public but need the backup key (`Authorization: Bearer …`), which an Admin creates in Settings
// → Backups; only its SHA-256 is stored. Every table is included, so a new table is backed up without anyone
// remembering to add it, except what would let someone sign in or act as the site: sign-ins, password hashes,
// temporary passwords, signing secrets and keys (any column named for one), and the secret calendar links.
// File contents come one file (or one piece of a big file) at a time.
//
// When a key is set and no backup has arrived for BACKUP_LATE_HOURS, the reminders run tells the Admins
// once a day (`backupLateNotice`), so a sheet that stopped running doesn't go unnoticed.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from './db';
import { logActivity, type Ctx } from './core';
import { requireAdmin, sha } from './auth';
import { fileStream } from './files';
import { HttpError, notFound, parse, zs } from './http';
import type { BackupStatus } from '../shared/types';
import { fmtAgo } from '../shared/format';

/** How long without a backup before the Admins are told. */
export const BACKUP_LATE_HOURS = 36;
/** Never in a backup: sign-ins. */
const LEFT_OUT_TABLES = new Set(['sessions']);
/** Never in a backup: any column named for a secret (password hashes, temporary passwords, signing secrets, key hashes). */
export const SECRET_COLUMN = /password|secret|token|key_hash/;
/** Also left out: file contents (saved as files instead) and the secret iCal links of synced calendars. */
const LEFT_OUT_COLUMNS: Record<string, readonly string[]> = { files: ['data'], calendar_feeds: ['url'] };
const NAME = /^[a-z_][a-z0-9_]*$/;
const PAGE = { default: 5000, max: 10000 };
/** The most of a file one request returns: a Google Sheet can fetch up to 50 MB at a time. */
const FILE_PIECE_MAX = 40 * 1024 * 1024;

export interface BackupTable {
  name: string;
  columns: string[];
  /** the primary key, which pages are read in order of */
  key: string[];
}

/** Every table in the backup, with the columns it includes. */
export async function backupTables(db: Db): Promise<BackupTable[]> {
  const cols = await db.query<{ tbl: string; col: string }>(
    `select c.table_name as tbl, c.column_name as col
       from information_schema.columns c
       join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = current_schema() and t.table_type = 'BASE TABLE'
      order by c.table_name, c.ordinal_position`,
  );
  const keys = await db.query<{ tbl: string; col: string }>(
    `select tc.table_name as tbl, k.column_name as col
       from information_schema.table_constraints tc
       join information_schema.key_column_usage k on k.constraint_name = tc.constraint_name and k.table_schema = tc.table_schema and k.table_name = tc.table_name
      where tc.table_schema = current_schema() and tc.constraint_type = 'PRIMARY KEY'
      order by tc.table_name, k.ordinal_position`,
  );
  const tables = new Map<string, BackupTable>();
  for (const { tbl, col } of cols) {
    if (LEFT_OUT_TABLES.has(tbl) || !NAME.test(tbl) || !NAME.test(col)) continue;
    const t = tables.get(tbl) ?? { name: tbl, columns: [], key: [] };
    if (!SECRET_COLUMN.test(col) && !LEFT_OUT_COLUMNS[tbl]?.includes(col)) t.columns.push(col);
    tables.set(tbl, t);
  }
  for (const { tbl, col } of keys) tables.get(tbl)?.key.push(col);
  // a table without a primary key can't be read in pages; every table here has one, so this only guards the future
  return [...tables.values()].filter((t) => t.key.length && t.key.every((k) => t.columns.includes(k)));
}

/** One page of a table: rows as arrays in `columns` order, read in key order after `after` (the last page's last key). */
export async function backupPage(db: Db, t: BackupTable, after: (string | number)[] | null, limit: number) {
  const q = (c: string) => `"${c}"`;
  const where = after ? `where (${t.key.map(q).join(', ')}) > (${t.key.map((_, i) => `$${i + 1}`).join(', ')})` : '';
  const rows = await db.query<Record<string, unknown>>(
    `select ${t.columns.map(q).join(', ')} from ${q(t.name)} ${where} order by ${t.key.map(q).join(', ')} limit ${limit + 1}`,
    after ?? [],
  );
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    columns: t.columns,
    rows: page.map((r) => t.columns.map((c) => r[c] ?? null)),
    next: more && last ? t.key.map((k) => last[k] as string | number) : null,
  };
}

/** The key's SHA-256 matches the stored one (a key that isn't set matches nothing). */
async function keyMatches(db: Db, req: FastifyRequest): Promise<boolean> {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
  const row = await db.one<{ hash: string | null }>(`select backup_key_hash as hash from settings where id = 1`);
  if (!m || !row?.hash) return false;
  const a = Buffer.from(sha(m[1]), 'hex');
  const b = Buffer.from(row.hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

const lastSchema = z.object({
  sheetUrl: z.string().trim().max(500).optional(),
  tables: z.number().int().min(0).max(10_000),
  rows: z.number().int().min(0),
  files: z.number().int().min(0),
  filesSaved: z.number().int().min(0),
  filesWaiting: z.number().int().min(0).default(0),
  problems: z.array(z.string().trim().max(500)).max(50).default([]),
});
type LastBackup = z.infer<typeof lastSchema>;

/** Only a Google Sheets address is kept as the sheet's link (Settings opens it). */
const isSheetUrl = (v: string | undefined) => !!v && /^https:\/\/docs\.google\.com\/spreadsheets\/[\w\-/?=#&.]+$/.test(v);

interface BackupRow {
  backup_key_hash: string | null; backup_key_created_at: string | null; key_by: string | null;
  backup_last_at: string | null; backup_last: LastBackup | string | null; backup_sheet_url: string | null;
}

/** Whether backups are on (a key is set) and none has arrived for BACKUP_LATE_HOURS since the last one, or since the key was made. */
export function isBackupLate(s: { keySet: boolean; lastAt: string | null; keyCreatedAt: string | null }, now: Date): boolean {
  const since = s.lastAt ?? s.keyCreatedAt;
  return s.keySet && !!since && now.getTime() - Date.parse(since) > BACKUP_LATE_HOURS * 3600_000;
}

async function loadBackupRow(db: Db) {
  const r = await db.one<BackupRow>(
    `select s.backup_key_hash, s.backup_key_created_at, u.name as key_by, s.backup_last_at, s.backup_last, s.backup_sheet_url
       from settings s left join users u on u.id = s.backup_key_created_by where s.id = 1`,
  );
  const last = typeof r?.backup_last === 'string' ? (JSON.parse(r.backup_last) as LastBackup) : r?.backup_last ?? null;
  return {
    keySet: !!r?.backup_key_hash,
    keyCreatedAt: r?.backup_key_created_at ?? null,
    keyBy: r?.key_by ?? null,
    lastAt: r?.backup_last_at ?? null,
    last,
    sheetUrl: r?.backup_sheet_url ?? null,
  };
}

export async function backupStatus(ctx: Ctx): Promise<BackupStatus> {
  const db = ctx.db;
  const r = await loadBackupRow(db);
  const files = await db.one<{ n: number; bytes: number }>(`select count(*) as n, coalesce(sum(size), 0) as bytes from files`);
  // the database's size on disk (practice copies included); null where the engine can't say
  const size = await db.one<{ bytes: number }>(`select pg_database_size(current_database()) as bytes`).catch(() => undefined);
  const largest = await db.query<{ name: string; bytes: number }>(
    `select c.relname as name, pg_total_relation_size(c.oid) as bytes
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = current_schema() and c.relkind = 'r' order by 2 desc limit 5`,
  ).catch(() => []);
  return {
    keySet: r.keySet,
    keyCreated: r.keySet && r.keyCreatedAt ? { at: r.keyCreatedAt, byName: r.keyBy } : null,
    last: r.lastAt && r.last ? { at: r.lastAt, ...r.last } : null,
    sheetUrl: r.sheetUrl,
    late: isBackupLate(r, ctx.now()),
    database: { bytes: size?.bytes ?? null, files: files?.n ?? 0, fileBytes: files?.bytes ?? 0, largest },
  };
}

/** What the reminders run tells the Admins when backups are late, or null when they aren't. */
export async function backupLateNotice(db: Db, now: Date): Promise<{ title: string; body: string } | null> {
  const r = await loadBackupRow(db);
  if (!isBackupLate(r, now)) return null;
  return {
    title: 'The Google Sheets backup hasn’t run',
    body: r.lastAt
      ? `The last backup arrived ${fmtAgo(r.lastAt, now.getTime())}. Open the backup sheet to see why (Extensions → Apps Script → Executions), or create a new key in Settings → Backups.`
      : 'No backup has arrived since the backup key was created. Finish setting up the sheet: Settings → Backups says how.',
  };
}

export function registerBackupRoutes(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db;
  const guard = async (req: FastifyRequest) => {
    if (!(await keyMatches(db, req))) throw new HttpError(401, 'The backup key didn’t match. Create a new key in Settings → Backups and paste it into the sheet.');
  };

  // What there is to copy: every table with its columns and row count, and the uploaded files.
  app.get('/hooks/backup', async (req) => {
    await guard(req);
    const tables = await backupTables(db);
    const out = [];
    for (const t of tables) {
      const n = await db.one<{ n: number }>(`select count(*) as n from "${t.name}"`);
      out.push({ ...t, rows: n?.n ?? 0 });
    }
    const files = await db.one<{ n: number; bytes: number }>(`select count(*) as n, coalesce(sum(size), 0) as bytes from files`);
    const org = await db.one<{ org_name: string }>(`select org_name from settings where id = 1`);
    return { site: org?.org_name ?? '', at: ctx.now().toISOString(), tables: out, files: { count: files?.n ?? 0, bytes: files?.bytes ?? 0 } };
  });

  app.get('/hooks/backup/tables/:name', async (req) => {
    await guard(req);
    const { name } = parse(z.object({ name: z.string().regex(NAME, 'No such table') }), req.params);
    const q = parse(z.object({
      after: z.string().max(2000).optional(),
      limit: z.coerce.number().int().min(1).max(PAGE.max).default(PAGE.default),
    }), req.query);
    const t = (await backupTables(db)).find((x) => x.name === name);
    if (!t) throw notFound('Table');
    let after: (string | number)[] | null = null;
    if (q.after) {
      let v: unknown;
      try { v = JSON.parse(q.after); } catch { v = null; }
      const ok = z.array(z.union([z.string(), z.number()])).length(t.key.length).safeParse(v);
      if (!ok.success) throw new HttpError(400, 'Use the `next` value of the previous page as `after`');
      after = ok.data;
    }
    return backupPage(db, t, after, q.limit);
  });

  // A stored file, or one piece of it (`from` and `length`, in bytes), streamed from the database.
  app.get('/hooks/backup/files/:id', async (req, reply) => {
    await guard(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const q = parse(z.object({
      from: z.coerce.number().int().min(0).default(0),
      length: z.coerce.number().int().min(1).max(FILE_PIECE_MAX).default(FILE_PIECE_MAX),
    }), req.query);
    const f = await db.one<{ stored: number }>(`select octet_length(data) as stored from files where id = $1`, [id]);
    if (!f) throw notFound('File');
    const from = Math.min(q.from, f.stored);
    const end = Math.min(f.stored, from + q.length);
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-length', String(end - from));
    reply.header('x-file-size', String(f.stored));
    return reply.send(fileStream(db, id, end, from));
  });

  // The sheet finished: when, how much it copied, and where the sheet is.
  app.post('/hooks/backup/done', async (req) => {
    await guard(req);
    const input = parse(lastSchema, req.body);
    const { sheetUrl, ...last } = input;
    await db.query(
      `update settings set backup_last_at = $3, backup_last = $1::jsonb, backup_sheet_url = coalesce($2, backup_sheet_url) where id = 1`,
      [JSON.stringify(last), isSheetUrl(sheetUrl) ? sheetUrl : null, ctx.now().toISOString()],
    );
    return { ok: true };
  });

  // Settings → Backups (Admins). These are under /api/admin/, so they always act on the real workspace.
  app.get('/api/admin/backup', async (req): Promise<BackupStatus> => {
    requireAdmin(req, 'Only admins can see backups');
    return backupStatus(ctx);
  });

  app.post('/api/admin/backup/key', async (req): Promise<{ key: string; status: BackupStatus }> => {
    const me = requireAdmin(req, 'Only admins can change the backup key');
    if (req.recording) throw new HttpError(403, 'You’re in Recording mode, a practice copy. Turn it off to set up backups.', undefined, 'recording');
    const key = `smb_${randomBytes(32).toString('base64url')}`;
    const had = await db.one<{ hash: string | null }>(`select backup_key_hash as hash from settings where id = 1`);
    await db.query(`update settings set backup_key_hash = $1, backup_key_created_at = $3, backup_key_created_by = $2 where id = 1`, [sha(key), me.id, ctx.now().toISOString()]);
    await logActivity(db, {
      actor: me, action: 'backup.key', entityType: 'settings',
      summary: had?.hash ? 'Created a new key for the Google Sheets backup (the old one stopped working)' : 'Created the key for the Google Sheets backup',
    });
    return { key, status: await backupStatus(ctx) };
  });

  app.delete('/api/admin/backup/key', async (req): Promise<BackupStatus> => {
    const me = requireAdmin(req, 'Only admins can change the backup key');
    if (req.recording) throw new HttpError(403, 'You’re in Recording mode, a practice copy. Turn it off to change backups.', undefined, 'recording');
    const r = await db.one(`update settings set backup_key_hash = null, backup_key_created_at = null, backup_key_created_by = null where id = 1 and backup_key_hash is not null returning id`);
    if (r) await logActivity(db, { actor: me, action: 'backup.key_removed', entityType: 'settings', summary: 'Turned off the Google Sheets backup (its key no longer works)' });
    return backupStatus(ctx);
  });
}
