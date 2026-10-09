// Pieces the Editors tab and an editor's Home share: how fresh the copy of Timeliner is, time on a video,
// a video's name ("Raw clip C0045") and square, how sure its shoot is, and the script document it's cut from
// ("Scripts PDF · v3 · from Timeliner", with the site's version as a quieter second link). Due words, time
// worked and title ranges ("Organic 26–30") are in shared/format.ts and shared/workflow.ts, which the server
// uses too.

import { useEffect, useState, type ReactNode } from 'react';
import { FileText, Film } from 'lucide-react';
import type { EditingSync, EditingVideo, EditorFocus, ScriptDoc } from '../../../shared/types';
import { addDays, diffDays, nowInZone, type ISODate } from '../../../shared/dates';
import { compressTitles, isNotMatched, titleNumber } from '../../../shared/workflow';
import { fmtAgo, fmtDate, fmtDow, fmtHour, plural } from '../../../shared/format';

/** Timeliner's web app. Its API has no link to one video, so "Open in Timeliner" opens the app. */
export const TIMELINER_APP = 'https://timeliner.io/';

/** The current time, moved on every `ms`, so "40 min on it" and "3 min ago" stay true between reads. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Seconds on the video so far: the stretches before, plus this one while it runs. */
export const focusSeconds = (f: EditorFocus, now: number) =>
  f.workedSeconds + (f.state === 'on' ? Math.max(0, (now - Date.parse(f.since)) / 1000) : 0);

/** The time on a video for a tile: "25" min, "1:05" hours, then whole hours from 10 ("16"), so it always fits. */
export function tileTime(seconds: number): { n: string; unit: string } {
  const m = Math.max(0, Math.floor(seconds / 60));
  if (m < 60) return { n: String(m), unit: 'min' };
  if (m < 600) return { n: `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`, unit: 'hours' };
  return { n: m < 6000 ? String(Math.floor(m / 60)) : '99+', unit: 'hours' };
}

/** "9:05 AM" in a time zone. */
export const clockTime = (iso: string | number, tz: string) =>
  new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(new Date(iso));

/** When something happened, in `tz`: "12 min ago", "9:05 AM", "yesterday 6:15 PM", "Mon 4:10 PM", "Sep 28". */
export function fmtWhen(iso: string, tz: string, now: number): string {
  if (now - Date.parse(iso) < 3600_000) return fmtAgo(iso, now);
  const day = nowInZone(tz, new Date(iso)).date;
  const today = nowInZone(tz, new Date(now)).date;
  const time = clockTime(iso, tz);
  if (day === today) return time;
  if (day === addDays(today, -1)) return `yesterday ${time}`;
  return diffDays(today, day) < 7 ? `${fmtDow(day)} ${time}` : fmtDate(day, today);
}

/** The time `at` (now, or when something happened) in someone's zone; null when it isn't known or this browser doesn't know it. */
export function localTime(tz: string | null, at: number): string | null {
  if (!tz) return null;
  try { return clockTime(at, tz); } catch { return null; }
}

export const hoursText = ([s, e]: [number, number]) => (e - s >= 24 ? 'around the clock' : `${fmtHour(s)}–${fmtHour(e)}`);

/** "due tomorrow, Fri, Oct 9" inside a sentence: only the first letter lowered. */
export const midSentence = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** How fresh the copy of Timeliner is, in a few quiet words. */
export function syncWords(s: EditingSync, now: number): string {
  if (!s.keySet) return 'Timeliner isn’t connected';
  if (!s.syncedAt) return s.error ? 'Timeliner couldn’t be read yet' : 'Not read from Timeliner yet';
  return `Read from Timeliner ${fmtAgo(s.syncedAt, now)}`;
}

// ── videos ───────────────────────────────────────────────────────────────

/** What a video's square shows: its number as written ("05"), else its first letters. */
export const squareLabel = (title: string) => /\d+/.exec(title)?.[0].slice(-3) ?? (title.trim().slice(0, 2) || '?');

/** A video's square: its number, or a film strip for a raw clip (a camera's number isn't a script's). */
export const squareOf = (v: Pick<EditingVideo, 'title' | 'raw'>): ReactNode => (v.raw ? <Film className="sq-raw" aria-hidden /> : squareLabel(v.title));

export const byTitle = (a: EditingVideo, b: EditingVideo) =>
  Number(a.raw) - Number(b.raw)
  || (titleNumber(a.title) ?? Number.MAX_SAFE_INTEGER) - (titleNumber(b.title) ?? Number.MAX_SAFE_INTEGER) || a.title.localeCompare(b.title);

/** A video by name: a raw camera clip as "Raw clip C0045", a titled video by its title. */
export const videoName = (v: Pick<EditingVideo, 'title' | 'raw'>) => (v.raw ? `Raw clip ${v.title}` : v.title);

/** The same, with "Raw clip" as a quiet word before the camera's name. */
export function VideoName({ v }: { v: Pick<EditingVideo, 'title' | 'raw'> }) {
  return v.raw ? <><span className="ed-raw">Raw clip</span> {v.title}</> : <>{v.title}</>;
}

/** Several videos in a few words: "Organic 01–05", with raw clips counted ("Organic 01–05 and 24 raw clips"). */
export function videoTitles(list: Pick<EditingVideo, 'title' | 'raw'>[]): string {
  const titled = list.filter((v) => !v.raw).map((v) => v.title);
  const clips = list.length - titled.length;
  if (!clips) return compressTitles(titled);
  return titled.length ? `${compressTitles(titled)} and ${plural(clips, 'raw clip')}` : plural(clips, 'raw clip');
}

/** "Oct 14 shoot", or the batch's title when it has no shoot date. */
export const shootWords = (b: { title: string; shootDate: ISODate | null }, today?: ISODate) => (b.shootDate ? `${fmtDate(b.shootDate, today)} shoot` : b.title);

/** "Joshua Shalimar · Oct 6": whose shoot a video is from, as far as it was matched. */
export function shootLabel(v: EditingVideo, today?: ISODate): string {
  const where = v.batch?.shootDate ? fmtDate(v.batch.shootDate, today) : v.batch?.title ?? null;
  return [v.client?.name, where ?? (v.client ? null : v.folder)].filter(Boolean).join(' · ');
}

/**
 * A shoot the site isn't sure of, in the editor's words: "matched by date" (a titled video by its date alone);
 * null when it's sure (a raw clip by its date, a titled video by its editor's raw clips, a pin…) or not matched.
 */
export const likelyWords = (v: EditingVideo): string | null => (!v.batch || v.match.sure ? null : 'matched by date');

/** Open and not matched to a shoot: the "Not matched" chip (the rule, shared with the server's count, is in shared/workflow.ts). */
export const notMatched = isNotMatched;

// ── script documents ─────────────────────────────────────────────────────

/** What opening the document opens: "PDF", "Google Doc"… */
export function docKind(d: ScriptDoc): string {
  if (d.source === 'timeliner') return 'PDF';
  if (d.href.startsWith('/api/files/')) {
    const ext = /\.([a-z0-9]+)$/i.exec(d.name ?? '')?.[1]?.toLowerCase();
    return ext === 'pdf' ? 'PDF' : ext === 'doc' || ext === 'docx' ? 'Word' : 'File';
  }
  if (/\.pdf($|[?#])/i.test(d.href)) return 'PDF';
  if (/docs\.google\.com\/document/i.test(d.href)) return 'Google Doc';
  if (/(docs|drive)\.google\.com/i.test(d.href)) return 'Google Drive';
  return 'Link';
}

/** The document's name, or what it holds ("Scripts 1–30", with its batch where the batch isn't shown beside it). */
export const docName = (d: ScriptDoc, withBatch = false) => d.name?.trim() || (withBatch ? `${d.batchTitle} · scripts ${d.ranges}` : `Scripts ${d.ranges}`);

/** Where the document is from: "Scripts PDF · v3 · from Timeliner"; the site's own by what it is ("Google Doc", "Edited version"). */
export const docSource = (d: ScriptDoc) =>
  (d.source === 'timeliner' ? `Scripts PDF · v${d.version ?? 1} · from Timeliner` : d.edited ? 'Edited version' : docKind(d));

/** The quieter second link's words: the site's version of the script, or the scripts PDF when the site's comes first. */
export const altWords = (d: ScriptDoc) => (d.source === 'timeliner' ? `Scripts PDF · v${d.version ?? 1}` : d.edited ? 'Edited version on the site' : 'Site version');

/** What a video is cut from, in a few words: "Script 5", or the shoot's whole scripts ("Scripts for the Oct 14 shoot"). */
export function scriptWhat(v: EditingVideo, today?: ISODate): string {
  if (v.scriptNumber != null) return `Script ${v.scriptNumber}`;
  return v.batch ? `Scripts for the ${shootWords(v.batch, today)}` : 'The shoot’s scripts';
}

/** The button that opens it: "Open script 5", or "Open the shoot’s scripts" for a raw clip. */
export const openWords = (v: EditingVideo) => (v.scriptNumber != null ? `Open script ${v.scriptNumber}` : 'Open the shoot’s scripts');

/** Why a video has no script link. Editors are told a manager has been asked; managers what it is. */
export function noScriptWords(v: EditingVideo, who: 'editor' | 'manager', today?: ISODate): string {
  if (!v.batch) {
    if (v.match.how === 'pinned') return who === 'editor' ? 'No script for this video' : 'Pinned as not from any batch';
    return who === 'editor' ? 'Not matched yet — a manager has been asked' : 'Not matched to a shoot';
  }
  if (v.scriptIssue === 'not_approved' && v.scriptNumber != null) return `Script ${v.scriptNumber} isn’t approved yet`;
  if (v.scriptNumber != null) return `Script ${v.scriptNumber} · no document yet`;
  return `No scripts PDF for the ${shootWords(v.batch, today)} yet`;
}

/** "being reviewed again": the scripts PDF is in review in Timeliner after this version ("being reviewed" for its first). */
export const reviewWords = (d: ScriptDoc): string | null =>
  (d.source === 'timeliner' && d.inReview ? ((d.version ?? 1) > 1 ? 'being reviewed again' : 'being reviewed') : null);

/** The words a screen reader hears for a document link. */
const docAria = (what: string, d: ScriptDoc) =>
  `Open ${what} in ${d.source === 'timeliner' ? `the scripts PDF, version ${d.version ?? 1}, from Timeliner${reviewWords(d) ? `, ${reviewWords(d)}` : ''}` : `${docName(d, true)}${d.edited ? ', the edited version' : ''}`} (opens in a new tab)`;

/** "being reviewed again", beside a scripts PDF that's in review in Timeliner. */
export const AgainTag = ({ d }: { d: ScriptDoc }) => { const w = reviewWords(d); return w ? <span className="ed-again">{w}</span> : null; };

/** The second document as a quiet link: the site's version, or the scripts PDF when the site's comes first. */
export function AltLink({ d, what = 'the script' }: { d: ScriptDoc | null; what?: string }) {
  if (!d) return null;
  return (
    <a className="ed-alt" href={d.href} target="_blank" rel="noopener noreferrer" aria-label={docAria(what, d)} title={`${docName(d, true)} · ${docSource(d)}`}>
      {altWords(d)}
    </a>
  );
}

/**
 * A video's script as a link to the document it's in: "Script 5" (or "Scripts for the Oct 14 shoot" for a raw clip),
 * with where it's from ("Scripts PDF · v3 · from Timeliner") and the site's version as a quieter second link. As a
 * pill on an editor's rows, or inline in a line of text on the Editors tab.
 */
export function ScriptLink({ v, who, pill, today }: { v: EditingVideo; who: 'editor' | 'manager'; pill?: boolean; today?: ISODate }) {
  const s = v.script;
  if (!s) return <span className="ed-noscript">{noScriptWords(v, who, today)}</span>;
  const what = scriptWhat(v, today);
  const aria = docAria(v.scriptNumber != null ? what.toLowerCase() : `the scripts for the ${v.batch ? shootWords(v.batch, today) : 'shoot'}`, s);
  if (pill) {
    return (
      <span className="ed-slinks">
        <a className="eh-slink" href={s.href} target="_blank" rel="noopener noreferrer" aria-label={aria} title={`${docName(s, true)} · ${docSource(s)}`}>
          <FileText aria-hidden />
          <span className="eh-slink-txt"><b>{what}</b><small>{docSource(s)}{reviewWords(s) && <span className="ed-again-t"> · {reviewWords(s)}</span>}</small></span>
        </a>
        <AltLink d={s.alt} what={what.toLowerCase()} />
      </span>
    );
  }
  return (
    <span className="ed-slinks">
      <a className="ed-doc" href={s.href} target="_blank" rel="noopener noreferrer" aria-label={aria} title={`${docName(s, true)} · ${docSource(s)}`}>
        <FileText aria-hidden />{what}
      </a>
      <span className={`ed-kind${s.source === 'timeliner' ? ' ed-kind-tl' : ''}`}>{docSource(s)}</span>
      <AgainTag d={s} />
      <AltLink d={s.alt} what={what.toLowerCase()} />
    </span>
  );
}
