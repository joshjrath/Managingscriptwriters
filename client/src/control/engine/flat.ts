// The Control Center without WebGL: the same globe drawn on a 2D canvas as an
// orthographic projection of the particle geography, with the real terminator,
// the writers, their arcs and handoffs. Other modes keep this view and let
// the typography carry them.

import { anomaliesOf, presenceOf, subsolarPoint, type Anomaly, type CcHandoff, type ControlWorld } from '../../../../shared/control';
import { isLand, landMask } from './landmask';
import { clamp01, DEG, easeInOutCubic, mulberry, wrapAngle } from './math';
import type { EngineStats, Filter, Focus, Mode, Target } from './Engine';
import type { WorldView } from './view';

interface Opts {
  reducedMotion: boolean;
  onSelect?: (t: Target | null) => void;
  onHover?: (t: Target | null) => void;
  onArrive?: (h: CcHandoff) => void;
  onReveal?: (p: number) => void;
  /** after each drawn frame, with its time (for anything that should move in step with the view) */
  onFrame?: (ms: number) => void;
}

type V3 = [number, number, number];
const geo = (lat: number, lon: number): V3 => [Math.cos(lat * DEG) * Math.sin(lon * DEG), Math.sin(lat * DEG), Math.cos(lat * DEG) * Math.cos(lon * DEG)];

export class FlatView implements WorldView {
  readonly flat = true;
  mode: Mode = 'world';
  focus: Focus = null;
  private filter: Filter = null;
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private opts: Opts;
  private world: ControlWorld | null = null;
  private land: V3[] = [];
  private yaw = 0;
  private pitch = 0.3;
  private goal: { yaw: number; pitch: number; start: number; from: { yaw: number; pitch: number } } | null = null;
  private zoom = 1;
  private raf = 0;
  private running = false;
  private t0 = performance.now();
  private last = 0;
  private revealStart = -1;
  private bindings = new Set<{ key: string; el: HTMLElement; vis?: string }>();
  /** land colours by their rounded channels: the same few hundred strings every frame */
  private rgb = new Map<number, string>();
  /** who is on shift, worked out once a second like the WebGL view does */
  private presence: boolean[] = [];
  private presenceAt = -Infinity;
  private packets: { from: number; to: number; start: number; h: CcHandoff }[] = [];
  private offset = 0;
  private anomalies: Anomaly[] = [];
  private drag: { x: number; y: number; moved: boolean } | null = null;
  private screen = new Map<string, { x: number; y: number; vis: number }>();
  private w = 1;
  private h = 1;

  constructor(canvas: HTMLCanvasElement, opts: Opts) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d canvas');
    this.ctx = ctx;
    this.canvas = canvas;
    this.opts = opts;
    const mask = landMask();
    const rand = mulberry(3);
    const n = 26000;
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
      const y = 1 - ((i + 0.5) / n) * 2;
      const r = Math.sqrt(1 - y * y);
      const th = i * golden + rand() * 0.002;
      const p: V3 = [Math.cos(th) * r, y, Math.sin(th) * r];
      if (isLand(mask, Math.asin(p[1]) / DEG, Math.atan2(p[0], p[2]) / DEG)) this.land.push(p);
    }
    canvas.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  private onVisibility = () => { if (document.hidden) this.stop(); else this.start(); };

  get stats(): EngineStats { return { fps: 60, tier: 'low', dpr: 1, particles: this.land.length, land: this.land.length }; }
  get currentAnomalies() { return this.anomalies; }
  get timeOffset() { return this.offset; }
  now() { return new Date(Date.now() + this.offset); }
  setTimeOffset(ms: number) { this.offset = ms; this.presenceAt = -Infinity; }
  setFilter(f: Filter) { this.filter = f; }
  zoomBy(f: number) { this.zoom = Math.min(1.5, Math.max(0.7, this.zoom / f)); }
  nudge(yaw: number, pitch: number) { this.yaw += yaw; this.pitch = Math.max(-1, Math.min(1, this.pitch + pitch)); }

  setWorld(world: ControlWorld) {
    const first = !this.world;
    this.world = world;
    this.presenceAt = -Infinity;
    this.anomalies = anomaliesOf(world, this.now());
    if (first && world.writers.length) {
      const lon = Math.atan2(world.writers.reduce((a, w) => a + Math.sin(w.lon * DEG), 0), world.writers.reduce((a, w) => a + Math.cos(w.lon * DEG), 0));
      this.yaw = -lon;
    }
  }

  setMode(mode: Mode) { this.mode = mode; }

  setFocus(focus: Focus) {
    this.focus = focus;
    const w = focus?.kind === 'writer' ? this.world?.writers.find((x) => x.id === focus.id) : null;
    if (w) this.turnTo(w.lat, w.lon);
  }

  focusGeo(lat: number, lon: number) {
    this.focus = { kind: 'city', id: `${lat},${lon}` };
    this.turnTo(lat, lon);
  }

  private turnTo(lat: number, lon: number) {
    this.goal = { yaw: this.yaw + wrapAngle(-lon * DEG - this.yaw), pitch: lat * DEG * 0.8, start: performance.now(), from: { yaw: this.yaw, pitch: this.pitch } };
  }

  bind(key: string, el: HTMLElement): () => void {
    const b = { key, el };
    this.bindings.add(b);
    return () => { this.bindings.delete(b); };
  }

  playHandoff(h: CcHandoff) {
    const ws = this.world?.writers ?? [];
    const from = ws.findIndex((w) => w.id === h.originNode), to = ws.findIndex((w) => w.id === h.destinationNode);
    if (from < 0 || to < 0) return false;
    this.packets.push({ from, to, start: performance.now(), h });
    return true;
  }

  reveal() { this.revealStart = performance.now(); this.start(); }
  start() { if (!this.running) { this.running = true; this.raf = requestAnimationFrame(this.draw); } }
  stop() { this.running = false; cancelAnimationFrame(this.raf); }

  dispose() {
    this.stop();
    this.canvas.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  // ── drawing ────────────────────────────────────────────────────────────

  private rot(p: V3): V3 {
    const [x, y, z] = p;
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
    return [x1, y * cp - z1 * sp, y * sp + z1 * cp];
  }

  private draw = (ms: number) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.draw);
    // drawn on the CPU, so only as often as needed: 30 fps unless something is moving, 15 in a window in the back
    const busy = !!this.drag || !!this.goal || this.packets.length > 0 || (this.revealStart >= 0 && ms - this.revealStart < 2000);
    const interval = !document.hasFocus() ? 1000 / 15 : busy ? 1000 / 60 : 1000 / 30;
    if (ms - this.last < interval - 3) return;
    const dt = Math.min(0.1, (ms - (this.last || ms)) / 1000);
    this.last = ms;
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width * dpr !== this.canvas.width || rect.height * dpr !== this.canvas.height) {
      this.canvas.width = rect.width * dpr;
      this.canvas.height = rect.height * dpr;
    }
    this.w = rect.width;
    this.h = rect.height;
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const t = (ms - this.t0) / 1000;
    const reveal = this.revealStart < 0 ? 0 : clamp01((ms - this.revealStart) / (this.opts.reducedMotion ? 600 : 1800));
    this.opts.onReveal?.(reveal);
    if (this.goal) {
      const p = clamp01((ms - this.goal.start) / 1400);
      const e = easeInOutCubic(p);
      this.yaw = this.goal.from.yaw + (this.goal.yaw - this.goal.from.yaw) * e;
      this.pitch = this.goal.from.pitch + (this.goal.pitch - this.goal.from.pitch) * e;
      if (p >= 1) this.goal = null;
    } else if (!this.drag && !this.focus && !this.opts.reducedMotion) this.yaw += 0.15 * dt;

    const R = Math.min(this.w, this.h) * (this.w < this.h ? 0.43 : 0.32) * this.zoom * (this.focus ? 1.25 : 1);
    const cx = this.w / 2 - (this.focus ? this.w * 0.1 : 0), cy = this.h / 2;
    const sun = subsolarPoint(this.now());
    const s = this.rot(geo(sun.lat, sun.lon));
    ctx.globalAlpha = reveal;

    // atmosphere and the dark disc
    const halo = ctx.createRadialGradient(cx, cy, R * 0.98, cx, cy, R * 1.18);
    halo.addColorStop(0, 'rgba(90,150,255,0.28)');
    halo.addColorStop(1, 'rgba(90,150,255,0)');
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.18, 0, Math.PI * 2); ctx.fill();
    const disc = ctx.createRadialGradient(cx + s[0] * R * 0.5, cy - s[1] * R * 0.5, R * 0.1, cx, cy, R);
    disc.addColorStop(0, '#0b1426');
    disc.addColorStop(1, '#03050b');
    ctx.fillStyle = disc;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();

    // land, lit by the real sun
    const sv = geo(sun.lat, sun.lon);
    const dot = Math.max(1.2, R / 260);
    // (the rotation is rot() inlined, and the colour is cached and its alpha set separately:
    // building and parsing a fresh rgba() string for every dot on every frame was most of the cost)
    const cyaw = Math.cos(this.yaw), syaw = Math.sin(this.yaw), cpit = Math.cos(this.pitch), spit = Math.sin(this.pitch);
    for (const p of this.land) {
      const z1 = -p[0] * syaw + p[2] * cyaw;
      const qz = p[1] * spit + z1 * cpit;
      if (qz <= 0) continue;
      const qx = p[0] * cyaw + p[2] * syaw, qy = p[1] * cpit - z1 * spit;
      const day = clamp01((p[0] * sv[0] + p[1] * sv[1] + p[2] * sv[2] + 0.1) / 0.4);
      const r = Math.round(92 + 118 * day), g = Math.round(110 + 115 * day), b = Math.round(225 + 30 * day);
      const key = (r << 16) | (g << 8) | b;
      let rgb = this.rgb.get(key);
      if (!rgb) { rgb = `rgb(${r},${g},${b})`; this.rgb.set(key, rgb); }
      ctx.globalAlpha = reveal * (0.42 + 0.5 * day) * (0.45 + 0.55 * qz);
      ctx.fillStyle = rgb;
      ctx.fillRect(cx + qx * R - dot / 2, cy - qy * R - dot / 2, dot, dot);
    }
    ctx.globalAlpha = reveal;

    // arcs and packets
    const ws = this.world?.writers ?? [];
    const pts = ws.map((w) => this.rot(geo(w.lat, w.lon)));
    const lift = (a: V3, b: V3, u: number): V3 => {
      const m: V3 = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
      const len = Math.hypot(...m) || 1;
      const k = (1 + 0.25 * Math.sin(Math.PI * u)) / len;
      return [m[0] * k, m[1] * k, m[2] * k];
    };
    ctx.lineWidth = 1;
    for (const l of this.world?.links ?? []) {
      const a = ws.findIndex((w) => w.id === l.from), b = ws.findIndex((w) => w.id === l.to);
      if (a < 0 || b < 0) continue;
      ctx.strokeStyle = `rgba(160,190,255,${l.active ? 0.22 : 0.07})`;
      ctx.beginPath();
      // only the part of the arc on this side of the planet
      let pen = false;
      for (let i = 0; i <= 32; i++) {
        const p = lift(pts[a], pts[b], i / 32);
        const seen = p[2] > 0 || Math.hypot(p[0], p[1]) > 1;
        if (!seen) { pen = false; continue; }
        if (!pen) ctx.moveTo(cx + p[0] * R, cy - p[1] * R); else ctx.lineTo(cx + p[0] * R, cy - p[1] * R);
        pen = true;
      }
      ctx.stroke();
    }
    this.packets = this.packets.filter((pk) => {
      const u = (ms - pk.start) / (this.opts.reducedMotion ? 800 : 2600);
      if (u >= 1) { this.opts.onArrive?.(pk.h); return false; }
      const p = lift(pts[pk.from], pts[pk.to], easeInOutCubic(u));
      ctx.fillStyle = 'rgba(220,235,255,0.95)';
      ctx.beginPath(); ctx.arc(cx + p[0] * R, cy - p[1] * R, 2.4, 0, Math.PI * 2); ctx.fill();
      return true;
    });

    // people
    this.screen.clear();
    if (ms - this.presenceAt > 1000 || this.presence.length !== ws.length) {
      const now = this.now();
      this.presence = ws.map((w) => { const ph = presenceOf(w, now).phase; return ph === 'on' || ph === 'late'; });
      this.presenceAt = ms;
    }
    ws.forEach((w, i) => {
      const q = pts[i];
      const on = this.presence[i];
      const vis = clamp01((q[2] - 0.05) / 0.2);
      const x = cx + q[0] * R, y = cy - q[1] * R;
      this.screen.set(`w:${w.id}`, { x, y, vis: vis * (on ? 1 : 0.5) });
      if (vis <= 0) return;
      const lit = !this.focus || (this.focus.kind === 'writer' && this.focus.id === w.id);
      const a = vis * (on ? 1 : 0.4) * (lit ? 1 : 0.25) * (this.filter === 'online' && !on ? 0.3 : 1);
      ctx.fillStyle = `rgba(200,225,255,${a})`;
      ctx.beginPath(); ctx.arc(x, y, 2.6, 0, Math.PI * 2); ctx.fill();
      if (on) {
        const pulse = (t / 2.6 + i * 0.3) % 1;
        ctx.strokeStyle = `rgba(160,200,255,${a * (1 - pulse) * 0.7})`;
        ctx.beginPath(); ctx.arc(x, y, 3 + pulse * 16, 0, Math.PI * 2); ctx.stroke();
      }
    });
    for (const an of this.anomalies) {
      if (an.writerId) { const p = this.screen.get(`w:${an.writerId}`); if (p) this.screen.set(`a:${an.id}`, p); }
      else if (an.at) {
        const q = this.rot(geo(an.at.lat, an.at.lon));
        this.screen.set(`a:${an.id}`, { x: cx + q[0] * R, y: cy - q[1] * R, vis: clamp01((q[2] - 0.05) / 0.2) });
      }
    }
    ctx.globalAlpha = 1;
    for (const b of this.bindings) {
      const p = this.screen.get(b.key);
      if (!p) { this.setVis(b, '0', '1'); continue; }
      b.el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
      this.setVis(b, (p.vis * reveal).toFixed(3), p.vis * reveal < 0.05 ? '1' : '');
    }
    this.opts.onFrame?.(ms);
  };

  /** A label's fade, written only when it changes (as opacity: it restyles the label alone, not all inside it). */
  private setVis(b: { el: HTMLElement; vis?: string }, vis: string, off: string) {
    if (b.vis !== vis) { b.vis = vis; b.el.style.opacity = vis; }
    if (b.el.dataset.off !== off) b.el.dataset.off = off;
  }

  private pick(x: number, y: number): Target | null {
    const r = this.canvas.getBoundingClientRect();
    let best: Target | null = null, bestD = 26 * 26;
    for (const [key, p] of this.screen) {
      if (!key.startsWith('w:') || p.vis < 0.2) continue;
      const d = (p.x - (x - r.left)) ** 2 + (p.y - (y - r.top)) ** 2;
      if (d < bestD) { bestD = d; best = { kind: 'writer', id: key.slice(2) }; }
    }
    return best;
  }

  private onDown = (e: PointerEvent) => { this.drag = { x: e.clientX, y: e.clientY, moved: false }; };
  private onMove = (e: PointerEvent) => {
    if (!this.drag) { if (e.target === this.canvas) this.opts.onHover?.(this.pick(e.clientX, e.clientY)); return; }
    const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
    if (Math.hypot(dx, dy) > 4) this.drag.moved = true;
    if (this.drag.moved) {
      this.goal = null;
      this.yaw += dx * 0.006;
      this.pitch = Math.max(-1, Math.min(1, this.pitch + dy * 0.006));
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
    }
  };
  private onUp = (e: PointerEvent) => {
    if (this.drag && !this.drag.moved) this.opts.onSelect?.(this.pick(e.clientX, e.clientY));
    this.drag = null;
  };
}
