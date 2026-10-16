// The Google Sheet's backup script (scripts/google-sheets-backup.gs) runs at Google, not here; these are its
// rules, run as written: what a cell holds, which daily copies go to the bin, and what's left out when
// everything wouldn't fit in one sheet. Settings → Backups hands it out with the site's address and key filled in.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { scriptWithKey } from '../client/src/components/backupScript';

const source = readFileSync(path.resolve(__dirname, '../scripts/google-sheets-backup.gs'), 'utf8');
const script = vm.createContext({});
vm.runInContext(source, script);
const call = <T>(fn: string, ...args: unknown[]): T => (script[fn] as (...a: unknown[]) => T)(...args);

describe('a cell', () => {
  it('is always text, and never a formula', () => {
    expect(call('cellText_', null)).toBe('');
    expect(call('cellText_', 12)).toBe('12');
    expect(call('cellText_', false)).toBe('false');
    expect(call('cellText_', { a: [1, 2] })).toBe('{"a":[1,2]}');
    for (const f of ['=IMPORTXML("http://x")', '+1+1', '@SUM(A1)', '-HYPERLINK("x")']) expect(call('cellText_', f)).toBe(`'${f}`);
    expect(call('cellText_', '-74.0060')).toBe('-74.0060');
  });

  it('is cut to what a cell holds, and says so', () => {
    const long = call<string>('cellText_', 'x'.repeat(80_000));
    expect(long.length).toBeLessThanOrEqual(50_000);
    expect(long).toMatch(/whole on the site]$/);
    expect(call<string>('cellText_', 'y'.repeat(49_000))).toHaveLength(49_000);
  });
});

describe('daily copies', () => {
  it('each is kept a year, and the 1st of each month for good', () => {
    const names = ['Backup 2025-10-15', 'Backup 2025-10-16', 'Backup 2025-10-17', 'Backup 2024-03-01', 'Backup 2025-09-30', 'Notes', 'Backup 2026-10-16'];
    expect(call('copiesToBin_', names, '2026-10-16', 365)).toEqual(['Backup 2025-10-15', 'Backup 2025-09-30']);
  });
});

describe('a sheet’s limit', () => {
  const t = (name: string, rows: number, columns = 10) => ({ name, rows, columns: Array.from({ length: columns }, (_, i) => `c${i}`) });

  it('leaves nothing out while everything fits, counting the biggest tab twice while it’s rewritten', () => {
    expect(call('tablesToLeaveOut_', [t('clients', 100), t('activity', 400_000)], 9_500_000)).toEqual([]);
    expect(call('tablesToLeaveOut_', [t('clients', 100), t('activity', 500_000)], 9_500_000)).toEqual(['activity']);
  });

  it('leaves out the logs first, never the work itself', () => {
    const big = [t('scripts', 300_000), t('audit_log', 400_000), t('notifications', 300_000), t('activity', 100_000)];
    expect(call('tablesToLeaveOut_', big, 9_500_000)).toEqual(['audit_log', 'notifications']);
  });

  it('puts the tabs people look at first', () => {
    expect(call('orderTables_', ['work_seen', 'scripts', 'activity', 'clients', 'audit_log'])).toEqual(['clients', 'scripts', 'activity', 'audit_log', 'work_seen']);
  });
});

describe('the script Settings hands out', () => {
  it('comes with the site’s address and the key filled in, and nothing else changed', () => {
    const filled = scriptWithKey(source, 'https://scripts.example.com/', 'smb_abc-123');
    expect(filled).toContain(`const SITE = 'https://scripts.example.com';`);
    expect(filled).toContain(`const KEY = 'smb_abc-123';`);
    expect(filled.replace(`'https://scripts.example.com'`, `'__SITE_URL__'`).replace(`'smb_abc-123'`, `'__BACKUP_KEY__'`)).toBe(source);
    // and it still runs
    vm.runInContext(filled, vm.createContext({}));
  });

  it('refuses to run without them', () => {
    expect(() => call('fetch_', 'get', '/hooks/backup')).toThrow(/Copy it again from Settings → Backups/);
  });
});
