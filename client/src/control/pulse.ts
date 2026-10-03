// The brand dot's breathing and the pressure marks' blink, worked out from the
// view's own frame time. As CSS animations they kept the browser compositing
// at the full display rate even while the view itself idled at 30 or 15 fps;
// timed off the view's frames they change only when the view draws.

/** CSS ease-in-out, cubic-bezier(0.42, 0, 0.58, 1), as the browser computes it. */
export function easeInOut(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  // solve bezierX(t) = x by Newton's method (it converges in a few steps on this curve), then return bezierY(t)
  const bx = (t: number) => 3 * (1 - t) * (1 - t) * t * 0.42 + 3 * (1 - t) * t * t * 0.58 + t * t * t;
  const dx = (t: number) => 3 * (1 - t) * (1 - t) * 0.42 + 6 * (1 - t) * t * (0.58 - 0.42) + 3 * t * t * (1 - 0.58);
  let t = x;
  for (let i = 0; i < 8; i++) {
    const d = dx(t);
    if (Math.abs(d) < 1e-9) break;
    t -= (bx(t) - x) / d;
    t = Math.min(1, Math.max(0, t));
  }
  return 3 * (1 - t) * t * t + t * t * t;
}

/**
 * How far into its breath the brand dot is: 0 (full) to 1 (dimmest, smallest) and back, every 3.4 s,
 * eased in and out each way (the old `cc-breathe 3.4s ease-in-out infinite`, whose 50% keyframe this is).
 */
export function breathe(ms: number): number {
  const p = (((ms % 3400) + 3400) % 3400) / 1700;
  return easeInOut(p <= 1 ? p : 2 - p);
}

/**
 * Whether a pressure mark is in the dim half of its blink, `ms` after it appeared: bright for 0.45 s,
 * dim for 0.9 s, bright for 0.45 s, every 1.8 s (the old `cc-blink 1.8s steps(2, jump-none) infinite`).
 */
export function blinkDim(ms: number): boolean {
  return (((ms + 450) % 1800) + 1800) % 1800 >= 900;
}
