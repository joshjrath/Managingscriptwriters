// Settings → Timeliner: when a batch's script document is uploaded in Timeliner, the batch is marked
// delivered by itself. Here a manager connects it (once), checks Timeliner can reach the site, and picks
// the batch for any upload that couldn't be matched. It also says when the editors' videos were last read
// from Timeliner (for the Editors tab), and reads them again on request.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCheck, CircleHelp, Clapperboard, FileText, Plug, RefreshCw, Send } from 'lucide-react';
import { api, useSave } from '../api';
import type { EditingBoard, TimelinerEvent, TimelinerStatus } from '../../../shared/types';
import { fmtAgo, fmtStamp } from '../../../shared/format';
import { useDisplayTz } from './Shell';
import { Button, Chip, FormError, Panel, useToast } from './ui';

/** the permissions the Timeliner key needs (server/timeliner.ts says the same in its errors) */
const KEY_PERMISSIONS = 'Tasks (read), Projects (read), Workspace (read) and Webhooks (read & write)';

const OUTCOME: Record<TimelinerEvent['outcome'], { label: string; color: string }> = {
  delivered: { label: 'Delivered', color: 'mint' },
  unmatched: { label: 'Needs a batch', color: 'yellow' },
  nothing_approved: { label: 'Not approved yet', color: 'pink' },
  already_delivered: { label: 'Already delivered', color: 'plain' },
  ignored: { label: 'Ignored', color: 'plain' },
  test: { label: 'Test', color: 'plain' },
};

export function TimelinerPanel() {
  const toast = useToast();
  const q = useQuery({ queryKey: ['timeliner'], queryFn: () => api<TimelinerStatus>('/api/timeliner') });
  const connect = useSave(() => api<TimelinerStatus>('/api/timeliner/connect', { body: {} }), { onSuccess: () => toast('Timeliner is connected. Script documents uploaded there now mark their batch delivered.') });
  const test = useSave(() => api<TimelinerStatus>('/api/timeliner/test', { body: {} }), { onSuccess: () => toast('Timeliner reached this site') });
  const s = q.data;
  const err = connect.error ?? test.error;
  return (
    <Panel id="timeliner" title="Timeliner" sub="script documents uploaded there mark their batch delivered"
      tools={s?.keySet && s.webhookUrl ? (
        <>
          {s.connected && <Button variant="sm ghost" icon={<Send aria-hidden />} busy={test.isPending} onClick={() => test.mutate(undefined)}>Test</Button>}
          <Button variant={s.connected ? 'sm ghost' : 'sm primary'} icon={s.connected ? <RefreshCw aria-hidden /> : <Plug aria-hidden />} busy={connect.isPending} onClick={() => connect.mutate(undefined)}>
            {s.connected ? 'Reconnect' : 'Connect Timeliner'}
          </Button>
        </>
      ) : undefined}>
      {!s ? null : (
        <div className="stack s3">
          <FormError error={err} />
          {!s.keySet ? (
            <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>In Timeliner → Settings → Developers, create an API key with <b>{KEY_PERMISSIONS}</b>. Add it to the server’s environment as <b>TIMELINER_API_KEY</b>, redeploy, then connect here.</p>
          ) : !s.webhookUrl ? (
            <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>The server doesn’t know its public address. Set <b>PUBLIC_URL</b> (like https://scripts.example.com) in its environment, then connect.</p>
          ) : s.connected ? (
            <div className="banner mint" style={{ margin: 0 }}>
              <CheckCheck aria-hidden />
              <div className="txt">
                <b>Connected{s.connected.byName ? ` by ${s.connected.byName}` : ''} {fmtAgo(s.connected.at)}</b>
                <span>When a PDF or Word document is uploaded to a client’s project in Timeliner, that batch’s approved scripts are marked delivered. Videos and images are ignored.{s.testAt ? ` Last test reached this site ${fmtAgo(s.testAt)}.` : ''}</span>
              </div>
            </div>
          ) : (
            <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>The key is set. Connect to have Timeliner tell this site about uploads, and the batches deliver themselves. The key needs <b>{KEY_PERMISSIONS}</b> in Timeliner (a read-only key can’t connect, but it’s enough to read the editors’ videos).</p>
          )}
          {s.keySet && <VideosRead />}
          {s.events.length > 0 && (
            <>
              <div className="section-title" style={{ margin: '4px 0 0' }}>Recent uploads</div>
              <div className="rows">{s.events.map((e) => <EventRow key={e.id} e={e} open={s.openBatches} />)}</div>
            </>
          )}
          {s.connected && !s.events.length && <p className="muted" style={{ fontSize: 12.5, margin: 0 }}><CircleHelp size={13} aria-hidden /> Nothing has arrived yet. Uploads show here as they come in.</p>}
        </div>
      )}
    </Panel>
  );
}

/** When the editors' videos were last read from Timeliner, and a way to read them now. */
function VideosRead() {
  const toast = useToast();
  const tz = useDisplayTz();
  const board = useQuery({ queryKey: ['editing'], queryFn: () => api<EditingBoard>('/api/editing') });
  const read = useSave(() => api<EditingBoard>('/api/editing/sync', { body: {} }), {
    onSuccess: (b) => { if (b.sync.error) toast(`Couldn’t read Timeliner: ${b.sync.error}`, 'error'); else toast('Read Timeliner just now'); },
  });
  const sync = board.data?.sync;
  return (
    <div className="tl-videos">
      <div className="row-flex s2">
        <Clapperboard size={16} aria-hidden />
        <span className="txt">
          Editors’ videos: {!sync ? '…' : sync.syncedAt
            ? <span title={fmtStamp(sync.syncedAt, tz)}>read {fmtAgo(sync.syncedAt)}</span>
            : 'not read yet'}
        </span>
        <Button variant="sm ghost" icon={<RefreshCw aria-hidden />} busy={read.isPending} onClick={() => read.mutate(undefined)}>Read Timeliner now</Button>
      </div>
      {sync?.error && <p className="tl-videos-err" role="status">Couldn’t read Timeliner{sync.syncedAt ? ' just now' : ''}: {sync.error}</p>}
      {board.isError && <p className="tl-videos-err" role="status">Couldn’t load when they were last read: {board.error.message}</p>}
      <FormError error={read.error} />
    </div>
  );
}

function EventRow({ e, open }: { e: TimelinerEvent; open: TimelinerStatus['openBatches'] }) {
  const toast = useToast();
  const [batchId, setBatchId] = useState('');
  const place = useSave((id: number) => api<TimelinerStatus>(`/api/timeliner/events/${encodeURIComponent(e.id)}/assign`, { body: { batchId: id } }), {
    onSuccess: () => toast('Delivered, and that Timeliner project now goes to this batch'),
  });
  const o = OUTCOME[e.outcome];
  const needs = e.outcome === 'unmatched' || e.outcome === 'nothing_approved';
  return (
    <div className={`item${e.outcome === 'unmatched' ? ' edge-yellow' : e.outcome === 'delivered' ? ' edge-mint' : ''}`}>
      <div className="body">
        <div className="row-flex s2" style={{ flexWrap: 'nowrap' }}><FileText size={15} aria-hidden /><span className="title ellipsis">{e.fileName ?? 'A file'}</span></div>
        <div className="meta">
          {e.where && <span className="ellipsis">{e.where}</span>}
          {e.uploader && <span>by {e.uploader}</span>}
          <span>{fmtAgo(e.receivedAt)}</span>
        </div>
        {e.batch && <div className="meta"><Link className="link" to={`/batches/${e.batch.id}`}>{e.batch.clientName} · {e.batch.title}</Link>{e.detail && <span>{e.detail}</span>}</div>}
        {!e.batch && e.detail && <div className="meta"><span>{e.detail}</span></div>}
        {needs && open.length > 0 && (
          <div className="row-flex s2" style={{ marginTop: 8 }}>
            <select className="input" style={{ maxWidth: 320 }} aria-label={`Which batch is “${e.fileName ?? 'this upload'}” for?`} value={batchId} onChange={(ev) => setBatchId(ev.target.value)}>
              <option value="">Which batch is it for?</option>
              {open.map((b) => <option key={b.id} value={b.id}>{b.clientName} · {b.title} ({b.approved} approved)</option>)}
            </select>
            <Button variant="sm primary" disabled={!batchId} busy={place.isPending} onClick={() => place.mutate(Number(batchId))}>Deliver</Button>
          </div>
        )}
        <FormError error={place.error} />
      </div>
      <div className="side"><Chip color={o.color}>{o.label}</Chip></div>
    </div>
  );
}
