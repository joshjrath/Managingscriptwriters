// One-off visual effects: confetti, particle bursts, and the paper plane that
// flies off when scripts are sent. They only use transforms and opacity (or a
// short-lived canvas), never block clicks, and do nothing when motion is off.

import { motionAllowed } from './motion';

export const PALETTE = ['#F2A599', '#F4ED70', '#60D1BE', '#9D89EF', '#55C7E8', '#E77AB5'];

// ── confetti ─────────────────────────────────────────────────────────────

interface Piece { x: number; y: number; vx: number; vy: number; r: number; vr: number; w: number; h: number; color: string; round: boolean; wobble: number; ws: number }

let active: { canvas: HTMLCanvasElement; pieces: Piece[]; raf: number } | null = null;

function ensureCanvas() {
  if (active) return active;
  const canvas = document.createElement('canvas');
  canvas.className = 'fx-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.appendChild(canvas);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const size = () => { canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr; };
  size();
  const ctx = canvas.getContext('2d')!;
  const state = { canvas, pieces: [] as Piece[], raf: 0 };
  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(2.5, (now - last) / 16.67);
    last = now;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of state.pieces) {
      p.vy += 0.32 * dt;
      p.vx *= Math.pow(0.988, dt);
      p.vy *= Math.pow(0.988, dt);
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.r += p.vr * dt;
      p.wobble += p.ws * dt;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.scale(1, Math.cos(p.wobble)); // paper flutter
      ctx.fillStyle = p.color;
      if (p.round) { ctx.beginPath(); ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2); ctx.fill(); } else ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    state.pieces = state.pieces.filter((p) => p.y < innerHeight + 40);
    if (state.pieces.length) state.raf = requestAnimationFrame(frame);
    else { canvas.remove(); active = null; }
  };
  state.raf = requestAnimationFrame(frame);
  active = state;
  return state;
}

/** A confetti shot from (x, y), aimed at `angle` degrees (−90 is straight up). */
export function confetti({ x = innerWidth / 2, y = innerHeight / 2, count = 90, angle = -90, spread = 70, power = 14, colors = PALETTE }: { x?: number; y?: number; count?: number; angle?: number; spread?: number; power?: number; colors?: string[] } = {}) {
  if (!motionAllowed()) return;
  const s = ensureCanvas();
  for (let i = 0; i < count; i++) {
    const a = ((angle + (Math.random() - 0.5) * spread) * Math.PI) / 180;
    const v = power * (0.55 + Math.random() * 0.6);
    s.pieces.push({
      x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
      w: 6 + Math.random() * 6, h: 4 + Math.random() * 5, color: colors[i % colors.length], round: Math.random() < 0.28,
      wobble: Math.random() * Math.PI, ws: 0.08 + Math.random() * 0.12,
    });
  }
}

/** The big one: two cannons from the bottom corners and a pop from the middle. */
export function celebrate() {
  if (!motionAllowed()) return;
  confetti({ x: -10, y: innerHeight * 0.9, angle: -58, spread: 40, count: 110, power: 22 });
  confetti({ x: innerWidth + 10, y: innerHeight * 0.9, angle: -122, spread: 40, count: 110, power: 22 });
  setTimeout(() => confetti({ x: innerWidth / 2, y: innerHeight * 0.42, angle: -90, spread: 160, count: 70, power: 12 }), 260);
}

// ── particle burst ───────────────────────────────────────────────────────

/** Little sparks flying out from a point, e.g. from the button you just pressed. */
export function burst(x: number, y: number, { colors = PALETTE, count = 16, distance = 56 }: { colors?: string[]; count?: number; distance?: number } = {}) {
  if (!motionAllowed()) return;
  for (let i = 0; i < count; i++) {
    const el = document.createElement('i');
    el.className = 'fx-spark';
    const size = 4 + Math.random() * 5;
    el.style.cssText = `left:${x}px;top:${y}px;width:${size}px;height:${size}px;background:${colors[i % colors.length]};${Math.random() < 0.4 ? 'border-radius:2px;' : ''}`;
    document.body.appendChild(el);
    const a = (i / count) * Math.PI * 2 + Math.random() * 0.5;
    const d = distance * (0.5 + Math.random() * 0.7);
    const anim = el.animate([
      { transform: 'translate(-50%, -50%) scale(1)', opacity: 1 },
      { transform: `translate(calc(-50% + ${Math.cos(a) * d}px), calc(-50% + ${Math.sin(a) * d + 10}px)) scale(0.2) rotate(${Math.random() * 180}deg)`, opacity: 0 },
    ], { duration: 520 + Math.random() * 280, easing: 'cubic-bezier(.23, 1, .32, 1)' });
    anim.onfinish = () => el.remove();
  }
}

export const centerOf = (el: Element | null | undefined) => {
  const r = el?.getBoundingClientRect();
  return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: innerWidth / 2, y: innerHeight / 2 };
};

// ── paper plane ──────────────────────────────────────────────────────────

const PLANE = '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#111113" stroke-width="1.6" stroke-linejoin="round"><path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4 20-7Z" fill="#F4ED70" /></svg>';

/** A paper plane loops up from `from` and flies off the top right, leaving a dotted trail. */
export function plane(from: { x: number; y: number }) {
  if (!motionAllowed()) return;
  const el = document.createElement('div');
  el.className = 'fx-plane';
  el.innerHTML = PLANE;
  el.style.left = `${from.x}px`;
  el.style.top = `${from.y}px`;
  document.body.appendChild(el);
  const dx = innerWidth - from.x + 60;
  const dy = -from.y - 80;
  const path: [number, number, number][] = [[0, 0, 0], [-30, -30, -40], [10, -80, 10], [dx * 0.45, dy * 0.45, 20], [dx, dy, 30]];
  const anim = el.animate(path.map(([x, y, r], i) => ({ transform: `translate(-50%, -50%) translate(${x}px, ${y}px) rotate(${r}deg) scale(${i === 0 ? 0.6 : i === path.length - 1 ? 0.8 : 1})`, opacity: i === path.length - 1 ? 0 : 1 })), {
    duration: 1100, easing: 'cubic-bezier(.45, 0, .2, 1)',
  });
  // trail
  let n = 0;
  const trail = setInterval(() => {
    const r = el.getBoundingClientRect();
    const dot = document.createElement('i');
    dot.className = 'fx-trail';
    dot.style.left = `${r.left + r.width / 2}px`;
    dot.style.top = `${r.top + r.height / 2}px`;
    document.body.appendChild(dot);
    dot.animate([{ opacity: 0.8, transform: 'translate(-50%, -50%) scale(1)' }, { opacity: 0, transform: 'translate(-50%, -50%) scale(0.3)' }], { duration: 600, easing: 'ease-out' }).onfinish = () => dot.remove();
    if (++n > 24) clearInterval(trail);
  }, 40);
  anim.onfinish = () => { el.remove(); clearInterval(trail); };
}
