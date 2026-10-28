// Content roadmaps: a month of long-form uploads read from a PDF (server/roadmaps.ts), with each video's deliverables,
// who owns each role, and when each step is due. The rules both sides need live here: the steps and roles, tidying
// what Claude read (`tidyRoadmap`, which every answer goes through before it's kept), who a role goes to
// (`autoAssign`), and where a deliverable stands (`taskState`). Nothing here is stored: progress is counted from the
// task rows.

import { isManager, isThumbnailDesigner, isVideoEditor, type EditorKind, type Role } from './workflow';
import { addDays, type ISODate } from './dates';

/** Who owns a deliverable, as a kind of job; each roadmap names a person (or nobody yet) for each. */
export const ROADMAP_ROLES = ['approver', 'writer', 'host', 'thumbnail', 'editor', 'other'] as const;
export type RoadmapRole = (typeof ROADMAP_ROLES)[number];
export const ROADMAP_ROLE_LABEL: Record<RoadmapRole, string> = {
  approver: 'Approver', writer: 'Writer', host: 'Host', thumbnail: 'Thumbnail designer', editor: 'Video editor', other: 'Someone else',
};

/** What a deliverable is. */
export const ROADMAP_STEPS = [
  'brief', 'script', 'approval', 'thumbnail_draft', 'film', 'results', 'rough_edit', 'final_thumbnail', 'final_edit', 'schedule', 'publish', 'review', 'other',
] as const;
export type RoadmapStep = (typeof ROADMAP_STEPS)[number];
export const ROADMAP_STEP_LABEL: Record<RoadmapStep, string> = {
  brief: 'Brief locked', script: 'Script draft', approval: 'Script approved', thumbnail_draft: 'Thumbnail draft', film: 'Film & hand off',
  results: 'Results added', rough_edit: 'Rough edit', final_thumbnail: 'Final thumbnail', final_edit: 'Final edit approved',
  schedule: 'Upload scheduled', publish: 'Publish', review: 'Performance review', other: 'Deliverable',
};

/** The six stages a video moves through, for its pipeline on the lineup. */
export const ROADMAP_STAGES = ['plan', 'script', 'film', 'edit', 'thumbnail', 'publish'] as const;
export type RoadmapStage = (typeof ROADMAP_STAGES)[number];
export const ROADMAP_STAGE_LABEL: Record<RoadmapStage, string> = { plan: 'Brief', script: 'Script', film: 'Film', edit: 'Edit', thumbnail: 'Thumbnail', publish: 'Publish' };
export const STEP_STAGE: Record<RoadmapStep, RoadmapStage | null> = {
  brief: 'plan', script: 'script', approval: 'script', results: 'script', thumbnail_draft: 'thumbnail', final_thumbnail: 'thumbnail',
  film: 'film', rough_edit: 'edit', final_edit: 'edit', schedule: 'publish', publish: 'publish', review: null, other: null,
};

/** How long each kept text may be; longer is cut at a word break. */
export const ROADMAP_LIMITS = { title: 200, short: 120, text: 1200, item: 400, beats: 8, tasks: 24, videos: 8, list: 12 } as const;

export interface RoadmapBeat { title: string; body: string }
export interface RoadmapDraftTask { step: RoadmapStep; title: string; date: ISODate; time: string | null; role: RoadmapRole }
export interface RoadmapDraftVideo {
  title: string; publishDate: ISODate; publishTime: string | null; tag: string | null; format: string | null; runtime: string | null;
  idea: string | null; why: string | null; beats: RoadmapBeat[]; thumbnailText: string | null; thumbnailConcept: string | null; prep: string | null;
  tasks: RoadmapDraftTask[];
}
export interface RoadmapDraftRole { key: RoadmapRole; label: string; person: string | null; responsibility: string | null }
export interface RoadmapExtras { standardTimes: string | null; workflow: { when: string; what: string }[]; checklist: string[]; contingency: string[]; notes: string[] }
/** A roadmap as read from its PDF, tidied, before it's saved. */
export interface RoadmapDraft extends RoadmapExtras {
  title: string;
  /** the month its videos go live: YYYY-MM */
  month: string;
  brand: string | null;
  summary: string | null;
  /** the IANA zone its times are in */
  timezone: string;
  /** a deliverable's time when the document gives none ("HH:MM") */
  defaultTime: string;
  roles: RoadmapDraftRole[];
  videos: RoadmapDraftVideo[];
}

// ── tidying what was read ────────────────────────────────────────────────

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v: unknown): v is ISODate => typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
/** "HH:MM" on a 24-hour clock, or null. */
export function clockTime(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}
/** Trimmed and cut at a word break, or null when empty. */
export function cut(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (s.length <= max) return s;
  const at = s.lastIndexOf(' ', max - 1);
  return `${s.slice(0, at > max * 0.6 ? at : max - 1).replace(/[\s,.;:]+$/, '')}…`;
}
const list = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.map((x) => cut(x, ROADMAP_LIMITS.item)).filter((x): x is string => !!x).slice(0, max) : []);
const isZone = (tz: unknown): tz is string => {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
};

/**
 * What Claude read, made safe to keep: texts trimmed and cut, days and times checked (a deliverable without a real day
 * is dropped), roles one per kind, videos in publish order, each with a Publish deliverable on its day. Null when
 * there's no video with a real publish day: then it isn't a roadmap.
 */
export function tidyRoadmap(raw: unknown, fallbackZone: string): RoadmapDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const L = ROADMAP_LIMITS;
  const roleOf = (v: unknown): RoadmapRole => (ROADMAP_ROLES as readonly unknown[]).includes(v) ? v as RoadmapRole : 'other';
  const stepOf = (v: unknown): RoadmapStep => (ROADMAP_STEPS as readonly unknown[]).includes(v) ? v as RoadmapStep : 'other';
  const defaultTime = clockTime(r.defaultTime) ?? '17:00';

  const videos: RoadmapDraftVideo[] = [];
  for (const x of Array.isArray(r.videos) ? r.videos : []) {
    if (!x || typeof x !== 'object') continue;
    const v = x as Record<string, unknown>;
    const title = cut(v.title, L.title);
    if (!title || !isDay(v.publishDate)) continue;
    const publishTime = clockTime(v.publishTime);
    const tasks: RoadmapDraftTask[] = [];
    const seen = new Set<string>();
    for (const y of Array.isArray(v.tasks) ? v.tasks : []) {
      if (!y || typeof y !== 'object') continue;
      const t = y as Record<string, unknown>;
      if (!isDay(t.date)) continue;
      const step = stepOf(t.step);
      const role = roleOf(t.role);
      const name = cut(t.title, L.short) ?? ROADMAP_STEP_LABEL[step];
      const key = `${step}|${role}|${t.date}|${name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tasks.push({ step, title: name, date: t.date, time: clockTime(t.time), role });
    }
    if (!tasks.some((t) => t.step === 'publish')) tasks.push({ step: 'publish', title: 'Publish', date: v.publishDate, time: publishTime, role: 'approver' });
    tasks.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? defaultTime).localeCompare(b.time ?? defaultTime));
    const beats = (Array.isArray(v.beats) ? v.beats : []).map((b) => {
      const o = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
      return { title: cut(o.title, L.short) ?? '', body: cut(o.body, L.item) ?? '' };
    }).filter((b) => b.title || b.body).slice(0, L.beats);
    videos.push({
      title, publishDate: v.publishDate, publishTime, tag: cut(v.tag, 40), format: cut(v.format, L.short), runtime: cut(v.runtime, 60),
      idea: cut(v.idea, L.text), why: cut(v.why, L.text), beats, thumbnailText: cut(v.thumbnailText, 80), thumbnailConcept: cut(v.thumbnailConcept, L.text),
      prep: cut(v.prep, L.text), tasks: tasks.slice(0, L.tasks),
    });
  }
  if (!videos.length) return null;
  videos.sort((a, b) => a.publishDate.localeCompare(b.publishDate));

  const roles: RoadmapDraftRole[] = [];
  for (const x of Array.isArray(r.roles) ? r.roles : []) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const key = roleOf(o.key);
    if (roles.some((p) => p.key === key)) continue;
    roles.push({ key, label: cut(o.label, 60) ?? ROADMAP_ROLE_LABEL[key], person: cut(o.person, 80), responsibility: cut(o.responsibility, L.item) });
  }
  // every role a deliverable names has a row, so it can be given to someone
  for (const key of ROADMAP_ROLES) {
    if (!roles.some((p) => p.key === key) && videos.some((v) => v.tasks.some((t) => t.role === key))) {
      roles.push({ key, label: ROADMAP_ROLE_LABEL[key], person: null, responsibility: null });
    }
  }
  roles.sort((a, b) => ROADMAP_ROLES.indexOf(a.key) - ROADMAP_ROLES.indexOf(b.key));

  // the month most of its videos go live in
  const months = new Map<string, number>();
  for (const v of videos) months.set(v.publishDate.slice(0, 7), (months.get(v.publishDate.slice(0, 7)) ?? 0) + 1);
  const busiest = [...months.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  const month = typeof r.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(r.month) && months.has(r.month) ? r.month : busiest;

  const workflow = (Array.isArray(r.workflow) ? r.workflow : []).map((w) => {
    const o = (w && typeof w === 'object' ? w : {}) as Record<string, unknown>;
    return { when: cut(o.when, 80) ?? '', what: cut(o.what, L.item) ?? '' };
  }).filter((w) => w.what).slice(0, L.list);

  return {
    title: cut(r.title, L.title) ?? 'Content roadmap', month, brand: cut(r.brand, 80), summary: cut(r.summary, L.text),
    timezone: isZone(r.timezone) ? r.timezone : fallbackZone, defaultTime, roles, videos: videos.slice(0, L.videos),
    standardTimes: cut(r.standardTimes, L.text), workflow, checklist: list(r.checklist, L.list), contingency: list(r.contingency, L.list), notes: list(r.notes, L.list),
  };
}

// ── who gets each role ───────────────────────────────────────────────────

export interface AssignCandidate { id: number; name: string; role: Role; editorKind: EditorKind | null; active: boolean; removed?: boolean; load: number }

const norm = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The person a role goes to: the one the document names, when someone on the site has that name (in full, else the
 * only one with that first name); otherwise, by the kind of job, the least busy active writer, thumbnail designer or
 * video editor, or for the approver the first Admin (then manager). A host, or anything else, is nobody until a
 * manager picks someone. Ties go to the earliest name.
 */
export function autoAssign(role: { key: RoadmapRole; person: string | null }, people: AssignCandidate[]): number | null {
  const live = people.filter((p) => p.active && !p.removed).sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
  if (role.person) {
    const want = norm(role.person);
    const full = live.filter((p) => norm(p.name) === want);
    if (full.length === 1) return full[0].id;
    const first = live.filter((p) => norm(p.name).split(' ')[0] === want.split(' ')[0]);
    if (first.length === 1) return first[0].id;
  }
  const least = (list: AssignCandidate[]) => [...list].sort((a, b) => a.load - b.load)[0]?.id ?? null;
  switch (role.key) {
    case 'approver': return live.find((p) => p.role === 'owner')?.id ?? live.find((p) => isManager(p.role))?.id ?? null;
    case 'writer': return least(live.filter((p) => p.role === 'writer'));
    case 'thumbnail': return least(live.filter((p) => isThumbnailDesigner(p)));
    case 'editor': return least(live.filter((p) => isVideoEditor(p)));
    default: return null;
  }
}

// ── where a deliverable stands ───────────────────────────────────────────

export type RoadmapTaskState = 'done' | 'overdue' | 'today' | 'soon' | 'upcoming';

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Done; overdue once its day and time have passed (in the roadmap's zone); due today; soon (within 3 days); or later. */
export function taskState(t: { date: ISODate; time: string | null; done: boolean }, now: { date: ISODate; minutes: number }, defaultTime = '17:00'): RoadmapTaskState {
  if (t.done) return 'done';
  if (t.date < now.date || (t.date === now.date && now.minutes > minutesOf(t.time ?? defaultTime))) return 'overdue';
  if (t.date === now.date) return 'today';
  if (t.date <= addDays(now.date, 3)) return 'soon';
  return 'upcoming';
}

/** "5 PM", "12:30 PM". */
export function fmtClock(hhmm: string): string {
  const h = Number(hhmm.slice(0, 2));
  const mm = hhmm.slice(3, 5);
  return `${h % 12 || 12}${mm === '00' ? '' : `:${mm}`} ${h < 12 ? 'AM' : 'PM'}`;
}
