// Small maths for the globe: geography ↔ 3D, arcs over the surface, easing,
// frame-rate independent smoothing, and a deterministic hash for layouts.

import { Vector3 } from 'three';

export const DEG = Math.PI / 180;
export const TAU = Math.PI * 2;

/** (lat, lon) in degrees → a point on a sphere. lon 0 faces +z, north is +y. */
export function geoToVec3(lat: number, lon: number, r = 1, out = new Vector3()): Vector3 {
  const phi = lat * DEG;
  const lambda = lon * DEG;
  return out.set(Math.cos(phi) * Math.sin(lambda) * r, Math.sin(phi) * r, Math.cos(phi) * Math.cos(lambda) * r);
}

export function vec3ToGeo(v: Vector3): { lat: number; lon: number } {
  const r = v.length() || 1;
  return { lat: Math.asin(Math.max(-1, Math.min(1, v.y / r))) / DEG, lon: Math.atan2(v.x, v.z) / DEG };
}

/** Along the great circle from a to b (unit vectors). */
export function slerpUnit(a: Vector3, b: Vector3, t: number, out = new Vector3()): Vector3 {
  const d = Math.max(-1, Math.min(1, a.dot(b)));
  const w = Math.acos(d);
  if (w < 1e-5) return out.copy(a);
  const s = Math.sin(w);
  const ka = Math.sin((1 - t) * w) / s;
  const kb = Math.sin(t * w) / s;
  return out.set(a.x * ka + b.x * kb, a.y * ka + b.y * kb, a.z * ka + b.z * kb);
}

/** How high an arc between two points rises: longer journeys fly higher. */
export const arcHeight = (a: Vector3, b: Vector3) => 0.06 + 0.3 * (Math.acos(Math.max(-1, Math.min(1, a.dot(b)))) / Math.PI);

/** A point on the arc from a to b, lifted off the surface. */
export function arcPoint(a: Vector3, b: Vector3, t: number, h: number, out = new Vector3()): Vector3 {
  slerpUnit(a, b, t, out);
  return out.multiplyScalar(1 + h * Math.sin(Math.PI * t));
}

// ── easing ───────────────────────────────────────────────────────────────

export const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeOutQuart = (t: number) => 1 - Math.pow(1 - t, 4);
export const easeInOutQuint = (t: number) => (t < 0.5 ? 16 * t ** 5 : 1 - Math.pow(-2 * t + 2, 5) / 2);
export const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Exponential smoothing that behaves the same at 30 or 144 fps. */
export const damp = (current: number, target: number, lambda: number, dt: number) => target + (current - target) * Math.exp(-lambda * dt);

/** The same, the short way round a circle. */
export function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  const d = wrapAngle(target - current);
  return current + d * (1 - Math.exp(-lambda * dt));
}

export const wrapAngle = (a: number) => ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;

// ── hashing ──────────────────────────────────────────────────────────────

/** A stable 0–1 number for a string, so layouts don't jump between refreshes. */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

export function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth 3D value noise in [0, 1], for particle brightness fields. */
export function noise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const h = (i: number, j: number, k: number) => {
    let n = (i * 374761393 + j * 668265263 + k * 1274126177) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(
    l(l(h(xi, yi, zi), h(xi + 1, yi, zi), u), l(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), u), v),
    l(l(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), u), l(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), u), v),
    w,
  );
}
