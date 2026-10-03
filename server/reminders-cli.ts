// One-off reminder run for an external cron (e.g. a Railway cron service):
//   npm run reminders
import { loadConfig } from './config';
import { openDb } from './db';
import { runReminders } from './reminders';

const config = loadConfig();
const db = await openDb({ databaseUrl: config.databaseUrl, dataDir: config.dataDir, ssl: config.pgSsl });
const result = await runReminders({ db, now: () => new Date(), secureCookies: true, allowSetup: false, uploadLimitBytes: 0 });
console.log(result.skipped ? 'another reminder run is in progress; skipped' : `reminders sent: ${result.created}`);
await db.close();
