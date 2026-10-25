// One thumbnail brief, built from GET /api/thumbnails/:id (ThumbnailBriefDetail in shared/types.ts).
// - Its designer (/studio/briefs/:id) gets the workbench: the brief and the client's look on one side; on the
//   other the private draft tray (A–F), filled by dropping an image anywhere on the page, pasting it or choosing
//   it, each option with its quick checks, a one-line "why this one" and, when the server has an AI key, a private
//   Second look; then "Send round N (k options)". A manager's note asking for changes sits on top, beside the
//   options it was asked on with the manager's numbered pins on them (and their second looks), next to the round
//   being drafted; a round still with the managers stays above the tray, compact once the next one is under way.
// - A manager (/thumbnails/:id) gets the review: the newest round sent, its options side by side at full size,
//   "Add note on image" to pin numbered notes on exact spots, "Pick B" (optionally marked Standout) with an
//   optional reason or "Ask for changes" with a required note, the pins going with either, and Decide again until
//   the designer sends another round. A newer round sent meanwhile is a 409 "stale": a toast, and the page
//   refreshes. Unsent options never reach a manager. The winner downloads at full quality.
// - A designer the brief was taken from reads the rounds they sent.
// Everyone gets Compare (this round's option against the last round's, side by side or with a swipe), Preview in
// the wild (every option at feed sizes, beside the client's recent winners), Lights down (one option alone on black,
// full screen), the round film strip, and on a desktop the keys (ThumbKeys.tsx).

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight, Ban, Check, CircleAlert, Columns2, Contrast, Download, Eye, Glasses, Image as ImageIcon, MapPinPlus, Maximize2, Pencil, RotateCcw, Send, Sparkles,
  Trash2, Trophy, Undo2,
} from 'lucide-react';
import { api, useSave, type ApiError } from '../api';
import type { ThumbnailBriefDetail, ThumbnailDecision, ThumbnailDecisionInput, ThumbnailOption, ThumbnailRound } from '../../../shared/types';
import { currentPins, isOpenThumb, MAX_OPTIONS, MAX_PINS, OPTION_LETTERS, THUMB_MIME_LABEL } from '../../../shared/workflow';
import { fmtAgo, plural } from '../../../shared/format';
import { PageHeader, useBoot } from '../components/Shell';
import { Button, Dialog, Empty, ErrorState, Field, FormError, inputProps, Loading, NotFound, Seg, Thumb, useFieldId, useToast } from '../components/ui';
import {
  BriefCard, ClientLook, DropZone, EmptySlot, OptionSlot, optionAlt, PendingSlot, pictureType, pinWords, PreviewInTheWild, readPicture, RoundStrip, StateChip, DueTag,
  type DropZoneHandle, type PendingStatus, type Picture, type WildItem,
} from '../components/ThumbBits';
import {
  allMarks, coarsePointer, HideNotes, marksOn, PinEditor, PinLayer, PinList, PinnedThumb, PinNote, pinInput, PinView, usePinDrafts, type PinDrafts,
} from '../components/ThumbPins';
import { Compare, LightsDown, type CompareSide } from '../components/ThumbCompare';
import { KeysPopover, useThumbKeys } from '../components/ThumbKeys';
import { SecondLook } from '../components/SecondLook';
import { useNow } from '../components/EditingBits';
import { burst, centerOf, plane } from '../fx';
import { motionAllowed } from '../motion';
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

type Tab = 'work' | 'compare' | 'wild';
type Ask = { action: 'pick'; option: ThumbnailOption } | { action: 'changes' };

function Workbench({ d }: { d: ThumbnailBriefDetail }) {
  const { clock } = useBoot();
  const toast = useToast();
  const now = useNow();
  const manager = d.viewer === 'manager';
  const designer = d.viewer === 'designer';
  const [tab, setTab] = useState<Tab>('work');
  const [pick, setPick] = useState<string | null>(null);
  const [edit, setEdit] = useState<null | 'all' | 'designer'>(null);
  const [cancelling, setCancelling] = useState(false);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [squint, setSquint] = useState(false);
  const [grey, setGrey] = useState(false);
  const [lights, setLights] = useState(false);
  const [cur, setCur] = useState(0);
  const [keyed, setKeyed] = useState(false);
  const reopen = useReopenBrief();
  const tray = useTray(d);
  const latest = d.rounds[d.rounds.length - 1] ?? null;
  const pins = usePinDrafts(manager ? latest : null);
  const preview = (key: string) => { setPick(key); setTab('wild'); };

  // what Preview in the wild shows: the tray (and images not added yet) while drafting, else the newest round sent
  const fromOptions = (list: ThumbnailOption[]): WildItem[] => list.map((o) => ({ key: String(o.id), letter: o.letter, src: o.url, alt: optionAlt(o, d.title) }));
  const trayItems = designer ? [...fromOptions(d.tray?.options ?? []), ...tray.pending.filter((p) => p.pic?.src).map((p) => ({ key: p.key, letter: p.letter, src: p.pic!.src, alt: `New option ${p.letter}` }))] : [];
  const wildItems = trayItems.length ? trayItems : fromOptions(d.winner ? [d.winner, ...(latest?.options ?? []).filter((o) => o.id !== d.winner!.id)] : latest?.options ?? []);

  // the options on stage, which ← → flick through, Lights down shows and Compare puts against the version before:
  // the tray while it has any, else the newest round sent
  const trayOptions = designer ? d.tray?.options ?? [] : [];
  const stage = trayOptions.length ? trayOptions : latest?.options ?? [];
  const stageLabel = trayOptions.length ? `Round ${d.nextRound} · your tray` : latest ? `Round ${latest.number}` : '';
  const at = stage.length ? Math.min(cur, stage.length - 1) : 0;
  // the version before: the last round sent with options to show (or the picked one, when it's not on stage)
  const shown = d.rounds.filter((r) => r.options.length);
  const prev = trayOptions.length ? shown[shown.length - 1] ?? null : shown.filter((r) => r.id !== latest?.id).pop() ?? null;
  const before: CompareSide[] = [
    ...(d.winner && !stage.some((o) => o.id === d.winner!.id) ? [{ option: d.winner, picked: true }] : []),
    ...(prev?.options.map((o) => ({ option: o })) ?? []),
  ];
  // nothing sent before this round: its options against each other
  const sides = before.length ? before : stage.length > 1 ? stage.map((o) => ({ option: o })) : [];
  const canCompare = stage.length > 0 && sides.length > 0;
  // Compare went away (the round it compared was replaced): back to the work
  const view: Tab = tab === 'compare' && !canCompare ? 'work' : tab;
  const firstBefore = (() => {
    if (!before.length) return at === 0 ? 1 : 0;
    // the one the last notes were on, else the same letter, else the first
    const notes = currentPins(prev ?? { decisions: [] });
    const counts = new Map<number, number>();
    for (const p of notes) counts.set(p.optionId, (counts.get(p.optionId) ?? 0) + 1);
    const most = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const byNotes = most != null ? sides.findIndex((s) => s.option.id === most) : -1;
    if (byNotes >= 0) return byNotes;
    const same = sides.findIndex((s) => s.option.letter === stage[at]?.letter);
    return same >= 0 ? same : 0;
  })();

  const flick = (dir: number) => {
    if (view === 'wild' && !lights) {
      if (!wildItems.length) return;
      const i = Math.max(0, wildItems.findIndex((w) => w.key === pick));
      setPick(wildItems[(i + dir + wildItems.length) % wildItems.length].key);
      return;
    }
    if (!stage.length) return;
    // on the work tab, only the options shown there (the changes card shows at most three beside those with notes)
    const shownHere = (i: number) => view !== 'work' || lights || !!document.querySelector(`[data-option="${stage[i].id}"]`);
    let next = at;
    for (let step = 0; step < stage.length; step++) {
      next = (next + dir + stage.length) % stage.length;
      if (shownHere(next)) break;
    }
    setCur(next);
    if (view === 'work' && !lights) {
      setKeyed(true);
      document.querySelector(`[data-option="${stage[next].id}"]`)?.scrollIntoView({ block: 'nearest', behavior: motionAllowed() ? 'smooth' : 'auto' });
    }
  };
  useThumbKeys((a) => {
    switch (a.kind) {
      case 'pick': {
        const o = latest?.options[a.index];
        if (!o || !d.can.decide) return;
        if (o.picked) { toast(`Option ${o.letter} is already the pick.`); return; }
        setAsk({ action: 'pick', option: o });
        return;
      }
      case 'feed': setTab(view === 'wild' ? 'work' : 'wild'); return;
      case 'squint': setSquint((v) => !v); return;
      case 'grey': setGrey((v) => !v); return;
      case 'lights': if (stage.length) setLights((v) => !v); return;
      case 'prev': flick(-1); return;
      case 'next': flick(1); return;
    }
  }, { manager: manager && d.can.decide });

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
  const currentId = keyed && view === 'work' ? stage[at]?.id ?? null : null;
  const paneLabel = view === 'work' ? workLabel : view === 'compare' ? 'Compare' : 'Preview in the wild';
  return (
    // a manager's review puts the round first whenever the columns stack: it's what they came to decide on
    <div className={`studio tb${manager ? ' review' : ''}`}>
      <PageHeader title={d.title} crumbs={crumbs} hideNewWork
        sub={<span className="row-flex s2"><StateChip brief={d} /><DueTag dueOn={d.dueOn} today={clock.today} state={d.state} />{d.roundsSent > 0 && <span className="muted">{plural(d.roundsSent, 'round')} sent</span>}</span>}>
        {tools}
      </PageHeader>

      <TopNote d={d} now={now} currentId={currentId} onReopen={manager && d.can.edit ? () => reopen.mutate(d.id) : undefined} reopening={reopen.isPending} />

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
        <section className={`panel tb-main${squint ? ' squint' : ''}${grey ? ' grey' : ''}`} aria-label={paneLabel}>
          <div className="tb-tabs">
            <Seg role="group" aria-label="Show">
              <button type="button" aria-pressed={view === 'work'} onClick={() => setTab('work')}>{workLabel}</button>
              {canCompare && <button type="button" aria-pressed={view === 'compare'} onClick={() => setTab('compare')}><Columns2 aria-hidden />Compare</button>}
              <button type="button" aria-pressed={view === 'wild'} onClick={() => setTab('wild')}><Eye aria-hidden />Preview in the wild</button>
            </Seg>
            {/* S and G work on every tab; outside the preview (which has its own) they show here, to switch off */}
            {(squint || grey) && view !== 'wild' && (
              <div className="wild-toggles" role="group" aria-label="Checks on">
                {squint && <button type="button" className="wild-tg" aria-pressed onClick={() => setSquint(false)} title="Squint is on (S)"><Glasses aria-hidden />Squint</button>}
                {grey && <button type="button" className="wild-tg" aria-pressed onClick={() => setGrey(false)} title="Greyscale is on (G)"><Contrast aria-hidden />Greyscale</button>}
              </div>
            )}
            <div className="tb-tabs-tools">
              {stage.length > 0 && <Button variant="sm ghost" icon={<Maximize2 aria-hidden />} onClick={() => setLights(true)} title="Lights down (L)">Lights down</Button>}
              <KeysPopover manager={manager && d.can.decide} />
            </div>
          </div>
          {/* the work and the preview stay mounted, so the tray keeps taking dropped and pasted images while another tab shows */}
          <div className="tb-pane" hidden={view !== 'work'}>
            {designer ? <Tray d={d} t={tray} now={now} currentId={currentId} onFiles={(files) => { setTab('work'); tray.add(files); }} onPreview={preview} />
              : manager ? <Review d={d} round={latest} pins={pins} now={now} currentId={currentId} onAsk={setAsk} onPreview={preview} />
              : <PastDesigner d={d} currentId={currentId} />}
          </div>
          {view === 'compare' && (
            <div className="tb-pane">
              <Compare key={`${stage.map((o) => o.id).join('.')}|${sides.map((s) => s.option.id).join('.')}`} before={sides} options={stage} index={at} onIndex={setCur}
                title={d.title} nowLabel={stageLabel} initialBefore={firstBefore} />
            </div>
          )}
          <div className="tb-pane" hidden={view !== 'wild'}>
            <PreviewInTheWild items={wildItems} pick={pick} onPick={setPick} title={d.title} clientName={d.clientName} winners={d.recentWinners}
              looks={{ squint, grey, onSquint: () => setSquint((v) => !v), onGrey: () => setGrey((v) => !v) }} />
          </div>
        </section>
      </div>

      <RoundStrip rounds={d.rounds} tray={designer ? d.tray : null} title={d.title} nextRound={d.nextRound} now={now} />

      {ask && latest && <DecideDialog d={d} round={latest} ask={ask} again={!!latest.decisions[0]} pins={pins} onClose={() => setAsk(null)} />}
      {lights && stage.length > 0 && <LightsDown options={stage} index={at} onIndex={setCur} title={d.title} squint={squint} grey={grey} onClose={() => setLights(false)} />}
      {edit && <BriefDialog brief={d} focus={edit === 'designer' ? 'designer' : undefined} onClose={() => setEdit(null)} />}
      {cancelling && <CancelBriefDialog brief={d} onClose={() => setCancelling(false)} />}
    </div>
  );
}

/** The one thing to know first: a manager's note asking for changes, the pick, a round waiting, a cancelled or moved brief. */
function TopNote({ d, now, currentId, onReopen, reopening }: { d: ThumbnailBriefDetail; now: number; currentId: number | null; onReopen?: () => void; reopening: boolean }) {
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
  if (d.state === 'changes' && dec && latest && d.viewer === 'designer') return <ChangesNote dec={dec} round={latest} title={d.title} now={now} nextRound={d.nextRound} currentId={currentId} />;
  if (d.state === 'picked' && d.winner) {
    // the win goes on the wall of whoever made it, who may not be the brief's designer now
    const mine = d.winner.uploadedById === me.id;
    const tail = d.viewer !== 'designer' ? ' · download it at full quality and post it yourself' : mine ? ' · it’s on your wall of wins' : ` · it’s on ${d.winner.uploadedByName}’s wall of wins`;
    const notes = marksOn(dec?.pins, d.winner.id);
    return (
      <div className={`tb-picked${dec?.standout ? ' standout' : ''}`}>
        <div className="tb-picked-pic">
          {notes.length
            ? <PinnedThumb option={d.winner} pins={notes} title={d.title} eager><span className="thumb-letter" aria-hidden>{d.winner.letter}</span></PinnedThumb>
            : <Thumb src={d.winner.url} alt={optionAlt(d.winner, d.title)} eager><span className="thumb-letter" aria-hidden>{d.winner.letter}</span></Thumb>}
        </div>
        <div className="tb-picked-txt">
          <span className="row-flex s2">
            <span className="eh-badge"><Sparkles aria-hidden />Picked</span>
            {dec?.standout && <span className="eh-badge standout"><Trophy aria-hidden />Standout</span>}
          </span>
          <b>{d.viewer === 'designer' ? `${mine ? 'Option' : `${d.winner.uploadedByName}’s option`} ${d.winner.letter} was picked` : `${dec?.decidedByName ?? 'A manager'} picked option ${d.winner.letter}`}</b>
          {dec?.note && <q>{dec.note}</q>}
          {notes.length > 0 && <PinList pins={notes} className="on-accent" />}
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

/**
 * The manager's note, on top of the round it was asked on, so the next round starts beside it. With pins, the
 * options they're on come first, each with its numbered pins, and the numbered list follows the note. Each of the
 * designer's options keeps its Second look (asked for before or after sending) while they make the next round.
 */
function ChangesNote({ dec, round, title, now, nextRound, currentId }: {
  dec: ThumbnailDecision; round: ThumbnailRound; title: string; now: number; nextRound: number; currentId: number | null;
}) {
  const { me, secondLook: lookOn } = useBoot();
  const [hide, setHide] = useState(false);
  const notes = allMarks(dec.pins);
  const on = new Set(dec.pins.map((p) => p.optionId));
  const pics = [...round.options.filter((o) => on.has(o.id)), ...round.options.filter((o) => !on.has(o.id))].slice(0, Math.max(3, on.size));
  // a second look under a picture: the note then sits below the pictures rather than over them
  const looks = pics.some((o) => o.secondLook || (lookOn && o.uploadedById === me.id));
  return (
    <div className={`tb-changes${notes.length ? ' pinned' : ''}${looks ? ' looks' : ''}`}>
      <div className="tb-changes-pics">
        {pics.map((o) => (
          // ← → land here while the next round's tray is empty (data-option, outlined as current)
          <span key={o.id} data-option={o.id} className={o.id === currentId ? 'current' : undefined}>
            {on.has(o.id)
              ? <PinnedThumb option={o} pins={marksOn(dec.pins, o.id)} title={title} hidden={hide} eager><span className="thumb-letter" aria-hidden>{o.letter}</span></PinnedThumb>
              : <Thumb src={o.url} alt={optionAlt(o, title)} fit={notes.length || looks ? 'contain' : 'cover'}><span className="thumb-letter" aria-hidden>{o.letter}</span></Thumb>}
            <SecondLook option={o} />
          </span>
        ))}
      </div>
      <figure className="tb-changes-note">
        <span className="tb-changes-k"><RotateCcw aria-hidden />Changes asked on round {round.number}</span>
        <blockquote>{dec.note}</blockquote>
        <figcaption>{dec.decidedByName} · {fmtAgo(dec.createdAt, now)} · round {nextRound} starts below</figcaption>
      </figure>
      {notes.length > 0 && (
        <div className="tb-changes-pins">
          <div className="tb-changes-pins-h"><b>{plural(notes.length, 'note')} on the image</b><HideNotes hidden={hide} onToggle={() => setHide((v) => !v)} /></div>
          <PinList pins={notes} letters={on.size > 1} />
        </div>
      )}
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

function Tray({ d, t, now, currentId, onFiles, onPreview }: { d: ThumbnailBriefDetail; t: TrayState; now: number; currentId: number | null; onFiles: (files: File[]) => void; onPreview: (key: string) => void }) {
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
  // the round with the managers: the designer's own work, read-only (with its second looks), at a useful size while
  // the tray is empty and as a compact row once the next round is under way
  const latest = d.rounds[d.rounds.length - 1] ?? null;
  const waiting = d.state === 'in_review' && latest?.options.length ? latest : null;
  const k = options.length;
  const why = !k ? 'Add at least one option to send a round.'
    : staged.length ? `Add or discard the ${plural(staged.length, 'image')} above first.`
    : moving.length ? 'Waiting for the uploads to finish.' : null;
  const next = t.pending.length < MAX_OPTIONS - k ? (OPTION_LETTERS.filter((l) => !options.some((o) => o.letter === l))[t.pending.length] ?? null) : null;
  const blocked = t.room <= 0 ? `Your tray is full: a round holds ${MAX_OPTIONS} options` : null;
  return (
    <div className="tb-tray">
      {waiting && (
        <section className={`tb-review tb-waiting${nothing ? '' : ' compact'}`} aria-label={`Round ${waiting.number}, with the managers`}>
          <div className="tb-round-head">
            <b>Round {waiting.number} · with the managers</b>
            <span className="muted">{waiting.sentAt ? `sent ${fmtAgo(waiting.sentAt, now)}` : ''}</span>
          </div>
          {waiting.note && nothing && <blockquote className="tb-quote">{waiting.note}<span>Your note to the managers</span></blockquote>}
          <div className={nothing ? `tb-sbs c${Math.min(3, waiting.options.length)}` : 'tb-slots'}>
            {waiting.options.map((o, i) => (
              <OptionSlot key={o.id} option={o} title={d.title} fit="contain" eager={i < 3} current={o.id === currentId} checks={nothing}
                actions={<Button variant="sm ghost" icon={<Eye aria-hidden />} onClick={() => onPreview(String(o.id))} aria-label={`Preview option ${o.letter} in the wild`}>Preview</Button>}
                below={<SecondLook option={o} />} />
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
            <OptionSlot key={o.id} option={o} title={d.title} eager={i < 3} current={o.id === currentId}
              actions={(
                <>
                  <Button variant="sm ghost" icon={<Eye aria-hidden />} onClick={() => onPreview(String(o.id))} aria-label={`Preview option ${o.letter} in the wild`}>Preview</Button>
                  {confirm === o.id
                    ? <Button variant="sm danger" icon={<Trash2 aria-hidden />} busy={remove.isPending && remove.variables?.id === o.id} onClick={() => remove.mutate(o, { onError: (err) => toast(err.message, 'error') })}>Remove {o.letter}?</Button>
                    : <Button variant="sm ghost" icon={<Trash2 aria-hidden />} onClick={() => setConfirm(o.id)} aria-label={`Remove option ${o.letter}`}>Remove</Button>}
                </>
              )}
              below={<SecondLook option={o} />} />
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

function Review({ d, round, pins, now, currentId, onAsk, onPreview }: {
  d: ThumbnailBriefDetail; round: ThumbnailRound | null; pins: PinDrafts; now: number; currentId: number | null; onAsk: (a: Ask) => void; onPreview: (key: string) => void;
}) {
  const toast = useToast();
  const [hide, setHide] = useState(false);
  // Esc stops dropping notes (a note being written closes first: its own Esc goes no further)
  const stop = useRef(() => pins.setPlacing(false));
  useEffect(() => { stop.current = () => pins.setPlacing(false); });
  const placing = pins.placing;
  useEffect(() => {
    if (!placing) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('dialog[open]')) stop.current(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [placing]);
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
  const canPin = d.can.decide;
  const total = pins.all.length;
  const coarse = coarsePointer();
  const multi = new Set(pins.all.map((p) => p.optionId)).size > 1;
  const open = pins.open;
  // where a pin is written: over the picture, or in the list (on a phone, or while the pins are hidden)
  const editWhere = (): 'pin' | 'list' => (hide || coarsePointer() ? 'list' : 'pin');
  const editorFor = (key: string) => {
    const p = pins.list().find((x) => x.key === key);
    if (!p) return null;
    return pins.editing
      ? <PinEditor pin={p} onChange={(c) => pins.change(p.key, c)} onDone={pins.close} onRemove={() => pins.remove(p.key)} />
      : <PinNote pin={p} />;
  };
  return (
    <div className="tb-review">
      <div className="tb-round-head">
        <b>Round {round.number}</b>
        <span className="muted">{round.createdByName} sent {plural(round.options.length, 'option')} {round.sentAt ? fmtAgo(round.sentAt, now) : ''}</span>
        {(canPin || total > 0) && (
          <div className="tb-round-tools">
            {total > 0 && <HideNotes hidden={hide} onToggle={() => setHide((v) => !v)} />}
            {canPin && (
              <Button variant={`sm${placing ? ' primary' : ''}`} icon={<MapPinPlus aria-hidden />} aria-pressed={placing} onClick={() => pins.setPlacing(!placing)}>
                Add note on image
              </Button>
            )}
          </div>
        )}
      </div>
      {placing && (
        <p className="tb-pin-hint" role="status">
          <MapPinPlus aria-hidden />
          <span>
            {coarse ? 'Tap the spot on an option, then write the note under it.' : 'Click the spot on an option and write the note. Tab to a pin: Enter opens it, the arrows move it, Delete takes it off.'}
            {' '}<span className="dim">{total} of {MAX_PINS}</span>
          </span>
          <button type="button" className="linkbtn" onClick={() => pins.setPlacing(false)}>Done</button>
        </p>
      )}
      {!placing && pins.changed && (
        <p className="tb-pin-hint">
          <MapPinPlus aria-hidden />
          <span>{total ? `Your ${plural(total, 'note')} on the image go${total === 1 ? 'es' : ''} with your decision${dec ? ': decide again to send the changes' : ''}.` : 'You took the notes off: decide again to send that.'}</span>
          <button type="button" className="linkbtn" onClick={pins.discard}>Undo my changes</button>
        </p>
      )}
      {round.note && <blockquote className="tb-quote">{round.note}<span>{round.createdByName}</span></blockquote>}
      {dec && (
        <div className={`tb-decided ${dec.action}${dec.standout ? ' standout' : ''}`}>
          {dec.action === 'pick' ? (dec.standout ? <Trophy aria-hidden /> : <Check aria-hidden />) : <RotateCcw aria-hidden />}
          <span>
            <b>{dec.action === 'pick' ? `${dec.decidedByName} picked ${dec.optionLetter}${dec.standout ? ' · Standout' : ''}` : `${dec.decidedByName} asked for changes`}</b>
            {dec.note ? <> · “{dec.note}”</> : null}{pinWords(dec) ? ` · ${pinWords(dec)}` : ''} <span className="muted">· {fmtAgo(dec.createdAt, now)}</span>
          </span>
        </div>
      )}
      <div className={`tb-sbs c${cols}`}>
        {round.options.map((o, i) => {
          const marks = pins.marks(o.id);
          return (
            <OptionSlot key={o.id} option={o} title={d.title} fit="contain" eager={i < 3} standout={o.picked && !!dec?.standout} current={o.id === currentId}
              frame={(picture) => (
                <PinLayer pins={marks} image={o} label={`option ${o.letter}`} placing={placing && canPin} hidden={hide}
                  openKey={open?.where === 'pin' ? open.key : null} popover={open?.where === 'pin' && marks.some((m) => m.key === open.key) ? editorFor(open.key) : null}
                  onPlace={(at) => { if (!pins.place(o, at, editWhere())) toast(`A decision holds up to ${MAX_PINS} notes on the image.`, 'error'); }}
                  onOpen={(key) => pins.openPin(key, 'pin')} onClose={pins.close}
                  onRemove={pins.editing ? pins.remove : undefined} onMove={pins.editing ? pins.move : undefined}>
                  {picture}
                </PinLayer>
              )}
              actions={(
                <>
                  {d.can.decide && (
                    <Button variant={`mint${o.picked ? '' : ' pill'}`} icon={<Check aria-hidden />} disabled={o.picked} onClick={() => onAsk({ action: 'pick', option: o })} title={i < MAX_OPTIONS ? `Pick ${o.letter} (${i + 1})` : undefined}>
                      {o.picked ? `Picked ${o.letter}` : `Pick ${o.letter}`}
                    </Button>
                  )}
                  <Button variant="sm ghost" icon={<Eye aria-hidden />} onClick={() => onPreview(String(o.id))} aria-label={`Preview option ${o.letter} in the wild`}>Preview</Button>
                  <a className="btn sm ghost" href={o.url} target="_blank" rel="noopener noreferrer" aria-label={`Option ${o.letter} at full size (opens in a new tab)`}>Full size</a>
                  {o.picked && <a className="btn sm ghost" href={`${o.url}?download=1`} download={o.fileName} aria-label={`Download option ${o.letter} (${THUMB_MIME_LABEL[o.mime]})`}><Download aria-hidden />{THUMB_MIME_LABEL[o.mime]}</a>}
                </>
              )}
              below={(
                <PinList pins={marks} openKey={open?.where === 'list' ? open.key : null} editor={open?.where === 'list' ? editorFor(open.key) : null}
                  onEdit={pins.editing ? (key) => pins.openPin(key, editWhere()) : undefined} onRemove={pins.editing ? pins.remove : undefined} letters={false} />
              )} />
          );
        })}
      </div>
      {d.can.decide && (
        <div className="tb-decide">
          <Button variant="changes pill" icon={<RotateCcw aria-hidden />} onClick={() => onAsk({ action: 'changes' })}>{dec?.action === 'changes' ? 'Change your note' : 'Ask for changes'}</Button>
          <span className="muted">{dec
            ? `Decide again: until ${d.designerName ?? 'the designer'} sends another round, you can pick another option or ask for changes after all. Their message about your first decision is taken back.`
            : `Pick one, with a reason if you like, or ask for changes with a note so they know what to change.${multi || total ? ' Your notes on the image go with either.' : ''}`}</span>
        </div>
      )}
    </div>
  );
}

function DecideDialog({ d, round, ask, again, pins, onClose }: { d: ThumbnailBriefDetail; round: ThumbnailRound; ask: Ask; again: boolean; pins: PinDrafts; onClose: () => void }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | undefined>();
  const [standout, setStandout] = useState(false);
  const [withPins, setWithPins] = useState(true);
  const nid = useFieldId('decide-note');
  const btn = useRef<HTMLButtonElement>(null);
  const from = useRef<{ x: number; y: number } | null>(null);
  const pick = ask.action === 'pick';
  const letter = ask.action === 'pick' ? ask.option.letter : null;
  // a pick is told to (and goes on the wall of) whoever made the option; changes go to whoever has the brief now
  const who = ask.action === 'pick' ? ask.option.uploadedByName : d.designerName ?? 'The designer';
  // the notes on the image: what's on screen (the round's current ones, or the manager's changes), those with a note
  const sendable = pinInput(pins.all);
  const written = pins.list().filter((p) => p.body.trim());
  const blank = pins.all.length - sendable.length;
  const save = useSave((body: ThumbnailDecisionInput) => api<ThumbnailBriefDetail>(`/api/thumbnails/${d.id}/decision`, { body: { ...body } }), {
    onSuccess: (_out, v) => {
      if (v.action === 'pick' && from.current) burst(from.current.x, from.current.y, v.standout ? { count: 30, distance: 84 } : { count: 18 });
      const k = v.pins?.length ?? 0;
      const withWhat = k ? ` with ${plural(k, 'note')} on the image` : '';
      toast(v.action === 'pick' ? `Picked ${letter}${v.standout ? ' as a standout' : ''} for ${d.title}${withWhat}. ${who} is told.` : `Changes asked on round ${round.number}${withWhat}. ${who} is told.`);
      pins.discard();
      onClose();
    },
  });
  const f = save.error?.fields ?? {};
  const submit = () => {
    if (!pick && !note.trim()) { setErr('Say what to change, so they know where to start'); return; }
    setErr(undefined);
    from.current = centerOf(btn.current);
    save.mutate({
      roundId: round.id, action: ask.action, optionId: ask.action === 'pick' ? ask.option.id : null, note: note.trim() || null,
      ...(withPins && sendable.length ? { pins: sendable } : {}),
      ...(pick && standout ? { standout: true } : {}),
    }, {
      // a newer round came in while you were looking: say so; the page refreshes to it (useSave refetches on a 409)
      onError: (e) => { if (e.status === 409) { toast(e.message, 'error'); onClose(); } },
    });
  };
  return (
    <Dialog open onClose={onClose} size="narrow"
      title={pick ? `Pick option ${ask.option.letter}` : `Ask for changes on round ${round.number}`}
      sub={pick ? `${who} is told, and it goes on their wall of wins.${again ? ' This replaces your earlier decision.' : ''}` : `${who} gets your note and starts round ${round.number + 1} from it.${again ? ' This replaces your earlier decision.' : ''}`}
      footer={<div className="form-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button ref={btn} variant={pick ? 'mint pill' : 'changes pill'} icon={pick ? <Check aria-hidden /> : <RotateCcw aria-hidden />} busy={save.isPending} onClick={submit}>{pick ? `Pick ${ask.option.letter}${standout ? ' · Standout' : ''}` : 'Ask for changes'}</Button></div>}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <FormError error={save.error && save.error.status !== 409 && !f.note && !f.pins && !f.standout ? save.error : null} />
        {pick && <div className={`tb-decide-pic${standout ? ' standout' : ''}`}><Thumb src={ask.option.url} alt={optionAlt(ask.option, d.title)} fit="contain" eager><span className="thumb-letter" aria-hidden>{ask.option.letter}</span></Thumb></div>}
        <Field label={pick ? 'Why this one?' : 'What should change?'} optional={pick} htmlFor={nid} error={err ?? f.note}
          help={pick ? 'One line they’ll see with the pick.' : 'Be specific: what to keep, what to change.'}>
          {pick
            ? <input className="input" data-autofocus value={note} maxLength={1000} placeholder="e.g. The face reads best small" onChange={(e) => setNote(e.target.value)} {...inputProps(nid, err ?? f.note)} />
            : <textarea className="textarea" data-autofocus value={note} maxLength={1000} placeholder="e.g. Keep B’s face, make the words bigger and cut them to three" onChange={(e) => setNote(e.target.value)} {...inputProps(nid, err ?? f.note)} />}
        </Field>
        {pick && (
          <div className="field">
            <label className="check tb-standout">
              <input type="checkbox" checked={standout} onChange={(e) => setStandout(e.target.checked)} aria-describedby={`${nid}-so`} />
              <span><b><Trophy aria-hidden />Mark as Standout</b></span>
            </label>
            {f.standout
              ? <span className="err" role="alert"><CircleAlert aria-hidden />{f.standout}</span>
              : <span className="help" id={`${nid}-so`}>One of the best: {who}’s celebration gets a ring, and it goes in their best this month.</span>}
          </div>
        )}
        {(sendable.length > 0 || blank > 0) && (
          <div className="field tb-decide-pins">
            {sendable.length > 0 && (
              <label className="check">
                <input type="checkbox" checked={withPins} onChange={(e) => setWithPins(e.target.checked)} />
                <span>Send {plural(sendable.length, 'note')} on the image</span>
              </label>
            )}
            {withPins && written.length > 0 && <PinList pins={written} letters className="compact" />}
            {blank > 0 && <span className="help">{blank === 1 ? 'One pin has no note yet, so it’s left out.' : `${blank} pins have no note yet, so they’re left out.`}</span>}
            {f.pins && <span className="err" role="alert"><CircleAlert aria-hidden />{f.pins}</span>}
          </div>
        )}
      </form>
    </Dialog>
  );
}

/** A designer the brief was taken from: the newest round they sent, with the notes pinned on it; every round is in the strip below. */
function PastDesigner({ d, currentId }: { d: ThumbnailBriefDetail; currentId: number | null }) {
  const [hide, setHide] = useState(false);
  const latest = d.rounds[d.rounds.length - 1] ?? null;
  if (!latest) return <Empty boxed icon={<ImageIcon />} title="No rounds to show" />;
  const notes = currentPins(latest);
  return (
    <div className="tb-review">
      <div className="tb-round-head">
        <b>Round {latest.number}</b><span className="muted">the newest round you sent on it</span>
        {notes.length > 0 && <div className="tb-round-tools"><HideNotes hidden={hide} onToggle={() => setHide((v) => !v)} /></div>}
      </div>
      <div className={`tb-sbs c${Math.min(3, Math.max(1, latest.options.length))}`}>
        {latest.options.map((o) => {
          const marks = marksOn(notes, o.id);
          return (
            <OptionSlot key={o.id} option={o} title={d.title} fit="contain" current={o.id === currentId} standout={o.picked && !!latest.decisions[0]?.standout}
              frame={marks.length ? (picture) => <PinView option={o} pins={marks} hidden={hide}>{picture}</PinView> : undefined}
              below={<><PinList pins={marks} /><SecondLook option={o} /></>} />
          );
        })}
      </div>
    </div>
  );
}
