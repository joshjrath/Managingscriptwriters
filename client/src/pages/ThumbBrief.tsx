// One thumbnail brief, built from GET /api/thumbnails/:id (ThumbnailBriefDetail in shared/types.ts).
// - Its designer (/studio/briefs/:id) gets the workbench: the brief and the client's look on one side; on the
//   other the private draft tray (A–F), filled by dropping an image anywhere on the page, pasting it or choosing
//   it, each option with its quick checks and a one-line "why this one", then "Send round N (k options)". A
//   manager's note asking for changes sits on top, next to the round being drafted.
// - A manager (/thumbnails/:id) gets the review: the newest round sent, its options side by side at full size,
//   "Pick B" with an optional reason or "Ask for changes" with a required note, and Decide again until the
//   designer sends another round. A newer round sent meanwhile is a 409 "stale": a toast, and the page refreshes.
//   Unsent options never reach a manager. The winner downloads at full quality.
// - A designer the brief was taken from reads the rounds they sent.
// Everyone gets Preview in the wild (every option at feed sizes, beside the client's recent winners) and the
// round film strip.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Ban, Check, Download, Eye, Image as ImageIcon, Pencil, RotateCcw, Send, Sparkles, Trash2, Undo2 } from 'lucide-react';
import { api, useSave, type ApiError } from '../api';
import type { ThumbnailBriefDetail, ThumbnailDecision, ThumbnailDecisionInput, ThumbnailOption, ThumbnailRound } from '../../../shared/types';
import { isOpenThumb, MAX_OPTIONS, OPTION_LETTERS, THUMB_MIME_LABEL } from '../../../shared/workflow';
import { fmtAgo, plural } from '../../../shared/format';
import { PageHeader, useBoot } from '../components/Shell';
import { Button, Dialog, Empty, ErrorState, Field, FormError, inputProps, Loading, NotFound, Seg, Thumb, useFieldId, useToast } from '../components/ui';
import {
  BriefCard, ClientLook, DropZone, EmptySlot, OptionSlot, optionAlt, PendingSlot, pictureType, PreviewInTheWild, readPicture, RoundStrip, StateChip, DueTag,
  type DropZoneHandle, type PendingStatus, type Picture, type WildItem,
} from '../components/ThumbBits';
import { useNow } from '../components/EditingBits';
import { burst, centerOf, plane } from '../fx';
import { BriefDialog, CancelBriefDialog, useReopenBrief } from './Thumbnails';

export function ThumbBriefPage() {
  const { id } = useParams();
  const bad = !/^\d+$/.test(id ?? '');
  // a minute's refresh, so a round sent (or a decision made) elsewhere shows up without a reload
  const q = useQuery({ queryKey: ['thumbnail', Number(id)], queryFn: () => api<ThumbnailBriefDetail>(`/api/thumbnails/${id}`), enabled: !bad, refetchInterval: 60_000 });
  if (bad || (q.error as ApiError | null)?.status === 404) return <NotFound what="brief" />;
  if (q.isLoading) return <div className="studio"><div style={{ height: 90 }} /><Loading height={520} /></div>;
  if (q.isError && !q.data) return <div className="studio"><ErrorState error={q.error} retry={() => q.refetch()} /></div>;
  return <Workbench key={q.data!.id} d={q.data!} />;
}

type Tab = 'work' | 'wild';

function Workbench({ d }: { d: ThumbnailBriefDetail }) {
  const { clock } = useBoot();
  const now = useNow();
  const manager = d.viewer === 'manager';
  const designer = d.viewer === 'designer';
  const [tab, setTab] = useState<Tab>('work');
  const [pick, setPick] = useState<string | null>(null);
  const [edit, setEdit] = useState<null | 'all' | 'designer'>(null);
  const [cancelling, setCancelling] = useState(false);
  const reopen = useReopenBrief();
  const tray = useTray(d);
  const latest = d.rounds[d.rounds.length - 1] ?? null;
  const preview = (key: string) => { setPick(key); setTab('wild'); };

  // what Preview in the wild shows: the tray (and images not added yet) while drafting, else the newest round sent
  const fromOptions = (list: ThumbnailOption[]): WildItem[] => list.map((o) => ({ key: String(o.id), letter: o.letter, src: o.url, alt: optionAlt(o, d.title) }));
  const trayItems = designer ? [...fromOptions(d.tray?.options ?? []), ...tray.pending.filter((p) => p.pic?.src).map((p) => ({ key: p.key, letter: p.letter, src: p.pic!.src, alt: `New option ${p.letter}` }))] : [];
  const wildItems = trayItems.length ? trayItems : fromOptions(d.winner ? [d.winner, ...(latest?.options ?? []).filter((o) => o.id !== d.winner!.id)] : latest?.options ?? []);

  const crumbs = manager
    ? <><Link to="/thumbnails">Thumbnails</Link><span aria-hidden>›</span><span>{d.clientName}</span></>
    : <><Link to="/studio">Studio</Link><span aria-hidden>›</span><span>{d.clientName}</span></>;
  const tools: ReactNode = manager ? (
    <>
      {d.winner && <a className="btn mint pill" href={`${d.winner.url}?download=1`} download={d.winner.fileName}><Download aria-hidden />Download {d.winner.letter}</a>}
      {d.can.edit && <Button variant="pill" icon={<Pencil aria-hidden />} onClick={() => setEdit('all')}>Edit</Button>}
      {d.designerId && !d.needsDesigner && <Link className="btn ghost pill" to={`/studio?userId=${d.designerId}`}>{d.designerName}’s Studio<ArrowRight aria-hidden /></Link>}
    </>
  ) : d.winner ? <a className="btn mint pill" href={`${d.winner.url}?download=1`} download={d.winner.fileName}><Download aria-hidden />Download {d.winner.letter}</a> : null;

  const workLabel = designer ? (isOpenThumb(d.state) ? `Round ${d.nextRound} · your tray` : 'Your rounds') : latest ? `Round ${latest.number}` : 'Options';
  return (
    // a manager's review puts the round first whenever the columns stack: it's what they came to decide on
    <div className={`studio tb${manager ? ' review' : ''}`}>
      <PageHeader title={d.title} crumbs={crumbs} hideNewWork
        sub={<span className="row-flex s2"><StateChip brief={d} /><DueTag dueOn={d.dueOn} today={clock.today} state={d.state} />{d.roundsSent > 0 && <span className="muted">{plural(d.roundsSent, 'round')} sent</span>}</span>}>
        {tools}
      </PageHeader>

      <TopNote d={d} now={now} onReopen={manager && d.can.edit ? () => reopen.mutate(d.id) : undefined} reopening={reopen.isPending} />

      <div className="tb-work">
        <div className="tb-side">
          <BriefCard brief={d} today={clock.today}
            tools={manager && d.can.edit ? (
              <div className="tb-brief-tools">
                <Button variant="sm ghost" icon={<Pencil aria-hidden />} onClick={() => setEdit('all')}>Edit brief</Button>
                {isOpenThumb(d.state) && <Button variant="sm ghost" onClick={() => setEdit('designer')}>{d.needsDesigner ? 'Choose a designer' : 'Reassign'}</Button>}
                {/* as on the board: only an open brief can be cancelled (a pick is its outcome), and a cancelled one reopened */}
                {isOpenThumb(d.state)
                  ? <Button variant="sm ghost" icon={<Ban aria-hidden />} onClick={() => setCancelling(true)}>Cancel brief</Button>
                  : d.state === 'cancelled' && <Button variant="sm ghost" icon={<Undo2 aria-hidden />} busy={reopen.isPending} onClick={() => reopen.mutate(d.id)}>Reopen</Button>}
              </div>
            ) : undefined} />
          <ClientLook look={d.look} />
        </div>
        <section className="panel tb-main" aria-label={tab === 'work' ? workLabel : 'Preview in the wild'}>
          <div className="tb-tabs">
            <Seg role="group" aria-label="Show">
              <button type="button" aria-pressed={tab === 'work'} onClick={() => setTab('work')}>{workLabel}</button>
              <button type="button" aria-pressed={tab === 'wild'} onClick={() => setTab('wild')}><Eye aria-hidden />Preview in the wild</button>
            </Seg>
          </div>
          {/* both stay mounted, so the tray keeps taking dropped and pasted images while the preview is showing */}
          <div className="tb-pane" hidden={tab !== 'work'}>
            {designer ? <Tray d={d} t={tray} now={now} onFiles={(files) => { setTab('work'); tray.add(files); }} onPreview={preview} />
              : manager ? <Review d={d} round={latest} onPreview={preview} now={now} />
              : <PastDesigner d={d} />}
          </div>
          <div className="tb-pane" hidden={tab !== 'wild'}>
            <PreviewInTheWild items={wildItems} pick={pick} onPick={setPick} title={d.title} clientName={d.clientName} winners={d.recentWinners} />
          </div>
        </section>
      </div>

      <RoundStrip rounds={d.rounds} tray={designer ? d.tray : null} title={d.title} nextRound={d.nextRound} now={now} />

      {edit && <BriefDialog brief={d} focus={edit === 'designer' ? 'designer' : undefined} onClose={() => setEdit(null)} />}
      {cancelling && <CancelBriefDialog brief={d} onClose={() => setCancelling(false)} />}
    </div>
  );
}

/** The one thing to know first: a manager's note asking for changes, the pick, a round waiting, a cancelled or moved brief. */
function TopNote({ d, now, onReopen, reopening }: { d: ThumbnailBriefDetail; now: number; onReopen?: () => void; reopening: boolean }) {
  const { me } = useBoot();
  const dec = d.decision;
  const latest = d.rounds[d.rounds.length - 1] ?? null;
  if (d.state === 'cancelled') {
    return (
      <div className="banner tb-banner"><Ban aria-hidden /><div className="txt"><b>This brief was cancelled{d.cancelledAt ? ` ${fmtAgo(d.cancelledAt, now)}` : ''}</b><span>Its rounds stay here as history.</span></div>
        {onReopen && <Button variant="sm" icon={<Undo2 aria-hidden />} busy={reopening} onClick={onReopen}>Reopen</Button>}
      </div>
    );
  }
  if (d.viewer === 'past_designer') {
    return <div className="banner tb-banner"><RotateCcw aria-hidden /><div className="txt"><b>{d.needsDesigner ? 'This brief is waiting for a new designer' : `This brief is now with ${d.designerName}`}</b><span>You can still see the rounds you sent.</span></div></div>;
  }
  // a manager sees their own note with the round, under Round N
  if (d.state === 'changes' && dec && latest && d.viewer === 'designer') return <ChangesNote dec={dec} round={latest} title={d.title} now={now} nextRound={d.nextRound} />;
  if (d.state === 'picked' && d.winner) {
    // the win goes on the wall of whoever made it, who may not be the brief's designer now
    const mine = d.winner.uploadedById === me.id;
    const tail = d.viewer !== 'designer' ? ' · download it at full quality and post it yourself' : mine ? ' · it’s on your wall of wins' : ` · it’s on ${d.winner.uploadedByName}’s wall of wins`;
    return (
      <div className="tb-picked">
        <div className="tb-picked-pic"><Thumb src={d.winner.url} alt={optionAlt(d.winner, d.title)} eager><span className="thumb-letter" aria-hidden>{d.winner.letter}</span></Thumb></div>
        <div className="tb-picked-txt">
          <span className="eh-badge"><Sparkles aria-hidden />Picked</span>
          <b>{d.viewer === 'designer' ? `${mine ? 'Option' : `${d.winner.uploadedByName}’s option`} ${d.winner.letter} was picked` : `${dec?.decidedByName ?? 'A manager'} picked option ${d.winner.letter}`}</b>
          {dec?.note && <q>{dec.note}</q>}
          <span className="tb-picked-by">{dec ? `${dec.decidedByName} · ${fmtAgo(dec.createdAt, now)}` : ''}{tail}</span>
        </div>
      </div>
    );
  }
  if (d.state === 'in_review' && latest && d.viewer === 'designer') {
    return <div className="banner lavender tb-banner"><Send aria-hidden /><div className="txt"><b>Round {latest.number} is with the managers</b><span>You can line up the next round meanwhile. Sending it replaces round {latest.number} in their queue.</span></div></div>;
  }
  return null;
}

/** The manager's note, on top of the round it was asked on, so the next round starts beside it. */
function ChangesNote({ dec, round, title, now, nextRound }: { dec: ThumbnailDecision; round: ThumbnailRound; title: string; now: number; nextRound: number }) {
  return (
    <div className="tb-changes">
      <div className="tb-changes-pics">
        {round.options.slice(0, 3).map((o) => <span key={o.id}><Thumb src={o.url} alt={optionAlt(o, title)}><span className="thumb-letter" aria-hidden>{o.letter}</span></Thumb></span>)}
      </div>
      <figure className="tb-changes-note">
        <span className="tb-changes-k"><RotateCcw aria-hidden />Changes asked on round {round.number}</span>
        <blockquote>{dec.note}</blockquote>
        <figcaption>{dec.decidedByName} · {fmtAgo(dec.createdAt, now)} · round {nextRound} starts below</figcaption>
      </figure>
    </div>
  );
}

// ── the designer's tray ──────────────────────────────────────────────────

interface Pending { key: string; file: File; pic: Picture | null; note: string; status: PendingStatus; error: string | null }

/** Images dropped, pasted or chosen, then added to the tray one upload at a time, in order. */
function useTray(d: ThumbnailBriefDetail) {
  const toast = useToast();
  const { uploadLimitMb } = useBoot();
  const [list, setList] = useState<Pending[]>([]);
  const patch = (key: string, p: Partial<Pending>) => setList((all) => all.map((x) => (x.key === key ? { ...x, ...p } : x)));
  const upload = useSave((p: Pending) => {
    const form = new FormData();
    if (p.note.trim()) form.set('note', p.note.trim());
    form.set('file', p.file, p.file.name || 'option.png');
    return api<ThumbnailBriefDetail>(`/api/thumbnails/${d.id}/options`, { form });
  }, {
    onSuccess: (out, p) => {
      setList((all) => all.filter((x) => x.key !== p.key));
      const added = (out.tray?.options ?? []).reduce<ThumbnailOption | null>((a, o) => (!a || o.id > a.id ? o : a), null);
      toast(added ? `Option ${added.letter} is in your tray` : 'Added to your tray');
    },
  });
  // one upload at a time, in the order they were added
  const busy = upload.isPending;
  const { mutate } = upload;
  useEffect(() => {
    if (busy) return;
    const next = list.find((x) => x.status === 'waiting');
    if (!next) return;
    const mark = (p: Partial<Pending>) => setList((all) => all.map((x) => (x.key === next.key ? { ...x, ...p } : x)));
    mark({ status: 'uploading', error: null });
    mutate(next, { onError: (err) => mark({ status: 'error', error: err.message }) });
  }, [list, busy, mutate]);

  const used = (d.tray?.options ?? []).map((o) => o.letter as string);
  const free = OPTION_LETTERS.filter((l) => !used.includes(l));
  // the letter each image will get: the tray's free letters, in order
  const pending = list.map((x, i) => ({ ...x, letter: free[i] ?? '?' }));
  const room = MAX_OPTIONS - used.length - list.length;

  const add = (files: File[]) => {
    if (!d.can.upload) { toast(isOpenThumb(d.state) ? `Your tray is full: a round holds ${MAX_OPTIONS} options.` : 'This brief is closed, so nothing more can be added.', 'error'); return; }
    const ok: File[] = [];
    for (const f of files) {
      if (!pictureType(f)) { toast(`${f.name || 'That file'} isn’t a PNG, JPG or WebP, so it can’t be an option.`, 'error'); continue; }
      if (f.size > uploadLimitMb * 1024 * 1024) { toast(`${f.name} is over the site’s ${uploadLimitMb} MB upload limit.`, 'error'); continue; }
      ok.push(f);
    }
    const take = ok.slice(0, Math.max(0, room));
    if (ok.length > take.length) toast(`A round holds up to ${MAX_OPTIONS} options${take.length ? `, so ${plural(ok.length - take.length, 'image')} ${ok.length - take.length === 1 ? 'was' : 'were'} left out` : ''}.`, 'error');
    if (!take.length) return;
    const items: Pending[] = take.map((file) => ({ key: `p${Date.now()}-${Math.random().toString(36).slice(2)}`, file, pic: null, note: '', status: 'reading', error: null }));
    setList((all) => [...all, ...items]);
    for (const it of items) {
      void readPicture(it.file).then((pic) => setList((all) => all.map((x) => (x.key === it.key ? { ...x, pic, status: x.status === 'reading' ? 'staged' : x.status } : x))));
    }
  };
  return {
    pending,
    room,
    add,
    note: (key: string, note: string) => patch(key, { note }),
    queue: (key: string) => patch(key, { status: 'waiting', error: null }),
    queueAll: () => setList((all) => all.map((x) => (x.status === 'staged' || x.status === 'error' ? { ...x, status: 'waiting', error: null } : x))),
    discard: (key: string) => setList((all) => all.filter((x) => x.key !== key)),
  };
}
type TrayState = ReturnType<typeof useTray>;

function Tray({ d, t, now, onFiles, onPreview }: { d: ThumbnailBriefDetail; t: TrayState; now: number; onFiles: (files: File[]) => void; onPreview: (key: string) => void }) {
  const { me } = useBoot();
  const toast = useToast();
  const dz = useRef<DropZoneHandle>(null);
  const [sending, setSending] = useState(false);
  const [confirm, setConfirm] = useState<number | null>(null);
  useEffect(() => { if (confirm == null) return; const x = setTimeout(() => setConfirm(null), 4000); return () => clearTimeout(x); }, [confirm]);
  const remove = useSave((o: ThumbnailOption) => api<ThumbnailBriefDetail>(`/api/thumbnail-options/${o.id}`, { method: 'DELETE' }), {
    onSuccess: (_out, o) => { setConfirm(null); toast(`Option ${o.letter} is out of your tray`); },
  });
  const options = d.tray?.options ?? [];
  const open = isOpenThumb(d.state);
  if (!open) {
    const done = d.winner?.uploadedById === me.id ? 'The picked option is on your wall of wins. Every round you sent is below.' : 'An option was picked, so nothing more is needed on it. Its rounds are below.';
    return <Empty boxed icon={<ImageIcon />} title={d.state === 'picked' ? 'This one’s done' : 'This brief was cancelled'}>{d.state === 'picked' ? done : 'Nothing more can be sent on it. Its rounds stay below.'}</Empty>;
  }
  const staged = t.pending.filter((p) => p.status === 'staged' || p.status === 'error');
  const moving = t.pending.filter((p) => p.status !== 'staged' && p.status !== 'error');
  const wanted = Math.min(MAX_OPTIONS, Math.max(1, d.optionsWanted));
  const empties = OPTION_LETTERS.filter((l) => !options.some((o) => o.letter === l) && !t.pending.some((p) => p.letter === l)).slice(0, Math.max(0, wanted - options.length - t.pending.length));
  // nothing lined up yet: the letters wanted as short tiles (the drop zone below says how to add images); once
  // something is in, at most one empty frame beside it, so the round reads as a row of options
  const nothing = !options.length && !t.pending.length;
  // the round with the managers, while the tray is empty: the designer's own work, read-only and at a useful size
  const latest = d.rounds[d.rounds.length - 1] ?? null;
  const waiting = d.state === 'in_review' && nothing && latest?.options.length ? latest : null;
  const k = options.length;
  const why = !k ? 'Add at least one option to send a round.'
    : staged.length ? `Add or discard the ${plural(staged.length, 'image')} above first.`
    : moving.length ? 'Waiting for the uploads to finish.' : null;
  const next = t.pending.length < MAX_OPTIONS - k ? (OPTION_LETTERS.filter((l) => !options.some((o) => o.letter === l))[t.pending.length] ?? null) : null;
  const blocked = t.room <= 0 ? `Your tray is full: a round holds ${MAX_OPTIONS} options` : null;
  return (
    <div className="tb-tray">
      {waiting && (
        <section className="tb-review tb-waiting" aria-label={`Round ${waiting.number}, with the managers`}>
          <div className="tb-round-head">
            <b>Round {waiting.number} · with the managers</b>
            <span className="muted">{waiting.sentAt ? `sent ${fmtAgo(waiting.sentAt, now)}` : ''}</span>
          </div>
          {waiting.note && <blockquote className="tb-quote">{waiting.note}<span>Your note to the managers</span></blockquote>}
          <div className={`tb-sbs c${Math.min(3, waiting.options.length)}`}>
            {waiting.options.map((o, i) => (
              <OptionSlot key={o.id} option={o} title={d.title} fit="contain" eager={i < 3}
                actions={<Button variant="sm ghost" icon={<Eye aria-hidden />} onClick={() => onPreview(String(o.id))} aria-label={`Preview option ${o.letter} in the wild`}>Preview</Button>} />
            ))}
          </div>
        </section>
      )}
      {waiting && <h3 className="tb-next-h">Round {d.nextRound} · your tray</h3>}
      <div className="tb-tray-head">
        <p className="muted">Private until you send it. {d.optionsWanted === 1 ? 'The brief asks for 1 option.' : `The brief asks for ${d.optionsWanted} options.`}{k > 0 && k < d.optionsWanted ? ` You have ${k} so far.` : ''}</p>
        {staged.length > 1 && <Button variant="sm" icon={<Check aria-hidden />} onClick={t.queueAll}>Add all {staged.length}</Button>}
      </div>
      {nothing ? empties.length > 0 && (
        <ul className="tb-empties" aria-label={`Options wanted: ${empties.join(', ')}`}>
          {empties.map((l) => <li key={l}><EmptySlot letter={l} compact onPick={() => dz.current?.open()} disabled={!!blocked} /></li>)}
        </ul>
      ) : (
        <div className="tb-slots">
          {options.map((o, i) => (
            <OptionSlot key={o.id} option={o} title={d.title} eager={i < 3}
              actions={(
                <>
                  <Button variant="sm ghost" icon={<Eye aria-hidden />} onClick={() => onPreview(String(o.id))} aria-label={`Preview option ${o.letter} in the wild`}>Preview</Button>
                  {confirm === o.id
                    ? <Button variant="sm danger" icon={<Trash2 aria-hidden />} busy={remove.isPending && remove.variables?.id === o.id} onClick={() => remove.mutate(o, { onError: (err) => toast(err.message, 'error') })}>Remove {o.letter}?</Button>
                    : <Button variant="sm ghost" icon={<Trash2 aria-hidden />} onClick={() => setConfirm(o.id)} aria-label={`Remove option ${o.letter}`}>Remove</Button>}
                </>
              )} />
          ))}
          {t.pending.map((p) => (
            <PendingSlot key={p.key} letter={p.letter} name={p.file.name || 'Pasted image'} pic={p.pic} status={p.status} note={p.note} error={p.error}
              onNote={(n) => t.note(p.key, n)} onAdd={() => t.queue(p.key)} onDiscard={() => t.discard(p.key)} onPreview={() => onPreview(p.key)} />
          ))}
          {empties.slice(0, 1).map((l) => <EmptySlot key={l} letter={l} onPick={() => dz.current?.open()} disabled={!!blocked} />)}
        </div>
      )}
      <DropZone ref={dz} onFiles={onFiles} next={next} blocked={blocked} />
      <div className="tb-sendbar">
        <Button variant="primary pill eh-btn xl" icon={<Send aria-hidden />} disabled={!d.can.send || !!why} onClick={() => setSending(true)}>
          Send round {d.nextRound} ({plural(k, 'option')})
        </Button>
        <span className="muted">{why ?? (d.state === 'in_review' ? `Round ${d.roundsSent} is still waiting: this one replaces it.` : 'Nothing reaches a manager until you send.')}</span>
      </div>
      {sending && <SendDialog d={d} options={options} onClose={() => setSending(false)} />}
    </div>
  );
}

function SendDialog({ d, options, onClose }: { d: ThumbnailBriefDetail; options: ThumbnailOption[]; onClose: () => void }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const nid = useFieldId('send-note');
  const btn = useRef<HTMLButtonElement>(null);
  const from = useRef<{ x: number; y: number } | null>(null);
  const n = d.nextRound;
  const k = options.length;
  const send = useSave((v: { note: string }) => api<ThumbnailBriefDetail>(`/api/thumbnails/${d.id}/send`, { body: { note: v.note.trim() || null } }), {
    onSuccess: () => {
      if (from.current) plane(from.current);
      toast(`Round ${n} sent: ${plural(k, 'option')}. The managers are told.`);
      onClose();
    },
  });
  const submit = () => {
    from.current = centerOf(btn.current);
    // already sent (another tab, a double tap): say so; the page refreshes to it (useSave refetches on a 409)
    send.mutate({ note }, { onError: (e) => { if (e.status === 409) { toast(e.message, 'error'); onClose(); } } });
  };
  return (
    <Dialog open onClose={onClose} size="narrow" title={`Send round ${n}`} sub={`${k === 1 ? 'Your option goes' : `All ${k} options go`} to the managers together.`}
      footer={<div className="form-actions"><Button variant="ghost" onClick={onClose}>Keep drafting</Button><Button ref={btn} variant="primary pill" icon={<Send aria-hidden />} busy={send.isPending} onClick={submit}>Send round {n} ({plural(k, 'option')})</Button></div>}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <FormError error={send.error?.status === 409 ? null : send.error} />
        <ul className="tb-send-pics" aria-label="What you’re sending">
          {options.map((o) => <li key={o.id}><Thumb src={o.url} alt={optionAlt(o, d.title)}><span className="thumb-letter" aria-hidden>{o.letter}</span></Thumb></li>)}
        </ul>
        {d.state === 'in_review' && <div className="banner lavender"><Send aria-hidden /><div className="txt"><b>Round {d.roundsSent} is still waiting</b><span>Sending this one replaces it in the review queue.</span></div></div>}
        {k < d.optionsWanted && <p className="muted">The brief asks for {d.optionsWanted}. You can still send {k}.</p>}
        <Field label="A note for the managers" optional htmlFor={nid} help="What you tried, or what to look at. One or two lines.">
          <textarea className="textarea" data-autofocus value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} {...inputProps(nid)} />
        </Field>
      </form>
    </Dialog>
  );
}

// ── a manager's review ───────────────────────────────────────────────────

type Ask = { action: 'pick'; option: ThumbnailOption } | { action: 'changes' };

function Review({ d, round, onPreview, now }: { d: ThumbnailBriefDetail; round: ThumbnailRound | null; onPreview: (key: string) => void; now: number }) {
  const [ask, setAsk] = useState<Ask | null>(null);
  if (!round) {
    return (
      <Empty boxed icon={<ImageIcon />} title={d.needsDesigner ? 'This brief needs a designer' : `${d.designerName ?? 'The designer'} hasn’t sent a round yet`}>
        {d.needsDesigner ? 'Choose one with Edit or Reassign, and they’re told straight away.'
          : d.draftOptions ? `Drafting · ${plural(d.draftOptions, 'option')} in their tray. You’ll see them when they send the round.`
          : 'Their options show up here when they send a round. Unsent options stay private.'}
      </Empty>
    );
  }
  const dec = round.decisions[0] ?? null;
  const cols = Math.min(3, Math.max(1, round.options.length));
  return (
    <div className="tb-review">
      <div className="tb-round-head">
        <b>Round {round.number}</b>
        <span className="muted">{round.createdByName} sent {plural(round.options.length, 'option')} {round.sentAt ? fmtAgo(round.sentAt, now) : ''}</span>
      </div>
      {round.note && <blockquote className="tb-quote">{round.note}<span>{round.createdByName}</span></blockquote>}
      {dec && (
        <div className={`tb-decided ${dec.action}`}>
          {dec.action === 'pick' ? <Check aria-hidden /> : <RotateCcw aria-hidden />}
          <span><b>{dec.action === 'pick' ? `${dec.decidedByName} picked ${dec.optionLetter}` : `${dec.decidedByName} asked for changes`}</b>{dec.note ? <> · “{dec.note}”</> : null} <span className="muted">· {fmtAgo(dec.createdAt, now)}</span></span>
        </div>
      )}
      <div className={`tb-sbs c${cols}`}>
        {round.options.map((o, i) => (
          <OptionSlot key={o.id} option={o} title={d.title} fit="contain" eager={i < 3}
            actions={(
              <>
                {d.can.decide && (
                  <Button variant={`mint${o.picked ? '' : ' pill'}`} icon={<Check aria-hidden />} disabled={o.picked} onClick={() => setAsk({ action: 'pick', option: o })}>
                    {o.picked ? `Picked ${o.letter}` : `Pick ${o.letter}`}
                  </Button>
                )}
                <Button variant="sm ghost" icon={<Eye aria-hidden />} onClick={() => onPreview(String(o.id))} aria-label={`Preview option ${o.letter} in the wild`}>Preview</Button>
                <a className="btn sm ghost" href={o.url} target="_blank" rel="noopener noreferrer" aria-label={`Option ${o.letter} at full size (opens in a new tab)`}>Full size</a>
                {o.picked && <a className="btn sm ghost" href={`${o.url}?download=1`} download={o.fileName} aria-label={`Download option ${o.letter} (${THUMB_MIME_LABEL[o.mime]})`}><Download aria-hidden />{THUMB_MIME_LABEL[o.mime]}</a>}
              </>
            )} />
        ))}
      </div>
      {d.can.decide && (
        <div className="tb-decide">
          <Button variant="changes pill" icon={<RotateCcw aria-hidden />} onClick={() => setAsk({ action: 'changes' })}>{dec?.action === 'changes' ? 'Change your note' : 'Ask for changes'}</Button>
          <span className="muted">{dec
            ? `Decide again: until ${d.designerName ?? 'the designer'} sends another round, you can pick another option or ask for changes after all. Their message about your first decision is taken back.`
            : 'Pick one, with a reason if you like, or ask for changes with a note so they know what to change.'}</span>
        </div>
      )}
      {ask && <DecideDialog d={d} round={round} ask={ask} again={!!dec} onClose={() => setAsk(null)} />}
    </div>
  );
}

function DecideDialog({ d, round, ask, again, onClose }: { d: ThumbnailBriefDetail; round: ThumbnailRound; ask: Ask; again: boolean; onClose: () => void }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | undefined>();
  const nid = useFieldId('decide-note');
  const btn = useRef<HTMLButtonElement>(null);
  const from = useRef<{ x: number; y: number } | null>(null);
  const pick = ask.action === 'pick';
  const letter = ask.action === 'pick' ? ask.option.letter : null;
  // a pick is told to (and goes on the wall of) whoever made the option; changes go to whoever has the brief now
  const who = ask.action === 'pick' ? ask.option.uploadedByName : d.designerName ?? 'The designer';
  const save = useSave((body: ThumbnailDecisionInput) => api<ThumbnailBriefDetail>(`/api/thumbnails/${d.id}/decision`, { body: { ...body } }), {
    onSuccess: (_out, v) => {
      if (v.action === 'pick' && from.current) burst(from.current.x, from.current.y, { count: 18 });
      toast(v.action === 'pick' ? `Picked ${letter} for ${d.title}. ${who} is told.` : `Changes asked on round ${round.number}. ${who} is told.`);
      onClose();
    },
  });
  const f = save.error?.fields ?? {};
  const submit = () => {
    if (!pick && !note.trim()) { setErr('Say what to change, so they know where to start'); return; }
    setErr(undefined);
    from.current = centerOf(btn.current);
    save.mutate({ roundId: round.id, action: ask.action, optionId: ask.action === 'pick' ? ask.option.id : null, note: note.trim() || null }, {
      // a newer round came in while you were looking: say so; the page refreshes to it (useSave refetches on a 409)
      onError: (e) => { if (e.status === 409) { toast(e.message, 'error'); onClose(); } },
    });
  };
  return (
    <Dialog open onClose={onClose} size="narrow"
      title={pick ? `Pick option ${ask.option.letter}` : `Ask for changes on round ${round.number}`}
      sub={pick ? `${who} is told, and it goes on their wall of wins.${again ? ' This replaces your earlier decision.' : ''}` : `${who} gets your note and starts round ${round.number + 1} from it.${again ? ' This replaces your earlier decision.' : ''}`}
      footer={<div className="form-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button ref={btn} variant={pick ? 'mint pill' : 'changes pill'} icon={pick ? <Check aria-hidden /> : <RotateCcw aria-hidden />} busy={save.isPending} onClick={submit}>{pick ? `Pick ${ask.option.letter}` : 'Ask for changes'}</Button></div>}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <FormError error={save.error && save.error.status !== 409 && !f.note ? save.error : null} />
        {pick && <div className="tb-decide-pic"><Thumb src={ask.option.url} alt={optionAlt(ask.option, d.title)} fit="contain" eager><span className="thumb-letter" aria-hidden>{ask.option.letter}</span></Thumb></div>}
        <Field label={pick ? 'Why this one?' : 'What should change?'} optional={pick} htmlFor={nid} error={err ?? f.note}
          help={pick ? 'One line they’ll see with the pick.' : 'Be specific: what to keep, what to change.'}>
          {pick
            ? <input className="input" data-autofocus value={note} maxLength={1000} placeholder="e.g. The face reads best small" onChange={(e) => setNote(e.target.value)} {...inputProps(nid, err ?? f.note)} />
            : <textarea className="textarea" data-autofocus value={note} maxLength={1000} placeholder="e.g. Keep B’s face, make the words bigger and cut them to three" onChange={(e) => setNote(e.target.value)} {...inputProps(nid, err ?? f.note)} />}
        </Field>
      </form>
    </Dialog>
  );
}

/** A designer the brief was taken from: the rounds they sent are in the strip below. */
function PastDesigner({ d }: { d: ThumbnailBriefDetail }) {
  const latest = d.rounds[d.rounds.length - 1] ?? null;
  if (!latest) return <Empty boxed icon={<ImageIcon />} title="No rounds to show" />;
  return (
    <div className="tb-review">
      <div className="tb-round-head"><b>Round {latest.number}</b><span className="muted">the newest round on it</span></div>
      <div className={`tb-sbs c${Math.min(3, Math.max(1, latest.options.length))}`}>
        {latest.options.map((o) => <OptionSlot key={o.id} option={o} title={d.title} fit="contain" />)}
      </div>
    </div>
  );
}
