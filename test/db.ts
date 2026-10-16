// The database a test file runs on: embedded Postgres (PGlite) in memory by default, or a real
// PostgreSQL when TEST_DATABASE_URL is set (its public schema is wiped first, so point it at a
// throwaway database). CI runs the API suites both ways.

import pg from 'pg';
import { openDb, type Db } from '../server/db';

/**
 * Whether the tests may wipe the database at `url`: only one on this machine, or one named for tests, and
 * never the app's own DATABASE_URL. A production address pasted here by mistake would otherwise lose everything.
 */
export function wipeAllowed(url: string, appUrl = process.env.DATABASE_URL): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (appUrl && url.trim() === appUrl.trim()) return false;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const name = decodeURIComponent(u.pathname.replace(/^\//, ''));
  return ['localhost', '127.0.0.1', '::1'].includes(host) || /test/i.test(name);
}

export async function freshDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return openDb({ memory: true });
  if (!wipeAllowed(url)) {
    throw new Error('TEST_DATABASE_URL must be a throwaway database on this machine (localhost) or one with "test" in its name, and not DATABASE_URL: the tests wipe it. Nothing was touched.');
  }
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('drop schema public cascade; create schema public;');
  await c.end();
  return openDb({ databaseUrl: url });
}
