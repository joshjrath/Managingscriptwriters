// Pieces the thumbnail pages share (the Studio, a brief, the Thumbnails board): a brief's picture, state and due
// words, the quick checks on an image (SpecChips), the drop zone (drop anywhere on the page, paste, or choose),
// an option's frame (OptionSlot, plus the empty and not-yet-added slots), Preview in the wild (every option at the
// sizes people meet it in a feed, on a plain light or dark feed), the round film strip with its compare, the brief
// card and the client's look. Everything is built on ui.tsx and the .studio / .thumb styles in app.css.

import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, Check, ChevronDown, Columns2, Contrast, ExternalLink, Eye, Frame, Glasses, ImagePlus, Loader2, Moon, RotateCcw, Smartphone, Sun, Upload,
} from 'lucide-react';
import {
  isOpenThumb, MAX_OPTIONS, OPTION_LETTERS, THUMB_MIMES, THUMB_STATE_COLOR, THUMB_STATE_LABEL, thumbSpecChecks, type ThumbState,
} from '../../../shared/workflow';
import { fileUrl, RESOURCE_LABEL, type ThumbnailBrief, type ThumbnailDecision, type ThumbnailLook, type ThumbnailOption, type ThumbnailRound, type ThumbnailWin } from '../../../shared/types';
import { dueWords, fmtAgo, fmtLong, fmtDate, plural, type DueTone } from '../../../shared/format';
import type { ISODate } from '../../../shared/dates';
import { Button, Chip, Field, inputProps, Seg, Thumb, useFieldId } from './ui';

// ── a brief's picture and words ─────────────────────────────────────────

/** The colour of a brief's title card: one of the accents, the same one every time for the same brief. */
const TONES = ['var(--salmon)', 'var(--cyan)', 'var(--lavender)', 'var(--mint)', 'var(--pink)', 'var(--yellow)'];
export const toneFor = (id: number) => TONES[Math.abs(id) % TONES.length];

/** What a screen reader hears for an option: "Option B for “Why dentists hate this”, by Ana". */
export const optionAlt = (o: { letter: string; uploadedByName?: string | null }, title: string) =>
  `Option ${o.letter} for “${title}”${o.uploadedByName ? `, by ${o.uploadedByName}` : ''}`;

/** A brief's picture: its winner, else the newest option sent (or, for its designer, the tray's first), else its title card. */
export function BriefThumb({ brief, eager, children, className }: { brief: ThumbnailBrief; eager?: boolean; children?: ReactNode; className?: string }) {
  const c = brief.cover;
  return (
    <Thumb src={c?.url} alt={c ? `${c.picked ? 'Picked option' : 'Option'} ${c.letter} for “${brief.title}”` : `${brief.title}, ${brief.clientName}: nothing made yet`}
      title={brief.title} sub={brief.clientName} tone={toneFor(brief.id)} eager={eager} className={className}>
      {children}
    </Thumb>
  );
}

/** "Drafting · 2 options", "In review · round 2", "Picked · B". */
export function stateWords(b: Pick<ThumbnailBrief, 'state' | 'draftOptions' | 'roundsSent' | 'winner'>): string {
  switch (b.state) {
    case 'drafting': return `${THUMB_STATE_LABEL.drafting} · ${plural(b.draftOptions, 'option')}`;
    case 'in_review': return b.roundsSent > 1 ? `${THUMB_STATE_LABEL.in_review} · round ${b.roundsSent}` : THUMB_STATE_LABEL.in_review;
    case 'picked': return b.winner ? `${THUMB_STATE_LABEL.picked} · ${b.winner.letter}` : THUMB_STATE_LABEL.picked;
    default: return THUMB_STATE_LABEL[b.state];
  }
}

export function StateChip({ brief }: { brief: Pick<ThumbnailBrief, 'state' | 'draftOptions' | 'roundsSent' | 'winner'> }) {
  const icon = brief.state === 'picked' ? <Check aria-hidden /> : brief.state === 'changes' ? <RotateCcw aria-hidden /> : undefined;
  return <Chip color={THUMB_STATE_COLOR[brief.state]} dot={!icon} icon={icon}>{stateWords(brief)}</Chip>;
}

const DUE_COLOR: Record<DueTone, string> = { late: 'red', today: 'yellow', soon: 'yellow', plain: 'plain' };

/** When an open brief is due, in words and never colour alone; nothing once it's picked or cancelled, or with no date. */
export function DueTag({ dueOn, today, state }: { dueOn: ISODate | null; today: ISODate; state?: ThumbState }) {
  if (state && !isOpenThumb(state)) return null;
  const d = dueWords(dueOn, today);
  if (!d) return null;
  return <Chip color={DUE_COLOR[d.tone]} icon={d.tone === 'late' ? <AlertTriangle aria-hidden /> : undefined}>{d.text}</Chip>;
}

// ── quick checks ─────────────────────────────────────────────────────────

/**
 * The quick checks on an image (shared/workflow.ts thumbSpecChecks): size, widescreen shape, YouTube's 2 MB and the
 * file type. They only warn. An image not measured yet (width 0) shows only what's known: its weight and type.
 */
export function SpecChips({ img, details = true }: { img: { width: number; height: number; size: number; mime: string }; details?: boolean }) {
  const known = img.width > 0 && img.height > 0;
  const checks = thumbSpecChecks(img).filter((c) => known || (c.key !== 'size' && c.key !== 'shape'));
  const issues = checks.filter((c) => !c.ok);
  return (
    <div className="spec">
      <ul className="spec-chips" aria-label={issues.length ? `Quick checks: ${plural(issues.length, 'thing')} to look at` : 'Quick checks: all fine'}>
        {checks.map((c) => (
          <li key={c.key}>
            <Chip color={c.ok ? 'plain' : 'yellow'} icon={c.ok ? <Check aria-hidden /> : <AlertTriangle aria-hidden />} title={c.detail ?? undefined}>
              {c.label}{!c.ok && !details && <span className="sr-only">: {c.detail}</span>}
            </Chip>
          </li>
        ))}
      </ul>
      {details && issues.length > 0 && <ul className="spec-notes">{issues.map((c) => <li key={c.key}>{c.detail}</li>)}</ul>}
    </div>
  );
}

// ── reading a picked, pasted or dropped image ───────────────────────────

/** An image read in the browser, before it's uploaded: a data: preview (what the page's CSP allows) and its size. */
export interface Picture { src: string | null; width: number; height: number; size: number; mime: string }

/** Bigger than this isn't read into the page for a preview (it would only slow the tab); it still uploads. */
export const PREVIEW_MAX_BYTES = 20 * 1024 * 1024;

/** The kept image type a file looks like (by its type, or its name when the system gives none), or null. The server reads the bytes itself. */
export function pictureType(f: File): (typeof THUMB_MIMES)[number] | null {
  const t = f.type.toLowerCase();
  const hit = THUMB_MIMES.find((m) => m === t);
  if (hit) return hit;
  if (t) return null;
  const ext = f.name.toLowerCase().split('.').pop() ?? '';
  return ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : null;
}

/** Reads a file for its preview and size. Never fails: an image the browser can't show comes back with no preview. */
export function readPicture(file: File): Promise<Picture> {
  const base = { size: file.size, mime: pictureType(file) ?? file.type, width: 0, height: 0, src: null };
  if (file.size > PREVIEW_MAX_BYTES) return Promise.resolve(base);
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onerror = () => resolve(base);
    r.onload = () => {
      const src = typeof r.result === 'string' ? r.result : null;
      if (!src) { resolve(base); return; }
      const img = new Image();
      img.onload = () => resolve({ ...base, src, width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => resolve(base);
      img.src = src;
    };
    r.readAsDataURL(file);
  });
}

// ── the drop zone ────────────────────────────────────────────────────────

export interface DropZoneHandle { open: () => void }

/**
 * Takes images three ways: dropped anywhere on the page (a full-screen hint shows while dragging), pasted (⌘V or
 * Ctrl+V, straight from Photoshop or Figma), or chosen with the picker, which is all a phone offers. Every image
 * goes to `onFiles`, which decides; `blocked` says why nothing more can be added right now.
 */
export const DropZone = forwardRef<DropZoneHandle, { onFiles: (files: File[]) => void; next: string | null; blocked?: string | null }>(function DropZone({ onFiles, next, blocked }, ref) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const take = useRef(onFiles);
  useEffect(() => { take.current = onFiles; });
  useImperativeHandle(ref, () => ({ open: () => input.current?.click() }), []);
  useEffect(() => {
    let depth = 0;
    const files = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    const enter = (e: DragEvent) => { if (!files(e)) return; e.preventDefault(); depth += 1; setOver(true); };
    const move = (e: DragEvent) => { if (!files(e)) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; };
    const leave = (e: DragEvent) => { if (!files(e)) return; depth = Math.max(0, depth - 1); if (!depth) setOver(false); };
    const drop = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      depth = 0;
      setOver(false);
      const list = Array.from(e.dataTransfer?.files ?? []);
      if (list.length) take.current(list);
    };
    const paste = (e: ClipboardEvent) => {
      const list = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
      if (!list.length) return;
      e.preventDefault();
      take.current(list);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', move);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    window.addEventListener('paste', paste);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', move);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
      window.removeEventListener('paste', paste);
    };
  }, []);
  return (
    <div className={`dz${blocked ? ' off' : ''}`}>
      <span className="dz-ic" aria-hidden><ImagePlus /></span>
      <div className="dz-txt">
        <b>{blocked ?? (next ? `Add option ${next}` : 'Add an option')}</b>
        <span className="dz-fine">Drop an image anywhere on this page, or paste it straight from Photoshop or Figma (⌘V or Ctrl+V).</span>
        <span className="dz-coarse">Choose a PNG, JPG or WebP from your phone.</span>
        <span className="dz-spec">1280×720 is best. The checks below each option only warn: nothing is refused for its size.</span>
      </div>
      <Button variant="primary pill" icon={<Upload aria-hidden />} disabled={!!blocked} onClick={() => input.current?.click()}>Choose image</Button>
      <input ref={input} className="sr-only" type="file" tabIndex={-1} aria-hidden accept={THUMB_MIMES.join(',')} multiple
        onChange={(e) => { const list = Array.from(e.target.files ?? []); e.target.value = ''; if (list.length) onFiles(list); }} />
      {over && (
        <div className="dz-over" aria-hidden>
          <div className="dz-over-card"><ImagePlus /><b>{blocked ?? `Drop to add option ${next ?? ''}`.trim()}</b></div>
        </div>
      )}
    </div>
  );
});

// ── option slots ─────────────────────────────────────────────────────────

/** One option in its 16:9 frame: its letter, the picture, the designer's one line, the checks, and what can be done. */
export function OptionSlot({ option, title, fit = 'cover', eager, actions, checks = true, className = '' }: {
  option: ThumbnailOption; title: string; fit?: 'cover' | 'contain'; eager?: boolean; actions?: ReactNode; checks?: boolean; className?: string;
}) {
  return (
    <figure className={`opt${option.picked ? ' picked' : ''} ${className}`}>
      <Thumb src={option.url} alt={optionAlt(option, title)} fit={fit} eager={eager}>
        <span className="thumb-letter" aria-hidden>{option.letter}</span>
        {option.picked && <span className="thumb-tr"><Chip color="mint" icon={<Check aria-hidden />}>Picked</Chip></span>}
      </Thumb>
      <figcaption className="opt-cap">
        {option.note && <p className="opt-note">“{option.note}”</p>}
        {checks && <SpecChips img={option} />}
        {actions && <div className="opt-acts">{actions}</div>}
      </figcaption>
    </figure>
  );
}

/**
 * A letter still free in the tray: tapping it opens the picker. `compact` is a short tile with just its letter, for
 * an empty tray, where the drop zone already says how to add an image.
 */
export function EmptySlot({ letter, onPick, disabled, compact }: { letter: string; onPick: () => void; disabled?: boolean; compact?: boolean }) {
  return (
    <button type="button" className={`opt empty${compact ? ' compact' : ''}`} onClick={onPick} disabled={disabled} aria-label={`Option ${letter}: choose an image`}>
      <span className="opt-empty-frame">
        <span className="opt-empty-l" aria-hidden>{letter}</span>
        {compact
          ? <ImagePlus className="opt-empty-ic" aria-hidden />
          : <span className="opt-empty-t"><ImagePlus aria-hidden /><span className="dz-fine">Drop, paste or choose</span><span className="dz-coarse">Choose image</span></span>}
      </span>
    </button>
  );
}

export type PendingStatus = 'reading' | 'staged' | 'waiting' | 'uploading' | 'error';

/**
 * An image just dropped, pasted or chosen: in its frame at once with its quick checks and a one-line "why this one",
 * and in the tray once it's added (one upload each, in order).
 */
export function PendingSlot({ letter, name, pic, status, note, error, onNote, onAdd, onDiscard, onPreview }: {
  letter: string; name: string; pic: Picture | null; status: PendingStatus; note: string; error: string | null;
  onNote: (note: string) => void; onAdd: () => void; onDiscard: () => void; onPreview: () => void;
}) {
  const nid = useFieldId('opt-note');
  const busy = status === 'waiting' || status === 'uploading';
  const open = status === 'staged' || status === 'error';
  return (
    <div className={`opt pending ${status}`}>
      <Thumb src={pic?.src} alt={`New option ${letter}: ${name}`} title={pic && !pic.src ? 'Too big to preview here' : name} sub={`Option ${letter} · not in your tray yet`} tone="var(--neutral)">
        <span className="thumb-letter" aria-hidden>{letter}</span>
        {(busy || status === 'reading') && (
          <span className="opt-progress" role="status"><Loader2 className="spin" aria-hidden />{status === 'reading' ? 'Reading…' : status === 'uploading' ? `Adding option ${letter}…` : 'Next in line…'}</span>
        )}
      </Thumb>
      <div className="opt-cap">
        {pic && <SpecChips img={pic} />}
        {status === 'error' && error && <p className="opt-err" role="alert"><AlertTriangle aria-hidden />{error}</p>}
        {open && (
          <>
            <Field label="Why this one?" optional htmlFor={nid}>
              <input className="input sm" value={note} maxLength={500} placeholder="One line, e.g. the face reads from across the room" onChange={(e) => onNote(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onAdd(); } }} {...inputProps(nid)} />
            </Field>
            <div className="opt-acts">
              <Button variant="primary pill" icon={<Check aria-hidden />} onClick={onAdd}>{status === 'error' ? 'Try again' : `Add as option ${letter}`}</Button>
              {pic?.src && <Button variant="sm ghost" icon={<Eye aria-hidden />} onClick={onPreview}>Preview</Button>}
              <Button variant="sm ghost" onClick={onDiscard} aria-label={`Discard ${name}`}>Discard</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Preview in the wild ──────────────────────────────────────────────────

/** Something to preview: an option, or an image not in the tray yet. */
export interface WildItem { key: string; letter: string; src: string | null; alt: string }

const FEED_KEY = 'sm.wild.feed';
const readFeed = (): 'light' | 'dark' => { try { return localStorage.getItem(FEED_KEY) === 'light' ? 'light' : 'dark'; } catch { return 'dark'; } };

/** A video's length badge, as a feed shows it in the corner. Made up: it's only there to show what it covers. */
const STAMP = '12:08';

/**
 * Every option the way viewers meet it: a home feed card (about 360 px), a search result (246), up next (168), a
 * phone's feed and arm's length (120), on a plain light or dark feed with a length badge in the corner, captioned
 * with the brief's title and client, beside the client's recent winners. Squint blurs, Greyscale drains the colour,
 * Safe zone marks what the badge covers and the edges a crop can take. A generic mock-up: no platform's logos or chrome.
 */
export function PreviewInTheWild({ items, pick, onPick, title, clientName, winners }: {
  items: WildItem[]; pick: string | null; onPick: (key: string) => void; title: string; clientName: string; winners: ThumbnailWin[];
}) {
  const [feed, setFeedState] = useState<'light' | 'dark'>(readFeed);
  const setFeed = (f: 'light' | 'dark') => { setFeedState(f); try { localStorage.setItem(FEED_KEY, f); } catch { /* private mode: this visit only */ } };
  const [squint, setSquint] = useState(false);
  const [grey, setGrey] = useState(false);
  const [safe, setSafe] = useState(false);
  const cur = items.find((i) => i.key === pick) ?? items[0] ?? null;
  if (!cur) return <p className="muted wild-none">Nothing to preview yet. Add an option and it shows up here at feed sizes.</p>;
  const others = winners.slice(0, 3);
  const mine = { src: cur.src, alt: cur.alt, title, channel: clientName, meta: `Option ${cur.letter}` };
  const theirs = others.map((w) => ({ key: w.option.id, src: w.option.url, alt: `Picked thumbnail for “${w.title}”`, title: w.title, channel: w.clientName, meta: 'Picked earlier' }));
  return (
    <div className="wild-wrap">
      <div className="wild-tools">
        {items.length > 1 && (
          <Seg role="group" aria-label="Option to preview">
            {items.map((i) => <button key={i.key} type="button" aria-pressed={i.key === cur.key} onClick={() => onPick(i.key)} aria-label={`Option ${i.letter}`}>{i.letter}</button>)}
          </Seg>
        )}
        <Seg role="group" aria-label="Feed">
          <button type="button" aria-pressed={feed === 'light'} onClick={() => setFeed('light')}><Sun aria-hidden />Light</button>
          <button type="button" aria-pressed={feed === 'dark'} onClick={() => setFeed('dark')}><Moon aria-hidden />Dark</button>
        </Seg>
        <div className="wild-toggles" role="group" aria-label="Checks">
          <button type="button" className="wild-tg" aria-pressed={squint} onClick={() => setSquint((v) => !v)} title="Does it read small?"><Glasses aria-hidden />Squint</button>
          <button type="button" className="wild-tg" aria-pressed={grey} onClick={() => setGrey((v) => !v)} title="Does it work without colour?"><Contrast aria-hidden />Greyscale</button>
          <button type="button" className="wild-tg" aria-pressed={safe} onClick={() => setSafe((v) => !v)} title="What the length badge covers, and the edges a crop can take"><Frame aria-hidden />Safe zone</button>
        </div>
      </div>
      <div className={`wild ${feed}${squint ? ' squint' : ''}${grey ? ' grey' : ''}${safe ? ' safe' : ''}`}>
        <WildRow label="Home feed" size="about 360 px wide">
          <div className="wild-home">
            <FeedCard item={mine} size="home" you />
            {theirs.map((t) => <FeedCard key={t.key} item={t} size="home" />)}
          </div>
        </WildRow>
        <WildRow label="Search results" size="about 246 px">
          <div className="wild-list">
            <FeedLine item={mine} size="search" you />
            {theirs.slice(0, 1).map((t) => <FeedLine key={t.key} item={t} size="search" />)}
          </div>
        </WildRow>
        <div className="wild-pair">
          <WildRow label="Up next" size="about 168 px">
            <div className="wild-list">
              <FeedLine item={mine} size="next" you />
              {theirs.slice(0, 2).map((t) => <FeedLine key={t.key} item={t} size="next" />)}
            </div>
          </WildRow>
          <WildRow label="Phone" size="a phone’s feed" icon={<Smartphone aria-hidden />}>
            <div className="wild-phone">
              <FeedCard item={mine} size="phone" you />
              {theirs.slice(0, 1).map((t) => <FeedLine key={t.key} item={t} size="phone-line" />)}
            </div>
          </WildRow>
        </div>
        <WildRow label="Arm’s length" size="about 120 px">
          <div className="wild-tiny">
            <WildFrame item={mine} size="tiny" you />
            {theirs.map((t) => <WildFrame key={t.key} item={t} size="tiny" />)}
          </div>
        </WildRow>
      </div>
      {!others.length && <p className="wild-foot muted">Once {clientName} has picked thumbnails on other briefs, they show up beside yours here.</p>}
    </div>
  );
}

interface FeedItem { src: string | null; alt: string; title: string; channel: string; meta: string }

function WildRow({ label, size, icon, children }: { label: string; size: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <section className="wild-row" aria-label={`${label}, ${size}`}>
      <div className="wild-h">{icon}<b>{label}</b><span>{size}</span></div>
      {children}
    </section>
  );
}

function WildFrame({ item, size, you }: { item: Pick<FeedItem, 'src' | 'alt'> & Partial<FeedItem>; size: string; you?: boolean }) {
  return (
    <div className={`wild-frame ${size}${you ? ' you' : ''}`}>
      <Thumb src={item.src} alt={item.alt} title={item.title} tone="var(--neutral)">
        <span className="wild-safe" aria-hidden><i /></span>
        <span className="wild-time" aria-hidden>{STAMP}</span>
      </Thumb>
    </div>
  );
}

function FeedCard({ item, size, you }: { item: FeedItem; size: string; you?: boolean }) {
  return (
    <div className={`wild-card ${size}${you ? ' you' : ''}`}>
      <WildFrame item={item} size={size} you={you} />
      <div className="wild-cap">
        <span className="wild-av" aria-hidden>{item.channel.slice(0, 1).toUpperCase()}</span>
        <span className="wild-txt"><b>{item.title}</b><span>{item.channel}</span><span>{item.meta}</span></span>
      </div>
    </div>
  );
}

function FeedLine({ item, size, you }: { item: FeedItem; size: string; you?: boolean }) {
  return (
    <div className={`wild-line ${size}${you ? ' you' : ''}`}>
      <WildFrame item={item} size={size} you={you} />
      <span className="wild-txt"><b>{item.title}</b><span>{item.channel}</span><span>{item.meta}</span></span>
    </div>
  );
}

// ── the round film strip ─────────────────────────────────────────────────

/** "B picked", "Changes asked": a decision in a few words. */
const decisionWords = (d: ThumbnailDecision) => (d.action === 'pick' ? `${d.optionLetter ?? 'An option'} picked` : 'Changes asked');

/**
 * The brief's story as a film strip: Round 1 A B C → changes asked, with the note → Round 2 → B picked; the tray
 * at the end for its designer. Compare puts this round (the tray, while one is being drafted) beside the last.
 */
export function RoundStrip({ rounds, tray, title, nextRound, now }: { rounds: ThumbnailRound[]; tray: ThumbnailRound | null; title: string; nextRound: number; now: number }) {
  const [comparing, setComparing] = useState(false);
  const cid = useId();
  const sent = rounds.filter((r) => r.sentAt);
  const drafting = tray && tray.options.length ? tray : null;
  // the story's newest step (the pick, the round waiting, the tray) in view: a strip wider than its panel starts at its end
  const track = useRef<HTMLOListElement>(null);
  const story = [...sent.map((r) => `${r.id}:${r.decisions.length}`), drafting ? `t${drafting.options.length}` : ''].join(',');
  useEffect(() => {
    const el = track.current;
    if (el && el.scrollWidth > el.clientWidth) el.scrollLeft = el.scrollWidth;
  }, [story]);
  // this round against the last: the tray against the newest sent, else the newest two sent (of those with options
  // to show: a round another designer sent before the brief came to you shows only its winner, if any)
  const shown = sent.filter((r) => r.options.length);
  const pair = drafting && shown.length ? { a: shown[shown.length - 1], b: drafting } : shown.length >= 2 ? { a: shown[shown.length - 2], b: shown[shown.length - 1] } : null;
  const label = (r: ThumbnailRound) => (r.sentAt ? `Round ${r.number}` : `Round ${r.number}, in your tray`);
  if (!sent.length && !drafting) return null;
  return (
    <section className="panel rs" aria-label="Rounds so far">
      <div className="panel-head">
        <h2>Rounds</h2>
        <span className="sub">{sent.length ? `${plural(sent.length, 'round')} sent` : 'nothing sent yet'}</span>
        {pair && (
          <div className="tools">
            <Button variant="sm ghost" icon={<Columns2 aria-hidden />} aria-expanded={comparing} aria-controls={cid} onClick={() => setComparing((v) => !v)}>
              {comparing ? 'Hide compare' : `Compare ${pair.b.sentAt ? `round ${pair.b.number}` : 'your tray'} with round ${pair.a.number}`}
            </Button>
          </div>
        )}
      </div>
      <ol className="rs-track" ref={track}>
        {sent.map((r, i) => {
          const dec = r.decisions[0] ?? null;
          return (
            <li key={r.id} className="rs-group">
              <div className={`rs-step rs-round${r.superseded ? ' old' : ''}`}>
                <div className="rs-h"><b>Round {r.number}</b><span>{r.createdByName} · {fmtAgo(r.sentAt!, now)}</span></div>
                {r.options.length ? (
                  <div className="rs-opts">
                    {r.options.map((o) => (
                      <span key={o.id} className={`rs-opt${o.picked ? ' picked' : ''}`}>
                        <Thumb src={o.url} alt={optionAlt(o, title)}><span className="thumb-letter" aria-hidden>{o.letter}</span></Thumb>
                      </span>
                    ))}
                  </div>
                ) : <p className="rs-note dim">{r.createdByName}’s options stay private to them</p>}
                {r.note && <p className="rs-note">“{r.note}”</p>}
              </div>
              {dec ? (
                <div className={`rs-step rs-dec ${dec.action}`}>
                  <Chip color={dec.action === 'pick' ? 'mint' : 'pink'} icon={dec.action === 'pick' ? <Check aria-hidden /> : <RotateCcw aria-hidden />}>{decisionWords(dec)}</Chip>
                  {dec.note && <p className="rs-note">“{dec.note}”</p>}
                  <span className="rs-by">{dec.decidedByName} · {fmtAgo(dec.createdAt, now)}{r.decisions.length > 1 ? ' · decided again' : ''}</span>
                </div>
              ) : (
                <div className={`rs-step rs-dec ${r.superseded ? 'skip' : 'wait'}`}>
                  <span className="rs-by">{!r.superseded ? 'Waiting on a manager' : sent[i + 1] ? `Replaced by round ${sent[i + 1].number} before anyone decided` : 'Replaced by a newer round before anyone decided'}</span>
                </div>
              )}
            </li>
          );
        })}
        {drafting && (
          <li className="rs-group">
            <div className="rs-step rs-round tray">
              <div className="rs-h"><b>Round {nextRound}</b><span>in your tray · {plural(drafting.options.length, 'option')}</span></div>
              <div className="rs-opts">
                {drafting.options.map((o) => (
                  <span key={o.id} className="rs-opt"><Thumb src={o.url} alt={optionAlt(o, title)}><span className="thumb-letter" aria-hidden>{o.letter}</span></Thumb></span>
                ))}
              </div>
            </div>
          </li>
        )}
      </ol>
      {pair && comparing && (
        <div id={cid} className="rs-compare">
          {[pair.a, pair.b].map((r) => (
            <div key={r.id} className="rs-col">
              <div className="rs-col-h"><b>{label(r)}</b>{r.decisions[0] && <Chip color={r.decisions[0].action === 'pick' ? 'mint' : 'pink'}>{decisionWords(r.decisions[0])}</Chip>}</div>
              {r.decisions[0]?.action === 'changes' && r.decisions[0].note && <p className="rs-note">“{r.decisions[0].note}”</p>}
              <div className="rs-col-opts">
                {r.options.map((o) => <OptionSlot key={o.id} option={o} title={title} fit="contain" checks={false} />)}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ── the brief and the client's look ─────────────────────────────────────

/** What the manager asked for: the video's title, client, shoot, what to show, words for the image, how many options, when. */
export function BriefCard({ brief, today, tools }: { brief: ThumbnailBrief; today: ISODate; tools?: ReactNode }) {
  const hid = useId();
  const letters = OPTION_LETTERS.slice(0, Math.min(MAX_OPTIONS, Math.max(1, brief.optionsWanted))).join(' ');
  return (
    <section className="panel tb-brief" aria-labelledby={hid}>
      <div className="tb-brief-top"><StateChip brief={brief} /><DueTag dueOn={brief.dueOn} today={today} state={brief.state} /></div>
      <div className="tb-kicker">{brief.clientName}{brief.shootDate ? ` · shoot ${fmtDate(brief.shootDate, today)}` : ''}</div>
      <h2 id={hid} className="tb-title">{brief.title}</h2>
      <dl className="tb-facts">
        <div className="wide"><dt>What it should show</dt><dd className="pre">{brief.brief ?? <span className="dim">Nothing written: go from the title and the client’s look.</span>}</dd></div>
        <div className="wide"><dt>Words on the image</dt><dd>{brief.onImage ? <span className="tb-words">{brief.onImage}</span> : <span className="dim">None suggested</span>}</dd></div>
        <div><dt>Options wanted</dt><dd>{brief.optionsWanted} <span className="dim">({letters})</span></dd></div>
        <div><dt>Due</dt><dd>{brief.dueOn ? fmtLong(brief.dueOn) : <span className="dim">No date</span>}</dd></div>
        <div><dt>Designer</dt><dd>{brief.needsDesigner ? <span className="dim">Needs a designer</span> : brief.designerName}</dd></div>
        <div><dt>From</dt><dd>{brief.createdByName}</dd></div>
      </dl>
      {tools}
    </section>
  );
}

/** The client's brand voice and guidance, with their logos and reference images as pictures and other resources as links. */
export function ClientLook({ look }: { look: ThumbnailLook }) {
  const [open, setOpen] = useState(() => typeof window === 'undefined' || !window.matchMedia('(max-width: 760px)').matches);
  const bid = useId();
  const pics = look.images.filter((r) => r.fileId != null);
  const empty = !look.brandVoice && !look.guidance && !pics.length && !look.resources.length;
  const what = [pics.length && plural(pics.length, 'picture'), look.brandVoice && 'brand voice', look.guidance && 'guidance', look.resources.length && plural(look.resources.length, 'link')].filter(Boolean).join(' · ');
  return (
    <section className="panel tb-look">
      <button type="button" className="tb-look-head" aria-expanded={open} aria-controls={bid} onClick={() => setOpen((v) => !v)}>
        <span className="tb-look-t"><b>{look.clientName}’s look</b><span>{what || 'nothing saved yet'}</span></span>
        <ChevronDown className={`chev${open ? ' up' : ''}`} aria-hidden />
      </button>
      {open && (
        <div id={bid} className="tb-look-body">
          {empty && <p className="muted">No brand voice, guidance or pictures saved for {look.clientName} yet. Managers add them on the client’s page.</p>}
          {pics.length > 0 && (
            <ul className="tb-pics">
              {pics.map((r) => (
                <li key={r.id}>
                  <a className="tb-pic" href={fileUrl(r.fileId!)} target="_blank" rel="noopener noreferrer" aria-label={`${r.title} (opens full size in a new tab)`}>
                    <Thumb src={fileUrl(r.fileId!)} alt={r.title} fit="contain" />
                    <span className="tb-pic-t">{r.title}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
          {look.brandVoice && <div className="tb-look-txt"><div className="section-title">Brand voice</div><p className="pre">{look.brandVoice}</p></div>}
          {look.guidance && <div className="tb-look-txt"><div className="section-title">Guidance</div><p className="pre">{look.guidance}</p></div>}
          {look.resources.length > 0 && (
            <ul className="tb-look-res">
              {look.resources.map((r) => {
                const href = r.kind === 'file' && r.fileId != null ? fileUrl(r.fileId) : r.url;
                if (!href) return null;
                return (
                  <li key={r.id}>
                    <a className="link" href={href} target="_blank" rel="noopener noreferrer">{r.title}<ExternalLink aria-hidden /></a>
                    <span className="dim">{RESOURCE_LABEL[r.category]}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

// ── a brief on a board ──────────────────────────────────────────────────

/** One brief on a board or the Studio: its picture (or title card) with its state, then its title, client and due date. */
export function BriefTile({ brief, to, today, foot, eager, designer }: { brief: ThumbnailBrief; to: string; today: ISODate; foot?: ReactNode; eager?: boolean; designer?: boolean }) {
  const due = isOpenThumb(brief.state) ? dueWords(brief.dueOn, today) : null;
  const who = designer ? (brief.needsDesigner ? 'needs a designer' : brief.designerName) : null;
  return (
    <article className={`bt ${brief.state}`}>
      <Link to={to} className="bt-link" aria-label={`${brief.title}, ${brief.clientName}: ${stateWords(brief)}${due ? `, ${due.text.toLowerCase()}` : ''}${who ? `, ${who}` : ''}`}>
        <BriefThumb brief={brief} eager={eager}>
          <span className="thumb-tl"><StateChip brief={brief} /></span>
          {brief.roundsSent > 0 && <span className="thumb-tr thumb-pill" aria-hidden>R{brief.roundsSent}</span>}
        </BriefThumb>
        <span className="bt-body">
          <b className="bt-title">{brief.title}</b>
          <span className="bt-meta">
            <span className="ellipsis">{brief.clientName}{who ? ` · ${who}` : ''}</span>
            {due && <span className={`eh-due ${due.tone}`}>{due.text}</span>}
          </span>
        </span>
      </Link>
      {foot && <div className="bt-foot">{foot}</div>}
    </article>
  );
}
