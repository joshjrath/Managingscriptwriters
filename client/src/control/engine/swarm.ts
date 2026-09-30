// Every script is a small luminous object. Where it sits depends on the view:
// orbiting its writer (wider while in review, higher with the client), on its
// deadline orbit, around its mission or along its project's phase arc, or as
// a star in the galaxy. Each script eases between views at its own pace, so
// transitions feel like a swarm reorganizing rather than a page swapping.

import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, DynamicDrawUsage, LineSegments, Matrix4, Points, Quaternion,
  ShaderMaterial, Vector3,
} from 'three';
import type { CcScript, ScriptState } from '../../../../shared/control';
import { hashString } from './math';

export const LAYOUT = { world: 0, deadline: 1, mission: 2, space: 3, graph: 4 } as const;
export const LAYOUTS = 5;

export const STATE_COLOR: Record<ScriptState, Color> = {
  research: new Color(0.52, 0.5, 1.0),
  concept: new Color(0.58, 0.56, 1.0),
  writing: new Color(0.55, 0.8, 1.0),
  internal_review: new Color(0.76, 0.62, 1.0),
  revision: new Color(1.0, 0.48, 0.82),
  client_review: new Color(0.45, 0.95, 1.0),
  approved: new Color(0.86, 0.93, 1.0),
  delivered: new Color(1.0, 0.9, 0.72),
};

/** how far from its writer a script orbits, and how high: work in review swings wider, client work rises a layer */
const ORBIT: Record<ScriptState, [number, number, number]> = {
  research: [0.03, 0.004, 0.7], concept: [0.034, 0.006, 0.75], writing: [0.04, 0.006, 1.0], internal_review: [0.068, 0.02, 0.6],
  revision: [0.052, 0.01, 1.2], client_review: [0.085, 0.07, 0.35], approved: [0.028, 0.002, 0.4], delivered: [0.12, 0.2, 0.2],
};

export interface ScriptBody {
  script: CcScript;
  writer: number;
  seed: number;
  phase: number;
  w: Float32Array;
  pos: Vector3;
  alpha: number;
  targetAlpha: number;
  size: number;
  color: Color;
  /** deadline orbit */
  orbitR: number;
  orbitW: number;
  urgent: boolean;
  archived: boolean;
  space: Vector3 | null;
  /** when it last changed, as a timestamp */
  updatedMs: number;
}

export interface SwarmFrame {
  time: number;
  dt: number;
  dpr: number;
  weights: number[];
  node: (writer: number) => { pos: Vector3; normal: Vector3 } | null;
  mission: (projectId: string, out: Vector3) => Vector3 | null;
  phase: (projectId: string, u: number, out: Vector3) => Vector3 | null;
  graph: (projectId: string, out: Vector3) => Vector3 | null;
  bandQuat: Quaternion;
  bandScale: number;
  space: Matrix4;
  reduced: boolean;
}

const PHASE_OF: Record<ScriptState, number> = {
  research: 0, concept: 0, writing: 1, internal_review: 2, revision: 3, client_review: 4, approved: 5, delivered: 5,
};

export class SwarmLayer {
  bodies: ScriptBody[] = [];
  points: Points;
  archiveLines: LineSegments;
  private material: ShaderMaterial;
  private pos!: BufferAttribute;
  private col!: BufferAttribute;
  private size!: BufferAttribute;
  private t1 = new Vector3();
  private t2 = new Vector3();
  private p = new Vector3();
  private q = new Vector3();
  private up = new Vector3(0, 1, 0);
  private layouts = Array.from({ length: LAYOUTS }, () => new Vector3());
  private valid = new Array<boolean>(LAYOUTS).fill(false);
  archiveOpacity = 0;

  constructor() {
    this.material = new ShaderMaterial({
      uniforms: { uDpr: { value: 1 }, uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        uniform float uDpr;
        attribute vec4 aColor;
        attribute float aSize;
        varying vec4 vColor;
        void main() {
          vColor = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = min(aSize * uDpr * 15.0 / -mv.z, 18.0 * uDpr);
        }`,
      fragmentShader: /* glsl */ `
        varying vec4 vColor;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = dot(c, c) * 4.0;
          float a = (exp(-d * 18.0) * 1.3 + exp(-d * 3.5) * 0.22) * vColor.a;
          if (a < 0.003) discard;
          gl_FragColor = vec4(vColor.rgb, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.points = new Points(new BufferGeometry(), this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 7;
    this.archiveLines = new LineSegments(new BufferGeometry(), new ShaderMaterial({
      uniforms: { uOpacity: { value: 0 } },
      vertexShader: /* glsl */ `void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `uniform float uOpacity; void main() { gl_FragColor = vec4(1.0, 0.9, 0.75, uOpacity); }`,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    }));
    this.archiveLines.frustumCulled = false;
    this.archiveLines.renderOrder = 6;
  }

  setScripts(list: { script: CcScript; writer: number; archived: boolean; orbitR: number; orbitW: number; urgent: boolean; space: Vector3 | null }[]) {
    const prev = new Map(this.bodies.map((b) => [b.script.id, b]));
    this.bodies = list.map((x) => {
      const old = prev.get(x.script.id);
      const seed = hashString(x.script.id);
      return {
        ...x,
        seed,
        phase: seed * Math.PI * 2,
        w: old?.w ?? Float32Array.from([1, 0, 0, 0, 0]),
        pos: old?.pos ?? new Vector3(),
        alpha: old?.alpha ?? 0,
        targetAlpha: 0,
        size: 1,
        color: STATE_COLOR[x.script.state].clone(),
        updatedMs: new Date(x.script.updatedAt).getTime(),
      };
    });
    const n = this.bodies.length;
    const g = this.points.geometry;
    this.pos = new BufferAttribute(new Float32Array(Math.max(1, n) * 3), 3).setUsage(DynamicDrawUsage);
    this.col = new BufferAttribute(new Float32Array(Math.max(1, n) * 4), 4).setUsage(DynamicDrawUsage);
    this.size = new BufferAttribute(new Float32Array(Math.max(1, n)), 1).setUsage(DynamicDrawUsage);
    g.setAttribute('position', this.pos);
    g.setAttribute('aColor', this.col);
    g.setAttribute('aSize', this.size);
    g.setDrawRange(0, n);

    // finished projects become constellations: their stars joined in a quiet chain
    const byProject = new Map<string, Vector3[]>();
    for (const b of this.bodies) if (b.archived && b.space) byProject.set(b.script.projectId, [...(byProject.get(b.script.projectId) ?? []), b.space]);
    const seg: number[] = [];
    for (const stars of byProject.values()) {
      const left = stars.slice();
      let cur = left.shift();
      while (cur && left.length) {
        let best = 0;
        for (let i = 1; i < left.length; i++) if (left[i].distanceToSquared(cur) < left[best].distanceToSquared(cur)) best = i;
        const next = left.splice(best, 1)[0];
        seg.push(cur.x, cur.y, cur.z, next.x, next.y, next.z);
        cur = next;
      }
    }
    this.archiveLines.geometry.setAttribute('position', new BufferAttribute(new Float32Array(seg), 3));
  }

  update(f: SwarmFrame, emphasis: (b: ScriptBody) => number) {
    this.material.uniforms.uDpr.value = f.dpr;
    const P = this.pos.array as Float32Array, C = this.col.array as Float32Array, S = this.size.array as Float32Array;
    const layouts = this.layouts;
    const valid = this.valid;
    const t = f.time;
    const fade = 1 - Math.exp(-f.dt * 4);
    this.bodies.forEach((b, i) => {
      const s = b.script;
      // each script eases between layouts at its own pace
      const k = 1 - Math.exp(-f.dt * (f.reduced ? 6 : 1.3 + b.seed * 2.2));
      let sum = 0;
      for (let l = 0; l < LAYOUTS; l++) { b.w[l] += (f.weights[l] - b.w[l]) * k; sum += b.w[l]; }
      b.targetAlpha = emphasis(b);
      // nothing to draw: skip the geometry until it's wanted again
      if (b.alpha < 0.003 && b.targetAlpha < 0.003) {
        b.alpha = 0;
        C[i * 4 + 3] = 0;
        return;
      }
      for (let l = 0; l < LAYOUTS; l++) valid[l] = false;

      // world: orbiting its writer
      const node = b.w[0] > 1e-4 && b.writer >= 0 ? f.node(b.writer) : null;
      if (node) {
        const [r, alt, speed] = ORBIT[s.state];
        this.t1.crossVectors(node.normal, this.up);
        if (this.t1.lengthSq() < 1e-4) this.t1.set(1, 0, 0);
        this.t1.normalize();
        this.t2.crossVectors(node.normal, this.t1);
        const th = b.phase + t * speed * (0.6 + b.seed * 0.8);
        const rr = r * (0.8 + b.seed * 0.5);
        layouts[0].copy(node.pos).addScaledVector(node.normal, alt + b.seed * 0.01)
          .addScaledVector(this.t1, Math.cos(th) * rr).addScaledVector(this.t2, Math.sin(th) * rr);
        valid[0] = true;
      }

      // deadline: on its orbit round Earth
      if (b.w[1] > 1e-4) {
        const a = b.phase + t * b.orbitW;
        layouts[1].set(Math.cos(a) * b.orbitR * f.bandScale, Math.sin(a) * b.orbitR * f.bandScale, (b.seed - 0.5) * 0.02).applyQuaternion(f.bandQuat);
        valid[1] = true;
      }

      // mission: along the phase arc when its project is open, otherwise round the project
      if (b.w[2] > 1e-4) {
        const u = (PHASE_OF[s.state] + 0.2 + b.seed * 0.6) / 6;
        if (f.phase(s.projectId, u, this.p)) {
          layouts[2].copy(this.p).add(this.q.set(Math.sin(b.phase * 3 + t * 0.4) * 0.02, Math.cos(b.phase * 5 + t * 0.3) * 0.03, 0));
          valid[2] = true;
        } else if (f.mission(s.projectId, this.p)) {
          const th = b.phase + t * 0.5;
          layouts[2].copy(this.p).add(this.q.set(Math.cos(th) * 0.06, Math.sin(th * 1.3) * 0.03, Math.sin(th) * 0.06));
          valid[2] = true;
        }
      }

      // galaxy
      if (b.w[3] > 1e-4 && b.space) {
        layouts[3].copy(b.space);
        if (!b.archived) layouts[3].y += Math.sin(t * 0.35 + b.phase) * 0.012;
        layouts[3].applyMatrix4(f.space);
        valid[3] = true;
      }

      // constellation: dust round its project
      if (b.w[4] > 1e-4 && f.graph(s.projectId, this.p)) {
        const th = b.phase + t * 0.25;
        layouts[4].copy(this.p).add(this.q.set(Math.cos(th) * 0.09, Math.sin(b.phase * 2) * 0.07, Math.sin(th) * 0.09));
        valid[4] = true;
      }

      // blend what's available; anything missing falls back to where it was
      this.p.set(0, 0, 0);
      let wsum = 0;
      for (let l = 0; l < LAYOUTS; l++) {
        if (!valid[l]) continue;
        this.p.addScaledVector(layouts[l], b.w[l]);
        wsum += b.w[l];
      }
      if (wsum > 1e-4) b.pos.copy(this.p.multiplyScalar(1 / wsum));
      const coverage = wsum / Math.max(1e-4, sum);

      b.alpha += (b.targetAlpha * Math.min(1, coverage * 1.2) - b.alpha) * fade;
      const pulse = b.urgent ? 0.75 + 0.25 * Math.sin(t * 5 + b.phase) : 1;
      P[i * 3] = b.pos.x; P[i * 3 + 1] = b.pos.y; P[i * 3 + 2] = b.pos.z;
      C[i * 4] = b.color.r; C[i * 4 + 1] = b.color.g; C[i * 4 + 2] = b.color.b; C[i * 4 + 3] = b.alpha * pulse;
      S[i] = b.size * (b.urgent ? 1.3 : 1) * (1 + b.w[3] * (b.archived ? 0.6 : 1.6));
    });
    this.pos.needsUpdate = this.col.needsUpdate = this.size.needsUpdate = true;
    const lm = this.archiveLines.material as ShaderMaterial;
    lm.uniforms.uOpacity.value = this.archiveOpacity;
    this.archiveLines.visible = this.archiveOpacity > 0.002;
  }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
    this.archiveLines.geometry.dispose();
    (this.archiveLines.material as ShaderMaterial).dispose();
  }
}
