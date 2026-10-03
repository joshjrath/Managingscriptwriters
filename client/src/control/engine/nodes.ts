// Writer nodes: a small signal emerging from the Earth. Each has a bright
// core, a beam rising off the surface, and a glyph lying on the surface that
// draws its rhythm: a pulse when active, a slow heartbeat in deep work, a
// bead in orbit while reviewing, a warm ring at local dawn and dusk, a broken
// amber ring under pressure, and rings radiating when selected.

import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, DoubleSide, DynamicDrawUsage, InstancedBufferAttribute,
  InstancedMesh, LineSegments, Matrix4, PlaneGeometry, Points, Quaternion, ShaderMaterial, Vector3,
} from 'three';
import { markUsed } from './buffers';

export const RING = { none: 0, pulse: 1, heartbeat: 2, orbit: 3, waking: 4, late: 5 } as const;

export interface NodeVis {
  pos: Vector3;
  normal: Vector3;
  /** 1 facing the camera → 0 on the horizon → negative behind the planet */
  facing: number;
  intensity: number;
  color: Color;
  ring: number;
  period: number;
  phase: number;
  anomaly: number;
  dusk: number;
  focus: number;
  flash: number;
  beam: number;
  /** 0 lies on the globe's surface, 1 faces the camera (in open space) */
  billboard: number;
  size: number;
}

export function newNodeVis(): NodeVis {
  return {
    pos: new Vector3(), normal: new Vector3(0, 0, 1), facing: 1, intensity: 0, color: new Color(0.6, 0.8, 1), ring: RING.pulse,
    period: 2.6, phase: Math.random(), anomaly: 0, dusk: 0, focus: 0, flash: 0, beam: 0.03, billboard: 0, size: 0.13,
  };
}

const GLYPH_FRAG = /* glsl */ `
uniform float uTime;
varying vec2 vUv;
varying vec4 vA;
varying vec4 vB;
varying vec4 vC;
float ring(float r, float R, float w) { return 1.0 - smoothstep(0.0, w, abs(r - R)); }
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float kind = vA.x, period = vA.y, phase = vA.z, inten = vA.w;
  float anomaly = vB.w;
  float dusk = vC.x, focus = vC.y, flash = vC.z;
  float fw = max(fwidth(r), 0.004);
  float th = atan(vUv.y, vUv.x);
  float t = fract(uTime / period + phase);
  float a = 0.0;
  vec3 col = vB.rgb;

  if (kind > 0.5 && kind < 1.5) {
    // pulse
    float rr = mix(0.08, 0.86, 1.0 - pow(1.0 - t, 3.0));
    a += ring(r, rr, fw * 1.6) * pow(1.0 - t, 1.6) * 0.95;
  } else if (kind > 1.5 && kind < 2.5) {
    // heartbeat: two quick beats, then rest
    float b1 = clamp(t / 0.28, 0.0, 1.0);
    float b2 = clamp((t - 0.16) / 0.3, 0.0, 1.0);
    a += ring(r, mix(0.08, 0.62, b1), fw * 1.6) * (1.0 - b1) * step(t, 0.28) * 0.9;
    a += ring(r, mix(0.08, 0.74, b2), fw * 1.6) * (1.0 - b2) * step(0.16, t) * step(t, 0.46) * 0.7;
  } else if (kind > 2.5 && kind < 3.5) {
    // reviewing: a quiet orbit with a bead travelling on it
    float bead = uTime * 1.1 + phase * 6.28;
    float d = length(vUv - 0.4 * vec2(cos(bead), sin(bead)));
    a += ring(r, 0.4, fw * 1.2) * 0.35;
    a += exp(-d * d * 900.0) * 1.2;
    a += ring(r, mix(0.1, 0.8, t), fw * 1.5) * pow(1.0 - t, 2.0) * 0.4;
  } else if (kind > 3.5 && kind < 4.5) {
    // waking: a slow breath
    a += ring(r, 0.3, fw * 1.4) * (0.2 + 0.2 * sin(uTime * 1.2 + phase * 6.28));
  } else if (kind > 4.5) {
    // late: a wide, slow pulse
    float rr = mix(0.12, 0.95, t);
    a += ring(r, rr, fw * 1.8) * (1.0 - t) * 0.75;
    a += ring(r, 0.22, fw * 1.2) * 0.3;
  }

  // local dawn or dusk: a warm ring close in
  a += ring(r, 0.24, fw * 1.4) * dusk * 0.6;
  col = mix(col, vec3(1.0, 0.64, 0.38), dusk * ring(r, 0.24, fw * 3.0));

  // pressure: a broken, trembling ring
  if (anomaly > 0.0) {
    float wob = 0.04 * sin(th * 7.0 + uTime * 5.0) + 0.02 * sin(th * 13.0 - uTime * 9.0);
    float broken = step(0.35, fract(th * 3.0 / 6.2831853 + uTime * 0.07));
    float ar = ring(r, 0.58 + wob * anomaly, fw * 1.8) * broken;
    a += ar * anomaly * (0.55 + 0.45 * sin(uTime * 7.0));
    col = mix(col, vec3(1.0, 0.66, 0.3), clamp(ar * 2.0, 0.0, 1.0) * anomaly);
  }

  // selected: rings radiate outward, and a still ring marks the place
  if (focus > 0.0) {
    for (int i = 0; i < 3; i++) {
      float tt = fract(uTime * 0.35 + float(i) / 3.0);
      a += ring(r, mix(0.15, 0.98, tt), fw * 1.3) * (1.0 - tt) * 0.55 * focus;
    }
    a += ring(r, 0.34, fw * 1.1) * 0.45 * focus;
    float tick = step(0.94, fract(th * 16.0 / 6.2831853)) * step(0.3, r) * step(r, 0.38);
    a += tick * 0.5 * focus;
  }

  // a transfer just landed
  a += ring(r, mix(0.1, 1.0, 1.0 - flash), fw * 2.5) * flash * 1.3;

  a *= inten;
  if (a < 0.003) discard;
  gl_FragColor = vec4(col, a);
}`;

export class NodesLayer {
  readonly max: number;
  readonly vis: NodeVis[] = [];
  glyphs: InstancedMesh;
  cores: Points;
  beams: LineSegments;
  private glyphMat: ShaderMaterial;
  private coreMat: ShaderMaterial;
  private aA: InstancedBufferAttribute;
  private aB: InstancedBufferAttribute;
  private aC: InstancedBufferAttribute;
  private corePos: BufferAttribute;
  private coreCol: BufferAttribute;
  private coreSize: BufferAttribute;
  private beamPos: BufferAttribute;
  private beamCol: BufferAttribute;
  private m = new Matrix4();
  private q = new Quaternion();
  private q2 = new Quaternion();
  private s = new Vector3();
  private at = new Vector3();
  private z = new Vector3(0, 0, 1);

  constructor(max = 48) {
    this.max = max;
    this.glyphMat = new ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute vec4 aA;
        attribute vec4 aB;
        attribute vec4 aC;
        varying vec2 vUv;
        varying vec4 vA;
        varying vec4 vB;
        varying vec4 vC;
        void main() {
          vUv = position.xy;
          vA = aA; vB = aB; vC = aC;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: GLYPH_FRAG,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
    });
    const quad = new PlaneGeometry(2, 2);
    this.glyphs = new InstancedMesh(quad, this.glyphMat, max);
    this.glyphs.instanceMatrix.setUsage(DynamicDrawUsage);
    this.aA = new InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(DynamicDrawUsage);
    this.aB = new InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(DynamicDrawUsage);
    this.aC = new InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(DynamicDrawUsage);
    quad.setAttribute('aA', this.aA);
    quad.setAttribute('aB', this.aB);
    quad.setAttribute('aC', this.aC);
    this.glyphs.frustumCulled = false;
    this.glyphs.renderOrder = 6;
    this.glyphs.count = 0;

    const cg = new BufferGeometry();
    this.corePos = new BufferAttribute(new Float32Array(max * 3), 3).setUsage(DynamicDrawUsage);
    this.coreCol = new BufferAttribute(new Float32Array(max * 4), 4).setUsage(DynamicDrawUsage);
    this.coreSize = new BufferAttribute(new Float32Array(max), 1).setUsage(DynamicDrawUsage);
    cg.setAttribute('position', this.corePos);
    cg.setAttribute('aColor', this.coreCol);
    cg.setAttribute('aSize', this.coreSize);
    this.coreMat = new ShaderMaterial({
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
          gl_PointSize = aSize * uDpr * 5.5 / -mv.z;
        }`,
      fragmentShader: /* glsl */ `
        varying vec4 vColor;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = dot(c, c) * 4.0;
          float core = exp(-d * 40.0);
          float halo = exp(-d * 5.0) * 0.35;
          float a = (core * 1.6 + halo) * vColor.a;
          if (a < 0.003) discard;
          gl_FragColor = vec4(mix(vColor.rgb, vec3(1.0), core * 0.7), a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.cores = new Points(cg, this.coreMat);
    this.cores.frustumCulled = false;
    this.cores.renderOrder = 8;

    const bg = new BufferGeometry();
    this.beamPos = new BufferAttribute(new Float32Array(max * 6), 3).setUsage(DynamicDrawUsage);
    this.beamCol = new BufferAttribute(new Float32Array(max * 8), 4).setUsage(DynamicDrawUsage);
    bg.setAttribute('position', this.beamPos);
    bg.setAttribute('aColor', this.beamCol);
    const beamMat = new ShaderMaterial({
      vertexShader: /* glsl */ `
        attribute vec4 aColor;
        varying vec4 vColor;
        void main() { vColor = aColor; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        varying vec4 vColor;
        void main() { gl_FragColor = vColor; }`,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.beams = new LineSegments(bg, beamMat);
    this.beams.frustumCulled = false;
    this.beams.renderOrder = 7;
  }

  setCount(n: number) {
    while (this.vis.length < n) this.vis.push(newNodeVis());
    this.vis.length = Math.min(n, this.max);
    this.glyphs.count = this.vis.length;
    this.cores.geometry.setDrawRange(0, this.vis.length);
    this.beams.geometry.setDrawRange(0, this.vis.length * 2);
  }

  update(time: number, dpr: number, cameraQuat: Quaternion) {
    this.glyphMat.uniforms.uTime.value = time;
    this.coreMat.uniforms.uDpr.value = dpr;
    const A = this.aA.array as Float32Array, B = this.aB.array as Float32Array, C = this.aC.array as Float32Array;
    const P = this.corePos.array as Float32Array, K = this.coreCol.array as Float32Array, S = this.coreSize.array as Float32Array;
    const BP = this.beamPos.array as Float32Array, BC = this.beamCol.array as Float32Array;
    this.vis.forEach((v, i) => {
      // behind the planet a node goes dark; at the horizon it thins out
      const seen = v.billboard > 0.5 ? 1 : Math.min(1, Math.max(0, (v.facing + 0.05) / 0.25));
      const inten = v.intensity * seen;
      this.q.setFromUnitVectors(this.z, v.normal);
      this.q2.copy(cameraQuat);
      this.q.slerp(this.q2, v.billboard);
      // lifted a hair off the surface so the rings never sink into the core
      this.s.set(v.size, v.size, v.size);
      this.m.compose(this.at.copy(v.pos).addScaledVector(v.normal, (1 - v.billboard) * 0.004), this.q, this.s);
      this.glyphs.setMatrixAt(i, this.m);
      // written in place (no arrays made per person per frame)
      const { r, g, b } = v.color, { x, y, z } = v.pos, nx = v.normal.x, ny = v.normal.y, nz = v.normal.z;
      const i4 = i * 4, i3 = i * 3, i6 = i * 6, i8 = i * 8;
      A[i4] = v.ring; A[i4 + 1] = v.period; A[i4 + 2] = v.phase; A[i4 + 3] = inten;
      B[i4] = r; B[i4 + 1] = g; B[i4 + 2] = b; B[i4 + 3] = v.anomaly;
      C[i4] = v.dusk; C[i4 + 1] = v.focus; C[i4 + 2] = v.flash; C[i4 + 3] = 0;
      P[i3] = x + nx * 0.006; P[i3 + 1] = y + ny * 0.006; P[i3 + 2] = z + nz * 0.006;
      K[i4] = r; K[i4 + 1] = g; K[i4 + 2] = b; K[i4 + 3] = Math.min(1.2, inten * (0.8 + v.flash));
      S[i] = (0.9 + v.focus * 0.5 + v.flash * 0.8) * (0.7 + 0.3 * Math.min(1.2, v.intensity));
      const h = v.beam * (1 - v.billboard);
      BP[i6] = x; BP[i6 + 1] = y; BP[i6 + 2] = z; BP[i6 + 3] = x + nx * h; BP[i6 + 4] = y + ny * h; BP[i6 + 5] = z + nz * h;
      BC[i8] = r; BC[i8 + 1] = g; BC[i8 + 2] = b; BC[i8 + 3] = inten * 0.8; BC[i8 + 4] = r; BC[i8 + 5] = g; BC[i8 + 6] = b; BC[i8 + 7] = 0;
    });
    // only the slots in use go to the GPU, not all of them
    const n = this.vis.length;
    markUsed(this.glyphs.instanceMatrix, n);
    markUsed(this.aA, n); markUsed(this.aB, n); markUsed(this.aC, n);
    markUsed(this.corePos, n); markUsed(this.coreCol, n); markUsed(this.coreSize, n);
    markUsed(this.beamPos, n * 2); markUsed(this.beamCol, n * 2);
  }

  dispose() {
    this.glyphs.geometry.dispose();
    this.glyphMat.dispose();
    this.cores.geometry.dispose();
    this.coreMat.dispose();
    this.beams.geometry.dispose();
    (this.beams.material as ShaderMaterial).dispose();
  }
}
