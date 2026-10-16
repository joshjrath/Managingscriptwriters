// The Google Sheet's backup script (scripts/google-sheets-backup.gs), as Settings → Backups hands it out: with
// this site's address and the backup key filled in, so pasting it is all there is to do.

import source from '../../../scripts/google-sheets-backup.gs?raw';

const quoted = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export function scriptWithKey(script: string, site: string, key: string): string {
  return script
    .replace(`'__SITE_URL__'`, () => quoted(site.replace(/\/+$/, '')))
    .replace(`'__BACKUP_KEY__'`, () => quoted(key));
}

export const backupScript = (site: string, key: string) => scriptWithKey(source, site, key);
