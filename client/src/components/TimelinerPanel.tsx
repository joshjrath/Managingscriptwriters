// Settings → Timeliner: when a batch's script document is uploaded in Timeliner, the batch is marked
// delivered by itself. Here a manager connects it (once), checks Timeliner can reach the site, and picks
// the batch for any upload that couldn't be matched.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCheck, CircleHelp, FileText, Plug, RefreshCw, Send } from 'lucide-react';
import { api, useSave } from '../api';
import type { TimelinerEvent, TimelinerStatus } from '../../../shared/types';
import { fmtAgo } from '../../../shared/format';
import { Button, Chip, FormError, Panel, useToast } from './ui';

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
            <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>Add <b>TIMELINER_API_KEY</b> to the server’s environment (Timeliner → Settings → Developers → Generate), redeploy, then connect here.</p>
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
            <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>The key is set. Connect to have Timeliner tell this site about uploads, and the batches deliver themselves.</p>
          )}
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
