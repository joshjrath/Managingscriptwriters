// The Control Center's world: one WebGL scene, driven imperatively. React
// owns the typography and asks the engine to move; the engine owns every
// frame, and writes the screen positions of anything anchored in space
// straight onto the bound DOM elements, so nothing re-renders per frame.

import {
  Color, Euler, Group, Matrix4, Mesh, PerspectiveCamera, Quaternion, Raycaster, Scene, ShaderMaterial, Sphere, Texture, Vector2, Vector3, WebGLRenderer,
} from 'three';
import {
  anomaliesOf, coverageOf, presenceOf, SLOTS, SLOT_MIN, subsolarPoint,
  type Anomaly, type CcHandoff, type CcProject, type CcWriter, type ControlWorld, type Presence,
} from '../../../../shared/control';
import { buildAtmosphere, buildCore, buildShell, buildStars, buildSurfacePoints, MAX_BUMPS } from './globe';
import { ArcsLayer, type ArcDef } from './arcs';
import { computeLayouts, deadlineOrbit, projectOrbit, type Layouts } from './layout';
import { clamp01, damp, dampAngle, DEG, easeInOutCubic, easeOutCubic, geoToVec3, smoothstep, vec3ToGeo, wrapAngle } from './math';
import { NodesLayer, RING } from './nodes';
import { ObjectsLayer, type Edge, type EndRef, type SpaceObject } from './objects';
import { lower, pickTier, TIERS, type Tier } from './quality';
import { buildBandField, buildDial, DIAL, MAX_LANES, Orbit, orbitExtent, orbitReaches } from './rings';
import { SwarmLayer, type ScriptBody } from './swarm';
import type { WorldView } from './view';

export type Mode = 'world' | 'missions' | 'deadlines' | 'timezones' | 'signals' | 'constellation' | 'galaxy' | 'archive' | 'system';
export type Focus = { kind: 'writer' | 'project' | 'client' | 'anomaly' | 'city'; id: string } | null;
export type Filter = 'online' | 'reviews' | 'pressure' | null;
export interface Target { kind: 'writer' | 'project' | 'client'; id: string }

export interface EngineStats { fps: number; tier: Tier; dpr: number; particles: number; land: number }

export interface EngineOptions {
  reducedMotion: boolean;
  /** skip hardware detection (for a saved preference or diagnostics) */
  tier?: Tier;
  onHover?: (t: Target | null) => void;
  onSelect?: (t: Target | null) => void;
  onArrive?: (h: CcHandoff) => void;
  /** after each drawn frame, with its time (for anything that should move in step with the view) */
  onFrame?: (ms: number) => void;
  /** a handoff's packet was dropped before it landed: another took its arc, or the arc went away */
  onCancel?: (h: CcHandoff) => void;
  onPointerGeo?: (g: { lat: number; lon: number } | null) => void;
  onReveal?: (progress: number) => void;
  onStats?: (s: EngineStats) => void;
  onOverscroll?: (dir: 'in' | 'out') => void;
  /** the GPU dropped the WebGL context (a driver reset, too many WebGL tabs, sleep): the view should be built again on a new canvas */
  onContextLost?: () => void;
}

// ── how each mode arranges the world ─────────────────────────────────────

interface ModeSpec {
  dist: number;
  globeScale: number;
  globeZ: number;
  dissolve: number;
  dim: number;
  grid: number;
  night: number;
  atmo: number;
  arcs: number;
  bands: number;
  dial: number;
  mission: number;
  stars: number;
  /** script layouts: world, deadline, mission, space, graph */
  scripts: [number, number, number, number, number];
  /** project/client layouts: mission, graph, deadline, space */
  objects: [number, number, number, number];
  /** where people are: on the globe, in the constellation, or in the galaxy */
  nodes: 'geo' | 'graph' | 'space';
  autoRotate: number;
  pitch: number | null;
  spaceZ: number;
  /** move the composition sideways to make room for an instrument */
  shiftX: number;
}

const BASE: ModeSpec = {
  dist: 1, globeScale: 1, globeZ: 0, dissolve: 0, dim: 0, grid: 0, night: 1, atmo: 1, arcs: 1, bands: 0, dial: 0, mission: 0, stars: 1,
  scripts: [1, 0, 0, 0, 0], objects: [1, 0, 0, 0], nodes: 'geo', autoRotate: 1, pitch: null, spaceZ: 0, shiftX: 0,
};

const MODES: Record<Mode, ModeSpec> = {
  world: BASE,
  signals: { ...BASE, dim: 0.18, arcs: 1, autoRotate: 0.6 },
  system: { ...BASE, dim: 0.42, grid: 1, arcs: 0.45, autoRotate: 0.5, shiftX: -0.12 },
  missions: { ...BASE, dist: 1.14, globeScale: 0.9, dim: 0.35, arcs: 0.18, mission: 1, scripts: [0, 0, 1, 0, 0], autoRotate: 0.5 },
  deadlines: { ...BASE, dist: 1.52, globeScale: 0.8, dim: 0.42, arcs: 0.08, bands: 1, scripts: [0, 1, 0, 0, 0], objects: [0, 0, 1, 0], autoRotate: 0.45, pitch: 0.2 },
  timezones: { ...BASE, dist: 1.2, globeScale: 0.9, dim: 0.1, night: 0.55, arcs: 0.12, dial: 1, autoRotate: 0, pitch: 0.3 },
  constellation: { ...BASE, dist: 1.32, globeScale: 0.4, globeZ: -2.4, dissolve: 0.6, dim: 0.62, atmo: 0.25, arcs: 0, stars: 1.25, scripts: [0, 0, 0, 0, 1], objects: [0, 1, 0, 0], nodes: 'graph', autoRotate: 0 },
  galaxy: { ...BASE, dist: 1.46, globeScale: 0.28, globeZ: -4.2, dissolve: 0.85, dim: 0.7, atmo: 0.15, arcs: 0, stars: 1.5, scripts: [0, 0, 0, 1, 0], objects: [0, 0, 0, 1], nodes: 'space', autoRotate: 0 },
  archive: { ...BASE, dist: 1.46, globeScale: 0.22, globeZ: -6, dissolve: 0.92, dim: 0.8, atmo: 0.1, arcs: 0, stars: 1.7, scripts: [0, 0, 0, 1, 0], objects: [0, 0, 0, 1], nodes: 'space', autoRotate: 0, spaceZ: 4.2 },
};

/** the free orbits: radius, tilt (x, y, z), opacity, dashes, ticks — per mode, so they reorganize */
type OrbitSpec = [number, [number, number, number], number, number, number];
const BAND_TILT: [number, number, number] = [-1.2, 0, 0.12];
const DIAL_TILT: [number, number, number] = [-1.22, 0, 0];
const MISSION_TILT: [number, number, number] = [-1.08, 0.32, -0.22];
const ORBITS: Record<Mode, OrbitSpec[]> = {
  world: [[1.2, [-1.32, 0, 0.34], 0.16, 220, 0], [1.37, [-1.02, 0.48, 0], 0.1, 0, 90], [1.78, [-1.42, 0, -0.26], 0.07, 0, 0], [2.3, [-0.9, -0.6, 0.3], 0.035, 400, 0]],
  signals: [[1.2, [-1.32, 0, 0.34], 0.2, 220, 0], [1.37, [-1.02, 0.48, 0], 0.14, 0, 90], [1.78, [-1.42, 0, -0.26], 0.1, 0, 0], [2.3, [-0.9, -0.6, 0.3], 0.05, 400, 0]],
  system: [[1.2, [-1.32, 0, 0.34], 0.34, 220, 0], [1.37, [-1.02, 0.48, 0], 0.3, 0, 90], [1.78, [-1.42, 0, -0.26], 0.24, 0, 180], [2.3, [-0.9, -0.6, 0.3], 0.16, 400, 0]],
  missions: [[1.62, MISSION_TILT, 0.26, 0, 0], [1.74, MISSION_TILT, 0.08, 260, 0], [2.2, [-1.3, 0, 0.3], 0.04, 0, 0], [2.8, [-0.9, -0.6, 0.3], 0.02, 400, 0]],
  deadlines: [[1.35, BAND_TILT, 0.2, 0, 0], [1.61, BAND_TILT, 0.16, 0, 0], [1.99, BAND_TILT, 0.12, 0, 0], [2.58, BAND_TILT, 0.09, 0, 0]],
  timezones: [[DIAL.inner - 0.1, DIAL_TILT, 0.08, 0, 0], [2.02, DIAL_TILT, 0.1, 360, 0], [2.4, DIAL_TILT, 0.04, 0, 0], [2.9, [-0.9, -0.6, 0.3], 0.02, 400, 0]],
  constellation: [[3.4, [-1.3, 0, 0.3], 0.04, 0, 0], [3.9, [-1.0, 0.5, 0], 0.03, 300, 0], [4.6, [-1.4, 0, -0.3], 0.025, 0, 0], [5.4, [-0.9, -0.6, 0.3], 0.02, 0, 0]],
  galaxy: [[4.2, [-1.45, 0, 0.1], 0.03, 0, 0], [5.0, [-1.45, 0, 0.1], 0.025, 500, 0], [6.0, [-1.45, 0, 0.1], 0.02, 0, 0], [7.2, [-1.45, 0, 0.1], 0.015, 0, 0]],
  archive: [[4.2, [-1.45, 0, 0.1], 0.02, 0, 0], [5.0, [-1.45, 0, 0.1], 0.02, 500, 0], [6.0, [-1.45, 0, 0.1], 0.015, 0, 0], [7.2, [-1.45, 0, 0.1], 0.01, 0, 0]],
};

const STATUS_COLOR: Record<string, Color> = {
  active: new Color(0.52, 0.8, 1.0),
  deep_work: new Color(0.86, 0.92, 1.0),
  reviewing: new Color(0.72, 0.6, 1.0),
  away: new Color(0.5, 0.58, 0.8),
  offline: new Color(0.42, 0.5, 0.72),
  late: new Color(0.96, 0.56, 1.0),
  waking: new Color(0.52, 0.9, 0.95),
};

const PROJECT_COLOR = new Color(0.72, 0.84, 1.0);
const CLIENT_COLOR = new Color(0.5, 0.92, 1.0);

interface RigTarget { yaw: number; pitch: number; dist: number; shiftX: number; shiftY: number }

interface Binding {
  el: HTMLElement;
  key: string;
  /** the key's parts ("w:12" → "w" and "12"), read once */
  kind: string;
  id: string;
  vis?: string;
}

/** below this a label is hidden (and not placed) */
const LABEL_SHOWN = 0.04;

export class Engine implements WorldView {
  readonly flat = false;
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(30, 1, 0.05, 200);
  private opts: EngineOptions;
  private host: HTMLElement;

  // the world
  private world: ControlWorld | null = null;
  private writers: CcWriter[] = [];
  private writerIndex = new Map<string, number>();
  private geo: Vector3[] = [];
  private presence: Presence[] = [];
  private anomalies: Anomaly[] = [];
  private anomalyById = new Map<string, Anomaly>();
  private layouts: Layouts | null = null;

  // scene graph
  private globe = new Group();
  private space = new Group();
  private graphGroup = new Group();
  private surface: ReturnType<typeof buildSurfacePoints>;
  /** one sphere for the core, halo and rim (declared first: the two below use it) */
  private shell = buildShell();
  private core = buildCore(this.shell);
  private atmo = buildAtmosphere(this.shell);
  private stars: ReturnType<typeof buildStars>;
  // room for every person and editor a team is likely to place (instanced buffers: cheap); beyond it the rest aren't drawn
  private nodes = new NodesLayer(128);
  private arcs = new ArcsLayer();
  private swarm = new SwarmLayer();
  private objects = new ObjectsLayer();
  private orbits: Orbit[] = [0, 1, 2, 3].map(() => new Orbit());
  private phaseArc = new Orbit(3.2);
  private bandField = buildBandField();
  private dial = buildDial();

  // state
  mode: Mode = 'world';
  focus: Focus = null;
  filter: Filter = null;
  private hover: Target | null = null;
  private spec: ModeSpec = MODES.world;
  private fx = { globeScale: 1, globeZ: 0, dissolve: 0, dim: 0, grid: 0, night: 1, atmo: 1, arcs: 1, bands: 0, dial: 0, mission: 0, stars: 1, phase: 0, spaceZ: 0, archive: 0 };
  private rig = { yaw: 0, pitch: 0.3, dist: 6, zoom: 1, shiftX: 0, shiftY: 0, px: 0, py: 0 };
  private target: RigTarget = { yaw: 0, pitch: 0.3, dist: 1, shiftX: 0, shiftY: 0 };
  private tween: { from: RigTarget; to: RigTarget; start: number; duration: number } | null = null;
  private spaceRot = { yaw: 0, pitch: 0.12, vy: 0, vp: 0 };
  private spaceShift = new Vector3();
  private vel = { yaw: 0, pitch: 0 };
  private nodeW: Float32Array[] = [];
  private nodeIntensity: number[] = [];
  private flashes = new Map<number, number>();
  private clockOffset = 0;
  private lastInteraction = 0;
  private revealT = 0;
  private revealing = false;
  private revealStart = 0;
  private revealDuration = 3.6;
  private revealFrom = { yaw: 0, dist: 1 };
  private presenceAt = 0;
  /** the clock is being played forward, and the moment pressure was last worked out for */
  private clockRunning = false;
  private anomaliesFor = NaN;
  private dataAt = 0;
  private builtAt = 0;
  private bindings = new Set<Binding>();
  private handoffArc = new Map<string, { arc: number; dest: number }>();
  private missionIndex = new Map<string, number>();
  private objIndex = new Map<string, number>();
  /** the world's projects by id (kept with the world: an unchanged refresh keeps the same projects) */
  private projectById = new Map<string, CcProject>();
  // read every frame but changed only by a refresh (or, for pressure, once a second): worked out then
  /** per writer: their deadline in ms (NaN for none), and whether a script of theirs is in internal review */
  private writerDeadlineMs: number[] = [];
  private writerInReview: boolean[] = [];
  /** per writer: the worst pressure on them; and the pairs of people under pressure together */
  private writerSeverity: number[] = [];
  private pressurePairs = new Set<string>();
  /** per arc: its two people, the relationship between them, and the pair key pressure uses */
  private arcEnds: { a: string; b: string; link: ControlWorld['links'][number] | undefined; pair: string }[] = [];
  /** project id → its object, for the script swarm */
  private projectObj = new Map<string, number>();
  /** who the focus lights up, worked out once a frame */
  private lit: Set<string> | null = null;

  // loop & input
  private raf = 0;
  private running = false;
  private disposed = false;
  private last = 0;
  private time = 0;
  private frames: number[] = [];
  /** frame times against the rate asked for, in 60 fps terms: what the watchdog judges */
  private load: number[] = [];
  private watchUntil = 0;
  private downgrades = 0;
  private tier: Tier;
  private dprBase = 1;
  private dpr = 1;
  private pxScale = 1;
  private width = 1;
  private height = 1;
  private pointer = new Vector2(-9, -9);
  private pointerIn = false;
  private drag: { id: number; x: number; y: number; moved: boolean; t: number } | null = null;
  private pinch: { d: number; zoom: number } | null = null;
  private touches = new Map<number, { x: number; y: number }>();
  private overscroll = 0;
  private resizeObs: ResizeObserver;
  private ray = new Raycaster();
  private tmp = new Vector3();
  private tmp2 = new Vector3();
  private tmp3 = new Vector3();
  private tmp4 = new Vector3();
  private anchorP = new Vector3();
  private nrm = new Vector3();
  private tmpE = new Euler();
  private tmpM = new Matrix4();
  private tmpQ = new Quaternion();
  private sunLocal = new Vector3(1, 0, 0);
  private bandQuat = new Quaternion().setFromEuler(new Euler(...BAND_TILT));
  private dialQuat = new Quaternion().setFromEuler(new Euler(...DIAL_TILT));
  private missionQuat = new Quaternion().setFromEuler(new Euler(...MISSION_TILT));

  constructor(canvas: HTMLCanvasElement, opts: EngineOptions) {
    this.opts = opts;
    this.host = canvas.parentElement ?? document.body;
    // WebGL may be unavailable; the caller catches this and shows the 2D fallback
    // no multisampling, no stencil, no preserved buffer, and whichever GPU the system prefers (not the power-hungry one)
    const probe = canvas.getContext('webgl2', { powerPreference: 'default', antialias: false, alpha: true, stencil: false, depth: true, preserveDrawingBuffer: false });
    if (!probe) throw new Error('webgl2 unavailable');
    const dbg = probe.getExtension('WEBGL_debug_renderer_info');
    const gpu = dbg ? String(probe.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : null;
    this.tier = opts.tier ?? pickTier(gpu);
    const q = TIERS[this.tier];
    this.renderer = new WebGLRenderer({ canvas, context: probe, antialias: q.antialias, alpha: true, stencil: false, powerPreference: 'default' });
    this.renderer.setClearColor(0x000000, 0);
    this.dprBase = Math.min(window.devicePixelRatio || 1, q.maxDpr);
    this.dpr = this.dprBase;
    this.renderer.setPixelRatio(this.dpr);

    this.surface = buildSurfacePoints(q.sphere, q.dot);
    this.stars = buildStars(q.stars);
    this.globe.add(this.core.mesh, this.surface.points, this.atmo.haloMesh, this.atmo.rimMesh, this.arcs.group);
    this.space.add(this.swarm.archiveLines);
    this.scene.add(this.stars.points, this.globe, this.space, this.graphGroup, this.nodes.beams, this.nodes.glyphs, this.nodes.cores, this.swarm.points, this.objects.lines, this.objects.points, this.bandField.mesh, this.dial.mesh, this.phaseArc.mesh);
    for (const o of this.orbits) this.scene.add(o.mesh);
    this.bandField.mesh.quaternion.copy(this.bandQuat);
    this.dial.mesh.quaternion.copy(this.dialQuat);
    this.phaseArc.u.uColor.value.setRGB(0.8, 0.9, 1);
    this.phaseArc.u.uWidth.value = 1.3;
    this.phaseArc.u.uTicks.value = 0;

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(this.host);
    this.resize();
    canvas.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('pointerleave', this.onLeave);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    document.addEventListener('visibilitychange', this.onVisibility);
    canvas.addEventListener('webglcontextlost', this.onContextLost);
  }

  // ── public API ─────────────────────────────────────────────────────────

  get stats(): EngineStats {
    const f = this.frames;
    const avg = f.length ? f.reduce((a, b) => a + b, 0) / f.length : 16.7;
    return { fps: Math.round(1000 / avg), tier: this.tier, dpr: this.dpr, particles: this.surface.total, land: this.surface.land };
  }

  now(): Date {
    return new Date(Date.now() + this.clockOffset);
  }

  setTimeOffset(ms: number, running = false) {
    this.clockOffset = ms;
    this.clockRunning = running;
    this.presenceAt = 0;
  }

  get timeOffset() {
    return this.clockOffset;
  }

  setWorld(world: ControlWorld) {
    const prev = this.world;
    // the layouts read only these lists and come out the same for the same lists
    // (unchanged parts keep their identity across refreshes)
    const sameLayout = !!prev && prev.writers === world.writers && prev.scripts === world.scripts && prev.projects === world.projects
      && prev.clients === world.clients && prev.links === world.links;
    // a refresh with nothing new on the map: keep every buffer and layout as it is, and
    // once a minute move project orbits in as deadlines near (script orbits follow in refreshPresence)
    if (sameLayout && prev.handoffs === world.handoffs) {
      this.world = world;
      if (performance.now() - this.builtAt >= 60_000) { this.builtAt = performance.now(); this.retimeProjects(); }
      return;
    }
    this.builtAt = performance.now();
    const first = !prev;
    this.world = world;
    this.writers = world.writers.slice(0, this.nodes.max);
    this.writerIndex = new Map(this.writers.map((w, i) => [w.id, i]));
    this.geo = this.writers.map((w) => geoToVec3(w.lat, w.lon, 1));
    this.nodes.setCount(this.writers.length);
    while (this.nodeW.length < this.writers.length) this.nodeW.push(Float32Array.from([1, 0, 0]));
    this.nodeW.length = this.writers.length;
    while (this.nodeIntensity.length < this.writers.length) this.nodeIntensity.push(0);
    this.writerDeadlineMs = this.writers.map((w) => (w.deadline ? new Date(w.deadline).getTime() : NaN));
    const reviewing = new Set<string>();
    for (const s of world.scripts) if (s.state === 'internal_review' && s.writerId) reviewing.add(s.writerId);
    this.writerInReview = this.writers.map((w) => reviewing.has(w.id));
    if (!sameLayout || !this.layouts) this.layouts = computeLayouts(world);
    this.presenceAt = 0;
    this.anomaliesFor = NaN;
    this.refreshPresence();

    // arcs: relationships, plus every pair a handoff has travelled
    const defs = new Map<string, ArcDef & { kind: string }>();
    const pair = (a: string, b: string, kind: string) => {
      const ia = this.writerIndex.get(a), ib = this.writerIndex.get(b);
      if (ia == null || ib == null || ia === ib) return;
      const key = ia < ib ? `${a}|${b}` : `${b}|${a}`;
      if (defs.has(key)) return;
      const [from, to] = ia < ib ? [ia, ib] : [ib, ia];
      const color = kind === 'review' ? new Color(0.7, 0.62, 1) : kind === 'edit' ? new Color(0.55, 0.9, 1) : kind === 'research' ? new Color(0.62, 0.72, 1) : new Color(0.58, 0.78, 1);
      defs.set(key, { key, from: this.geo[from], to: this.geo[to], color, kind });
    };
    for (const l of world.links) pair(l.from, l.to, l.kind);
    for (const h of world.handoffs) pair(h.originNode, h.destinationNode, 'handoff');
    const list = [...defs.values()];
    this.arcs.setArcs(list);
    this.arcEnds = this.arcs.keys().map((key) => {
      const [a, b] = key.split('|');
      // the pair key is sorted by id (the arc key is ordered by writer index), as pressure's pairs are
      return { a, b, link: world.links.find((l) => (l.from === a && l.to === b) || (l.from === b && l.to === a)), pair: [a, b].sort().join('|') };
    });
    this.handoffArc.clear();
    for (const h of world.handoffs) {
      const ia = this.writerIndex.get(h.originNode), ib = this.writerIndex.get(h.destinationNode);
      if (ia == null || ib == null) continue;
      const key = ia < ib ? `${h.originNode}|${h.destinationNode}` : `${h.destinationNode}|${h.originNode}`;
      this.handoffArc.set(h.id, { arc: this.arcs.indexOf(key), dest: ib });
    }

    // scripts and objects
    this.refreshOrbits();
    this.missionIndex = new Map(this.layouts.missionOrder.map((id, i) => [id, i]));
    const objs: Parameters<ObjectsLayer['setObjects']>[0] = [];
    const at = this.now();
    for (const p of world.projects) {
      const g = this.layouts.graph.index.get(`p:${p.id}`);
      objs.push({
        kind: 'project', id: p.id, color: p.archived ? new Color(1, 0.88, 0.7) : PROJECT_COLOR.clone(), size: p.archived ? 0.9 : 1.6,
        graphPos: g != null ? this.layouts.graph.nodes[g].pos : null, spacePos: this.layouts.space.projects.get(p.id) ?? null,
        missionIndex: this.missionIndex.get(p.id) ?? -1, ...projectOrbit(p, at),
      });
    }
    for (const c of world.clients) {
      const g = this.layouts.graph.index.get(`c:${c.id}`);
      if (g == null) continue;
      objs.push({ kind: 'client', id: c.id, color: CLIENT_COLOR.clone(), size: 1.1, graphPos: this.layouts.graph.nodes[g].pos, spacePos: null, orbitR: 3, orbitW: 0, missionIndex: -1, urgent: false });
    }
    this.objIndex = new Map(objs.map((o, i) => [`${o.kind}:${o.id}`, i]));
    this.projectObj = new Map();
    objs.forEach((o, i) => { if (o.kind === 'project' && !this.projectObj.has(o.id)) this.projectObj.set(o.id, i); });
    this.projectById = new Map();
    for (const p of world.projects) if (!this.projectById.has(p.id)) this.projectById.set(p.id, p);
    const edges: Omit<Edge, 'alpha'>[] = [];
    for (const e of this.layouts.graph.edges) {
      const a = this.layouts.graph.nodes[e.a], b = this.layouts.graph.nodes[e.b];
      const ref = (n: typeof a): EndRef | null => {
        const i = n.kind === 'writer' ? this.writerIndex.get(n.id) : this.objIndex.get(`${n.kind}:${n.id}`);
        return i == null ? null : n.kind === 'writer' ? { writer: i } : { obj: i };
      };
      const ra = ref(a), rb = ref(b);
      if (ra && rb) edges.push({ a: ra, b: rb, kind: e.kind });
    }
    this.objects.setObjects(objs, edges);
    this.dataAt = performance.now();

    if (first) {
      // open facing where the team is, from a little above
      let sx = 0, sz = 0;
      for (const v of this.geo) { sx += v.x; sz += v.z; }
      const lon = this.geo.length ? Math.atan2(sx, sz) : 0;
      this.rig.yaw = this.target.yaw = -lon;
      this.rig.pitch = this.target.pitch = 0.32;
    }
  }

  /** Move project orbits in as their deadlines near, without rebuilding anything. */
  private retimeProjects() {
    const at = this.now();
    for (const p of this.world?.projects ?? []) {
      const i = this.objIndex.get(`project:${p.id}`);
      if (i != null) Object.assign(this.objects.objects[i], projectOrbit(p, at));
    }
  }

  /** Recompute script orbits: deadlines keep approaching, so orbits tighten over time. */
  private refreshOrbits() {
    const world = this.world;
    if (!world || !this.layouts) return;
    const at = this.now();
    const archived = new Set(world.projects.filter((p) => p.archived).map((p) => p.id));
    this.swarm.setScripts(world.scripts.map((s) => {
      const d = deadlineOrbit(s.state === 'delivered' || s.state === 'approved' ? null : s.deadline, at);
      return {
        script: s, writer: s.writerId ? this.writerIndex.get(s.writerId) ?? -1 : -1, archived: archived.has(s.projectId),
        orbitR: d.radius, orbitW: (0.045 / Math.pow(d.radius, 1.5)) * (d.hours < 24 ? 2.2 : 1), urgent: !archived.has(s.projectId) && d.hours < 24 && s.state !== 'delivered' && s.state !== 'approved',
        space: this.layouts!.space.scripts.get(s.id) ?? null,
      };
    }));
  }

  setMode(mode: Mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.spec = MODES[mode];
    // the dial fades in fresh, not with the lanes and hour it had when last seen
    if (mode === 'timezones' && this.world) this.updateDial(this.now());
    if (mode !== 'missions' && this.focus?.kind === 'project') this.focus = null;
    this.retarget(1.6);
  }

  setFocus(focus: Focus) {
    this.focus = focus;
    if (focus?.kind === 'city') {
      const [lat, lon] = focus.id.split(',').map(Number);
      this.retarget(1.8, { lat, lon });
      return;
    }
    this.retarget(focus ? 1.9 : 1.5);
  }

  setFilter(filter: Filter) {
    this.filter = filter;
  }

  /** Aim the camera at a city (the globe turns to face it). */
  focusGeo(lat: number, lon: number) {
    this.focus = { kind: 'city', id: `${lat},${lon}` };
    this.retarget(1.8, { lat, lon });
  }

  /** Turn the globe (or the open-space views) a little, for the keyboard. */
  nudge(yaw: number, pitch: number) {
    this.tween = null;
    this.lastInteraction = this.time;
    if (this.spec.nodes === 'geo') {
      this.vel.yaw += yaw * 3;
      this.vel.pitch += pitch * 3;
    } else {
      this.spaceRot.vy += yaw * 3;
      this.spaceRot.vp += pitch * 3;
    }
  }

  zoomBy(factor: number) {
    this.rig.zoom = Math.min(1.7, Math.max(0.5, this.rig.zoom * factor));
    this.lastInteraction = this.time;
  }

  /** Pin a DOM element to something in space (several elements may share a key). */
  bind(key: string, el: HTMLElement): () => void {
    const c = key.indexOf(':');
    const b: Binding = { el, key, kind: c < 0 ? key : key.slice(0, c), id: c < 0 ? '' : key.slice(c + 1) };
    this.bindings.add(b);
    return () => { this.bindings.delete(b); };
  }

  playHandoff(h: CcHandoff): boolean {
    const route = this.handoffArc.get(h.id);
    if (!route || route.arc < 0) return false;
    const [a] = this.arcs.keys()[route.arc].split('|');
    const reverse = a !== h.originNode;
    const duration = this.opts.reducedMotion ? 0.8 : 2.8;
    this.arcs.launch(route.arc, reverse, this.time, duration, () => {
      this.flashes.set(route.dest, 1);
      this.opts.onArrive?.(h);
    }, () => this.opts.onCancel?.(h));
    return true;
  }

  reveal(fast = false) {
    this.revealing = true;
    this.revealStart = this.time;
    this.revealDuration = this.opts.reducedMotion ? 0.9 : fast ? 2.2 : 3.8;
    this.revealFrom = { yaw: this.rig.yaw + (this.opts.reducedMotion ? 0 : 0.9), dist: this.opts.reducedMotion ? 1 : 0.62 };
    this.rig.yaw = this.revealFrom.yaw;
    this.start();
  }

  start() {
    if (this.running || this.disposed) return;
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  dispose() {
    this.disposed = true;
    this.stop();
    this.resizeObs.disconnect();
    const c = this.renderer.domElement;
    c.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointercancel', this.onUp);
    c.removeEventListener('pointerleave', this.onLeave);
    c.removeEventListener('wheel', this.onWheel);
    document.removeEventListener('visibilitychange', this.onVisibility);
    c.removeEventListener('webglcontextlost', this.onContextLost);
    this.nodes.dispose();
    this.arcs.dispose();
    this.swarm.dispose();
    this.objects.dispose();
    // everything else in the scene: geometry, materials and any textures they hold
    this.scene.traverse((o) => {
      const m = o as Mesh;
      m.geometry?.dispose();
      const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
      for (const mat of mats) {
        for (const u of Object.values((mat as ShaderMaterial).uniforms ?? {})) if ((u.value as Texture | null)?.isTexture) (u.value as Texture).dispose();
        mat.dispose();
      }
    });
    this.renderer.renderLists.dispose();
    this.renderer.dispose();
    // give the GPU memory back now rather than whenever the page lets go of the canvas
    // (not while the canvas is still on the page: React may mount it again)
    setTimeout(() => { if (!c.isConnected) this.renderer.forceContextLoss(); }, 0);
  }

  writerAnomaly(id: string): Anomaly[] {
    return this.anomalies.filter((a) => a.writerId === id);
  }

  get currentAnomalies(): Anomaly[] {
    return this.anomalies;
  }

  // ── targets ────────────────────────────────────────────────────────────

  private retarget(duration: number, geo?: { lat: number; lon: number }) {
    const spec = this.spec;
    const t = { yaw: this.rig.yaw, pitch: spec.pitch ?? this.target.pitch, dist: spec.dist, shiftX: spec.shiftX, shiftY: 0 };
    const f = this.focus;
    const face = (lat: number, lon: number, pitchScale = 0.85) => {
      t.yaw = this.rig.yaw + wrapAngle(-lon * DEG - this.rig.yaw);
      t.pitch = Math.max(-1.0, Math.min(1.0, lat * DEG * pitchScale));
    };
    if (geo) {
      face(geo.lat, geo.lon);
      t.dist = spec.dist * 0.72;
    } else if (f?.kind === 'writer' || (f?.kind === 'anomaly' && this.anomalyById.get(f.id)?.writerId)) {
      const id = f.kind === 'writer' ? f.id : this.anomalyById.get(f.id)!.writerId!;
      const w = this.writers[this.writerIndex.get(id) ?? -1];
      if (w && this.spec.nodes === 'geo') {
        face(w.lat, w.lon);
        t.dist = spec.dist * 0.7;
        // the city sits left of centre, a little high, so its readout has dark space to the right
        t.shiftX = -0.17;
        t.shiftY = -0.05;
      } else if (w) {
        t.dist = spec.dist * 0.8;
      }
    } else if (f?.kind === 'anomaly') {
      const a = this.anomalyById.get(f.id);
      if (a?.at) { face(a.at.lat, a.at.lon); t.dist = spec.dist * 0.7; t.shiftX = -0.1; }
    } else if (f?.kind === 'project' && this.world) {
      const p = this.projectById.get(f.id);
      const ws = (p?.writers ?? []).map((id) => this.writers[this.writerIndex.get(id) ?? -1]).filter(Boolean);
      if (ws.length && this.spec.nodes === 'geo') {
        let sx = 0, sy = 0, sz = 0;
        for (const w of ws) { const v = geoToVec3(w.lat, w.lon); sx += v.x; sy += v.y; sz += v.z; }
        const c = vec3ToGeo(new Vector3(sx, sy, sz));
        face(c.lat * 0.6, c.lon, 0.6);
      }
      t.dist = spec.dist * 0.96;
      t.shiftY = 0.04;
    } else if (f?.kind === 'client') {
      t.dist = spec.dist * 0.9;
    }
    if (this.mode === 'timezones') {
      const sun = subsolarPoint(this.now());
      t.yaw = this.rig.yaw + wrapAngle((90 - sun.lon) * DEG - this.rig.yaw);
    }
    if (this.portrait) {
      // on a phone the typography lives below: the planet rides high, focused places in the upper half
      t.shiftX = 0;
      t.shiftY = f && f.kind !== 'client' ? -0.2 : -0.12;
      if (f?.kind === 'writer' || f?.kind === 'anomaly' || f?.kind === 'city') t.dist *= 1.15;
    }
    this.rig.zoom = 1;
    const reduced = this.opts.reducedMotion;
    this.tween = { from: { yaw: this.rig.yaw, pitch: this.rig.pitch, dist: this.target.dist, shiftX: this.rig.shiftX, shiftY: this.rig.shiftY }, to: t, start: this.time, duration: reduced ? 0.35 : duration };
    this.target = t;
    this.vel.yaw = this.vel.pitch = 0;
  }

  // ── per frame ──────────────────────────────────────────────────────────

  /**
   * How often to draw right now. Smooth while anything moves (a drag, a camera
   * move, the reveal, a handoff in flight), half that while the planet is just
   * turning, and slower still while the window isn't in front. Frames that
   * aren't drawn cost nothing.
   */
  private frameInterval(): number {
    if (!document.hasFocus()) return 1000 / 15;
    const busy = !!this.drag || !!this.pinch || !!this.tween || this.revealing || this.time - this.lastInteraction < 2.5 || this.arcs.moving;
    return busy ? 1000 / 60 : 1000 / 30;
  }

  private frame = (ms: number) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    const interval = this.frameInterval();
    const raw = ms - this.last;
    if (raw < interval - 3) return;
    // time follows the clock at any frame rate (only a long stall is cut short)
    const dt = Math.min(0.1, raw / 1000);
    this.last = ms;
    this.time += dt;
    this.frames.push(raw);
    if (this.frames.length > 90) this.frames.shift();
    this.load.push((raw * (1000 / 60)) / interval);
    if (this.load.length > 90) this.load.shift();
    this.watchPerformance();
    try {
      this.step(dt);
      this.renderer.render(this.scene, this.camera);
      this.writeAnchors();
      this.opts.onFrame?.(ms);
    } catch (err) {
      console.error(err);
      this.stop();
    }
  };

  private step(dt: number) {
    const now = this.now();
    const reduced = this.opts.reducedMotion;
    if (performance.now() - this.presenceAt > 1000) this.refreshPresence();

    // reveal: a point, a cloud, the outline, then the planet
    let reveal = 1;
    if (this.revealing) {
      const p = clamp01((this.time - this.revealStart) / this.revealDuration);
      reveal = p;
      this.revealT = p;
      if (p >= 1) this.revealing = false;
      this.opts.onReveal?.(p);
    } else reveal = this.revealT;

    // ease every mode value toward its target
    const s = this.spec;
    const focusDim = this.focus && this.focus.kind !== 'city' ? 0.22 : 0;
    const want = {
      globeScale: s.globeScale, globeZ: s.globeZ, dissolve: s.dissolve, dim: Math.min(0.9, s.dim + focusDim), grid: s.grid, night: s.night, atmo: s.atmo,
      arcs: s.arcs, bands: s.bands, dial: s.dial, mission: s.mission, stars: s.stars,
      phase: this.mode === 'missions' && this.focus?.kind === 'project' ? 1 : 0, spaceZ: s.spaceZ, archive: this.mode === 'archive' ? 1 : 0,
    };
    const lam = reduced ? 10 : 2.4;
    for (const k of Object.keys(want) as (keyof typeof want)[]) this.fx[k] = damp(this.fx[k], want[k], k === 'spaceZ' ? lam * 0.7 : lam, dt);

    // camera: a choreographed tween, or free control with inertia
    const tw = this.tween;
    if (tw) {
      const p = clamp01((this.time - tw.start) / tw.duration);
      const e = easeInOutCubic(p);
      this.rig.yaw = tw.from.yaw + (tw.to.yaw - tw.from.yaw) * e;
      this.rig.pitch = tw.from.pitch + (tw.to.pitch - tw.from.pitch) * e;
      this.rig.shiftX = tw.from.shiftX + (tw.to.shiftX - tw.from.shiftX) * e;
      this.rig.shiftY = tw.from.shiftY + (tw.to.shiftY - tw.from.shiftY) * e;
      this.target.dist = tw.from.dist + (tw.to.dist - tw.from.dist) * easeInOutCubic(clamp01(p * 1.1));
      if (p >= 1) this.tween = null;
    } else if (!this.drag) {
      this.rig.yaw += this.vel.yaw * dt;
      this.rig.pitch = Math.max(-1.1, Math.min(1.1, this.rig.pitch + this.vel.pitch * dt));
      const decay = Math.exp(-dt * 2.6);
      this.vel.yaw *= decay;
      this.vel.pitch *= decay;
      const idle = this.time - this.lastInteraction > 5 && !this.focus && !reduced;
      if (idle && !this.revealing) this.rig.yaw += dt * 0.028 * s.autoRotate;
      if (this.mode === 'timezones' && !this.focus) {
        const sun = subsolarPoint(now);
        this.rig.yaw = dampAngle(this.rig.yaw, (90 - sun.lon) * DEG, 1.5, dt);
        this.rig.pitch = damp(this.rig.pitch, s.pitch ?? 0.3, 1.5, dt);
      }
    }
    if (!this.drag && this.mode !== 'timezones' && !tw && s.pitch == null && !this.focus && this.time - this.lastInteraction > 8) {
      this.rig.pitch = damp(this.rig.pitch, 0.3, 0.3, dt);
    }
    // the space views turn slowly on their own and follow drags there
    this.spaceRot.yaw += (this.spaceRot.vy + (reduced ? 0 : 0.03)) * dt;
    this.spaceRot.pitch = Math.max(-0.8, Math.min(0.8, this.spaceRot.pitch + this.spaceRot.vp * dt));
    this.spaceRot.vy *= Math.exp(-dt * 2.4);
    this.spaceRot.vp *= Math.exp(-dt * 2.4);

    const revealDist = this.revealing ? this.revealFrom.dist + (1 - this.revealFrom.dist) * easeOutCubic(reveal) : 1;
    if (this.revealing && !reduced) this.rig.yaw = this.revealFrom.yaw + (this.target.yaw - this.revealFrom.yaw) * easeOutCubic(reveal);
    const wantDist = this.baseDist() * this.target.dist * this.rig.zoom * revealDist;
    this.rig.dist = this.revealing ? wantDist : damp(this.rig.dist, wantDist, 4, dt);

    // a little parallax from the pointer
    const px = reduced || !this.pointerIn ? 0 : this.pointer.x * 0.06;
    const py = reduced || !this.pointerIn ? 0 : this.pointer.y * 0.04;
    this.rig.px = damp(this.rig.px, px, 2, dt);
    this.rig.py = damp(this.rig.py, py, 2, dt);
    this.camera.position.set(this.rig.px * this.rig.dist * 0.2, this.rig.py * this.rig.dist * 0.2, this.rig.dist);
    this.camera.lookAt(0, 0, 0);
    this.camera.setViewOffset(this.width, this.height, -this.rig.shiftX * this.width, -this.rig.shiftY * this.height, this.width, this.height);
    this.camera.updateMatrixWorld();

    // the planet
    this.globe.rotation.set(this.rig.pitch, this.rig.yaw, 0, 'XYZ');
    this.globe.scale.setScalar(this.fx.globeScale);
    this.globe.position.set(0, 0, this.fx.globeZ);
    this.globe.updateMatrixWorld();
    const sun = subsolarPoint(now);
    geoToVec3(sun.lat, sun.lon, 1, this.sunLocal);
    const su = this.surface.material.uniforms;
    su.uTime.value = this.time;
    su.uReveal.value = reveal;
    su.uDpr.value = this.dpr * this.pxScale;
    su.uSun.value.copy(this.sunLocal);
    su.uDim.value = this.fx.dim;
    su.uDissolve.value = this.fx.dissolve;
    su.uGrid.value = this.fx.grid;
    su.uNight.value = this.fx.night;
    const coreOn = smoothstep(0.62, 0.95, reveal);
    this.core.material.uniforms.uOpacity.value = coreOn * (1 - this.fx.dissolve * 0.85);
    this.core.material.uniforms.uSun.value.copy(this.sunLocal);
    this.core.material.uniforms.uSunView.value.copy(this.sunLocal).applyQuaternion(this.globe.quaternion).transformDirection(this.camera.matrixWorldInverse);
    this.core.material.uniforms.uDim.value = this.fx.dim;
    this.core.mesh.visible = coreOn > 0.001;
    const atmoOn = smoothstep(0.7, 1, reveal) * this.fx.atmo;
    this.atmo.halo.uniforms.uSun.value.copy(this.sunLocal);
    this.atmo.halo.uniforms.uIntensity.value = atmoOn * 0.72;
    this.atmo.rim.uniforms.uSun.value.copy(this.sunLocal);
    this.atmo.rim.uniforms.uIntensity.value = atmoOn * 0.78;
    this.stars.material.uniforms.uTime.value = this.time;
    this.stars.material.uniforms.uDpr.value = this.dpr;
    this.stars.material.uniforms.uOpacity.value = smoothstep(0.05, 0.6, reveal) * this.fx.stars;
    this.stars.material.uniforms.uDeep.value = this.fx.archive;
    this.stars.points.rotation.y = this.time * 0.004 + this.rig.yaw * 0.05;

    // the space views; an open cluster is brought to the centre of the view
    const cluster = (this.mode === 'galaxy' || this.mode === 'archive') && this.focus?.kind === 'project' ? this.layouts?.space.projects.get(this.focus.id) : null;
    if (cluster) {
      this.tmp.copy(cluster).applyEuler(this.space.rotation);
      this.spaceShift.x = damp(this.spaceShift.x, -this.tmp.x, 2, dt);
      this.spaceShift.y = damp(this.spaceShift.y, -this.tmp.y, 2, dt);
      this.spaceShift.z = damp(this.spaceShift.z, -this.tmp.z - this.fx.spaceZ + 2.2, 2, dt);
    } else {
      this.spaceShift.x = damp(this.spaceShift.x, 0, 2, dt);
      this.spaceShift.y = damp(this.spaceShift.y, 0, 2, dt);
      this.spaceShift.z = damp(this.spaceShift.z, 0, 2, dt);
    }
    this.space.position.set(this.spaceShift.x, this.spaceShift.y, this.fx.spaceZ + this.spaceShift.z);
    this.space.rotation.set(this.spaceRot.pitch, this.spaceRot.yaw * 0.6, 0, 'XYZ');
    this.space.updateMatrixWorld();
    this.graphGroup.rotation.set(this.spaceRot.pitch * 0.8, this.spaceRot.yaw, 0, 'XYZ');
    this.graphGroup.updateMatrixWorld();

    this.lit = this.focusedWriters();
    this.updateNodes(dt, reveal);
    this.updateArcs(dt);
    this.updateOrbits(dt, reveal);
    this.updateObjects(dt, reveal);
    this.updateSwarm(dt, reveal);
    this.updatePointer();
  }

  private baseDist() {
    // size the globe to about 62% of the shorter side of the screen
    const vHalf = (this.camera.fov / 2) * DEG;
    const aspect = this.width / this.height;
    const hHalf = Math.atan(Math.tan(vHalf) * aspect);
    const half = Math.min(vHalf, hHalf);
    const frac = aspect < 0.8 ? 0.86 : 0.64;
    return 1 / Math.sin(Math.atan(Math.tan(half) * frac));
  }

  private refreshPresence() {
    const now = this.now();
    this.presenceAt = performance.now();
    this.presence = this.writers.map((w) => presenceOf(w, now));
    if (this.world) {
      // while the sun is followed (an hour a second) pressure is worked out every quarter hour of
      // that clock rather than every frame; exact again as soon as the clock stops or jumps
      if (!this.clockRunning || this.focus || !(Math.abs(now.getTime() - this.anomaliesFor) < 15 * 60_000)) {
        this.anomaliesFor = now.getTime();
        this.anomalies = anomaliesOf(this.world, now);
        this.anomalyById = new Map();
        for (const a of this.anomalies) if (!this.anomalyById.has(a.id)) this.anomalyById.set(a.id, a);
        this.writerSeverity = this.writers.map(() => 0);
        this.pressurePairs = new Set();
        for (const a of this.anomalies) {
          if (!a.writerId) continue;
          const i = this.writerIndex.get(a.writerId);
          if (i != null && i < this.writerSeverity.length) this.writerSeverity[i] = Math.max(this.writerSeverity[i], a.severity);
          for (const s of a.sources) this.pressurePairs.add([a.writerId, s].sort().join('|'));
        }
      }
      // the 24-hour dial is only seen in the time zones view (and while it fades out of it)
      if (this.mode === 'timezones' || this.dial.mesh.visible) this.updateDial(now);
    }
    // deadlines approach: every half minute, orbits tighten
    if (this.world && performance.now() - this.dataAt > 30_000) {
      this.dataAt = performance.now();
      this.refreshOrbits();
    }
  }

  private updateDial(now: Date) {
    const cov = coverageOf(this.writers, now);
    const data = this.dial.data;
    data.fill(0);
    const lanes = this.writers.slice(0, MAX_LANES);
    lanes.forEach((w, i) => {
      const win = cov.windows.find((x) => x.writerId === w.id);
      if (!win) return;
      for (let s = Math.round((win.start * 60) / SLOT_MIN); s < Math.round((win.end * 60) / SLOT_MIN); s++) data[i * SLOTS + (s % SLOTS)] = 255;
      const c = (this.dial.material.uniforms.uLaneColor.value as Color[])[i];
      const p = this.presence[i];
      c.copy(STATUS_COLOR[p?.phase === 'late' ? 'late' : p?.status ?? 'active'] ?? STATUS_COLOR.active);
    });
    for (let s = 0; s < SLOTS; s++) data[MAX_LANES * SLOTS + s] = Math.min(255, cov.slots[s] * 32);
    this.dial.lanes.needsUpdate = true;
    this.dial.material.uniforms.uLaneCount.value = lanes.length;
    const u = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
    this.dial.material.uniforms.uNowH.value = u;
  }

  /** Where each person is this frame, and how they look. */
  private updateNodes(dt: number, reveal: number) {
    const camPos = this.camera.position;
    const reduced = this.opts.reducedMotion;
    const focusWriter = this.lit;
    const want = this.spec.nodes;
    const target = [want === 'geo' ? 1 : 0, want === 'graph' ? 1 : 0, want === 'space' ? 1 : 0];
    const nowMs = this.now().getTime();
    const bumps = this.surface.material.uniforms.uBumps.value as { set: (x: number, y: number, z: number, w: number) => void }[];
    let bump = 0;
    const g = this.layouts?.graph;
    this.writers.forEach((w, i) => {
      const v = this.nodes.vis[i];
      const p = this.presence[i];
      const W = this.nodeW[i];
      const k = 1 - Math.exp(-dt * (reduced ? 8 : 1.4 + (i % 5) * 0.35));
      for (let j = 0; j < 3; j++) W[j] += (target[j] - W[j]) * k;
      // geography
      const geoPos = this.tmp.copy(this.geo[i]).applyMatrix4(this.globe.matrixWorld);
      const center = this.tmp2.setFromMatrixPosition(this.globe.matrixWorld);
      const normal = this.nrm.subVectors(geoPos, center).normalize();
      v.pos.copy(geoPos).multiplyScalar(W[0]);
      let ws = W[0];
      if (g && W[1] > 1e-4) {
        const gi = g.index.get(`w:${w.id}`);
        if (gi != null) {
          const gp = this.tmp3.copy(g.nodes[gi].pos).add(this.tmp4.set(Math.sin(this.time * 0.31 + i) * 0.04, Math.cos(this.time * 0.27 + i * 2) * 0.04, 0)).applyMatrix4(this.graphGroup.matrixWorld);
          v.pos.addScaledVector(gp, W[1]);
          ws += W[1];
        }
      }
      if (this.layouts && W[2] > 1e-4) {
        const sp = this.layouts.space.writers.get(w.id);
        if (sp) { v.pos.addScaledVector(this.tmp3.copy(sp).applyMatrix4(this.space.matrixWorld), W[2]); ws += W[2]; }
      }
      v.pos.multiplyScalar(1 / Math.max(1e-4, ws));
      v.normal.copy(normal);
      v.billboard = 1 - W[0];
      v.facing = W[0] * normal.dot(this.tmp3.subVectors(camPos, geoPos).normalize()) + (1 - W[0]);

      // rhythm by status and time of day
      const phase = p?.phase ?? 'off';
      const status = p?.status ?? 'offline';
      const soon = w.deadline ? this.writerDeadlineMs[i] - nowMs : Infinity;
      const pressing = soon > 0 && soon < 12 * 3_600_000;
      v.ring = phase === 'off' ? RING.none : phase === 'waking' ? RING.waking : phase === 'late' ? RING.late
        : status === 'reviewing' ? RING.orbit : status === 'deep_work' ? RING.heartbeat : RING.pulse;
      v.period = (status === 'deep_work' ? 3.4 : phase === 'late' ? 4.2 : 2.6) / (pressing ? 1.55 : 1);
      v.color.copy(STATUS_COLOR[phase === 'late' ? 'late' : phase === 'waking' ? 'waking' : status] ?? STATUS_COLOR.active);
      const night = (p?.sun ?? 0) < -0.05;
      let inten = phase === 'on' ? (night ? 1.15 : 0.95) : phase === 'late' ? 1.05 : phase === 'waking' ? 0.5 : 0.22;
      if (focusWriter) inten = focusWriter.has(w.id) ? 1.25 : 0.1;
      if (this.filter === 'online' && phase !== 'on' && phase !== 'late') inten *= 0.2;
      if (this.filter === 'reviews' && status !== 'reviewing' && !this.writerInReview[i]) inten *= 0.25;
      const anomaly = this.writerSeverity[i] ?? 0;
      if (this.filter === 'pressure' && !anomaly) inten *= 0.2;
      if (this.mode === 'missions' && !this.focus) inten *= 0.45;
      if (this.mode === 'deadlines') inten *= 0.6;
      if (this.mode === 'archive') inten *= 0.12;
      const hovered = this.hover?.kind === 'writer' && this.hover.id === w.id;
      if (hovered) inten *= 1.25;
      this.nodeIntensity[i] = damp(this.nodeIntensity[i], inten, 3.5, dt);
      const appear = this.revealing ? smoothstep(0.82 + (i % 7) * 0.02, 0.98, reveal) : 1;
      v.intensity = this.nodeIntensity[i] * appear;
      v.anomaly = anomaly * (this.mode === 'world' || this.mode === 'signals' || this.mode === 'system' || this.filter === 'pressure' ? 1 : 0.4);
      v.dusk = Math.abs(p?.sun ?? 1) < 0.12 && phase !== 'off' ? 1 - Math.abs(p!.sun) / 0.12 : 0;
      const isFocus = (this.focus?.kind === 'writer' && this.focus.id === w.id) || (this.focus?.kind === 'anomaly' && this.anomalyById.get(this.focus.id)?.writerId === w.id);
      v.focus = damp(v.focus, isFocus ? 1 : hovered ? 0.35 : 0, 3, dt);
      const fl = this.flashes.get(i) ?? 0;
      v.flash = fl;
      if (fl > 0) this.flashes.set(i, Math.max(0, fl - dt * 0.8));
      v.beam = (phase === 'on' || phase === 'late' ? 0.035 + Math.min(1.5, w.workload) * 0.03 : 0.012) * (1 + v.focus * 0.6);
      v.size = (0.1 + v.focus * 0.06) * (v.billboard > 0.5 ? 1.4 : 1) * this.fx.globeScale ** (1 - v.billboard);

      if (bump < MAX_BUMPS && W[0] > 0.5 && (phase === 'on' || phase === 'late')) {
        bumps[bump++].set(this.geo[i].x, this.geo[i].y, this.geo[i].z, (0.5 + v.focus * 0.8 + fl) * (focusWriter && !focusWriter.has(w.id) ? 0.2 : 1));
      }
    });
    for (let i = bump; i < MAX_BUMPS; i++) bumps[i].set(0, 0, 0, 0);
    this.nodes.update(this.time, this.dpr * this.pxScale, this.camera.quaternion);
    this.nodes.glyphs.visible = this.nodes.cores.visible = this.nodes.beams.visible = reveal > 0.8;
  }

  /** People who should stay lit for the current focus, or null for everyone. */
  private focusedWriters(): Set<string> | null {
    const f = this.focus;
    if (!f || !this.world) return null;
    if (f.kind === 'writer') {
      const ids = new Set([f.id]);
      if (this.spec.nodes !== 'geo') {
        for (const l of this.world.links) { if (l.from === f.id) ids.add(l.to); if (l.to === f.id) ids.add(l.from); }
        for (const p of this.world.projects) if (!p.archived && p.writers.includes(f.id)) p.writers.forEach((x) => ids.add(x));
      }
      return ids;
    }
    if (f.kind === 'project') return new Set(this.projectById.get(f.id)?.writers ?? []);
    if (f.kind === 'client') return new Set(this.world.projects.filter((p) => p.clientId === f.id && !p.archived).flatMap((p) => p.writers));
    if (f.kind === 'anomaly') {
      const a = this.anomalyById.get(f.id);
      return a ? new Set([...(a.writerId ? [a.writerId] : []), ...a.sources]) : null;
    }
    if (f.kind === 'city') {
      const [lat, lon] = f.id.split(',').map(Number);
      return new Set(this.writers.filter((w) => Math.abs(w.lat - lat) < 1 && Math.abs(w.lon - lon) < 1).map((w) => w.id));
    }
    return null;
  }

  private updateArcs(dt: number) {
    const world = this.world;
    if (!world) return;
    const lit = this.lit;
    const pressure = this.pressurePairs;
    this.arcEnds.forEach(({ a, b, link, pair }, i) => {
      let base = link ? (link.active ? 0.2 : 0.06) : 0.03;
      let flow = link?.active ? 1 : 0;
      if (this.mode === 'signals') base = Math.max(base, 0.16);
      if (lit) { const on = lit.has(a) && lit.has(b) || (this.focus?.kind === 'writer' && (a === this.focus.id || b === this.focus.id)); base = on ? Math.max(base * 2.2, 0.26) : base * 0.12; flow = on ? 1 : 0; }
      if (this.filter === 'reviews') { const rev = link?.kind === 'review'; base = rev ? 0.3 : 0.02; flow = rev ? 1 : 0; }
      if (this.filter === 'pressure' || this.focus?.kind === 'anomaly') { const on = pressure.has(pair); if (on) { base = 0.32; flow = 1; } }
      this.arcs.target[i] = base;
      this.arcs.flow[i] = flow;
    });
    this.arcs.update(this.time, dt, this.dpr * this.pxScale, this.fx.arcs * clamp01(this.revealT * 3 - 2));
  }

  private updateOrbits(dt: number, reveal: number) {
    const specs = ORBITS[this.mode];
    const on = smoothstep(0.75, 1, reveal);
    const reduced = this.opts.reducedMotion;
    this.orbits.forEach((o, i) => {
      const [r, tilt, alpha, dash, ticks] = specs[i];
      const u = o.u;
      u.uRadius.value = damp(u.uRadius.value, r, reduced ? 10 : 1.8, dt);
      u.uExtent.value = orbitExtent(u.uRadius.value);
      u.uOpacity.value = damp(u.uOpacity.value, alpha * on * (this.focus && this.spec.nodes === 'geo' ? 0.5 : 1), 2.5, dt);
      u.uDash.value = dash;
      u.uTicks.value = ticks;
      u.uTime.value = this.time;
      u.uSpin.value = 0.1 + i * 0.04;
      this.tmpQ.setFromEuler(this.tmpE.set(...tilt));
      o.mesh.quaternion.slerp(this.tmpQ, 1 - Math.exp(-dt * (reduced ? 10 : 1.6)));
      o.mesh.visible = u.uOpacity.value > 0.002 && orbitReaches(u.uRadius.value, u.uExtent.value);
    });
    // the deadline bands and the dial
    this.bandField.material.uniforms.uOpacity.value = this.fx.bands * on;
    this.bandField.material.uniforms.uTime.value = this.time;
    this.bandField.material.uniforms.uHot.value = 1;
    this.bandField.mesh.visible = this.fx.bands > 0.003;
    this.dial.material.uniforms.uOpacity.value = this.fx.dial * on;
    this.dial.material.uniforms.uTime.value = this.time;
    this.dial.mesh.visible = this.fx.dial > 0.003;
    // the phase arc for an open project
    const pa = this.phaseArc.u;
    pa.uOpacity.value = this.fx.phase * 0.5;
    pa.uRadius.value = PHASE_R;
    pa.uFrom.value = PHASE_FROM;
    pa.uTo.value = PHASE_TO;
    pa.uTicks.value = 0;
    const proj = this.focus?.kind === 'project' ? this.projectById.get(this.focus.id) : null;
    if (proj) {
      const idx = phaseIndex(proj.stage);
      pa.uMark.value = phaseAngle((idx + 0.5) / 6);
      pa.uMarkOn.value = this.fx.phase * (0.7 + 0.3 * Math.sin(this.time * 3));
    } else pa.uMarkOn.value = 0;
    pa.uTime.value = this.time;
    this.phaseArc.mesh.position.set(0, PHASE_Y, PHASE_Z);
    this.phaseArc.mesh.visible = this.fx.phase > 0.003;
  }

  private phasePoint(u: number, out: Vector3): Vector3 {
    const a = phaseAngle(u);
    return out.set(Math.cos(a) * PHASE_R, Math.sin(a) * PHASE_R + PHASE_Y, PHASE_Z);
  }

  private updateObjects(dt: number, reveal: number) {
    if (!this.world) return;
    const s = this.spec;
    const live = this.world.projects.filter((p) => !p.archived).length;
    const f = this.focus;
    const on = smoothstep(0.85, 1, reveal);
    this.objects.update({
      time: this.time, dt, dpr: this.dpr * this.pxScale, weights: s.objects, missionQuat: this.missionQuat, missionRadius: 1.62 * this.fx.globeScale / 0.9,
      missionCount: live, bandQuat: this.bandQuat, bandScale: 1, space: this.space.matrixWorld, graph: this.graphGroup.matrixWorld,
      writerPos: (i) => this.nodes.vis[i]?.pos ?? null, reduced: this.opts.reducedMotion,
    }, (o: SpaceObject) => {
      const project = o.kind === 'project' ? this.projectById.get(o.id) : null;
      const archived = !!project?.archived;
      let a = 0;
      if (this.mode === 'missions') a = o.kind === 'project' && !archived ? 0.9 : 0;
      else if (this.mode === 'constellation') a = archived ? 0 : o.kind === 'project' ? 0.85 : 0.75;
      else if (this.mode === 'deadlines') a = o.kind === 'project' && !archived ? 0.8 : 0;
      else if (this.mode === 'galaxy') a = o.kind === 'project' ? (archived ? 0.25 : 0.7) : 0;
      else if (this.mode === 'archive') a = o.kind === 'project' ? (archived ? 0.8 : 0.1) : 0;
      if (f && a > 0) {
        const mine = (f.kind === 'project' && o.kind === 'project' && f.id === o.id) || (f.kind === 'client' && ((o.kind === 'client' && o.id === f.id) || project?.clientId === f.id))
          || (f.kind === 'writer' && !!project && project.writers.includes(f.id)) || (f.kind === 'writer' && o.kind === 'client' && this.world!.projects.some((p) => p.clientId === o.id && !p.archived && p.writers.includes(f.id)));
        a *= mine ? 1.3 : 0.15;
      }
      if (this.hover?.kind === o.kind && this.hover.id === o.id) a *= 1.3;
      return a * on;
    }, (e: Edge) => {
      let a = 0;
      if (this.mode === 'constellation') a = e.kind === 'works' ? 0.16 : e.kind === 'client' ? 0.2 : e.kind === 'review' ? 0.2 : 0.12;
      else if (this.mode === 'missions') a = e.kind === 'works' ? 0.06 : 0;
      if (a && f) {
        const ends = [e.a, e.b].map((r) => ('writer' in r ? { kind: 'writer', id: this.writers[r.writer]?.id } : { kind: this.objects.objects[r.obj]?.kind, id: this.objects.objects[r.obj]?.id }));
        const touches = ends.some((x) => x.kind === f.kind && x.id === f.id);
        const clientProject = f.kind === 'client' && ends.some((x) => x.kind === 'project' && this.projectById.get(x.id ?? '')?.clientId === f.id);
        const writerProject = f.kind === 'writer' && ends.some((x) => x.kind === 'project' && this.projectById.get(x.id ?? '')?.writers.includes(f.id));
        a = touches || clientProject || (writerProject && e.kind !== 'works') ? Math.max(0.45, a * 3) : a * 0.12;
        if (this.mode === 'missions' && f.kind === 'project') a = touches ? 0.4 : 0;
      }
      return a * on;
    });
  }

  private updateSwarm(dt: number, reveal: number) {
    if (!this.world) return;
    const f = this.focus;
    const lit = this.lit;
    const phaseOpen = this.focus?.kind === 'project' && this.mode === 'missions' ? this.focus.id : null;
    const on = smoothstep(0.88, 1, reveal);
    this.swarm.archiveOpacity = this.fx.archive * 0.14 * on;
    this.swarm.update({
      time: this.time, dt, dpr: this.dpr * this.pxScale, weights: this.spec.scripts,
      node: (i) => this.nodes.vis[i] ?? null,
      mission: (id, out) => { const i = this.projectObj.get(id); const o = i != null ? this.objects.objects[i] : null; return o && o.missionIndex >= 0 ? out.copy(o.pos) : null; },
      phase: (id, u, out) => (phaseOpen === id ? this.phasePoint(u, out) : null),
      graph: (id, out) => { const i = this.projectObj.get(id); const o = i != null ? this.objects.objects[i] : null; return o?.graphPos ? out.copy(o.pos) : null; },
      bandQuat: this.bandQuat, bandScale: 1, space: this.space.matrixWorld, reduced: this.opts.reducedMotion,
    }, (b: ScriptBody) => {
      const st = b.script.state;
      const done = st === 'delivered';
      let a: number;
      switch (this.mode) {
        case 'galaxy': a = b.archived ? 0.3 : done ? 0.4 : st === 'approved' ? 0.55 : 0.95; break;
        case 'archive': a = b.archived || done ? 0.75 : 0.12; break;
        case 'deadlines': a = b.archived || done || st === 'approved' ? 0 : 0.85; break;
        case 'constellation': a = b.archived || done ? 0 : 0.35; break;
        case 'missions': a = b.archived || done ? 0 : phaseOpen ? (b.script.projectId === phaseOpen ? 1 : 0.06) : 0.55; break;
        default: {
          // on the globe: live work orbits its writer; finished work has gone to the archive
          const recent = done && Date.now() - b.updatedMs < 6 * 3_600_000;
          a = b.archived ? 0 : done ? (recent ? 0.35 : 0) : st === 'approved' ? 0.3 : b.writer < 0 ? 0 : 0.85;
          const p = b.writer >= 0 ? this.presence[b.writer] : null;
          if (p && p.phase === 'off') a *= 0.45;
        }
      }
      if (lit && this.spec.nodes === 'geo' && this.mode !== 'missions') {
        const mine = (b.script.writerId && lit.has(b.script.writerId)) || (f?.kind === 'project' && b.script.projectId === f.id);
        a *= mine ? 1.2 : 0.1;
      }
      if (this.filter === 'reviews') a *= st === 'internal_review' ? 1.2 : 0.2;
      return a * on;
    });
  }

  // ── anchors: DOM labels pinned to places in space ─────────────────────

  private anchorPos(kind: string, id: string, out: Vector3): number | null {
    switch (kind) {
      case 'w': {
        const i = this.writerIndex.get(id);
        if (i == null) return null;
        const v = this.nodes.vis[i];
        out.copy(v.pos);
        return v.billboard > 0.5 ? v.intensity : Math.min(1, Math.max(0, (v.facing - 0.08) / 0.2)) * Math.min(1, v.intensity * 1.6);
      }
      case 'p': case 'c': {
        const i = this.objIndex.get(`${kind === 'p' ? 'project' : 'client'}:${id}`);
        if (i == null) return null;
        const o = this.objects.objects[i];
        out.copy(o.pos);
        return Math.min(1, o.alpha * 1.3);
      }
      case 'a': {
        const a = this.anomalyById.get(id);
        if (!a) return null;
        if (a.writerId) return this.anchorPos('w', a.writerId, out);
        if (a.at) return this.geoAnchor(a.at.lat, a.at.lon, out);
        return null;
      }
      case 'geo': {
        const [lat, lon] = id.split(',').map(Number);
        return this.geoAnchor(lat, lon, out);
      }
      case 'band': {
        const [lo, hi] = ({ '24H': [1.26, 1.44], '48H': [1.52, 1.7], '7D': [1.82, 2.16], '30D': [2.3, 2.85] } as Record<string, number[]>)[id] ?? [0, 0];
        // down the front-right of the orbits, so the four labels stack instead of bunching up
        out.set(Math.cos(-0.62) * (lo + hi) / 2, Math.sin(-0.62) * (lo + hi) / 2, 0).applyQuaternion(this.bandQuat);
        return this.fx.bands;
      }
      case 'dial': {
        const h = Number(id);
        const nowH = this.dial.material.uniforms.uNowH.value as number;
        const rel = ((((h - nowH) % 24) + 24) % 24) / 24;
        const a = rel * Math.PI * 2 - Math.PI / 2;
        const r = DIAL.inner + Math.min(MAX_LANES, this.writers.length) * DIAL.lane + 0.16;
        out.set(Math.cos(a) * r, Math.sin(a) * r, 0).applyQuaternion(this.dialQuat);
        return this.fx.dial * (out.z > -0.3 ? 1 : 0.35);
      }
      case 'phase': {
        const i = Number(id);
        this.phasePoint((i + 0.5) / 6, out);
        out.y += 0.12;
        return this.fx.phase;
      }
      case 'packet': {
        const route = this.handoffArc.get(id);
        if (!route || !this.arcs.packetPosition(route.arc, this.time, out)) return null;
        out.applyMatrix4(this.globe.matrixWorld);
        return this.fx.arcs > 0.05 ? 1 : 0;
      }
      case 's': {
        const b = this.swarm.byId.get(id);
        if (!b) return null;
        out.copy(b.pos);
        return b.alpha;
      }
      default:
        return null;
    }
  }

  private geoAnchor(lat: number, lon: number, out: Vector3): number {
    geoToVec3(lat, lon, 1, out).applyMatrix4(this.globe.matrixWorld);
    const c = this.tmp2.setFromMatrixPosition(this.globe.matrixWorld);
    const n = this.nrm.subVectors(out, c).normalize();
    const facing = n.dot(this.tmp3.subVectors(this.camera.position, out).normalize());
    return Math.min(1, Math.max(0, (facing - 0.08) / 0.2)) * (this.spec.nodes === 'geo' ? 1 : 0);
  }

  /** 1 in front of the planet, fading to nearly nothing behind it. */
  private occlusion(p: Vector3): number {
    if (this.fx.globeScale < 0.5) return 1;
    const c = this.tmp2.setFromMatrixPosition(this.globe.matrixWorld);
    const r = this.fx.globeScale;
    const o = this.camera.position;
    const d = this.tmp3.subVectors(p, o);
    const len = d.length();
    d.multiplyScalar(1 / len);
    const oc = this.tmp4.subVectors(o, c);
    const b = oc.dot(d);
    const disc = b * b - (oc.lengthSq() - r * r);
    if (disc <= 0) return 1;
    const hit = -b - Math.sqrt(disc);
    if (hit <= 0 || hit >= len) return 1;
    // how deep behind the limb it is: labels near the horizon fade rather than pop
    return Math.max(0.06, 1 - Math.min(1, Math.sqrt(disc) / (r * 0.25)));
  }

  private writeAnchors() {
    const p = this.anchorP;
    for (const b of this.bindings) {
      let vis = this.anchorPos(b.kind, b.id, p);
      if (vis != null && b.kind !== 'w' && b.kind !== 'geo' && !(b.kind === 'a' && this.anomalyById.get(b.id)?.writerId)) vis *= this.occlusion(p);
      if (vis == null) { this.setVis(b, 0); continue; }
      p.project(this.camera);
      const v = p.z > 1 ? 0 : Math.max(0, Math.min(1, vis));
      // a hidden label isn't drawn: it's placed again the frame it shows
      if (v >= LABEL_SHOWN) {
        const x = (p.x * 0.5 + 0.5) * this.width;
        const y = (-p.y * 0.5 + 0.5) * this.height;
        b.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      }
      this.setVis(b, v);
    }
  }

  private setVis(b: Binding, v: number) {
    const s = v.toFixed(3);
    if (b.vis === s) return;
    b.vis = s;
    // opacity, not an inherited custom property: changing one restyles the label itself, not everything inside it
    b.el.style.opacity = s;
    const off = v < LABEL_SHOWN ? '1' : '';
    if (b.el.dataset.off !== off) b.el.dataset.off = off;
  }

  // ── input ──────────────────────────────────────────────────────────────

  private pick(clientX: number, clientY: number): Target | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    const radius = matchMedia('(pointer: coarse)').matches ? 34 : 22;
    let best: Target | null = null;
    let bestD = radius * radius;
    const p = new Vector3();
    const test = (target: Target, pos: Vector3, vis: number) => {
      if (vis < 0.2) return;
      p.copy(pos).project(this.camera);
      if (p.z > 1) return;
      const dx = (p.x * 0.5 + 0.5) * this.width - x, dy = (-p.y * 0.5 + 0.5) * this.height - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = target; }
    };
    this.writers.forEach((w, i) => {
      const v = this.nodes.vis[i];
      const seen = v.billboard > 0.5 ? 1 : v.facing > 0.08 ? 1 : 0;
      test({ kind: 'writer', id: w.id }, v.pos, seen * Math.max(0.25, v.intensity));
    });
    for (const o of this.objects.objects) test({ kind: o.kind, id: o.id }, o.pos, o.alpha);
    return best;
  }

  private updatePointer() {
    // where the pointer touches the planet, for the particles and the coordinates readout
    const su = this.surface.material.uniforms;
    if (!this.pointerIn || this.spec.nodes !== 'geo') {
      su.uPointerOn.value = damp(su.uPointerOn.value, 0, 4, 0.016);
      return;
    }
    this.ray.setFromCamera(this.pointer, this.camera);
    const inv = this.tmpM.copy(this.globe.matrixWorld).invert();
    const o = this.ray.ray.origin.clone().applyMatrix4(inv);
    const d = this.ray.ray.direction.clone().transformDirection(inv);
    const hit = new Vector3();
    const sphere = new Sphere(new Vector3(), 1);
    const r = this.ray.ray.clone().set(o, d).intersectSphere(sphere, hit);
    if (r) {
      su.uPointer.value.copy(hit.normalize());
      su.uPointerOn.value = damp(su.uPointerOn.value, 1, 6, 0.016);
      this.opts.onPointerGeo?.(vec3ToGeo(hit));
    } else {
      su.uPointerOn.value = damp(su.uPointerOn.value, 0, 4, 0.016);
      this.opts.onPointerGeo?.(null);
    }
  }

  private setPointer(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.pointerIn = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
  }

  private onDown = (e: PointerEvent) => {
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.touches.size === 2) {
      const [a, b] = [...this.touches.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.rig.zoom };
      this.drag = null;
      return;
    }
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, t: performance.now() };
    this.lastInteraction = this.time;
    this.renderer.domElement.setPointerCapture?.(e.pointerId);
  };

  private onMove = (e: PointerEvent) => {
    this.setPointer(e);
    if (this.touches.has(e.pointerId)) this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pinch && this.touches.size === 2) {
      const [a, b] = [...this.touches.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      this.rig.zoom = Math.min(1.7, Math.max(0.5, this.pinch.zoom * (this.pinch.d / Math.max(1, d))));
      return;
    }
    const drag = this.drag;
    if (drag && drag.id === e.pointerId) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > 4) {
        drag.moved = true;
        this.tween = null;
        this.renderer.domElement.style.cursor = 'grabbing';
      }
      if (drag.moved) {
        const dtm = Math.max(8, performance.now() - drag.t) / 1000;
        const k = (1.6 / this.height) * (this.rig.dist / 6);
        if (this.spec.nodes === 'geo') {
          this.rig.yaw += dx * k * 2.2;
          this.rig.pitch = Math.max(-1.1, Math.min(1.1, this.rig.pitch + dy * k * 2.2));
          this.vel.yaw = (dx * k * 2.2) / dtm;
          this.vel.pitch = (dy * k * 2.2) / dtm;
        } else {
          this.spaceRot.yaw += dx * 0.004;
          this.spaceRot.pitch = Math.max(-0.8, Math.min(0.8, this.spaceRot.pitch + dy * 0.003));
          this.spaceRot.vy = (dx * 0.004) / dtm;
          this.spaceRot.vp = (dy * 0.003) / dtm;
        }
        drag.x = e.clientX;
        drag.y = e.clientY;
        drag.t = performance.now();
        this.lastInteraction = this.time;
      }
      return;
    }
    if (e.target === this.renderer.domElement) {
      const t = this.pick(e.clientX, e.clientY);
      if (t?.kind !== this.hover?.kind || t?.id !== this.hover?.id) {
        this.hover = t;
        this.opts.onHover?.(t);
        this.renderer.domElement.style.cursor = t ? 'pointer' : 'grab';
      }
    }
  };

  private onUp = (e: PointerEvent) => {
    this.touches.delete(e.pointerId);
    if (this.touches.size < 2) this.pinch = null;
    const drag = this.drag;
    if (!drag || drag.id !== e.pointerId) return;
    this.drag = null;
    this.renderer.domElement.style.cursor = this.hover ? 'pointer' : 'grab';
    if (!drag.moved && e.type === 'pointerup') {
      const t = this.pick(e.clientX, e.clientY);
      this.opts.onSelect?.(t);
    }
    if (performance.now() - drag.t > 90) { this.vel.yaw = 0; this.vel.pitch = 0; }
  };

  private onLeave = () => {
    this.pointerIn = false;
    if (this.hover) { this.hover = null; this.opts.onHover?.(null); }
    this.opts.onPointerGeo?.(null);
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.lastInteraction = this.time;
    const before = this.rig.zoom;
    this.rig.zoom = Math.min(1.7, Math.max(0.5, this.rig.zoom * Math.exp(e.deltaY * 0.0011)));
    // keep scrolling past the limits to move between layers
    if (this.rig.zoom === before) {
      this.overscroll += e.deltaY;
      if (Math.abs(this.overscroll) > 260) {
        this.opts.onOverscroll?.(this.overscroll > 0 ? 'out' : 'in');
        this.overscroll = 0;
      }
    } else this.overscroll = 0;
  };

  private onVisibility = () => {
    if (document.hidden) this.stop();
    else this.start();
  };

  private onContextLost = (e: Event) => {
    e.preventDefault();
    this.stop();
    // static buffers have let go of their CPU copies, so this engine can't redraw on a restored
    // context: the owner rebuilds the view instead
    this.opts.onContextLost?.();
  };

  private get portrait() {
    return this.width / this.height < 0.8;
  }

  private resize() {
    const r = this.host.getBoundingClientRect();
    const was = this.portrait;
    this.width = Math.max(1, r.width);
    this.height = Math.max(1, r.height);
    if (was !== this.portrait) setTimeout(() => this.retarget(0.6), 0);
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.pxScale = Math.min(1.5, Math.max(0.6, Math.min(this.width, this.height * 1.4) / 1000));
  }

  /** If frames drop, spend fewer pixels, then fewer particles. */
  private watchPerformance() {
    if (this.revealing || this.load.length < 60) return;
    if (!this.watchUntil) { this.watchUntil = this.time + 3; return; }
    if (this.time < this.watchUntil) return;
    const sorted = this.load.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    this.opts.onStats?.(this.stats);
    this.watchUntil = this.time + 3;
    if (median < 30 || this.downgrades > 4) return;
    this.downgrades++;
    this.load.length = 0;
    if (this.dpr > 1) {
      this.dpr = Math.max(1, this.dpr * 0.75);
      this.renderer.setPixelRatio(this.dpr);
      this.resize();
      return;
    }
    const next = lower(this.tier);
    if (!next) return;
    this.tier = next;
    const fresh = buildSurfacePoints(TIERS[next].sphere, TIERS[next].dot);
    fresh.material.uniforms.uBumps.value = this.surface.material.uniforms.uBumps.value;
    this.globe.remove(this.surface.points);
    this.surface.points.geometry.dispose();
    this.surface.material.dispose();
    this.surface = fresh;
    this.globe.add(fresh.points);
  }
}

// the phase arc: RESEARCH on the left, DELIVERY on the right, over the top of the planet
const PHASE_FROM = 0.3;
const PHASE_TO = Math.PI - 0.3;
const PHASE_R = 1.28;
const PHASE_Y = -0.02;
const PHASE_Z = 0.35;
const phaseAngle = (u: number) => PHASE_TO - u * (PHASE_TO - PHASE_FROM);

function phaseIndex(stage: string): number {
  return stage === 'research' || stage === 'concept' ? 0 : stage === 'writing' ? 1 : stage === 'internal_review' ? 2 : stage === 'revision' ? 3 : stage === 'client_review' ? 4 : 5;
}
