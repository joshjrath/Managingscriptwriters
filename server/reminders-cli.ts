// One-off reminder run for an external cron (e.g. a Railway cron service):
//   npm run reminders
import { openDb } from './db';
import { runReminders } from './reminders';

const db = await openDb({ databaseUrl: process.env.DATABASE_URL, dataDir: process.env.DATA_DIR ?? 'data/pglite' });
const result = await runReminders({ db, now: () => new Date(), secureCookies: true, allowSetup: false, uploadLimitBytes: 0 });
console.log(result.skipped ? 'another reminder run is in progress; skipped' : `reminders sent: ${result.created}`);
await db.close();
