// Pins: a manager's numbered notes on exact spots of an option, sent with a decision (ThumbnailDecision.pins).
// PinLayer sits over an option's picture. In a manager's review, "Add note on image" and then a click or tap places
// a pin where it lands (pinAt, measured on the picture's own box: fitContain), with a small popover for the note and
// an optional tag chip; each pin is reachable with Tab, Enter opens it, the arrow keys nudge one not sent yet and
// Delete takes it away. On a phone a tap places it and PinList below is where it's written. Designers see the
// numbered pins (with "Hide notes") and PinList beside them, numbered the same. usePinDrafts holds a manager's pins
// for the round on screen until they decide.

import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Check, EyeOff, Pencil, Trash2 } from 'lucide-react';
import type { ThumbnailOption, ThumbnailPin, ThumbnailPinInput, ThumbnailRound } from '../../../shared/types';
import { currentPins, fitContain, MAX_PINS, PIN_NOTE_MAX, pinAt, THUMB_PIN_TAG_LABEL, THUMB_PIN_TAGS, type ThumbPinTag } from '../../../shared/workflow';
import { plural } from '../../../shared/format';
import { Button, Chip, Thumb } from './ui';
import { optionAlt } from './ThumbBits';

/** A pin as drawn: one sent with a decision (see pinMark), or one a manager is placing before sending (its key is a local id). */
export interface PinMark { key: string; n: number; x: number; y: number; body: string; tag: ThumbPinTag | null; letter?: string }

/** A sent pin, as PinLayer and PinList draw it. */
export const pinMark = (p: ThumbnailPin): PinMark => ({ key: String(p.id), n: p.n, x: p.x, y: p.y, body: p.body, tag: p.tag, letter: p.optionLetter });

/** A decision's pins on one option, in their numbers' order. */
export const marksOn = (pins: readonly ThumbnailPin[] | undefined, optionId: number): PinMark[] =>
  (pins ?? []).filter((p) => p.optionId === optionId).sort((a, b) => a.n - b.n).map(pinMark);

/** Every pin of a decision, in their numbers' order. */
export const allMarks = (pins: readonly ThumbnailPin[] | undefined): PinMark[] => [...(pins ?? [])].sort((a, b) => a.n - b.n).map(pinMark);

/** "Note 2 (Text) on option B: make the word bigger". */
const pinWords = (p: PinMark, label: string) => `Note ${p.n}${p.tag ? ` (${THUMB_PIN_TAG_LABEL[p.tag]})` : ''} on ${label}: ${p.body.trim() || 'no note written yet'}`;

// A .thumb frame is always 16:9, so the picture's own box (letterboxed when its shape isn't) is the same share of
// the frame at every size: worked out once, in percentages.
const FRAME = { width: 16, height: 9 };
function pictureBox(image: { width: number; height: number }) {
  const b = fitContain(FRAME, image);
  return { left: (b.left / FRAME.width) * 100, top: (b.top / FRAME.height) * 100, width: (b.width / FRAME.width) * 100, height: (b.height / FRAME.height) * 100 };
}

// a click outside an open note closes it; the same click mustn't also drop a new pin where it landed
let closedAt = 0;
const unit = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 10_000) / 10_000;
export const coarsePointer = () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

/**
 * Where focus goes when the pin (or the note) it was on goes away: `first` while it's still on the page, else the
 * picture (while notes are being placed), else the option's first action, so it never drops to the top of the page.
 */
function refocus(layer: HTMLElement | null, first: HTMLElement | null | undefined) {
  const to = (first?.isConnected ? first : null) ?? layer?.querySelector<HTMLElement>('.pin-catch')
    ?? layer?.closest('[data-option]')?.querySelector<HTMLElement>('.opt-acts :is(button:not(:disabled), a[href])');
  to?.focus({ preventScroll: true });
}

/** The pins on one option, over its picture (`children`: the Thumb they sit on, which shows the whole image: fit="contain"). */
export function PinLayer({ pins, image, label, placing, hidden, openKey, popover, onPlace, onOpen, onClose, onRemove, onMove, children }: {
  /** this option's pins */
  pins: readonly PinMark[];
  /** the picture's own size, so pins sit on the image itself when it's letterboxed (fitContain) */
  image: { width: number; height: number };
  /** which option, for screen readers: "option B" */
  label: string;
  /** "Add note on image" is on: a click or tap places a pin at that spot */
  placing?: boolean;
  /** "Hide notes" */
  hidden?: boolean;
  /** the pin whose note is open over the picture */
  openKey?: string | null;
  /** what the open pin shows: its note (PinNote), or the editor while a manager writes it (PinEditor) */
  popover?: ReactNode;
  onPlace?: (at: { x: number; y: number }) => void;
  onOpen?: (key: string) => void;
  onClose?: () => void;
  /** Delete on a focused pin: only a manager's pins not sent yet */
  onRemove?: (key: string) => void;
  /** the arrow keys on a focused pin not sent yet nudge it (Shift for bigger steps) */
  onMove?: (key: string, at: { x: number; y: number }) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const box = pictureBox(image);
  const open = openKey && !hidden ? pins.find((p) => p.key === openKey) ?? null : null;
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });
  // a click or tap anywhere else closes the open note (its own pin toggles it)
  const openId = open?.key ?? null;
  useEffect(() => {
    if (!openId) return;
    const down = (e: PointerEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (!t || pop.current?.contains(t) || t.closest(`[data-pin="${openId}"]`)) return;
      closedAt = performance.now();
      close.current?.();
    };
    document.addEventListener('pointerdown', down);
    return () => document.removeEventListener('pointerdown', down);
  }, [openId]);
  // focus goes back to the pin when its note closes from the keyboard (or on, when the pin went with it)
  const was = useRef<string | null>(null);
  useEffect(() => {
    const prev = was.current;
    was.current = openId;
    if (!prev || openId) return;
    const a = document.activeElement;
    if (a && a !== document.body && !ref.current?.contains(a)) return;
    refocus(ref.current, ref.current?.querySelector<HTMLElement>(`[data-pin="${prev}"]`));
  }, [openId]);

  const keys = (e: KeyboardEvent<HTMLButtonElement>, p: PinMark) => {
    if (onRemove && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      e.stopPropagation();
      const next = (e.currentTarget.nextElementSibling ?? e.currentTarget.previousElementSibling) as HTMLElement | null;
      onRemove(p.key);
      requestAnimationFrame(() => refocus(ref.current, next));
      return;
    }
    const step = e.shiftKey ? 0.1 : 0.02;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (onMove && d) {
      e.preventDefault();
      e.stopPropagation();
      onMove(p.key, { x: unit(p.x + d[0]), y: unit(p.y + d[1]) });
    }
  };
  const place = (e: MouseEvent<HTMLButtonElement>) => {
    if (!onPlace || performance.now() - closedAt < 450) return;
    const el = ref.current;
    if (!el) return;
    // from the keyboard (Enter or Space on the picture): the middle, to move with the arrow keys
    if (e.detail === 0) { onPlace({ x: 0.5, y: 0.5 }); return; }
    const r = el.getBoundingClientRect();
    const at = pinAt({ x: e.clientX - r.left, y: e.clientY - r.top }, fitContain(r, image));
    if (at) onPlace(at);
  };
  const where = open ? { x: box.left + open.x * box.width, y: box.top + open.y * box.height } : null;
  return (
    <div ref={ref} className={`pin-layer${placing ? ' placing' : ''}`}>
      {children}
      {placing && onPlace && (
        <button type="button" className="pin-catch" onClick={place}
          aria-label={`Drop a note on ${label}: click or tap the spot, or press Enter to start in the middle and move it with the arrow keys`} />
      )}
      {!hidden && pins.length > 0 && (
        <div className="pin-box" style={{ left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%`, height: `${box.height}%` }}>
          {pins.map((p) => (
            <button key={p.key} type="button" data-pin={p.key} className={`pin${p.key === openKey ? ' open' : ''}${p.body.trim() ? '' : ' blank'}`}
              style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }} aria-label={pinWords(p, label)} aria-expanded={p.key === openKey}
              onClick={() => (p.key === openKey ? onClose?.() : onOpen?.(p.key))} onKeyDown={(e) => keys(e, p)}>
              {p.n}
            </button>
          ))}
        </div>
      )}
      {open && popover && where && (
        <div ref={pop} className={`pin-pop${open.y > 0.5 ? ' up' : ''}`} role="dialog" aria-label={`Note ${open.n}`}
          style={{ ['--px' as string]: `${where.x}%`, ['--py' as string]: `${where.y}%` }}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose?.(); } }}>
          {popover}
        </div>
      )}
    </div>
  );
}

/** A pin's note, read-only: its number, its tag and what it says. */
export function PinNote({ pin }: { pin: PinMark }) {
  return (
    <div className="pin-note">
      <div className="pin-note-h">
        <span className="pin-n" aria-hidden>{pin.n}</span>
        <b>Note {pin.n}{pin.letter ? ` · option ${pin.letter}` : ''}</b>
        {pin.tag && <Chip color="yellow">{THUMB_PIN_TAG_LABEL[pin.tag]}</Chip>}
      </div>
      <p>{pin.body}</p>
    </div>
  );
}

/** Writing a pin's note, with its optional tag: in the popover over the picture, or in the list on a phone. */
export function PinEditor({ pin, onChange, onDone, onRemove }: {
  pin: PinMark; onChange: (c: { body: string; tag: ThumbPinTag | null }) => void; onDone: () => void; onRemove: () => void;
}) {
  const id = `pin-note-${useId().replace(/:/g, '')}`;
  return (
    <div className="pin-ed">
      <label className="pin-ed-l" htmlFor={id}><span className="pin-n" aria-hidden>{pin.n}</span>Note {pin.n}{pin.letter ? ` on option ${pin.letter}` : ''}</label>
      {/* focused at once: they just dropped the pin to write this */}
      <textarea id={id} className="textarea pin-ed-t" rows={3} maxLength={PIN_NOTE_MAX} value={pin.body} autoFocus
        placeholder="What to change here, e.g. make this word twice as big"
        onChange={(e) => onChange({ body: e.target.value, tag: pin.tag })}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); onDone(); } }} />
      <div className="pin-tags" role="group" aria-label="What it’s about (optional)">
        {THUMB_PIN_TAGS.map((t) => (
          <button key={t} type="button" className="pin-tag" aria-pressed={pin.tag === t} onClick={() => onChange({ body: pin.body, tag: pin.tag === t ? null : t })}>
            {THUMB_PIN_TAG_LABEL[t]}
          </button>
        ))}
      </div>
      <div className="pin-ed-acts">
        <Button variant="sm ghost" icon={<Trash2 aria-hidden />} onClick={onRemove}>Remove</Button>
        <Button variant="sm primary" icon={<Check aria-hidden />} onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}

/** The numbered notes beside the picture, matching its pins; editable (note and tag) while a manager hasn't sent them. */
export function PinList({ pins, openKey, editor, onEdit, onRemove, letters, className = '' }: {
  pins: readonly PinMark[];
  /** the pin being written in the list (on a phone), which shows `editor` in its place */
  openKey?: string | null;
  editor?: ReactNode;
  onEdit?: (key: string) => void;
  onRemove?: (key: string) => void;
  /** say which option each note is on (when they're on more than one) */
  letters?: boolean;
  className?: string;
}) {
  if (!pins.length) return null;
  return (
    <ol className={`pin-list ${className}`} aria-label={plural(pins.length, 'note') + ' on the image'}>
      {pins.map((p) => (
        <li key={p.key} value={p.n} className={`pin-item${p.key === openKey && editor ? ' editing' : ''}`}>
          {p.key === openKey && editor ? editor : (
            <>
              <span className="pin-n" aria-hidden>{p.n}</span>
              <span className="pin-item-t">
                <span className="sr-only">Note {p.n}{p.letter ? ` on option ${p.letter}` : ''}{p.tag ? `, ${THUMB_PIN_TAG_LABEL[p.tag]}` : ''}: </span>
                {letters && p.letter && <b className="pin-item-l" aria-hidden>{p.letter}</b>}
                {p.body.trim() ? <span className="pin-item-b">{p.body}</span> : <span className="dim">No note written yet</span>}
                {p.tag && <span className="pin-item-tag" aria-hidden>{THUMB_PIN_TAG_LABEL[p.tag]}</span>}
              </span>
              {(onEdit || onRemove) && (
                <span className="pin-item-acts">
                  {onEdit && <button type="button" className="icon-btn sm" onClick={() => onEdit(p.key)} aria-label={`Edit note ${p.n}`}><Pencil aria-hidden /></button>}
                  {onRemove && <button type="button" className="icon-btn sm" onClick={() => onRemove(p.key)} aria-label={`Remove note ${p.n}`}><Trash2 aria-hidden /></button>}
                </span>
              )}
            </>
          )}
        </li>
      ))}
    </ol>
  );
}

/** "Hide notes": the pins off the pictures for a clean look, the list left as it is. */
export function HideNotes({ hidden, onToggle }: { hidden: boolean; onToggle: () => void }) {
  return <button type="button" className="wild-tg pin-hide" aria-pressed={hidden} onClick={onToggle}><EyeOff aria-hidden />Hide notes</button>;
}

/** The pins sent on an option, read-only, over its picture (`children`, shown whole: fit="contain"): a pin opens its note. */
export function PinView({ option, pins, hidden, children }: { option: ThumbnailOption; pins: readonly PinMark[]; hidden?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState<string | null>(null);
  const shown = open ? pins.find((p) => p.key === open) ?? null : null;
  return (
    <PinLayer pins={pins} image={option} label={`option ${option.letter}`} hidden={hidden} openKey={shown?.key ?? null}
      popover={shown ? <PinNote pin={shown} /> : null} onOpen={setOpen} onClose={() => setOpen(null)}>
      {children}
    </PinLayer>
  );
}

/** An option's picture with the pins sent on it, read-only (`children` sit on the picture: its letter). */
export function PinnedThumb({ option, pins, title, hidden, eager, children }: {
  option: ThumbnailOption; pins: readonly PinMark[]; title: string; hidden?: boolean; eager?: boolean; children?: ReactNode;
}) {
  return (
    <PinView option={option} pins={pins} hidden={hidden}>
      <Thumb src={option.url} alt={optionAlt(option, title)} fit="contain" eager={eager}>{children}</Thumb>
    </PinView>
  );
}

// ── a manager's pins, before they decide ────────────────────────────────

/** A pin on the round being decided, as the manager places it: on which option, where, and the note so far. */
export interface PinDraft { key: string; optionId: number; letter: string; x: number; y: number; body: string; tag: ThumbPinTag | null }

let seq = 0;
const draftKey = () => `p${Date.now().toString(36)}${(seq++).toString(36)}`;
const fromSent = (pins: readonly ThumbnailPin[]): PinDraft[] =>
  [...pins].sort((a, b) => a.n - b.n).map((p) => ({ key: String(p.id), optionId: p.optionId, letter: p.optionLetter, x: p.x, y: p.y, body: p.body, tag: p.tag }));
/** What a decision sends: the pins with a note, in the order placed (the server numbers them 1, 2, 3…). */
export const pinInput = (list: readonly PinDraft[]): ThumbnailPinInput[] =>
  list.filter((p) => p.body.trim()).map((p) => ({ optionId: p.optionId, x: p.x, y: p.y, body: p.body.trim(), tag: p.tag }));

/**
 * The pins a manager is working on for the round on screen. Until they start, it's the round's current pins (its
 * newest decision's: currentPins); "Add note on image" starts from a copy of those, so deciding again keeps them
 * unless they're taken off. Numbered 1, 2, 3… in the order placed, across the round's options. A new round on
 * screen starts over.
 */
export function usePinDrafts(round: ThumbnailRound | null) {
  const [state, setState] = useState<{ roundId: number; list: PinDraft[] } | null>(null);
  const [placing, setPlacingState] = useState(false);
  const [open, setOpen] = useState<{ key: string; where: 'pin' | 'list' } | null>(null);
  const sentPins = round ? currentPins(round) : [];
  const sent = fromSent(sentPins);
  const drafts = state && round && state.roundId === round.id ? state.list : null;
  const all = drafts ?? sent;
  const shownOpen = open && all.some((p) => p.key === open.key) ? open : null;
  const update = (f: (list: PinDraft[]) => PinDraft[]) => {
    if (!round) return;
    setState((s) => ({ roundId: round.id, list: f(s && s.roundId === round.id ? s.list : fromSent(currentPins(round))) }));
  };
  const remove = (key: string) => { update((l) => l.filter((p) => p.key !== key)); setOpen((o) => (o?.key === key ? null : o)); };
  const n = new Map(all.map((p, i) => [p.key, i + 1]));
  const sentInput = JSON.stringify(pinInput(sent));
  return {
    /** every pin shown on the round: the drafts while editing, else its current pins */
    all,
    /** started: what's shown is the manager's, not (only) what was sent */
    editing: drafts != null,
    /** the drafts differ from what was sent with the round's current decision */
    changed: drafts != null && JSON.stringify(pinInput(drafts)) !== sentInput,
    placing: placing && !!round,
    open: shownOpen,
    full: all.length >= MAX_PINS,
    setPlacing: (on: boolean) => {
      setPlacingState(on);
      if (on && !drafts) update((l) => l);
      if (!on) setOpen(null);
    },
    /**
     * drops a pin on an option, and opens it to write its note: over the picture, or in the list (`where`: the page
     * says, since it knows when the pins are hidden; else in the list on a phone)
     */
    place: (o: ThumbnailOption, at: { x: number; y: number }, where?: 'pin' | 'list') => {
      if (all.length >= MAX_PINS) return false;
      const key = draftKey();
      update((l) => [...l, { key, optionId: o.id, letter: o.letter, x: at.x, y: at.y, body: '', tag: null }]);
      setOpen({ key, where: where ?? (coarsePointer() ? 'list' : 'pin') });
      return true;
    },
    openPin: (key: string, where: 'pin' | 'list') => setOpen({ key, where }),
    /** closes the open note; a pin left without one goes */
    close: () => {
      const o = shownOpen && all.find((p) => p.key === shownOpen.key);
      if (o && !o.body.trim() && drafts) remove(o.key);
      setOpen(null);
    },
    change: (key: string, c: { body: string; tag: ThumbPinTag | null }) => update((l) => l.map((p) => (p.key === key ? { ...p, ...c } : p))),
    move: (key: string, at: { x: number; y: number }) => update((l) => l.map((p) => (p.key === key ? { ...p, ...at } : p))),
    remove,
    /** back to what was sent */
    discard: () => { setState(null); setPlacingState(false); setOpen(null); },
    /** the pins on one option, numbered across the round */
    marks: (optionId: number): PinMark[] => all.filter((p) => p.optionId === optionId).map((p) => ({ key: p.key, n: n.get(p.key) ?? 0, x: p.x, y: p.y, body: p.body, tag: p.tag, letter: p.letter })),
    /** every pin, numbered */
    list: (): PinMark[] => all.map((p) => ({ key: p.key, n: n.get(p.key) ?? 0, x: p.x, y: p.y, body: p.body, tag: p.tag, letter: p.letter })),
  };
}
export type PinDrafts = ReturnType<typeof usePinDrafts>;
