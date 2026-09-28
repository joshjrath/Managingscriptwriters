// Small building blocks shared by every screen.

import { createContext, forwardRef, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { AlertTriangle, Check, CheckCheck, CircleAlert, Loader2, RotateCcw, X } from 'lucide-react';
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

/** "20 / 45 drafts ready · 44%" with a segmented bar: delivered, approved, in review. */
export function BatchProgress({ p, thin, showSecondary = true }: { p: Progress; thin?: boolean; showSecondary?: boolean }) {
  const w = (n: number) => (p.total ? `${(n / p.total) * 100}%` : '0%');
  const label = `${p.draftReady} / ${p.total} drafts ready · ${p.pctDraft}%`;
  return (
    <div className="prog" role="group" aria-label={`${label}. ${p.approved} approved, ${p.delivered} delivered.`}>
      <div className={`bar-line${thin ? ' thin' : ''}`} aria-hidden>
        {p.delivered > 0 && <span style={{ width: w(p.delivered), ['--c' as string]: 'var(--mint)' }} />}
        {p.awaitingDelivery > 0 && <span style={{ width: w(p.awaitingDelivery), ['--c' as string]: 'color-mix(in srgb, var(--mint) 55%, var(--track))' }} />}
        {p.inReview > 0 && <span style={{ width: w(p.inReview), ['--c' as string]: 'var(--lavender)' }} />}
      </div>
      <div className="label">
        <span><b>{p.draftReady} / {p.total}</b> drafts ready · <span className="n">{p.pctDraft}%</span></span>
        {showSecondary && <span className="n">{p.approved} approved · {p.delivered} delivered{p.revisions ? ` · ${p.revisions} revisions` : ''}</span>}
      </div>
    </div>
  );
}

export function Ring({ pct, size = 44, stroke = 5, color = 'var(--cyan)', children, large }: { pct: number; size?: number; stroke?: number; color?: string; children?: ReactNode; large?: boolean }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.min(100, Math.max(0, pct)) / 100);
  return (
    <div className={`ring-wrap${large ? ' lg' : ''}`} style={{ width: size, height: size }}>
      <svg className="ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden style={{ ['--c' as string]: color }}>
        <circle className="trk" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} />
        {pct > 0 && <circle className="arc" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={off} transform={`rotate(-90 ${size / 2} ${size / 2})`} />}
      </svg>
      <div className="ring-c">{children ?? `${pct}%`}</div>
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
    if (open && !d.open) d.showModal();
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
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind === 'error' ? 'error' : ''}`}>
            {t.kind === 'error' ? <CircleAlert aria-hidden /> : <Check aria-hidden />}
            <span>{t.text}</span>
            <button className="x" onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))} aria-label="Dismiss"><X size={15} /></button>
          </div>
        ))}
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
