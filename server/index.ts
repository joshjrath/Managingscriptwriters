// Entry point. Reads configuration from the environment, opens the database,
// creates the first manager if configured, and starts the web server and the
// reminder scheduler.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { openDb } from './db';
import { hashPassword, validatePassword } from './auth';
import { startReminderScheduler } from './reminders';
import { seedDemo } from './seed-demo';
import type { Ctx } from './core';

const env = process.env;
const production = env.NODE_ENV === 'production' || !!env.RENDER || !!env.RAILWAY_ENVIRONMENT;
const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  if (production && !env.DATABASE_URL && !env.DATA_DIR) {
    console.error('DATABASE_URL is not set. In production the app needs PostgreSQL (or DATA_DIR on a persistent volume). Refusing to start so no data is lost.');
    process.exit(1);
  }
  const dataDir = env.DATA_DIR ?? 'data/pglite';
  const db = await openDb({ databaseUrl: env.DATABASE_URL, dataDir });
  console.log(env.DATABASE_URL ? 'database: PostgreSQL' : `database: embedded PGlite at ${dataDir}`);

  const users = await db.one<{ n: number }>(`select count(*) as n from users`);
  if (!users?.n && env.MANAGER_EMAIL && env.MANAGER_PASSWORD) {
    const err = validatePassword(env.MANAGER_PASSWORD);
    if (err) throw new Error(`MANAGER_PASSWORD: ${err}`);
    await db.query(`insert into users (email, name, role, password_hash) values (lower($1), $2, 'manager', $3)`, [
      env.MANAGER_EMAIL.trim(), env.MANAGER_NAME?.trim() || 'Manager', await hashPassword(env.MANAGER_PASSWORD),
    ]);
    console.log(`created manager account ${env.MANAGER_EMAIL}`);
  }
  if (env.DEMO === '1') {
    const seeded = await seedDemo(db);
    if (seeded) console.log('demo workspace seeded (sign in as josh@scalemedia.demo / scalemedia-demo)');
  }

  const ctx: Ctx = {
    db,
    now: () => new Date(),
    secureCookies: production,
    allowSetup: !production || env.ALLOW_SETUP === '1',
    uploadLimitBytes: Number(env.UPLOAD_LIMIT_MB ?? 25) * 1024 * 1024,
  };
  const staticDir = env.STATIC_DIR ?? path.resolve(here, '../client');
  const app = await buildApp(ctx, { staticDir, logger: production });

  const minutes = Number(env.REMINDER_INTERVAL_MINUTES ?? 10);
  const stopReminders = env.REMINDERS === 'off' ? () => {} : startReminderScheduler(ctx, minutes, (m) => console.log(m));

  const port = Number(env.PORT ?? 3001);
  await app.listen({ port, host: env.HOST ?? '0.0.0.0' });
  console.log(`Scale Media scripts listening on :${port}`);

  const shutdown = async () => {
    stopReminders();
    await app.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
