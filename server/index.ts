// Entry point. Reads configuration (server/config.ts), opens the database,
// creates the first manager if configured, and starts the web server and the
// reminder scheduler.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { databaseProblem, loadConfig, type Config } from './config';
import { openDb } from './db';
import { hashPassword, validatePassword } from './auth';
import { startReminderScheduler } from './reminders';
import { seedDemo } from './seed-demo';
import { claudeNotesReader } from './notes-import';
import type { Ctx } from './core';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = loadConfig(process.env, { staticDir: path.resolve(here, '../client') });

async function main() {
  const problem = databaseProblem(config);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  const db = await openDb({ databaseUrl: config.databaseUrl, dataDir: config.dataDir, ssl: config.pgSsl });
  console.log(config.databaseUrl ? 'database: PostgreSQL' : `database: embedded PGlite at ${config.dataDir}`);

  const setupHint = await bootstrapManager(db, config.manager);
  if (config.demo) {
    const seeded = await seedDemo(db);
    if (seeded) console.log('demo workspace seeded (sign in as josh@scalemedia.demo / scalemedia-demo)');
  }

  const ctx: Ctx = {
    db,
    now: () => new Date(),
    secureCookies: config.production,
    allowSetup: config.allowSetup,
    uploadLimitBytes: config.uploadLimitBytes,
    setupHint,
    // paste-notes import reads notes with Claude when an API key is configured
    notesReader: config.anthropicApiKey ? claudeNotesReader() : null,
    controlData: config.controlData,
  };
  const app = await buildApp(ctx, { staticDir: config.staticDir, logger: config.production, trustProxy: config.trustProxy });

  const stopReminders = config.remindersEnabled ? startReminderScheduler(ctx, config.reminderIntervalMinutes, (m) => console.log(m)) : () => {};

  await app.listen({ port: config.port, host: config.host });
  console.log(`Scale Media scripts listening on :${config.port}`);

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    stopReminders();
    app.close().then(() => db.close()).then(
      () => process.exit(0),
      (err: unknown) => { console.error('shutdown failed', err); process.exit(1); },
    );
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Creates the first manager from MANAGER_EMAIL / MANAGER_PASSWORD, or with
// MANAGER_RESET_PASSWORD=1 resets that account's password (creating it if
// missing). Problems are logged and returned for the sign-in page rather
// than crashing the server.
async function bootstrapManager(db: Awaited<ReturnType<typeof openDb>>, { email, password, name, reset }: Config['manager']): Promise<string | undefined> {
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
