// Every environment variable the server reads, in one place. Read settings
// from here rather than from process.env elsewhere, and list new ones in
// .env.example. A value that doesn't parse is reported and the default is
// used, so a typo can never become, say, a reminder loop that runs every
// millisecond.

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
  /** Timeliner's workspace API key (tlsk_…): with it, a script document uploaded in Timeliner marks its batch delivered */
  timelinerApiKey: string | undefined;
  /** where Timeliner's API lives (tests and staging point it elsewhere) */
  timelinerApiUrl: string;
  /** the site's public https address, for the webhook Timeliner calls (PUBLIC_URL, or the one Render sets) */
  publicUrl: string | undefined;
  /** with a Timeliner key, the editors' videos are re-read from Timeliner on a timer (TIMELINER_SYNC=off turns it off) */
  timelinerSyncEnabled: boolean;
  timelinerSyncMinutes: number;
  /** the built client; an empty STATIC_DIR (the dev runner) serves no client */
  staticDir: string | undefined;
  remindersEnabled: boolean;
  reminderIntervalMinutes: number;
  /** synced calendars are re-read on a timer (CALENDAR_SYNC=off turns it off) */
  calendarSyncEnabled: boolean;
  calendarSyncMinutes: number;
  /** let a synced calendar point at a private address (local testing only) */
  calendarAllowPrivate: boolean;
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

const set = (v: string | undefined) => (v?.trim() ? v.trim() : undefined);
const ON = new Set(['1', 'true', 'yes', 'on']);
const OFF = new Set(['0', 'false', 'no', 'off']);

/**
 * Reads the configuration. `defaults.dataDir` lets the command-line tools keep
 * their own embedded-database folder (the demo seed uses data/demo).
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  defaults: { dataDir?: string; staticDir?: string } = {},
  warn: (msg: string) => void = (m) => console.warn(m),
): Config {
  const number = (name: string, fallback: number, min: number, max: number, opts: { integer?: boolean; clamp?: boolean } = {}): number => {
    const raw = set(env[name]);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (Number.isFinite(n) && (!opts.integer || Number.isInteger(n))) {
      if (n >= min && n <= max) return n;
      // a value that's too big for what the server can handle is brought down to the most it can, rather than reset
      if (opts.clamp && n > max) { warn(`${name}=${raw} is more than ${max}; using ${max}`); return max; }
    }
    warn(`${name}=${JSON.stringify(raw)} is not ${opts.integer ? 'a whole number' : 'a number'} between ${min} and ${max}; using ${fallback}`);
    return fallback;
  };
  /** on/off settings: 1, true, yes or on, and 0, false, no or off (any case) */
  const flag = (name: string, fallback: boolean): boolean => {
    const raw = set(env[name])?.toLowerCase();
    if (raw === undefined) return fallback;
    if (ON.has(raw)) return true;
    if (OFF.has(raw)) return false;
    warn(`${name}=${JSON.stringify(env[name])} is not on or off (1/0, true/false); using ${fallback ? 'on' : 'off'}`);
    return fallback;
  };

  const production = env.NODE_ENV === 'production' || !!env.RENDER || !!env.RAILWAY_ENVIRONMENT;
  return {
    production,
    databaseUrl: set(env.DATABASE_URL),
    dataDirSet: !!env.DATA_DIR,
    dataDir: env.DATA_DIR || defaults.dataDir || 'data/pglite',
    pgSsl: flag('PGSSL', false),
    demo: flag('DEMO', false),
    allowSetup: !production || flag('ALLOW_SETUP', false),
    // files are stored in the database in pieces appended together, which gets slow and heavy for very large files
    uploadLimitBytes: number('UPLOAD_LIMIT_MB', 25, 1, 100, { clamp: true }) * 1024 * 1024,
    anthropicApiKey: set(env.ANTHROPIC_API_KEY),
    timelinerApiKey: set(env.TIMELINER_API_KEY),
    timelinerApiUrl: (set(env.TIMELINER_API_URL) ?? 'https://timeliner.io').replace(/\/+$/, ''),
    publicUrl: (set(env.PUBLIC_URL) ?? set(env.RENDER_EXTERNAL_URL))?.replace(/\/+$/, ''),
    timelinerSyncEnabled: flag('TIMELINER_SYNC', true),
    timelinerSyncMinutes: number('TIMELINER_SYNC_MINUTES', 5, 1, 24 * 60),
    staticDir: env.STATIC_DIR !== undefined ? env.STATIC_DIR || undefined : defaults.staticDir,
    remindersEnabled: flag('REMINDERS', true),
    reminderIntervalMinutes: number('REMINDER_INTERVAL_MINUTES', 10, 1, 24 * 60),
    calendarSyncEnabled: flag('CALENDAR_SYNC', true),
    calendarAllowPrivate: flag('CALENDAR_ALLOW_PRIVATE', false),
    calendarSyncMinutes: number('CALENDAR_SYNC_MINUTES', 15, 1, 24 * 60),
    port: number('PORT', 3001, 1, 65535, { integer: true }),
    host: set(env.HOST) ?? '0.0.0.0',
    trustProxy: trustProxy(set(env.TRUST_PROXY), warn),
    // pasted values often carry a trailing space or newline
    manager: {
      email: env.MANAGER_EMAIL?.trim().toLowerCase() ?? '',
      password: env.MANAGER_PASSWORD?.trim() ?? '',
      name: env.MANAGER_NAME?.trim() || 'Manager',
      reset: flag('MANAGER_RESET_PASSWORD', false),
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
