// Settings → Timeliner: each shoot's scripts PDF in Timeliner is matched to its batch the first time it arrives
// (by a date in its name, else the shoot waiting for its scripts), and every later version of that same PDF
// follows it there and delivers whatever was approved since. Here a manager connects it (once), checks Timeliner
// can reach the site, picks the batch for any upload that couldn't be matched (the likely one comes preselected),
// moves a PDF linked to the wrong shoot (once its delivery there is undone), and sees which PDF is linked to which
// shoot. It also says when the editors' videos were last read from Timeliner (for the Editors tab), and reads them
// again on request, and sets the day the one-editor-per-client rule began (only videos made since are checked).

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCheck, CircleHelp, Clapperboard, FileText, Plug, RefreshCw, Send } from 'lucide-react';
import { api, useSave } from '../api';
import {
  TIMELINER_KEY_PERMISSIONS, type EditingBoard, type Settings, type TimelinerEvent, type TimelinerOutcome, type TimelinerPdfHow, type TimelinerPdfLink, type TimelinerStatus,
} from '../../../shared/types';
import { fmtAgo, fmtDateYear, fmtStamp } from '../../../shared/format';
import { useBoot, useDisplayTz } from './Shell';
import { Button, Chip, Field, FormError, inputProps, Panel, useFieldId, useToast } from './ui';

const OUTCOME: Record<TimelinerOutcome, { label: string; color: string }> = {
  delivered: { label: 'Delivered', color: 'mint' },
  unmatched: { label: 'Needs a batch', color: 'yellow' },
  nothing_approved: { label: 'Not approved yet', color: 'pink' },
  already_delivered: { label: 'Already delivered', color: 'plain' },
  new_version: { label: 'New version', color: 'plain' },
  ignored: { label: 'Ignored', color: 'plain' },
  test: { label: 'Test', color: 'plain' },
};

/** How a scripts PDF found its batch, in a few words. */
const HOW: Record<TimelinerPdfHow, string> = {
  name: 'named for this shoot',
  date: 'the shoot waiting for its scripts',
  earliest: 'the earliest of several shoots waiting',
  late: 'a shoot that had just happened',
  only: 'the client’s only batch waiting',
  manager: 'picked by a manager',
  backfill: 'from an earlier delivery',
};

/** Recent links shown before "Show all". */
const PDFS_SHOWN = 6;

export function TimelinerPanel() {
  const toast = useToast();
  const q = useQuery({ queryKey: ['timeliner'], queryFn: () => api<TimelinerStatus>('/api/timeliner') });
  const connect = useSave(() => api<TimelinerStatus>('/api/timeliner/connect', { body: {} }), { onSuccess: () => toast('Timeliner is connected. A shoot’s scripts PDF uploaded there now delivers its batch.') });
  const test = useSave(() => api<TimelinerStatus>('/api/timeliner/test', { body: {} }), { onSuccess: () => toast('Timeliner reached this site') });
  const s = q.data;
  const err = connect.error ?? test.error;
  return (
    <Panel id="timeliner" title="Timeliner" sub="each shoot’s scripts PDF there delivers its batch"
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
            <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>In Timeliner → Settings → Developers, create an API key with <b>{TIMELINER_KEY_PERMISSIONS}</b>. Add it to the server’s environment as <b>TIMELINER_API_KEY</b>, redeploy, then connect here.</p>
          ) : !s.webhookUrl ? (
            <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>The server doesn’t know its public address. Set <b>PUBLIC_URL</b> (like https://scripts.example.com) in its environment, then connect.</p>
          ) : s.connected ? (
            <div className="banner mint" style={{ margin: 0 }}>
              <CheckCheck aria-hidden />
              <div className="txt">
                <b>Connected{s.connected.byName ? ` by ${s.connected.byName}` : ''} {fmtAgo(s.connected.at)}</b>
                <span>When a shoot’s scripts PDF (or Word document) is uploaded to Timeliner, it’s matched to its batch once, by a date in its name, else the shoot waiting for its scripts, and that batch’s approved scripts are marked delivered. Every new version of the same PDF goes to the same batch and delivers whatever was approved since. Videos and images are ignored.{s.testAt ? ` Last test reached this site ${fmtAgo(s.testAt)}.` : ''}</span>
              </div>
            </div>
          ) : (
            <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>The key is set. Connect to have Timeliner tell this site about uploads, and each shoot’s scripts PDF delivers its batch. The key needs <b>{TIMELINER_KEY_PERMISSIONS}</b> in Timeliner (a read-only key can’t connect, but it’s enough to read the editors’ videos).</p>
          )}
          {s.keySet && <VideosRead />}
          {s.keySet && <OneEditorSince />}
          {s.events.length > 0 && (
            <>
              <div className="section-title" style={{ margin: '4px 0 0' }}>Recent uploads</div>
              <div className="rows">{s.events.map((e) => <EventRow key={e.id} e={e} open={s.openBatches} />)}</div>
            </>
          )}
          {s.connected && !s.events.length && <p className="muted" style={{ fontSize: 12.5, margin: 0 }}><CircleHelp size={13} aria-hidden /> Nothing has arrived yet. Uploads show here as they come in.</p>}
          {s.pdfs.length > 0 && <PdfLinks pdfs={s.pdfs} />}
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

/**
 * The day the team began giving each client one editor: the Editors tab checks only videos made in Timeliner since
 * then (a client split across editors, two editors on a client, whom its videos usually go to). Sends only this field.
 */
function OneEditorSince() {
  const { settings } = useBoot();
  const toast = useToast();
  const id = useFieldId('one-editor');
  const [day, setDay] = useState(settings.oneEditorSince);
  // take the saved day when it changes, but never over one being typed here
  const synced = useRef(settings.oneEditorSince);
  useEffect(() => {
    setDay((cur) => (cur === synced.current ? settings.oneEditorSince : cur));
    synced.current = settings.oneEditorSince;
  }, [settings.oneEditorSince]);
  const save = useSave((oneEditorSince: string) => api<{ settings: Settings }>('/api/settings', { method: 'PATCH', body: { oneEditorSince } }), {
    onSuccess: (out) => { synced.current = out.settings.oneEditorSince; setDay(out.settings.oneEditorSince); toast(`One editor per client since ${fmtDateYear(out.settings.oneEditorSince)}`); },
  });
  const err = !day ? 'Pick a day' : save.error?.fields.oneEditorSince;
  const dirty = day !== settings.oneEditorSince;
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); if (day && dirty) save.mutate(day); }} noValidate>
      <Field label="One editor per client since" htmlFor={id} error={err} help="Only work made in Timeliner since this day is checked against the one-editor rule">
        <div className="row-flex s2">
          <input className="input" type="date" style={{ maxWidth: 200 }} value={day} onChange={(e) => setDay(e.target.value)} {...inputProps(id, err)} />
          {dirty && <Button type="submit" variant="sm primary" disabled={!day} busy={save.isPending}>Save</Button>}
        </div>
      </Field>
      <FormError error={save.error && !save.error.fields.oneEditorSince ? save.error : null} />
    </form>
  );
}

const batchName = (b: { title: string; clientName: string }) => `${b.clientName} · ${b.title}`;

function EventRow({ e, open }: { e: TimelinerEvent; open: TimelinerStatus['openBatches'] }) {
  const toast = useToast();
  const r = e.result;
  const o = OUTCOME[r];
  // waiting for a batch: the picker is open. A scripts PDF already linked to one can be moved from a quieter
  // "Move to another batch" (once its delivery there is undone, on the batch's page)
  const needs = r === 'unmatched' || (r === 'nothing_approved' && !e.batch);
  const linked = !!e.batch && r !== 'ignored' && r !== 'test' && r !== 'unmatched';
  const [moving, setMoving] = useState(false);
  // the batch it most likely belongs to comes preselected, when it's one that can be picked
  const likely = e.suggestedBatch && open.some((b) => b.id === e.suggestedBatch!.id) ? String(e.suggestedBatch.id) : '';
  const [batchId, setBatchId] = useState(likely);
  const place = useSave((id: number) => api<TimelinerStatus>(`/api/timeliner/events/${encodeURIComponent(e.id)}/assign`, { body: { batchId: id } }), {
    onSuccess: (out, id) => {
      const b = open.find((x) => x.id === id);
      const now = out.events.find((x) => x.id === e.id);
      const name = b ? b.title : 'that batch';
      const next = 'its next versions go there by themselves';
      toast(now?.result === 'delivered' ? `Delivered. This scripts PDF is linked to ${name}, so ${next}.`
        : now?.result === 'already_delivered' ? `Linked to ${name}. Everything there was already delivered; ${next}.`
        : `Linked to ${name}. Nothing there is approved yet; each new version delivers what’s approved by then.`);
      setMoving(false);
    },
  });
  const v = e.version != null ? `v${e.version}` : null;
  const picker = open.length > 0 && (needs || moving);
  return (
    <div className={`item${r === 'unmatched' ? ' edge-yellow' : r === 'delivered' ? ' edge-mint' : ''}`}>
      <div className="body">
        <div className="row-flex s2" style={{ flexWrap: 'nowrap' }}>
          <FileText size={15} aria-hidden /><span className="title ellipsis">{e.fileName ?? 'A file'}</span>
          {v && <span className="tl-ver num">{v}</span>}
        </div>
        <div className="meta">
          {e.where && <span className="ellipsis">{e.where}</span>}
          {e.uploader && <span>by {e.uploader}</span>}
          <span>{fmtAgo(e.receivedAt)}</span>
        </div>
        {r === 'new_version' && <div className="meta"><span>New version of the scripts PDF · nothing new to deliver</span></div>}
        {e.batch && (
          <div className="meta">
            <Link className="link" to={`/batches/${e.batch.id}`}>{batchName(e.batch)}</Link>
            {r === 'nothing_approved'
              ? <span>Linked · nothing approved there yet; its next version delivers what’s approved by then</span>
              : r !== 'new_version' && e.detail && <span>{e.detail}</span>}
          </div>
        )}
        {!e.batch && e.detail && <div className="meta"><span>{e.detail}</span></div>}
        {needs && e.suggestedBatch && <div className="meta"><span>Most likely <b style={{ color: 'var(--text)' }}>{batchName(e.suggestedBatch)}</b></span></div>}
        {picker && (
          <div className="row-flex s2" style={{ marginTop: 8 }}>
            <select className="input" style={{ maxWidth: 360 }} aria-label={`Which batch is “${e.fileName ?? 'this upload'}” for?`} value={batchId} onChange={(ev) => setBatchId(ev.target.value)}>
              <option value="">Which batch is it for?</option>
              {open.filter((b) => !moving || b.id !== e.batch?.id).map((b) => (
                <option key={b.id} value={b.id}>{batchName(b)} ({b.approved} approved){e.suggestedBatch?.id === b.id ? ' · most likely' : ''}</option>
              ))}
            </select>
            <Button variant="sm primary" disabled={!batchId} busy={place.isPending} onClick={() => place.mutate(Number(batchId))}>{moving ? 'Move and deliver' : 'Link and deliver'}</Button>
            {moving && <Button variant="sm ghost" onClick={() => setMoving(false)}>Cancel</Button>}
          </div>
        )}
        {picker && (
          <p className="tl-hint">
            {moving && e.batch ? `If it delivered scripts on ${e.batch.title}, undo that delivery on its page first. ` : ''}
            Picking a batch links this scripts PDF to it: its next versions go there by themselves.
          </p>
        )}
        {linked && !moving && open.length > 0 && (
          <div style={{ marginTop: 6 }}><Button variant="sm ghost" onClick={() => { setBatchId(''); setMoving(true); }}>Move to another batch</Button></div>
        )}
        <FormError error={place.error} />
      </div>
      <div className="side"><Chip color={o.color}>{o.label}</Chip></div>
    </div>
  );
}

/** Which scripts PDF is linked to which shoot: each new version of it follows the link. */
function PdfLinks({ pdfs }: { pdfs: TimelinerPdfLink[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? pdfs : pdfs.slice(0, PDFS_SHOWN);
  return (
    <>
      <div className="section-title" style={{ margin: '4px 0 0' }}>Scripts PDFs and their shoots</div>
      <div className="rows">
        {shown.map((p) => (
          <div key={p.key} className={`item${p.gone ? ' tl-gone' : ''}`}>
            <div className="body">
              <div className="row-flex s2" style={{ flexWrap: 'nowrap' }}>
                <FileText size={15} aria-hidden /><span className="title ellipsis">{p.fileName ?? p.title ?? 'Scripts PDF'}</span>
                <span className="tl-ver num">v{p.version}</span>
              </div>
              <div className="meta">
                <Link className="link" to={`/batches/${p.batch.id}`}>{batchName(p.batch)}</Link>
                <span>{p.how === 'manager' && p.linkedBy ? `picked by ${p.linkedBy}` : HOW[p.how]}{p.sure ? '' : ' (likely)'}</span>
                <span>latest version {fmtAgo(p.latestAt)}</span>
              </div>
            </div>
            <div className="side">
              {p.gone ? <Chip color="plain">Trashed in Timeliner</Chip> : p.inReview ? <Chip color="yellow">{p.version > 1 ? 'Being reviewed again' : 'Being reviewed'}</Chip> : <Chip color="mint">Linked</Chip>}
            </div>
          </div>
        ))}
      </div>
      {pdfs.length > PDFS_SHOWN && (
        <Button variant="sm ghost" onClick={() => setAll((x) => !x)}>{all ? 'Show fewer' : `Show all ${pdfs.length}`}</Button>
      )}
    </>
  );
}
