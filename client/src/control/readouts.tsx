// What appears when something is selected, anchored to it in space where it
// has a place (a person, a disturbance), or taking over the statement where
// it doesn't (an operation, a client, a city). Plus the timezone and system
// layers, which have their own instruments.

import { useEffect, useState } from 'react';
import {
  coverageOf, fmtAgo, fmtCountdown, fmtHoursMinutes, localClock, PHASES, phaseOf, presenceOf, ROLE_LABEL, STATE_LABEL,
  STATUS_LABEL, type Anomaly, type ControlWorld, type ScriptState,
} from '../../../shared/control';
import { Anchor } from './overlay';
import type { EngineStats } from './engine/Engine';
import type { SyncInfo } from './Experience';

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

const STATUS_VAR: Record<string, string> = {
  active: 'var(--ice)', deep_work: '#e8efff', reviewing: 'var(--violet)', away: 'var(--dim)', offline: 'var(--faint)', late: 'var(--magenta)', waking: 'var(--cyan)',
};
const STATE_VAR: Partial<Record<ScriptState, string>> = {
  writing: 'var(--ice)', internal_review: 'var(--violet)', revision: 'var(--magenta)', client_review: 'var(--cyan)', approved: '#e8efff', research: '#8f8cff', concept: '#9a98ff', delivered: '#ffe2b8',
};

/** Coordinates that resolve out of noise, digit by digit. */
function Resolve({ text, delay = 350 }: { text: string; delay?: number }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    setShown(0);
    let n = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => { n++; setShown(n); if (n < text.length) timer = setTimeout(tick, 22); };
    timer = setTimeout(tick, delay);
    return () => clearTimeout(timer);
  }, [text, delay]);
  const glyphs = '0123456789.-';
  return <>{text.split('').map((c, i) => (i < shown || c === ' ' ? c : glyphs[(i * 7 + shown) % glyphs.length]))}</>;
}

/** A name set letter by letter; words stay whole so a long name wraps between them. */
function Name({ text }: { text: string }) {
  let n = 0;
  return (
    <div className="name" aria-label={text}>
      {text.split(' ').map((word, w) => (
        <span className="w" key={w} aria-hidden>
          {word.split('').map((c) => <span key={n} style={{ animationDelay: `${120 + n++ * 38}ms` }}>{c}</span>)}
        </span>
      ))}
    </div>
  );
}

export function WriterReadout({ world, id, now, anomalies }: { world: ControlWorld; id: string; now: Date; anomalies: Anomaly[] }) {
  const w = world.writers.find((x) => x.id === id);
  if (!w) return null;
  const p = presenceOf(w, now);
  const mine = world.scripts.filter((s) => s.writerId === w.id && s.state !== 'delivered' && !world.projects.find((x) => x.id === s.projectId)?.archived);
  const left = w.deadline ? new Date(w.deadline).getTime() - now.getTime() : null;
  const project = w.projectId ? world.projects.find((x) => x.id === w.projectId) : null;
  const statusKey = p.phase === 'late' ? 'late' : p.phase === 'waking' ? 'waking' : p.status;
  const statusText = p.phase === 'off' ? 'OFFLINE' : p.phase === 'waking' ? 'COMING ONLINE' : p.phase === 'late' ? `${STATUS_LABEL[w.status]} · AFTER HOURS` : STATUS_LABEL[w.status];
  const pressure = anomalies.filter((a) => a.writerId === w.id);
  return (
    <Anchor k={`w:${w.id}`}>
      <div className="readout" style={{ ['--wire' as string]: '110px' }} key={w.id}>
        <i className="wire" />
        <div className="body">
          <Name text={w.callsign} />
          <div className="where"><span>{w.city.toUpperCase()} · {w.country.toUpperCase()}</span><span className="clock">{p.clock.time}</span></div>
          <div className="coords"><Resolve text={`LAT ${w.lat.toFixed(4)}   LON ${w.lon.toFixed(4)}   ${p.clock.offsetLabel}`} /></div>
          <div className="status" style={{ ['--c' as string]: STATUS_VAR[statusKey] }}><i />{statusText}<span>{ROLE_LABEL[w.role]}</span></div>
          {w.currentAssignment ? (
            <div className="block">
              <span className="k">CURRENT SIGNAL</span>
              <span className="v">{project?.client.toUpperCase()}<br />{w.currentAssignment.toUpperCase()}</span>
              {w.progress && (
                <>
                  <span className="v dim">{pad(w.progress.done)} / {pad(w.progress.total)} COMPLETE</span>
                  <span className="meter"><i style={{ width: `${(w.progress.done / Math.max(1, w.progress.total)) * 100}%` }} /></span>
                </>
              )}
            </div>
          ) : (
            <div className="block"><span className="k">CURRENT SIGNAL</span><span className="v dim">NO ACTIVE ASSIGNMENT</span></div>
          )}
          {left != null && (
            <div className="block">
              <span className="k">NEXT DEADLINE</span>
              <span className="v big" style={left < 0 ? { color: 'var(--amber)' } : undefined}>{left < 0 ? `−${fmtCountdown(-left)}` : fmtCountdown(left)}</span>
            </div>
          )}
          <div className="block">
            <span className="k">ORBITING · {pad(mine.length)} OBJECTS</span>
            <span className="chips">{mine.slice(0, 6).map((s) => <span key={s.id} style={{ ['--c' as string]: STATE_VAR[s.state] }}><i />{s.code} {STATE_LABEL[s.state]}</span>)}</span>
            <div className="row" style={{ marginTop: 6 }}>
              <span className="v dim">OUTPUT {pad(w.weeklyOutput)} / WK</span>
              <span className="v dim" style={w.workload > 1.2 ? { color: 'var(--amber)' } : undefined}>LOAD {Math.round(w.workload * 100)}%</span>
              {w.lastActivity && <span className="v dim">SEEN {fmtAgo(now.getTime() - new Date(w.lastActivity).getTime())}</span>}
            </div>
          </div>
          {pressure.length > 0 && (
            <div className="block" style={{ borderColor: 'rgba(255,176,112,0.35)' }}>
              {pressure.map((a) => <span key={a.id} className="v dim" style={{ color: 'var(--amber)' }}>{a.title} · {a.lines.map((l) => `${l.value} ${l.label}`).join(' · ')}</span>)}
            </div>
          )}
        </div>
      </div>
    </Anchor>
  );
}

/** On a phone: the same readout, set as typography under the planet instead of beside the city. */
export function WriterReadoutMobile({ world, id, now }: { world: ControlWorld; id: string; now: Date }) {
  const w = world.writers.find((x) => x.id === id);
  if (!w) return null;
  const p = presenceOf(w, now);
  const left = w.deadline ? new Date(w.deadline).getTime() - now.getTime() : null;
  const project = w.projectId ? world.projects.find((x) => x.id === w.projectId) : null;
  return (
    <section className="readout-mobile" key={w.id}>
      <Name text={w.callsign} />
      <div className="row">
        <div><b>{p.clock.time}</b><span>{w.city.toUpperCase()}</span></div>
        <div><b>{p.phase === 'off' ? 'OFFLINE' : STATUS_LABEL[w.status]}</b><span>{ROLE_LABEL[w.role]}</span></div>
      </div>
      {w.currentAssignment && (
        <div className="row">
          <div><b>{project?.client.toUpperCase()}</b><span>{w.currentAssignment.toUpperCase()}{w.progress ? ` · ${w.progress.done}/${w.progress.total}` : ''}</span></div>
          {left != null && <div className={left < 86_400_000 ? 'warn' : ''}><b>{left < 0 ? `−${fmtCountdown(-left)}` : fmtCountdown(left)}</b><span>NEXT DEADLINE</span></div>}
        </div>
      )}
    </section>
  );
}

export function AnomalyReadout({ world, anomaly }: { world: ControlWorld; anomaly: Anomaly }) {
  const w = anomaly.writerId ? world.writers.find((x) => x.id === anomaly.writerId) : null;
  const sources = anomaly.sources.map((id) => world.writers.find((x) => x.id === id)?.city.toUpperCase()).filter(Boolean);
  return (
    <Anchor k={`a:${anomaly.id}`}>
      <div className="readout warn compact" style={{ ['--wire' as string]: '90px' }} key={anomaly.id}>
        <i className="wire" />
        <div className="body">
          <Name text={anomaly.title} />
          {w && <div className="where"><span>{w.callsign} · {w.city.toUpperCase()}</span></div>}
          {anomaly.lines.map((l, i) => (
            <div className="block" key={i}>
              <span className="k">{l.label}</span>
              <span className={`v${i === 0 || /[0-9]H|%/.test(l.value) ? ' big' : ''}`}>{l.value}</span>
            </div>
          ))}
          {sources.length > 0 && <div className="block"><span className="k">CONVERGING FROM</span><span className="v dim">{sources.join(' · ')}</span></div>}
        </div>
      </div>
    </Anchor>
  );
}

function Stat({ v, l, warn }: { v: string | number; l: string; warn?: boolean }) {
  return <div className={warn ? 'warn' : ''}><b>{v}</b><span>{l}</span></div>;
}

export function ProjectStatement({ world, id, now }: { world: ControlWorld; id: string; now: Date }) {
  const p = world.projects.find((x) => x.id === id);
  if (!p) return null;
  const scripts = world.scripts.filter((s) => s.projectId === p.id);
  const count = (st: ScriptState[]) => scripts.filter((s) => st.includes(s.state)).length;
  const left = p.deadline ? new Date(p.deadline).getTime() - now.getTime() : null;
  const people = p.writers.map((wid) => world.writers.find((w) => w.id === wid)).filter(Boolean);
  return (
    <section className="cc-panel stats" key={p.id}>
      <h1 className="title cc-serif"><span className="l"><span>{p.client}</span></span><span className="l"><span><em style={{ fontStyle: 'italic', textTransform: 'none', color: 'var(--ink-2)' }}>{p.title}</em></span></span></h1>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(5, auto)' }}>
        <Stat v={pad(scripts.length)} l="SCRIPTS" />
        <Stat v={pad(p.progress.done)} l="COMPLETE" />
        <Stat v={pad(count(['writing', 'research', 'concept']))} l="WRITING" />
        <Stat v={pad(count(['internal_review', 'client_review']))} l="REVIEW" />
        <Stat v={pad(count(['revision']))} l="REVISION" warn={count(['revision']) > 2} />
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(3, auto)' }}>
        {left != null && <Stat v={left < 0 ? `−${fmtCountdown(-left)}` : fmtCountdown(left)} l={p.archived ? 'DELIVERED' : 'NEXT DEADLINE'} warn={left < 86_400_000 && !p.archived} />}
        <Stat v={PHASES[phaseOf(p.stage)]} l="CURRENT PHASE" />
        <Stat v={p.priority.toUpperCase()} l="PRIORITY" warn={p.priority === 'urgent'} />
      </div>
      {people.length > 0 && <div className="cc-metrics" style={{ marginTop: 0 }}>{people.map((w) => <div key={w!.id}><b>{w!.callsign}</b><span>{w!.cityCode}</span></div>)}</div>}
      {p.blocked && <div className="cc-metrics" style={{ marginTop: 0 }}><div className="warn"><b>BLOCKED</b><span>{p.blocked.toUpperCase()}</span></div></div>}
    </section>
  );
}

export function ClientStatement({ world, id, now }: { world: ControlWorld; id: string; now: Date }) {
  const c = world.clients.find((x) => x.id === id);
  if (!c) return null;
  const ps = world.projects.filter((p) => p.clientId === id);
  const live = ps.filter((p) => !p.archived);
  const people = new Set(live.flatMap((p) => p.writers));
  const next = live.filter((p) => p.deadline && new Date(p.deadline) > now).sort((a, b) => a.deadline!.localeCompare(b.deadline!))[0];
  return (
    <section className="cc-panel stats" key={c.id}>
      <h1 className="title cc-serif"><span className="l"><span>{c.name}</span></span></h1>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, auto)' }}>
        <Stat v={pad(live.length)} l="ACTIVE OPERATIONS" />
        <Stat v={pad(people.size)} l="PEOPLE CONNECTED" />
        <Stat v={pad(world.scripts.filter((s) => live.some((p) => p.id === s.projectId)).length)} l="SCRIPTS" />
        {next && <Stat v={fmtCountdown(new Date(next.deadline!).getTime() - now.getTime())} l="NEXT DEADLINE" />}
      </div>
      <div className="cc-metrics" style={{ marginTop: 0 }}>{live.map((p) => <div key={p.id}><b>{p.title.toUpperCase()}</b><span>{p.progress.done}/{p.progress.total} · {PHASES[phaseOf(p.stage)]}</span></div>)}</div>
    </section>
  );
}

export function CityStatement({ world, lat, lon, now }: { world: ControlWorld; lat: number; lon: number; now: Date }) {
  const here = world.writers.filter((w) => Math.abs(w.lat - lat) < 1 && Math.abs(w.lon - lon) < 1);
  const tz = here[0]?.timezone;
  const name = here[0]?.city;
  return (
    <section className="cc-panel stats">
      <h1 className="title cc-serif"><span className="l"><span>{name ?? `${lat.toFixed(1)}°, ${lon.toFixed(1)}°`}</span></span></h1>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(3, auto)' }}>
        {tz && <Stat v={localClock(tz, now).time} l="LOCAL TIME" />}
        <Stat v={pad(here.length)} l={here.length === 1 ? 'NODE' : 'NODES'} />
        <Stat v={`${lat.toFixed(2)} ${lon.toFixed(2)}`} l="COORDINATES" />
      </div>
      {here.length > 0 && <div className="cc-metrics" style={{ marginTop: 0 }}>{here.map((w) => { const p = presenceOf(w, now); return <div key={w.id}><b>{w.callsign}</b><span>{p.phase === 'off' ? 'OFFLINE' : STATUS_LABEL[w.status]}</span></div>; })}</div>}
      {!here.length && <div className="empty" style={{ fontSize: 10, letterSpacing: '0.26em', color: 'var(--dim)' }}>NO NODES IN THIS CITY</div>}
    </section>
  );
}

export function TimezonePanel({ world, now, offset, playing, onScrub, onPlay, onNow, onFocus }: {
  world: ControlWorld; now: Date; offset: number; playing: boolean; onScrub: (ms: number) => void; onPlay: () => void; onNow: () => void; onFocus: (id: string) => void;
}) {
  const cov = coverageOf(world.writers, now);
  const name = (id?: string) => world.writers.find((w) => w.id === id);
  const hours = offset / 3_600_000;
  const writers = world.writers.slice().sort((a, b) => {
    const wa = cov.windows.find((x) => x.writerId === a.id)?.start ?? 99, wb = cov.windows.find((x) => x.writerId === b.id)?.start ?? 99;
    return wa - wb;
  });
  return (
    <>
      <section className="cc-panel stats tz">
        <h1 className="title cc-serif"><span className="l"><span>Follow</span></span><span className="l"><span><em style={{ fontStyle: 'italic', textTransform: 'none', color: 'var(--ink-2)' }}>the sun</em></span></span></h1>
        <div className="grid">
          <Stat v={fmtHoursMinutes(cov.coveredMinutes)} l="GLOBAL COVERAGE" warn={cov.coveredMinutes < 20 * 60} />
          <Stat v={`${pad(cov.overlapNow)}`} l={`CURRENT OVERLAP · ${cov.overlapNow === 1 ? 'WRITER' : 'WRITERS'}`} />
          {cov.nextHandoff ? <Stat v={fmtCountdown(cov.nextHandoff.in)} l={`NEXT HANDOFF · ${name(cov.nextHandoff.writerId)?.city.toUpperCase()} SIGNS OFF`} /> : <Stat v="—" l="NEXT HANDOFF" />}
          {cov.nextOnline ? <Stat v={fmtCountdown(cov.nextOnline.in)} l={`NEXT NODE ONLINE · ${name(cov.nextOnline.writerId)?.city.toUpperCase()}`} /> : <Stat v="—" l="NEXT NODE ONLINE" />}
          {cov.gaps.length > 0 && <div className="warn extra"><b>{cov.gaps.map((g) => `${pad(Math.floor(g.start) % 24)}–${pad(Math.floor(g.end) % 24)}`).join(' ')}</b><span>UTC GAPS</span></div>}
        </div>
      </section>
      <div className="cc-scrub">
        <div className="row">
          <button onClick={onPlay} className={playing ? 'on' : ''}>{playing ? 'PAUSE' : 'FOLLOW THE SUN ▸'}</button>
          <span>{Math.abs(hours) < 0.02 ? 'NOW' : `${hours > 0 ? '+' : '−'}${fmtCountdown(Math.abs(offset))}`}</span>
          <button onClick={onNow} disabled={!offset}>RETURN TO NOW</button>
        </div>
        <input type="range" min={-12} max={12} step={0.25} value={Math.max(-12, Math.min(12, hours))} aria-label="Scrub time, hours from now"
          onChange={(e) => onScrub(Number(e.target.value) * 3_600_000)} />
        <div className="ticks" aria-hidden><span>−12H</span><span>−6H</span><span>NOW</span><span>+6H</span><span>+12H</span></div>
      </div>
      <div className="cc-lanes" aria-label="Shifts">
        {writers.map((w) => {
          const p = presenceOf(w, now);
          const win = cov.windows.find((x) => x.writerId === w.id);
          const key = p.phase === 'late' ? 'late' : p.phase === 'waking' ? 'waking' : p.status;
          return (
            <button key={w.id} className={p.phase === 'off' ? 'off' : ''} style={{ ['--c' as string]: STATUS_VAR[key] }} onClick={() => onFocus(w.id)}>
              <i /><b>{w.callsign}</b><span>{w.cityCode}</span><time>{p.clock.short}</time>
              <span>{win ? `${pad(Math.floor(win.start))}–${pad(Math.floor(win.end) % 24)} UTC` : '—'}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

export function SystemPanel({ world, stats, sync, anomalies, onLock, onPeople }: {
  world: ControlWorld; stats: EngineStats; sync: SyncInfo; anomalies: Anomaly[]; onLock: () => void; onPeople: () => void;
}) {
  // no timer of its own: Experience's clock re-renders this once a second, and rests while the tab is hidden
  const since = Math.floor((Date.now() - sync.at) / 1000);
  const zones = new Set(world.writers.map((w) => w.timezone)).size;
  const rows: [string, string, string?][] = [
    ['NETWORK', sync.lastOk ? 'ONLINE' : 'DEGRADED', sync.lastOk ? 'ok' : 'warn'],
    ['WRITER NODES', `${pad(world.writers.length)} / ${pad(world.writers.length + world.source.unplaced)}`],
    ['TIMEZONE SYNC', `STABLE · ${pad(zones)} ZONES`, 'ok'],
    ['LAST DATA REFRESH', `00:00:${pad(Math.min(59, since))}`],
    ['ACTIVE PROJECTS', pad(world.projects.filter((p) => !p.archived).length)],
    ['HANDOFF CHANNELS', pad(world.links.filter((l) => l.active).length)],
    ['PRESSURE POINTS', pad(anomalies.length), anomalies.length ? 'warn' : undefined],
    ['DATA SOURCE', world.source.label, world.source.kind === 'simulated' ? 'warn' : 'ok'],
    ['RENDER', `${stats.tier.toUpperCase()} · DPR ${stats.dpr.toFixed(1)} · ${stats.fps} FPS`],
    ['PARTICLES', stats.particles.toLocaleString('en-US')],
    ['SYNCS RECEIVED', pad(sync.packets, 5)],
    ['SYSTEM VERSION', world.version],
  ];
  return (
    <section className="cc-system" aria-label="Diagnostics">
      {rows.map(([k, v, tone]) => <div key={k}><span>{k}</span><b className={tone}>{v}</b></div>)}
      <p className="note">
        {world.source.kind === 'simulated'
          ? <>THIS IS THE SIMULATED NETWORK: SAMPLE PEOPLE AND CLIENTS, SET BY CONTROL_CENTER_DATA ON THE SERVER. HANDOFFS ARE REPLAYED, NOT OBSERVED.</>
          : <>LIVE WORKSPACE: YOUR TEAM, EDITORS, BATCHES, SCRIPTS AND REVIEWS FROM THE PLATFORM, REFRESHED EVERY 20 SECONDS.{world.source.unplaced ? <> {world.source.unplaced} TEAM MEMBER{world.source.unplaced === 1 ? ' HAS' : 'S HAVE'} NO CITY YET. <button onClick={onPeople}>PLACE THEM</button></> : ''}</>}
        {' '}<button onClick={onLock}>LOCK CLEARANCE</button>
      </p>
    </section>
  );
}
