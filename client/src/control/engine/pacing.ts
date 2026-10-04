// How the views' frame loops wait between frames. requestAnimationFrame wakes
// the page on every display refresh (60 or 120 times a second) even when the
// view only draws 15 times a second because its window isn't in front; then
// it sleeps on a timer until just before its next frame instead.

/** Below this frame rate (an interval over 40 ms) the loop sleeps between frames. */
const SLEEP_ABOVE_MS = 40;

/**
 * How long a frame loop can sleep before asking for its next frame, or 0 to ask for the next
 * display frame now. `last` is when it last drew, `ms` this callback's frame time, `now` the clock,
 * `drew` whether this callback drew. Chromium answers a frame requested after a sleep at once, with
 * the previous refresh's time: a callback that close to its frame asks for the next refresh
 * directly (0) rather than sleeping again and missing it.
 */
export function sleepFor(interval: number, last: number, ms: number, now: number, drew: boolean): number {
  if (interval <= SLEEP_ABOVE_MS) return 0;
  const wait = (drew ? ms : last) + interval - 4 - now;
  return wait > 2 ? wait : 0;
}
