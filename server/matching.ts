// Matching what arrives from Timeliner to the site's batches: pure rules, no database and no network.
// server/timeliner.ts places a scripts PDF with placePdf; server/editing.ts matches every video with
// matchVideos after each read of Timeliner (and after each video message and pin). ARCHITECTURE.md says the
// same in plain words.
//
// A batch is one shoot's scripts. Its date D is the shoot's start (unless the shoot was cancelled), else the
// final delivery, else the draft deadline; E is the shoot's end, else D. Days are in the workspace's time zone.
//
// Scripts PDF → batch: a PDF is linked to its batch once (server/timeliner.ts keeps the link, and every later
// version of the same PDF follows it). The first time, a date in its name decides; else the one shoot waiting
// for its scripts around when the PDF was made; else a shoot that has just happened; else the client's only
// undated batch. When two shoots could be meant, or the name looks like another shoot's PDF, it waits for a
// manager to pick.
//
// Video → batch: by date. A video goes to the shoot that had just happened when it was made (its creation in
// Timeliner, never its later versions). Raw camera clips are uploaded right after their shoot; a titled video
// an editor makes later goes to the shoot whose raw clips that editor has been cutting. The folder's word
// (Organic, Ads) only decides between batches of the same shoot. A video that has been in review keeps its
// batch. A manager's pin beats everything.

import { addDays, diffDays, nowInZone, type ISODate } from '../shared/dates';
import { fmtDate as formatDate } from '../shared/format';
import { isRawTitle, type VideoState } from '../shared/workflow';
import type { VideoMatchHow } from '../shared/types';

/** "Oct 14" (worked out once per day: matching writes it into many notes) */
const shown = new Map<ISODate, string>();
function fmtDate(iso: ISODate): string {
  let s = shown.get(iso);
  if (!s) { s = formatDate(iso); if (shown.size > 5000) shown.clear(); shown.set(iso, s); }
  return s;
}

/** a scripts PDF can come this many days before its shoot… */
export const PDF_AHEAD = 45;
/** …or this many after it (when the shoot is waiting for its scripts) */
export const PDF_LATE = 3;
/** a late upload, for a shoot that had just happened and is still waiting for its scripts */
export const PDF_LATE_FALLBACK = 21;
/** two waiting shoots this close: ask, don't guess */
export const PDF_TIE = 3;
/** a batch delivered in full this long ago is closed: no new PDF goes to it by date */
export const CLOSED_AFTER = 14;
/** a video made this many days before a shoot can be for it ("made ahead") */
export const VIDEO_AHEAD = 7;
/** a video made this long after a shoot isn't from it */
export const VIDEO_STALE = 90;
/** a project or sub-folder made at most this many days before the scripts PDF in it was made for that shoot */
export const PLACE_MADE = 30;
/** a titled video goes to the shoot whose raw clips its editor has been cutting, when that shoot was this recent */
export const EDITOR_SHOOT_DAYS = 30;
/** which shoots each editor's raw clips were matched to is remembered this long (raw clips are trashed soon after) */
export const EDITOR_SHOOT_KEEP_DAYS = 45;

// ── names ────────────────────────────────────────────────────────────────

const STOP = new Set(['the', 'and', 'of', 'co', 'company', 'inc', 'llc', 'ltd', 'group']);
export const nameWords = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' ')
  .split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w));

/** How well a Timeliner name fits a client: how many of the client's name words it holds, if it holds them all (else 0). */
export function clientFit(clientName: string, timelinerName: string): number {
  const client = nameWords(clientName);
  const there = new Set(nameWords(timelinerName));
  if (!client.length || !there.size) return 0;
  // "Lumen" (the brand) is Lumen Skincare; "Old Mill Bakery · Winter" (a project) is Old Mill Bakery
  if (client.every((w) => there.has(w))) return client.length;
  if ([...there].every((w) => client.includes(w))) return there.size;
  return 0;
}

/** The client a Timeliner name (the brand's, else the project's) fits strictly best; `tie` when two fit equally. */
export function fitClient<C extends { id: number; name: string }>(clients: C[], names: (string | null | undefined)[]): { client: C | null; tie: C[] } {
  for (const name of names) {
    if (!name) continue;
    const fits = clients.map((c) => ({ c, fit: clientFit(c.name, name) })).filter((x) => x.fit > 0).sort((a, b) => b.fit - a.fit);
    if (!fits.length) continue;
    if (fits.length === 1 || fits[0].fit > fits[1].fit) return { client: fits[0].c, tie: [] };
    return { client: null, tie: fits.filter((x) => x.fit === fits[0].fit).map((x) => x.c) };
  }
  return { client: null, tie: [] };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_WORD = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)$/;

/** The ways a date shows up in a project or task name: "Oct 13", "13 Oct", "10/13", "2026-10-13". */
export function dateForms(iso: ISODate): string[] {
  const [y, m, d] = iso.split('-').map(Number);
  const mon = MONTHS[m - 1];
  return [`${mon} ${d}`, `${d} ${mon}`, `${m}/${d}`, `${d}/${m}`, iso, `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`];
}

/** Only the unmistakable forms, for a video's folder or title: a month's name ("Oct 14", "14 October") or 2026-10-14, never 10/14. */
const formsSeen = new Map<ISODate, string[]>();
function namedForms(iso: ISODate): string[] {
  const seen = formsSeen.get(iso);
  if (seen) return seen;
  const out = namedFormsOf(iso);
  if (formsSeen.size > 5000) formsSeen.clear();
  formsSeen.set(iso, out);
  return out;
}
function namedFormsOf(iso: ISODate): string[] {
  const [, m, d] = iso.split('-').map(Number);
  const dd = String(d).padStart(2, '0');
  const out = new Set<string>([iso]);
  for (const mon of [MONTHS[m - 1], MONTH_NAMES[m - 1]]) for (const day of [String(d), dd]) { out.add(`${mon} ${day}`); out.add(`${day} ${mon}`); }
  return [...out];
}

/** Text as matched against names: lower case, every other character a space, padded so whole words match. */
const hay = (text: string) => ` ${text.toLowerCase().replace(/[^a-z0-9/-]+/g, ' ')} `;

interface Named { id: number; title: string; client_name: string; shoot_date: string | null; final_due: string | null; shoot_end?: string | null }

/** Words in a batch's title that every scripts PDF's name has too. */
const PLAIN = new Set(['script', 'scripts', 'shoot', 'shoots', 'batch', 'video', 'videos', 'content', 'final', 'new', 'pdf', 'doc', 'docs', 'draft', 'drafts']);

/** How strongly `text` names a batch: 3 for each of its dates it carries, 1 for each distinctive word of its title. */
function nameScore(c: Named, text: string): number {
  const h = hay(text);
  const own = nameWords(c.client_name);
  let score = nameWords(c.title).filter((w) => w.length > 2 && !own.includes(w) && !PLAIN.has(w) && h.includes(` ${w} `)).length;
  for (const d of [c.shoot_date, c.shoot_end ?? null, c.final_due]) if (d && dateForms(d).some((f) => h.includes(` ${f} `))) score += 3;
  return score;
}

/** Which of these batches a Timeliner name points at: the only one, or the one whose title or date it carries. */
export function pickBatch<C extends Named>(cands: C[], text: string): C | null {
  if (cands.length <= 1) return cands[0] ?? null;
  return namedBatch(cands, text);
}

/** The batch `text` names, strictly better than any other (a name that names none, or two equally, names nothing). */
export function namedBatch<C extends Named>(cands: C[], text: string): C | null {
  const scored = cands.map((c) => ({ c, score: nameScore(c, text) })).sort((a, b) => b.score - a.score);
  return scored.length && scored[0].score > 0 && (scored.length === 1 || scored[0].score > scored[1].score) ? scored[0].c : null;
}

/** A file's name without its extension or version marks, to tell a re-upload of the same document: "JS scripts FINAL (1).pdf" → "js scripts". */
export function nameKey(fileName: string | null | undefined): string {
  return (fileName ?? '').toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/, '')
    .replace(/\(\d+\)/g, ' ')
    .replace(/\b(?:v|ver|version|rev|revision)\s*\.?\s*\d+\b/g, ' ')
    .replace(/\b(?:final|updated|new|copy)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** A video's title compared with another's: lower case, spaces collapsed, numbers without leading zeros ("Organic 5" is "organic 05"). */
export const titleKey = (title: string) => title.toLowerCase().replace(/\d+/g, (d) => String(Number(d))).replace(/\s+/g, ' ').trim();

/** The day a timestamp falls on in the workspace's time zone. */
export const dayOf = (ts: string | Date, tz: string): ISODate => nowInZone(tz, typeof ts === 'string' ? new Date(ts) : ts).date;

// ── script numbers ───────────────────────────────────────────────────────

/** N3: a number the title says outright: "#12", "Script 12", "No. 12". */
export function explicitNumber(title: string): number | null {
  const m = /(?:#\s*|\bscript\s*#?\s*|\bno\.\s*|\bnº\s*)(\d{1,3})(?!\d)/i.exec(title);
  return m && Number(m[1]) > 0 ? Number(m[1]) : null;
}

const EDGE = /^[,.:;!?·|"“”'‘’–—-]+|[,.:;!?·|"“”'‘’–—-]+$/g;
const word = (s: string | undefined) => (s ?? '').toLowerCase().replace(/[^a-z]/g, '');

/**
 * N4: the first number of one to three digits standing on its own: not part of a date ("Oct 6", "6 Oct", 10/6),
 * not a version ("v2", "version 3", "(1)"), not joined to other characters ("9-5", "3x", "10k").
 */
export function standaloneNumber(title: string): number | null {
  const tokens = title.split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i].replace(EDGE, '');
    if (!/^\d{1,3}$/.test(tok)) continue;
    const before = word(tokens[i - 1]);
    if (MONTH_WORD.test(before) || MONTH_WORD.test(word(tokens[i + 1]))) continue;
    if (/^(v|ver|version|rev|revision)$/.test(before)) continue;
    const n = Number(tok);
    if (n > 0) return n;
  }
  return null;
}

/**
 * The script number a title gives (before it's checked against the batch): never from a raw clip, and for a video
 * still To be edited only when the title says it outright (raw camera numbers like "1234" repeat across shoots).
 */
export function scriptNumber(title: string, o: { toEdit: boolean }): number | null {
  if (isRawTitle(title)) return null;
  return explicitNumber(title) ?? (o.toEdit ? null : standaloneNumber(title));
}

// ── scripts PDF → batch ──────────────────────────────────────────────────

/** A batch as a scripts PDF's match sees it (the client's batches, archived ones included). */
export interface PdfBatch {
  id: number; title: string; clientName: string;
  /** null when the shoot was cancelled */
  shootStart: ISODate | null; shootEnd: ISODate | null; finalDue: ISODate | null; draftDue: ISODate | null;
  archived: boolean;
  /** approved or delivered scripts */
  finished: number;
  /** approved scripts not delivered yet */
  waiting: number;
  /** every script delivered (and at least one) */
  allDelivered: boolean;
  /** some of its scripts were delivered from Timeliner (by a scripts PDF, even one trashed since), not all by hand */
  fromTimeliner: boolean;
  /** the newest delivery's day */
  lastDelivered: ISODate | null;
  /** its live scripts PDFs (not trashed) */
  pdfs: { fileName: string | null; nameKey: string | null }[];
}

export const batchDay = (b: { shootStart: ISODate | null; finalDue: ISODate | null; draftDue: ISODate | null }) => b.shootStart ?? b.finalDue ?? b.draftDue ?? null;

export type PdfPlace =
  | { batchId: number; how: 'name' | 'date' | 'earliest' | 'late' | 'only'; sure: boolean; runnerUp: PdfBatch | null; why: string }
  | { batchId: null; suggested: number | null; why: string };

const shootWord = (b: PdfBatch) => { const d = batchDay(b); return d ? `${b.title} (${fmtDate(d)})` : b.title; };

/**
 * Which batch a scripts PDF seen for the first time is for (P3–P8), among its client's batches. `u` is the day
 * the PDF was made (its task's creation), `text` the names it arrived under (task, file, sub-folder, project).
 */
export function placePdf(input: { u: ISODate; text: string; nameKey: string; batches: PdfBatch[] }): PdfPlace {
  const { u, batches } = input;
  const d = (b: PdfBatch) => batchDay(b);
  const e = (b: PdfBatch) => b.shootEnd ?? d(b);

  // P3 · a date or a word of one batch in its name (a batch that's still ahead, or just behind)
  const nameable = batches.filter((b) => !b.archived && (!d(b) || d(b)! >= addDays(u, -PDF_LATE_FALLBACK)));
  const named = namedBatch(nameable.map((b) => ({ id: b.id, title: b.title, client_name: b.clientName, shoot_date: b.shootStart, shoot_end: b.shootEnd, final_due: b.finalDue, b })), input.text)?.b;
  if (named) {
    if (named.pdfs.length) {
      return { batchId: null, suggested: named.id, why: `${named.title} already has its scripts PDF “${named.pdfs[0].fileName ?? 'a PDF'}”. If this is a new version of it, pick ${named.title}.` };
    }
    return { batchId: named.id, how: 'name', sure: true, runnerUp: null, why: `Its name points at ${shootWord(named)}` };
  }

  // P4 · named like the PDF of a shoot still ahead: probably that PDF uploaded again as a new task
  if (input.nameKey) {
    const again = batches.find((b) => !b.archived && b.pdfs.some((p) => p.nameKey === input.nameKey) && (!d(b) || d(b)! >= u));
    if (again) {
      const ahead = d(again) ? ', whose shoot is still ahead' : '';
      return { batchId: null, suggested: again.id, why: `It has the same name as the scripts PDF of ${shootWord(again)}${ahead}. If it’s a new version of that PDF, pick ${again.title}; if it’s another shoot’s, pick that one.` };
    }
  }

  // open: not archived, no scripts PDF yet, and not delivered in full a while ago
  const closed = (b: PdfBatch) => b.allDelivered && !!b.lastDelivered && diffDays(u, b.lastDelivered) > CLOSED_AFTER;
  const open = batches.filter((b) => !b.archived && !b.pdfs.length && !closed(b));

  // P5 · the shoot it was made for: one with finished scripts from 45 days ahead to 3 days behind. A shoot whose
  // scripts were all delivered by hand, without a scripts PDF, isn't waiting for one: it never takes a new PDF by
  // date (a manager is asked when nothing else fits, below)
  const byHand = (b: PdfBatch) => b.allDelivered && b.waiting === 0 && !b.fromTimeliner;
  const around = open.filter((b) => b.finished > 0 && d(b) && d(b)! <= addDays(u, PDF_AHEAD) && e(b)! >= addDays(u, -PDF_LATE))
    .sort((a, b) => d(a)!.localeCompare(d(b)!) || a.id - b.id);
  const near = around.filter((b) => !byHand(b));
  if (near.length === 1) return { batchId: near[0].id, how: 'date', sure: true, runnerUp: null, why: `The only shoot around then still without its scripts PDF: ${shootWord(near[0])}` };
  if (near.length > 1) {
    const [first, next] = near;
    if (diffDays(d(next)!, d(first)!) <= PDF_TIE) {
      return { batchId: null, suggested: first.id, why: `It could be ${near.filter((b) => diffDays(d(b)!, d(first)!) <= PDF_TIE).map(shootWord).join(' or ')}: their shoots are too close together to tell.` };
    }
    return { batchId: first.id, how: 'earliest', sure: false, runnerUp: next, why: `The earliest of the shoots around then still without their scripts PDF: ${shootWord(first)} (also possible: ${shootWord(next)})` };
  }

  // P6 · a shoot that has just happened and is still waiting for its scripts
  const late = open.filter((b) => b.waiting > 0 && d(b) && d(b)! >= addDays(u, -PDF_LATE_FALLBACK) && d(b)! <= addDays(u, -(PDF_LATE + 1)));
  if (late.length === 1) return { batchId: late[0].id, how: 'late', sure: false, runnerUp: null, why: `Uploaded after ${shootWord(late[0])}, which is still waiting for its scripts` };

  // P7 · the client's only batch without a date that's waiting for its scripts
  const undated = open.filter((b) => !d(b) && b.waiting > 0);
  if (!late.length && undated.length === 1) return { batchId: undated[0].id, how: 'only', sure: true, runnerUp: null, why: `${undated[0].title} is the client’s only batch without a date waiting for its scripts` };

  // P8 · ask
  if (late.length > 1) return { batchId: null, suggested: late[0].id, why: `It could be ${late.map(shootWord).join(' or ')}.` };
  if (undated.length > 1) return { batchId: null, suggested: null, why: `It could be ${undated.map((b) => b.title).join(' or ')}.` };
  const hand = around.find(byHand);
  if (hand) {
    return { batchId: null, suggested: hand.id, why: `${shootWord(hand)} was delivered by hand, without a scripts PDF. If this is its PDF, pick ${hand.title}; if it’s another shoot’s, pick that one.` };
  }
  return { batchId: null, suggested: null, why: `No shoot of ${batches[0]?.clientName ?? 'this client'} around ${fmtDate(u)} is waiting for its scripts.` };
}

// ── video → batch ────────────────────────────────────────────────────────

/** A video as matching sees it: what Timeliner says, and the match it had before. */
export interface VideoIn {
  id: string;
  title: string;
  state: VideoState;
  /** still at Timeliner's To be edited step (not In progress): a number only when the title says it outright */
  toDo: boolean;
  createdAt: string | null;
  projectId: string | null;
  subFolderId: string | null;
  brandId: string | null;
  /** the earlier of its deadlines: a video can't be due before its shoot */
  deadline: ISODate | null;
  /** Timeliner member ids */
  assignees: string[];
  /** a variant's parent task */
  parentId: string | null;
  /** it has been sent to review at least once */
  leftPlate: boolean;
  prev: { how: VideoMatchHow | null; batchId: number | null; note: string | null };
}

/** A batch as a video's match sees it. */
export interface VideoBatch {
  id: number; title: string; clientId: number; clientName: string;
  /** D: the shoot's start (not cancelled), else the final delivery, else the draft deadline */
  d: ISODate | null;
  e: ISODate | null;
  /** whether D is a shoot's date or a deadline, for the managers' note */
  dFrom: 'shoot' | 'due' | null;
  /** its scripts' numbers (not removed) */
  numbers: Set<number>;
  /** approved or delivered scripts */
  finished: number;
  /** the Timeliner project it was linked to before PDFs were (a client hint, and a tie-break between same-day batches) */
  legacyProject: string | null;
}

export interface World {
  tz: string;
  clients: { id: number; name: string }[];
  batches: Map<number, VideoBatch>;
  /** live scripts PDFs: where they sit, and when they were made */
  pdfs: { batchId: number; projectId: string | null; subFolderId: string | null; firstAt: string }[];
  /** Timeliner brands, projects and sub-folders: names, and when projects and sub-folders were made */
  names: Map<string, { name: string; createdAt: string | null }>;
  pins: Map<string, { batchId: number | null; number: number | null; byName: string | null }>;
  /**
   * raw clips as last matched, one per clip and editor, remembered for a while after they're trashed: which batch,
   * and when the clip was made. A clip still in the copy is matched again on every pass, and that replaces this.
   */
  editorClips: { taskId: string; member: string; batchId: number; at: string }[];
  memberNames: Map<string, string>;
}

export interface VideoMatchOut {
  clientId: number | null;
  batchId: number | null;
  number: number | null;
  how: VideoMatchHow | null;
  kept: boolean;
  check: boolean;
  note: string | null;
}

/** Words that say nothing about which batch a video is from. */
const GENERIC = new Set(['my', 'video', 'script', 'shoot', 'batch', 'content', 'edit', 'reel', 'final', 'raw', 'footage', 'clip']);
/** "Ads" and "Ad" are the same word here. */
const stem = (w: string) => (w.length >= 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const isAd = (title: string, folder: string | null) => /\bads?\b/i.test(title) || (!!folder && /\bads?\b/i.test(folder));
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * Matches every video in the copy of Timeliner to a client, batch and script (V1–V9, N1–N6). Videos are taken
 * oldest-made first, so a video can lean on the ones made before it; variants after their parents. Pure: the
 * caller loads the world and writes what changed.
 */
export function matchVideos(videos: VideoIn[], w: World): Map<string, VideoMatchOut> {
  const out = new Map<string, VideoMatchOut>();
  const byId = new Map(videos.map((v) => [v.id, v]));
  const made = (v: VideoIn) => v.createdAt ?? '9999';
  const isVariant = (v: VideoIn) => !!v.parentId && byId.has(v.parentId) && v.parentId !== v.id;
  const order = [...videos].sort((a, b) => Number(isVariant(a)) - Number(isVariant(b)) || made(a).localeCompare(made(b)) || a.id.localeCompare(b.id));
  const nameOf = (id: string | null) => (id ? w.names.get(id)?.name ?? null : null);
  const raw = new Map(videos.map((v) => [v.id, isRawTitle(v.title)]));
  // the same few days come up again and again: work each out once
  const days = new Map<string, ISODate>();
  const day = (ts: string) => { let d = days.get(ts); if (!d) { d = dayOf(ts, w.tz); days.set(ts, d); } return d; };

  // which shoot each editor's raw clips are from, clip by clip: remembered (trashed clips too), then replaced by
  // what this pass matches (oldest first, so a raw clip is matched before the titled video made from it), so a
  // clip moved to another shoot (a shoot date fixed on the site, a pin) takes its editor's memory with it
  const clipsOf = new Map<string, Map<string, { batchId: number; at: string }>>();
  const clipMembers = new Map<string, Set<string>>();
  const remember = (taskId: string, member: string, batchId: number, at: string) => {
    const list = clipsOf.get(member) ?? new Map<string, { batchId: number; at: string }>();
    list.set(taskId, { batchId, at });
    clipsOf.set(member, list);
    clipMembers.set(taskId, (clipMembers.get(taskId) ?? new Set<string>()).add(member));
  };
  for (const c of w.editorClips) remember(c.taskId, c.member, c.batchId, c.at);
  const learn = (v: VideoIn, batchId: number | null) => {
    for (const m of clipMembers.get(v.id) ?? []) clipsOf.get(m)?.delete(v.id);
    clipMembers.delete(v.id);
    if (batchId != null) for (const a of v.assignees) remember(v.id, a, batchId, v.createdAt ?? new Date(0).toISOString());
  };
  // raw clips still on someone's plate: the batch each is on (as matched before, then as this pass matches it)
  const openClips = new Map<string, { batchId: number; assignees: string[] }>();
  const holdClip = (v: VideoIn, batchId: number | null) => {
    openClips.delete(v.id);
    if (raw.get(v.id) && batchId != null && (v.state === 'to_edit' || v.state === 'revisions')) openClips.set(v.id, { batchId, assignees: v.assignees });
  };
  for (const v of videos) holdClip(v, v.prev.batchId);
  const cuttingNow = (batchId: number, member: string) => [...openClips.values()].some((c) => c.batchId === batchId && c.assignees.includes(member));
  // titled videos already matched, for "the same title in the same place is already on the shoot before"
  const placed = new Map<string, { batchId: number; made: string }[]>();
  // looked up once, not per video
  const withPdf = new Set(w.pdfs.map((p) => p.batchId));
  const byClient = new Map<number, VideoBatch[]>();
  for (const b of w.batches.values()) byClient.set(b.clientId, [...(byClient.get(b.clientId) ?? []), b]);
  const projectClients = new Map<string, Set<number>>();
  const hint = (projectId: string | null, batchId: number) => {
    const b = w.batches.get(batchId);
    if (!projectId || !b) return;
    const s = projectClients.get(projectId) ?? new Set<number>();
    s.add(b.clientId);
    projectClients.set(projectId, s);
  };
  for (const p of w.pdfs) hint(p.projectId, p.batchId);
  for (const b of w.batches.values()) hint(b.legacyProject, b.id);
  const pdfsIn = new Map<string, World['pdfs']>();
  for (const p of w.pdfs) {
    for (const k of [p.projectId ? `p:${p.projectId}` : null, p.subFolderId ? `s:${p.subFolderId}` : null]) if (k) pdfsIn.set(k, [...(pdfsIn.get(k) ?? []), p]);
  }

  const placeOf = (v: VideoIn) => `${v.projectId ?? ''}|${v.subFolderId ?? ''}`;
  const fitNumber = (v: VideoIn, b: VideoBatch | null | undefined, anyState = false): number | null => {
    if (!b) return null;
    const n = scriptNumber(v.title, { toEdit: !anyState && v.toDo });
    return n != null && b.numbers.has(n) ? n : null;
  };
  const shootName = (b: VideoBatch) => (b.d ? (b.dFrom === 'shoot' ? `the ${fmtDate(b.d)} shoot` : `${b.title} (due ${fmtDate(b.d)})`) : b.title);

  /** V4 · the client: the one whose scripts PDFs sit in the video's project, else the brand's name, else the project's */
  const clientOf = (v: VideoIn): { id: number | null; why: string | null } => {
    const here = v.projectId ? projectClients.get(v.projectId) : undefined;
    if (here?.size === 1) return { id: [...here][0], why: null };
    const brand = nameOf(v.brandId);
    const project = nameOf(v.projectId);
    const fit = fitClient(w.clients, [brand, project]);
    if (fit.client) return { id: fit.client.id, why: null };
    if (fit.tie.length) return { id: null, why: `More than one client fits its Timeliner name: ${fit.tie.map((c) => c.name).join(', ')}.` };
    return { id: null, why: `No client is named like ${[brand, project].filter(Boolean).map((x) => `“${x}”`).join(' or ') || 'its Timeliner brand or project'}.` };
  };

  /** V8 · batches of the same shoot (the legacy Organic/Ads split): the folder's word, then the project its PDF sits in */
  const sameShoot = (pool: VideoBatch[], v: VideoIn): { batch: VideoBatch | null; why: string } => {
    if (pool.length === 1) return { batch: pool[0], why: '' };
    const own = new Set(nameWords(pool[0].clientName).map(stem));
    const sources = [nameOf(v.subFolderId), nameOf(v.projectId), raw.get(v.id) ? null : v.title];
    let words = new Set<string>();
    for (const src of sources) {
      if (!src) continue;
      words = new Set(nameWords(src).map(stem).filter((x) => !/^\d+$/.test(x) && !own.has(x) && !GENERIC.has(x)));
      if (words.size) break;
    }
    const sharing = pool.filter((b) => nameWords(b.title).some((x) => words.has(stem(x))));
    if (sharing.length === 1) return { batch: sharing[0], why: ` (the word “${[...words].join(' ')}” picks ${sharing[0].title})` };
    const among = sharing.length > 1 ? sharing : pool;
    const linked = among.filter((b) => (v.projectId && b.legacyProject === v.projectId) || w.pdfs.some((p) => p.batchId === b.id && p.projectId === v.projectId));
    if (linked.length === 1) return { batch: linked[0], why: ` (its scripts PDF is in the same project)` };
    return { batch: null, why: `${among.map((b) => b.title).join(' and ')} are from the same shoot, and nothing in its folder tells them apart.` };
  };

  const none = (clientId: number | null, why: string): VideoMatchOut => ({ clientId, batchId: null, number: null, how: null, kept: false, check: false, note: why });

  const matchOne = (v: VideoIn): VideoMatchOut => {
    const isRaw = raw.get(v.id)!;
    // V1 · a manager's pin
    const pin = w.pins.get(v.id);
    if (pin) {
      const b = pin.batchId != null ? w.batches.get(pin.batchId) : undefined;
      const by = pin.byName ? ` by ${pin.byName}` : '';
      if (!b) return { ...none(clientOf(v).id, `Pinned${by} as not from any batch`), how: 'pinned' };
      const n = pin.number != null && b.numbers.has(pin.number) ? pin.number : fitNumber(v, b, true);
      return { clientId: b.clientId, batchId: b.id, number: n, how: 'pinned', kept: false, check: false, note: `Pinned to ${b.title}${by}` };
    }
    // V3 · kept: once in review (or made ahead of its shoot), later changes on the site don't move it
    const was = v.prev.batchId != null ? w.batches.get(v.prev.batchId) : undefined;
    if (was && v.prev.how && v.prev.how !== 'pinned' && v.prev.how !== 'parent' && (v.leftPlate || v.prev.how === 'next')) {
      return { clientId: was.clientId, batchId: was.id, number: fitNumber(v, was, true), how: v.prev.how, kept: true, check: false, note: v.prev.note };
    }

    const client = clientOf(v);
    if (client.id == null) return none(null, client.why ?? 'No client fits.');
    const C = v.createdAt ? day(v.createdAt) : null;
    // its client's batches with finished scripts or a scripts PDF, never one whose shoot is after the video is due
    const cands = (byClient.get(client.id) ?? []).filter((b) => (b.finished > 0 || withPdf.has(b.id)) && !(v.deadline && b.d && b.d > v.deadline));
    if (!cands.length) return none(client.id, `${w.clients.find((c) => c.id === client.id)?.name ?? 'The client'} has no batch with approved scripts${v.deadline ? ` before it’s due (${fmtDate(v.deadline)})` : ''}.`);
    const done = (b: VideoBatch, how: VideoMatchHow, note: string): VideoMatchOut => ({ clientId: b.clientId, batchId: b.id, number: fitNumber(v, b), how, kept: false, check: false, note });
    const tieOrNone = (pool: VideoBatch[], how: VideoMatchHow, note: string): VideoMatchOut => {
      const s = sameShoot(pool, v);
      return s.batch ? done(s.batch, how, note + s.why) : none(client.id, s.why);
    };

    // V5 · a folder made for one shoot's scripts (a sub-folder, else the project)
    const placeId = v.subFolderId ?? v.projectId;
    const place = placeId ? w.names.get(placeId) : undefined;
    if (place?.createdAt) {
      const here = (pdfsIn.get(v.subFolderId ? `s:${v.subFolderId}` : `p:${v.projectId}`) ?? []).filter((p) => cands.some((b) => b.id === p.batchId));
      const ids = new Set(here.map((p) => p.batchId));
      if (ids.size === 1) {
        const first = here.map((p) => p.firstAt).sort()[0];
        if (diffDays(day(first), day(place.createdAt)) <= PLACE_MADE) {
          const b = w.batches.get([...ids][0])!;
          return done(b, 'place', `Its folder “${place.name}” was made for the scripts of ${shootName(b)}`);
        }
      }
    }

    // V6 · its folder (or its title, unless it's a raw clip) names the shoot's date
    const text = hay([nameOf(v.subFolderId), nameOf(v.projectId), isRaw ? null : v.title].filter(Boolean).join(' '));
    const hits = cands.filter((b) => b.d && (!C || (b.d >= addDays(C, -VIDEO_STALE) && b.d <= addDays(C, VIDEO_AHEAD)))
      && [b.d, b.e].some((x) => x && namedForms(x).some((f) => text.includes(` ${f} `))));
    const hitDays = [...new Set(hits.map((b) => b.d!))];
    if (hitDays.length === 1) return tieOrNone(cands.filter((b) => b.d === hitDays[0]), 'name', `Its folder or title names ${fmtDate(hitDays[0])}`);

    if (!C) {
      const undated = cands.filter((b) => !b.d);
      if (undated.length === 1 && cands.length === 1) return done(undated[0], 'undated', `${undated[0].title} is the client’s only batch without a date`);
      return none(client.id, 'Timeliner didn’t say when it was made, so its shoot can’t be told.');
    }
    const n = isRaw ? null : (explicitNumber(v.title) ?? standaloneNumber(v.title));

    // a titled video: the shoot whose raw clips its editor has been cutting (they're trashed soon after, so remembered)
    if (!isRaw && v.assignees.length) {
      const recent = new Set(cands.filter((b) => b.d && b.d <= C && b.d >= addDays(C, -EDITOR_SHOOT_DAYS)).map((b) => b.id));
      const mine = new Map<number, { last: string; member: string }>();
      for (const a of v.assignees) {
        for (const { batchId: bid, at } of clipsOf.get(a)?.values() ?? []) {
          if (!recent.has(bid) || (v.createdAt && at > v.createdAt)) continue;
          const had = mine.get(bid);
          if (!had || at > had.last) mine.set(bid, { last: at, member: a });
        }
      }
      let pick: number | null = null;
      if (mine.size === 1) pick = [...mine.keys()][0];
      else if (mine.size > 1) {
        const ids = [...mine.keys()];
        const fits = n != null ? ids.filter((id) => w.batches.get(id)!.numbers.has(n)) : [];
        const pool = fits.length ? fits : ids;
        if (pool.length === 1) pick = pool[0];
        else {
          const stillCutting = pool.filter((id) => v.assignees.some((a) => cuttingNow(id, a)))
            .sort((a, b) => (w.batches.get(a)!.d ?? '').localeCompare(w.batches.get(b)!.d ?? ''));
          pick = stillCutting[0] ?? pool.sort((a, b) => mine.get(b)!.last.localeCompare(mine.get(a)!.last))[0];
        }
      }
      if (pick != null) {
        const b = w.batches.get(pick)!;
        const who = w.memberNames.get(mine.get(pick)!.member) ?? 'Its editor';
        // the folder's word still decides between batches of that same shoot (the legacy Organic/Ads split);
        // when it can't, the batch the raw clips went to
        const same = cands.filter((x) => x.d === b.d);
        const s = same.length > 1 ? sameShoot(same, v) : null;
        return done(s?.batch ?? b, 'editor', `${who} has been cutting raw clips from ${shootName(b)}${s?.batch ? s.why : ''}`);
      }
    }

    // V7 · dates: the latest shoot before it was made (S), or the one just after (N) when it was made ahead
    const dated = cands.filter((b) => b.d);
    if (dated.length) {
      const before = dated.filter((b) => b.d! <= C && diffDays(C, b.d!) <= VIDEO_STALE).map((b) => b.d!).sort();
      const after = isRaw ? [] : dated.filter((b) => b.d! > C && b.d! <= addDays(C, VIDEO_AHEAD)).map((b) => b.d!).sort();
      const S = before.at(-1) ?? null;
      const N = after[0] ?? null;
      const atS = S ? dated.filter((b) => b.d === S) : [];
      const atN = N ? dated.filter((b) => b.d === N) : [];
      let why: string | null = null;
      if (N) {
        if (!S) why = 'nothing came before it';
        else {
          const key = titleKey(v.title);
          const twin = (placed.get(`${placeOf(v)}|${key}`) ?? []).find((p) => atS.some((b) => b.id === p.batchId) && p.made < made(v));
          const sMax = Math.max(...atS.map((b) => Math.max(0, ...b.numbers)));
          const nMax = Math.max(...atN.map((b) => Math.max(0, ...b.numbers)));
          if (twin) why = `another “${v.title}” here is already on ${shootName(atS[0])}`;
          else if (n != null && n > sMax && n <= nMax) why = `${n} is past the ${sMax} scripts of ${shootName(atS[0])}`;
        }
      }
      if (N && why) {
        const days = diffDays(N, C);
        return tieOrNone(atN, 'next', `Made ${fmtDate(C)}, ${plural(days, 'day')} before ${shootName(atN[0])}: ${why}`);
      }
      if (S) {
        const days = diffDays(C, S);
        return tieOrNone(atS, 'date', `Made ${fmtDate(C)}, ${days ? `${plural(days, 'day')} after` : 'the day of'} ${shootName(atS[0])}`);
      }
      return none(client.id, `Made ${fmtDate(C)}: no shoot in the ${VIDEO_STALE} days before${isRaw ? '' : ` or ${VIDEO_AHEAD} after`}.`);
    }
    // V9 · no dated batch at all: the client's only batch without a date
    const undated = cands.filter((b) => !b.d);
    if (undated.length === 1) return done(undated[0], 'undated', `${undated[0].title} is the client’s only batch without a date`);
    return none(client.id, `It could be ${undated.map((b) => b.title).join(' or ')}: none of them has a date.`);
  };

  const variants: VideoIn[] = [];
  for (const v of order) {
    if (isVariant(v) && !w.pins.has(v.id)) { variants.push(v); continue; }
    const m = matchOne(v);
    out.set(v.id, m);
    if (raw.get(v.id)) { learn(v, m.batchId); holdClip(v, m.batchId); }
    if (m.batchId != null && !raw.get(v.id)) {
      const k = `${placeOf(v)}|${titleKey(v.title)}`;
      placed.set(k, [...(placed.get(k) ?? []), { batchId: m.batchId, made: made(v) }]);
    }
  }

  // N6 · an Ad whose number a non-Ad video of the same batch also uses: numbered separately, so no number
  const nonAd = new Map<number, Set<number>>();
  for (const v of order) {
    const m = out.get(v.id);
    if (!m || m.batchId == null || m.number == null || isAd(v.title, nameOf(v.subFolderId))) continue;
    const s = nonAd.get(m.batchId) ?? new Set<number>();
    s.add(m.number);
    nonAd.set(m.batchId, s);
  }
  for (const v of order) {
    const m = out.get(v.id);
    if (m && m.batchId != null && m.number != null && m.how !== 'pinned' && isAd(v.title, nameOf(v.subFolderId)) && nonAd.get(m.batchId)?.has(m.number)) m.number = null;
  }

  // two titled videos in one folder with the same title on the same batch: one may be from another shoot
  const same = new Map<string, string[]>();
  for (const v of order) {
    const m = out.get(v.id);
    if (!m || m.batchId == null || raw.get(v.id) || m.how === 'pinned') continue;
    const k = `${placeOf(v)}|${titleKey(v.title)}|${m.batchId}`;
    same.set(k, [...(same.get(k) ?? []), v.id]);
  }
  for (const ids of same.values()) if (ids.length > 1) for (const id of ids) out.get(id)!.check = true;

  // V2 · a variant goes with its parent
  for (const v of variants) {
    const p = out.get(v.parentId!);
    if (p && p.batchId != null) {
      out.set(v.id, { clientId: p.clientId, batchId: p.batchId, number: p.number, how: 'parent', kept: false, check: false, note: `A version of “${byId.get(v.parentId!)!.title}”` });
    } else {
      out.set(v.id, matchOne(v));
    }
  }
  return out;
}

/**
 * Sure matches: pinned, by name, by its folder, and the owner's two confirmed paths: a raw clip by its date (raw
 * clips are uploaded right after their shoot) and a titled video by the raw clips its editor has been cutting.
 * Not sure ("matched by date"): a titled video by its date alone, made ahead (`next`), or the only undated batch.
 * A kept match keeps its `how`; a variant (`parent`) is as sure as its parent.
 */
export function isSureMatch(how: VideoMatchHow | null, raw: boolean): boolean {
  return how === 'pinned' || how === 'place' || how === 'name' || how === 'editor' || (how === 'date' && raw);
}
