// Relationships between people as arcs that wrap the planet (never straight
// through it), and handoffs as packets of light that travel them. Everything
// here lives in the globe's own space, so it turns with the Earth.

import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, DynamicDrawUsage, Group, LineSegments, Points, ShaderMaterial,
  Vector3, Vector4,
} from 'three';
import { markUsed } from './buffers';
import { arcHeight, arcPoint, easeInOutCubic } from './math';

export const MAX_ARCS = 64;
const SEGMENTS = 72;

export interface ArcDef {
  key: string;
  from: Vector3;
  to: Vector3;
  color: Color;
}

interface Packet {
  arc: number;
  /** the arc's key, so the packet keeps to its arc when the arcs are rebuilt */
  key: string;
  reverse: boolean;
  start: number;
  duration: number;
  done: boolean;
  onArrive?: () => void;
  /** dropped before it landed */
  onCancel?: () => void;
}

export class ArcsLayer {
  group = new Group();
  private lines: LineSegments;
  private material: ShaderMaterial;
  private defs: ArcDef[] = [];
  private index = new Map<string, number>();
  private heights: number[] = [];
  /** per arc: base opacity (current, target) and highlight */
  base: Float32Array = new Float32Array(MAX_ARCS);
  target: Float32Array = new Float32Array(MAX_ARCS);
  highlight: Float32Array = new Float32Array(MAX_ARCS);
  flow: Float32Array = new Float32Array(MAX_ARCS);
  private packets: Packet[] = [];
  private sig = '';
  private packetPoints: Points;
  private packetPos: BufferAttribute;
  private packetCol: BufferAttribute;
  private tmp = new Vector3();

  constructor() {
    this.material = new ShaderMaterial({
      uniforms: {
        uArcs: { value: Array.from({ length: MAX_ARCS }, () => new Vector4(0, -1, 0.2, 0)) },
        uColors: { value: Array.from({ length: MAX_ARCS }, () => new Color(0.6, 0.8, 1)) },
        uTime: { value: 0 },
        uOpacity: { value: 1 },
      },
      vertexShader: /* glsl */ `
        attribute float aT;
        attribute float aArc;
        varying float vT;
        varying float vArc;
        varying float vFacing;
        void main() {
          vT = aT;
          vArc = aArc;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vFacing = dot(normalize(normalMatrix * normalize(position)), normalize(-mv.xyz));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec4 uArcs[${MAX_ARCS}];
        uniform vec3 uColors[${MAX_ARCS}];
        uniform float uTime;
        uniform float uOpacity;
        varying float vT;
        varying float vArc;
        varying float vFacing;
        void main() {
          int i = int(vArc + 0.5);
          vec4 s = uArcs[i];
          float base = s.x;
          float head = s.y;
          float trail = abs(s.z);
          float t = s.z < 0.0 ? 1.0 - vT : vT;
          // fade the ends into the nodes, and dim what is behind the horizon
          float ends = smoothstep(0.0, 0.08, vT) * smoothstep(1.0, 0.92, vT);
          float a = base * (0.55 + 0.45 * ends);
          // active relationships carry a slow flow of dashes
          a += s.w * step(0.72, fract(t * 26.0 - uTime * 0.6)) * 0.35 * ends;
          if (head >= 0.0) {
            float d = head - t;
            float tail = d >= 0.0 && d < trail ? pow(1.0 - d / trail, 2.2) : 0.0;
            float tip = exp(-d * d * 2500.0);
            a += tail * 1.1 + tip * 1.4;
          }
          a *= uOpacity * mix(0.35, 1.0, smoothstep(-0.25, 0.2, vFacing));
          if (a < 0.003) discard;
          gl_FragColor = vec4(uColors[i], a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.lines = new LineSegments(new BufferGeometry(), this.material);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 5;
    this.group.add(this.lines);

    const pg = new BufferGeometry();
    this.packetPos = new BufferAttribute(new Float32Array(24 * 3), 3).setUsage(DynamicDrawUsage);
    this.packetCol = new BufferAttribute(new Float32Array(24 * 4), 4).setUsage(DynamicDrawUsage);
    pg.setAttribute('position', this.packetPos);
    pg.setAttribute('aColor', this.packetCol);
    this.packetPoints = new Points(pg, new ShaderMaterial({
      uniforms: { uDpr: { value: 1 } },
      vertexShader: /* glsl */ `
        uniform float uDpr;
        attribute vec4 aColor;
        varying vec4 vColor;
        void main() {
          vColor = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = 44.0 * uDpr / -mv.z;
        }`,
      fragmentShader: /* glsl */ `
        varying vec4 vColor;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = dot(c, c) * 4.0;
          float a = (exp(-d * 26.0) * 1.8 + exp(-d * 5.0) * 0.45) * vColor.a;
          if (a < 0.003) discard;
          gl_FragColor = vec4(mix(vColor.rgb, vec3(1.0), 0.5), a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    }));
    this.packetPoints.frustumCulled = false;
    this.packetPoints.renderOrder = 9;
    this.group.add(this.packetPoints);
  }

  setArcs(defs: ArcDef[]) {
    const next = defs.slice(0, MAX_ARCS);
    // the same arcs between the same places: keep the geometry, just refresh the colours
    const sig = next.map((d) => `${d.key}:${d.from.x.toFixed(3)},${d.from.y.toFixed(3)},${d.to.x.toFixed(3)},${d.to.y.toFixed(3)}`).join('|');
    if (sig === this.sig) {
      next.forEach((d, i) => (this.material.uniforms.uColors.value as Color[])[i].copy(d.color));
      this.defs = next;
      return;
    }
    this.sig = sig;
    this.defs = next;
    this.index = new Map(this.defs.map((d, i) => [d.key, i]));
    this.heights = this.defs.map((d) => arcHeight(d.from, d.to));
    const pos = new Float32Array(this.defs.length * SEGMENTS * 2 * 3);
    const at = new Float32Array(this.defs.length * SEGMENTS * 2);
    const arc = new Float32Array(this.defs.length * SEGMENTS * 2);
    let v = 0;
    this.defs.forEach((d, i) => {
      for (let s = 0; s < SEGMENTS; s++) {
        for (const t of [s / SEGMENTS, (s + 1) / SEGMENTS]) {
          arcPoint(d.from, d.to, t, this.heights[i], this.tmp);
          pos.set([this.tmp.x, this.tmp.y, this.tmp.z], v * 3);
          at[v] = t;
          arc[v] = i;
          v++;
        }
      }
      (this.material.uniforms.uColors.value as Color[])[i].copy(d.color);
    });
    const old = this.lines.geometry;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('aT', new BufferAttribute(at, 1));
    g.setAttribute('aArc', new BufferAttribute(arc, 1));
    g.computeBoundingSphere();
    this.lines.geometry = g;
    old.dispose();
    // a packet in flight keeps to its arc wherever that now sits; one whose arc has gone is dropped
    this.packets = this.packets.filter((p) => {
      const i = this.index.get(p.key);
      if (i === undefined) { p.onCancel?.(); return false; }
      p.arc = i;
      return true;
    });
  }

  /** Whether a handoff is travelling right now (the view draws more often while one is). */
  get moving(): boolean {
    return this.packets.some((p) => !p.done);
  }

  indexOf(key: string): number {
    return this.index.get(key) ?? -1;
  }

  keys(): string[] {
    return this.defs.map((d) => d.key);
  }

  /** Send a packet along an arc; calls back when it lands, or when it's dropped first. */
  launch(arc: number, reverse: boolean, now: number, duration = 2.6, onArrive?: () => void, onCancel?: () => void) {
    if (arc < 0 || arc >= this.defs.length) return;
    // one packet to an arc: a new one takes the place of any still travelling it
    this.packets = this.packets.filter((p) => {
      if (p.arc !== arc || p.done) return true;
      p.onCancel?.();
      return false;
    });
    this.packets.push({ arc, key: this.defs[arc].key, reverse, start: now, duration, done: false, onArrive, onCancel });
  }

  update(time: number, dt: number, dpr: number, opacity: number) {
    const u = this.material.uniforms;
    u.uTime.value = time;
    u.uOpacity.value = opacity;
    // the brightest fragment is about 3.4 × opacity and anything under 0.003 is discarded: below this nothing shows
    this.group.visible = opacity > 0.0005;
    (this.packetPoints.material as ShaderMaterial).uniforms.uDpr.value = dpr;
    const arcs = u.uArcs.value as Vector4[];
    const k = 1 - Math.exp(-dt * 3);
    for (let i = 0; i < this.defs.length; i++) {
      this.base[i] += (this.target[i] - this.base[i]) * k;
      arcs[i].set(this.base[i], -1, 0.22, this.flow[i] * this.base[i] * 3);
    }
    const P = this.packetPos.array as Float32Array;
    const C = this.packetCol.array as Float32Array;
    let n = 0;
    for (const p of this.packets) {
      if (p.done) continue;
      const raw = (time - p.start) / p.duration;
      if (raw >= 1) {
        p.done = true;
        p.onArrive?.();
        continue;
      }
      const e = easeInOutCubic(Math.max(0, raw));
      arcs[p.arc].y = e;
      arcs[p.arc].z = (p.reverse ? -1 : 1) * 0.24;
      arcs[p.arc].x = Math.max(arcs[p.arc].x, 0.12);
      const d = this.defs[p.arc];
      arcPoint(p.reverse ? d.to : d.from, p.reverse ? d.from : d.to, e, this.heights[p.arc], this.tmp);
      if (n < 24) {
        P.set([this.tmp.x, this.tmp.y, this.tmp.z], n * 3);
        C.set([d.color.r, d.color.g, d.color.b, Math.min(1, raw * 8) * opacity], n * 4);
        n++;
      }
    }
    this.packets = this.packets.filter((p) => !p.done);
    this.packetPoints.geometry.setDrawRange(0, n);
    // nothing in flight: no draw call, and no buffers to send
    this.packetPoints.visible = n > 0;
    if (n > 0) { markUsed(this.packetPos, n); markUsed(this.packetCol, n); }
  }

  /** Where a packet on this arc is right now (globe space), for its label. */
  packetPosition(arc: number, time: number, out: Vector3): Vector3 | null {
    const p = this.packets.find((x) => x.arc === arc && !x.done);
    if (!p) return null;
    const d = this.defs[arc];
    const e = easeInOutCubic(Math.min(1, Math.max(0, (time - p.start) / p.duration)));
    return arcPoint(p.reverse ? d.to : d.from, p.reverse ? d.from : d.to, e, this.heights[arc], out);
  }

  get busy(): boolean {
    return this.packets.length > 0;
  }

  dispose() {
    for (const p of this.packets) if (!p.done) p.onCancel?.();
    this.packets = [];
    this.lines.geometry.dispose();
    this.material.dispose();
    this.packetPoints.geometry.dispose();
    (this.packetPoints.material as ShaderMaterial).dispose();
  }
}
