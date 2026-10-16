// Settings → Backups (Admins): the nightly copy of everything to a Google Sheet. Setting it up makes a backup
// key and hands out the sheet's script with it filled in (the key is shown once); after that this says when the
// last backup arrived and what it held, warns when one is overdue, and shows how big the database is.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Check, CheckCheck, Copy, DatabaseBackup, ExternalLink, KeyRound, Power } from 'lucide-react';
import { api, useSave } from '../api';
import type { BackupStatus } from '../../../shared/types';
import { fmtAgo, fmtBytes, fmtStamp, plural } from '../../../shared/format';
import { useBoot, useDisplayTz } from './Shell';
import { backupScript } from './backupScript';
import { Button, copyText, Dialog, ErrorState, FormError, Panel, useToast } from './ui';

export function BackupsPanel() {
  const toast = useToast();
  const tz = useDisplayTz();
  const recording = !!useBoot().mode?.recording;
  const q = useQuery({ queryKey: ['backup'], queryFn: () => api<BackupStatus>('/api/admin/backup') });
  const [made, setMade] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const newKey = useSave(() => api<{ key: string; status: BackupStatus }>('/api/admin/backup/key', { body: {} }), { onSuccess: (o) => setMade(o.key) });
  const stop = useSave(() => api<BackupStatus>('/api/admin/backup/key', { method: 'DELETE' }), {
    onSuccess: () => { setStopping(false); toast('Backups to Google Sheets are off. The sheet keeps what it has.'); },
  });
  const s = q.data;
  return (
    <Panel id="backups" title="Backups" sub="everything copied to a Google Sheet every night · admin only"
      tools={s?.keySet ? (
        <>
          <Button variant="sm ghost" icon={<KeyRound aria-hidden />} busy={newKey.isPending} disabled={recording} onClick={() => newKey.mutate(undefined)}>New key</Button>
          <Button variant="sm ghost" icon={<Power aria-hidden />} disabled={recording} onClick={() => setStopping(true)}>Turn off</Button>
        </>
      ) : undefined}>
      {!s ? (q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : null) : (
        <div className="stack s3">
          <FormError error={newKey.error} />
          {!s.keySet ? (
            <>
              <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>
                The database host keeps its own backups for only 3 to 7 days. Set this up and a Google Sheet copies everything every night: a tab for every table, every uploaded file into Google Drive, and a dated copy kept for a year (the 1st of each month kept for good). Passwords, sign-ins and keys are left out.
              </p>
              <div><Button variant="primary pill" icon={<DatabaseBackup aria-hidden />} busy={newKey.isPending} disabled={recording} onClick={() => newKey.mutate(undefined)}>Set up the Google Sheets backup</Button></div>
              {recording && <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>Turn Recording mode off first: backups are of the real workspace.</p>}
            </>
          ) : s.late ? (
            <div className="banner red" style={{ margin: 0 }}>
              <AlertTriangle aria-hidden />
              <div className="txt">
                <b>{s.last ? `No backup since ${fmtAgo(s.last.at)}` : 'No backup has arrived yet'}</b>
                <span>{s.last
                  ? 'Open the sheet and check Extensions → Apps Script → Executions for what went wrong. If the key was changed since, use New key and paste the new script into the sheet.'
                  : 'Finish setting up the sheet (New key shows the steps again), or check Extensions → Apps Script → Executions in it.'}</span>
              </div>
            </div>
          ) : s.last ? (
            <div className="banner mint" style={{ margin: 0 }}>
              <CheckCheck aria-hidden />
              <div className="txt">
                <b title={fmtStamp(s.last.at, tz)}>Last backup {fmtAgo(s.last.at)}</b>
                <span>{plural(s.last.tables, 'table')} · {plural(s.last.rows, 'row')} · {s.last.filesSaved} of {plural(s.last.files, 'uploaded file')} saved in Drive{s.last.filesWaiting ? ` (${s.last.filesWaiting} still to save; tried again tonight)` : ''}</span>
              </div>
            </div>
          ) : (
            <div className="banner yellow" style={{ margin: 0 }}>
              <AlertTriangle aria-hidden />
              <div className="txt"><b>Waiting for the first backup</b><span>Paste the script into the sheet and run setUp. Lost the script? New key shows the steps again.</span></div>
            </div>
          )}
          {s.last && s.last.problems.length > 0 && (
            <ul className="muted" style={{ fontSize: 12.5, margin: 0, paddingLeft: 18 }}>{s.last.problems.map((p) => <li key={p}>{p}</li>)}</ul>
          )}
          {s.sheetUrl && <div><a className="btn sm ghost" href={s.sheetUrl} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden />Open the backup sheet</a></div>}
          {s.keyCreated && <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>Key made {fmtAgo(s.keyCreated.at)}{s.keyCreated.byName ? ` by ${s.keyCreated.byName}` : ''}.</p>}
          <Database d={s.database} />
        </div>
      )}
      {made && <SetupDialog keyText={made} onClose={() => setMade(null)} />}
      {stopping && (
        <Dialog open onClose={() => setStopping(false)} title="Turn off the Google Sheets backup?" size="narrow"
          sub="Its key stops working, so the sheet gets no more backups. What’s already in the sheet and in Drive stays. You can set it up again any time."
          footer={<div className="form-actions"><Button variant="ghost" onClick={() => setStopping(false)}>Cancel</Button><Button variant="primary pill" busy={stop.isPending} onClick={() => stop.mutate(undefined)}>Turn off</Button></div>}>
          <FormError error={stop.error} />
        </Dialog>
      )}
    </Panel>
  );
}

/** How big the database is, and what takes the room. */
function Database({ d }: { d: BackupStatus['database'] }) {
  return (
    <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
      Database: {d.bytes != null ? fmtBytes(d.bytes) : 'size unknown'}, of which {plural(d.files, 'uploaded file')} take {fmtBytes(d.fileBytes)}.
      {d.largest.length > 0 && <> Biggest tables: {d.largest.map((t) => `${t.name} ${fmtBytes(t.bytes)}`).join(', ')}.</>}
      {' '}Keep it well under your database plan’s storage: a full database stops saving.
    </p>
  );
}

function SetupDialog({ keyText, onClose }: { keyText: string; onClose: () => void }) {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const script = backupScript(window.location.origin, keyText);
  const copy = async () => setCopied((await copyText(script)) ? 'ok' : 'fail');
  return (
    <Dialog open onClose={onClose} title="Set up the Google Sheets backup" sub="The script below holds a new backup key. It’s shown only now: any older key has stopped working."
      footer={<div className="form-actions"><Button variant="ghost" onClick={onClose}>Done</Button><Button variant="primary pill" icon={copied === 'ok' ? <Check aria-hidden /> : <Copy aria-hidden />} onClick={copy}>{copied === 'ok' ? 'Copied' : 'Copy the script'}</Button></div>}>
      <div className="form">
        <ol className="howto">
          <li>Open a new Google Sheet: <a href="https://sheets.new" target="_blank" rel="noopener noreferrer">sheets.new</a> (signed in to the Google account the backups should go to). Name it, e.g. <b>Scripts backup</b>.</li>
          <li>In the sheet: <b>Extensions → Apps Script</b>. Delete what’s there, paste the script (<b>Copy the script</b> below), and click <b>Save</b>.</li>
          <li>At the top, pick <b>setUp</b> in the list of functions and click <b>Run</b>. Google asks you to allow it: choose your account → <b>Advanced</b> → <b>Go to … (unsafe)</b> → <b>Allow</b>. It’s your own script; Google asks that of every one.</li>
          <li>That’s it. It backs up now (a big first backup carries on by itself for a few minutes), then every night at about 3 am. This page shows the last one.</li>
          <li className="howto-alt">The key in the script opens a copy of everything. Share the sheet only with Admins. If it might have leaked, click <b>New key</b> here and paste the new script in.</li>
        </ol>
        <pre className="share-block" aria-label="The backup script" style={{ maxHeight: 180, overflow: 'auto', fontSize: 11.5 }}>{script}</pre>
        {copied === 'fail' && <span className="err" role="alert" style={{ color: '#FF9C94', fontSize: 12.5, fontWeight: 600 }}>Your browser blocked copying: select the script above and copy it by hand.</span>}
        {copied === 'ok' && <span className="muted" style={{ fontSize: 12.5 }} role="status">Copied to your clipboard.</span>}
      </div>
    </Dialog>
  );
}
