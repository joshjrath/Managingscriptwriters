// The planet: particle geography over a dark core, a real day/night
// terminator, an atmosphere that lives mostly on the horizon, and deep space.

import {
  AdditiveBlending, BackSide, BufferAttribute, BufferGeometry, Color, FrontSide, Mesh, NormalBlending, Points,
  ShaderMaterial, SphereGeometry, Vector3, Vector4,
} from 'three';
import { releaseAfterUpload } from './buffers';
import { isLand, landMask } from './landmask';
import { DEG, mulberry, noise3 } from './math';

export const MAX_BUMPS = 16;

// ── particles: land, coast, a whisper of ocean, and the graticule ───────

/** kind: 0 land · 1 coast · 2 ocean · 3 graticule */
export function buildSurface(count: number): { geometry: BufferGeometry; land: number } {
  const mask = landMask();
  const rand = mulberry(20260930);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const spacing = Math.sqrt((4 * Math.PI) / count);
  // typed arrays sized for the worst case (every sample kept, plus the graticule), trimmed at the end
  const cap = count + 12_000;
  const pos = new Float32Array(cap * 3);
  const data = new Float32Array(cap * 4);
  let n = 0;
  const put = (x: number, y: number, z: number, a: number, b: number, c: number, d: number) => {
    pos[n * 3] = x; pos[n * 3 + 1] = y; pos[n * 3 + 2] = z;
    data[n * 4] = a; data[n * 4 + 1] = b; data[n * 4 + 2] = c; data[n * 4 + 3] = d;
    n++;
  };
  const t1 = new Vector3(), t2 = new Vector3(), p = new Vector3(), up = new Vector3(0, 1, 0);
  let land = 0;
  for (let i = 0; i < count; i++) {
    const y = 1 - ((i + 0.5) / count) * 2;
    const r = Math.sqrt(1 - y * y);
    const th = i * golden;
    p.set(Math.cos(th) * r, y, Math.sin(th) * r);
    // a little jitter so the lattice reads as geography, not a pattern
    t1.crossVectors(p, up).normalize();
    if (t1.lengthSq() < 0.5) t1.set(1, 0, 0);
    t2.crossVectors(p, t1);
    p.addScaledVector(t1, (rand() - 0.5) * spacing * 0.7).addScaledVector(t2, (rand() - 0.5) * spacing * 0.7).normalize();
    const lat = Math.asin(p.y) / DEG;
    const lon = Math.atan2(p.x, p.z) / DEG;
    const seed = rand();
    if (isLand(mask, lat, lon)) {
      const d = 0.55;
      const coast = !isLand(mask, lat + d, lon) || !isLand(mask, lat - d, lon) || !isLand(mask, lat, lon + d / Math.max(0.2, Math.cos(lat * DEG))) || !isLand(mask, lat, lon - d / Math.max(0.2, Math.cos(lat * DEG)));
      const nz = noise3(p.x * 3.2 + 7, p.y * 3.2, p.z * 3.2) * 0.62 + noise3(p.x * 11 + 3, p.y * 11, p.z * 11) * 0.38;
      // most sit on the surface; some a hair above; a few float
      const lift = seed > 0.994 ? 0.02 + rand() * 0.035 : seed > 0.86 ? 0.003 + rand() * 0.009 : 0;
      put(p.x, p.y, p.z, seed, coast ? 1 : 0, lift, nz);
      land++;
    } else if (rand() < 0.085) {
      put(p.x, p.y, p.z, seed, 2, 0, noise3(p.x * 5, p.y * 5, p.z * 5));
    }
  }
  // graticule: dotted parallels and meridians every 15°
  for (let lat = -75; lat <= 75; lat += 15) {
    const steps = Math.round(480 * Math.cos(lat * DEG));
    for (let s = 0; s < steps; s++) {
      const lon = (s / steps) * 360 - 180;
      const phi = lat * DEG, lam = lon * DEG;
      put(Math.cos(phi) * Math.sin(lam) * 1.002, Math.sin(phi) * 1.002, Math.cos(phi) * Math.cos(lam) * 1.002, rand(), 3, 0, lat === 0 ? 1 : 0.35);
    }
  }
  for (let lon = -180; lon < 180; lon += 15) {
    for (let lat = -80; lat <= 80; lat += 0.75) {
      const phi = lat * DEG, lam = lon * DEG;
      put(Math.cos(phi) * Math.sin(lam) * 1.002, Math.sin(phi) * 1.002, Math.cos(phi) * Math.cos(lam) * 1.002, rand(), 3, 0, lon === 0 ? 0.8 : 0.3);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(pos.slice(0, n * 3), 3));
  geometry.setAttribute('aData', new BufferAttribute(data.slice(0, n * 4), 4));
  geometry.boundingSphere = null;
  geometry.computeBoundingSphere();
  releaseAfterUpload(geometry);
  return { geometry, land };
}

const SURFACE_VERT = /* glsl */ `
uniform float uTime;
uniform float uReveal;
uniform float uSize;
uniform float uDpr;
uniform vec3 uSun;
uniform vec3 uPointer;
uniform float uPointerOn;
uniform vec4 uBumps[${MAX_BUMPS}];
uniform float uDim;
uniform float uDissolve;
uniform float uGrid;
uniform float uNight;
attribute vec4 aData;
varying vec4 vColor;

float h1(float n) { return fract(sin(n) * 43758.5453123); }

void main() {
  vec3 n = normalize(position);
  float seed = aData.x;
  float kind = aData.y;
  float grid = step(2.5, kind);
  float ocean = step(1.5, kind) * (1.0 - grid);
  float coast = step(0.5, kind) * (1.0 - step(1.5, kind));

  // the reveal: one point, a cloud, then the outline of Earth settles first
  vec3 viewN = normalize(normalMatrix * n);
  float limb = 1.0 - abs(viewN.z);
  float start = 0.40 + (1.0 - limb) * 0.30 + seed * 0.12;
  float settle = smoothstep(start, start + 0.24, uReveal);
  vec3 dir = normalize(vec3(h1(seed * 91.7) - 0.5, h1(seed * 37.3) - 0.5, h1(seed * 13.1) - 0.5) + 1e-4);
  float spread = smoothstep(0.03, 0.42, uReveal);
  float cr = spread * (0.18 + pow(h1(seed * 7.7), 0.7) * 1.25);
  float sw = uTime * 0.45 + seed * 6.2831;
  vec3 cloud = dir * cr;
  cloud.xz = mat2(cos(sw), -sin(sw), sin(sw), cos(sw)) * cloud.xz;

  // live cities push the surface up and ripple it
  float bump = 0.0;
  for (int i = 0; i < ${MAX_BUMPS}; i++) {
    vec4 b = uBumps[i];
    if (b.w <= 0.0) continue;
    float d = acos(clamp(dot(n, b.xyz), -1.0, 1.0));
    bump += b.w * exp(-d * d * 1600.0) * (0.6 + 0.4 * sin(uTime * 1.7 - d * 110.0));
  }
  float pd = distance(n, uPointer);
  float pointer = uPointerOn * exp(-pd * pd * 110.0) * (1.0 - grid);
  vec3 sphere = n * (1.0 + aData.z + bump * 0.014 + pointer * 0.005);
  vec3 p = mix(cloud, sphere, settle) + dir * uDissolve * (0.25 + seed * 2.2);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  // the real sun: day is cold white, night deep blue, a warm band at the terminator
  float l = dot(n, uSun);
  float day = smoothstep(-0.10, 0.32, l);
  float dusk = exp(-l * l * 55.0);
  vec3 col = mix(vec3(0.26, 0.33, 0.78), vec3(0.80, 0.88, 1.0), day);
  col = mix(col, vec3(1.0, 0.60, 0.34), dusk * 0.55 * (1.0 - grid));
  float facing = dot(viewN, normalize(-mv.xyz));
  float twinkle = step(0.978, seed) * (0.5 + 0.5 * sin(uTime * (1.2 + seed * 3.0) + seed * 60.0));
  float a = mix(0.26 * uNight, 0.8, day) * (0.5 + 0.62 * aData.w);
  a += coast * 0.2 + twinkle * 0.3 + bump * 1.1 + pointer * 0.45;
  a *= mix(1.0, 0.1, ocean);
  a = mix(a, (0.05 + aData.w * 0.09) * (0.45 + 0.55 * day) + uGrid * (0.12 + aData.w * 0.2), grid);
  a *= smoothstep(-0.12, 0.12, facing);
  // points multiply out of a single one: 0001, 0024, 0182…
  float born = pow(clamp(uReveal / 0.34, 0.0, 1.0), 2.4);
  a *= smoothstep(seed - 0.015, seed, born) * mix(0.35, 1.0, smoothstep(0.0, 0.3, uReveal));
  a *= (1.0 - uDim * 0.6) * (1.0 - uDissolve * 0.72);
  col += vec3(0.35, 0.65, 1.0) * bump * 0.7;
  vColor = vec4(col, a);
  float size = uSize * (0.72 + 0.6 * aData.w + coast * 0.2 + bump * 1.8 + twinkle * 0.5 + pointer * 0.6);
  size *= mix(1.0, 0.75, ocean) * mix(1.0, 0.6, grid);
  size *= mix(mix(0.5, 1.5, spread), 1.0, settle);
  gl_PointSize = size * uDpr / -mv.z;
}`;

const SOFT_POINT_FRAG = /* glsl */ `
varying vec4 vColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c) * 4.0;
  float a = 1.0 - smoothstep(0.5, 1.0, d);
  if (a <= 0.0) discard;
  gl_FragColor = vec4(vColor.rgb, vColor.a * a);
}`;

export function surfaceMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uReveal: { value: 0 }, uSize: { value: 11 }, uDpr: { value: 1 },
      uSun: { value: new Vector3(1, 0, 0) }, uPointer: { value: new Vector3(0, 0, 9) }, uPointerOn: { value: 0 },
      uBumps: { value: Array.from({ length: MAX_BUMPS }, () => new Vector4(0, 0, 0, 0)) },
      uDim: { value: 0 }, uDissolve: { value: 0 }, uGrid: { value: 0 }, uNight: { value: 1 },
    },
    vertexShader: SURFACE_VERT,
    fragmentShader: SOFT_POINT_FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
}

export function buildSurfacePoints(count: number, dot = 11) {
  const { geometry, land } = buildSurface(count);
  const material = surfaceMaterial();
  material.uniforms.uSize.value = dot;
  const points = new Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 2;
  return { points, material, land, total: geometry.getAttribute('position').count };
}

// ── the core: dark, detailed, lifted a touch on the day side ─────────────

const SHELL_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vView;
varying vec3 vModelN;
void main() {
  vModelN = normalize(position);
  vN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

export function buildCore() {
  const material = new ShaderMaterial({
    uniforms: { uSun: { value: new Vector3(1, 0, 0) }, uSunView: { value: new Vector3(1, 0, 0) }, uOpacity: { value: 0 }, uDim: { value: 0 } },
    vertexShader: SHELL_VERT,
    fragmentShader: /* glsl */ `
      uniform vec3 uSun;
      uniform vec3 uSunView;
      uniform float uOpacity;
      uniform float uDim;
      varying vec3 vN;
      varying vec3 vView;
      varying vec3 vModelN;
      void main() {
        float l = dot(vModelN, uSun);
        float day = smoothstep(-0.25, 0.6, l);
        float fres = pow(1.0 - max(dot(vN, vView), 0.0), 2.6);
        vec3 col = mix(vec3(0.006, 0.008, 0.02), vec3(0.018, 0.03, 0.062), day);
        col += vec3(0.04, 0.09, 0.2) * fres * (0.25 + 0.75 * day);
        float glint = pow(max(dot(reflect(-uSunView, vN), vView), 0.0), 70.0) * 0.1 * day;
        col += vec3(0.75, 0.85, 1.0) * glint;
        col *= 1.0 - uDim * 0.4;
        gl_FragColor = vec4(col, uOpacity);
      }`,
    transparent: true,
    depthWrite: true,
    blending: NormalBlending,
  });
  const mesh = new Mesh(new SphereGeometry(0.994, 96, 64), material);
  releaseAfterUpload(mesh.geometry);
  mesh.renderOrder = 0;
  return { mesh, material };
}

// ── atmosphere: a halo just past the horizon, and a hairline on it ───────

const ATMO_K = 1.2;

export function buildAtmosphere() {
  const halo = new ShaderMaterial({
    uniforms: { uSun: { value: new Vector3(1, 0, 0) }, uIntensity: { value: 0 } },
    vertexShader: SHELL_VERT,
    fragmentShader: /* glsl */ `
      uniform vec3 uSun;
      uniform float uIntensity;
      varying vec3 vN;
      varying vec3 vView;
      varying vec3 vModelN;
      void main() {
        float d = dot(vN, vView);
        float b = ${ATMO_K.toFixed(2)} * sqrt(max(0.0, 1.0 - d * d));
        float g = pow(clamp(1.0 - (b - 1.0) / ${(ATMO_K - 1).toFixed(2)}, 0.0, 1.0), 3.2);
        float l = dot(vModelN, uSun);
        vec3 day = vec3(0.36, 0.64, 1.0);
        vec3 dusk = vec3(1.0, 0.5, 0.26);
        vec3 night = vec3(0.34, 0.2, 0.86);
        vec3 col = mix(night * 0.45, day, smoothstep(-0.2, 0.35, l));
        col = mix(col, dusk, exp(-l * l * 18.0) * 0.7);
        gl_FragColor = vec4(col, g * uIntensity * mix(0.35, 1.0, smoothstep(-0.4, 0.3, l)));
      }`,
    side: BackSide,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const haloMesh = new Mesh(new SphereGeometry(1, 96, 64), halo);
  releaseAfterUpload(haloMesh.geometry);
  haloMesh.scale.setScalar(ATMO_K);
  haloMesh.renderOrder = 1;

  const rim = new ShaderMaterial({
    uniforms: { uSun: { value: new Vector3(1, 0, 0) }, uIntensity: { value: 0 } },
    vertexShader: SHELL_VERT,
    fragmentShader: /* glsl */ `
      uniform vec3 uSun;
      uniform float uIntensity;
      varying vec3 vN;
      varying vec3 vView;
      varying vec3 vModelN;
      void main() {
        float f = pow(1.0 - max(dot(vN, vView), 0.0), 6.0);
        float l = dot(vModelN, uSun);
        vec3 col = mix(vec3(0.3, 0.24, 0.9) * 0.6, vec3(0.62, 0.82, 1.0), smoothstep(-0.2, 0.3, l));
        col = mix(col, vec3(1.0, 0.62, 0.38), exp(-l * l * 20.0) * 0.6);
        gl_FragColor = vec4(col, f * uIntensity * mix(0.4, 1.0, smoothstep(-0.3, 0.3, l)));
      }`,
    side: FrontSide,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const rimMesh = new Mesh(new SphereGeometry(1.006, 96, 64), rim);
  releaseAfterUpload(rimMesh.geometry);
  rimMesh.renderOrder = 3;
  return { haloMesh, rimMesh, halo, rim };
}

// ── deep space ───────────────────────────────────────────────────────────

export function buildStars(count: number) {
  const rand = mulberry(7);
  const pos = new Float32Array(count * 3);
  const data = new Float32Array(count * 4);
  const col = new Color();
  for (let i = 0; i < count; i++) {
    // mostly far away, some drifting dust closer in for parallax
    const near = i < count * 0.12;
    const r = near ? 3 + rand() * 7 : 40 + rand() * 50;
    const u = rand() * 2 - 1;
    const th = rand() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    pos.set([Math.cos(th) * s * r, u * r, Math.sin(th) * s * r], i * 3);
    const tint = rand();
    col.setRGB(0.8, 0.86, 1);
    if (tint > 0.9) col.setRGB(1, 0.82, 0.66);
    else if (tint > 0.7) col.setRGB(0.66, 0.74, 1);
    data.set([rand(), near ? 1 : 0, col.r, col.b], i * 4);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(pos, 3));
  geometry.setAttribute('aData', new BufferAttribute(data, 4));
  const material = new ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uDpr: { value: 1 }, uOpacity: { value: 0 }, uDeep: { value: 0 } },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uDpr;
      uniform float uOpacity;
      uniform float uDeep;
      attribute vec4 aData;
      varying vec4 vColor;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float near = aData.y;
        float tw = 0.65 + 0.35 * sin(uTime * (0.4 + aData.x * 1.3) + aData.x * 80.0);
        float a = (near > 0.5 ? 0.09 : 0.12 + pow(aData.x, 6.0) * 0.6) * tw * uOpacity * (1.0 + uDeep * 0.8);
        vColor = vec4(aData.z, mix(aData.z, aData.w, 0.5), aData.w, a);
        float size = near > 0.5 ? 1.2 : 0.8 + pow(aData.x, 4.0) * 1.8;
        gl_PointSize = size * uDpr * (near > 0.5 ? 6.0 / -mv.z : 1.0);
      }`,
    fragmentShader: SOFT_POINT_FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const points = new Points(geometry, material);
  releaseAfterUpload(geometry);
  points.frustumCulled = false;
  points.renderOrder = -1;
  return { points, material };
}
