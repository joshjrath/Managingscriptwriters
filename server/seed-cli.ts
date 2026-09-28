// npm run seed:demo — adds demo data to DATA_DIR (default data/demo) or DATABASE_URL, only if it has no users.
import { openDb } from './db';
import { DEMO_PASSWORD, seedDemo } from './seed-demo';

const db = await openDb({ databaseUrl: process.env.DATABASE_URL, dataDir: process.env.DATA_DIR ?? 'data/demo' });
const ok = await seedDemo(db);
console.log(ok ? `Demo data added. Sign in as josh@scalemedia.demo / ${DEMO_PASSWORD}` : 'This database already has users — demo data was not added.');
await db.close();
