// Runs the API (tsx watch) and the Vite dev server together.
// `npm run dev`  → real workspace in data/pglite (or DATABASE_URL)
// `npm run demo` → separate demo workspace in data/demo, seeded with sample data
import { spawn } from 'node:child_process';

const env = { ...process.env, API_PORT: process.env.API_PORT ?? '3001', STATIC_DIR: '' };
if (env.DEMO === '1') env.DATA_DIR = env.DATA_DIR ?? 'data/demo';

const procs = [
  spawn('npx', ['tsx', 'watch', '--clear-screen=false', 'server/index.ts'], { stdio: 'inherit', env: { ...env, PORT: env.API_PORT } }),
  spawn('npx', ['vite'], { stdio: 'inherit', env }),
];
const stop = () => { for (const p of procs) p.kill('SIGTERM'); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => { if (code) { console.error(`process exited with ${code}`); stop(); } });
