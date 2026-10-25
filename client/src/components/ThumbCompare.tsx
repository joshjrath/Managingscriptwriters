// Compare on a brief's page: this round's option and the version before it (the last round's, or the picked one)
// side by side, or one over the other with a before/after swipe (a range input and clip-path), flicking between this
// round's options with ← →. And Lights down: one option alone on black, full screen (requestFullscreen; a fixed
// overlay where the browser can't), ← → to flick, Esc to come back.

import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Columns2, SquareSplitHorizontal, X } from 'lucide-react';
import type { ThumbnailOption } from '../../../shared/types';
import { Seg, Thumb } from './ui';
import { optionAlt } from './ThumbBits';

/** A version to compare with: an option of the last round, or the picked one. */
export interface CompareSide { option: ThumbnailOption; picked?: boolean }

const MODE_KEY = 'sm.compare.mode';
const readMode = (): 'side' | 'swipe' => { try { return localStorage.getItem(MODE_KEY) === 'swipe' ? 'swipe' : 'side'; } catch { return 'side'; } };
const sideWords = (s: CompareSide) => (s.picked ? `Picked · option ${s.option.letter}` : `Round ${s.option.roundNumber} · option ${s.option.letter}`);
const sideShort = (s: CompareSide) => (s.picked ? `Picked ${s.option.letter}` : `R${s.option.roundNumber} ${s.option.letter}`);

export function Compare({ before, options, index, onIndex, title, nowLabel, initialBefore = 0 }: {
  /** what this round is compared with: the last round's versions, or the picked one */
  before: readonly CompareSide[];
  /** this round's options */
  options: readonly ThumbnailOption[];
  /** the option shown; ← → move it */
  index: number;
  onIndex: (i: number) => void;
  /** the video's title, for the pictures' alt text */
  title: string;
  /** "Round 2", "Round 3 · your tray" */
  nowLabel: string;
  /** the version to start from: the one the last notes were on, else the same letter */
  initialBefore?: number;
}) {
  const [mode, setModeState] = useState<'side' | 'swipe'>(readMode);
  const setMode = (m: 'side' | 'swipe') => { setModeState(m); try { localStorage.setItem(MODE_KEY, m); } catch { /* private mode: this visit only */ } };
  const [bi, setBi] = useState(initialBefore);
  const [pos, setPos] = useState(50);
  const drag = useRef(false);
  const ids = useId();
  const beforeId = `cmp-b${ids}`;
  const nowId = `cmp-n${ids}`;
  const shown = options[index] ?? options[0];
  const b = before[bi] ?? before[0];
  if (!shown || !b) return null;
  const n = options.length;
  const flick = (d: number) => onIndex((index + d + n) % n);
  // nothing sent before this round: it's one option beside another, not a before and after
  const peers = !b.picked && b.option.roundId === shown.roundId;
  const left = peers ? `Option ${b.option.letter}` : 'Before';
  const right = peers ? `Option ${shown.letter}` : 'Now';
  const at = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width > 0) setPos(Math.round(Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100))));
  };
  return (
    <div className="cmp">
      <div className="cmp-tools">
        <Seg role="group" aria-label="How to compare">
          <button type="button" aria-pressed={mode === 'side'} onClick={() => setMode('side')}><Columns2 aria-hidden />Side by side</button>
          <button type="button" aria-pressed={mode === 'swipe'} onClick={() => setMode('swipe')}><SquareSplitHorizontal aria-hidden />Swipe</button>
        </Seg>
      </div>
      <div className="cmp-pickers">
        {before.length > 1 && (
          <div className="cmp-pick">
            <span className="cmp-pick-l" id={beforeId}>{peers ? 'Beside' : 'Before'}</span>
            <Seg role="group" aria-labelledby={beforeId}>
              {before.map((s, i) => <button key={`${s.option.id}${s.picked ? 'p' : ''}`} type="button" aria-pressed={i === bi} onClick={() => setBi(i)} aria-label={sideWords(s)}>{sideShort(s)}</button>)}
            </Seg>
          </div>
        )}
        {n > 1 && (
          <div className="cmp-pick">
            <span className="cmp-pick-l" id={nowId}>{peers ? nowLabel : `Now · ${nowLabel}`}</span>
            <div className="cmp-flick">
              <button type="button" className="icon-btn sm" onClick={() => flick(-1)} aria-label="Previous option"><ChevronLeft aria-hidden /></button>
              <Seg role="group" aria-labelledby={nowId}>
                {options.map((o, i) => <button key={o.id} type="button" aria-pressed={i === index} onClick={() => onIndex(i)} aria-label={`Option ${o.letter}`}>{o.letter}</button>)}
              </Seg>
              <button type="button" className="icon-btn sm" onClick={() => flick(1)} aria-label="Next option"><ChevronRight aria-hidden /></button>
            </div>
          </div>
        )}
      </div>
      {mode === 'side' ? (
        <div className="cmp-side">
          <figure className="cmp-col">
            <figcaption><b>{left}</b>{!peers && <span>{sideWords(b)}</span>}</figcaption>
            <Thumb src={b.option.url} alt={optionAlt(b.option, title)} fit="contain" eager><span className="thumb-letter" aria-hidden>{b.option.letter}</span></Thumb>
          </figure>
          <figure className="cmp-col now">
            <figcaption><b>{right}</b><span>{peers ? nowLabel : `${nowLabel} · option ${shown.letter}`}</span></figcaption>
            <Thumb src={shown.url} alt={optionAlt(shown, title)} fit="contain" eager><span className="thumb-letter" aria-hidden>{shown.letter}</span></Thumb>
          </figure>
        </div>
      ) : (
        <figure className="cmp-swipe-wrap">
          <figcaption className="sr-only">{left}: {sideWords(b)}, on the left of the line. {right}: {nowLabel}, option {shown.letter}, on the right.</figcaption>
          <div className="cmp-swipe" style={{ ['--pos' as string]: `${pos}%` }}
            onPointerDown={(e) => { drag.current = true; e.currentTarget.setPointerCapture(e.pointerId); at(e); }}
            onPointerMove={(e) => { if (drag.current) at(e); }}
            onPointerUp={() => { drag.current = false; }} onPointerCancel={() => { drag.current = false; }}>
            <Thumb src={b.option.url} alt={`${left}: ${optionAlt(b.option, title)}`} fit="contain" eager />
            <div className="cmp-after"><Thumb src={shown.url} alt={`${right}: ${optionAlt(shown, title)}`} fit="contain" eager /></div>
            <span className="cmp-line" aria-hidden><i><ChevronLeft /><ChevronRight /></i></span>
            <span className="cmp-tag l" aria-hidden>{peers ? left : `Before · ${sideShort(b)}`}</span>
            <span className="cmp-tag r" aria-hidden>{peers ? right : `Now · ${shown.letter}`}</span>
            <input className="cmp-range" type="range" min={0} max={100} step={1} value={pos} onChange={(e) => setPos(Number(e.target.value))}
              aria-label={`Line between ${left.toLowerCase()} and ${right.toLowerCase()}`} aria-valuetext={`${pos}% across: ${left.toLowerCase()} to the left, ${right.toLowerCase()} to the right`} />
          </div>
        </figure>
      )}
      <p className="cmp-hint dim">{mode === 'swipe' ? 'Drag across the picture to move the line. ' : ''}<span className="dz-fine">← → flick between this round’s options.</span></p>
    </div>
  );
}

/**
 * Lights down: the option alone on black, as big as the screen allows, full screen where the browser can (else a
 * cover over the page). ← → flick (the page's keys), Esc comes back, and focus returns to where it was.
 */
export function LightsDown({ options, index, onIndex, title, onClose, squint, grey }: {
  options: readonly ThumbnailOption[]; index: number; onIndex: (i: number) => void; title: string; onClose: () => void; squint?: boolean; grey?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const done = useRef(onClose);
  useEffect(() => { done.current = onClose; });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    el.focus({ preventScroll: true });
    // in full screen once the browser says so (whichever request got there), and leaving it is coming back: Esc out
    // of full screen is the browser's, while the cover over the page (where there's no full screen) listens for Esc itself
    let full = document.fullscreenElement === el;
    const change = () => {
      if (document.fullscreenElement === el) { full = true; return; }
      if (full) done.current();
    };
    if (!full && document.fullscreenEnabled && el.requestFullscreen) {
      el.requestFullscreen().catch(() => { /* the cover over the page stays */ });
    }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); done.current(); } };
    document.addEventListener('fullscreenchange', change);
    window.addEventListener('keydown', key);
    const scroll = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('fullscreenchange', change);
      window.removeEventListener('keydown', key);
      document.body.style.overflow = scroll;
      if (document.fullscreenElement === el) document.exitFullscreen().catch(() => { /* already out */ });
      if (back?.isConnected) back.focus({ preventScroll: true });
    };
  }, []);
  // Tab stays on the cover's own buttons while it's up
  const trap = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return;
    const all = [...e.currentTarget.querySelectorAll<HTMLElement>('button')];
    if (!all.length) return;
    const i = all.indexOf(document.activeElement as HTMLElement);
    const next = e.shiftKey ? (i <= 0 ? all.length - 1 : i - 1) : (i === all.length - 1 ? 0 : i + 1);
    e.preventDefault();
    all[next].focus();
  };
  const o = options[index] ?? options[0];
  if (!o) return null;
  const n = options.length;
  return createPortal(
    <div ref={ref} className={`lights${squint ? ' squint' : ''}${grey ? ' grey' : ''}`} role="dialog" aria-modal="true" aria-label={`Lights down: option ${o.letter} for “${title}”`} tabIndex={-1} onKeyDown={trap}>
      <div className="lights-frame"><Thumb src={o.url} alt={optionAlt(o, title)} fit="contain" eager /></div>
      <div className="lights-bar">
        <span className="lights-t"><b>{o.letter}</b>{title}</span>
        {n > 1 && (
          <span className="lights-flick">
            <button type="button" className="lights-btn" onClick={() => onIndex((index - 1 + n) % n)} aria-label="Previous option"><ChevronLeft aria-hidden /></button>
            <span aria-live="polite">{index + 1} of {n}</span>
            <button type="button" className="lights-btn" onClick={() => onIndex((index + 1) % n)} aria-label="Next option"><ChevronRight aria-hidden /></button>
          </span>
        )}
        <span className="lights-hint dz-fine">{n > 1 ? '← → flick · ' : ''}Esc to come back</span>
        <button type="button" className="lights-btn" onClick={onClose} aria-label="Lights up: back to the page"><X aria-hidden /></button>
      </div>
    </div>,
    document.body,
  );
}
