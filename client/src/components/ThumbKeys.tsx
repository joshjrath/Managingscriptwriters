// Desktop shortcuts on a brief's page, and the small "Keys" popover that lists them. A key never acts while someone
// is typing (in an input, a textarea, a select or anything editable), while a dialog is open, or with Ctrl, Cmd or
// Alt held. 1–6 only opens the manager's confirm for that option; it never decides by itself. L is "Lights down":
// the option's frame full screen (requestFullscreen), Esc to come back. B opens and closes the Brand drawer (the
// client's brand kit, and a designer's references for that client) beside the work.

import { useEffect, useId, useRef, useState } from 'react';
import { Keyboard } from 'lucide-react';
import { MAX_OPTIONS } from '../../../shared/workflow';

/** What a shortcut asks the page to do. */
export type ThumbKeyAction =
  | { kind: 'pick'; index: number }
  | { kind: 'feed' | 'squint' | 'grey' | 'prev' | 'next' | 'lights' | 'brand' };

/** What the Keys popover lists, in order. `managers`: only in a manager's review. */
export const THUMB_KEYS: readonly { keys: string; what: string; managers?: boolean }[] = [
  { keys: `1–${MAX_OPTIONS}`, what: 'Pick that option (you confirm first)', managers: true },
  { keys: 'F', what: 'Feed preview' },
  { keys: 'S', what: 'Squint' },
  { keys: 'G', what: 'Greyscale' },
  { keys: '← →', what: 'Flick between options' },
  { keys: 'L', what: 'Lights down (Esc to come back)' },
  { keys: 'B', what: 'Brand kit drawer' },
];

/** Focus is somewhere keys mean text (or a control's own arrows): an input, a textarea, a select, anything editable. */
const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || !!t.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'));

/** The action a key press asks for, or null. */
export function thumbKeyAction(e: Pick<KeyboardEvent, 'key' | 'repeat'>, manager: boolean): ThumbKeyAction | null {
  if (e.key === 'ArrowLeft') return { kind: 'prev' };
  if (e.key === 'ArrowRight') return { kind: 'next' };
  if (e.repeat) return null;
  if (manager && /^[1-9]$/.test(e.key) && Number(e.key) <= MAX_OPTIONS) return { kind: 'pick', index: Number(e.key) - 1 };
  switch (e.key.toLowerCase()) {
    case 'f': return { kind: 'feed' };
    case 's': return { kind: 'squint' };
    case 'g': return { kind: 'grey' };
    case 'l': return { kind: 'lights' };
    case 'b': return { kind: 'brand' };
    default: return null;
  }
}

/** Calls `onKey` for the page's shortcuts while `enabled` (pick keys only when `manager`). */
export function useThumbKeys(onKey: (a: ThumbKeyAction) => void, opts: { enabled?: boolean; manager?: boolean } = {}): void {
  const { enabled = true, manager = false } = opts;
  const cb = useRef(onKey);
  useEffect(() => { cb.current = onKey; });
  useEffect(() => {
    if (!enabled) return;
    const down = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      if (typing(e.target) || document.querySelector('dialog[open]')) return;
      const a = thumbKeyAction(e, manager);
      if (!a) return;
      e.preventDefault();
      cb.current(a);
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, [enabled, manager]);
}

/** The "Keys" popover: the shortcuts this person has on this page. Hidden on touch screens, where there are no keys. */
export function KeysPopover({ manager }: { manager: boolean }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pid = `keys-${useId().replace(/:/g, '')}`;
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (!(e.target instanceof Node) || !wrap.current?.contains(e.target)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); btn.current?.focus(); } };
    document.addEventListener('pointerdown', down);
    window.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', down); window.removeEventListener('keydown', key); };
  }, [open]);
  return (
    <div className="tb-keys" ref={wrap}>
      <button ref={btn} type="button" className="btn sm ghost" aria-expanded={open} aria-controls={pid} onClick={() => setOpen((v) => !v)}>
        <Keyboard aria-hidden />Keys
      </button>
      {open && (
        <div id={pid} className="tb-keys-pop" role="region" aria-label="Keyboard shortcuts">
          <dl>
            {THUMB_KEYS.filter((k) => manager || !k.managers).map((k) => (
              <div key={k.keys}><dt><kbd>{k.keys}</kbd></dt><dd>{k.what}</dd></div>
            ))}
          </dl>
          <p className="dim">Not while you’re typing in a box.</p>
        </div>
      )}
    </div>
  );
}
