// Portfolio (/studio/portfolio): a thumbnail designer's wall of every current winner they made, from
// GET /api/studio/portfolio (PortfolioPayload in shared/types.ts), filterable by client and month (?clientId= and
// ?month=YYYY-MM, so a filtered wall can be bookmarked; the server counts months in the workspace's time zone). Each
// card turns over (a click, Enter or Space; with animations off or reduced motion it crossfades instead), growing or
// shrinking to the other face's height as it turns, to its round story: every round sent, the changes asked and the
// notes on the designer's own rounds, who picked it, "Went live: <link> · <date>" and YouTube Test & Compare's winner
// when a manager recorded them. ?card=<optionId> (the went-live notification's link, portfolioPath) opens on that card,
// turned over. Beside the wall, a quiet panel of private growth figures over the last GROWTH_MONTHS months, whatever
// the filters (portfolioGrowth in shared/workflow.ts): picks per month as small bars (a bar shows that month's wins on
// the wall, every client's: barFilter), the first-round pick rate as a plain sentence (only ever here, never on the
// Studio's hero), standouts, and what managers' notes are usually about as tag chips. No points, levels, streaks or
// rankings, and never one designer against another. A manager opens a designer's with ?userId= (read-only); without
// one they pick a designer. A past thumbnail a manager added from YouTube (story.importedFrom) has no rounds: its card
// reads "Added from YouTube", with "Watch on YouTube", and it counts in its month's picks but not in the first-round rate.

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowRight, Download, Images, Import, Info, Rotate3d, RotateCcw, Sparkles, Tag, Trophy, Undo2 } from 'lucide-react';
import { api, qs, type ApiError } from '../api';
import type { PortfolioCard, PortfolioPayload } from '../../../shared/types';
import {
  barFilter, clientFilterControl, GROWTH_MONTHS, isManager, isThumbnailDesigner, portfolioPath, THUMB_PIN_TAG_LABEL, thumbBriefPath,
  type PortfolioGrowth, type RoundStep, type RoundStory,
} from '../../../shared/workflow';
import { isYearMonth, type YearMonth } from '../../../shared/dates';
import { fmtYearMonth, plural } from '../../../shared/format';
import { PageHeader, useBoot, useDisplayTz } from '../components/Shell';
import { Button, Chip, Empty, ErrorState, Loading, Panel, Seg, Thumb } from '../components/ui';
import { optionAlt } from '../components/ThumbBits';
import { LiveBadge, LiveLine, TestWinnerLine } from '../components/ThumbLive';
import { AddedFromYoutube } from '../components/ThumbImport';
import { motionAllowed, useMotionAllowed } from '../motion';
import { PickDesigner } from './Studio';

export function StudioPortfolioPage() {
  const { me } = useBoot();
  const [params] = useSearchParams();
  const manager = isManager(me.role);
  // a designer always gets their own portfolio; a manager names the designer
  const userId = manager ? params.get('userId') ?? '' : '';
  if (manager && !/^\d+$/.test(userId)) return <PickDesigner page="portfolio" />;
  return <PortfolioView key={userId || 'me'} userId={userId} />;
}

/** The filters in the address, or nothing when they aren't ones the server would take. */
function useFilters() {
  const [params, setParams] = useSearchParams();
  const rawClient = params.get('clientId') ?? '';
  const rawMonth = params.get('month') ?? '';
  const clientId = /^\d+$/.test(rawClient) ? rawClient : '';
  const month = isYearMonth(rawMonth) ? rawMonth : '';
  const cardRaw = params.get('card') ?? '';
  const card = /^\d+$/.test(cardRaw) ? Number(cardRaw) : null;
  // a filter that isn't one (a mistyped month, say) comes out of the address rather than turning into an error
  const bad = (!!rawClient && !clientId) || (!!rawMonth && !month);
  useEffect(() => {
    if (!bad) return;
    const p = new URLSearchParams(params);
    if (!clientId) p.delete('clientId');
    if (!month) p.delete('month');
    setParams(p, { replace: true });
  }, [bad, clientId, month, params, setParams]);
  /** Sets or clears filters (an empty string clears one). The card a link opened on never carries over: it's let go too. */
  const set = (patch: { clientId?: string; month?: string }) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v) p.set(k, v); else p.delete(k); }
    p.delete('card');
    setParams(p, { replace: true });
  };
  return { clientId, month, card, set };
}

function PortfolioView({ userId }: { userId: string }) {
  const { me } = useBoot();
  const f = useFilters();
  const q = useQuery({
    queryKey: ['portfolio', userId || 'me', f.clientId, f.month],
    queryFn: () => api<PortfolioPayload>(`/api/studio/portfolio${qs({ userId, clientId: f.clientId, month: f.month })}`),
    // the wall stays put while a new filter loads
    placeholderData: keepPreviousData,
  });
  if ((q.error as ApiError | null)?.status === 404 && isManager(me.role)) return <PickDesigner page="portfolio" missing />;
  const head = <PageHeader title="Portfolio" crumbs={<><Link to={userId ? `/studio?userId=${userId}` : '/studio'}>Studio</Link><span aria-hidden>›</span><span>Portfolio</span></>} hideNewWork />;
  if (q.isLoading) return <div className="studio pf">{head}<Loading height={420} /></div>;
  if (q.isError && !q.data) return <div className="studio pf">{head}<ErrorState error={q.error} retry={() => q.refetch()} /></div>;
  return <Portfolio p={q.data!} filtering={q.isPlaceholderData} refreshFailed={q.isError} filters={f} />;
}

type Filters = ReturnType<typeof useFilters>;

function Portfolio({ p, filtering, refreshFailed, filters }: { p: PortfolioPayload; filtering: boolean; refreshFailed: boolean; filters: Filters }) {
  const { users } = useBoot();
  const nav = useNavigate();
  const allowed = useMotionAllowed();
  const first = p.designer.name.split(' ')[0];
  const others = users.filter((u) => u.active && !u.removed && isThumbnailDesigner(u));
  const filtered = !!filters.clientId || !!filters.month;
  const clientName = p.clients.find((c) => String(c.id) === filters.clientId)?.name ?? null;

  // cards turned over to their story; a link's ?card= opens on that one, turned, in view and with focus on it
  const [turned, setTurned] = useState<Set<number>>(() => new Set(filters.card != null ? [filters.card] : []));
  const turn = (id: number, on: boolean) => {
    setTurned((prev) => { const next = new Set(prev); if (on) next.add(id); else next.delete(id); return next; });
    if (!on && id === filters.card) filters.set({});
  };
  const target = filters.card;
  const found = target != null && p.cards.some((c) => c.option.id === target);
  const targetTurned = target != null && turned.has(target);
  const shown = useRef<number | null>(null);
  useEffect(() => {
    if (target == null || !found) return;
    if (!targetTurned) { setTurned((prev) => new Set(prev).add(target)); return; }
    if (shown.current === target) return;
    // once it's turned (its back no longer inert): in view, with the keyboard on it
    const raf = requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-card="${target}"]`);
      if (!el) return;
      shown.current = target;
      el.scrollIntoView({ behavior: motionAllowed() ? 'smooth' : 'auto', block: 'center' });
      el.querySelector<HTMLElement>('.pf-back-btn')?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [target, found, targetTurned]);

  const what = [clientName, filters.month ? fmtYearMonth(filters.month) : null].filter(Boolean).join(' · ');
  return (
    <div className="studio pf">
      <PageHeader
        title={p.readOnly ? `${p.designer.name}’s portfolio` : 'Your portfolio'}
        crumbs={p.readOnly
          ? <><Link to="/thumbnails">Thumbnails</Link><span aria-hidden>›</span><Link to={`/studio?userId=${p.designer.id}`}>{first}’s Studio</Link><span aria-hidden>›</span><span>Portfolio</span></>
          : <><Link to="/studio">Studio</Link><span aria-hidden>›</span><span>Portfolio</span></>}
        sub={<>{p.readOnly ? 'Every thumbnail of theirs that was picked, and how it got there. What they see, read-only.' : 'Every thumbnail of yours that was picked, and how it got there. Only you and the managers see this page.'}{refreshFailed && <span role="status"> · couldn’t refresh just now, so this may be out of date</span>}</>}
        hideNewWork>
        {p.readOnly && others.length > 1 && (
          <select className="select st-switch" value={p.designer.id} onChange={(e) => nav(portfolioPath({ userId: Number(e.target.value) }))} aria-label="Whose portfolio">
            {others.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        )}
      </PageHeader>

      {target != null && !found && !filtered && !filtering && (
        <div className="banner pf-gone" role="status">
          <Info aria-hidden />
          <div className="txt"><b>That thumbnail isn’t on the wall now</b><span>It may have been decided again, or its brief cancelled. Everything still picked is below.</span></div>
          <Button variant="sm ghost" onClick={() => filters.set({})}>OK</Button>
        </div>
      )}

      <div className="grid g-main-side pf-cols">
        <Panel title={p.readOnly ? 'Their wins' : 'Your wins'} count={p.total} className="pf-wall-panel"
          sub={filtered ? `${plural(p.cards.length, 'win')} ${what ? `in ${what}` : ''}` : 'newest pick first · turn a card over for how it came about'}>
          {p.total > 0 && <WallFilters p={p} filters={filters} />}
          {!p.total ? (
            <Empty boxed icon={<Trophy />} title={p.readOnly ? `Nothing of ${first}’s picked yet` : 'Your portfolio starts with your first pick'}>
              Every option a manager picks goes here, with the rounds it took and where it went live.
            </Empty>
          ) : !p.cards.length ? (
            <Empty boxed icon={<Images />} title="No wins match these filters"
              action={<Button variant="sm" onClick={() => filters.set({ clientId: '', month: '' })}>Show every win</Button>} />
          ) : (
            <ul className={`pf-wall${allowed ? ' animate' : ''}${filtering ? ' busy' : ''}`} aria-busy={filtering || undefined}>
              {p.cards.map((c, i) => (
                <FlipCard key={c.option.id} c={c} i={i} turned={turned.has(c.option.id)} target={c.option.id === target} readOnly={p.readOnly} turnMode={allowed} onTurn={turn} />
              ))}
            </ul>
          )}
        </Panel>
        {/* a bar counts every client's picks, so showing its month shows them all: the client filter goes */}
        <Growth g={p.growth} readOnly={p.readOnly} first={first} month={filters.month}
          onMonth={(m) => filters.set(barFilter(filters, m))} />
      </div>
    </div>
  );
}

/** By client (a segmented control for a few with short names, a list otherwise: clientFilterControl) and by month; both stay in the address. */
function WallFilters({ p, filters }: { p: PortfolioPayload; filters: Filters }) {
  const cid = filters.clientId;
  const control = clientFilterControl(p.clients);
  return (
    <div className="filters pf-filters" role="search" aria-label="Filter the wall">
      {control === 'buttons' ? (
        <Seg role="group" aria-label="Client">
          <button type="button" aria-pressed={!cid} onClick={() => filters.set({ clientId: '' })}>All</button>
          {p.clients.map((c) => (
            <button key={c.id} type="button" aria-pressed={cid === String(c.id)} onClick={() => filters.set({ clientId: String(c.id) })} aria-label={`${c.name}, ${plural(c.wins, 'win')}`}
              title={c.name}><span className="ellipsis">{c.name}</span></button>
          ))}
        </Seg>
      ) : control === 'list' ? (
        <select className="select sm pf-select" value={cid} onChange={(e) => filters.set({ clientId: e.target.value })} aria-label="Client">
          <option value="">All clients</option>
          {p.clients.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.wins})</option>)}
        </select>
      ) : null}
      {p.months.length > 1 && (
        <select className="select sm pf-select" value={filters.month} onChange={(e) => filters.set({ month: e.target.value })} aria-label="Month picked">
          <option value="">Any month</option>
          {/* a month a link named stays offered, even with nothing in it */}
          {filters.month && !p.months.some((m) => m.month === filters.month) && <option value={filters.month}>{fmtYearMonth(filters.month)} (0)</option>}
          {p.months.map((m) => <option key={m.month} value={m.month}>{fmtYearMonth(m.month)} ({m.wins})</option>)}
        </select>
      )}
      {(cid || filters.month) && <Button variant="sm ghost" onClick={() => filters.set({ clientId: '', month: '' })}>Clear filters</Button>}
    </div>
  );
}

// ── a card that turns over ───────────────────────────────────────────────

const OUTCOME: Record<RoundStep['outcome'], string> = { changes: 'changes asked', picked: 'picked', none: 'replaced before anyone decided' };

/** On the front, a few words of how it came about. */
function peekWords(s: RoundStory): string {
  if (s.importedFrom) return 'Added from YouTube';
  const last = s.rounds[s.rounds.length - 1];
  if (s.firstRound || !last) return 'Picked from the first round';
  return s.changesAsked ? `Round ${last.number}, after ${plural(s.changesAsked, 'round')} of changes` : `Picked in round ${last.number}`;
}

/** How long a card takes to turn over, and its curve: the same as the turn's transition in app.css (.pf-flip). */
const TURN = { duration: 640, easing: 'cubic-bezier(.23, 1, .32, 1)' };

/**
 * One win: its picture on the front (Standout and Live marked), its story on the back. The front's whole face is one
 * button that turns it over; the back's ↺ (or Esc) turns it back, and focus follows to the face that's showing (the
 * hidden face is inert). With animations on it turns in 3D, growing or shrinking to the other face's height in step
 * (so the cards below glide); otherwise the faces crossfade and the height simply changes.
 */
function FlipCard({ c, i, turned, target, readOnly, turnMode, onTurn }: {
  c: PortfolioCard; i: number; turned: boolean; target: boolean; readOnly: boolean; turnMode: boolean; onTurn: (id: number, on: boolean) => void;
}) {
  const { me, clock } = useBoot();
  const tz = useDisplayTz();
  const backId = useId();
  const titleId = useId();
  const front = useRef<HTMLButtonElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLLIElement>(null);
  // how tall the card was when it was turned, until its new height is drawn
  const was = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = card.current;
    const from = was.current;
    was.current = null;
    if (!el || from == null || !turnMode) return;
    const to = el.offsetHeight;
    if (Math.abs(to - from) < 2) return;
    el.dataset.moving = '';
    const grow = el.animate([{ height: `${from}px` }, { height: `${to}px` }], TURN);
    const done = () => { delete el.dataset.moving; };
    grow.onfinish = done;
    grow.oncancel = done;
    return () => grow.cancel();
  }, [turned, turnMode]);
  const day = (ts: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', ...(ts.slice(0, 4) !== clock.today.slice(0, 4) ? { year: 'numeric' } : {}), timeZone: tz }).format(new Date(ts));
  const flip = (on: boolean) => {
    was.current = card.current?.offsetHeight ?? null;
    onTurn(c.option.id, on);
    // the face that's showing takes the keyboard (the other one is inert once React has drawn it)
    requestAnimationFrame(() => (on ? back : front).current?.focus({ preventScroll: true }));
  };
  const picked = day(c.pickedAt);
  const yt = c.story.importedFrom ? c.imported ?? null : null;
  // "Watch on YouTube" already opens the video's own page: its went-live line keeps only the day then
  const live = c.live && yt && c.live.url === yt.url ? { ...c.live, url: null } : c.live;
  return (
    <li ref={card} className={`pf-card${turned ? ' turned' : ''}${target ? ' target' : ''}${c.standout ? ' standout' : ''}`} style={{ ['--i' as string]: Math.min(i, 14) }} data-card={c.option.id}>
      <div className="pf-flip" data-mode={turnMode ? 'turn' : 'fade'}>
        <div className="pf-face pf-front" inert={turned}>
          <Thumb src={c.coverUrl} alt={optionAlt(c.option, c.title)} eager={i < 6}>
            {c.standout && <span className="thumb-tl"><Chip color="yellow" icon={<Trophy aria-hidden />}>Standout</Chip></span>}
            <span className="thumb-tr pf-hint" aria-hidden><Rotate3d /></span>
          </Thumb>
          <span className="pf-cap">
            <b>{c.title}</b>
            <span>{c.clientName} · {picked}</span>
          </span>
          <span className={`pf-peek${c.story.firstRound ? ' first' : ''}`}><StoryIcon story={c.story} />{peekWords(c.story)}</span>
          <button ref={front} type="button" className="pf-turn" aria-controls={backId} onClick={() => flip(true)}
            aria-label={`${c.title}, ${c.clientName}: ${yt ? `added from YouTube, live ${picked}` : `option ${c.option.letter}, picked ${picked}`}${c.standout ? ', a standout' : ''}${c.live && !yt ? ', live' : ''}. Turn over for how it came about`} />
          {/* over the picture's corner, beside the button: a link can't sit inside one */}
          {c.live && <span className="pf-over"><LiveBadge live={c.live} /></span>}
        </div>
        <div className="pf-face pf-back" id={backId} inert={!turned} role="group" aria-labelledby={titleId}
          onKeyDown={(e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); flip(false); } }}>
          <div className="pf-back-head">
            <span className="pf-back-tt">
              <b id={titleId} className="pf-back-t">{c.title}</b>
              <span className="pf-back-k">{c.clientName} · option {c.option.letter}</span>
            </span>
            <button ref={back} type="button" className="icon-btn sm pf-back-btn" onClick={() => flip(false)} aria-label={`Turn “${c.title}” back to the picture`} title="Turn back (Esc)"><Undo2 aria-hidden /></button>
          </div>
          {yt && <AddedFromYoutube imported={yt} compact className="pf-yt" />}
          <Story story={c.story} readOnly={readOnly} />
          <p className="pf-who">
            {c.standout && <Chip color="yellow" icon={<Trophy aria-hidden />}>Standout</Chip>}
            <span>{yt ? `${c.pickedByName} added it to ${readOnly ? 'their' : 'your'} wall` : `${c.pickedByName} picked it · ${picked}`}</span>
          </p>
          {live
            ? <><LiveLine live={live} /><TestWinnerLine winner={live.testWinner} note={live.testNote} title={c.title} /></>
            : <p className="pf-notlive">Not marked live yet.</p>}
          <div className="pf-back-acts">
            <Link className="btn sm ghost" to={thumbBriefPath(me, c.briefId)}>Open brief<ArrowRight aria-hidden /></Link>
            <a className="btn sm ghost" href={`${c.coverUrl}?download=1`} download={c.option.fileName} aria-label={`Download option ${c.option.letter} for “${c.title}” at full quality`}><Download aria-hidden />Download</a>
          </div>
        </div>
      </div>
    </li>
  );
}

/** The icon beside a story's few words: first round, more rounds, or added from YouTube. */
function StoryIcon({ story }: { story: RoundStory }) {
  return story.importedFrom ? <Import aria-hidden /> : story.firstRound ? <Sparkles aria-hidden /> : <RotateCcw aria-hidden />;
}

/**
 * The rounds, oldest first: Round 1 · 3 options · changes asked, “the note” → Round 2 · 2 options · picked. A past
 * thumbnail added from YouTube has none to tell: it was out there before it came to the site.
 */
function Story({ story, readOnly }: { story: RoundStory; readOnly: boolean }) {
  if (story.importedFrom) {
    return (
      <div className="pf-story">
        <p className="pf-story-yt">It went live on YouTube before it came to the site, so there are no rounds or notes to show.</p>
      </div>
    );
  }
  return (
    <div className="pf-story">
      <span className={`pf-story-lead${story.firstRound ? ' first' : ''}`}><StoryIcon story={story} />{peekWords(story)}</span>
      <ol className="pf-steps">
        {story.rounds.map((s) => (
          <li key={s.number} className={`pf-step ${s.outcome}${s.mine ? '' : ' theirs'}`}>
            <span className="pf-step-n" aria-hidden>R{s.number}</span>
            <span className="pf-step-b">
              <span className="pf-step-t">
                <span className="sr-only">Round {s.number}: </span>{plural(s.options, 'option')} · {OUTCOME[s.outcome]}
                {!s.mine && <span className="dim">{readOnly ? ' · before it came to them' : ' · before it came to you'}</span>}
              </span>
              {s.note && <q className="pf-step-q">{s.note}</q>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ── private growth ───────────────────────────────────────────────────────

/**
 * The last GROWTH_MONTHS months, whatever the wall's filters: picks per month, the first-round pick rate in a plain
 * sentence, standouts, and what notes are usually about. Only the designer and the managers see it.
 */
function Growth({ g, readOnly, first, month, onMonth }: { g: PortfolioGrowth; readOnly: boolean; first: string; month: string; onMonth: (m: YearMonth) => void }) {
  const your = readOnly ? 'their' : 'your';
  const tagged = g.themes.reduce((n, t) => n + t.count, 0);
  const themesId = useId();
  const Your = readOnly ? 'Their' : 'Your';
  // out of the picks that had rounds (roundPicks): a past thumbnail added from YouTube had none, so it's left out
  const imports = g.importedPicks
    ? ` ${g.importedPicks === 1 ? 'The 1 added from YouTube isn’t' : `The ${g.importedPicks} added from YouTube aren’t`} counted: ${g.importedPicks === 1 ? 'it' : 'they'} had no rounds.`
    : '';
  const rate = g.firstRoundRate == null
    ? g.importedPicks
      ? `${g.importedPicks === 1 ? `${Your} 1 pick` : `All ${g.importedPicks} of ${your} picks`} in that time ${g.importedPicks === 1 ? 'was' : 'were'} added from YouTube, so there’s no first-round rate yet.`
      : `No picks in the last ${GROWTH_MONTHS} months yet.`
    : (g.firstRoundPicks === g.roundPicks ? `${g.roundPicks === 1 ? `${Your} 1 pick` : `All ${g.roundPicks} of ${your} picks`} came from the brief’s first round.`
      : g.firstRoundPicks === 0 ? `None of ${your} ${plural(g.roundPicks, 'pick')} came from the brief’s first round: each took another round.`
      : `${g.firstRoundPicks} of ${your} ${plural(g.roundPicks, 'pick')} came from the brief’s first round: ${g.firstRoundRate}%.`) + imports;
  const standouts = g.standouts ? `${plural(g.standouts, 'standout')}: ${g.standouts === 1 ? 'a pick' : 'picks'} a manager marked as one of the best.` : 'No picks marked Standout in that time.';
  return (
    <Panel title={readOnly ? `${first}’s last ${GROWTH_MONTHS} months` : `Your last ${GROWTH_MONTHS} months`} className="pf-growth"
      sub={readOnly ? 'private to them and the managers, worked out from their picks' : 'private, worked out from your picks and the notes on your rounds'}>
      <MonthBars months={g.months} month={month} onMonth={onMonth} />
      <ul className="pf-lines">
        <li><Sparkles aria-hidden /><span>{rate}</span></li>
        <li><Trophy aria-hidden /><span>{standouts}</span></li>
      </ul>
      <section className="pf-themes" aria-labelledby={themesId}>
        <h3 id={themesId} className="section-title">What notes are usually about</h3>
        {g.themes.length ? (
          <ul className="pf-tags">
            {g.themes.map((t) => (
              <li key={t.tag}><Chip color="plain" icon={<Tag aria-hidden />}>{THUMB_PIN_TAG_LABEL[t.tag]}<b className="pf-tag-n">{t.count}</b><span className="sr-only">{t.count === 1 ? ' note' : ' notes'}</span></Chip></li>
            ))}
          </ul>
        ) : <p className="muted pf-quiet">{g.notes ? 'None of the notes had a tag.' : `No notes on the image of ${your} rounds in that time.`}</p>}
        {g.notes > 0 && <p className="help pf-quiet">{plural(g.notes, 'note')} pinned on {your} rounds{tagged < g.notes ? `, ${tagged} with a tag` : ''}, counted by each round’s latest decision.</p>}
      </section>
    </Panel>
  );
}

/**
 * Picks per month as small glowing bars, built from the tokens like the due-by-day tiles: the number is the exact
 * count (never the height alone), this month is outlined, and a bar with picks shows that month's wins on the wall.
 */
function MonthBars({ months, month, onMonth }: { months: PortfolioGrowth['months']; month: string; onMonth: (m: YearMonth) => void }) {
  const { clock } = useBoot();
  const allowed = useMotionAllowed();
  const max = Math.max(1, ...months.map((m) => m.picks));
  const now = clock.today.slice(0, 7);
  const total = months.reduce((n, m) => n + m.picks, 0);
  const summary = useMemo(() => months.map((m) => `${fmtYearMonth(m.month)}: ${m.picks}`).join('; '), [months]);
  return (
    <figure className="pf-chart">
      <figcaption className="pf-chart-h"><b>Picks per month</b><span>{plural(total, 'pick')}</span></figcaption>
      <p className="sr-only">Picks per month, oldest first. {summary}.</p>
      <ol className={`pf-bars${allowed ? ' animate' : ''}`}>
        {months.map((m, i) => {
          const lvl = m.picks ? Math.max(10, Math.round((m.picks / max) * 100)) : 0;
          const on = month === m.month;
          return (
            <li key={m.month} className={`pf-bar${m.month === now ? ' now' : ''}${m.picks ? '' : ' none'}${on ? ' on' : ''}`} style={{ ['--i' as string]: i }}>
              <button type="button" className="pf-bar-btn" disabled={!m.picks} aria-pressed={on} onClick={() => onMonth(m.month)}
                aria-label={`${fmtYearMonth(m.month)}: ${plural(m.picks, 'pick')}${m.picks ? on ? '. Showing them on the wall: press to show every win' : '. Show them on the wall' : ''}`}>
                <span className="pf-bar-n" aria-hidden>{m.picks}</span>
                <span className="pf-bar-track" aria-hidden><span className="pf-bar-lvl" style={{ height: `${lvl}%` }} /></span>
                <span className="pf-bar-m" aria-hidden>{fmtYearMonth(m.month, { short: true, today: clock.today })}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </figure>
  );
}
