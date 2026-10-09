// Editors (managers): what each editor is doing right now and what's on their plate, read from Timeliner.
// Videos are given to editors in Timeliner (on the video, or to the client's dedicated editor on its brand); this
// page never assigns them. On top, what the last read found and Read Timeliner now; then the summary cards and
// "Editors by client" (each client's editor, its open videos, and a chip when its videos are split across editors
// or some aren't assigned). The roster has a card for everyone in Timeliner with videos and every editor on the
// site; people to fix (not on the site, or another email here) are flagged on their card and listed in one line
// above the cards. Each card leads with its clients ("Joshua Shalimar · 32 videos") and says what they're on (the
// video they tapped "I'm on this" for, or paused), else what's next by deadline, or that they're off hours; their
// videos by state; what's due today; the last one they finished; and the script documents they cut from ("Scripts
// PDF · v3 · from Timeliner"). Raw camera clips count as clips ("24 clips to edit"). Videos the site couldn't match
// to a shoot, or whose match is worth a look, carry "Not matched" and "Check" chips; a client without scripts on
// the site is "No scripts on the site", never "Not matched". In an editor's Videos, tapping a video shows how it was
// matched, and "Wrong shoot? Pin it" pins it to a batch (and maybe a script), or to none. Then the videos nobody has
// in Timeliner yet (raw clips by shoot), with whom to give them ("usually Leo").

import { useId, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlarmClock, AlertTriangle, ArrowRight, Check, ChevronDown, CircleCheck, CircleHelp, Clapperboard, Eye, ExternalLink, FileText, FileX, Film, History, Layers,
  Moon, Pause, Pin, PinOff, RefreshCw, RotateCcw, Scissors, Sunrise, TimerOff, UserPlus, Users, X,
} from 'lucide-react';
import { api, qs, useSave } from '../api';
import type { BatchSummary, EditingBoard, EditingSync, EditingVideo, EditorFlag, EditorRow, ClientEditing, ScriptDoc } from '../../../shared/types';
import { FOCUS_STALE_HOURS, isAdmin, isFocusStale, isOnPlate, needsCheck } from '../../../shared/workflow';
import { dueWords, fmtAgo, fmtDate, fmtHour, fmtStamp, fmtWorked, plural } from '../../../shared/format';
import { nowInZone, type ISODate } from '../../../shared/dates';
import { PageHeader, useBoot, useDisplayTz } from '../components/Shell';
import { Avatar, Button, Chip, Empty, ErrorState, Field, FormError, inputProps, Loading, Panel, useFieldId, useToast } from '../components/ui';
import { KpiCard } from '../components/StatCards';
import { motionAllowed } from '../motion';
import {
  AgainTag, byTitle, clientName, clockTime, docKind, docName, docSource, midSentence, fmtWhen, focusSeconds, hoursText, localTime, noScripts, notMatched, readWords,
  reviewWords, ScriptLink, shootLabel, shootWords, squareOf, tileTime, TIMELINER_APP, useNow, VideoName, videoName, videoTitles,
} from '../components/EditingBits';

const first = (name: string) => name.trim().split(/\s+/)[0] || name;
const names = (list: string[]) => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);
const sum = (list: number[]) => list.reduce((n, x) => n + x, 0);
const plateTotal = (e: EditorRow) => e.plate.toEdit + e.plate.revisions + e.plate.inReview + e.plate.withClient + e.plate.approvedWeek;
/** still to edit or fix, and not marked done here */
const onPlate = (v: EditingVideo) => isOnPlate(v.state) && !v.doneAt;

/** An editor's card on the page, for the links that scroll to it ("Fix these people", Editors by client). */
const cardId = (key: string) => `ed-card-${key}`;
/** Scroll to an editor's card and put focus on it (smoothly only when motion is on). */
const goToCard = (key: string) => (ev: MouseEvent) => {
  const el = document.getElementById(cardId(key));
  if (!el) return;
  ev.preventDefault();
  el.scrollIntoView({ behavior: motionAllowed() ? 'smooth' : 'auto', block: 'start' });
  el.focus({ preventScroll: true });
  // a short ring, so the eye finds the card it landed on
  el.classList.add('ed-hl');
  window.setTimeout(() => el.classList.remove('ed-hl'), 1800);
};

/** Someone to fix about who they are (not `nothing_assigned`, which is a quiet note on their card). */
const needsFix = (f: EditorFlag | null): f is EditorFlag => !!f && f.kind !== 'nothing_assigned';
/** The flag in two or three words, for the "Fix these people" line. */
const FIX_WORDS: Record<EditorFlag['kind'], string> = {
  not_on_site: 'not on the site', no_site_access: 'no site access', email_differs: 'emails differ', nothing_assigned: 'nothing in Timeliner',
};

/** What a card shows under Right now: one of these for each editor. `stale` is an I'm on this left running (isFocusStale). */
type NowKind = 'live' | 'stale' | 'paused' | 'next' | 'off' | 'clear';
const nowKind = (e: EditorRow, now: number): NowKind =>
  e.focus
    ? (e.focus.state === 'paused' ? 'paused' : isFocusStale(e.focus, e.offHours, now) ? 'stale' : 'live')
    : e.nextUp ? 'next' : e.offHours ? 'off' : 'clear';

/** One video once, however many editors share it (marked done if any of them marked it). */
const uniqueVideos = (list: EditingVideo[]) => {
  const out = new Map<string, EditingVideo>();
  for (const v of list) { const was = out.get(v.id); if (!was || (!was.doneAt && v.doneAt)) out.set(v.id, v); }
  return [...out.values()];
};

/**
 * Videos counted by state, split as the bars are: marked done here is its own count, as on an editor's Home. From
 * the videos themselves, so a video two editors share (both on its client in Timeliner) counts once for the team.
 */
function stateCounts(videos: EditingVideo[]): { label: string; n: number; c: string }[] {
  const n = (fn: (v: EditingVideo) => boolean) => videos.filter(fn).length;
  const marked = n((v) => !!v.doneAt);
  const toEdit = n((v) => v.state === 'to_edit' && !v.doneAt);
  // raw camera clips to cut read as clips, when that's all there is to edit
  const clips = toEdit > 0 && n((v) => v.state === 'to_edit' && !v.doneAt && v.raw) === toEdit;
  return [
    { label: clips ? 'Clips to edit' : 'To edit', n: toEdit, c: 'ed' }, { label: 'Revisions', n: n((v) => v.state === 'revisions' && !v.doneAt), c: 'rv' },
    ...(marked ? [{ label: 'Marked done', n: marked, c: 'dn' }] : []),
    { label: 'In review', n: n((v) => v.state === 'in_review'), c: 'ir' },
    { label: 'With client', n: n((v) => v.state === 'with_client'), c: 'cl' }, { label: 'Approved', n: n((v) => v.state === 'approved'), c: 'ap' },
  ];
}

function Counts({ list }: { list: { label: string; n: number; c: string }[] }) {
  return (
    <div className="ed-counts">
      {list.map((c) => (
        <div key={c.c}><span className={`ed-cn num${c.n ? '' : ' zero'}`}>{c.n}</span><span className="ed-cl"><i className={`ed-sw c-${c.c}`} aria-hidden />{c.label}</span></div>
      ))}
    </div>
  );
}

/**
 * A script document as a link, with what it is: the shoot's scripts PDF ("Scripts PDF · v3 · from Timeliner",
 * maybe "being reviewed again"), else the site's ("Google Doc", "Edited version"). One document of the batch: a
 * single video's own second link isn't the batch's, so none is shown here (the server sends none).
 */
function DocLink({ d }: { d: ScriptDoc }) {
  const tl = d.source === 'timeliner';
  const review = reviewWords(d);
  return (
    <span className="ed-docs">
      <FileText aria-hidden />
      <span className="muted">{d.batchTitle}</span>
      <a className="ed-doc" href={d.href} target="_blank" rel="noopener noreferrer"
        aria-label={`${tl ? `${d.batchTitle} scripts PDF, version ${d.version ?? 1}, from Timeliner${review ? `, ${review}` : ''}` : `${docName(d, true)}${d.edited ? ', the edited version' : ''}`} (opens in a new tab)`}
        title={tl ? docName(d, true) : undefined}>
        {tl ? docSource(d) : docName(d)}
      </a>
      {!tl && <span className="ed-kind">{docKind(d)}</span>}
      {!tl && d.edited && <span className="ed-edited">Edited version</span>}
      <AgainTag d={d} />
    </span>
  );
}

export function EditorsPage() {
  const { clock } = useBoot();
  const tz = useDisplayTz();
  const now = useNow();
  const toast = useToast();
  // refreshed every minute, so what each editor is on stays live without reloading
  const q = useQuery({ queryKey: ['editing'], queryFn: () => api<EditingBoard>('/api/editing'), refetchInterval: 60_000 });
  const read = useSave(() => api<EditingBoard>('/api/editing/sync', { body: {} }), {
    onSuccess: (b) => {
      if (b.sync.error) toast(`Couldn’t read Timeliner: ${b.sync.error}`, 'error');
      else toast(readWords(b.sync, Date.now()));
    },
  });
  const readButton = (primary?: boolean) => (
    <Button variant={primary ? 'primary pill' : 'pill tall'} icon={<RefreshCw aria-hidden />} busy={read.isPending} onClick={() => read.mutate(undefined)}>Read Timeliner now</Button>
  );
  const b = q.data;
  return (
    <>
      <PageHeader title="Editors" sub="Who’s on what right now. Videos, steps and deadlines come from Timeliner." hideNewWork>
        {/* what the last read found, and a new read, always at the top once Timeliner has been read */}
        {b?.sync.syncedAt && (
          <div className="ed-read">
            <span className="ed-sync" title={fmtStamp(b.sync.syncedAt, tz)}>{readWords(b.sync, now)}</span>
            {b.sync.keySet && readButton()}
          </div>
        )}
      </PageHeader>
      {q.isLoading && <Loading height={420} />}
      {q.isError && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {b && !b.sync.keySet && !b.sync.syncedAt && <SetupPanel b={b} />}
      {b && b.sync.keySet && !b.sync.syncedAt && (
        <Panel title="Timeliner hasn’t been read yet" className="ed-setup">
          <div className="stack s4">
            {b.sync.error
              ? <div className="banner red" role="alert"><AlertTriangle aria-hidden /><div className="txt"><b>Couldn’t read Timeliner</b><span>{b.sync.error}</span></div></div>
              : <p className="muted">The key is set. The site reads Timeliner a few seconds after it starts, then every few minutes, and each editor’s videos show up here.</p>}
            <FormError error={read.error} />
            <div className="row-flex">{readButton(true)}</div>
          </div>
        </Panel>
      )}
      {b && b.sync.syncedAt && (
        <>
          {b.sync.error && <SyncBanner s={b.sync} now={now} />}
          {!b.sync.keySet && (
            <div className="banner yellow ed-banner" role="status">
              <AlertTriangle aria-hidden />
              <div className="txt"><b>Timeliner isn’t connected any more</b><span>TIMELINER_API_KEY isn’t set on the server, so this is the last copy, read {fmtAgo(b.sync.syncedAt, now)}.</span></div>
            </div>
          )}
          {read.error && <div className="ed-banner"><FormError error={read.error} /></div>}
          {/* nobody and nothing on the board: zeros and all-clears would only look like nothing to do */}
          {(b.editors.length > 0 || b.unassigned.length > 0) && <SummaryCards b={b} now={now} today={clock.today} workspaceTz={clock.timezone} />}
          <ClientStrip b={b} />
          <Panel title="Roster" count={b.editors.length} className="ed-roster"
            sub="Editing now first, then paused, due today, revisions, and who’s free"
            tools={<a className="ed-tl-link" href={TIMELINER_APP} target="_blank" rel="noopener noreferrer"><Layers aria-hidden />Open in Timeliner</a>}>
            <Roster b={b} now={now} tz={tz} today={clock.today} />
          </Panel>
        </>
      )}
    </>
  );
}

/** No key on the server: what to add on Render, and who will be matched. */
function SetupPanel({ b }: { b: EditingBoard }) {
  const { users } = useBoot();
  const people = b.editors.map((e) => users.find((u) => u.id === e.userId)).filter((u): u is NonNullable<typeof u> => !!u);
  return (
    <Panel title="Connect Timeliner" sub="the Editors tab reads it" className="ed-setup">
      <div className="ed-setup-body">
        <span className="ed-setup-ic" aria-hidden><Clapperboard /></span>
        <div className="stack s4" style={{ minWidth: 0 }}>
          <p>Videos are assigned to editors in Timeliner. Once the site can read it, this page shows what each editor is on, what’s on their plate and the script each video is cut from.</p>
          <ol className="ed-steps">
            <li>In Timeliner → Settings → Developers, create an API key with <b>Tasks (read), Projects (read) and Workspace (read)</b>. A read-only key is enough.</li>
            <li>On Render, open this site’s service → <b>Environment</b>, add <b>TIMELINER_API_KEY</b> with that key, and save. Render deploys the site again.</li>
            <li>The site reads Timeliner a few seconds after it starts, then every few minutes. Each editor is matched by the email they use in Timeliner.</li>
          </ol>
          {people.length > 0 && (
            <p className="muted" style={{ fontSize: 13 }}>
              Editors on the site: {people.map((u, i) => <span key={u.id}>{i > 0 && ', '}<b style={{ color: 'var(--text)' }}>{u.name}</b> ({u.email})</span>)}. Their emails in Timeliner should match.
            </p>
          )}
        </div>
      </div>
    </Panel>
  );
}

/**
 * The last read failed: why, in the server's words (Timeliner's own answer, "Timeliner answered 500: …", or that it
 * couldn't be reached), and that what's below is the last good copy (so it never reads as "nothing to do").
 */
function SyncBanner({ s, now }: { s: EditingSync; now: number }) {
  return (
    <div className="banner red ed-banner" role="alert">
      <AlertTriangle aria-hidden />
      <div className="txt">
        <b>Couldn’t read Timeliner just now</b>
        <span>{s.error}{s.syncedAt ? ` Everything below is the copy read ${fmtAgo(s.syncedAt, now)}, so it may be out of date; the site tries again in a few minutes.` : ''}</span>
      </div>
    </div>
  );
}

// ── summary cards ────────────────────────────────────────────────────────

function SummaryCards({ b, now, today, workspaceTz }: { b: EditingBoard; now: number; today: ISODate; workspaceTz: string }) {
  const t = b.totals;
  // the last read failed: an all-clear can't be vouched for, so the cards say how old their copy is instead, in the
  // pill and in the line under the number (phones hide the pill)
  const asOf = b.sync.error && b.sync.syncedAt ? `As of ${fmtAgo(b.sync.syncedAt, now)}` : null;
  const clear = (words: string) => (asOf
    ? <span className="kpi-pill" title="Timeliner couldn’t be read just now">{asOf}</span>
    : <span className="kpi-pill"><Check aria-hidden />{words}</span>);
  const calm = (words: string) => asOf ?? words;
  const kinds = new Map(b.editors.map((e) => [e.key, nowKind(e, now)]));
  const live = b.editors.filter((e) => kinds.get(e.key) === 'live');
  const paused = b.editors.filter((e) => kinds.get(e.key) === 'paused');
  const stale = b.editors.filter((e) => kinds.get(e.key) === 'stale');
  const held = [...paused, ...stale];
  const next = b.editors.find((e) => !e.focus && e.nextUp && !e.offHours) ?? b.editors.find((e) => !e.focus && e.nextUp);

  // 1 · editing now: who tapped "I'm on this", and for how long (one left running isn't counted)
  const liveCard = (
    <KpiCard tone="live" icon={<Scissors />} n={live.length} glint={live.length > 0}
      pill={live.length ? <span className="kpi-pill"><i className="ed-live-dot" aria-hidden />Live</span> : <span className="kpi-pill">{held.length ? 'Nobody editing' : 'Nobody on a video'}</span>}
      cap="Editing now"
      sub={live.length ? names(live.map((e) => first(e.name))) : paused.length ? `${paused.length} paused` : stale.length ? 'Nobody editing right now' : 'Nobody has tapped I’m on this'}
      label={`${plural(live.length, 'editor')} editing now, ${paused.length} paused`}
      foot={(
        <span className="kpi-list">
          {live.slice(0, 3).map((e) => (
            <span key={e.key} className="kpi-row"><span className="ellipsis">{first(e.name)} · <b>{videoName(e.focus!.video)}</b></span><span className="num">{fmtWorked(focusSeconds(e.focus!, now))}</span></span>
          ))}
          {held.slice(0, live.length >= 3 ? 1 : 3 - live.length).map((e) => (
            <span key={e.key} className="kpi-row"><span className="ellipsis"><Pause size={11} aria-hidden /> {first(e.name)} · <b>{videoName(e.focus!.video)}</b></span><span>{e.focus!.state === 'paused' ? 'paused' : 'still marked'}</span></span>
          ))}
          {!live.length && !held.length && (
            <span className="kpi-row"><span>Next up</span><b className="ellipsis">{next ? `${first(next.name)} · ${videoName(next.nextUp!)}` : calm('Nothing on anyone’s plate')}</b></span>
          )}
        </span>
      )} />
  );

  // 2 · due today: still to edit or fix, due today or earlier; the meter is today's videos, each once: due today, and
  // overdue ones still to do or that left the plate today (sent to review in Timeliner, or marked done here)
  const due = b.editors.filter((e) => e.dueToday > 0).sort((a, c) => c.dueToday - a.dueToday);
  const dayOf = (iso: string) => nowInZone(workspaceTz, new Date(iso)).date;
  const leftToday = (v: EditingVideo) => { const at = v.doneAt ?? (isOnPlate(v.state) ? null : v.movedAt); return !!at && dayOf(at) === today; };
  const todays = uniqueVideos(b.editors.flatMap((e) => e.videos))
    .filter((v) => v.due && (v.due === today || (v.due < today && (onPlate(v) || leftToday(v)))));
  const sent = todays.filter((v) => !isOnPlate(v.state)).length;
  const marked = todays.filter((v) => isOnPlate(v.state) && v.doneAt).length;
  const unassignedDue = b.unassigned.filter((g) => g.due && g.due <= today);
  const top = due[0];
  // today's videos all sent to review or marked done: there were some, there's just nothing left to edit
  const dueCard = (
    <KpiCard tone="today" icon={<AlarmClock />} n={t.dueToday}
      pill={due.length ? <span className="kpi-pill">{plural(due.length, 'editor')}</span> : clear(todays.length ? 'Nothing left' : 'Nothing due')}
      cap="Due today"
      sub={top ? `${first(top.name)} · ${videoTitles(top.videos.filter((v) => onPlate(v) && v.due && v.due <= today))} still to edit` : calm(todays.length ? 'Nothing left to edit today' : 'No videos due today')}
      label={`${plural(t.dueToday, 'video')} due today still to edit`}
      foot={todays.length ? (
        <span className="kpi-meter">
          <span className="kpi-row"><span>Sent to review</span><b className="num">{sent} of {todays.length}</b></span>
          <span className="kpi-bar ed-kbar" aria-hidden>
            {sent > 0 && <i style={{ width: `${(sent / todays.length) * 100}%` }} />}
            {marked > 0 && <i className="dn" style={{ width: `${(marked / todays.length) * 100}%` }} />}
          </span>
          {marked > 0 && <span className="kpi-row"><span>Marked done, not sent yet</span><b className="num">{marked}</b></span>}
          {unassignedDue.length > 0 && <span className="kpi-row"><span>Due, no editor yet</span><b className="ellipsis">{unassignedDue.map((g) => naLabel(g, today)).join(', ')}</b></span>}
        </span>
      ) : (
        <span className="kpi-row"><span>{unassignedDue.length ? 'Due, no editor yet' : 'Next due'}</span><b className="ellipsis">{unassignedDue.length ? unassignedDue.map((g) => naLabel(g, today)).join(', ') : nextDue(b, today)}</b></span>
      )} />
  );

  // 3 · revisions: sent back with changes
  const rev = b.editors.filter((e) => e.plate.revisions > 0).sort((a, c) => c.plate.revisions - a.plate.revisions);
  const revCard = (
    <KpiCard tone="revs" icon={<RotateCcw />} n={t.revisions}
      pill={rev.length ? <span className="kpi-pill">{plural(rev.length, 'editor')}</span> : clear('None')}
      cap="Revisions"
      sub={t.revisions ? 'sent back with changes' : calm('Nothing sent back')}
      label={`${plural(t.revisions, 'video')} in revisions`}
      foot={(
        <span className="kpi-list">
          {rev.slice(0, 3).map((e) => {
            const vids = e.videos.filter((v) => v.state === 'revisions' && !v.doneAt);
            const round = Math.max(0, ...vids.map((v) => v.revisionRound));
            return <span key={e.key} className="kpi-row"><span className="ellipsis">{first(e.name)} · <b>{videoTitles(vids)}</b></span><span>{round ? `Round ${round}` : ''}</span></span>;
          })}
          {!rev.length && <span className="kpi-row"><span>{calm('Every video is moving forward')}</span></span>}
        </span>
      )} />
  );

  // 4 · waiting on you: in review in Timeliner, or marked done here. The number is everyone's (the server's);
  // what's left once the editors' own are counted is in review with nobody here (no editor, or one not on the site)
  const waiting = b.editors.flatMap((e) => e.videos.filter((v) => v.state === 'in_review' || v.doneAt).map((v) => ({ e, v })));
  const mine = uniqueVideos(waiting.map((w) => w.v));
  const steps = new Map<string, number>();
  for (const v of mine) if (!v.doneAt) steps.set(v.step, (steps.get(v.step) ?? 0) + 1);
  const markedDone = mine.filter((v) => v.doneAt).length;
  if (markedDone) steps.set('Marked done', markedDone);
  const others = Math.max(0, t.waitingOnYou - mine.length);
  if (others) steps.set('Others', others);
  const oldest = mine.filter((v) => v.state === 'in_review' && v.movedAt).map((v) => v.movedAt!).sort()[0];
  const byEditor = [...new Map(waiting.map(({ e }) => [e.key, e])).values()]
    .map((e) => ({ e, vids: waiting.filter((w) => w.e === e).map((w) => w.v) })).sort((a, c) => c.vids.length - a.vids.length);
  const waitCard = (
    <KpiCard tone="review" icon={<Eye />} n={t.waitingOnYou}
      pill={oldest ? <span className="kpi-pill">Oldest: {fmtAgo(oldest, now)}</span> : t.waitingOnYou ? undefined : clear('Queue clear')}
      cap="Waiting on you"
      sub={steps.size ? [...steps].map(([k, n]) => `${k} ${n}`).join(' · ') : calm('Nothing to review')}
      label={`${plural(t.waitingOnYou, 'video')} waiting on your review`}
      foot={(
        <span className="kpi-list">
          {byEditor.slice(0, others ? 2 : 3).map(({ e, vids }) => (
            <span key={e.key} className="kpi-row"><span className="ellipsis">{first(e.name)} · {videoTitles(vids)}</span><b className="num">{vids.length}</b></span>
          ))}
          {others > 0 && <span className="kpi-row"><span className="ellipsis">Others in Timeliner</span><b className="num">{others}</b></span>}
          {!byEditor.length && !others && <span className="kpi-row"><span>{calm('Nothing sent to review yet')}</span></span>}
        </span>
      )} />
  );

  return <div className="kpis">{liveCard}{dueCard}{revCard}{waitCard}</div>;
}

/** "Fri, Oct 9 · Leo": the soonest deadline still on someone's plate. */
function nextDue(b: EditingBoard, today: ISODate): string {
  const all = b.editors.flatMap((e) => e.videos.filter((v) => onPlate(v) && v.due).map((v) => ({ e, v })))
    .sort((a, c) => a.v.due!.localeCompare(c.v.due!));
  const n = all[0];
  return n ? `${dueWords(n.v.due, today)!.text.replace(/^Due /, '')} · ${first(n.e.name)}` : 'Nothing scheduled';
}

// ── editors by client ────────────────────────────────────────────────────

/** Clients shown before "Show all" (flagged ones always show: the server lists them first). */
const CLIENT_TILES = 12;
/** On a phone, where each client is one line: the rest fold away so the roster stays near the top. */
const PHONE_TILES = 4;

/** A client's flag without its name, which its tile already shows ("18 with Maya, 3 with Sam — one editor per client"). */
function flagWords(c: ClientEditing, text: string): string {
  if (!c.name || !text.startsWith(c.name)) return text;
  const rest = text.slice(c.name.length).replace(/^\s*[:·]\s*/, '').trim();
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : text;
}

/**
 * Each client and its editor (one editor per client, worked out from Timeliner): the one assigned to the client
 * there, else whoever has most of its recent videos. Its open videos, and a chip when they're split across
 * editors or some aren't assigned. A tile whose editor has a card goes to it. The clients to look at come first
 * and always show; on a phone each client is one line, and the rest fold away after a few.
 */
function ClientStrip({ b }: { b: EditingBoard }) {
  const [all, setAll] = useState(false);
  const listId = useId();
  if (!b.clients.length) return null;
  const cards = new Set(b.editors.map((e) => e.key));
  const folds = (cap: number) => (c: ClientEditing, i: number) => !c.flags.length && i >= cap;
  const shown = all ? b.clients : b.clients.filter((c, i) => !folds(CLIENT_TILES)(c, i));
  const foldedHere = b.clients.filter(folds(CLIENT_TILES)).length;
  const foldedOnPhone = b.clients.filter(folds(PHONE_TILES)).length;
  const flagged = b.clients.filter((c) => c.flags.length > 0).length;
  return (
    <Panel title="Editors by client" count={b.clients.length} className="ed-clients"
      sub={flagged ? `one editor per client · ${plural(flagged, 'client')} to look at` : 'one editor per client, from Timeliner'}>
      <ul className="ed-ct-list" id={listId}>
        {shown.map((c, i) => (
          <li key={c.key} className={!all && folds(PHONE_TILES)(c, i) ? 'ed-ct-fold' : undefined}>
            <ClientTile c={c} card={!!c.editor && cards.has(c.editor.key)} />
          </li>
        ))}
      </ul>
      {foldedOnPhone > 0 && (
        // only a phone folds any away when there are few clients
        <button type="button" className={`ed-vbtn ed-ct-more${foldedHere ? '' : ' phone'}`} aria-expanded={all} aria-controls={listId} onClick={() => setAll((x) => !x)}>
          {all ? 'Show fewer' : `Show all ${b.clients.length} clients`}<ChevronDown className={`chev${all ? ' up' : ''}`} aria-hidden />
        </button>
      )}
    </Panel>
  );
}

function ClientTile({ c, card }: { c: ClientEditing; card: boolean }) {
  const ed = c.editor;
  const body = (
    <>
      <span className="ed-ct-top">
        <b className="ed-ct-name">{c.name}</b>
        <span className="ed-ct-open num">{c.open ? `${c.open} open` : 'nothing open'}</span>
      </span>
      <span className="ed-ct-ed">
        <ArrowRight aria-hidden />
        {ed ? <b className="ellipsis">{ed.name}</b> : <span className="muted">No editor yet</span>}
        {ed && c.editors.length > 1 && <span className="muted">+{c.editors.length - 1}</span>}
        {ed && (c.editorFrom === 'client'
          ? <span className="ed-via" title="Assigned to this client in Timeliner">assigned in Timeliner</span>
          : <span className="ed-via" title="Nobody is assigned to this client in Timeliner: they have the most of its videos made in the last 60 days">most of its videos</span>)}
      </span>
      {c.flags.length > 0 && (
        <span className="ed-ct-flags">{c.flags.map((f) => <Chip key={f} color="yellow" dot title={f}>{flagWords(c, f)}</Chip>)}</span>
      )}
    </>
  );
  return card && ed
    ? <a className="ed-ct go" href={`#${cardId(ed.key)}`} onClick={goToCard(ed.key)}>{body}</a>
    : <div className="ed-ct">{body}</div>;
}

// ── roster ───────────────────────────────────────────────────────────────

function Roster({ b, now, tz, today }: { b: EditingBoard; now: number; tz: string; today: ISODate }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  // every bar against the fullest plate, so they compare at a glance
  const scale = Math.max(1, ...b.editors.map(plateTotal));
  return (
    <>
      {!b.editors.length && <NoEditors b={b} now={now} />}
      <FixPeople list={b.editors} />
      <MatchStrip b={b} />
      {b.editors.length > 0 && (
        <div className="ed-colhead" aria-hidden><span>Editor</span><span>Right now</span><span>On their plate this week</span></div>
      )}
      <div className="ed-list">
        {b.editors.map((e) => (
          <EditorCard key={e.key} e={e} b={b} scale={scale} now={now} tz={tz} today={today} open={open.has(e.key)} onToggle={() => toggle(e.key)} />
        ))}
        {b.unassigned.length > 0 && <NotAssigned b={b} today={today} />}
      </div>
      {b.editors.length > 0 && <WholeTeam b={b} now={now} />}
      <Legend />
    </>
  );
}

/**
 * Nobody on the roster: Timeliner's last read found no videos assigned to anyone and nobody on the site is an
 * editor. Never an all-clear when the last read failed: then it says the copy may be out of date.
 */
function NoEditors({ b, now }: { b: EditingBoard; now: number }) {
  const c = b.sync.counts;
  if (b.sync.error) {
    return (
      <Empty boxed icon={<AlertTriangle />} title="Nothing to show until Timeliner can be read">
        The last read failed (see above), and the copy read {b.sync.syncedAt ? fmtAgo(b.sync.syncedAt, now) : 'before'} had no videos assigned to anyone. Read Timeliner now, or wait for the next read in a few minutes.
      </Empty>
    );
  }
  return (
    <Empty boxed icon={<Users />} title="No editors yet">
      {c && (c.videos === 0
        ? <>The last read found no videos in Timeliner. If there should be some, check that the API key can read Tasks and Projects. </>
        : <>The last read found {plural(c.videos, 'video')} in Timeliner, none of them assigned to anyone or to their client. </>)}
      Give someone the Editor role in <Link className="link" to="/settings#team">Settings → Team</Link>, with the email they use in Timeliner. Everyone with videos in Timeliner shows up here too.
    </Empty>
  );
}

/** One line above the cards: the people whose cards are flagged (not on the site, or another email here), each a link to their card. */
function FixPeople({ list }: { list: EditorRow[] }) {
  const fix = list.filter((e) => needsFix(e.flag));
  if (!fix.length) return null;
  return (
    <div className="ed-fix" role="group" aria-label={fix.length === 1 ? 'Fix this person' : 'Fix these people'}>
      <UserPlus aria-hidden />
      <b className="ed-fix-h">{fix.length === 1 ? 'Fix this person' : 'Fix these people'}</b>
      <span className="ed-fix-list">
        {fix.map((e) => (
          <a key={e.key} className="ed-fix-who" href={`#${cardId(e.key)}`} onClick={goToCard(e.key)}>
            {e.name}<span className="muted"> · {FIX_WORDS[e.flag!.kind]}</span>
          </a>
        ))}
      </span>
      <span className="muted ed-fix-how">Each card says which email to use.</span>
    </div>
  );
}

/** One client on a card ("Joshua Shalimar · 32 videos"), with whether they're its editor in Timeliner and whether it has scripts here. */
interface CardClient { key: string; name: string; count: number; via: boolean; noScripts: boolean }

/** Their clients, most first: the card's, then any client they're the editor of in Timeliner with none of its videos theirs. */
function cardClients(e: EditorRow, b: EditingBoard): CardClient[] {
  const same = (name: string, a: string) => name.trim().toLowerCase() === a.trim().toLowerCase();
  const out: CardClient[] = e.clients.map((c, i) => {
    const vids = e.videos.filter((v) => (c.clientId != null ? v.client?.id === c.clientId : !v.client && same(clientName(v) ?? '', c.name)));
    return { key: `${c.clientId ?? 'b'}|${c.name}|${i}`, name: c.name, count: c.count, via: c.viaClient, noScripts: vids.length > 0 && vids.every(noScripts) };
  });
  for (const c of b.clients) {
    if (!c.editors.some((x) => x.key === e.key)) continue;
    if (e.clients.some((k) => (k.clientId != null ? k.clientId === c.clientId : c.clientId == null && same(k.name, c.name)))) continue;
    out.push({ key: c.key, name: c.name, count: 0, via: true, noScripts: false });
  }
  return out;
}

const escapeRe = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A line of text with the emails in it in bold: the email to use is what the person acts on. */
function Emphasize({ text, words }: { text: string; words: (string | null)[] }) {
  const list = [...new Set(words.filter((w): w is string => !!w && text.includes(w)))];
  if (!list.length) return <>{text}</>;
  const re = new RegExp(`(${list.map(escapeRe).join('|')})`);
  return <>{text.split(re).map((part, i) => (list.includes(part) ? <b key={i}>{part}</b> : part))}</>;
}

/** Why a card needs fixing, with the email to use and where to fix it (Settings → Team, or Settings → Editors for an Admin). */
function FlagLine({ f }: { f: EditorFlag }) {
  const { me } = useBoot();
  const go = f.kind === 'no_site_access'
    ? (isAdmin(me.role) ? <Link className="ed-flag-go" to="/settings#editors">Settings → Editors</Link> : <span className="ed-flag-who">an Admin can do this in Settings → Editors</span>)
    : <Link className="ed-flag-go" to="/settings#team">Settings → Team</Link>;
  return (
    <span className="ed-flag fix">
      <UserPlus aria-hidden />
      <span className="ed-flag-t"><Emphasize text={f.text} words={[f.timelinerEmail, f.siteEmail]} /></span>
      {go}
    </span>
  );
}

function EditorCard({ e, b, scale, now, tz, today, open, onToggle }: {
  e: EditorRow; b: EditingBoard; scale: number; now: number; tz: string; today: ISODate; open: boolean; onToggle: () => void;
}) {
  const drillId = useId();
  const kind = nowKind(e, now);
  const f = e.focus;
  const city = e.city?.split(',')[0] ?? null;
  const local = localTime(e.timezone, now);
  // the clients they edit for lead the card ("Joshua Shalimar · 32 videos"); a client split across editors is flagged
  const clients = cardClients(e, b);
  const splits = [...new Set(e.clients.map((c) => c.split).filter((x): x is string => !!x))];
  const fix = needsFix(e.flag) ? e.flag : null;
  // a site editor with nothing in Timeliner: a quiet note where Right now would say what they're on
  const nothing = e.flag?.kind === 'nothing_assigned' ? e.flag.text : null;
  const brandOnly = clients.filter((c) => !c.count);
  const plate = e.videos.filter(onPlate);
  const overdue = plate.filter((v) => v.due && v.due < today).length;
  const soonest = plate.map((v) => v.due).filter((d): d is string => !!d).sort()[0] ?? null;

  // the pills under their name
  const pills: ReactNode[] = [];
  if (overdue) pills.push(<Chip key="late" color="red" icon={<AlertTriangle aria-hidden />}>{overdue} overdue</Chip>);
  else if (e.dueToday) pills.push(<Chip key="due" color="yellow" dot>{e.dueToday} due today</Chip>);
  if (e.plate.revisions) pills.push(<Chip key="rv" color="pink">{plural(e.plate.revisions, 'revision')}</Chip>);
  const off = offLabel(e, now);
  if (off) pills.push(<Chip key="off" color="plain">{off}</Chip>);
  // their open videos the site couldn't match to a shoot, or whose match is worth a look (Videos shows which)
  const unmatched = e.videos.filter(notMatched).length;
  const toCheck = e.videos.filter(needsCheck).length;
  if (unmatched) pills.push(<Chip key="nm" color="yellow" icon={<CircleHelp aria-hidden />} title="Not matched to a shoot: open Videos to pin them">{unmatched} not matched</Chip>);
  if (toCheck) pills.push(<Chip key="ck" color="plain" icon={<AlertTriangle aria-hidden />} title="Two videos in one folder have the same title on the same shoot: open Videos to check">{toCheck} to check</Chip>);

  // right now
  const video = f?.video ?? (kind === 'next' ? e.nextUp : null);
  const secs = f ? focusSeconds(f, now) : 0;
  const tt = tileTime(secs);
  const hours = e.workHours ? hoursText(e.workHours) : null;
  let tile: ReactNode;
  let eyebrow: ReactNode;
  let big: { text: string; cls: string; raw?: boolean };
  let note: { text: string; cls?: string };
  if (kind === 'live') {
    tile = <span className="ed-tile live" role="img" aria-label={`Editing now, ${fmtWorked(secs)} on it`}><span className="dt-glint" aria-hidden /><span className="ed-tn">{tt.n}</span><span className="ed-tu">{tt.unit}</span></span>;
    eyebrow = <span className="ed-eyebrow-row"><Chip color="cyan" icon={<i className="ed-live-dot" aria-hidden />}>Editing now</Chip><span className="ed-since num">since {clockTime(f!.since, tz)}</span></span>;
    big = { text: f!.video.title, cls: 'live', raw: f!.video.raw };
    note = { text: `Timeliner: ${f!.video.step}${f!.video.state === 'revisions' && f!.video.revisionRound ? ` · round ${f!.video.revisionRound}` : ''}` };
  } else if (kind === 'stale') {
    // tapped I'm on this and never paused: say so, without claiming they're editing
    tile = <span className="ed-tile stale" role="img" aria-label={`Still marked as editing, ${fmtWorked(secs)}`}><TimerOff className="ed-ti" aria-hidden /><span className="ed-tn">{tt.n}</span><span className="ed-tu">{tt.unit}</span></span>;
    eyebrow = <span className="ed-eyebrow-row"><Chip color="plain" icon={<TimerOff aria-hidden />}>Still marked as editing</Chip><span className="ed-since num">since {fmtWhen(f!.since, tz, now)}</span></span>;
    big = { text: f!.video.title, cls: 'quiet', raw: f!.video.raw };
    note = { text: `${e.offHours ? 'Outside their working hours' : `Over ${FOCUS_STALE_HOURS} hours without a pause`}, so maybe left running · Timeliner: ${f!.video.step}` };
  } else if (kind === 'paused') {
    tile = <span className="ed-tile paused" role="img" aria-label={`Paused, ${fmtWorked(secs)} on it`}><Pause className="ed-ti" aria-hidden /><span className="ed-tn">{tt.n}</span><span className="ed-tu">{tt.unit}</span></span>;
    eyebrow = (
      <span className="ed-eyebrow-row">
        <Chip color="yellow" icon={<Pause aria-hidden />}>Paused</Chip>
        {f!.video.state === 'revisions' && <Chip color="pink">Revisions{f!.video.revisionRound ? ` · round ${f!.video.revisionRound}` : ''}</Chip>}
      </span>
    );
    big = { text: f!.video.title, cls: 'paused', raw: f!.video.raw };
    note = { text: `Paused ${f!.pausedAt ? fmtAgo(f!.pausedAt, now) : ''} · ${fmtWorked(secs)} on it`, cls: 'paused' };
  } else if (kind === 'next') {
    tile = <span className="ed-tile next" aria-hidden><Sunrise /><span className="ed-tu">Next</span></span>;
    eyebrow = <span className="ed-eyebrow">Next up · {e.nextUp!.state === 'revisions' ? 'revisions first' : 'soonest due'}</span>;
    big = { text: e.nextUp!.title, cls: 'quiet', raw: e.nextUp!.raw };
    const d = dueWords(e.nextUp!.due, today);
    note = e.offHours
      ? { text: `Off hours${hours ? ` · works ${hours} their time` : ''}` }
      : { text: [d?.text, `Timeliner: ${e.nextUp!.step}`].filter(Boolean).join(' · '), cls: d?.tone === 'late' ? 'late' : d?.tone === 'today' ? 'today' : undefined };
  } else if (kind === 'off') {
    tile = <span className="ed-tile off" aria-hidden><Moon /><span className="ed-tu">Off</span></span>;
    eyebrow = <span className="ed-eyebrow off">{[city, local].filter(Boolean).join(' ') || 'Off hours'}</span>;
    big = { text: 'Off hours', cls: 'quiet' };
    note = { text: nothing ?? `Nothing to edit${hours ? ` · works ${hours} their time` : ''}` };
  } else {
    // nothing to edit: what they do have, if anything, is with you, with the client or approved
    tile = <span className="ed-tile clear" aria-hidden><CircleCheck /><span className="ed-tu">Clear</span></span>;
    eyebrow = <span className="ed-eyebrow">Nothing to edit</span>;
    big = { text: e.plate.inReview ? 'Waiting on review' : e.plate.withClient ? 'With the client' : e.videos.length ? 'All approved' : 'Nothing assigned', cls: 'quiet' };
    const has = [
      e.plate.inReview && `${plural(e.plate.inReview, 'video')} with you to review`,
      e.plate.withClient && `${e.plate.withClient} with the client`,
      e.plate.approvedWeek && `${e.plate.approvedWeek} approved this week`,
    ].filter(Boolean);
    note = {
      text: has.length ? has.join(' · ')
        : nothing ?? (brandOnly.length
          ? `Editor of ${names(brandOnly.map((c) => c.name))} in Timeliner; ${brandOnly.length === 1 ? 'its' : 'their'} videos are assigned to others`
          : 'Nothing assigned to them in Timeliner'),
    };
  }

  // their plate: raw camera clips to cut read as clips ("24 clips to edit")
  const total = plateTotal(e);
  const clips = e.plate.rawToEdit;
  const totalText = !clips ? plural(total, 'video') : total > clips ? `${plural(total - clips, 'video')} · ${clips} ${clips === 1 ? 'clip' : 'clips'} to edit` : `${clips} ${clips === 1 ? 'clip' : 'clips'} to edit`;
  const dueText = overdue ? { text: `${overdue} overdue`, cls: 'late' }
    : e.dueToday ? { text: `${e.dueToday} due today`, cls: 'today' }
    : soonest ? { text: dueWords(soonest, today)!.text, cls: 'plain' }
    : e.plate.inReview && !plate.length ? { text: 'All waiting on your review', cls: 'review' } : null;
  const segs = plateSegments(e);

  const last = e.lastFinished;
  // when it was in their zone, unless this browser doesn't know that zone
  const lastLocal = last && e.timezone && e.timezone !== tz && now - Date.parse(last.at) >= 3600_000 ? localTime(e.timezone, Date.parse(last.at)) : null;
  const theirs = lastLocal ? ` (${lastLocal} ${city ? `in ${city}` : 'their time'})` : '';

  return (
    <article id={cardId(e.key)} tabIndex={-1} className={`ed-card ${kind}`} aria-label={e.name}>
      {(fix || splits.length > 0) && (
        <div className="ed-flags">
          {fix && <FlagLine f={fix} />}
          {splits.map((t) => <span key={t} className="ed-flag split"><Users aria-hidden /><span className="ed-flag-t">{t}</span></span>)}
        </div>
      )}
      <div className="ed-who">
        <span className="ed-av"><Avatar name={e.name} id={e.userId} /></span>
        <div className="ed-who-txt">
          <h3 className="ed-name ellipsis">{e.name}</h3>
          {clients.length > 0 && (
            <div className="ed-clients-line">
              {clients.slice(0, 2).map((c) => (
                <span key={c.key} className="ed-cli">
                  <b>{c.name}</b> · {c.count ? plural(c.count, 'video') : 'its editor in Timeliner'}
                  {c.via && c.count > 0 && <span className="ed-via" title="Assigned to this client in Timeliner, so its videos nobody else is on are theirs">via client</span>}
                  {c.noScripts && <span className="ed-via" title="This client has no scripts on the site">no scripts on the site</span>}
                </span>
              ))}
              {clients.length > 2 && <span className="muted" title={clients.slice(2).map((c) => `${c.name} · ${c.count ? plural(c.count, 'video') : 'its editor in Timeliner'}`).join(', ')}>+{clients.length - 2} more</span>}
            </div>
          )}
          <div className="ed-place num">{[city, local].filter(Boolean).join(' · ') || (e.site ? 'Time zone not set' : 'Only in Timeliner')}</div>
          {pills.length > 0 && <div className="ed-pills">{pills}</div>}
        </div>
      </div>

      <div className="ed-now">
        {tile}
        <div className="ed-now-txt">
          {eyebrow}
          <span className={`ed-big ${big.cls}${big.text.length > 22 ? ' long' : ''}`}>{big.raw ? <VideoName v={{ title: big.text, raw: true }} /> : big.text}</span>
          {video && <span className="ed-line"><ScriptLink v={video} who="manager" today={today} />{shootLabel(video, today) && <> · {shootLabel(video, today)}</>}</span>}
          <span className={`ed-note${note.cls ? ` ${note.cls}` : ''}`}>{note.text}</span>
        </div>
      </div>

      <div className="ed-plate">
        <div className="ed-plate-top">
          <span className="ed-total num">{totalText}</span>
          {dueText && <span className={`ed-due ${dueText.cls}`}>{dueText.text}</span>}
        </div>
        <div className="ed-bar" role="img" aria-label={segs.length ? segs.map((s) => s.label).join(', ') : 'No videos'}>
          {segs.map((s) => <span key={s.c} className={`c-${s.c}`} style={{ width: `calc(${(s.n / scale) * 100}% - 2px)` }} title={s.label} />)}
        </div>
        <Counts list={stateCounts(e.videos)} />
      </div>

      <div className="ed-foot">
        {e.scripts.slice(0, 3).map((d) => <DocLink key={d.href} d={d} />)}
        {e.scripts.length > 3 && <span className="muted">+{e.scripts.length - 3} more</span>}
        <span className="ed-last">
          {last ? (
            <>
              <span><History className="ed-last-ic" aria-hidden /><b className={last.onSite ? 'site' : undefined}>Last finished {last.title}</b> · {last.onSite ? 'marked done' : 'sent to review'} {fmtWhen(last.at, tz, now)}{theirs}</span>
              {last.onSite
                ? <span className="ed-src site" title="Marked done on the site"><Check aria-hidden />on the site</span>
                : <span className="ed-src tl" title="Moved on in Timeliner">in Timeliner</span>}
            </>
          ) : <span><History className="ed-last-ic" aria-hidden />Nothing finished yet</span>}
        </span>
        {e.videos.length > 0 && (
          <button type="button" className="ed-vbtn" aria-expanded={open} aria-controls={drillId} onClick={onToggle}>
            {open ? 'Hide videos' : 'Videos'}<span className="sr-only">, {e.name}</span><ChevronDown className={`chev${open ? ' up' : ''}`} aria-hidden />
          </button>
        )}
      </div>

      {open && <Drill id={drillId} e={e} today={today} tz={tz} now={now} />}
    </article>
  );
}

/** "Starts 9 AM" before their day begins, "Back 9 AM their time" after it ends. */
function offLabel(e: EditorRow, now: number): string | null {
  if (!e.offHours || !e.workHours || !e.timezone) return null;
  try {
    const h = nowInZone(e.timezone, new Date(now)).minutes / 60;
    return h < e.workHours[0] ? `Starts ${fmtHour(e.workHours[0])}` : `Back ${fmtHour(e.workHours[0])} their time`;
  } catch {
    return null;
  }
}

/** Their videos as bar segments: what they're on, then to edit, revisions, marked done, review, client, approved. */
function plateSegments(e: EditorRow): { c: string; n: number; label: string }[] {
  const f = e.focus;
  const rest = e.videos.filter((v) => v.id !== f?.video.id);
  const count = (fn: (v: EditingVideo) => boolean) => rest.filter(fn).length;
  const parts = [
    { c: f?.state === 'on' ? 'now' : 'pa', n: f ? 1 : 0, label: f ? `${videoName(f.video)} ${f.state === 'on' ? 'editing now' : 'paused'}` : '' },
    { c: 'ed', n: count((v) => v.state === 'to_edit' && !v.doneAt), label: count((v) => v.state === 'to_edit' && !v.doneAt && !v.raw) ? 'to edit' : 'clips to edit' },
    { c: 'rv', n: count((v) => v.state === 'revisions' && !v.doneAt), label: 'in revisions' },
    { c: 'dn', n: count((v) => !!v.doneAt), label: 'marked done' },
    { c: 'ir', n: count((v) => v.state === 'in_review'), label: 'in review' },
    { c: 'cl', n: count((v) => v.state === 'with_client'), label: 'with the client' },
    { c: 'ap', n: count((v) => v.state === 'approved'), label: 'approved this week' },
  ];
  return parts.filter((p) => p.n > 0).map((p) => ({ ...p, label: p.c === 'now' || p.c === 'pa' ? p.label : `${p.n} ${p.label}` }));
}

/** Squares shown in each of the drill-down's groups before "+N". */
const SQUARES = 60;

/** The drill-down: their videos by state, one square each. Tap one for its shoot, how it was matched, and a pin. */
function Drill({ id, e, today, tz, now }: { id: string; e: EditorRow; today: ISODate; tz: string; now: number }) {
  const [picked, setPicked] = useState<string | null>(null);
  const detailId = useId();
  const f = e.focus;
  const rest = e.videos.filter((v) => v.id !== f?.video.id);
  // what needs a manager (not matched, to check) first, so it's never folded into "+N"
  const flagged = (v: EditingVideo) => notMatched(v) || needsCheck(v);
  const pick = (fn: (v: EditingVideo) => boolean) => rest.filter(fn).sort((a, b) => Number(flagged(b)) - Number(flagged(a)) || byTitle(a, b));
  const soon = (vs: EditingVideo[]) => { const d = vs.map((v) => v.due).filter((x): x is string => !!x).sort()[0]; return d ? midSentence(dueWords(d, today)!.text) : 'no deadline'; };
  const stepsOf = (vs: EditingVideo[]) => [...new Set(vs.map((v) => v.step))].join(', ');
  const groups: { key: string; c: string; label: string; sub: string; vids: EditingVideo[] }[] = [];
  if (f) groups.push({ key: 'now', c: f.state === 'on' ? 'now' : 'pa', label: f.state === 'on' ? 'Editing now' : 'Paused', sub: `${shootLabel(f.video, today) || f.video.step} · ${fmtWorked(focusSeconds(f, now))} on it`, vids: [f.video] });
  const rv = pick((v) => v.state === 'revisions' && !v.doneAt);
  if (rv.length) groups.push({ key: 'rv', c: 'rv', label: 'Revisions', sub: `round ${Math.max(...rv.map((v) => v.revisionRound)) || 1} · ${soon(rv)}`, vids: rv });
  const ed = pick((v) => v.state === 'to_edit' && !v.doneAt);
  if (ed.length) groups.push({ key: 'ed', c: 'ed', label: 'To edit', sub: soon(ed), vids: ed });
  const dn = pick((v) => !!v.doneAt);
  if (dn.length) groups.push({ key: 'dn', c: 'dn', label: 'Marked done', sub: `moves on when it’s in Needs review · ${fmtWhen(dn.map((v) => v.doneAt!).sort().reverse()[0], tz, now)}`, vids: dn });
  const ir = pick((v) => v.state === 'in_review');
  if (ir.length) groups.push({ key: 'ir', c: 'ir', label: 'In review', sub: stepsOf(ir), vids: ir });
  const cl = pick((v) => v.state === 'with_client');
  if (cl.length) groups.push({ key: 'cl', c: 'cl', label: 'With client', sub: stepsOf(cl), vids: cl });
  const ap = pick((v) => v.state === 'approved');
  if (ap.length) groups.push({ key: 'ap', c: 'ap', label: 'Approved this week', sub: [...new Set(ap.map((v) => shootLabel(v, today)).filter(Boolean))].join(', ') || 'Approved', vids: ap });
  const all = groups.flatMap((g) => g.vids.map((v) => ({ v, c: g.c })));
  const sel = all.find((x) => x.v.id === picked) ?? null;
  const unmatched = all.filter((x) => notMatched(x.v)).length;
  const toCheck = all.filter((x) => needsCheck(x.v)).length;
  // a client without scripts on the site has no shoot to match its videos to
  const noneToMatch = all.length > 0 && all.every((x) => x.v.match.how === 'no_scripts');
  return (
    <div className="ed-drill" id={id}>
      <p className="ed-drill-hint">
        {noneToMatch ? 'No scripts on the site for these videos, so there’s no shoot to match them to. Tap one to see it.' : 'Tap a video to see which shoot it was matched to, and pin it if that’s wrong.'}
        {unmatched > 0 && <span className="ed-drill-key"><i className="ed-sq c-ed lg nm" aria-hidden /><b>{unmatched} not matched</b></span>}
        {toCheck > 0 && <span className="ed-drill-key"><i className="ed-sq c-ed lg ck" aria-hidden /><b>{toCheck} to check</b></span>}
      </p>
      {groups.map((g) => {
        // sixty squares a group, and every one that needs a manager however many there are
        const shown = Math.max(SQUARES, g.vids.filter(flagged).length);
        return (
        <div key={g.key} className="ed-group">
          <div className="ed-group-h">{g.label} · {videoTitles(g.vids)} <span>· {g.sub}</span></div>
          <ul className="ed-sqs pick">
            {g.vids.slice(0, shown).map((v) => {
              const nm = notMatched(v);
              const ck = !nm && needsCheck(v);
              return (
                <li key={v.id}>
                  <button type="button" className={`ed-sqb${picked === v.id ? ' on' : ''}`} aria-expanded={picked === v.id} aria-controls={detailId}
                    title={`${videoName(v)} · ${v.step}${nm ? ' · not matched' : ck ? ' · check' : ''}`} onClick={() => setPicked((p) => (p === v.id ? null : v.id))}>
                    <span className={`ed-sq c-${g.c}${nm ? ' nm' : ck ? ' ck' : ''}`} aria-hidden>{squareOf(v)}</span>
                    <span className="sr-only">{videoName(v)}, {v.step}{nm ? ', not matched to a shoot' : ck ? ', worth a check' : ''}</span>
                  </button>
                </li>
              );
            })}
            {g.vids.length > shown && <li className="ed-sq more">+{g.vids.length - shown}</li>}
          </ul>
        </div>
        );
      })}
      <div id={detailId} className="ed-vd-slot">
        {sel && <VideoDetail key={sel.v.id} v={sel.v} c={sel.c} today={today} onClose={() => setPicked(null)} />}
      </div>
    </div>
  );
}

/** One video from the drill-down: its shoot, how sure that is and why, its script, and Wrong shoot? Pin it. */
function VideoDetail({ v, c, today, onClose }: { v: EditingVideo; c: string; today: ISODate; onClose: () => void }) {
  const toast = useToast();
  const [pinning, setPinning] = useState(false);
  const pinned = v.match.how === 'pinned';
  const nm = notMatched(v);
  // its client has no scripts on the site (or isn't a site client): normal work, nothing to pin it to
  const ns = noScripts(v);
  // its client has no batches at all: no pin. A brand no client is named like may still be one of theirs, so it
  // can be pinned (quietly: no nag, not counted as not matched)
  const canPin = !ns || v.match.how === 'no_client';
  const who = clientName(v);
  const unpin = useSave(() => api<EditingBoard>(`/api/editing/videos/${encodeURIComponent(v.id)}/pin`, { method: 'DELETE' }), {
    onSuccess: () => toast(`Took the pin off ${videoName(v)}. The site matches it by itself again.`),
  });
  return (
    <section className="ed-vd" aria-label={`${videoName(v)}: its shoot`}>
      <div className="ed-vd-top">
        <span className={`ed-sq c-${c}`} aria-hidden>{squareOf(v)}</span>
        <div className="ed-vd-title">
          <b><VideoName v={v} /></b>
          <span className="muted">Timeliner: {v.step}{v.folder ? ` · ${v.folder}` : ''}</span>
        </div>
        <button type="button" className="icon-btn ed-vd-x" aria-label={`Close ${videoName(v)}`} onClick={onClose}><X aria-hidden /></button>
      </div>
      <div className="ed-vd-line">
        <span className="ed-vd-shoot">
          {v.batch
            ? <>{v.client && `${v.client.name} · `}<Link className="link" to={`/batches/${v.batch.id}`}>{v.batch.title}</Link>{v.batch.shootDate && ` · shoot ${fmtDate(v.batch.shootDate, today)}`}</>
            : pinned ? 'Not from any batch' : ns ? who ?? 'In Timeliner' : who ? `${who} · no shoot yet` : 'No client or shoot yet'}
        </span>
        {!v.client && v.brand && <span className="ed-via" title="Its brand (client) in Timeliner, which isn’t a client on the site">Timeliner brand</span>}
        {ns && <Chip color="plain" icon={<FileX aria-hidden />}>No scripts on the site</Chip>}
        {v.assignedBy === 'client' && <span className="ed-via" title="Nobody is assigned on this video in Timeliner: it’s its client’s, and the client’s editor there has it">via client</span>}
        {nm && <Chip color="yellow" icon={<CircleHelp aria-hidden />}>Not matched</Chip>}
        {v.match.check && <Chip color="yellow" icon={<AlertTriangle aria-hidden />}>Check</Chip>}
        {pinned && <Chip color="plain" icon={<Pin aria-hidden />}>Pinned</Chip>}
        {v.batch && !v.match.sure && <Chip color="plain">matched by date</Chip>}
        {v.match.kept && <Chip color="plain" title="It has been in review, so changes on the site don’t move it">Kept</Chip>}
      </div>
      {(v.match.note || v.match.check) && (
        <p className="ed-vd-note">
          {v.match.note}
          {v.match.check && <>{v.match.note && ' · '}Another video in the same folder has this title on the same shoot, so one of them may be from another shoot.</>}
        </p>
      )}
      {v.batch && <div className="ed-vd-line"><ScriptLink v={v} who="manager" today={today} /></div>}
      {!pinning && canPin && (
        <div className="ed-vd-acts">
          <Button variant={ns ? 'ghost tall' : 'tall'} icon={<Pin aria-hidden />} onClick={() => setPinning(true)}>{pinned ? 'Change the pin' : v.batch ? 'Wrong shoot? Pin it' : 'Pin it to its shoot'}</Button>
          {pinned && <Button variant="ghost tall" icon={<PinOff aria-hidden />} busy={unpin.isPending} onClick={() => unpin.mutate(undefined)}>Unpin</Button>}
        </div>
      )}
      <FormError error={unpin.error} />
      {pinning && <PinForm v={v} today={today} onDone={() => setPinning(false)} />}
    </section>
  );
}

/** "JS · Oct 14 · shoot Oct 14, 2026" for the batch list, without saying the date twice. */
const batchOption = (b: BatchSummary, today: ISODate, now: number | null) => {
  const date = b.shootStart ? fmtDate(b.shootStart, today) : null;
  return `${b.title}${date && !b.title.includes(date) ? ` · shoot ${date}` : ''}${b.archivedAt ? ' · archived' : ''}${b.id === now ? ' (matched now)' : ''}`;
};

/**
 * Pin a video to a batch of its client (and maybe a script), or to no batch. The pin holds through every read of
 * Timeliner until a manager takes it off.
 */
function PinForm({ v, today, onDone }: { v: EditingVideo; today: ISODate; onDone: () => void }) {
  const toast = useToast();
  const batchId = useFieldId('pin-batch');
  const numId = useFieldId('pin-script');
  const clientId = v.client?.id ?? null;
  // archived and long-delivered batches too: a video can be from any of the client's shoots
  const list = useQuery({
    queryKey: ['batches', 'pin', clientId],
    queryFn: () => api<{ batches: BatchSummary[] }>(`/api/batches${qs({ clientId, archived: 1, completed: 1 })}`),
  });
  const pinned = v.match.how === 'pinned';
  // a pin starts from itself; anything else from a blank choice, so the match it may be wrong about isn't one tap away
  const [choice, setChoice] = useState(pinned ? (v.batch ? String(v.batch.id) : 'none') : '');
  const [num, setNum] = useState(pinned && v.scriptNumber != null ? String(v.scriptNumber) : '');
  const save = useSave((body: { batchId: number | null; scriptNumber: number | null }) =>
    api<EditingBoard>(`/api/editing/videos/${encodeURIComponent(v.id)}/pin`, { body }), {
    onSuccess: (_b, body) => {
      const b = list.data?.batches.find((x) => x.id === body.batchId);
      toast(body.batchId == null
        ? `${videoName(v)} pinned as not from any batch`
        : `${videoName(v)} pinned to ${b?.title ?? 'that batch'}${body.scriptNumber != null ? `, script ${body.scriptNumber}` : ''}`);
      onDone();
    },
  });
  const none = choice === 'none';
  // a raw clip is footage for many videos: it never has a script number
  const askNumber = !none && !v.raw;
  const typed = num.trim();
  const n = typed === '' ? null : Number(typed);
  const numBad = askNumber && n != null && (!Number.isInteger(n) || n < 1 || n > 500) ? 'A whole number, like 12' : undefined;
  const numErr = numBad ?? save.error?.fields.scriptNumber;
  const batches = [...(list.data?.batches ?? [])].sort((a, b) => (b.shootStart ?? '').localeCompare(a.shootStart ?? '') || a.title.localeCompare(b.title));
  const clients = [...new Set(batches.map((b) => b.clientName))];
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    if (!choice || numBad) return;
    save.mutate({ batchId: none ? null : Number(choice), scriptNumber: askNumber ? n : null });
  };
  return (
    <form className="ed-pin" onSubmit={submit} aria-label={`Pin ${videoName(v)} to its shoot`}>
      <div className="ed-pin-fields">
        <Field label={`Which batch is ${videoName(v)} from?`} htmlFor={batchId} error={save.error?.fields.batchId}>
          <select className="select" value={choice} onChange={(ev) => setChoice(ev.target.value)} disabled={list.isLoading} {...inputProps(batchId, save.error?.fields.batchId)}>
            <option value="">{list.isLoading ? 'Loading batches…' : `Pick a batch${v.client ? ` of ${v.client.name}` : ''}`}</option>
            <option value="none">Not from any batch</option>
            {clientId != null || clients.length <= 1
              ? batches.map((b) => <option key={b.id} value={b.id}>{batchOption(b, today, v.batch?.id ?? null)}</option>)
              : clients.map((c) => (
                <optgroup key={c} label={c}>
                  {batches.filter((b) => b.clientName === c).map((b) => <option key={b.id} value={b.id}>{batchOption(b, today, v.batch?.id ?? null)}</option>)}
                </optgroup>
              ))}
          </select>
        </Field>
        {askNumber && (
          <Field label="Script" optional htmlFor={numId} error={numErr} help="Leave it empty to take the number from the title">
            <input className="input num ed-pin-num" inputMode="numeric" autoComplete="off" value={num} onChange={(ev) => setNum(ev.target.value)} {...inputProps(numId, numErr)} />
          </Field>
        )}
      </div>
      {list.isError && (
        <div className="ed-pin-err" role="alert">
          Couldn’t load the batches: {list.error.message}
          <Button variant="ghost tall" icon={<RotateCcw aria-hidden />} onClick={() => void list.refetch()}>Try again</Button>
        </div>
      )}
      {save.error && !save.error.fields.scriptNumber && !save.error.fields.batchId && <FormError error={save.error} />}
      <div className="ed-vd-acts">
        <Button type="submit" variant="primary tall" icon={<Pin aria-hidden />} busy={save.isPending} disabled={!choice || !!numBad}>Pin it</Button>
        <Button variant="ghost tall" onClick={onDone}>Cancel</Button>
        <span className="ed-pin-note">A pin holds through every read of Timeliner, until someone unpins it.</span>
      </div>
    </form>
  );
}

type NotAssignedGroup = EditingBoard['unassigned'][number];
/** A shoot's unassigned raw clips by name, kept short: "C0200–0208", else the first three and how many more (all of them in the tooltip). */
const clipNames = (g: NotAssignedGroup) =>
  (g.titles.length <= 40 ? g.titles : `${g.videoTitles.slice(0, 3).join(', ')} +${g.count - 3} more`);
/** A row of videos nobody has: "Organic 26–30", or raw clips by shoot ("Oct 6 shoot · 9 clips not assigned"). */
const naLabel = (g: NotAssignedGroup, today: ISODate) =>
  (g.raw ? `${g.batch ? shootWords(g.batch, today) : g.folder} · ${g.count} ${g.count === 1 ? 'clip' : 'clips'} not assigned` : g.titles);

/**
 * Videos the site couldn't match to a shoot (their editors see "Not matched yet"), and matches worth a look: how
 * many, and where to fix them. Nothing shows when there's nothing to do.
 */
function MatchStrip({ b }: { b: EditingBoard }) {
  const t = b.totals;
  if (!t.notMatched && !t.toCheck) return null;
  // the counts are the videos on the editors' cards, which can be pinned from their Videos
  return (
    <div className="ed-match" role="status">
      <CircleHelp aria-hidden />
      <span className="ed-match-txt">
        {t.notMatched > 0 && <b>{plural(t.notMatched, 'video')} not matched to a shoot</b>}
        {t.notMatched > 0 && t.toCheck > 0 && ' · '}
        {t.toCheck > 0 && <b>{t.toCheck} to check</b>}
        <span className="muted">
          {' '}Open an editor’s Videos and tap one to see why, then pin it to its shoot.
        </span>
      </span>
    </div>
  );
}

/** Videos still to be edited in Timeliner that nobody has been given. */
function NotAssigned({ b, today }: { b: EditingBoard; today: ISODate }) {
  const groups = b.unassigned;
  const total = sum(groups.map((g) => g.count));
  const allClips = groups.every((g) => g.raw);
  const dueNow = sum(groups.filter((g) => g.due && g.due <= today).map((g) => g.count));
  const soonest = groups.map((g) => g.due).filter((d): d is string => !!d).sort()[0] ?? null;
  const clients = [...new Set(groups.map((g) => g.clientName ?? g.brand).filter((c): c is string => !!c))];
  // the documents these videos are cut from, so whoever assigns them can check which shoot's scripts they are
  const docs = [...new Map(groups.flatMap((g) => g.scripts).map((d) => [d.href, d])).values()];
  return (
    <article className="ed-card na" aria-label="Not assigned yet">
      <div className="ed-who">
        <span className="ed-av na" aria-hidden><UserPlus /></span>
        <div className="ed-who-txt">
          <h3 className="ed-name">Not assigned yet</h3>
          <div className="ed-place">Nobody on them or on their client in Timeliner</div>
          {clients.length > 0 && <div className="ed-pills">{clients.map((c) => <Chip key={c} color="plain">{c}</Chip>)}</div>}
        </div>
      </div>
      <div className="ed-now">
        <span className="ed-tile na" role="img" aria-label={`${plural(total, allClips ? 'clip' : 'video')} not assigned`}><span className="ed-tn">{total}</span><span className="ed-tu">{allClips ? (total === 1 ? 'clip' : 'clips') : total === 1 ? 'video' : 'videos'}</span></span>
        <div className="ed-now-txt">
          <span className="ed-eyebrow">Waiting for an editor</span>
          <span className={`ed-big quiet${dueNow ? ' today' : ''}`}>{dueNow ? `${dueNow} due today` : soonest ? dueWords(soonest, today)!.text : `${total} to assign`}</span>
          <span className="ed-line">In Timeliner: {[...new Set(groups.map((g) => g.folder))].join(', ')}</span>
        </div>
      </div>
      <div className="ed-plate ed-na-rows">
        {groups.map((g) => {
          const d = dueWords(g.due, today);
          const hot = d?.tone === 'today' || d?.tone === 'late';
          return (
            <div key={`${g.raw ? 'raw' : 'titled'}|${g.batch?.id ?? ''}|${g.folder}|${g.clientName ?? g.brand ?? ''}`} className={`ed-na-row${g.raw ? ' raw' : ''}`}>
              <span className="ed-na-t">
                {naLabel(g, today)}
                {/* whom to give them: their client's editor */}
                {g.suggested && <span className="ed-na-sug"> (usually {first(g.suggested.name)})</span>}
              </span>
              {/* the titles beside them say the same, so the squares are for the eye; raw clips are counted, not drawn */}
              {!g.raw && (
                <span className="ed-na-sqs" aria-hidden>
                  {g.videoTitles.slice(0, 12).map((title, i) => <span key={`${title}|${i}`} className={`ed-sq c-na${hot ? ' hot' : ''}`} title={`${title} · not assigned${d ? ` · ${midSentence(d.text)}` : ''}`}>{squareOf({ title, raw: false })}</span>)}
                  {g.count > 12 && <small>+{g.count - 12}</small>}
                </span>
              )}
              {g.raw && <span className="ed-na-raw muted" title={g.videoTitles.join(', ')}>{clipNames(g)}</span>}
              <span className={`ed-due ${d ? (d.tone === 'soon' ? 'plain' : d.tone) : 'plain'}`}>{d?.text ?? 'No deadline'}</span>
            </div>
          );
        })}
      </div>
      <div className="ed-foot">
        {docs.length
          ? docs.slice(0, 3).map((d) => <DocLink key={d.href} d={d} />)
          : <span className="muted">Give them to an editor in Timeliner, on the video or on its client; they show up on that editor’s card here.</span>}
        {docs.length > 3 && <span className="muted">+{docs.length - 3} more</span>}
        <a className="ed-abtn" href={TIMELINER_APP} target="_blank" rel="noopener noreferrer">Assign in Timeliner<ExternalLink aria-hidden /></a>
      </div>
    </article>
  );
}

function WholeTeam({ b, now }: { b: EditingBoard; now: number }) {
  // each editor once, under what their card shows
  const kinds = b.editors.map((e) => nowKind(e, now));
  const n = (k: NowKind) => kinds.filter((x) => x === k).length;
  // each video once, however many editors have it (two on its client in Timeliner)
  const videos = uniqueVideos(b.editors.flatMap((e) => e.videos));
  return (
    <div className="ed-team" role="group" aria-label="Whole team">
      <div className="ed-team-who">
        <b>Whole team</b>
        <span className="muted">{plural(videos.length, 'video')} assigned · {b.totals.notAssigned} not yet{b.totals.notMatched ? ` · ${b.totals.notMatched} not matched` : ''}{b.totals.toCheck ? ` · ${b.totals.toCheck} to check` : ''}</span>
      </div>
      <div className="ed-team-now">
        <Chip color="cyan" icon={<i className="ed-live-dot" aria-hidden />}>{n('live')} editing now</Chip>
        <Chip color="yellow" icon={<Pause aria-hidden />}>{n('paused')} paused</Chip>
        {n('stale') > 0 && <Chip color="plain" icon={<TimerOff aria-hidden />}>{n('stale')} still marked as editing</Chip>}
        <Chip color="plain">{n('next')} next up</Chip>
        <Chip color="plain">{n('off')} off hours</Chip>
      </div>
      <Counts list={stateCounts(videos)} />
    </div>
  );
}

function Legend() {
  return (
    <div className="ed-legend">
      <div><span className="ed-legend-h">Right now</span>
        <span className="ed-lg"><i className="k live" />Editing now</span><span className="ed-lg"><i className="k paused" />Paused</span>
        <span className="ed-lg"><i className="k stale" />Still marked as editing</span>
        <span className="ed-lg"><i className="k next" />Next up (by deadline)</span><span className="ed-lg"><i className="k off" />Off hours</span>
      </div>
      <div><span className="ed-legend-h">Videos</span>
        <span className="ed-lg"><i className="bar c-ed" />To edit · To be edited</span><span className="ed-lg"><i className="bar c-rv" />Revisions · Revisions requested</span>
        <span className="ed-lg"><i className="bar c-ir" />In review · Needs review, Internal approval</span><span className="ed-lg"><i className="bar c-cl" />With client · Awaiting client review</span>
        <span className="ed-lg"><i className="bar c-ap" />Approved this week</span><span className="ed-lg"><i className="bar c-dn" />Marked done here</span>
      </div>
      <div><span className="ed-legend-h">Shoots</span>
        <span className="ed-lg"><i className="ed-sq c-ed lg" aria-hidden><Film className="sq-raw" /></i>Raw clip (camera footage, no script number)</span>
        <span className="ed-lg"><i className="ed-sq c-ed lg nm" aria-hidden />Not matched to a shoot</span>
        <span className="ed-lg"><i className="ed-sq c-ed lg ck" aria-hidden />Check: two videos with one title on a shoot</span>
        <span className="ed-lg wrap"><Chip color="plain" icon={<FileX aria-hidden />}>No scripts on the site</Chip>a client we don’t write scripts for: its videos are normal work</span>
      </div>
      <div><span className="ed-legend-h">Last finished</span>
        <span className="ed-lg wrap"><span className="ed-src site"><Check aria-hidden />on the site</span>marked done here, until Timeliner moves it to Needs review</span>
        <span className="ed-lg"><span className="ed-src tl">in Timeliner</span>sent to review in Timeliner</span>
      </div>
      <p>“Editing now” is the video an editor tapped “I’m on this” for. They can pause it, then mark it done. It clears itself when Timeliner moves that video to Needs review. Left running for {FOCUS_STALE_HOURS} hours, or outside the editor’s working hours, it shows as still marked as editing instead.</p>
      <p>A video is the editor’s it’s assigned to in Timeliner; one nobody is on is its client’s editor’s there (“via client”). Each client has one editor: a client whose videos are with more than one is flagged.</p>
      <p>Each video goes with the shoot that had just happened when it was made in Timeliner; a titled video with the shoot whose raw clips its editor has been cutting. Once it has been in review it keeps that shoot. A pin always wins.</p>
    </div>
  );
}
