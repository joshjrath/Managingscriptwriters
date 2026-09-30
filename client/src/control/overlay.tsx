// The typography of the Control Center: the frame, the navigation, the
// editorial statement for each view, micro details, the signal feed, and the
// labels pinned to places in space (moved every frame by the view, not React).

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  bandOf, coverageOf, fmtAgo, fmtCountdown, fmtHoursMinutes, localClock, metricsOf, PHASES, phaseOf, presenceOf,
  STATE_LABEL, utcClock, type Anomaly, type CcHandoff, type ControlWorld,
} from '../../../shared/control';
import type { Filter, Focus, Mode, Target } from './engine/Engine';
import type { WorldView } from './engine/view';

export const ViewCtx = createContext<WorldView | null>(null);

/** A label pinned to something in space; the view moves it every frame. */
export function Anchor({ k, className = '', children }: { k: string; className?: string; children: ReactNode }) {
  const view = useContext(ViewCtx);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!view || !ref.current) return;
    return view.bind(k, ref.current);
  }, [view, k]);
  return <div ref={ref} className={`anc ${className}`}>{children}</div>;
}

export const MODES: { mode: Mode; label: string }[] = [
  { mode: 'world', label: 'WORLD' },
  { mode: 'missions', label: 'MISSIONS' },
  { mode: 'deadlines', label: 'DEADLINES' },
  { mode: 'timezones', label: 'TIMEZONES' },
  { mode: 'signals', label: 'SIGNALS' },
  { mode: 'constellation', label: 'CONSTELLATION' },
  { mode: 'galaxy', label: 'GALAXY' },
  { mode: 'archive', label: 'ARCHIVE' },
  { mode: 'system', label: 'SYSTEM' },
];

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

// ── frame ────────────────────────────────────────────────────────────────

export function Top({ world, now, offset, soundOn, onSound, onPalette, onExit }: {
  world: ControlWorld; now: Date; offset: number; soundOn: boolean; onSound: () => void; onPalette: () => void; onExit: () => void;
}) {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const date = now.toISOString().slice(0, 10);
  const scrubbed = Math.abs(offset) > 60_000;
  return (
    <header className="cc-top">
      <div className="cc-brand">
        <div className="mark"><i aria-hidden /><span className="full">SCALE MEDIA <span style={{ color: 'var(--faint)' }}>/</span> </span>CONTROL CENTER</div>
        <div className={`sub${world.source.kind === 'simulated' ? ' sim' : ''}`}>{world.version} · <b>{world.source.label}</b></div>
      </div>
      <div className="cc-clock">
        <div className="utc" aria-live="off"><span>{scrubbed ? 'SCRUBBED' : 'UTC'}</span>{utcClock(now)}</div>
        <div className={`date${scrubbed ? ' scrub' : ''}`}>{date} {scrubbed ? `· ${offset > 0 ? '+' : '−'}${fmtCountdown(Math.abs(offset))}` : ''}</div>
        <div className="cc-controls">
          <button onClick={onPalette} aria-label="Open command search"><kbd>{mac ? '⌘' : 'CTRL'} K</kbd><span className="wide">SEARCH</span></button>
          <button onClick={onSound} className={soundOn ? 'on' : ''} aria-pressed={soundOn}>SOUND {soundOn ? 'ON' : 'OFF'}</button>
          <button onClick={onExit}>EXIT</button>
        </div>
      </div>
    </header>
  );
}

export function Nav({ mode, onMode }: { mode: Mode; onMode: (m: Mode) => void }) {
  return (
    <nav className="cc-nav" aria-label="Views">
      {MODES.map((m, i) => (
        <span key={m.mode} style={{ display: 'contents' }}>
          {(i === 5 || i === 8) && <span className="group" aria-hidden />}
          <button aria-current={mode === m.mode} onClick={() => onMode(m.mode)} aria-keyshortcuts={String(i + 1)}>
            <span className="n">{pad(i + 1)}</span>
            <span className="tick" aria-hidden />
            {m.label}
          </button>
        </span>
      ))}
    </nav>
  );
}

// ── the statement for each view ──────────────────────────────────────────

const TITLES: Record<Mode, [string, string]> = {
  world: ['The world', 'is writing'],
  missions: ['Active', 'operations'],
  deadlines: ['Everything', 'arrives'],
  timezones: ['Follow', 'the sun'],
  signals: ['In', 'transit'],
  constellation: ['The company', 'as a network'],
  galaxy: ['Every script', 'a star'],
  archive: ['What we', 'have written'],
  system: ['Internal', 'diagnostics'],
};

function Title({ lines, k }: { lines: [string, string]; k: string }) {
  return (
    <h1 key={k}>
      <span className="l"><span>{lines[0]}</span></span>
      <span className="l"><span><em>{lines[1]}</em></span></span>
    </h1>
  );
}

function Metric({ v, l, warn }: { v: ReactNode; l: string; warn?: boolean }) {
  return <div className={warn ? 'warn' : ''}><b>{v}</b><span>{l}</span></div>;
}

export function Statement({ mode, world, now, anomalies }: { mode: Mode; world: ControlWorld; now: Date; anomalies: Anomaly[] }) {
  const m = metricsOf(world, now);
  const cov = coverageOf(world.writers, now);
  const live = world.projects.filter((p) => !p.archived);
  const liveIds = new Set(live.map((p) => p.id));
  const writerName = (id: string | undefined) => world.writers.find((w) => w.id === id);
  let metrics: ReactNode = null;
  let empty: ReactNode = null;
  if (mode === 'world' || mode === 'system') {
    metrics = (
      <>
        <Metric v={`${pad(m.onShift)} / ${pad(m.nodes)}`} l="ACTIVE NODES" />
        <Metric v={pad(m.scriptsInMotion)} l="SCRIPTS IN MOTION" />
        <Metric v={fmtHoursMinutes(cov.coveredMinutes)} l="COVERAGE" />
        <Metric v={pad(anomalies.length)} l="PRESSURE POINTS" warn={anomalies.length > 0} />
      </>
    );
    if (!m.onShift && cov.nextOnline) {
      const w = writerName(cov.nextOnline.writerId);
      empty = <div className="empty"><b>GLOBAL NETWORK QUIET</b>NEXT NODE ONLINE · {w?.city.toUpperCase()} · {fmtCountdown(cov.nextOnline.in)}</div>;
    }
    if (!world.writers.length) empty = <div className="empty"><b>NO NODES PLACED</b>SET CITIES IN SETTINGS → TEAM</div>;
  } else if (mode === 'missions') {
    const next = live.filter((p) => p.deadline && new Date(p.deadline) > now).sort((a, b) => a.deadline!.localeCompare(b.deadline!))[0];
    metrics = (
      <>
        <Metric v={pad(live.length)} l="OPERATIONS" />
        <Metric v={pad(world.scripts.filter((s) => liveIds.has(s.projectId)).length)} l="SCRIPTS" />
        <Metric v={pad(m.clientQueue)} l="WITH CLIENTS" />
        {next && <Metric v={fmtCountdown(new Date(next.deadline!).getTime() - now.getTime())} l={`NEXT · ${next.client.toUpperCase()}`} />}
      </>
    );
    if (!live.length) empty = <div className="empty"><b>NO ACTIVE OPERATIONS</b>THE NETWORK IS BETWEEN PROJECTS</div>;
  } else if (mode === 'deadlines') {
    const open = world.scripts.filter((s) => liveIds.has(s.projectId) && s.state !== 'delivered' && s.state !== 'approved');
    const count = (b: string) => open.filter((s) => bandOf(s.deadline, now).band === b).length;
    const overdue = count('OVERDUE');
    metrics = (
      <>
        {overdue > 0 && <Metric v={pad(overdue)} l="OVERDUE" warn />}
        <Metric v={pad(count('24H'))} l="WITHIN 24H" warn={count('24H') > 0} />
        <Metric v={pad(count('48H'))} l="WITHIN 48H" />
        <Metric v={pad(count('7D'))} l="WITHIN 7D" />
        <Metric v={pad(count('30D'))} l="WITHIN 30D" />
      </>
    );
    if (!overdue && !count('24H') && !count('48H')) empty = <div className="empty"><b>TRAJECTORIES STABLE</b>NOTHING ARRIVES IN THE NEXT 48 HOURS</div>;
  } else if (mode === 'signals') {
    const day = world.handoffs.filter((h) => now.getTime() - new Date(h.timestamp).getTime() < 86_400_000);
    const last = world.handoffs.slice().sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
    metrics = (
      <>
        <Metric v={pad(day.length)} l="HANDOFFS · 24H" />
        <Metric v={pad(m.handoffChannels)} l="ACTIVE CHANNELS" />
        {last && <Metric v={fmtAgo(now.getTime() - new Date(last.timestamp).getTime())} l="LAST TRANSFER" />}
      </>
    );
    if (!day.length) empty = <div className="empty"><b>NO ACTIVE HANDOFFS</b>TRANSFERS APPEAR HERE AS WORK MOVES</div>;
  } else if (mode === 'constellation') {
    metrics = (
      <>
        <Metric v={pad(world.writers.length)} l="PEOPLE" />
        <Metric v={pad(live.length)} l="OPERATIONS" />
        <Metric v={pad(new Set(live.map((p) => p.clientId)).size)} l="CLIENTS" />
        <Metric v={pad(world.links.length)} l="RELATIONSHIPS" />
      </>
    );
  } else if (mode === 'galaxy') {
    metrics = (
      <>
        <Metric v={world.scripts.length} l="OBJECTS" />
        <Metric v={pad(world.scripts.filter((s) => liveIds.has(s.projectId) && s.state !== 'delivered').length)} l="IN MOTION" />
        <Metric v={pad(world.scripts.filter((s) => s.state === 'delivered').length)} l="DELIVERED" />
      </>
    );
  } else if (mode === 'archive') {
    const done = world.projects.filter((p) => p.archived);
    const oldest = done.reduce((a, p) => Math.max(a, p.completedAt ? now.getTime() - new Date(p.completedAt).getTime() : 0), 0);
    metrics = (
      <>
        <Metric v={pad(world.scripts.filter((s) => s.state === 'delivered').length)} l="SCRIPTS DELIVERED" />
        <Metric v={pad(done.length)} l="FINISHED OPERATIONS" />
        {oldest > 0 && <Metric v={`${Math.floor(oldest / 86_400_000)}D`} l="OLDEST LIGHT" />}
      </>
    );
    if (!done.length) empty = <div className="empty"><b>THE ARCHIVE IS EMPTY</b>DELIVERED WORK DRIFTS HERE</div>;
  }
  if (mode === 'timezones') return null;
  return (
    <section className="cc-statement" aria-live="polite">
      <Title lines={TITLES[mode]} k={mode} />
      <div className="cc-metrics" key={`m-${mode}`}>{metrics}</div>
      {empty}
    </section>
  );
}

// ── micro information ────────────────────────────────────────────────────

export function Micro({ world, now, geo, sync }: { world: ControlWorld; now: Date; geo: { lat: number; lon: number } | null; sync: { at: number; skew: number; ok: number; total: number; packets: number } }) {
  const m = metricsOf(world, now);
  const recent = world.handoffs.filter((h) => now.getTime() - new Date(h.timestamp).getTime() < 3_600_000).length;
  const skew = sync.skew / 1000;
  return (
    <aside className="cc-micro" aria-hidden>
      <div>NETWORK <b>{pad(m.onShift)}/{pad(m.nodes)}</b></div>
      <div>UTC SYNC <b>{skew >= 0 ? '+' : '−'}{Math.abs(skew).toFixed(3).padStart(6, '0')}</b></div>
      <div>SIGNAL <b>{sync.total ? ((sync.ok / sync.total) * 100).toFixed(1) : '100.0'}%</b></div>
      <div>PACKET <b>{pad(sync.packets, 5)}</b> RECEIVED</div>
      <div>ACTIVE STREAM <b>{pad(m.scriptsInMotion, 3)}</b></div>
      <div>REVIEWS PENDING <b>{pad(m.reviewsPending)}</b></div>
      <div>CLIENT QUEUE <b>{pad(m.clientQueue)}</b></div>
      <div>TRANSFER PATH <b>{recent > 2 ? 'BUSY' : 'STABLE'}</b></div>
      <div>LAST SYNC <b>{fmtAgo(Date.now() - sync.at)}</b></div>
      <hr />
      <div className="geo">LAT <b>{geo ? geo.lat.toFixed(4) : '——.————'}</b></div>
      <div className="geo">LON <b>{geo ? geo.lon.toFixed(4) : '——.————'}</b></div>
    </aside>
  );
}

// ── the signal feed ──────────────────────────────────────────────────────

export function Feed({ world, expanded, operatorTz }: { world: ControlWorld; expanded: boolean; operatorTz: string }) {
  const [held, setHeld] = useState(false);
  const [shown, setShown] = useState(0);
  const frozen = useRef<ControlWorld['activity'] | null>(null);
  const all = (held && frozen.current) || world.activity;
  if (!held) frozen.current = world.activity;
  // on arrival the feed streams in, one transmission at a time
  useEffect(() => {
    if (shown >= all.length) return;
    const t = setTimeout(() => setShown((n) => n + 1), shown === 0 ? 900 : 260);
    return () => clearTimeout(t);
  }, [shown, all.length]);
  const limit = expanded ? 14 : 6;
  const items = all.slice(0, Math.min(limit, shown));
  return (
    <aside className={`cc-feed${held ? ' held' : ''}`} onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)} aria-label="Signal feed">
      <div className="head"><span>SIGNALS</span><b>{held ? 'HELD' : 'LIVE'}</b></div>
      <ol>
        {items.map((a, i) => (
          <li key={a.id} style={{ ['--age' as string]: i }}>
            <time dateTime={a.timestamp}>{localClock(operatorTz, new Date(a.timestamp)).short}</time>
            <span><b>{a.actor}</b> {a.action}{a.subject && <span className="s">{a.subject}</span>}</span>
          </li>
        ))}
      </ol>
      {!all.length && <div className="head"><span>NO TRANSMISSIONS YET</span></div>}
      <span className="cc-sr">{items[0] ? `Latest: ${items[0].actor} ${items[0].action} ${items[0].subject}` : ''}</span>
    </aside>
  );
}

// ── labels in space ──────────────────────────────────────────────────────

export function NodeLabels({ world, now, hover, focus, mode, onSelect }: { world: ControlWorld; now: Date; hover: Target | null; focus: Focus; mode: Mode; onSelect: (t: Target) => void }) {
  return (
    <>
      {world.writers.map((w) => {
        const p = presenceOf(w, now);
        const off = p.phase === 'off';
        const focused = focus?.kind === 'writer' && focus.id === w.id;
        const dimmed = !!focus && !focused;
        if (focused && (mode === 'world' || mode === 'signals' || mode === 'system' || mode === 'timezones' || mode === 'deadlines' || mode === 'missions')) return <Anchor key={w.id} k={`w:${w.id}`}><span /></Anchor>;
        return (
          <Anchor key={w.id} k={`w:${w.id}`}>
            <button className={`node-label hit${hover?.kind === 'writer' && hover.id === w.id ? ' hover' : ''}${off ? ' off' : ''}${dimmed ? ' dimmed' : ''}`} onClick={() => onSelect({ kind: 'writer', id: w.id })} aria-label={`${w.name}, ${w.city}, ${p.clock.short} local`}>
              <b>{w.callsign}</b>
              <span>{w.cityCode}{mode === 'timezones' ? <span className="clock"> {p.clock.short}</span> : null}</span>
            </button>
          </Anchor>
        );
      })}
    </>
  );
}

export function AnomalyMarks({ anomalies, mode, filter, focus, onSelect }: { anomalies: Anomaly[]; mode: Mode; filter: Filter; focus: Focus; onSelect: (a: Anomaly) => void }) {
  const show = mode === 'world' || mode === 'signals' || mode === 'system' || filter === 'pressure';
  if (!show) return null;
  // one mark per place: the most severe
  const seen = new Set<string>();
  const marks = anomalies.filter((a) => { const k = a.writerId ?? a.id; if (seen.has(k)) return false; seen.add(k); return true; });
  return (
    <>
      {marks.map((a) => {
        const more = a.writerId ? anomalies.filter((x) => x.writerId === a.writerId).length - 1 : 0;
        if (focus?.kind === 'anomaly' && focus.id === a.id) return null;
        return (
          <Anchor key={a.id} k={`a:${a.id}`}>
            <button className={`anomaly-mark hit${a.writerId ? '' : ' gap'}`} onClick={() => onSelect(a)} aria-label={`${a.title}: ${a.lines.map((l) => `${l.value} ${l.label}`).join(', ')}`}>
              <i aria-hidden />{a.title}{more > 0 ? ` +${more}` : ''}
            </button>
          </Anchor>
        );
      })}
    </>
  );
}

export function ObjectLabels({ world, now, mode, focus, hover, onSelect }: { world: ControlWorld; now: Date; mode: Mode; focus: Focus; hover: Target | null; onSelect: (t: Target) => void }) {
  if (!['missions', 'deadlines', 'constellation', 'galaxy', 'archive'].includes(mode)) return null;
  const projects = world.projects.filter((p) => (mode === 'archive' ? p.archived : !p.archived));
  const deadlineTop = mode === 'deadlines'
    ? new Set(projects.filter((p) => p.deadline).sort((a, b) => a.deadline!.localeCompare(b.deadline!)).slice(0, 5).map((p) => p.id))
    : null;
  return (
    <>
      {projects.map((p) => {
        if (deadlineTop && !deadlineTop.has(p.id) && !(focus?.kind === 'project' && focus.id === p.id)) return null;
        if (mode === 'missions' && focus?.kind === 'project' && focus.id === p.id) return null;
        const left = p.deadline ? new Date(p.deadline).getTime() - now.getTime() : null;
        const hot = hover?.kind === 'project' && hover.id === p.id;
        const pct = p.progress.total ? p.progress.done / p.progress.total : 0;
        return (
          <Anchor key={p.id} k={`p:${p.id}`}>
            <button className={`obj-label hit${hot ? ' hot' : ''}${mode === 'constellation' ? ' quiet' : ''}`} onClick={() => onSelect({ kind: 'project', id: p.id })}>
              {mode === 'constellation' ? <b>{p.title.toUpperCase()}</b> : <b>{p.client.toUpperCase()}</b>}
              {mode !== 'constellation' && mode !== 'galaxy' && <span className="t">{p.title.toUpperCase()}</span>}
              {mode === 'archive' && p.completedAt && <span>{p.progress.total} SCRIPTS · {Math.floor((now.getTime() - new Date(p.completedAt).getTime()) / 86_400_000)}D AGO</span>}
              {mode === 'galaxy' && <span>{p.title.toUpperCase()} · {p.progress.total}</span>}
              {(mode === 'missions' || mode === 'deadlines') && left != null && <span>{left < 0 ? <em>OVERDUE {fmtCountdown(-left)}</em> : left < 86_400_000 ? <em>{fmtCountdown(left)}</em> : fmtCountdown(left)} · {p.progress.done}/{p.progress.total}</span>}
              {mode === 'missions' && <span className="bar"><i style={{ width: `${pct * 100}%` }} /></span>}
            </button>
          </Anchor>
        );
      })}
      {mode === 'constellation' && world.clients.filter((c) => world.projects.some((p) => p.clientId === c.id && !p.archived)).map((c) => (
        <Anchor key={c.id} k={`c:${c.id}`}>
          <button className="obj-label client hit" onClick={() => onSelect({ kind: 'client', id: c.id })}>
            <b>{c.name.toUpperCase()}</b>
          </button>
        </Anchor>
      ))}
    </>
  );
}

export function BandLabels({ mode }: { mode: Mode }) {
  if (mode !== 'deadlines') return null;
  return (
    <>
      {['24H', '48H', '7D', '30D'].map((b) => (
        <Anchor key={b} k={`band:${b}`}><div className="band-label"><b>{b}</b>ORBIT</div></Anchor>
      ))}
    </>
  );
}

export function DialLabels({ mode, now }: { mode: Mode; now: Date }) {
  if (mode !== 'timezones') return null;
  const cur = now.getUTCHours();
  return (
    <>
      {Array.from({ length: 24 }, (_, h) => (
        <Anchor key={h} k={`dial:${h}`}>
          <div className={`dial-label${h % 6 === 0 ? ' major' : ''}${h === cur ? ' now' : ''}`}>{pad(h)}</div>
        </Anchor>
      ))}
    </>
  );
}

export function PhaseLabels({ world, focus, mode }: { world: ControlWorld; focus: Focus; mode: Mode }) {
  if (mode !== 'missions' || focus?.kind !== 'project') return null;
  const p = world.projects.find((x) => x.id === focus.id);
  if (!p) return null;
  const scripts = world.scripts.filter((s) => s.projectId === p.id);
  const cur = phaseOf(p.stage);
  return (
    <>
      {PHASES.map((ph, i) => (
        <Anchor key={ph} k={`phase:${i}`}>
          <div className={`phase-label${i === cur ? ' on' : ''}`}>
            {i > 0 ? '→ ' : ''}{ph}
            <small>{pad(scripts.filter((s) => phaseOf(s.state) === i).length)}</small>
          </div>
        </Anchor>
      ))}
    </>
  );
}

export function ScriptLabels({ world, focus, mode }: { world: ControlWorld; focus: Focus; mode: Mode }) {
  if (!(mode === 'galaxy' || mode === 'archive') || focus?.kind !== 'project') return null;
  const scripts = world.scripts.filter((s) => s.projectId === focus.id).slice(0, 24);
  return (
    <>
      {scripts.map((s) => (
        <Anchor key={s.id} k={`s:${s.id}`}>
          <div className="script-label"><span>{s.code}</span>{s.title.toUpperCase()}</div>
        </Anchor>
      ))}
    </>
  );
}

export interface Transmission { id: string; h: CcHandoff; phase: 'transit' | 'arrived'; replay: boolean }

export function Transmissions({ items, world, now }: { items: Transmission[]; world: ControlWorld; now: Date }) {
  const city = (id: string) => world.writers.find((w) => w.id === id)?.city.toUpperCase() ?? '—';
  return (
    <>
      {items.map((t) => t.phase === 'transit'
        ? (
          <Anchor key={`t-${t.id}`} k={`packet:${t.h.id}`}>
            <div className="packet-label">{t.h.label} · {city(t.h.originNode)} → {city(t.h.destinationNode)}</div>
          </Anchor>
        )
        : (
          <Anchor key={`a-${t.id}`} k={`w:${t.h.destinationNode}`}>
            <div className="arrival" role="status">
              <b>TRANSFER RECEIVED</b>
              <span>{city(t.h.originNode)} → {city(t.h.destinationNode)}</span>
              <span>{t.h.label}</span>
              <small>{t.h.state}{t.replay ? ` · ${fmtAgo(now.getTime() - new Date(t.h.timestamp).getTime())}` : ''}</small>
            </div>
          </Anchor>
        ))}
    </>
  );
}

export function HoverTip({ world, now, hover, focus }: { world: ControlWorld; now: Date; hover: Target | null; focus: Focus }) {
  if (!hover || (focus && focus.kind === hover.kind && focus.id === hover.id)) return null;
  if (hover.kind === 'writer') {
    const w = world.writers.find((x) => x.id === hover.id);
    if (!w) return null;
    const p = presenceOf(w, now);
    return (
      <Anchor k={`w:${w.id}`}>
        <div className="cc-tip">
          <b>{w.name.toUpperCase()}</b>
          <span>{w.city.toUpperCase()} · {p.clock.time} · {p.phase === 'off' ? 'OFFLINE' : p.phase === 'waking' ? 'WAKING' : w.status.replace('_', ' ').toUpperCase()}</span>
          {w.currentAssignment && <span>{w.currentAssignment.toUpperCase()}</span>}
        </div>
      </Anchor>
    );
  }
  if (hover.kind === 'project') {
    const p = world.projects.find((x) => x.id === hover.id);
    if (!p) return null;
    return (
      <Anchor k={`p:${p.id}`}>
        <div className="cc-tip"><span>{STATE_LABEL[p.stage]} · {p.progress.done}/{p.progress.total} COMPLETE</span></div>
      </Anchor>
    );
  }
  return null;
}
