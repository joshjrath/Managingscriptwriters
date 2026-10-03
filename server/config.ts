// Every environment variable the server reads, in one place. Read settings
// from here rather than from process.env elsewhere, and list new ones in
// .env.example. A value that doesn't parse is reported and the default is
// used, so a typo can never become, say, a reminder loop that runs every
// millisecond.

/** Where the Control Center's world comes from: the real workspace, or (only when set on the server) the simulated network. */
export type ControlData = 'simulated' | 'workspace';

export interface Config {
  /** running on a host (NODE_ENV=production, Render or Railway): needs a real database, secure cookies, no browser setup */
  production: boolean;
  /** PostgreSQL connection string; without it the embedded PGlite database in `dataDir` is used */
  databaseUrl: string | undefined;
  /** whether DATA_DIR was set explicitly (production accepts that instead of DATABASE_URL) */
  dataDirSet: boolean;
  dataDir: string;
  /** force TLS to PostgreSQL (PGSSL=1); `sslmode=require` in the URL does the same */
  pgSsl: boolean;
  /** DEMO=1: seed the sample workspace */
  demo: boolean;
  /** first-run setup from the browser: always locally, in production only with ALLOW_SETUP=1 */
  allowSetup: boolean;
  uploadLimitBytes: number;
  /** turns on Paste notes (Claude); the SDK reads the key from the environment itself */
  anthropicApiKey: string | undefined;
  controlData: ControlData;
  /** the built client; an empty STATIC_DIR (the dev runner) serves no client */
  staticDir: string | undefined;
  remindersEnabled: boolean;
  reminderIntervalMinutes: number;
  port: number;
  host: string;
  /**
   * Which proxies to believe about the client's address (sign-in throttling and the Master log use it):
   * true (the default) trusts every X-Forwarded-For hop; a number trusts that many hops from the server.
   */
  trustProxy: boolean | number;
  /** the first manager account, created when there are no users yet */
  manager: { email: string; password: string; name: string; reset: boolean };
}

/**
 * Why this process must not open a database, or null if it may: on a host, without DATABASE_URL (or a
 * DATA_DIR on a persistent volume), the embedded database would live on a temporary disk and be lost.
 */
export function databaseProblem(config: Config): string | null {
  return config.production && !config.databaseUrl && !config.dataDirSet
    ? 'DATABASE_URL is not set. In production the app needs PostgreSQL (or DATA_DIR on a persistent volume). Refusing to start so no data is lost.'
    : null;
}

const truthy = (v: string | undefined) => v === '1' || v === 'true';
const set = (v: string | undefined) => (v?.trim() ? v.trim() : undefined);

/**
 * Reads the configuration. `defaults.dataDir` lets the command-line tools keep
 * their own embedded-database folder (the demo seed uses data/demo).
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  defaults: { dataDir?: string; staticDir?: string } = {},
  warn: (msg: string) => void = (m) => console.warn(m),
): Config {
  const number = (name: string, fallback: number, min: number, max: number): number => {
    const raw = set(env[name]);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= min && n <= max) return n;
    warn(`${name}=${JSON.stringify(raw)} is not a number between ${min} and ${max}; using ${fallback}`);
    return fallback;
  };

  const control = set(env.CONTROL_CENTER_DATA);
  if (control && control !== 'simulated' && control !== 'workspace') {
    warn(`CONTROL_CENTER_DATA=${JSON.stringify(control)} is not "workspace" or "simulated"; using workspace`);
  }

  const production = env.NODE_ENV === 'production' || !!env.RENDER || !!env.RAILWAY_ENVIRONMENT;
  return {
    production,
    databaseUrl: set(env.DATABASE_URL),
    dataDirSet: !!env.DATA_DIR,
    dataDir: env.DATA_DIR || defaults.dataDir || 'data/pglite',
    pgSsl: env.PGSSL === '1',
    demo: env.DEMO === '1',
    allowSetup: !production || env.ALLOW_SETUP === '1',
    uploadLimitBytes: number('UPLOAD_LIMIT_MB', 25, 1, 1024) * 1024 * 1024,
    anthropicApiKey: set(env.ANTHROPIC_API_KEY),
    controlData: control === 'simulated' ? 'simulated' : 'workspace',
    staticDir: env.STATIC_DIR !== undefined ? env.STATIC_DIR || undefined : defaults.staticDir,
    remindersEnabled: env.REMINDERS !== 'off',
    reminderIntervalMinutes: number('REMINDER_INTERVAL_MINUTES', 10, 1, 24 * 60),
    port: number('PORT', 3001, 1, 65535),
    host: set(env.HOST) ?? '0.0.0.0',
    trustProxy: trustProxy(set(env.TRUST_PROXY), warn),
    // pasted values often carry a trailing space or newline
    manager: {
      email: env.MANAGER_EMAIL?.trim().toLowerCase() ?? '',
      password: env.MANAGER_PASSWORD?.trim() ?? '',
      name: env.MANAGER_NAME?.trim() || 'Manager',
      reset: truthy(env.MANAGER_RESET_PASSWORD),
    },
  };
}

function trustProxy(raw: string | undefined, warn: (msg: string) => void): boolean | number {
  if (raw === undefined || raw === 'true') return true;
  if (raw === 'false') return false;
  const hops = Number(raw);
  if (Number.isInteger(hops) && hops >= 0 && hops <= 10) return hops;
  warn(`TRUST_PROXY=${JSON.stringify(raw)} is not true, false or a number of proxy hops; trusting every hop`);
  return true;
}
