// One small query interface over two engines that speak the same SQL:
//   DATABASE_URL set → PostgreSQL through `pg` (Railway, production)
//   otherwise        → PGlite, an embedded Postgres persisted to DATA_DIR
// Both use identical migrations and queries.

import pg from 'pg';
import { MIGRATIONS } from './schema';

export interface Db {
  kind: 'postgres' | 'pglite';
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const OID = { int8: 20, numeric: 1700, date: 1082, timestamptz: 1184, timestamp: 1114 };
const iso = (v: string) => new Date(v).toISOString();

export async function openPostgres(url: string): Promise<Db> {
  const types = {
    getTypeParser(oid: number, format?: string) {
      if (oid === OID.int8) return (v: string) => Number(v);
      if (oid === OID.numeric) return (v: string) => Number(v);
      if (oid === OID.date) return (v: string) => v;
      if (oid === OID.timestamptz) return iso;
      return pg.types.getTypeParser(oid, format as 'text');
    },
  };
  const ssl = /sslmode=require/.test(url) || process.env.PGSSL === '1' ? { rejectUnauthorized: false } : undefined;
  const pool = new pg.Pool({ connectionString: url, types: types as pg.CustomTypesConfig, max: 10, ssl });

  const make = (runner: { query: pg.Pool['query'] }, inTx: boolean): Db => {
    const db: Db = {
      kind: 'postgres',
      async query(sql, params = []) {
        const res = await runner.query(sql, params as unknown[]);
        return res.rows;
      },
      async one(sql, params = []) {
        const res = await runner.query(sql, params as unknown[]);
        return res.rows[0];
      },
      async tx(fn) {
        if (inTx) return fn(db);
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const out = await fn(make(client as unknown as { query: pg.Pool['query'] }, true));
          await client.query('COMMIT');
          return out;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      },
      async close() {
        if (!inTx) await pool.end();
      },
    };
    return db;
  };
  return make(pool, false);
}

export async function openPglite(dataDir?: string): Promise<Db> {
  const { PGlite, types } = await import('@electric-sql/pglite');
  const lite = new PGlite({
    dataDir,
    parsers: {
      [types.INT8]: (v: string) => Number(v),
      [types.NUMERIC]: (v: string) => Number(v),
      [types.DATE]: (v: string) => v,
      [types.TIMESTAMPTZ]: iso,
    },
  });
  await lite.waitReady;

  type Runner = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
  const make = (runner: Runner, inTx: boolean): Db => {
    const db: Db = {
      kind: 'pglite',
      async query<T>(sql: string, params: unknown[] = []) {
        return (await runner.query(sql, params)).rows as T[];
      },
      async one<T>(sql: string, params: unknown[] = []) {
        return (await runner.query(sql, params)).rows[0] as T | undefined;
      },
      async tx(fn) {
        if (inTx) return fn(db);
        return lite.transaction(async (t) => fn(make(t as unknown as Runner, true)));
      },
      async close() {
        if (!inTx) await lite.close();
      },
    };
    return db;
  };
  return make(lite as unknown as Runner, false);
}

export async function openDb(opts: { databaseUrl?: string; dataDir?: string; memory?: boolean }): Promise<Db> {
  const db = opts.databaseUrl
    ? await openPostgres(opts.databaseUrl)
    : await openPglite(opts.memory ? undefined : opts.dataDir);
  await migrate(db);
  return db;
}

export async function migrate(db: Db): Promise<void> {
  await db.query(`create table if not exists schema_migrations (version int primary key, applied_at timestamptz not null default now())`);
  const done = new Set((await db.query<{ version: number }>(`select version from schema_migrations`)).map((r) => r.version));
  for (const [i, sql] of MIGRATIONS.entries()) {
    const version = i + 1;
    if (done.has(version)) continue;
    await db.tx(async (t) => {
      for (const stmt of splitStatements(sql)) await t.query(stmt);
      await t.query(`insert into schema_migrations (version) values ($1)`, [version]);
    });
  }
}

function splitStatements(sql: string): string[] {
  return sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
}
