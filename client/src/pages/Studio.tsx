// Studio (/studio): a thumbnail designer's home, built from GET /api/studio (StudioPayload in shared/types.ts),
// refreshed every minute. A dark, picture-first room. On top the hero, in the order EditorHome uses for videos:
// changes asked (the manager's note on the round it was asked on, with "Start round N"), next up (the brief due
// soonest, in a 16:9 frame or its title card), just picked (the winner, for 12 hours), all clear (the latest
// wins). Then Your board (a 16:9 grid of open briefs with their state), the Wall of wins (every pick, newest
// first, filtered by client; a new win flips in with a glint and a few sparks the first time it's seen, when
// animations are on), a few numbers counted from rows, and to-dos. No timers, points or streaks.
// A manager opens a designer's Studio with ?userId= (read-only; their unsent options stay private); an Admin can
// also View as the designer and see exactly theirs.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CalendarClock, CircleCheck, Clock, Image as ImageIcon, Play, RotateCcw, SkipForward, Sparkles, Trophy } from 'lucide-react';
import { api, qs, type ApiError } from '../api';
import type { StudioHero, StudioPayload, ThumbnailBrief, ThumbnailWin } from '../../../shared/types';
import { isManager, isThumbnailDesigner, thumbBriefPath } from '../../../shared/workflow';
import { dueWords, fmtAgo, fmtDate, plural } from '../../../shared/format';
import { onOrAfterDay, startOfMonth } from '../../../shared/dates';
import { PageHeader, useBoot, useDisplayTz } from '../components/Shell';
import { Chip, Empty, ErrorState, Loading, Panel, Seg, Thumb } from '../components/ui';
import { KpiCard } from '../components/StatCards';
import { TodoPanel } from '../components/Todos';
import { BriefThumb, BriefTile, optionAlt, StateChip, toneFor } from '../components/ThumbBits';
import { useNow } from '../components/EditingBits';
import { NoDesigners } from './Thumbnails';
import { burst, centerOf } from '../fx';
import { motionAllowed, useMotionAllowed } from '../motion';

export function StudioPage() {
  const { me } = useBoot();
  const [params] = useSearchParams();
  const manager = isManager(me.role);
  // a designer always gets their own Studio; a manager names the designer
  const userId = manager ? params.get('userId') ?? '' : '';
  if (manager && !userId) return <PickDesigner />;
  return <StudioView key={userId || 'me'} userId={userId} />;
}

/** A manager who opened /studio without saying whose: every designer's Studio, one tap each. */
function PickDesigner({ missing }: { missing?: boolean }) {
  const { users } = useBoot();
  const designers = users.filter((u) => u.active && !u.removed && isThumbnailDesigner(u));
  return (
    <div className="studio">
      <PageHeader title="Studios" sub={missing ? 'That person isn’t a thumbnail designer any more. Pick another.' : 'Each thumbnail designer’s Studio, read-only. Their unsent options stay private.'} hideNewWork
        crumbs={<Link to="/thumbnails">Thumbnails</Link>} />
      {!designers.length ? <NoDesigners /> : (
        <div className="st-people">
          {designers.map((u) => (
            <Link key={u.id} to={`/studio?userId=${u.id}`} className="st-person">
              <span className="st-person-n">{u.name}</span>
              <span className="muted">Open their Studio</span>
              <ArrowRight aria-hidden />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function StudioView({ userId }: { userId: string }) {
  const { me } = useBoot();
  const q = useQuery({ queryKey: ['studio', userId || 'me'], queryFn: () => api<StudioPayload>(`/api/studio${qs({ userId })}`), refetchInterval: 60_000 });
  if ((q.error as ApiError | null)?.status === 404 && isManager(me.role)) return <PickDesigner missing />;
  if (q.isLoading) return <div className="studio"><div style={{ height: 90 }} /><Loading height={420} /></div>;
  if (q.isError && !q.data) return <div className="studio"><ErrorState error={q.error} retry={() => q.refetch()} /></div>;
  return <Studio s={q.data!} refreshFailed={q.isError} />;
}

function Studio({ s, refreshFailed }: { s: StudioPayload; refreshFailed: boolean }) {
  const { me, clock, users } = useBoot();
  const nav = useNavigate();
  const now = useNow();
  const first = s.designer.name.split(' ')[0];
  const hero = s.hero;
  const featured = hero.kind === 'changes' || hero.kind === 'next' ? hero.brief.id : null;
  const board = s.board.filter((b) => b.id !== featured);
  const others = users.filter((u) => u.active && !u.removed && isThumbnailDesigner(u));
  return (
    <div className="studio st">
      <PageHeader
        title={s.readOnly ? `${s.designer.name}’s Studio` : `Hi ${first}`}
        crumbs={s.readOnly ? <><Link to="/thumbnails">Thumbnails</Link><span aria-hidden>›</span><span>Studio</span></> : undefined}
        sub={<>{s.readOnly ? 'What they see, read-only. Their unsent options stay private.' : 'Your next thumbnail, your board and your wall of wins.'}{refreshFailed && <span role="status"> · couldn’t refresh just now, so this may be out of date</span>}</>}
        hideNewWork>
        {s.readOnly && others.length > 1 && (
          <select className="select st-switch" value={s.designer.id} onChange={(e) => nav(`/studio?userId=${e.target.value}`)} aria-label="Whose Studio">
            {others.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        )}
      </PageHeader>

      <Hero hero={hero} s={s} now={now} />

      <div className="grid g-main-side st-cols">
        <div className="stack" style={{ gap: 'var(--gap)' }}>
          <Panel title={s.readOnly ? 'Their board' : 'Your board'} count={s.board.length} sub="open briefs: changes asked first, then by due date" className="st-board">
            {!s.board.length
              ? <Empty boxed icon={<ImageIcon />} title="Nothing on the board">{s.readOnly ? 'No open briefs right now.' : 'New briefs show up here the moment a manager hands one out.'}</Empty>
              : !board.length
                ? <p className="muted st-only">That’s the only one on {s.readOnly ? 'their' : 'your'} board.</p>
                : <div className="st-grid">{board.map((b, i) => <BriefTile key={b.id} brief={b} to={thumbBriefPath(me, b.id)} today={clock.today} eager={i < 4} />)}</div>}
          </Panel>
          <WallOfWins wins={s.wins} readOnly={s.readOnly} designerId={s.designer.id} name={s.readOnly ? s.designer.name : null} />
        </div>
        <div className="stack st-side" style={{ gap: 'var(--gap)' }}>
          <Numbers s={s} />
          {!s.readOnly && <TodoPanel title="Your to-dos" />}
        </div>
      </div>
    </div>
  );
}

// ── the hero ─────────────────────────────────────────────────────────────

/** A fresh pick sits on top of changes asked or next up (as EditorHome's Done card sits over Next up); alone, it's the hero. */
function Hero({ hero, s, now }: { hero: StudioHero; s: StudioPayload; now: number }) {
  const picked = s.justPicked && (hero.kind === 'changes' || hero.kind === 'next')
    ? <PickedCard key={`j-${s.justPicked.option.id}`} win={s.justPicked} readOnly={s.readOnly} now={now} /> : null;
  switch (hero.kind) {
    case 'changes': return <>{picked}<ChangesHero key={`c-${hero.brief.id}`} hero={hero} readOnly={s.readOnly} now={now} /></>;
    case 'next': return <>{picked}<NextHero key={`n-${hero.brief.id}`} brief={hero.brief} readOnly={s.readOnly} /></>;
    case 'picked': return <PickedHero key={`p-${hero.win.option.id}`} brief={hero.brief} win={hero.win} readOnly={s.readOnly} now={now} />;
    case 'clear': return <ClearHero s={s} />;
  }
}

/** Scrolls to the Wall of wins (gently, when animations are on) and takes keyboard focus there too. */
function toWall() {
  const wall = document.getElementById('st-wall');
  if (!wall) return;
  wall.scrollIntoView({ behavior: motionAllowed() ? 'smooth' : 'auto', block: 'start' });
  wall.focus({ preventScroll: true });
}

/** A pick of the last 12 hours, compact, above what's next: the one real celebration stays in sight. */
function PickedCard({ win, readOnly, now }: { win: ThumbnailWin; readOnly: boolean; now: number }) {
  const { me } = useBoot();
  const allowed = useMotionAllowed();
  return (
    <section className="st-hero picked st-just" aria-label={`Just picked: option ${win.option.letter} for ${win.title}`}>
      {allowed && <span className="dt-glint" aria-hidden />}
      <div className="st-hero-frame">
        <Thumb src={win.option.url} alt={optionAlt(win.option, win.title)} eager className="ringed">
          <span className="thumb-letter" aria-hidden>{win.option.letter}</span>
        </Thumb>
      </div>
      <div className="st-hero-body">
        <span className="eh-badge"><Sparkles aria-hidden />Just picked</span>
        <h2 className="st-just-title">{win.title}</h2>
        <p className="st-hero-sub">{win.clientName} · {win.pickedByName} picked option {win.option.letter} · {fmtAgo(win.pickedAt, now)}</p>
        {win.reason && <blockquote className="st-hero-quote">{win.reason}</blockquote>}
        <div className="eh-actions">
          <a className="btn eh-btn dark" href="#st-wall" onClick={(e) => { e.preventDefault(); toWall(); }}>
            <Trophy aria-hidden />{readOnly ? 'Their wall of wins' : 'Your wall of wins'}
          </a>
          <Link className="btn eh-btn quiet" to={thumbBriefPath(me, win.briefId)}>Open brief<ArrowRight aria-hidden /></Link>
        </div>
      </div>
    </section>
  );
}

/** "Due tomorrow, Fri, Oct 9" for an open brief, else nothing. */
function DueLine({ brief }: { brief: ThumbnailBrief }) {
  const { clock } = useBoot();
  const d = dueWords(brief.dueOn, clock.today);
  return d ? <span className={`eh-due ${d.tone}`}>{d.text}</span> : null;
}

function ChangesHero({ hero, readOnly, now }: { hero: Extract<StudioHero, { kind: 'changes' }>; readOnly: boolean; now: number }) {
  const { me } = useBoot();
  const { brief, decision, round } = hero;
  const lead = round.options[0] ?? null;
  const go = readOnly ? 'Open brief' : brief.draftOptions ? `Carry on with round ${brief.nextRound}` : `Start round ${brief.nextRound}`;
  return (
    <section className="st-hero changes" aria-label={`Changes asked: ${brief.title}`}>
      <div className="st-hero-frame">
        <Thumb src={lead?.url} alt={lead ? optionAlt(lead, brief.title) : brief.title} title={brief.title} sub={brief.clientName} tone={toneFor(brief.id)} eager>
          {lead && <span className="thumb-letter" aria-hidden>{lead.letter}</span>}
        </Thumb>
        <figure className="st-note">
          <span className="st-note-k"><RotateCcw aria-hidden />Changes asked on round {round.number}</span>
          <blockquote>{decision.note}</blockquote>
          <figcaption>{decision.decidedByName} · {fmtAgo(decision.createdAt, now)}</figcaption>
        </figure>
        {round.options.length > 1 && (
          <div className="st-hero-strip" aria-label={`Round ${round.number}: ${plural(round.options.length, 'option')}`}>
            {round.options.map((o) => <span key={o.id}><Thumb src={o.url} alt={optionAlt(o, brief.title)}><span className="thumb-letter" aria-hidden>{o.letter}</span></Thumb></span>)}
          </div>
        )}
      </div>
      <div className="st-hero-body">
        <span className="eh-badge"><RotateCcw aria-hidden />Changes asked</span>
        <div className="st-kicker">{brief.clientName}</div>
        <h2 className={`st-hero-title${brief.title.length > 40 ? ' long' : ''}`}>{brief.title}</h2>
        <p className="st-hero-sub">{decision.decidedByName} asked for changes on round {round.number}. <DueLine brief={brief} /></p>
        <div className="eh-actions">
          <Link className="btn primary eh-btn xl" to={thumbBriefPath(me, brief.id)}><Play className="ed-fill" aria-hidden />{go}</Link>
        </div>
        {!readOnly && <p className="st-hero-note">{brief.draftOptions ? `${plural(brief.draftOptions, 'option')} already in your tray for round ${brief.nextRound}.` : `Round ${brief.nextRound} opens with this note beside it.`}</p>}
      </div>
    </section>
  );
}

function NextHero({ brief, readOnly }: { brief: ThumbnailBrief; readOnly: boolean }) {
  const { me } = useBoot();
  return (
    <section className="st-hero next" aria-label={`Next up: ${brief.title}`}>
      <div className="st-hero-frame">
        <BriefThumb brief={brief} eager>
          <span className="thumb-tl"><StateChip brief={brief} /></span>
        </BriefThumb>
      </div>
      <div className="st-hero-body">
        <span className="eh-badge plain"><SkipForward aria-hidden />Next up · soonest due</span>
        <div className="st-kicker">{brief.clientName}{brief.shootDate ? ` · shoot ${fmtDate(brief.shootDate)}` : ''}</div>
        <h2 className={`st-hero-title${brief.title.length > 40 ? ' long' : ''}`}>{brief.title}</h2>
        <p className="st-hero-sub"><DueLine brief={brief} />{brief.dueOn ? ' · ' : ''}{plural(brief.optionsWanted, 'option')} wanted{brief.draftOptions ? ` · ${brief.draftOptions} in the tray` : ''}</p>
        {brief.brief && <p className="st-hero-brief">{brief.brief}</p>}
        {brief.onImage && <p className="st-hero-words"><span>Words on the image</span><b>{brief.onImage}</b></p>}
        <div className="eh-actions">
          <Link className="btn primary eh-btn xl" to={thumbBriefPath(me, brief.id)}><Play className="ed-fill" aria-hidden />{readOnly ? 'Open brief' : brief.draftOptions ? 'Carry on' : 'Open brief'}</Link>
        </div>
        {!readOnly && <p className="st-hero-note">Picked by due date. Nothing reaches a manager until you send a round.</p>}
      </div>
    </section>
  );
}

function PickedHero({ brief, win, readOnly, now }: { brief: ThumbnailBrief; win: ThumbnailWin; readOnly: boolean; now: number }) {
  const { me } = useBoot();
  const allowed = useMotionAllowed();
  return (
    <section className="st-hero picked" aria-label={`Picked: option ${win.option.letter} for ${win.title}`}>
      {allowed && <span className="dt-glint" aria-hidden />}
      <div className="st-hero-frame">
        <Thumb src={win.option.url} alt={optionAlt(win.option, win.title)} eager className="ringed">
          <span className="thumb-letter" aria-hidden>{win.option.letter}</span>
        </Thumb>
      </div>
      <div className="st-hero-body">
        <span className="eh-badge"><Sparkles aria-hidden />Just picked</span>
        <div className="st-kicker">{win.clientName}</div>
        <h2 className={`st-hero-title${win.title.length > 40 ? ' long' : ''}`}>{win.title}</h2>
        <p className="st-hero-sub">{win.pickedByName} picked option {win.option.letter} · {fmtAgo(win.pickedAt, now)}</p>
        {win.reason && <blockquote className="st-hero-quote">{win.reason}</blockquote>}
        <div className="eh-actions">
          <a className="btn eh-btn dark" href="#st-wall" onClick={(e) => { e.preventDefault(); toWall(); }}>
            <Trophy aria-hidden />{readOnly ? 'Their wall of wins' : 'Your wall of wins'}
          </a>
          <Link className="btn eh-btn quiet" to={thumbBriefPath(me, brief.id)}>Open brief<ArrowRight aria-hidden /></Link>
        </div>
      </div>
    </section>
  );
}

function ClearHero({ s }: { s: StudioPayload }) {
  const latest = s.wins.slice(0, 4);
  return (
    <section className="st-hero clear" aria-label="All clear">
      <div className="st-hero-frame">
        {latest.length
          ? <div className={`st-mosaic n${latest.length}`}>{latest.map((w) => <Thumb key={w.option.id} src={w.option.url} alt={optionAlt(w.option, w.title)} eager />)}</div>
          : <Thumb alt="Your wall of wins starts with your first pick" title="Your wins hang here" sub="Wall of wins" tone="var(--mint)" />}
      </div>
      <div className="st-hero-body">
        <span className="eh-badge plain"><CircleCheck aria-hidden />All clear</span>
        <h2 className="st-hero-title long">Nothing on {s.readOnly ? 'their' : 'your'} plate right now</h2>
        <p className="st-hero-sub">
          {s.counts.waitingOnReview ? `${plural(s.counts.waitingOnReview, 'round')} waiting on review. ` : ''}
          {s.readOnly ? 'New briefs show up here when a manager hands them out.' : 'New briefs show up here the moment a manager hands one out.'}
        </p>
      </div>
    </section>
  );
}

// ── numbers ──────────────────────────────────────────────────────────────

function Numbers({ s }: { s: StudioPayload }) {
  const { clock } = useBoot();
  const c = s.counts;
  const dated = s.board.filter((b) => b.dueOn).sort((a, b) => a.dueOn!.localeCompare(b.dueOn!));
  // waiting longest first (the board itself is by due date)
  const inReview = s.board.filter((b) => b.state === 'in_review').sort((a, b) => (a.sentAt ?? '').localeCompare(b.sentAt ?? ''));
  // picked this month in the workspace's time zone, as the server counts it
  const month = startOfMonth(clock.today);
  const thisMonth = s.wins.filter((w) => onOrAfterDay(w.pickedAt, month, clock.timezone));
  return (
    <div className="st-kpis">
      <KpiCard tone="done" icon={<Trophy />} n={c.pickedThisMonth} cap="Picked this month"
        sub={thisMonth[0] ? `latest: ${thisMonth[0].title}` : 'none yet this month'}
        label={`${plural(c.pickedThisMonth, 'thumbnail')} picked this month.`}
        foot={<span className="kpi-row"><span>On the wall</span><b>{plural(s.wins.length, 'pick')}</b></span>} />
      <KpiCard tone="review" icon={<Clock />} n={c.waitingOnReview} cap="Waiting on review"
        sub={c.waitingOnReview ? 'with the managers' : 'nothing waiting'}
        label={`${plural(c.waitingOnReview, 'round')} waiting on review.`}
        foot={<span className="kpi-row"><span>{inReview[0] ? 'Oldest' : 'On the plate'}</span><b className="ellipsis">{inReview[0]?.title ?? plural(c.onPlate, 'brief')}</b></span>} />
      <KpiCard tone="today" icon={<CalendarClock />} n={c.dueThisWeek} cap="Due this week"
        sub={`${plural(c.onPlate, 'brief')} on the plate`}
        label={`${plural(c.dueThisWeek, 'brief')} due this week.`}
        foot={<span className="kpi-row"><span>Next</span><b className="ellipsis">{dated[0] ? `${dated[0].title} · ${fmtDate(dated[0].dueOn!, clock.today)}` : 'Nothing dated'}</b></span>} />
    </div>
  );
}

// ── the wall of wins ─────────────────────────────────────────────────────

const seenKey = (designerId: number) => `sm.studio.wins-seen.${designerId}`;
function loadSeen(key: string): Set<number> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const ids: unknown = JSON.parse(raw);
    return Array.isArray(ids) ? new Set(ids.filter((x): x is number => typeof x === 'number')) : null;
  } catch { return null; }
}
function saveSeen(key: string, ids: Set<number>) {
  try { localStorage.setItem(key, JSON.stringify([...ids].slice(-500))); } catch { /* private mode: they glint again next visit */ }
}

/**
 * Every pick, newest first, filtered by client. A win the designer hasn't seen on this device is marked New (in a
 * mint ring, and "(new)" for screen readers), and flips in with a glint (the newest one with a few sparks), once;
 * the very first visit treats only the newest as new. Remembered in this browser only. The New mark shows either
 * way; only when animations are on does anything move.
 */
function WallOfWins({ wins, readOnly, designerId, name }: { wins: ThumbnailWin[]; readOnly: boolean; designerId: number; name: string | null }) {
  const { clock } = useBoot();
  const tz = useDisplayTz();
  const { me } = useBoot();
  const allowed = useMotionAllowed();
  const [client, setClient] = useState<number | 'all'>('all');
  const clients = useMemo(() => {
    const m = new Map<number, { id: number; name: string; n: number }>();
    for (const w of wins) { const c = m.get(w.clientId) ?? { id: w.clientId, name: w.clientName, n: 0 }; c.n += 1; m.set(w.clientId, c); }
    return [...m.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  }, [wins]);
  const shown = client === 'all' ? wins : wins.filter((w) => w.clientId === client);

  // first seen on this device
  const key = seenKey(designerId);
  const seen = useRef<Set<number> | null | undefined>(undefined);
  const [fresh, setFresh] = useState<Set<number>>(() => new Set());
  const ids = wins.map((w) => w.option.id).join(',');
  useEffect(() => {
    if (readOnly) return;
    if (seen.current === undefined) seen.current = loadSeen(key);
    const list = ids ? ids.split(',').map(Number) : [];
    const known = seen.current;
    const added = known ? list.filter((id) => !known.has(id)) : list.slice(0, 1);
    const all = new Set([...(known ?? []), ...list]);
    seen.current = all;
    saveSeen(key, all);
    if (added.length) setFresh((prev) => new Set([...prev, ...added.slice(0, 6)]));
  }, [ids, readOnly, key]);
  // a few sparks from the newest new one, once it has flipped in
  const sparked = useRef(new Set<number>());
  useEffect(() => {
    const id = wins.find((w) => fresh.has(w.option.id) && !sparked.current.has(w.option.id))?.option.id;
    if (id == null || !motionAllowed()) return;
    const t = setTimeout(() => {
      sparked.current.add(id);
      const el = document.querySelector(`[data-win="${id}"]`);
      if (!el) return;
      const at = centerOf(el);
      burst(at.x, at.y, { count: 18, distance: 70 });
    }, 700);
    return () => clearTimeout(t);
  }, [fresh, wins]);

  const day = (ts: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', ...(ts.slice(0, 4) !== clock.today.slice(0, 4) ? { year: 'numeric' } : {}), timeZone: tz }).format(new Date(ts));
  return (
    <Panel id="st-wall" tabIndex={-1} title="Wall of wins" count={wins.length} sub={name ? `every thumbnail of ${name}’s that was picked` : 'every thumbnail of yours that was picked'} className="st-wall"
      tools={clients.length > 1 && clients.length <= 6 ? (
        <Seg role="group" aria-label="Client">
          <button type="button" aria-pressed={client === 'all'} onClick={() => setClient('all')}>All</button>
          {clients.map((c) => <button key={c.id} type="button" aria-pressed={client === c.id} onClick={() => setClient(c.id)}>{c.name}</button>)}
        </Seg>
      ) : clients.length > 6 ? (
        <select className="select sm" value={client} onChange={(e) => setClient(e.target.value === 'all' ? 'all' : Number(e.target.value))} aria-label="Client">
          <option value="all">All clients</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.n})</option>)}
        </select>
      ) : undefined}>
      {!wins.length
        ? <Empty boxed icon={<Trophy />} title={name ? `Nothing of ${name}’s picked yet` : 'Your wall starts with your first pick'}>Every option a manager picks hangs here, newest first.</Empty>
        : (
          <ul className={`wall${allowed ? ' animate' : ''}`}>
            {shown.map((w, i) => {
              // new is new whatever the Animations switch says; only the glint (and the flip-in and sparks) need motion
              const isNew = fresh.has(w.option.id);
              return (
                <li key={w.option.id} className={`win${isNew ? ' fresh' : ''}`} style={{ ['--i' as string]: Math.min(i, 14) }} data-win={w.option.id}>
                  <Link to={thumbBriefPath(me, w.briefId)} className="win-link" aria-label={`${w.title}, ${w.clientName}: option ${w.option.letter}, picked ${day(w.pickedAt)}${isNew ? ' (new)' : ''}`}>
                    <Thumb src={w.option.url} alt={optionAlt(w.option, w.title)} eager={i < 6}>
                      {isNew && allowed && <span className="dt-glint" aria-hidden />}
                      {isNew && <span className="thumb-tr"><Chip color="mint" icon={<Sparkles aria-hidden />}>New</Chip></span>}
                    </Thumb>
                    <span className="win-cap"><b>{w.title}</b><span>{w.clientName} · {day(w.pickedAt)}</span></span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
    </Panel>
  );
}
