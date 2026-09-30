// The Control Center once cleared: the world view (WebGL, or 2D if that's
// all the device has) under the typography, and everything that moves it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CcHandoff, ControlWorld } from '../../../shared/control';
import { Engine, type Filter, type Focus, type Mode, type Target } from './engine/Engine';
import { FlatView } from './engine/flat';
import type { WorldView } from './engine/view';
import {
  AnomalyMarks, BandLabels, DialLabels, Feed, HoverTip, Micro, MODES, Nav, NodeLabels, ObjectLabels, PhaseLabels, ScriptLabels, Statement, Top,
  Transmissions, ViewCtx, type Transmission,
} from './overlay';
import { AnomalyReadout, CityStatement, ClientStatement, ProjectStatement, SystemPanel, TimezonePanel, WriterReadout, WriterReadoutMobile } from './readouts';
import { Palette, type Command } from './Palette';
import { sound } from './sound';

export interface SyncInfo { at: number; skew: number; ok: number; total: number; packets: number }

const GEO_MODES: Mode[] = ['world', 'missions', 'deadlines', 'timezones', 'signals', 'system'];
const SPACE_MODES: Mode[] = ['constellation', 'galaxy', 'archive'];
const operatorTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export function Experience({ world, live, returning, sync, onReady, onExit, onLock }: {
  world: ControlWorld; live: boolean; returning: boolean; sync: SyncInfo;
  onReady: () => void; onExit: () => void; onLock: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const counter = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<WorldView | null>(null);
  const [mode, setModeState] = useState<Mode>('world');
  const [focus, setFocus] = useState<Focus>(null);
  const [filter, setFilter] = useState<Filter>(null);
  const [hover, setHover] = useState<Target | null>(null);
  const [palette, setPalette] = useState(false);
  const [geo, setGeo] = useState<{ lat: number; lon: number } | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [offset, setOffset] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [soundOn, setSoundOn] = useState(sound.enabled);
  const [transmissions, setTransmissions] = useState<Transmission[]>([]);
  const reduced = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  const narrow = useMedia('(max-width: 760px)');
  const handlers = useRef({ select: (_t: Target | null) => {}, arrive: (_h: CcHandoff) => {}, overscroll: (_d: 'in' | 'out') => {} });

  // ── the view: WebGL, or the flat 2D globe if the device can't ────────────
  const [flat, setFlat] = useState(false);
  useEffect(() => {
    const el = canvas.current!;
    const common = {
      reducedMotion: reduced,
      onSelect: (t: Target | null) => handlers.current.select(t),
      onHover: (t: Target | null) => { setHover(t); if (t) sound.hover(); },
      onArrive: (h: CcHandoff) => handlers.current.arrive(h),
      onReveal: (p: number) => {
        const out = counter.current;
        if (out) out.innerHTML = revealText(p, v?.stats.land ?? 0, world.writers.length);
        if (p > 0.82) setRevealed(true);
      },
    };
    let v: WorldView | null = null;
    try {
      v = flat
        ? new FlatView(el, common)
        : new Engine(el, { ...common, onPointerGeo: throttle((g: { lat: number; lon: number } | null) => setGeo(g), 80), onOverscroll: (d) => handlers.current.overscroll(d) });
    } catch {
      if (!flat) setFlat(true);
      return;
    }
    v.setWorld(world);
    setView(v);
    onReady();
    return () => { v?.dispose(); setView(null); };
  }, [flat]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { view?.setWorld(world); }, [view, world]);
  useEffect(() => { if (live && view) view.reveal(returning); }, [live, view, returning]);
  useEffect(() => { view?.setMode(mode); }, [view, mode]);
  useEffect(() => { view?.setFocus(focus); }, [view, focus]);
  useEffect(() => { view?.setFilter(filter); }, [view, filter]);
  useEffect(() => { view?.setTimeOffset(offset); }, [view, offset]);

  // the clock: once a second, or smoothly while the sun is being followed
  useEffect(() => {
    const t = setInterval(() => setNow(new Date(Date.now() + offset)), playing ? 100 : 1000);
    setNow(new Date(Date.now() + offset));
    return () => clearInterval(t);
  }, [offset, playing]);
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const dt = t - last;
      last = t;
      setOffset((o) => { const n = o + dt * 3600; return n > 12 * 3_600_000 ? -12 * 3_600_000 : n; });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const anomalies = useMemo(() => view?.currentAnomalies ?? [], [view, now]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── moving the world ───────────────────────────────────────────────────
  const setMode = useCallback((m: Mode, keepFocus = false) => {
    setModeState((cur) => {
      if (cur !== m) sound.mode();
      return m;
    });
    if (!keepFocus) setFocus(null);
    if (m !== 'timezones') { setPlaying(false); setOffset(0); }
  }, []);

  const select = useCallback((t: Target | null) => {
    if (!t) { setFocus((f) => (f ? null : f)); return; }
    sound.select();
    if (t.kind === 'writer') setFocus({ kind: 'writer', id: t.id });
    else if (t.kind === 'project') {
      setModeState((m) => (GEO_MODES.includes(m) && m !== 'deadlines' ? 'missions' : m));
      setFocus({ kind: 'project', id: t.id });
    } else setFocus({ kind: 'client', id: t.id });
  }, []);

  const play = useCallback((h: CcHandoff, replay: boolean) => {
    if (!view?.playHandoff(h)) return;
    const id = `${h.id}-${Date.now()}`;
    setTransmissions((ts) => [...ts.filter((x) => x.phase === 'arrived' || x.h.id !== h.id), { id, h, phase: 'transit', replay }]);
  }, [view]);

  handlers.current.select = select;
  handlers.current.arrive = (h) => {
    sound.transfer();
    setTransmissions((ts) => {
      const t = [...ts].reverse().find((x) => x.h.id === h.id && x.phase === 'transit');
      if (!t) return ts;
      setTimeout(() => setTransmissions((cur) => cur.filter((x) => x.id !== t.id)), 5600);
      return ts.map((x) => (x === t ? { ...x, phase: 'arrived' } : x));
    });
  };
  handlers.current.overscroll = (d) => {
    if (d === 'in' && hover?.kind === 'writer') select(hover);
    else if (d === 'out') {
      if (focus) setFocus(null);
      else if (mode !== 'world') setMode('world');
    } else if (mode === 'missions' && focus?.kind === 'project') stepProject(1);
  };

  const liveProjects = useMemo(() => world.projects.filter((p) => !p.archived).sort((a, b) => (a.deadline ?? '9').localeCompare(b.deadline ?? '9')), [world]);
  const stepProject = (dir: number) => {
    if (!liveProjects.length) return;
    const i = focus?.kind === 'project' ? liveProjects.findIndex((p) => p.id === focus.id) : -1;
    const next = liveProjects[(i + dir + liveProjects.length) % liveProjects.length];
    setFocus({ kind: 'project', id: next.id });
    sound.select();
  };

  // handoffs: new ones play as they arrive; recent ones replay now and then so the network moves
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!view || !revealed) return;
    const firstLook = !seen.current;
    seen.current ??= new Set(world.handoffs.map((h) => h.id));
    if (!firstLook) {
      for (const h of world.handoffs) if (!seen.current.has(h.id)) { seen.current.add(h.id); play(h, false); }
    }
  }, [world, view, revealed, play]);
  useEffect(() => {
    if (!view || !revealed || reduced) return;
    const list = world.handoffs.slice().sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    if (!list.length) return;
    let i = Math.max(0, list.length - 3);
    const replay = world.source.kind === 'workspace';
    const run = () => { play(list[i % list.length], replay); i++; };
    const first = setTimeout(run, mode === 'signals' ? 600 : 2400);
    const every = setInterval(run, mode === 'signals' ? 3800 : 12500);
    return () => { clearTimeout(first); clearInterval(every); };
  }, [view, revealed, reduced, world.handoffs, world.source.kind, mode, play]);

  const run = (c: Command) => {
    const geoMode = GEO_MODES.includes(mode);
    switch (c.kind) {
      case 'writer':
        if (!geoMode && !SPACE_MODES.includes(mode)) setMode('world', true);
        if (mode === 'missions' || mode === 'deadlines') setMode('world', true);
        setFocus({ kind: 'writer', id: c.id });
        break;
      case 'project':
        if (!SPACE_MODES.includes(mode) && mode !== 'deadlines') setMode('missions', true);
        setFocus({ kind: 'project', id: c.id });
        break;
      case 'client':
        if (mode !== 'constellation' && mode !== 'missions') setMode('missions', true);
        setFocus({ kind: 'client', id: c.id });
        break;
      case 'city':
        if (!geoMode || mode === 'missions' || mode === 'deadlines') setMode('world', true);
        setFocus({ kind: 'city', id: `${c.lat},${c.lon}` });
        break;
      case 'script': {
        const s = world.scripts.find((x) => x.id === c.id);
        if (s?.writerId) { if (!geoMode || mode === 'missions' || mode === 'deadlines') setMode('world', true); setFocus({ kind: 'writer', id: s.writerId }); }
        else if (s) { setMode('missions', true); setFocus({ kind: 'project', id: s.projectId }); }
        break;
      }
      case 'mode':
        setMode(c.mode);
        if (c.filter !== undefined) setFilter(c.filter);
        if (c.play) setTimeout(() => setPlaying(true), 400);
        break;
      case 'filter':
        if (!['world', 'signals', 'system'].includes(mode)) setMode('world');
        setFilter((f) => (f === c.filter ? null : c.filter));
        break;
      case 'action':
        if (c.action === 'exit') onExit();
        else if (c.action === 'lock') onLock();
        else if (c.action === 'sound') toggleSound();
        else if (c.action === 'now') { setPlaying(false); setOffset(0); }
    }
  };

  const toggleSound = () => { sound.setEnabled(!sound.enabled); setSoundOn(sound.enabled); };

  // ── keyboard ───────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); return; }
      if (palette || typing) return;
      if (e.key === '/') { e.preventDefault(); setPalette(true); return; }
      if (e.key === 'Escape') {
        if (focus) setFocus(null);
        else if (filter) setFilter(null);
        else if (mode !== 'world') setMode('world');
        return;
      }
      const n = Number(e.key);
      if (n >= 1 && n <= MODES.length && !e.metaKey && !e.ctrlKey && !e.altKey) { setMode(MODES[n - 1].mode); return; }
      if (e.key === '+' || e.key === '=') view?.zoomBy(0.88);
      else if (e.key === '-' || e.key === '_') view?.zoomBy(1.12);
      else if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        const dir = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
        if (mode === 'missions' && focus?.kind === 'project' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) stepProject(dir);
        else if (mode === 'timezones' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { setPlaying(false); setOffset((o) => Math.max(-12, Math.min(12, o / 3_600_000 + dir)) * 3_600_000); }
        else view?.nudge(e.key === 'ArrowLeft' ? -0.12 : e.key === 'ArrowRight' ? 0.12 : 0, e.key === 'ArrowUp' ? -0.1 : e.key === 'ArrowDown' ? 0.1 : 0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ── what to show ───────────────────────────────────────────────────────
  const anomaly = focus?.kind === 'anomaly' ? anomalies.find((a) => a.id === focus.id) : null;
  const geoFocusMode = GEO_MODES.includes(mode);
  let statement: React.ReactNode = <Statement mode={mode} world={world} now={now} anomalies={anomalies} />;
  if (focus?.kind === 'project') statement = <ProjectStatement world={world} id={focus.id} now={now} />;
  else if (focus?.kind === 'client') statement = <ClientStatement world={world} id={focus.id} now={now} />;
  else if (focus?.kind === 'city') { const [lat, lon] = focus.id.split(',').map(Number); statement = <CityStatement world={world} lat={lat} lon={lon} now={now} />; }
  else if (focus?.kind === 'writer' || focus?.kind === 'anomaly') statement = null;
  if (mode === 'timezones' && !focus) statement = null;

  return (
    <ViewCtx.Provider value={view}>
      <div className="cc-stage"><canvas key={flat ? '2d' : 'gl'} ref={canvas} aria-label="The Scale Media network on a globe" /></div>
      <div className="cc-vignette" aria-hidden />
      <div className="cc-grain" aria-hidden />
      <div className="cc-dim-layer" aria-hidden />
      {view?.flat && <div className="cc-fallback-note">REDUCED RENDERER · 2D</div>}
      {live && !revealed && <div className="cc-count" ref={counter} aria-hidden />}
      {live && revealed && (
        <>
          <div className="cc-anchors" data-focus={focus ? '1' : '0'}>
            <NodeLabels world={world} now={now} hover={hover} focus={focus} mode={mode} onSelect={select} />
            <AnomalyMarks anomalies={anomalies} mode={mode} filter={filter} focus={focus} onSelect={(a) => { sound.select(); setFocus({ kind: 'anomaly', id: a.id }); }} />
            <ObjectLabels world={world} now={now} mode={mode} focus={focus} hover={hover} onSelect={select} />
            <BandLabels mode={mode} />
            <DialLabels mode={mode} now={now} />
            <PhaseLabels world={world} focus={focus} mode={mode} />
            <ScriptLabels world={world} focus={focus} mode={mode} />
            <Transmissions items={transmissions} world={world} now={now} />
            <HoverTip world={world} now={now} hover={hover} focus={focus} />
            {focus?.kind === 'writer' && geoFocusMode && !narrow && <WriterReadout world={world} id={focus.id} now={now} anomalies={anomalies} />}
            {anomaly && <AnomalyReadout world={world} anomaly={anomaly} />}
          </div>
          <Top world={world} now={now} offset={offset} soundOn={soundOn} onSound={toggleSound} onPalette={() => setPalette(true)} onExit={onExit} />
          <Nav mode={mode} onMode={(m) => setMode(m)} />
          {statement}
          {focus?.kind === 'writer' && !geoFocusMode && <SpaceWriterStatement world={world} id={focus.id} />}
          {focus?.kind === 'writer' && geoFocusMode && narrow && <WriterReadoutMobile world={world} id={focus.id} now={now} />}
          {!focus && (mode === 'world' || mode === 'missions' || mode === 'deadlines') && <Micro world={world} now={now} geo={geo} sync={sync} />}
          {!focus && (mode === 'world' || mode === 'signals') && <Feed world={world} expanded={mode === 'signals'} operatorTz={operatorTz} />}
          {mode === 'timezones' && !focus && (
            <TimezonePanel world={world} now={now} offset={offset} playing={playing}
              onScrub={(ms) => { setPlaying(false); setOffset(ms); }} onPlay={() => setPlaying((p) => !p)} onNow={() => { setPlaying(false); setOffset(0); }}
              onFocus={(id) => setFocus({ kind: 'writer', id })} />
          )}
          {mode === 'system' && view && <SystemPanel world={world} stats={view.stats} sync={sync} anomalies={anomalies} onLock={onLock} />}
          {focus && <button className="cc-back" onClick={() => setFocus(null)}>← {MODES.find((m) => m.mode === mode)?.label ?? 'WORLD'} <kbd>ESC</kbd></button>}
          {filter && !focus && <button className="cc-back" onClick={() => setFilter(null)}>{filter === 'online' ? 'WRITERS ONLINE' : filter === 'reviews' ? 'REVIEWS' : 'PRESSURE'} · CLEAR <kbd>ESC</kbd></button>}
          {palette && <Palette world={world} now={now} onClose={() => setPalette(false)} onRun={run} />}
        </>
      )}
      <PaletteDim open={palette} />
    </ViewCtx.Provider>
  );
}

function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const h = () => setOn(m.matches);
    m.addEventListener('change', h);
    return () => m.removeEventListener('change', h);
  }, [query]);
  return on;
}

function PaletteDim({ open }: { open: boolean }) {
  useEffect(() => {
    document.querySelector('.cc')?.classList.toggle('palette-open', open);
  }, [open]);
  return null;
}

function SpaceWriterStatement({ world, id }: { world: ControlWorld; id: string }) {
  const w = world.writers.find((x) => x.id === id);
  if (!w) return null;
  const projects = world.projects.filter((p) => !p.archived && p.writers.includes(id));
  const peers = new Set(world.links.filter((l) => l.from === id || l.to === id).map((l) => (l.from === id ? l.to : l.from)));
  return (
    <section className="cc-panel stats" key={id}>
      <h1 className="title cc-serif"><span className="l"><span>{w.callsign}</span></span><span className="l"><span><em style={{ fontStyle: 'italic', textTransform: 'none', color: 'var(--ink-2)' }}>{w.city}</em></span></span></h1>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(3, auto)' }}>
        <div><b>{String(projects.length).padStart(2, '0')}</b><span>OPERATIONS</span></div>
        <div><b>{String(new Set(projects.map((p) => p.clientId)).size).padStart(2, '0')}</b><span>CLIENTS</span></div>
        <div><b>{String(peers.size).padStart(2, '0')}</b><span>COLLABORATORS</span></div>
      </div>
      <div className="cc-metrics" style={{ marginTop: 0 }}>{projects.map((p) => <div key={p.id}><b>{p.client.toUpperCase()}</b><span>{p.title.toUpperCase()}</span></div>)}</div>
    </section>
  );
}

function revealText(p: number, land: number, nodes: number): string {
  const n = (x: number) => String(Math.max(1, Math.floor(x))).padStart(5, '0');
  if (p < 0.06) return `POINT <b>${n(1)}</b>`;
  if (p < 0.4) return `POINT <b>${n(Math.pow((p - 0.06) / 0.34, 2.2) * land * 0.45 + 1)}</b>`;
  if (p < 0.68) return `EARTH FORMING · <b>${n(land * (0.45 + ((p - 0.4) / 0.28) * 0.55))}</b>`;
  if (p < 0.8) return 'NETWORK <b>SYNCHRONIZING</b>';
  if (p < 0.9) return `WRITER NODES <b>${String(nodes).padStart(2, '0')}</b> ONLINE`;
  return 'ATMOSPHERE <b>ACTIVE</b>';
}

function throttle<T extends unknown[]>(fn: (...a: T) => void, ms: number) {
  let last = 0;
  let pending: ReturnType<typeof setTimeout> | null = null;
  return (...a: T) => {
    const now = performance.now();
    if (pending) clearTimeout(pending);
    if (now - last >= ms) { last = now; fn(...a); }
    else pending = setTimeout(() => { last = performance.now(); fn(...a); }, ms);
  };
}
