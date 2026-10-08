// Entry point. Reads configuration from the environment, opens the database,
// creates the first manager if configured, and starts the web server and the
// reminder scheduler.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { openDb } from './db';
import { hashPassword, validatePassword } from './auth';
import { startReminderScheduler } from './reminders';
import { startCalendarSync } from './calendar-feeds';
import { seedDemo } from './seed-demo';
import { claudeNotesReader } from './notes-import';
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

  const setupHint = await bootstrapManager(db);
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
    setupHint,
    // paste-notes import reads notes with Claude when an API key is configured
    notesReader: env.ANTHROPIC_API_KEY ? claudeNotesReader() : null,
  };
  const staticDir = env.STATIC_DIR ?? path.resolve(here, '../client');
  const app = await buildApp(ctx, { staticDir, logger: production });

  const minutes = Number(env.REMINDER_INTERVAL_MINUTES ?? 10);
  const stopReminders = env.REMINDERS === 'off' ? () => {} : startReminderScheduler(ctx, minutes, (m) => console.log(m));
  // synced calendars (Google Calendar iCal links) are re-read every 15 minutes
  const stopCalendars = env.CALENDAR_SYNC === 'off' ? () => {} : startCalendarSync(ctx, Number(env.CALENDAR_SYNC_MINUTES ?? 15), (m) => console.log(m));

  const port = Number(env.PORT ?? 3001);
  await app.listen({ port, host: env.HOST ?? '0.0.0.0' });
  console.log(`Scale Media scripts listening on :${port}`);

  const shutdown = async () => {
    stopReminders();
    stopCalendars();
    await app.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Creates the first manager from MANAGER_EMAIL / MANAGER_PASSWORD, or with
// MANAGER_RESET_PASSWORD=1 resets that account's password (creating it if
// missing). Values are trimmed: pasted variables often carry a trailing space
// or newline. Problems are logged and returned for the sign-in page rather
// than crashing the server.
async function bootstrapManager(db: Awaited<ReturnType<typeof openDb>>): Promise<string | undefined> {
  const email = env.MANAGER_EMAIL?.trim().toLowerCase() ?? '';
  const password = env.MANAGER_PASSWORD?.trim() ?? '';
  const name = env.MANAGER_NAME?.trim() || 'Manager';
  const reset = env.MANAGER_RESET_PASSWORD === '1' || env.MANAGER_RESET_PASSWORD === 'true';
  const users = await db.one<{ n: number }>(`select count(*) as n from users`);
  const empty = !users?.n;
  if (!empty && !reset) return undefined;
  if (!email || !password) {
    return empty ? 'Set MANAGER_EMAIL and MANAGER_PASSWORD in the server’s environment, then redeploy.' : undefined;
  }
  const pwErr = validatePassword(password);
  if (pwErr) {
    console.error(`manager account not ${empty ? 'created' : 'reset'}: MANAGER_PASSWORD ${pwErr.toLowerCase()}`);
    return empty ? `MANAGER_PASSWORD is too short (${pwErr.toLowerCase()}). Change it in the server’s environment, then redeploy.` : undefined;
  }
  const hash = await hashPassword(password);
  const existing = await db.one<{ id: number }>(`select id from users where lower(email) = $1`, [email]);
  if (existing) {
    await db.query(`update users set password_hash = $2, role = 'owner', active = true, removed_at = null, temp_password = null, updated_at = now() where id = $1`, [existing.id, hash]);
    await db.query(`delete from sessions where user_id = $1`, [existing.id]);
    console.log(`reset password for manager ${email} — remove MANAGER_RESET_PASSWORD now so later restarts don't reset it again`);
  } else {
    await db.query(`insert into users (email, name, role, password_hash) values ($1, $2, 'owner', $3)`, [email, name, hash]);
    console.log(`created manager account ${email}`);
  }
  return undefined;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
