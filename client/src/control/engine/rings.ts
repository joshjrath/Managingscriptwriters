// Orbital structures, drawn as hairlines on flat quads so they stay crisp at
// any distance: the free orbits that reorganize with each mode, the deadline
// bands, the 24-hour dial, and a project's phase arc.

import {
  AdditiveBlending, Color, DataTexture, DoubleSide, LinearFilter, Mesh, PlaneGeometry, RedFormat, ShaderMaterial,
  UnsignedByteType, Vector3,
} from 'three';
import { SLOTS } from '../../../../shared/control';
import { BAND_RADII } from './layout';

const QUAD = new PlaneGeometry(2, 2);

const RING_VERT = /* glsl */ `
uniform float uExtent;
varying vec2 vP;
void main() {
  vP = position.xy * uExtent;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(vP, 0.0, 1.0);
}`;

// ── a single orbit ───────────────────────────────────────────────────────

/** The biggest square an orbit ring is ever drawn on (bigger rings are cut off at its corners, by design). */
export const ORBIT_EXTENT = 3.4;

/**
 * How big a square an orbit ring of this radius needs: the line, its ticks and glint all sit within
 * about 0.1 of the ring, so just past it is enough; a full-size square would mostly be thrown away.
 */
export const orbitExtent = (radius: number) => Math.min(ORBIT_EXTENT, radius + 0.2);

/** Whether a ring of this radius reaches into a square of this size at all (beyond its corners it draws nothing). */
export const orbitReaches = (radius: number, extent: number) => radius < extent * Math.SQRT2 + 0.1;

export class Orbit {
  mesh: Mesh;
  material: ShaderMaterial;

  constructor(extent = ORBIT_EXTENT) {
    this.material = new ShaderMaterial({
      uniforms: {
        uExtent: { value: extent }, uRadius: { value: 1.3 }, uOpacity: { value: 0 }, uColor: { value: new Color(0.62, 0.78, 1) },
        uDash: { value: 0 }, uTicks: { value: 0 }, uTickLen: { value: 0.03 }, uTime: { value: 0 }, uSpin: { value: 0.12 },
        uWidth: { value: 1.1 }, uFrom: { value: -10 }, uTo: { value: 10 }, uMark: { value: -10 }, uMarkOn: { value: 0 },
        uGlow: { value: 0.5 },
      },
      vertexShader: RING_VERT,
      fragmentShader: /* glsl */ `
        uniform float uRadius, uOpacity, uDash, uTicks, uTickLen, uTime, uSpin, uWidth, uFrom, uTo, uMark, uMarkOn, uGlow;
        uniform vec3 uColor;
        varying vec2 vP;
        const float TAU = 6.2831853;
        void main() {
          float r = length(vP);
          float a = atan(vP.y, vP.x);
          float fw = fwidth(r);
          float line = 1.0 - smoothstep(0.0, fw * uWidth, abs(r - uRadius));
          if (uDash > 0.0) line *= step(0.42, fract(a / TAU * uDash));
          // an arc can be a partial orbit
          float inArc = step(uFrom, a) * step(a, uTo);
          float fade = smoothstep(uFrom, uFrom + 0.12, a) * smoothstep(uTo, uTo - 0.12, a);
          line *= mix(1.0, fade, step(-9.0, uFrom));
          line *= mix(1.0, inArc, step(-9.0, uFrom));
          float tick = 0.0;
          if (uTicks > 0.0) {
            float seg = TAU / uTicks;
            float da = abs(fract(a / seg + 0.5) - 0.5) * seg * r;
            tick = (1.0 - smoothstep(0.0, fw * 1.1, da)) * step(uRadius, r) * step(r, uRadius + uTickLen);
            tick *= mix(1.0, inArc, step(-9.0, uFrom));
          }
          // a slow glint travels round the orbit
          float glint = pow(0.5 + 0.5 * cos(a - uTime * uSpin), 30.0);
          // a marker: a brighter bead on the orbit
          float md = abs(atan(sin(a - uMark), cos(a - uMark))) * r;
          float mark = uMarkOn * exp(-md * md * 900.0) * exp(-pow(r - uRadius, 2.0) * 3000.0);
          float alpha = (line * (0.6 + uGlow * glint) + tick * 0.6) * uOpacity + mark * 1.4;
          if (alpha < 0.002) discard;
          gl_FragColor = vec4(uColor * (1.0 + mark), alpha);
        }`,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
    });
    this.mesh = new Mesh(QUAD, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
  }

  get u() {
    return this.material.uniforms;
  }
}

// ── deadline bands: Earth is now; tighter orbits arrive sooner ───────────

export function buildBandField() {
  const bands = ['24H', '48H', '7D', '30D'].map((b) => BAND_RADII[b]);
  const material = new ShaderMaterial({
    uniforms: {
      uExtent: { value: 3.3 }, uOpacity: { value: 0 }, uTime: { value: 0 },
      uBands: { value: bands.map(([a, b]) => new Vector3(a, b, 0)) },
      uOverdue: { value: BAND_RADII.OVERDUE[1] },
      uHot: { value: 0 },
    },
    vertexShader: RING_VERT,
    fragmentShader: /* glsl */ `
      uniform float uOpacity, uTime, uOverdue, uHot;
      uniform vec3 uBands[4];
      varying vec2 vP;
      void main() {
        float r = length(vP);
        float a = atan(vP.y, vP.x);
        float fw = fwidth(r);
        float alpha = 0.0;
        vec3 col = vec3(0.55, 0.72, 1.0);
        for (int i = 0; i < 4; i++) {
          vec3 b = uBands[i];
          float inside = step(b.x, r) * step(r, b.y);
          float edge = (1.0 - smoothstep(0.0, fw * 1.1, abs(r - b.x))) + (1.0 - smoothstep(0.0, fw * 1.1, abs(r - b.y)));
          // the innermost band carries a faint warmth: that's today
          float warm = i == 0 ? 1.0 : 0.0;
          float fill = inside * (0.035 - float(i) * 0.006);
          // fine radial hatching on each band, like an instrument
          float hatch = inside * step(0.93, fract(a * (60.0 + float(i) * 24.0) / 6.2831853)) * 0.05;
          alpha += edge * (0.16 - float(i) * 0.025) + fill + hatch;
          col = mix(col, vec3(1.0, 0.66, 0.42), warm * inside * 0.35 * uHot);
        }
        float od = 1.0 - smoothstep(0.0, fw * 1.2, abs(r - uOverdue));
        alpha += od * 0.22 * step(0.5, fract(a * 40.0 / 6.2831853 + uTime * 0.05));
        alpha *= uOpacity;
        if (alpha < 0.002) discard;
        gl_FragColor = vec4(col, alpha);
      }`,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
  });
  const mesh = new Mesh(QUAD, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;
  return { mesh, material };
}

// ── the 24-hour dial ─────────────────────────────────────────────────────

export const MAX_LANES = 24;
export const DIAL = { inner: 1.46, lane: 0.026, coverage: 1.4 };

export function buildDial() {
  const data = new Uint8Array(SLOTS * (MAX_LANES + 1));
  const lanes = new DataTexture(data, SLOTS, MAX_LANES + 1, RedFormat, UnsignedByteType);
  lanes.magFilter = LinearFilter;
  lanes.minFilter = LinearFilter;
  lanes.needsUpdate = true;
  const material = new ShaderMaterial({
    uniforms: {
      uExtent: { value: 2.6 }, uOpacity: { value: 0 }, uTime: { value: 0 }, uLanes: { value: lanes },
      uLaneCount: { value: 0 }, uNowH: { value: 0 }, uHi: { value: -1 },
      uLaneColor: { value: Array.from({ length: MAX_LANES }, () => new Color(0.6, 0.8, 1)) },
      uInner: { value: DIAL.inner }, uLaneW: { value: DIAL.lane }, uCov: { value: DIAL.coverage },
    },
    vertexShader: RING_VERT,
    fragmentShader: /* glsl */ `
      uniform float uOpacity, uTime, uLaneCount, uNowH, uHi, uInner, uLaneW, uCov;
      uniform sampler2D uLanes;
      uniform vec3 uLaneColor[${MAX_LANES}];
      varying vec2 vP;
      const float TAU = 6.2831853;
      void main() {
        float r = length(vP);
        float a = atan(vP.y, vP.x);
        float fw = fwidth(r);
        // "now" sits at the front of the dial (local −y); hours run round from there
        float rel = (a + 1.5707963) / TAU;
        float hour = mod(uNowH + rel * 24.0, 24.0);
        float u = hour / 24.0;
        float outer = uInner + uLaneCount * uLaneW + 0.04;
        float alpha = 0.0;
        vec3 col = vec3(0.6, 0.78, 1.0);

        // hairlines bounding the dial, hour ticks outside it
        alpha += (1.0 - smoothstep(0.0, fw * 1.1, abs(r - outer))) * 0.22;
        alpha += (1.0 - smoothstep(0.0, fw * 1.1, abs(r - (uCov - 0.035)))) * 0.14;
        float seg = TAU / 24.0;
        float da = abs(fract(a / seg + 0.5) - 0.5) * seg * r;
        float hN = floor(hour + 0.5);
        float tickLen = mod(hN, 6.0) < 0.5 ? 0.075 : 0.035;
        alpha += (1.0 - smoothstep(0.0, fw * 1.1, da)) * step(outer, r) * step(r, outer + tickLen) * 0.45;
        float seg4 = TAU / 96.0;
        float da4 = abs(fract(a / seg4 + 0.5) - 0.5) * seg4 * r;
        alpha += (1.0 - smoothstep(0.0, fw, da4)) * step(outer, r) * step(r, outer + 0.018) * 0.18;

        // coverage: dark where nobody is on shift, more luminous where shifts overlap
        float cov = texture2D(uLanes, vec2(u, (float(${MAX_LANES}) + 0.5) / float(${MAX_LANES + 1}))).r * 8.0;
        float inCov = step(uCov - 0.03, r) * step(r, uCov + 0.012);
        float gap = step(cov, 0.5);
        alpha += inCov * mix(0.05 + min(cov, 5.0) * 0.08, 0.0, gap);
        col = mix(col, vec3(0.75, 0.9, 1.0), inCov * smoothstep(1.5, 4.0, cov));
        // gaps are drawn as a fine amber dash, not a block of red
        alpha += inCov * gap * step(0.5, fract(a * 180.0 / TAU)) * 0.18;
        col = mix(col, vec3(1.0, 0.62, 0.3), inCov * gap);

        // one lane per person
        float lane = floor((r - uInner) / uLaneW);
        float inLane = step(uInner, r) * step(lane, uLaneCount - 1.0);
        float within = fract((r - uInner) / uLaneW);
        float bar = smoothstep(0.18, 0.3, within) * (1.0 - smoothstep(0.62, 0.74, within));
        float on = texture2D(uLanes, vec2(u, (lane + 0.5) / float(${MAX_LANES + 1}))).r;
        vec3 lc = vec3(0.6, 0.8, 1.0);
        for (int i = 0; i < ${MAX_LANES}; i++) if (float(i) == lane) lc = uLaneColor[i];
        float hi = 1.0 - step(0.5, abs(lane - uHi));
        float track = inLane * (1.0 - smoothstep(0.0, fw * 1.1, abs(within - 0.46) * uLaneW)) * 0.05;
        alpha += inLane * (on * bar * (0.32 + hi * 0.5) + track);
        col = mix(col, lc, inLane * on);

        // the scan line: now
        float nd = abs(atan(sin(a + 1.5707963), cos(a + 1.5707963))) * r;
        float scan = (1.0 - smoothstep(0.0, fw * 1.4, nd)) * step(uCov - 0.08, r) * step(r, outer + 0.1);
        float scanGlow = exp(-nd * nd * 900.0) * step(uCov - 0.08, r) * step(r, outer + 0.1) * 0.25;
        alpha += scan * 0.9 + scanGlow;
        col = mix(col, vec3(0.92, 0.97, 1.0), scan);

        alpha *= uOpacity;
        if (alpha < 0.002) discard;
        gl_FragColor = vec4(col, alpha);
      }`,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
  });
  const mesh = new Mesh(QUAD, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;
  return { mesh, material, lanes, data };
}
