// Pieces the Editors tab and an editor's Home share: how fresh the copy of Timeliner is, time on a video,
// due words, the script document a video is cut from, and short labels for videos ("Organic 26–30").

import { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import type { EditingSync, EditingVideo, EditorFocus, ScriptDoc } from '../../../shared/types';
import { addDays, diffDays, nowInZone, type ISODate } from '../../../shared/dates';
import { compressRanges } from '../../../shared/workflow';
import { fmtAgo, fmtDate, fmtDow, fmtWeekday } from '../../../shared/format';

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

/** "40 min", "1 h 5 min" */
export function fmtWorked(seconds: number): string {
  const m = Math.max(0, Math.round(seconds / 60));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

/** The time on a video for a tile: "25" min, or "1:05" hours. */
export function tileTime(seconds: number): { n: string; unit: string } {
  const m = Math.max(0, Math.floor(seconds / 60));
  return m < 60 ? { n: String(m), unit: 'min' } : { n: `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`, unit: 'hours' };
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

/** Someone's local time, or null when their time zone isn't known. */
export function localTime(tz: string | null, now: number): string | null {
  if (!tz) return null;
  try { return clockTime(now, tz); } catch { return null; }
}

/** "9 AM", "6 PM" (a stored hour may pass midnight: 26 is 2 AM). */
export const fmtHour = (h: number) => {
  const x = ((h % 24) + 24) % 24;
  return `${((x + 11) % 12) + 1} ${x < 12 ? 'AM' : 'PM'}`;
};
export const hoursText = ([s, e]: [number, number]) => (e - s >= 24 ? 'around the clock' : `${fmtHour(s)}–${fmtHour(e)}`);

/** "due tomorrow, Fri, Oct 9" inside a sentence: only the first letter lowered. */
export const midSentence = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

export type DueTone = 'late' | 'today' | 'soon' | 'plain';
/** "Due today", "Due tomorrow, Fri, Oct 9", "Overdue since Tue, Oct 6": a deadline in words, with its tone. */
export function dueWords(due: ISODate | null, today: ISODate): { text: string; tone: DueTone } | null {
  if (!due) return null;
  const n = diffDays(due, today);
  if (n < 0) return { text: `Overdue since ${fmtWeekday(due)}`, tone: 'late' };
  if (n === 0) return { text: 'Due today', tone: 'today' };
  if (n === 1) return { text: `Due tomorrow, ${fmtWeekday(due)}`, tone: 'soon' };
  return { text: `Due ${fmtWeekday(due)}`, tone: 'plain' };
}

/** How fresh the copy of Timeliner is, in a few quiet words. */
export function syncWords(s: EditingSync, now: number): string {
  if (!s.keySet) return 'Timeliner isn’t connected';
  if (!s.syncedAt) return s.error ? 'Timeliner couldn’t be read yet' : 'Not read from Timeliner yet';
  return `Read from Timeliner ${fmtAgo(s.syncedAt, now)}`;
}

// ── videos ───────────────────────────────────────────────────────────────

/** The number in a video's title, for ordering ("Organic 05" → 5). */
export const titleNumber = (title: string) => { const m = /\d+/.exec(title); return m ? Number(m[0]) : null; };

/** What a video's square shows: its number as written ("05"), else its first letters. */
export const squareLabel = (title: string) => /\d+/.exec(title)?.[0].slice(-3) ?? (title.trim().slice(0, 2) || '?');

export const byTitle = (a: EditingVideo, b: EditingVideo) =>
  (titleNumber(a.title) ?? Number.MAX_SAFE_INTEGER) - (titleNumber(b.title) ?? Number.MAX_SAFE_INTEGER) || a.title.localeCompare(b.title);

/** "Organic 26", "Organic 27" … "Organic 30" → "Organic 26–30": titles that differ only by their number, as ranges. */
export function titleRange(titles: string[]): string {
  const groups = new Map<string, { pre: string; post: string; nums: number[]; width: number }>();
  const plain: string[] = [];
  for (const raw of titles) {
    const t = raw.trim();
    const m = /^(.*?)(\d+)(\D*)$/.exec(t);
    if (!m) { if (!plain.includes(t)) plain.push(t); continue; }
    const key = `${m[1]}\u0000${m[3]}`;
    const g = groups.get(key) ?? { pre: m[1], post: m[3], nums: [], width: 1 };
    g.nums.push(Number(m[2]));
    if (m[2].length > 1 && m[2].startsWith('0')) g.width = Math.max(g.width, m[2].length);
    groups.set(key, g);
  }
  return [
    ...[...groups.values()].map((g) => `${g.pre}${compressRanges(g.nums).replace(/\d+/g, (x) => x.padStart(g.width, '0'))}${g.post}`),
    ...plain,
  ].join(', ');
}

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
