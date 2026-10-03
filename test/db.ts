// The database a test file runs on: embedded Postgres (PGlite) in memory by default, or a real
// PostgreSQL when TEST_DATABASE_URL is set (its public schema is wiped first, so point it at a
// throwaway database). CI runs the API suites both ways.

import pg from 'pg';
import { openDb, type Db } from '../server/db';

export async function freshDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return openDb({ memory: true });
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('drop schema public cascade; create schema public;');
  await c.end();
  return openDb({ databaseUrl: url });
}
