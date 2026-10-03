// Small building blocks shared by every screen.

import { createContext, forwardRef, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode, type TransitionEvent } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import { AlertTriangle, Check, CheckCheck, CircleAlert, Loader2, RotateCcw, X } from 'lucide-react';
import { useMotionAllowed, SPRING } from '../motion';
import { burst } from '../fx';
import type { ApiError } from '../api';
import { STATUS_LABEL, STAGE_LABEL, type Milestone, type Progress, type ScriptStatus, type Stage } from '../../../shared/workflow';
import { fmtDate } from '../../../shared/format';

// ── buttons ──────────────────────────────────────────────────────────────

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; busy?: boolean; icon?: ReactNode };

export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button({ variant = '', busy, icon, children, className = '', disabled, ...rest }, ref) {
  return (
    <button ref={ref} type="button" className={`btn ${variant} ${className}`} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy ? <Loader2 className="spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

// ── chips ────────────────────────────────────────────────────────────────

export function Chip({ color = 'neutral', icon, dot, solid, children, title }: { color?: string; icon?: ReactNode; dot?: boolean; solid?: boolean; children: ReactNode; title?: string }) {
  return (
    <span className={`chip ${color}${solid ? ' solid' : ''}`} title={title}>
      {dot && <i className="d" aria-hidden />}
      {icon}
      {children}
    </span>
  );
}

export const STATUS_COLOR: Record<ScriptStatus, string> = {
  not_started: 'neutral', in_progress: 'cyan', ready_for_review: 'lavender', revisions_needed: 'pink', approved: 'mint', delivered: 'mint',
};

export function StatusChip({ status }: { status: ScriptStatus }) {
  const icon = status === 'delivered' ? <CheckCheck aria-hidden /> : status === 'approved' ? <Check aria-hidden /> : status === 'revisions_needed' ? <RotateCcw aria-hidden /> : undefined;
  return <Chip color={STATUS_COLOR[status]} dot={!icon} icon={icon}>{STATUS_LABEL[status]}</Chip>;
}

export const STAGE_COLOR: Record<Stage, string> = { not_started: 'neutral', writing: 'cyan', in_review: 'lavender', approved: 'mint', delivered: 'mint' };

export function StageChip({ stage }: { stage: Stage }) {
  return <Chip color={STAGE_COLOR[stage]} dot={stage !== 'delivered'} icon={stage === 'delivered' ? <CheckCheck aria-hidden /> : undefined}>{STAGE_LABEL[stage]}</Chip>;
}

/** Deadline state with explicit words, never colour alone. */
export function DueChip({ m, today, prefix = true }: { m: Milestone | null; today: string; prefix?: boolean }) {
  if (!m) return <Chip color="mint" icon={<CheckCheck aria-hidden />}>Fully delivered</Chip>;
  const what = m.kind === 'draft' ? 'Drafts' : 'Final';
  if (!m.date) return <Chip color="neutral">{what}: no date</Chip>;
  if (m.complete) return <Chip color="mint" icon={<Check aria-hidden />}>{m.label}</Chip>;
  if (m.overdue) return <Chip color="red" icon={<AlertTriangle aria-hidden />}>{prefix ? `${what} ` : ''}{m.label.toLowerCase()}</Chip>;
  if (m.dueToday) return <Chip color="yellow" dot>{prefix ? `${what} due ` : 'Due '}today</Chip>;
  const soon = m.daysUntil != null && m.daysUntil <= 2;
  if (!prefix) return <Chip color={soon ? 'yellow' : 'plain'}>{m.daysUntil === 1 ? 'Tomorrow' : `In ${m.daysUntil} days`}</Chip>;
  return <Chip color={soon ? 'yellow' : 'plain'}>{what} {fmtDate(m.date, today)}</Chip>;
}

export const edgeFor = (m: Milestone | null, blocked?: boolean) =>
  m?.overdue || blocked ? 'edge-red' : m?.dueToday ? 'edge-yellow' : '';

// ── progress ─────────────────────────────────────────────────────────────

/** Starts at 0 and follows `target`, so CSS transitions animate the first fill as well as later changes. */
export function useRise(target: number, ready = true) {
  const allowed = useMotionAllowed();
  const [shown, setShown] = useState(allowed ? 0 : target);
  const prev = useRef<number | null>(null);
  const rose = useRef(false);
  useEffect(() => {
    if (!allowed) { setShown(target); prev.current = target; return; }
    if (!ready && prev.current === null) return;
    rose.current = prev.current !== null && target > prev.current + 0.01;
    prev.current = target;
    const id = requestAnimationFrame(() => setShown(target));
    return () => cancelAnimationFrame(id);
  }, [target, allowed, ready]);
  return { shown, rose };
}

/** True while the element is on (or near) the screen; continuous animations pause otherwise. */
export function useOnScreen<T extends Element>() {
  const ref = useRef<T>(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setOn(true); return; }
    const io = new IntersectionObserver(([e]) => setOn(e.isIntersecting), { rootMargin: '60px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, on] as const;
}

// bubble positions (left %, size px, delay s, duration s, drift px), fixed so bars don't reshuffle on re-render
const BUBBLES: [number, number, number, number, number][] = [[8, 3, 0, 2.8, 3], [21, 4, 1.4, 3.4, -2], [34, 2.5, 0.6, 2.4, 2], [47, 3.5, 2.1, 3.1, -3], [61, 3, 0.3, 2.7, 2], [74, 4, 1.8, 3.6, -2], [88, 2.5, 1.1, 2.5, 3]];

/** A pill that fills like liquid: layered colours, a sloshing edge, rising bubbles, sparks when it goes up. */
export function LiquidBar({ total, segs, thin }: { total: number; segs: { n: number; c: string }[]; thin?: boolean }) {
  const filled = segs.reduce((n, x) => n + x.n, 0);
  const pct = total ? Math.min(100, (filled / total) * 100) : 0;
  const [ref, on] = useOnScreen<HTMLDivElement>();
  const allowed = useMotionAllowed();
  const { shown, rose } = useRise(pct, on);
  const liq = useRef<HTMLDivElement>(null);
  const edge = [...segs].reverse().find((x) => x.n > 0)?.c ?? 'var(--track)';
  const onEnd = (e: TransitionEvent) => {
    if (e.target !== liq.current || e.propertyName !== 'width' || !rose.current) return;
    rose.current = false;
    const r = liq.current!.getBoundingClientRect();
    burst(r.right, r.top + r.height / 2, { colors: ['#FFFFFF', '#9D89EF', '#60D1BE', '#F4ED70'], count: 12, distance: 30 });
  };
  const full = shown >= 99.9;
  return (
    <div ref={ref} className={`bar-line liquid${thin ? ' thin' : ''}`} data-live={on && allowed ? '' : undefined} aria-hidden>
      <div ref={liq} className={`liq${full ? ' full' : ''}`} style={{ width: `${shown}%`, ['--edge' as string]: edge }} onTransitionEnd={onEnd}>
        <div className="liq-layers">
          {segs.map((x, i) => {
            // blend into the next layer that's actually showing
            const next = segs.slice(i + 1).find((y) => y.n > 0)?.c ?? x.c;
            return <span key={i} style={{ flexGrow: x.n, ['--c' as string]: x.c, ['--next' as string]: next }} />;
          })}
        </div>
        <span className="liq-shine" />
        {!thin && shown > 0 && BUBBLES.map(([l, sz, d, t, x], i) => (
          <i key={i} className="bub" style={{ left: `${l}%`, ['--s' as string]: `${sz}px`, ['--d' as string]: `${d}s`, ['--t' as string]: `${t}s`, ['--x' as string]: `${x}px` }} />
        ))}
        {shown > 0 && !full && (
          <svg className="liq-wave" viewBox="0 0 8 60" preserveAspectRatio="none"><path d="M0 0H4Q7 5 4 10Q1 15 4 20Q7 25 4 30Q1 35 4 40Q7 45 4 50Q1 55 4 60H0Z" /></svg>
        )}
      </div>
    </div>
  );
}

/**
 * "20 / 45 drafts ready · 44%" with a liquid bar: delivered, approved, in review,
 * and (lighter) what writers say they've written but not sent yet.
 */
export function BatchProgress({ p, thin, showSecondary = true, written = 0 }: { p: Progress; thin?: boolean; showSecondary?: boolean; written?: number }) {
  const extra = Math.max(0, Math.min(p.total, written) - p.draftReady);
  const label = `${p.draftReady} / ${p.total} drafts ready · ${p.pctDraft}%${extra ? ` · ${p.draftReady + extra} written` : ''}`;
  return (
    <div className="prog" role="group" aria-label={`${label}. ${p.approved} approved, ${p.delivered} delivered.`}>
      <LiquidBar total={p.total} thin={thin} segs={[
        { n: p.delivered, c: 'var(--mint)' },
        { n: p.awaitingDelivery, c: 'color-mix(in srgb, var(--mint) 55%, var(--track))' },
        { n: p.inReview, c: 'var(--lavender)' },
        { n: extra, c: 'color-mix(in srgb, var(--cyan) 70%, var(--track))' },
      ]} />
      <div className="label">
        <span><b>{p.draftReady} / {p.total}</b> drafts ready · <span className="n">{p.pctDraft}%</span>{extra > 0 && <span className="written-tag"> · {p.draftReady + extra} written</span>}</span>
        {showSecondary && <span className="n">{p.approved} approved · {p.delivered} delivered{p.revisions ? ` · ${p.revisions} revisions` : ''}</span>}
      </div>
    </div>
  );
}

/** A number that counts up to its value (and eases between values when it changes). */
export function CountUp({ value, duration = 800 }: { value: number; duration?: number }) {
  const allowed = useMotionAllowed();
  const [shown, setShown] = useState(allowed ? 0 : value);
  const cur = useRef(allowed ? 0 : value);
  useEffect(() => {
    if (!allowed) { cur.current = value; setShown(value); return; }
    const from = cur.current;
    if (from === value) return;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const v = Math.round(from + (value - from) * (1 - Math.pow(1 - t, 3)));
      cur.current = v;
      setShown(v);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, allowed, duration]);
  return <><span aria-hidden>{shown}</span><span className="sr-only">{value}</span></>;
}

export function Ring({ pct, size = 44, stroke = 5, color = 'var(--cyan)', children, large }: { pct: number; size?: number; stroke?: number; color?: string; children?: ReactNode; large?: boolean }) {
  const [ref, on] = useOnScreen<HTMLDivElement>();
  const { shown } = useRise(Math.min(100, Math.max(0, pct)), on);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const off = c * (1 - shown / 100);
  return (
    <div ref={ref} className={`ring-wrap${large ? ' lg' : ''}`} style={{ width: size, height: size }} data-live={on ? '' : undefined}>
      {large && (
        <span className="ring-water" style={{ ['--c' as string]: color }} aria-hidden>
          <span className="rw" style={{ transform: `translateY(${(100 - shown) / 2}%)` }}><i /><i /></span>
        </span>
      )}
      <svg className="ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden style={{ ['--c' as string]: color }}>
        <circle className="trk" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} />
        {pct > 0 && <circle className="arc" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={off} transform={`rotate(-90 ${size / 2} ${size / 2})`} />}
      </svg>
      <div className="ring-c">{children ?? <span><CountUp value={pct} />%</span>}</div>
    </div>
  );
}

/** Segmented control: a pill glides to the pressed button. */
export function Seg({ children, className = '', ...rest }: HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);
  const glider = useRef<HTMLSpanElement>(null);
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    const g = glider.current;
    if (!el || !g) return;
    const place = () => {
      const on = el.querySelector<HTMLElement>('button[aria-pressed="true"], button[aria-selected="true"]');
      if (!on) { g.style.opacity = '0'; return; }
      g.style.opacity = '1';
      g.style.width = `${on.offsetWidth}px`;
      g.style.height = `${on.offsetHeight}px`;
      g.style.transform = `translate(${on.offsetLeft}px, ${on.offsetTop}px)`;
    };
    place();
    if (!ready) requestAnimationFrame(() => setReady(true));
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null;
    ro?.observe(el);
    const mo = new MutationObserver(place);
    mo.observe(el, { attributes: true, subtree: true, attributeFilter: ['aria-pressed', 'aria-selected'] });
    return () => { ro?.disconnect(); mo.disconnect(); };
  });
  return (
    <div ref={ref} className={`seg glide${ready ? ' ready' : ''} ${className}`} {...rest}>
      <span ref={glider} className="seg-glider" aria-hidden />
      {children}
    </div>
  );
}

export const ringColor = (p: Progress) => (p.total && p.delivered === p.total ? 'var(--mint)' : p.draftReady === p.total && p.total ? 'var(--lavender)' : 'var(--cyan)');

// ── avatars ──────────────────────────────────────────────────────────────

const AV_COLORS = ['var(--salmon)', 'var(--cyan)', 'var(--lavender)', 'var(--mint)', 'var(--pink)', 'var(--yellow)'];
export function Avatar({ name, id, small }: { name: string; id?: number | null; small?: boolean }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]!.toUpperCase()).join('') || '?';
  const color = id == null ? 'var(--neutral)' : AV_COLORS[id % AV_COLORS.length];
  return <span className={`avatar${small ? ' sm' : ''}`} style={{ ['--c' as string]: color }} aria-hidden>{initials}</span>;
}

// ── panels & states ──────────────────────────────────────────────────────

export function Panel({ title, sub, tools, count, children, className = '', id, as: As = 'section' }: { title?: ReactNode; sub?: ReactNode; tools?: ReactNode; count?: number; children: ReactNode; className?: string; id?: string; as?: 'section' | 'div' }) {
  const hid = useId();
  return (
    <As className={`panel ${className}`} aria-labelledby={title ? hid : undefined} id={id}>
      {(title || tools) && (
        <div className="panel-head">
          {title && <h2 id={hid}>{title}</h2>}
          {count != null && <span className="count">{count}</span>}
          {sub && <span className="sub">{sub}</span>}
          {tools && <div className="tools">{tools}</div>}
        </div>
      )}
      {children}
    </As>
  );
}

export function Empty({ icon, title, children, action, boxed }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode; boxed?: boolean }) {
  return (
    <div className={`empty${boxed ? ' boxed' : ''}`}>
      {icon}
      <b>{title}</b>
      {children && <span>{children}</span>}
      {action}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div className="empty boxed" role="alert">
      <CircleAlert />
      <b>Couldn’t load this</b>
      <span>{(error as Error)?.message ?? 'Something went wrong.'}</span>
      {retry && <Button onClick={retry} icon={<RotateCcw aria-hidden />}>Try again</Button>}
    </div>
  );
}

export function Loading({ label = 'Loading…', height = 320 }: { label?: string; height?: number }) {
  return <div className="skel" style={{ height }} role="status" aria-label={label} />;
}

export function FormError({ error }: { error: ApiError | null | undefined }) {
  if (!error) return null;
  return (
    <div className="form-error" role="alert">
      <CircleAlert aria-hidden />
      <span>{error.message}{error.status === 0 || error.status >= 500 ? '' : ''}</span>
    </div>
  );
}

// ── form fields ──────────────────────────────────────────────────────────

export function Field({ label, optional, help, error, children, className = '', htmlFor }: { label: ReactNode; optional?: boolean; help?: ReactNode; error?: string; children: ReactNode; className?: string; htmlFor?: string }) {
  return (
    <div className={`field ${className}`}>
      <label htmlFor={htmlFor}>{label}{optional && <span className="opt">optional</span>}</label>
      {children}
      {error ? <span className="err" role="alert" id={htmlFor ? `${htmlFor}-err` : undefined}><CircleAlert aria-hidden />{error}</span> : help ? <span className="help">{help}</span> : null}
    </div>
  );
}

/** Field + input with a generated id, and aria wiring for errors. */
export function useFieldId(prefix: string) {
  const id = useId();
  return `${prefix}-${id.replace(/:/g, '')}`;
}

export const inputProps = (id: string, error?: string) => ({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': error ? `${id}-err` : undefined });

// ── dialogs ──────────────────────────────────────────────────────────────

/** Native <dialog>: focus trapping, Escape and backdrop come from the browser. */
export function Dialog({ open, onClose, title, sub, children, footer, kind = 'modal', size = '' }: { open: boolean; onClose: () => void; title: ReactNode; sub?: ReactNode; children: ReactNode; footer?: ReactNode; kind?: 'modal' | 'drawer'; size?: '' | 'wide' | 'narrow' }) {
  const ref = useRef<HTMLDialogElement>(null);
  const hid = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // React focuses autoFocus fields before the dialog opens, when they can't take focus; opening
      // then focuses the close button. So fields to start in are marked data-autofocus instead.
      d.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`${kind} ${size}`}
      aria-labelledby={hid}
      onClose={onClose}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
    >
      {open && (
        <div className="sheet">
          <div className="sheet-head">
            <div style={{ minWidth: 0 }}>
              <h2 id={hid}>{title}</h2>
              {sub && <div className="sub">{sub}</div>}
            </div>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><X /></button>
          </div>
          <div className="sheet-body">{children}</div>
          {footer && <div className="sheet-foot">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

// ── toasts (only after a save has actually succeeded) ────────────────────

interface Toast { id: number; text: ReactNode; kind: 'ok' | 'error' }
const ToastCtx = createContext<(text: ReactNode, kind?: 'ok' | 'error') => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: ReactNode, kind: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 9000 : 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        <AnimatePresence initial={false}>
          {toasts.map((t) => (
            <m.div key={t.id} layout className={`toast ${t.kind === 'error' ? 'error' : ''}`}
              initial={{ opacity: 0, y: 18, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, x: 40, transition: { duration: 0.16, ease: [0.32, 0, 0.67, 0] } }} transition={SPRING}>
              {t.kind === 'error' ? <CircleAlert aria-hidden /> : <Check aria-hidden className="toast-check" />}
              <span>{t.text}</span>
              <button className="x" onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))} aria-label="Dismiss"><X size={15} /></button>
            </m.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

// ── misc ─────────────────────────────────────────────────────────────────

export function DateTile({ date, color }: { date: string; color?: string }) {
  const d = new Date(date + 'T00:00:00Z');
  const m = d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
  return (
    <div className="datetile" style={color ? { ['--c' as string]: color } : undefined} aria-hidden>
      <span className="m">{m}</span>
      <span className="d">{d.getUTCDate()}</span>
    </div>
  );
}

export function ExtLink({ href, children, className = 'link' }: { href: string; children: ReactNode; className?: string }) {
  return <a href={href} target="_blank" rel="noopener noreferrer" className={className}>{children}</a>;
}
