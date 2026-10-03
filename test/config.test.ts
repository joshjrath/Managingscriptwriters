// The environment is read in one place (server/config.ts). These pin down its
// defaults and how it treats values that don't parse.

import { describe, expect, it } from 'vitest';
import { databaseProblem, loadConfig } from '../server/config';

const load = (env: Record<string, string>, defaults = {}) => {
  const warnings: string[] = [];
  const config = loadConfig(env, defaults, (m) => warnings.push(m));
  return { config, warnings };
};

describe('configuration', () => {
  it('has working defaults for local development', () => {
    const { config, warnings } = load({}, { staticDir: '/app/client' });
    expect(config).toMatchObject({
      production: false, databaseUrl: undefined, dataDirSet: false, dataDir: 'data/pglite', allowSetup: true,
      uploadLimitBytes: 25 * 1024 * 1024, controlData: 'workspace', staticDir: '/app/client',
      remindersEnabled: true, reminderIntervalMinutes: 10, port: 3001, host: '0.0.0.0', trustProxy: true,
    });
    expect(warnings).toEqual([]);
  });

  it('treats Render and Railway as production, where browser setup needs ALLOW_SETUP=1', () => {
    expect(load({ RENDER: 'true' }).config).toMatchObject({ production: true, allowSetup: false });
    expect(load({ RAILWAY_ENVIRONMENT: 'production', ALLOW_SETUP: '1' }).config).toMatchObject({ production: true, allowSetup: true });
    expect(load({ NODE_ENV: 'production' }).config.production).toBe(true);
  });

  it('falls back to the default, with a warning, when a number does not parse', () => {
    const { config, warnings } = load({ REMINDER_INTERVAL_MINUTES: 'ten', UPLOAD_LIMIT_MB: '-5', PORT: '80a' });
    // a NaN interval would run the reminders every millisecond
    expect(config.reminderIntervalMinutes).toBe(10);
    expect(config.uploadLimitBytes).toBe(25 * 1024 * 1024);
    expect(config.port).toBe(3001);
    expect(warnings).toHaveLength(3);
    expect(load({ REMINDER_INTERVAL_MINUTES: '0' }).config.reminderIntervalMinutes).toBe(10);
    expect(load({ REMINDER_INTERVAL_MINUTES: '15', UPLOAD_LIMIT_MB: '50' }).config).toMatchObject({ reminderIntervalMinutes: 15, uploadLimitBytes: 50 * 1024 * 1024 });
  });

  it('serves no client when STATIC_DIR is set but empty (the dev runner)', () => {
    expect(load({ STATIC_DIR: '' }, { staticDir: '/app/client' }).config.staticDir).toBeUndefined();
    expect(load({ STATIC_DIR: '/srv/client' }, { staticDir: '/app/client' }).config.staticDir).toBe('/srv/client');
  });

  it('trusts every proxy hop unless told how many there are', () => {
    expect(load({ TRUST_PROXY: '1' }).config.trustProxy).toBe(1);
    expect(load({ TRUST_PROXY: 'false' }).config.trustProxy).toBe(false);
    const odd = load({ TRUST_PROXY: 'render' });
    expect(odd.config.trustProxy).toBe(true);
    expect(odd.warnings).toHaveLength(1);
  });

  it('shows the simulated Control Center only when asked for exactly', () => {
    expect(load({ CONTROL_CENTER_DATA: 'simulated' }).config.controlData).toBe('simulated');
    const typo = load({ CONTROL_CENTER_DATA: 'simulate' });
    expect(typo.config.controlData).toBe('workspace');
    expect(typo.warnings).toHaveLength(1);
  });

  it('trims pasted manager values and accepts 1 or true for a password reset', () => {
    const { config } = load({ MANAGER_EMAIL: ' Josh@Scale.Test\n', MANAGER_PASSWORD: 'long-enough-pw \n', MANAGER_NAME: '  ', MANAGER_RESET_PASSWORD: 'true' });
    expect(config.manager).toEqual({ email: 'josh@scale.test', password: 'long-enough-pw', name: 'Manager', reset: true });
    expect(load({ MANAGER_RESET_PASSWORD: 'yes' }).config.manager.reset).toBe(false);
  });

  it('refuses an embedded database on a host unless DATA_DIR says where it lives', () => {
    expect(databaseProblem(load({ RENDER: 'true' }).config)).toMatch(/DATABASE_URL is not set/);
    expect(databaseProblem(load({ RENDER: 'true', DATABASE_URL: 'postgres://x/db' }).config)).toBeNull();
    expect(databaseProblem(load({ RENDER: 'true', DATA_DIR: '/var/data' }).config)).toBeNull();
    expect(databaseProblem(load({}).config)).toBeNull();
  });

  it('keeps the database settings the command-line tools rely on', () => {
    expect(load({}, { dataDir: 'data/demo' }).config.dataDir).toBe('data/demo');
    expect(load({ DATA_DIR: '/var/data', DATABASE_URL: ' postgres://x/db\n', PGSSL: '1' }).config)
      .toMatchObject({ dataDir: '/var/data', dataDirSet: true, databaseUrl: 'postgres://x/db', pgSsl: true });
  });
});
