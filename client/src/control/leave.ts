// Getting in and out of the Control Center from the public site. This file
// is part of the main bundle, so it stays tiny: the Control Center itself
// (and three.js) loads while the page drains away.

let loading: Promise<unknown> | null = null;

export const loadControlCenter = () => import('./ControlCenter');

/** Start fetching the Control Center before it's needed (on hover or focus of the link). */
export function preloadControlCenter(): Promise<unknown> {
  loading ??= loadControlCenter().catch((err) => { loading = null; throw err; });
  return loading;
}

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Drain the page into darkness, then go. The Control Center clears the dark once it's on screen. */
export async function leaveForControlCenter(go: () => void) {
  if (document.querySelector('.cc-departure')) return;
  const overlay = document.createElement('div');
  overlay.className = 'cc-departure';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.appendChild(document.createElement('i'));
  document.body.appendChild(overlay);
  document.documentElement.classList.add('cc-departing');
  await Promise.all([
    new Promise((r) => setTimeout(r, reduced() ? 260 : 1250)),
    preloadControlCenter().catch(() => {}),
  ]);
  go();
}

export function clearDeparture() {
  document.documentElement.classList.remove('cc-departing');
  const overlay = document.querySelector('.cc-departure');
  if (!overlay) return;
  overlay.classList.add('gone');
  setTimeout(() => overlay.remove(), 800);
}

/** Back to the public site: it comes back up out of the dark. */
export function returnToSite(go: () => void) {
  document.documentElement.classList.add('cc-returning');
  go();
  setTimeout(() => document.documentElement.classList.remove('cc-returning'), 1200);
}
