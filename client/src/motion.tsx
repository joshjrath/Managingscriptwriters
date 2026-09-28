// Animation settings. Motion follows the system "reduce motion" setting, and
// anyone can also switch animations off from their account menu (remembered
// in this browser). CSS reads <html data-motion>, JS reads motionAllowed().

import { useSyncExternalStore, type ReactNode } from 'react';
import { domMax, LazyMotion, MotionConfig } from 'framer-motion';

const KEY = 'sm.motion';
const subs = new Set<() => void>();
const mq = typeof window !== 'undefined' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

function readSetting(): boolean {
  try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; }
}

let enabled = readSetting();
const apply = () => { document.documentElement.dataset.motion = enabled ? 'on' : 'off'; };
apply();
mq?.addEventListener('change', () => subs.forEach((f) => f()));

const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

/** True when animations should play: the person hasn't switched them off and the system doesn't ask for less motion. */
export const motionAllowed = () => enabled && !mq?.matches;

export function setMotionEnabled(on: boolean) {
  enabled = on;
  try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* private mode: still applies for this visit */ }
  apply();
  subs.forEach((f) => f());
}

export const useMotionAllowed = () => useSyncExternalStore(subscribe, motionAllowed, () => true);
export const useMotionSetting = () => useSyncExternalStore(subscribe, () => enabled, () => true);

/** Springs used across the app. */
export const SPRING = { type: 'spring', stiffness: 420, damping: 34, mass: 0.8 } as const;
export const SOFT = { type: 'spring', stiffness: 240, damping: 26 } as const;

export function MotionProvider({ children }: { children: ReactNode }) {
  const allowed = useMotionAllowed();
  return (
    <LazyMotion features={domMax} strict>
      <MotionConfig reducedMotion={allowed ? 'never' : 'always'}>{children}</MotionConfig>
    </LazyMotion>
  );
}
