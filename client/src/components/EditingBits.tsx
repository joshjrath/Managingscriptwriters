// Pieces the Editors tab and an editor's Home share: how fresh the copy of Timeliner is, time on a video,
// the script document a video is cut from, and a video's square. Due words, time worked and title ranges
// ("Organic 26–30") are in shared/format.ts and shared/workflow.ts, which the server uses too.

import { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import type { EditingSync, EditingVideo, EditorFocus, ScriptDoc } from '../../../shared/types';
import { addDays, diffDays, nowInZone, type ISODate } from '../../../shared/dates';
import { titleNumber } from '../../../shared/workflow';
import { fmtAgo, fmtDate, fmtDow, fmtHour } from '../../../shared/format';

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

export const byTitle = (a: EditingVideo, b: EditingVideo) =>
  (titleNumber(a.title) ?? Number.MAX_SAFE_INTEGER) - (titleNumber(b.title) ?? Number.MAX_SAFE_INTEGER) || a.title.localeCompare(b.title);

/** "Joshua Shalimar · Oct 6": whose shoot a video is from, as far as it was matched. */
export function shootLabel(v: EditingVideo, today?: ISODate): string {
  const where = v.batch?.shootDate ? fmtDate(v.batch.shootDate, today) : v.batch?.title ?? null;
  return [v.client?.name, where ?? (v.client ? null : v.folder)].filter(Boolean).join(' · ');
}

// ── script documents ─────────────────────────────────────────────────────

/** What opening the document opens: "PDF", "Google Doc"… */
export function docKind(d: ScriptDoc): string {
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

/** A video's script, as a link to the document it's in (the edited version when there is one). */
export function ScriptLink({ v, className = 'ed-doc', label }: { v: EditingVideo; className?: string; label?: string }) {
  if (!v.script) {
    return <span className="ed-noscript">{v.batch && v.scriptNumber ? `Script ${v.scriptNumber} · no document yet` : 'Script not matched yet'}</span>;
  }
  const what = `Script ${v.scriptNumber}`;
  return (
    <a className={className} href={v.script.href} target="_blank" rel="noopener noreferrer"
      aria-label={`Open ${what.toLowerCase()} in ${docName(v.script, true)}${v.script.edited ? ', the edited version' : ''} (opens in a new tab)`}
      title={`${docName(v.script, true)}${v.script.edited ? ' · edited version' : ''}`}>
      <FileText aria-hidden />{label ?? what}
    </a>
  );
}
