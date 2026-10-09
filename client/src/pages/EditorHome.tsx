// Editors' home. On top, their videos from Timeliner (assigned there, never picked here): what they're on
// ("I'm on this", then Pause or Done), else what's next by deadline, and every video still to edit or fix
// with the script it's cut from: the shoot's scripts PDF from Timeliner, else the manager's edited version, with
// the other as a quieter second link. Raw camera clips ("Raw clip C0045") are folded by shoot under To edit and
// open the shoot's whole scripts PDF; a video the site couldn't match says a manager has been asked. Done tells the managers and
// never changes Timeliner; the video moves on here once Timeliner has it in review, and tapping I'm on this on
// a video marked done takes the mark back. Below: each shoot coming up with how many of its scripts are final
// (Ready, On track or Late, opening just that shoot's scripts), the newest finished scripts, and their to-dos.

import { useId, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight, Camera, CalendarDays, Check, ChevronDown, ChevronRight, CircleCheck, Clapperboard, ExternalLink, FileText, Film, Layers,
  Inbox, Library, ListTodo, Pause, Play, RotateCcw, Scissors, SkipForward,
} from 'lucide-react';
import { api, qs, useSave, type ApiError } from '../api';
import type { CalendarEvent, EditingVideo, EditorFocus, FocusAction, MyEditing, ScriptBankPage, ShootReadiness } from '../../../shared/types';
import { addDays, diffDays, type ISODate } from '../../../shared/dates';
import { dueWords, fmtAgo, fmtDate, fmtRange, fmtWorked, plural } from '../../../shared/format';
import { isManager, scriptsLabel } from '../../../shared/workflow';
import { PageHeader, useBoot, useDisplayTz } from '../components/Shell';
import { Button, Chip, DateTile, Empty, ErrorState, FormError, Loading, Panel, useToast } from '../components/ui';
import { TodoPanel } from '../components/Todos';
import { burst, centerOf } from '../fx';
import { motionAllowed } from '../motion';
import {
  AgainTag, AltLink, byTitle, docKind, docName, docSource, fmtWhen, likelyWords, midSentence, focusSeconds, noScriptWords, openWords, reviewWords, ScriptLink,
  scriptWhat, shootLabel, shootWords, squareOf, syncWords, TIMELINER_APP, useNow, VideoName, videoName, videoTitles,
} from '../components/EditingBits';
import { DeliverableRow } from './ScriptBank';

const STATE: Record<ShootReadiness['state'], { label: string; color: string; edge: string }> = {
  ready: { label: 'Ready', color: 'mint', edge: 'edge-mint' },
  on_track: { label: 'On track', color: 'plain', edge: '' },
  late: { label: 'Late', color: 'red', edge: 'edge-red' },
  no_scripts: { label: 'Not planned', color: 'plain', edge: '' },
};
const daysText = (d: string, today: string) => { const n = diffDays(d, today); return n < 0 ? 'started' : n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`; };

const LOOKS_LIKE_SHOOT = /\b(shoots?|shooting|filming|film day|photo ?shoot|video ?shoot|content day|production day)\b/i;

/** jump to a panel further down, without a page load */
const jump = (id: string) => (e: MouseEvent) => {
  e.preventDefault();
  document.getElementById(id)?.scrollIntoView({ behavior: motionAllowed() ? 'smooth' : 'auto', block: 'start' });
};

export function EditorHome() {
  const { me, clock } = useBoot();
  const tz = useDisplayTz();
  const to = addDays(clock.today, 27);
  const cal = useQuery({
    queryKey: ['calendar', clock.today, to, 'editor-home'],
    queryFn: () => api<{ events: CalendarEvent[] }>(`/api/calendar${qs({ from: clock.today, to })}`),
  });
  const ready = useQuery({ queryKey: ['script-bank', 'editor-home'], queryFn: () => api<ScriptBankPage>(`/api/script-bank${qs({ status: 'finished', limit: 10 })}`) });
  const ready2 = useQuery({ queryKey: ['shoot-readiness'], queryFn: () => api<{ shoots: ShootReadiness[] }>('/api/shoot-readiness') });
  // shoot-looking events on synced calendars that aren't planned on the site
  const external = (cal.data?.events ?? [])
    .filter((e) => e.type === 'external' && !e.external?.linkedShootId && LOOKS_LIKE_SHOOT.test(e.title) && e.end >= clock.today)
    .sort((a, b) => a.start.localeCompare(b.start));

  return (
    <>
      <PageHeader title={`Hi ${me.name.split(' ')[0]}`} sub="Your videos from Timeliner, each with its script, and the shoots coming up." hideNewWork />
      <MyVideos />
      <div className="grid g-main-side" style={{ alignItems: 'start' }}>
        <Panel title="Ready to edit" sub="newest finished scripts" tools={<Link to="/scripts" className="btn sm ghost">Script bank <ArrowRight size={14} aria-hidden /></Link>}>
          {ready.isLoading && <Loading height={220} />}
          {ready.isError && <ErrorState error={ready.error} retry={() => ready.refetch()} />}
          {ready.data && !ready.data.deliverables.length && <Empty boxed icon={<Library />} title="No finished scripts yet">Scripts show up here once they’re approved.</Empty>}
          {ready.data && ready.data.deliverables.length > 0 && (
            <div className="rows bank">
              {ready.data.deliverables.filter((d) => !d.past).map((d) => <DeliverableRow key={d.key} d={d} tz={tz} num={null} linkBatch={false} />)}
            </div>
          )}
        </Panel>
        <div className="stack" style={{ gap: 'var(--gap)' }}>
          <Panel id="home-shoots" title="Shoots coming up" sub="are the scripts ready?" tools={<Link to="/calendar" className="btn sm ghost">Calendar <ArrowRight size={14} aria-hidden /></Link>}>
            {ready2.isLoading && <Loading height={200} />}
            {ready2.isError && <ErrorState error={ready2.error} retry={() => ready2.refetch()} />}
            {ready2.data && !ready2.data.shoots.length && !external.length && <Empty boxed icon={<Camera />} title="No shoots in the next 6 weeks" />}
            <div className="rows">
              {(ready2.data?.shoots ?? []).slice(0, 12).map((r) => {
                const st = STATE[r.state];
                return (
                  <Link key={r.shoot.id} to={`/scripts?shootId=${r.shoot.id}`} className={`item with-tile clickable ${st.edge}`}>
                    <DateTile date={r.shoot.startDate} color="var(--salmon)" />
                    <div className="body">
                      <div className="top">{fmtRange(r.shoot.startDate, r.shoot.endDate)} · {daysText(r.shoot.startDate, clock.today)}</div>
                      <div className="title">{r.shoot.clientName}</div>
                      <div className="meta">
                        {r.total ? <span className="num"><b style={{ color: 'var(--text)' }}>{r.finished} of {r.total}</b> scripts final</span> : <span>Scripts not planned yet</span>}
                        {r.finalDue && r.state !== 'ready' && <span>final due {fmtDate(r.finalDue, clock.today)}</span>}
                      </div>
                    </div>
                    <div className="side"><Chip color={st.color}>{st.label}</Chip></div>
                  </Link>
                );
              })}
            </div>
            {external.length > 0 && (
              <>
                <div className="section-title" style={{ marginTop: 14 }}>Also on the calendar</div>
                <div className="rows">
                  {external.slice(0, 6).map((e) => (
                    <div key={e.id} className="item with-tile">
                      <DateTile date={e.start} color={e.external!.color} />
                      <div className="body">
                        <div className="top" style={{ color: e.external!.color, fontWeight: 700, display: 'flex', gap: 5, alignItems: 'center' }}><CalendarDays size={13} aria-hidden />{e.external!.feedName}</div>
                        <div className="title">{e.title}</div>
                        <div className="meta"><span>{fmtRange(e.start, e.end !== e.start ? e.end : null)}</span>{e.external?.location && <span className="ellipsis">{e.external.location}</span>}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </Panel>
          <div id="home-todos"><TodoPanel title="Your to-dos" /></div>
        </div>
      </div>
    </>
  );
}

// ── your videos, from Timeliner ──────────────────────────────────────────

type Act = { video: EditingVideo; action: FocusAction };
/** what the confirmation says after each tap */
const SAID: Record<FocusAction, (title: string) => string> = {
  start: (t) => `You’re on ${t}. The managers can see it.`,
  pause: (t) => `${t} paused`,
  resume: (t) => `Back on ${t}`,
  done: (t) => `${t} marked done. Send it to Needs review in Timeliner.`,
};
/** a done card stays up this long after the tap (the video stays under Waiting on review until Timeliner moves it) */
const DONE_CARD_MS = 12 * 3600_000;

/** What the hero and the rows need to act on a video and show how it went. */
interface Acting {
  run: (video: EditingVideo, action: FocusAction, from?: Element | null) => void;
  pending: boolean;
  busy: (id: string, action: FocusAction) => boolean;
  error: (id: string) => ApiError | null;
}

function MyVideos() {
  const { me, clock } = useBoot();
  const tz = useDisplayTz();
  const now = useNow();
  const toast = useToast();
  // refreshed every minute, so a video Timeliner moves on leaves the list without a reload
  const q = useQuery({ queryKey: ['editing-me'], queryFn: () => api<MyEditing>('/api/editing/me'), refetchInterval: 60_000 });
  const from = useRef<{ x: number; y: number } | null>(null);
  const act = useSave((v: Act) => api<MyEditing>('/api/editing/focus', { body: { videoId: v.video.id, action: v.action } }), {
    onSuccess: (_out, v) => {
      toast(SAID[v.action](videoName(v.video)));
      if (v.action === 'done' && from.current) burst(from.current.x, from.current.y, { count: 18 });
    },
  });
  const acting: Acting = {
    run: (video, action, el) => {
      from.current = el ? centerOf(el) : null;
      act.mutate({ video, action }, {
        onError: (err) => {
          // what Timeliner changed meanwhile can take the video out of view (useSave refreshes on a 409), so say it here too
          toast(err.message, 'error');
          // given to someone else (403) or gone (404) in Timeliner: this copy is out of date
          if (err.status === 403 || err.status === 404) void q.refetch();
        },
      });
    },
    pending: act.isPending,
    busy: (id, action) => act.isPending && act.variables?.video.id === id && act.variables.action === action,
    error: (id) => (act.isError && act.variables?.video.id === id ? act.error : null),
  };
  const today = clock.today;

  if (q.isLoading) return <div className="eh-top"><Loading height={300} /></div>;
  // a failed refresh keeps the last copy on screen (Pause and Done are on it), with a note under Your videos
  if (q.isError && !q.data) return <div className="eh-top"><ErrorState error={q.error} retry={() => q.refetch()} /></div>;
  const d = q.data!;
  const s = d.sync;

  if (!s.syncedAt) {
    return (
      <Panel className="eh-top">
        <Empty icon={<Clapperboard />} title={s.keySet ? 'Your videos are on their way' : 'Your videos will show up here'}>
          {!s.keySet
            ? <>Once Timeliner is connected, the videos assigned to you there appear here, each with the script it’s cut from.{isManager(me.role) && ' Add TIMELINER_API_KEY on Render: the Editors tab says how.'}</>
            : s.error ? <>Timeliner couldn’t be read yet: {s.error}</> : <>Timeliner hasn’t been read yet. The videos assigned to you there show up here within a few minutes.</>}
        </Empty>
      </Panel>
    );
  }

  const f = d.focus;
  const all = uniq([...d.revisions, ...d.toEdit, ...d.waiting, ...d.approvedWeek]);
  if (!all.length && !f) {
    return (
      <Panel className="eh-top" title="Your videos" sub={syncWords(s, now)}>
        <Empty boxed icon={<Clapperboard />} title="Nothing assigned to you in Timeliner">
          Videos assigned to you there show up here with their scripts. Timeliner needs to know you by the email you sign in with here: <b>{me.email}</b>.
        </Empty>
      </Panel>
    );
  }

  const lastDone = !f
    ? d.waiting.filter((v) => v.doneAt && now - Date.parse(v.doneAt) < DONE_CARD_MS).sort((a, b) => b.doneAt!.localeCompare(a.doneAt!))[0] ?? null
    : null;
  // the video the hero shows; the rows below leave it out
  const featured = f?.video ?? d.nextUp;
  const hero: ReactNode = f
    ? <FocusCard key={`f-${f.video.id}-${f.state}`} f={f} all={all} now={now} today={today} acting={acting} />
    : (
      <>
        {lastDone && <DoneCard key={`d-${lastDone.id}`} v={lastDone} now={now} tz={tz} today={today} acting={acting} />}
        {d.nextUp
          ? <NextCard key={`n-${d.nextUp.id}`} v={d.nextUp} after={!!lastDone} today={today} acting={acting} />
          : !lastDone && <ClearCard waiting={d.waiting.length} />}
      </>
    );

  return (
    <div className="grid g-main-side eh-top" style={{ alignItems: 'start' }}>
      <div className="stack" style={{ gap: 'var(--gap)' }}>
        {hero}
        <YourVideos d={d} featured={featured?.id ?? null} refreshFailed={q.isError} now={now} tz={tz} today={today} acting={acting} />
      </div>
      <div className="stack" style={{ gap: 'var(--gap)' }}>
        <ScriptDocs d={d} now={now} tz={tz} today={today} />
        <Plate d={d} now={now} tz={tz} />
        <nav className="panel eh-quick" aria-label="More on Home">
          <a href="#home-shoots" className="eh-qlink" onClick={jump('home-shoots')}><CalendarDays aria-hidden />Shoots coming up<ChevronRight className="end" aria-hidden /></a>
          <a href="#home-todos" className="eh-qlink" onClick={jump('home-todos')}><ListTodo aria-hidden />Your to-dos<ChevronRight className="end" aria-hidden /></a>
        </nav>
      </div>
    </div>
  );
}

const uniq = (list: EditingVideo[]) => [...new Map(list.map((v) => [v.id, v])).values()];

/** A hero's title: a raw clip's camera name, with "Raw clip" as a small word before it. */
function HeroTitle({ v, done, sm, max = 16 }: { v: EditingVideo; done?: boolean; sm?: boolean; max?: number }) {
  return (
    <div className={`eh-title${sm ? ' sm' : ''}${v.title.length > max ? ' long' : ''}`}>
      {v.raw && <span className="eh-rawtag">Raw clip</span>}{v.title}{done && ' done'}
    </div>
  );
}

/** What a video is cut from, in a sentence for the hero: "Script 5 · Scripts PDF · v3 · from Timeliner". */
function scriptSentence(v: EditingVideo, today: ISODate): string {
  const s = v.script;
  if (!s) return noScriptWords(v, 'editor', today);
  const from = s.source === 'timeliner' ? ` · ${docSource(s)}${reviewWords(s) ? ` · ${reviewWords(s)}` : ''}` : s.name ? ` in ${s.name}` : '';
  return `${scriptWhat(v, today)}${from}${s.edited ? ' · edited version' : ''}`;
}

/** The cyan (on it) or yellow (paused) card. */
function FocusCard({ f, all, now, today, acting }: { f: EditorFocus; all: EditingVideo[]; now: number; today: ISODate; acting: Acting }) {
  const v = f.video;
  const on = f.state === 'on';
  const secs = focusSeconds(f, now);
  const due = dueWords(v.due, today);
  const what = v.state === 'revisions' ? `revisions${v.revisionRound ? `, round ${v.revisionRound}` : ''}` : due && midSentence(due.text);
  const err = acting.error(v.id);
  return (
    <section className={`eh-hero ${on ? 'live' : 'paused'}`} aria-label={`${on ? 'Editing now' : 'Paused'}: ${videoName(v)}`}>
      {on && <span className="dt-glint" aria-hidden />}
      <div className="eh-hero-top">
        <span className="eh-badge">{on ? <><i className="ed-live-dot" aria-hidden />Editing now</> : <><Pause aria-hidden />Paused</>}</span>
        <span className={`eh-time${on ? ' big' : ''} num`}>
          {on ? (secs < 60 ? (f.workedSeconds ? 'Back on it just now' : 'Started just now') : `${fmtWorked(secs)} on it`) : (v.state === 'revisions' ? `Revisions${v.revisionRound ? ` · round ${v.revisionRound}` : ''}` : due?.text ?? '')}
        </span>
      </div>
      <div>
        <div className="eh-kicker">{on ? 'You’re on' : 'You paused'}</div>
        <HeroTitle v={v} />
        <div className="eh-sub num">
          {on ? [shootLabel(v, today), likelyWords(v), what].filter(Boolean).join(' · ') : `${fmtWorked(secs)} on it so far · paused ${f.pausedAt ? fmtAgo(f.pausedAt, now) : 'just now'}`}
        </div>
      </div>
      <ScriptBox v={v} today={today} />
      <div className="eh-actions">
        {v.script && (
          <a className={`btn eh-btn ${on ? 'dark xl' : 'light'}`} href={v.script.href} target="_blank" rel="noopener noreferrer"
            aria-label={`${openWords(v)}${v.script.source === 'timeliner' ? `, the scripts PDF from Timeliner (version ${v.script.version ?? 1})` : v.script.edited ? ', the edited version' : ''} (opens in a new tab)`}>
            <FileText aria-hidden />{openWords(v)}
          </a>
        )}
        <a className="btn eh-btn quiet" href={TIMELINER_APP} target="_blank" rel="noopener noreferrer"><Layers aria-hidden />Open in Timeliner</a>
        <div className="eh-act-group" role="group" aria-label={videoName(v)}>
          {on
            ? <Button variant="eh-btn light" icon={<Pause className="ed-fill" aria-hidden />} busy={acting.busy(v.id, 'pause')} disabled={acting.pending} onClick={() => acting.run(v, 'pause')}>Pause</Button>
            : <Button variant="eh-btn dark" icon={<Play className="ed-fill" aria-hidden />} busy={acting.busy(v.id, 'resume')} disabled={acting.pending} onClick={() => acting.run(v, 'resume')}>Resume</Button>}
          <Button variant="eh-btn white" icon={<Check aria-hidden />} busy={acting.busy(v.id, 'done')} disabled={acting.pending} onClick={(e) => acting.run(v, 'done', e.currentTarget)}>Done</Button>
        </div>
      </div>
      {err && <div className="eh-err"><FormError error={err} /></div>}
      <VideoMap f={f} all={all} today={today} />
      <p className="eh-note">{on
        ? 'The managers see this on their Editors tab, Pause and Done included. Sending it to Needs review in Timeliner also clears it.'
        : 'The managers see it’s paused on their Editors tab. Nothing changes in Timeliner.'}</p>
    </section>
  );
}

/** Where the video's script is, in words, with the site's version as a second link. */
function ScriptBox({ v, today }: { v: EditingVideo; today: ISODate }) {
  const s = v.script;
  const tl = s?.source === 'timeliner';
  return (
    <div className="eh-script">
      <span className="eh-script-ic" aria-hidden><FileText /></span>
      <div className="eh-script-txt">
        <div className="eh-script-t">
          {s
            ? (v.scriptNumber != null ? `Script ${v.scriptNumber} in ${tl ? 'the scripts PDF' : s.name?.trim() || `the ${s.batchTitle} document`}` : scriptWhat(v, today))
            : noScriptWords(v, 'editor', today)}
        </div>
        <div className="eh-script-s">
          {s
            ? (tl
              ? `${docSource(s)}${reviewWords(s) ? ` · ${reviewWords(s)}` : ''}${v.scriptNumber == null ? ' · every script from the shoot' : ''}`
              : `${docKind(s)} · ${s.edited ? 'approved with edits, so this is the edited version to use' : `approved · scripts ${s.ranges}`}`)
            : !v.batch
              ? (v.match.how === 'pinned' ? 'A manager says this video isn’t cut from a shoot’s scripts.' : 'The site couldn’t tell which shoot this video is from yet.')
              : v.scriptIssue === 'not_approved' ? `It shows up here once it’s approved in ${v.batch.title}.`
              : v.scriptNumber != null ? `${v.batch.title} has no finished document for it yet.`
              : `It shows up here once the ${shootWords(v.batch, today)}’s scripts PDF is in Timeliner.`}
        </div>
        {s?.alt && <div className="eh-script-alt">Also: <AltLink d={s.alt} what={scriptWhat(v, today).toLowerCase()} /></div>}
      </div>
    </div>
  );
}

/** The other videos from the same shoot as squares: the one you're on glows. */
function VideoMap({ f, all, today }: { f: EditorFocus; all: EditingVideo[]; today: ISODate }) {
  const v = f.video;
  const same = all.filter((x) => (v.batch ? x.batch?.id === v.batch.id : !!v.folder && x.folder === v.folder)).sort(byTitle);
  if (same.length < 2) return null;
  const on = f.state === 'on';
  const kind = (x: EditingVideo) => (x.id === v.id ? (on ? 'now' : 'ps') : x.doneAt ? 'dn' : x.state === 'revisions' ? 'rv' : x.state === 'to_edit' ? 'todo' : x.state === 'approved' ? 'ap' : 'ir');
  const word: Record<string, string> = { now: 'you’re on this', ps: 'paused', dn: 'marked done', rv: 'revisions', todo: 'to edit', ap: 'approved', ir: 'in review' };
  const n = (k: string) => same.filter((x) => kind(x) === k).length;
  const keys = [
    { k: on ? 'now' : 'ps', text: on ? '1 you’re on' : '1 paused' },
    { k: 'todo', text: `${n('todo')} to edit` }, { k: 'rv', text: plural(n('rv'), 'revision') }, { k: 'dn', text: `${n('dn')} marked done` },
    { k: 'ir', text: `${n('ir')} in review` }, { k: 'ap', text: `${n('ap')} approved` },
  ].filter((x) => x.k === 'now' || x.k === 'ps' || n(x.k) > 0);
  const where = v.batch?.shootDate ? fmtDate(v.batch.shootDate, today) : v.batch?.title ?? v.folder;
  const label = `Your ${where} videos · ${videoTitles(same)}`;
  return (
    <div className="eh-map">
      <div className="eh-map-h">{label}</div>
      <div className="eh-sqs" role="img" aria-label={`${label}: ${keys.map((x) => x.text).join(', ')}`}>
        {same.slice(0, 48).map((x) => <span key={x.id} className={`eh-sq ${kind(x)}`} title={`${videoName(x)} · ${word[kind(x)]}`}>{squareOf(x)}</span>)}
      </div>
      <div className="eh-keys">{keys.map((x) => <span key={x.k}><i className={`eh-k ${x.k}`} aria-hidden />{x.text}</span>)}</div>
    </div>
  );
}

/** Just marked done: send it on in Timeliner. */
function DoneCard({ v, now, tz, today, acting }: { v: EditingVideo; now: number; tz: string; today: ISODate; acting: Acting }) {
  const err = acting.error(v.id);
  return (
    <section className="eh-hero done" aria-label={`${videoName(v)} done`}>
      <div className="eh-hero-top">
        <span className="eh-badge"><Check aria-hidden />Done</span>
      </div>
      <div>
        <HeroTitle v={v} done sm max={11} />
        <div className="eh-sub num">{[shootLabel(v, today), `marked done ${fmtWhen(v.doneAt!, tz, now)}`].filter(Boolean).join(' · ')}</div>
      </div>
      <div className="eh-script">
        <span className="eh-script-ic" aria-hidden><Layers /></span>
        <div className="eh-script-txt">
          <div className="eh-script-t">Send it to Needs review in Timeliner</div>
          <div className="eh-script-s">The managers can already see it’s done. It moves on here once it’s in Needs review.</div>
        </div>
        <a className="btn eh-btn dark" href={TIMELINER_APP} target="_blank" rel="noopener noreferrer">Open in Timeliner<ExternalLink aria-hidden /></a>
      </div>
      <div className="eh-actions">
        <Button variant="eh-btn quiet" icon={<RotateCcw aria-hidden />} busy={acting.busy(v.id, 'start')} disabled={acting.pending} onClick={() => acting.run(v, 'start')}
          aria-label={`Not done after all? I’m on ${videoName(v)}`}>Not done after all? I’m on this</Button>
      </div>
      {err && <div className="eh-err"><FormError error={err} /></div>}
    </section>
  );
}

/** What's next by deadline, with the one tap. */
function NextCard({ v, after, today, acting }: { v: EditingVideo; after: boolean; today: ISODate; acting: Acting }) {
  const due = dueWords(v.due, today);
  const label = after ? 'Up next' : 'Next up';
  const err = acting.error(v.id);
  return (
    <section className="eh-hero next" aria-label={`${label}: ${videoName(v)}`}>
      <div className="eh-hero-top">
        <span className="eh-badge plain"><SkipForward aria-hidden />{label} · {v.state === 'revisions' ? 'revisions first' : 'soonest due'}</span>
        {due && <span className={`eh-due ${due.tone}`}>{due.text}</span>}
      </div>
      <div>
        <HeroTitle v={v} sm />
        <div className="eh-sub">
          {[shootLabel(v, today), likelyWords(v), v.state === 'revisions' ? `revisions${v.revisionRound ? `, round ${v.revisionRound}` : ''}` : null, scriptSentence(v, today)].filter(Boolean).join(' · ')}
        </div>
      </div>
      <div className="eh-actions">
        <Button variant="primary eh-btn xl" icon={<Play className="ed-fill" aria-hidden />} busy={acting.busy(v.id, 'start')} disabled={acting.pending}
          onClick={() => acting.run(v, 'start')} aria-label={`I’m on this: ${videoName(v)}`}>I’m on this</Button>
        {v.script && (
          <a className="btn eh-btn" href={v.script.href} target="_blank" rel="noopener noreferrer" aria-label={`${openWords(v)} (opens in a new tab)`}>
            <FileText aria-hidden />{openWords(v)}
          </a>
        )}
        {v.script?.alt && <AltLink d={v.script.alt} what={scriptWhat(v, today).toLowerCase()} />}
        <a className="btn eh-btn ghost" href={TIMELINER_APP} target="_blank" rel="noopener noreferrer">Open in Timeliner</a>
      </div>
      {err && <div className="eh-err"><FormError error={err} /></div>}
      <p className="eh-note">Picked by deadline from Timeliner{v.state === 'revisions' ? ', revisions first' : ''}. Tapping it lets the managers see what you’re cutting.</p>
    </section>
  );
}

function ClearCard({ waiting }: { waiting: number }) {
  return (
    <section className="eh-hero next clear" aria-label="Nothing to edit right now">
      <div className="eh-hero-top"><span className="eh-badge plain"><CircleCheck aria-hidden />All clear</span></div>
      <div>
        <div className="eh-title sm long">Nothing to edit right now</div>
        <div className="eh-sub">{waiting ? `${plural(waiting, 'video')} waiting on review. ` : ''}When a video is assigned to you in Timeliner, it shows up here with its script.</div>
      </div>
    </section>
  );
}

/** Raw clips from one shoot (else one folder), in the order they came. */
interface ClipGroup { key: string; batch: EditingVideo['batch']; folder: string | null; clips: EditingVideo[] }
function clipGroups(list: EditingVideo[]): ClipGroup[] {
  const groups = new Map<string, ClipGroup>();
  for (const v of list) {
    const key = v.batch ? `b${v.batch.id}` : `f${v.folder ?? ''}|${v.client?.id ?? ''}`;
    const g = groups.get(key) ?? { key, batch: v.batch, folder: v.folder, clips: [] };
    g.clips.push(v);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** Revisions, To edit (titled videos as rows, raw clips folded by shoot), then Waiting on review (folded). */
function YourVideos({ d, featured, refreshFailed, now, tz, today, acting }: {
  d: MyEditing; featured: string | null; refreshFailed: boolean; now: number; tz: string; today: ISODate; acting: Acting;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const rv = d.revisions.filter((v) => v.id !== featured);
  const ed = d.toEdit.filter((v) => v.id !== featured);
  const titled = ed.filter((v) => !v.raw);
  const clips = clipGroups(ed.filter((v) => v.raw));
  const todo = d.revisions.length + d.toEdit.length;
  // the shoot goes in each row of a list whose videos come from more than one
  const mixed = (list: EditingVideo[]) => new Set(list.map((v) => v.batch?.id ?? v.folder ?? v.client?.id ?? '')).size > 1;
  const multi = mixed([...d.revisions, ...d.toEdit]);
  const multiWaiting = mixed(d.waiting);
  const folders = [...new Set([...d.revisions, ...d.toEdit].map((v) => v.folder).filter((x): x is string => !!x))];
  const done = d.waiting.filter((v) => v.doneAt);
  const inReview = d.waiting.filter((v) => !v.doneAt && v.state === 'in_review').length;
  const withClient = d.waiting.filter((v) => !v.doneAt && v.state === 'with_client').length;
  const waitSub = done.length
    ? `${videoTitles(done)} marked done · ${done.length === 1 ? 'moves' : 'each moves'} on when it’s in Needs review`
    : [inReview && `${inReview} with the managers`, withClient && `${withClient} with the client`].filter(Boolean).join(' · ');
  const soonest = ed.map((v) => v.due).filter((x): x is string => !!x).sort()[0];
  const row = (v: EditingVideo, kind: RowKind) => <VideoRow key={v.id} v={v} kind={kind} multi={kind === 'rv' || kind === 'ed' ? multi : multiWaiting} now={now} tz={tz} today={today} acting={acting} />;
  return (
    <Panel title="Your videos" className="eh-videos"
      sub={<><span className="eh-todo">{todo} to do</span> Assigned to you in Timeliner{folders.length && folders.length <= 2 ? ` · ${folders.join(', ')}` : ''} · <span title={d.sync.error ?? undefined}>{syncWords(d.sync, now).replace('Read from Timeliner', 'read')}{d.sync.error ? ' · couldn’t read it just now' : ''}</span>{refreshFailed && <span role="status"> · couldn’t refresh just now, so this may be out of date</span>}</>}
      tools={<a className="ed-tl-link" href={TIMELINER_APP} target="_blank" rel="noopener noreferrer"><Layers aria-hidden />Open in Timeliner</a>}>
      <div className="eh-groups">
        {rv.length > 0 && (
          <div>
            <div className="eh-glabel rv"><RotateCcw aria-hidden />Revisions · {rv.length}<span className="eh-gsub">sent back with changes</span></div>
            <div className="eh-rows">{rv.map((v) => row(v, 'rv'))}</div>
          </div>
        )}
        {ed.length > 0 && (
          <div>
            <div className="eh-glabel ed"><Scissors aria-hidden />To edit · {ed.length}<span className="eh-gsub">by deadline{soonest ? ` · next ${midSentence(dueWords(soonest, today)!.text)}` : ''}</span></div>
            <div className="eh-rows">
              {titled.map((v) => row(v, 'ed'))}
              {clips.map((g) => <RawClips key={g.key} g={g} now={now} tz={tz} today={today} acting={acting} />)}
            </div>
          </div>
        )}
        {!rv.length && !ed.length && (
          <p className="muted eh-nothing">{featured ? 'That’s the only one still to edit.' : 'Nothing else to edit or fix right now.'}</p>
        )}
        {d.waiting.length > 0 && (
          <div className="eh-rows">
            <button type="button" className="eh-wbtn" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((o) => !o)}>
              <span className="eh-wsq" aria-hidden>
                {d.waiting.slice(0, 5).map((v) => <span key={v.id} className={`eh-vq sm ${v.doneAt ? 'dn' : v.state === 'with_client' ? 'cl' : 'ir'}`}>{squareOf(v)}</span>)}
              </span>
              <span className="eh-wtxt"><b>Waiting on review · {d.waiting.length}</b>{waitSub && <span>{waitSub}</span>}</span>
              <span className="eh-wmore">{open ? 'Hide' : 'Show'}<ChevronDown className={`chev${open ? ' up' : ''}`} aria-hidden /></span>
            </button>
            {open && (
              <div id={listId} className="eh-rows">
                {d.waiting.map((v) => row(v, v.doneAt ? 'dn' : v.state === 'with_client' ? 'cl' : 'ir'))}
              </div>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

/**
 * One shoot's raw clips, folded: "Oct 6 shoot · 24 raw clips", with the shoot's scripts beside it. Opened, each
 * clip keeps its I'm on this. A couple of clips start open: folding them would only hide them.
 */
function RawClips({ g, now, tz, today, acting }: { g: ClipGroup; now: number; tz: string; today: ISODate; acting: Acting }) {
  const [open, setOpen] = useState(g.clips.length <= 2);
  const listId = useId();
  const n = g.clips.length;
  const label = `${g.batch ? shootWords(g.batch, today) : g.folder ?? 'Not matched to a shoot'} · ${plural(n, 'raw clip')}`;
  const soonest = g.clips.map((v) => v.due).filter((x): x is string => !!x).sort()[0];
  const due = soonest ? dueWords(soonest, today) : null;
  const likely = likelyWords(g.clips[0]);
  // every clip of a shoot opens the same scripts: shown once, beside the group
  const lead = g.clips.find((v) => v.script) ?? g.clips[0];
  return (
    <div className="eh-clips">
      <div className="eh-clips-head">
        <button type="button" className="eh-wbtn" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((o) => !o)}>
          <span className="eh-vq ed raw" aria-hidden><Film className="sq-raw" /></span>
          <span className="eh-wtxt">
            <b>{label}</b>
            <span>{[due ? <span key="d" className={`eh-due ${due.tone}`}>{due.text}</span> : 'No deadline in Timeliner', likely].filter(Boolean).map((x, i) => <span key={i}>{i > 0 && ' · '}{x}</span>)}</span>
          </span>
          <span className="eh-wmore">{open ? 'Hide' : 'Show'}<ChevronDown className={`chev${open ? ' up' : ''}`} aria-hidden /></span>
        </button>
        <ScriptLink v={lead} who="editor" pill today={today} />
      </div>
      {open && (
        <div id={listId} className="eh-rows eh-clip-rows">
          {g.clips.map((v) => <VideoRow key={v.id} v={v} kind="ed" multi={false} inGroup={{ due: soonest ?? null }} now={now} tz={tz} today={today} acting={acting} />)}
        </div>
      )}
    </div>
  );
}

type RowKind = 'rv' | 'ed' | 'dn' | 'ir' | 'cl';

/** `inGroup`: a raw clip in its shoot's folded list, which already says the shoot, its scripts and the soonest deadline. */
function VideoRow({ v, kind, multi, inGroup, now, tz, today, acting }: {
  v: EditingVideo; kind: RowKind; multi: boolean; inGroup?: { due: ISODate | null }; now: number; tz: string; today: ISODate; acting: Acting;
}) {
  const due = dueWords(v.due, today);
  const likely = inGroup ? null : likelyWords(v);
  const meta: ReactNode[] = [];
  // the shoot, where the list mixes shoots or the site isn't sure of it
  if ((multi || likely) && !inGroup && shootLabel(v, today)) meta.push(shootLabel(v, today));
  if (likely) meta.push(<span className="ed-likely">{likely}</span>);
  if (kind === 'dn') meta.push(`Marked done ${fmtWhen(v.doneAt!, tz, now)} · moves on when it’s in Needs review`);
  else if (kind === 'ir') meta.push(v.movedAt ? `Sent ${fmtWhen(v.movedAt, tz, now)}` : 'With the managers');
  else if (kind === 'cl') meta.push(v.movedAt ? `With the client since ${fmtWhen(v.movedAt, tz, now)}` : 'With the client');
  else {
    // a clip in its shoot's list says only what differs from the list
    if (due && (!inGroup || v.due !== inGroup.due)) meta.push(<span className={`eh-due ${due.tone}`}>{due.text}</span>);
    else if (kind === 'ed' && !inGroup) meta.push('No deadline in Timeliner');
    if (kind === 'rv' && v.movedAt) meta.push(`sent back ${fmtWhen(v.movedAt, tz, now)}`);
  }
  if (!inGroup || v.state !== 'to_edit' || v.step !== 'To be edited') meta.push(<span className="nowrap">Timeliner: {v.step}</span>);
  const canStart = kind === 'rv' || kind === 'ed' || kind === 'dn';
  const err = acting.error(v.id);
  return (
    <div className={`eh-row ${kind}${v.raw ? ' raw' : ''}`}>
      <span className={`eh-vq ${kind}${v.raw ? ' raw' : ''}`} aria-hidden>{squareOf(v)}</span>
      <div className="eh-row-body">
        <div className="eh-row-top">
          <b className="eh-row-title"><VideoName v={v} /></b>
          {kind === 'rv' && v.revisionRound > 0 && <Chip color="pink">Round {v.revisionRound}</Chip>}
        </div>
        {meta.length > 0 && <div className="eh-row-meta">{meta.map((m, i) => <span key={i}>{i > 0 && ' · '}{m}</span>)}</div>}
      </div>
      <div className="eh-row-tools">
        {!inGroup && <ScriptLink v={v} who="editor" pill today={today} />}
        {(kind === 'dn' || kind === 'ir' || kind === 'cl') && <span className={`eh-st ${kind}`}><i aria-hidden />{kind === 'dn' ? 'Marked done' : kind === 'ir' ? 'In review' : 'With client'}</span>}
        {canStart && (
          <Button variant="eh-tap" icon={<Play aria-hidden />} busy={acting.busy(v.id, 'start')} disabled={acting.pending} onClick={() => acting.run(v, 'start')}
            aria-label={`I’m on this: ${videoName(v)}${kind === 'dn' ? ' (it isn’t done after all)' : ''}`}
            title={kind === 'dn' ? 'Not done after all? This takes the done mark back.' : undefined}>I’m on this</Button>
        )}
      </div>
      {err && <div className="eh-err"><FormError error={err} /></div>}
    </div>
  );
}

/** The documents to cut from, the one you're on (or next) first; each with the site's version as a quieter link. */
function ScriptDocs({ d, now, tz, today }: { d: MyEditing; now: number; tz: string; today: ISODate }) {
  const f = d.focus;
  const lead = f?.video ?? d.nextUp;
  const plate = uniq([...(f ? [f.video] : []), ...d.revisions, ...d.toEdit]);
  const docs = [...d.scripts].sort((a, b) => Number(b.href === lead?.script?.href) - Number(a.href === lead?.script?.href));
  const example = plate.find((v) => v.script && v.scriptNumber != null);
  const anyPdf = docs.some((s) => s.source === 'timeliner');
  return (
    <Panel title="Script documents" className="eh-docs">
      <p className="eh-docs-sub">{docs.length
        ? <>Approved scripts for your videos.{example && <> {example.title} is Script {example.scriptNumber}, and so on.</>}{anyPdf && <> The scripts PDF is always its newest version in Timeliner.</>}</>
        : 'No script documents matched yet. They show up here once your videos are matched to a shoot’s approved scripts.'}</p>
      {docs.length > 0 && (
        <div className="stack">
          {docs.map((s) => {
            const uses = plate.filter((v) => v.script?.href === s.href);
            const numbered = uses.filter((v) => v.scriptNumber != null);
            const whole = uses.filter((v) => v.scriptNumber == null);
            const usesText = [
              numbered.length > 0 && `${videoTitles(numbered)} use${numbered.length === 1 ? 's' : ''} ${scriptsLabel(numbered.map((v) => v.scriptNumber!)).toLowerCase()}`,
              whole.length > 0 && `${videoTitles(whole)} use${whole.length === 1 ? 's' : ''} every script in it`,
            ].filter(Boolean).join('; ');
            // the site's own versions of the same scripts, once each
            const alts = [...new Map(uses.flatMap((v) => (v.script?.alt ? [v.script.alt] : [])).map((x) => [x.href, x])).values()];
            const isLead = !!lead && lead.script?.href === s.href;
            const tl = s.source === 'timeliner';
            return (
              <article key={s.href} className={`eh-doc${isLead ? ' on' : ''}`}>
                <div className="eh-doc-top">
                  <span className="muted ellipsis">{s.batchTitle}</span>
                  {isLead && <Chip color={f?.state === 'paused' ? 'yellow' : 'cyan'}>{f ? (f.state === 'on' ? 'You’re on' : 'Paused on') : 'Next:'} {lead.scriptNumber != null ? `script ${lead.scriptNumber}` : videoName(lead)}</Chip>}
                </div>
                <div className="eh-doc-main">
                  <span className="eh-doc-ic" aria-hidden><FileText /></span>
                  <div style={{ minWidth: 0 }}>
                    <div className="eh-doc-name">{docName(s)}</div>
                    <div className="eh-doc-tags">
                      <span className={`ed-kind${tl ? ' ed-kind-tl' : ''}`}>{docSource(s)}</span>
                      <AgainTag d={s} />
                      {!tl && s.edited && <span className="ed-edited">Edited version · use this one</span>}
                    </div>
                  </div>
                </div>
                {(usesText || (tl && s.updatedAt)) && (
                  <div className="eh-doc-uses">
                    {usesText && <>Your videos: {usesText}.</>}
                    {tl && s.updatedAt && <span className="eh-doc-when"> Version {s.version ?? 1} came in {fmtWhen(s.updatedAt, tz, now)}.</span>}
                  </div>
                )}
                <a className="btn eh-btn block" href={s.href} target="_blank" rel="noopener noreferrer"
                  aria-label={`Open ${tl ? `the scripts PDF for ${s.batchTitle}, version ${s.version ?? 1}, from Timeliner` : docName(s, true)} (opens in a new tab)`}>
                  {tl ? 'Open the scripts PDF' : 'Open document'}<ExternalLink aria-hidden />
                </a>
                {alts.length > 0 && (
                  <div className="eh-doc-alt">Also: {alts.slice(0, 2).map((x, i) => <span key={x.href}>{i > 0 && ', '}<AltLink d={x} what={`the scripts for ${shootWordsOf(s, uses, today)}`} /></span>)}</div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

/** "the Oct 14 shoot": the shoot a document's videos are from, for what a screen reader hears. */
const shootWordsOf = (s: { batchTitle: string }, uses: EditingVideo[], today: ISODate) => {
  const b = uses.find((v) => v.batch)?.batch;
  return b ? `the ${shootWords(b, today)}` : s.batchTitle;
};

/** Everything of theirs this week, by state. */
function Plate({ d, now, tz }: { d: MyEditing; now: number; tz: string }) {
  const f = d.focus;
  const not = (v: EditingVideo) => v.id !== f?.video.id;
  const parts = [
    { c: f?.state === 'paused' ? 'pa' : 'now', n: f ? 1 : 0, label: f ? (f.state === 'on' ? 'you’re on' : 'paused') : '' },
    { c: 'ed', n: d.toEdit.filter(not).length, label: 'to edit' },
    { c: 'rv', n: d.revisions.filter(not).length, label: 'in revisions' },
    { c: 'dn', n: d.waiting.filter((v) => v.doneAt).length, label: 'marked done' },
    { c: 'ir', n: d.waiting.filter((v) => !v.doneAt && v.state === 'in_review').length, label: 'in review' },
    { c: 'cl', n: d.waiting.filter((v) => !v.doneAt && v.state === 'with_client').length, label: 'with the client' },
    { c: 'ap', n: d.approvedWeek.length, label: 'approved this week' },
  ].filter((p) => p.n > 0);
  const total = parts.reduce((n, p) => n + p.n, 0);
  // raw clips to cut read as clips ("24 clips to edit"), when that's all there is to edit
  const allClips = d.toEdit.length > 0 && d.toEdit.every((v) => v.raw);
  const counts = [
    { c: 'ed', label: allClips ? 'Clips to edit' : 'To edit', n: d.toEdit.length }, { c: 'rv', label: 'Revisions', n: d.revisions.length },
    ...(parts.some((p) => p.c === 'dn') ? [{ c: 'dn', label: 'Marked done', n: parts.find((p) => p.c === 'dn')!.n }] : []),
    { c: 'ir', label: 'In review', n: parts.find((p) => p.c === 'ir')?.n ?? 0 }, { c: 'cl', label: 'With client', n: parts.find((p) => p.c === 'cl')?.n ?? 0 },
    { c: 'ap', label: 'Approved', n: d.approvedWeek.length },
  ];
  const lastApproved = d.approvedWeek.map((v) => v.movedAt).filter((x): x is string => !!x).sort().reverse()[0];
  return (
    <Panel title="Your plate this week" className="eh-plate" tools={<span className="muted num" style={{ fontSize: 13, fontWeight: 650 }}>{plural(total, 'video')}</span>}>
      <div className="ed-bar" role="img" aria-label={parts.map((p) => `${p.c === 'now' || p.c === 'pa' ? 1 : p.n} ${p.c === 'ed' && allClips ? 'clips to edit' : p.label}`).join(', ') || 'No videos'}>
        {parts.map((p) => <span key={p.c} className={`c-${p.c}`} style={{ width: `calc(${(p.n / Math.max(1, total)) * 100}% - 2px)` }} />)}
      </div>
      <div className="ed-counts">
        {counts.map((c) => <div key={c.c}><span className={`ed-cn num${c.n ? '' : ' zero'}`}>{c.n}</span><span className="ed-cl"><i className={`ed-sw c-${c.c}`} aria-hidden />{c.label}</span></div>)}
      </div>
      {d.approvedWeek.length > 0 && (
        <div className="eh-plate-note"><Check aria-hidden /><span>{videoTitles(d.approvedWeek)} approved{lastApproved ? ` · last ${fmtWhen(lastApproved, tz, now)}` : ''}</span></div>
      )}
      {!d.approvedWeek.length && d.waiting.length > 0 && (
        <div className="eh-plate-note wait"><Inbox aria-hidden /><span>{plural(d.waiting.length, 'video')} waiting on review · nothing approved yet this week</span></div>
      )}
    </Panel>
  );
}
