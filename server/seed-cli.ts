// npm run seed:demo — adds demo data to DATA_DIR (default data/demo) or DATABASE_URL, only if it has no users.
import { loadConfig } from './config';
import { openDb } from './db';
import { DEMO_PASSWORD, seedDemo } from './seed-demo';

const config = loadConfig(process.env, { dataDir: 'data/demo' });
const db = await openDb({ databaseUrl: config.databaseUrl, dataDir: config.dataDir, ssl: config.pgSsl });
const ok = await seedDemo(db);
console.log(ok ? `Demo data added. Sign in as josh@scalemedia.demo / ${DEMO_PASSWORD}` : 'This database already has users — demo data was not added.');
await db.close();
