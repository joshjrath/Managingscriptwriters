// Projects and clients as objects in the system: projects ride the mission
// orbit and their deadline orbits; in the constellation, projects and clients
// float among the people, joined by fine lines of who works on what.

import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, LineSegments, Matrix4, Points, Quaternion,
  ShaderMaterial, Vector3,
} from 'three';
import { fitGeometry, markUsed } from './buffers';
import { hashString } from './math';

export const OBJ_LAYOUT = { mission: 0, graph: 1, deadline: 2, space: 3 } as const;

export interface SpaceObject {
  kind: 'project' | 'client';
  id: string;
  seed: number;
  w: Float32Array;
  pos: Vector3;
  alpha: number;
  color: Color;
  size: number;
  graphPos: Vector3 | null;
  spacePos: Vector3 | null;
  orbitR: number;
  orbitW: number;
  missionIndex: number;
  urgent: boolean;
}

export type EndRef = { writer: number } | { obj: number };

const EDGE_COLOR: Record<string, [number, number, number]> = {
  review: [0.72, 0.6, 1], client: [0.55, 0.9, 1], collab: [0.6, 0.75, 1], other: [0.6, 0.8, 1],
};

export interface Edge {
  a: EndRef;
  b: EndRef;
  kind: 'works' | 'client' | 'review' | 'collab';
  alpha: number;
}

export interface ObjectsFrame {
  time: number;
  dt: number;
  dpr: number;
  weights: number[];
  missionQuat: Quaternion;
  missionRadius: number;
  missionCount: number;
  bandQuat: Quaternion;
  bandScale: number;
  space: Matrix4;
  graph: Matrix4;
  writerPos: (i: number) => Vector3 | null;
  reduced: boolean;
}

export class ObjectsLayer {
  objects: SpaceObject[] = [];
  edges: Edge[] = [];
  points: Points;
  lines: LineSegments;
  private material: ShaderMaterial;
  private ok = [false, false, false, false];
  private pos!: BufferAttribute;
  private col!: BufferAttribute;
  private info!: BufferAttribute;
  private lpos!: BufferAttribute;
  private lcol!: BufferAttribute;
  private tmp = new Vector3();
  private slots = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];

  constructor() {
    this.material = new ShaderMaterial({
      uniforms: { uDpr: { value: 1 }, uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        uniform float uDpr;
        attribute vec4 aColor;
        attribute vec2 aInfo;
        varying vec4 vColor;
        varying float vShape;
        void main() {
          vColor = aColor;
          vShape = aInfo.y;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = min(aInfo.x * uDpr * 6.5 / -mv.z, 30.0 * uDpr);
        }`,
      fragmentShader: /* glsl */ `
        varying vec4 vColor;
        varying float vShape;
        void main() {
          vec2 c = (gl_PointCoord - 0.5) * 2.0;
          float a;
          if (vShape < 0.5) {
            // project: a hairline ring round a bright core
            float r = length(c);
            float fw = fwidth(r) * 1.2;
            a = (1.0 - smoothstep(0.0, fw, abs(r - 0.62))) * 0.9 + exp(-r * r * 30.0) * 1.2 + exp(-r * r * 3.0) * 0.12;
          } else {
            // client: a small diamond
            float d = abs(c.x) + abs(c.y);
            float fw = fwidth(d) * 1.2;
            a = (1.0 - smoothstep(0.0, fw, abs(d - 0.5))) * 0.9 + exp(-d * d * 40.0) * 0.8;
          }
          a *= vColor.a;
          if (a < 0.003) discard;
          gl_FragColor = vec4(vColor.rgb, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.points = new Points(new BufferGeometry(), this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 8;
    this.lines = new LineSegments(new BufferGeometry(), new ShaderMaterial({
      vertexShader: /* glsl */ `
        attribute vec4 aColor;
        varying vec4 vColor;
        void main() { vColor = aColor; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `varying vec4 vColor; void main() { if (vColor.a < 0.003) discard; gl_FragColor = vColor; }`,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 5;
  }

  setObjects(objects: Omit<SpaceObject, 'w' | 'pos' | 'alpha' | 'seed'>[], edges: Omit<Edge, 'alpha'>[]) {
    const prev = new Map(this.objects.map((o) => [`${o.kind}:${o.id}`, o]));
    this.objects = objects.map((o) => {
      const old = prev.get(`${o.kind}:${o.id}`);
      return { ...o, seed: hashString(o.id), w: old?.w ?? Float32Array.from([1, 0, 0, 0]), pos: old?.pos ?? new Vector3(), alpha: old?.alpha ?? 0 };
    });
    this.edges = edges.map((e) => ({ ...e, alpha: 0 }));
    // buffers are kept between refreshes and only grow when the data outgrows them
    const pts = fitGeometry(this.points, this.objects.length, { position: 3, aColor: 4, aInfo: 2 });
    this.pos = pts.position; this.col = pts.aColor; this.info = pts.aInfo;
    const lines = fitGeometry(this.lines, this.edges.length, { position: 3, aColor: 4 }, 2);
    this.lpos = lines.position; this.lcol = lines.aColor;
  }

  /** Where an object sits on the mission orbit (world space). */
  missionPoint(index: number, f: Pick<ObjectsFrame, 'time' | 'missionQuat' | 'missionRadius' | 'missionCount'>, out: Vector3): Vector3 {
    const a = (index / Math.max(1, f.missionCount)) * Math.PI * 2 + f.time * 0.025 + 0.3;
    return out.set(Math.cos(a) * f.missionRadius, Math.sin(a) * f.missionRadius, 0).applyQuaternion(f.missionQuat);
  }

  update(f: ObjectsFrame, emphasis: (o: SpaceObject) => number, edgeEmphasis: (e: Edge) => number) {
    this.material.uniforms.uDpr.value = f.dpr;
    const P = this.pos.array as Float32Array, C = this.col.array as Float32Array, I = this.info.array as Float32Array;
    this.objects.forEach((o, i) => {
      const k = 1 - Math.exp(-f.dt * (f.reduced ? 6 : 1.6 + o.seed * 1.8));
      for (let l = 0; l < 4; l++) o.w[l] += (f.weights[l] - o.w[l]) * k;
      const [mission, graph, deadline, space] = this.slots;
      const ok = this.ok;
      ok.fill(false);
      if (o.missionIndex >= 0) { this.missionPoint(o.missionIndex, f, mission); ok[0] = true; }
      if (o.graphPos) {
        graph.copy(o.graphPos).add(this.tmp.set(Math.sin(f.time * 0.3 + o.seed * 9) * 0.04, Math.cos(f.time * 0.23 + o.seed * 7) * 0.04, Math.sin(f.time * 0.19 + o.seed * 5) * 0.04)).applyMatrix4(f.graph);
        ok[1] = true;
      }
      if (o.kind === 'project') {
        const a = o.seed * Math.PI * 2 + f.time * o.orbitW;
        deadline.set(Math.cos(a) * o.orbitR * f.bandScale, Math.sin(a) * o.orbitR * f.bandScale, 0).applyQuaternion(f.bandQuat);
        ok[2] = true;
      }
      if (o.spacePos) { space.copy(o.spacePos).applyMatrix4(f.space); ok[3] = true; }
      this.tmp.set(0, 0, 0);
      let ws = 0, total = 0;
      for (let l = 0; l < 4; l++) {
        total += o.w[l];
        if (!ok[l] || o.w[l] < 1e-4) continue;
        this.tmp.addScaledVector(this.slots[l], o.w[l]);
        ws += o.w[l];
      }
      if (ws > 1e-4) o.pos.copy(this.tmp.multiplyScalar(1 / ws));
      const target = emphasis(o) * Math.min(1, (ws / Math.max(1e-4, total)) * 1.2);
      o.alpha += (target - o.alpha) * (1 - Math.exp(-f.dt * 4));
      P[i * 3] = o.pos.x; P[i * 3 + 1] = o.pos.y; P[i * 3 + 2] = o.pos.z;
      const pulse = o.urgent ? 0.8 + 0.2 * Math.sin(f.time * 4 + o.seed * 6) : 1;
      C[i * 4] = o.color.r; C[i * 4 + 1] = o.color.g; C[i * 4 + 2] = o.color.b; C[i * 4 + 3] = o.alpha * pulse;
      I[i * 2] = o.size; I[i * 2 + 1] = o.kind === 'project' ? 0 : 1;
    });
    const L = this.lpos.array as Float32Array, LC = this.lcol.array as Float32Array;
    const end = (r: EndRef) => ('writer' in r ? f.writerPos(r.writer) : this.objects[r.obj]?.pos ?? null);
    this.edges.forEach((e, i) => {
      const a = end(e.a), b = end(e.b);
      e.alpha += (edgeEmphasis(e) - e.alpha) * (1 - Math.exp(-f.dt * 4));
      if (!a || !b) { LC.fill(0, i * 8, i * 8 + 8); return; }
      L[i * 6] = a.x; L[i * 6 + 1] = a.y; L[i * 6 + 2] = a.z; L[i * 6 + 3] = b.x; L[i * 6 + 4] = b.y; L[i * 6 + 5] = b.z;
      const c = EDGE_COLOR[e.kind] ?? EDGE_COLOR.other;
      const o = i * 8;
      LC[o] = LC[o + 4] = c[0]; LC[o + 1] = LC[o + 5] = c[1]; LC[o + 2] = LC[o + 6] = c[2];
      LC[o + 3] = e.alpha; LC[o + 7] = e.alpha * 0.55;
    });
    const n = this.objects.length, m = this.edges.length * 2;
    markUsed(this.pos, n); markUsed(this.col, n); markUsed(this.info, n);
    markUsed(this.lpos, m); markUsed(this.lcol, m);
  }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
    this.lines.geometry.dispose();
    (this.lines.material as ShaderMaterial).dispose();
  }
}
