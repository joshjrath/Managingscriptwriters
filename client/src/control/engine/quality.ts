// How much the device can take: particle counts and pixel ratio per tier,
// picked from the hardware up front and lowered at runtime if frames drop.

export type Tier = 'high' | 'medium' | 'low';

export interface Quality {
  tier: Tier;
  /** points sampled over the whole sphere (about a third land on land) */
  sphere: number;
  /** particle size: the denser the sampling, the finer the dots */
  dot: number;
  stars: number;
  maxDpr: number;
  antialias: boolean;
}

// Kept deliberately light: the canvas is the biggest cost (pixels × samples),
// so there's no multisampling at any tier (the dots are antialiased in their
// shader) and the pixel ratio stays under 1.5, and the particle counts are
// what the look needs, not what the GPU could take.
export const TIERS: Record<Tier, Quality> = {
  high: { tier: 'high', sphere: 150_000, dot: 8.2, stars: 1400, maxDpr: 1.5, antialias: false },
  medium: { tier: 'medium', sphere: 100_000, dot: 9.6, stars: 1000, maxDpr: 1.25, antialias: false },
  low: { tier: 'low', sphere: 60_000, dot: 11.5, stars: 700, maxDpr: 1, antialias: false },
};

export const lower = (t: Tier): Tier | null => (t === 'high' ? 'medium' : t === 'medium' ? 'low' : null);

/** A first guess from what the browser tells us; the frame-time watchdog corrects it. */
export function pickTier(gpu: string | null): Tier {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const small = Math.min(window.innerWidth, window.innerHeight) < 700;
  if (gpu && /swiftshader|llvmpipe|software|basic render/i.test(gpu)) return 'low';
  if (coarse && small) return 'low';
  if ((nav.deviceMemory ?? 8) <= 4 || (navigator.hardwareConcurrency ?? 8) <= 4 || coarse) return 'medium';
  return 'high';
}
