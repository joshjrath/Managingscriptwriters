// How much the device can take: particle counts and pixel ratio per tier,
// picked from the hardware up front and lowered at runtime if frames drop.

export type Tier = 'high' | 'medium' | 'low';

export interface Quality {
  tier: Tier;
  /** points sampled over the whole sphere (about a third land on land) */
  sphere: number;
  stars: number;
  maxDpr: number;
  antialias: boolean;
}

export const TIERS: Record<Tier, Quality> = {
  high: { tier: 'high', sphere: 200_000, stars: 2600, maxDpr: 2, antialias: true },
  medium: { tier: 'medium', sphere: 120_000, stars: 1600, maxDpr: 1.5, antialias: true },
  low: { tier: 'low', sphere: 64_000, stars: 900, maxDpr: 1, antialias: false },
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
