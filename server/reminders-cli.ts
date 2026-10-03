// One-off reminder run for an external cron (e.g. a Railway cron service):
//   npm run reminders
import { databaseProblem, loadConfig } from './config';
import { openDb } from './db';
import { runReminders } from './reminders';

const config = loadConfig();
// a cron job without DATABASE_URL would otherwise remind nobody, from an empty database of its own
const problem = databaseProblem(config);
if (problem) {
  console.error(problem);
  process.exit(1);
}
// the embedded database can only be open in one process at a time, and a server using it runs reminders itself
if (!config.databaseUrl) {
  console.error('npm run reminders needs DATABASE_URL: the embedded database can only be open in one process, and the web server already sends reminders itself.');
  process.exit(1);
}
const db = await openDb({ databaseUrl: config.databaseUrl, dataDir: config.dataDir, ssl: config.pgSsl });
const result = await runReminders({ db, now: () => new Date(), secureCookies: true, allowSetup: false, uploadLimitBytes: 0 });
console.log(result.skipped ? 'another reminder run is in progress; skipped' : `reminders sent: ${result.created}`);
await db.close();
