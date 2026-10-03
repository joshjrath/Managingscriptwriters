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
  /**
   * The same database, but queries run in `schema` (Recording mode's practice
   * copy). Costs no extra engine: on PostgreSQL it's a tiny pool that closes
   * idle connections; on PGlite each query runs in a transaction that points at
   * the schema, on the one existing engine.
   */
  withSchema(schema: string): Promise<Db>;
}

const OID = { int8: 20, numeric: 1700, date: 1082, timestamptz: 1184, timestamp: 1114 };
const iso = (v: string) => new Date(v).toISOString();

const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;

export async function openPostgres(url: string, opts: { schema?: string; ssl?: boolean } = {}): Promise<Db> {
  const types = {
    getTypeParser(oid: number, format?: string) {
      if (oid === OID.int8) return (v: string) => Number(v);
      if (oid === OID.numeric) return (v: string) => Number(v);
      if (oid === OID.date) return (v: string) => v;
      if (oid === OID.timestamptz) return iso;
      return pg.types.getTypeParser(oid, format as 'text');
    },
  };
  // TLS: an sslmode in DATABASE_URL takes precedence over this option in pg (and, with pg 8, means a
  // verified certificate); PGSSL=1 without one turns TLS on without checking the certificate.
  const ssl = opts.ssl ? { rejectUnauthorized: false } : undefined;
  if (opts.schema && !SCHEMA_NAME.test(opts.schema)) throw new Error('bad schema name');
  // Each open connection costs memory on the database server (a 256 MB plan on
  // Render), so keep pools small and let idle connections go.
  const pool = new pg.Pool({
    connectionString: url, types: types as pg.CustomTypesConfig, ssl,
    ...(opts.schema
      ? { max: 2, idleTimeoutMillis: 5_000, options: `-c search_path=${opts.schema}` }
      : { max: 6, idleTimeoutMillis: 30_000 }),
  });
  // A connection dropped by the database (a restart, a failover, a proxy timing out idle
  // connections) is reported here; without a listener Node treats it as fatal and exits.
  // The pool discards the broken connection and opens a new one when needed.
  pool.on('error', (err) => console.warn(`postgres: idle connection lost: ${err.message}`));

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
        // a connection lost mid-transaction fails the pending query (so the transaction fails as usual); this keeps it from also crashing the process
        const lost = (err: Error) => console.warn(`postgres: connection lost in a transaction: ${err.message}`);
        client.on('error', lost);
        try {
          await client.query('BEGIN');
          const out = await fn(make(client as unknown as { query: pg.Pool['query'] }, true));
          await client.query('COMMIT');
          return out;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.removeListener('error', lost);
          client.release();
        }
      },
      async close() {
        if (!inTx) await pool.end();
      },
      withSchema: (schema) => openPostgres(url, { schema, ssl: opts.ssl }),
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
      withSchema: async (schema) => scoped(schema),
    };
    return db;
  };
  // Every query runs in a transaction that points at `schema`; `set local` ends with it.
  const scoped = (schema: string): Db => {
    if (!SCHEMA_NAME.test(schema)) throw new Error('bad schema name');
    const enter = `set local search_path = ${schema}`;
    const run = <T>(fn: (t: Runner) => Promise<T>) => lite.transaction(async (t) => { await t.query(enter); return fn(t as unknown as Runner); });
    return {
      kind: 'pglite',
      query: async <T>(sql: string, params: unknown[] = []) => run(async (t) => (await t.query(sql, params)).rows as T[]),
      one: async <T>(sql: string, params: unknown[] = []) => run(async (t) => (await t.query(sql, params)).rows[0] as T | undefined),
      tx: (fn) => run((t) => fn(make(t, true))),
      close: async () => {},
      withSchema: async (other) => scoped(other),
    };
  };
  return make(lite as unknown as Runner, false);
}

export async function openDb(opts: { databaseUrl?: string; dataDir?: string; memory?: boolean; ssl?: boolean }): Promise<Db> {
  const db = opts.databaseUrl
    ? await openPostgres(opts.databaseUrl, { ssl: opts.ssl })
    : await openPglite(opts.memory ? undefined : opts.dataDir);
  await migrate(db);
  return db;
}

/** Advisory lock ids (pg_advisory_xact_lock), one per job that must never run twice at once. Keep them unique. */
export const LOCKS = {
  /** a reminders run (in-process scheduler or the cron), across every instance */
  reminders: 724001,
  /** first-run setup, so two people can't both create the first admin */
  setup: 724002,
  /** applying a migration, so processes starting together (web replicas, the web server and the cron) take turns */
  migrations: 724003,
} as const;

export async function migrate(db: Db): Promise<void> {
  await db.query(`create table if not exists schema_migrations (version int primary key, applied_at timestamptz not null default now())`);
  const done = new Set((await db.query<{ version: number }>(`select version from schema_migrations`)).map((r) => r.version));
  for (const [i, sql] of MIGRATIONS.entries()) {
    const version = i + 1;
    if (done.has(version)) continue;
    await db.tx(async (t) => {
      await t.query(`select pg_advisory_xact_lock(${LOCKS.migrations})`);
      // another process may have applied it while this one waited for the lock
      if (await t.one(`select 1 from schema_migrations where version = $1`, [version])) return;
      if (typeof sql === 'function') await sql(t);
      else for (const stmt of splitStatements(sql)) await t.query(stmt);
      await t.query(`insert into schema_migrations (version) values ($1)`, [version]);
    });
  }
}

function splitStatements(sql: string): string[] {
  return sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
}
