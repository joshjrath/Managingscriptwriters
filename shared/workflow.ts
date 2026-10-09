// Script workflow and progress, derived only from individual script records.
//
// Progress counts are cumulative stages:
//   draft-ready = ready for review + approved + delivered
//   approved    = approved + delivered   (delivery requires approval)
//   delivered   = delivered to Timeliner (writer-confirmed)
// A script returned for revisions is not draft-ready until it is resubmitted.

import { dueState, describeDue, type Clock, type ISODate } from './dates';

export const SCRIPT_STATUSES = [
  'not_started',
  'in_progress',
  'ready_for_review',
  'revisions_needed',
  'approved',
  'delivered',
] as const;
export type ScriptStatus = (typeof SCRIPT_STATUSES)[number];

// One word for each state, used everywhere: chips, filters, notifications, pop-ups and the history.
export const STATUS_LABEL: Record<ScriptStatus, string> = {
  not_started: 'Not started',
  in_progress: 'Writing',
  ready_for_review: 'In review',
  revisions_needed: 'Sent back',
  approved: 'Approved',
  delivered: 'Delivered',
};

export const STATUS_SHORT: Record<ScriptStatus, string> = STATUS_LABEL;

export const isDraftReady = (s: ScriptStatus) => s === 'ready_for_review' || s === 'approved' || s === 'delivered';
export const isApproved = (s: ScriptStatus) => s === 'approved' || s === 'delivered';

export interface ScriptLite {
  id: number;
  number: number;
  status: ScriptStatus;
  assigneeId: number | null;
}

export interface Progress {
  total: number;
  notStarted: number;
  inProgress: number;
  inReview: number;
  revisions: number;
  /** approved but not yet delivered */
  awaitingDelivery: number;
  approved: number;
  delivered: number;
  draftReady: number;
  unassigned: number;
  pctDraft: number;
  pctApproved: number;
  pctDelivered: number;
}

/** Whole-number percentage, rounded down so 100% only ever means complete. */
export function pct(n: number, total: number): number {
  return total > 0 ? Math.floor((n * 100) / total) : 0;
}

export function summarize(scripts: Pick<ScriptLite, 'status' | 'assigneeId'>[]): Progress {
  const p: Progress = {
    total: scripts.length, notStarted: 0, inProgress: 0, inReview: 0, revisions: 0,
    awaitingDelivery: 0, approved: 0, delivered: 0, draftReady: 0, unassigned: 0,
    pctDraft: 0, pctApproved: 0, pctDelivered: 0,
  };
  for (const s of scripts) {
    if (s.assigneeId == null) p.unassigned++;
    switch (s.status) {
      case 'not_started': p.notStarted++; break;
      case 'in_progress': p.inProgress++; break;
      case 'ready_for_review': p.inReview++; break;
      case 'revisions_needed': p.revisions++; break;
      case 'approved': p.awaitingDelivery++; break;
      case 'delivered': p.delivered++; break;
    }
  }
  p.approved = p.awaitingDelivery + p.delivered;
  p.draftReady = p.inReview + p.approved;
  p.pctDraft = pct(p.draftReady, p.total);
  p.pctApproved = pct(p.approved, p.total);
  p.pctDelivered = pct(p.delivered, p.total);
  return p;
}

/** "20 / 45 drafts sent · 44%" */
export function progressLabel(n: number, total: number, noun = 'drafts sent'): string {
  return `${n} / ${total} ${noun} · ${pct(n, total)}%`;
}

// ── batch stage (derived) ────────────────────────────────────────────────

export const STAGES = ['not_started', 'writing', 'in_review', 'approved', 'delivered'] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABEL: Record<Stage, string> = {
  not_started: 'Not started',
  writing: 'Writing',
  in_review: 'In review',
  approved: 'Approved',
  delivered: 'Delivered',
};

/**
 * The batch's workflow stage is the least advanced stage any of its scripts
 * is in, so a partially delivered batch never reads as delivered.
 */
export function deriveStage(p: Progress): Stage {
  if (p.total === 0) return 'not_started';
  if (p.delivered === p.total) return 'delivered';
  if (p.approved === p.total) return 'approved';
  if (p.draftReady === p.total) return 'in_review';
  if (p.notStarted === p.total) return 'not_started';
  return 'writing';
}

// ── milestones ───────────────────────────────────────────────────────────

export type MilestoneKind = 'draft' | 'final';

export interface Milestone {
  kind: MilestoneKind;
  date: ISODate | null;
  complete: boolean;
  /** scripts still short of this milestone */
  remaining: number;
  overdue: boolean;
  dueToday: boolean;
  daysUntil: number | null;
  label: string;
}

export function milestone(kind: MilestoneKind, date: ISODate | null, p: Progress, clock: Clock): Milestone {
  const done = kind === 'draft' ? p.draftReady : p.delivered;
  const remaining = Math.max(0, p.total - done);
  const complete = p.total > 0 && remaining === 0;
  if (!date) {
    return { kind, date, complete, remaining, overdue: false, dueToday: false, daysUntil: null, label: 'No deadline set' };
  }
  const st = dueState(date, clock);
  return {
    kind, date, complete, remaining,
    overdue: !complete && st.overdue,
    dueToday: !complete && st.dueToday,
    daysUntil: st.daysUntil,
    label: complete ? (kind === 'draft' ? 'Drafts complete' : 'Fully delivered') : describeDue(st),
  };
}

/** The earliest milestone that isn't complete yet (final delivery first when it falls before the drafts date). */
export function nextMilestone(draft: Milestone, final: Milestone): Milestone | null {
  const draftOpen = !draft.complete && !!draft.date;
  if (draftOpen && !final.complete && final.date && final.date < draft.date!) return final;
  if (draftOpen) return draft;
  if (!final.complete) return final;
  return null;
}

/**
 * Both deadlines missed: "Drafts 4 days overdue · Final delivery 2 days overdue", worded the
 * same on every page. Null unless both are overdue (one late deadline is just the next milestone).
 */
export function bothLate(draft: Milestone, final: Milestone): string | null {
  if (!draft.overdue || !final.overdue) return null;
  return `Drafts ${draft.label.toLowerCase()} · Final delivery ${final.label.toLowerCase()}`;
}

// ── actions & permissions ────────────────────────────────────────────────

export type Role = 'owner' | 'manager' | 'writer' | 'editor';

/** How long work counts as new on My work. */
export const NEW_WORK_DAYS = 7;

/**
 * A writer's scripts in a batch are new work when they were given to them in the last week,
 * the writer hasn't said "Got it" (or opened the batch) since, and nothing has happened yet:
 * none written on the counter, none sent, none sent back.
 */
export function isNewWork(mine: { status: ScriptStatus; assignedAt: string | null }[], written: number, now: Date, seenAt: string | null = null): boolean {
  if (!mine.length || written > 0 || mine.some((s) => s.status !== 'not_started')) return false;
  const cut = Math.max(now.getTime() - NEW_WORK_DAYS * 86400_000, seenAt ? new Date(seenAt).getTime() + 1 : 0);
  return mine.some((s) => s.assignedAt != null && new Date(s.assignedAt).getTime() >= cut);
}

/** Scripts added to work the writer has already started, since they last looked (or in the last week). */
export function newlyAdded<T extends { status: ScriptStatus; assignedAt: string | null }>(mine: T[], now: Date, seenAt: string | null): T[] {
  const cut = Math.max(now.getTime() - NEW_WORK_DAYS * 86400_000, seenAt ? new Date(seenAt).getTime() + 1 : 0);
  return mine.filter((s) => (s.status === 'not_started' || s.status === 'in_progress') && s.assignedAt != null && new Date(s.assignedAt).getTime() >= cut);
}

/** Admins (stored as 'owner') can do everything managers can. */
export const isManager = (role: Role) => role === 'manager' || role === 'owner';
/** Admin-only features: Master log, View as, Recording mode, Settings → Editors, the colour palette. */
export const isAdmin = (role: Role) => role === 'owner';
/** Editors cut the videos: they see the calendar, finished scripts, clients and resources, read-only. */
export const isEditor = (role: Role) => role === 'editor';
/** Who can be given scripts to write. */
export const canWrite = (role: Role) => role !== 'editor';
export const ROLE_LABEL: Record<Role, string> = { owner: 'Admin', manager: 'Manager', writer: 'Writer', editor: 'Editor' };

export const SCRIPT_ACTIONS = [
  'start', 'reset', 'submit', 'withdraw', 'approve', 'request_revisions', 'deliver', 'undo_delivery',
] as const;
export type ScriptAction = (typeof SCRIPT_ACTIONS)[number];

interface ActionRule {
  from: ScriptStatus[];
  to: ScriptStatus;
  /** 'assignee' actions may be taken by the script's writer or any manager */
  who: 'assignee' | 'manager';
  label: string;
}

export const ACTION_RULES: Record<ScriptAction, ActionRule> = {
  start: { from: ['not_started'], to: 'in_progress', who: 'assignee', label: 'Start writing' },
  reset: { from: ['in_progress'], to: 'not_started', who: 'assignee', label: 'Mark not started' },
  submit: { from: ['not_started', 'in_progress', 'revisions_needed'], to: 'ready_for_review', who: 'assignee', label: 'Submit for review' },
  withdraw: { from: ['ready_for_review'], to: 'in_progress', who: 'assignee', label: 'Withdraw from review' },
  approve: { from: ['ready_for_review'], to: 'approved', who: 'manager', label: 'Approve' },
  request_revisions: { from: ['ready_for_review', 'approved'], to: 'revisions_needed', who: 'manager', label: 'Request revisions' },
  deliver: { from: ['approved'], to: 'delivered', who: 'assignee', label: 'Mark delivered' },
  // writers can take back their own delivery on the day they made it (the server checks); managers any time
  undo_delivery: { from: ['delivered'], to: 'approved', who: 'assignee', label: 'Undo delivery' },
};

export interface Actor {
  id: number;
  role: Role;
}

/** Whether `action` is possible from `status` at all (who may take it is checkAction's question). */
export const allowedFrom = (action: ScriptAction, status: ScriptStatus) => ACTION_RULES[action].from.includes(status);

/** Scripts that can go in a document sent for review: anything not yet approved (sending one already in review replaces its document). */
export const canSendDocument = (status: ScriptStatus) => !isApproved(status);

export type DocumentState = 'in_progress' | 'in_review' | 'revisions' | 'approved' | 'delivered';

/**
 * Where a document sent for review stands, from the scripts it still covers.
 * A send-back outranks scripts still waiting: the writer has something to do.
 */
export function documentState(statuses: ScriptStatus[]): DocumentState {
  if (statuses.length && statuses.every((s) => s === 'delivered')) return 'delivered';
  if (statuses.length && statuses.every(isApproved)) return 'approved';
  if (statuses.some((s) => s === 'revisions_needed')) return 'revisions';
  if (statuses.some((s) => s === 'ready_for_review')) return 'in_review';
  return 'in_progress';
}

export function checkAction(action: ScriptAction, script: Pick<ScriptLite, 'status' | 'assigneeId'>, actor: Actor): string | null {
  const rule = ACTION_RULES[action];
  if (rule.who === 'manager' && !isManager(actor.role)) return 'Only managers can do this';
  if (rule.who === 'assignee' && !isManager(actor.role) && script.assigneeId !== actor.id) {
    return 'You can only update scripts assigned to you';
  }
  if (!rule.from.includes(script.status)) {
    return `Not possible from “${STATUS_LABEL[script.status]}”`;
  }
  return null;
}

// ── assignments ──────────────────────────────────────────────────────────

/** [1,2,3,5,7,8] → "1–3, 5, 7–8" */
export function compressRanges(numbers: number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}–${sorted[j]}`);
    i = j + 1;
  }
  return parts.join(', ');
}

/** "Script 3" or "Scripts 1–3, 7": the right word for however many there are. */
export function scriptsLabel(numbers: number[]): string {
  const n = new Set(numbers).size;
  return `${n === 1 ? 'Script' : 'Scripts'} ${compressRanges(numbers)}`;
}

/** "1-20, 25", "1 - 20 and 25", "1 to 20; 25" → [1..20, 25]; returns null if the text isn't a valid range list. */
export function parseRanges(text: string, max: number): number[] | null {
  const out = new Set<number>();
  const cleaned = text.replace(/[–—]/g, '-').replace(/#|\bscripts?\b/gi, '').replace(/\s*(?:-|\bto\b|\bthrough\b|\.\.)\s*/gi, '-')
    .replace(/\s*(?:;|&|\band\b)\s*/gi, ',').trim();
  if (!cleaned) return null;
  for (const part of cleaned.split(/[,\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b < a || b > max) return null;
    for (let n = a; n <= b; n++) out.add(n);
  }
  return [...out].sort((x, y) => x - y);
}

/**
 * Split `total` scripts across writers in order. `counts` may leave some
 * scripts unassigned; the sum may not exceed the total.
 */
export function splitAssignments(total: number, parts: { writerId: number; count: number }[]): (number | null)[] {
  const sum = parts.reduce((s, p) => s + p.count, 0);
  if (sum > total) throw new Error(`Assigned ${sum} scripts but the batch only has ${total}`);
  const out: (number | null)[] = [];
  for (const p of parts) for (let i = 0; i < p.count; i++) out.push(p.writerId);
  while (out.length < total) out.push(null);
  return out;
}

export function evenSplit(total: number, writers: number): number[] {
  if (writers <= 0) return [];
  const base = Math.floor(total / writers);
  const extra = total % writers;
  return Array.from({ length: writers }, (_, i) => base + (i < extra ? 1 : 0));
}

// ── Editing: where a video stands, read from Timeliner ───────────────────

/** Timeliner's step groups (a task's `statusGroup`). */
export const TIMELINER_STATUS_GROUPS = ['toDo', 'inProgress', 'inRevision', 'supervisorApproval', 'clientApproval', 'endClientApproval', 'approved', 'posted'] as const;
export type TimelinerStatusGroup = (typeof TIMELINER_STATUS_GROUPS)[number];

/** Where a video stands, in the site's few plain words. Timeliner's own step is shown underneath. */
export type VideoState = 'to_edit' | 'revisions' | 'in_review' | 'with_client' | 'approved';

export const VIDEO_STATE_LABEL: Record<VideoState, string> = {
  to_edit: 'To edit',
  revisions: 'Revisions',
  in_review: 'In review',
  with_client: 'With client',
  approved: 'Approved',
};

/**
 * Timeliner's step group → the site's state. The team's steps: To be edited (toDo) → Needs review (inProgress) →
 * Revisions requested (inRevision) → Internal approval (supervisorApproval) → Awaiting client review (clientApproval)
 * → Approved. So the inProgress group is their Needs review: in review, off the editor's plate.
 */
export function videoState(group: string): VideoState {
  switch (group) {
    case 'inRevision': return 'revisions';
    case 'inProgress': case 'supervisorApproval': return 'in_review';
    case 'clientApproval': case 'endClientApproval': return 'with_client';
    case 'approved': case 'posted': return 'approved';
    default: return 'to_edit';
  }
}

/** Timeliner's step in the team's words, when its exact name (from the task's history) isn't known. */
export const TIMELINER_STEP_LABEL: Record<TimelinerStatusGroup, string> = {
  toDo: 'To be edited',
  inProgress: 'Needs review',
  inRevision: 'Revisions requested',
  supervisorApproval: 'Internal approval',
  clientApproval: 'Awaiting client review',
  endClientApproval: 'End-client review',
  approved: 'Approved',
  posted: 'Posted',
};

/** Videos an editor still has to work on (and so can say they're on). */
export const isOnPlate = (s: VideoState) => s === 'to_edit' || s === 'revisions';

/** A video as the "Not matched" and "Check" rules see it (an EditingVideo). */
interface MatchedVideo { state: VideoState; batch: unknown; match: { how: string | null; check: boolean } }

/**
 * Open and not matched to a shoot: the "Not matched" chip and count. Pinned to no batch is a manager's answer, not a
 * gap; nor is a video whose client has no scripts on the site (`no_scripts`) or isn't a site client (`no_client`).
 */
export const isNotMatched = (v: MatchedVideo) => v.state !== 'approved' && !v.batch && v.match.how !== 'pinned' && !hasNoScripts(v);

/** Normal work whose client has no scripts on the site, or whose Timeliner brand is no site client: "No scripts on the site". */
export const hasNoScripts = (v: { match: { how: string | null } }) => v.match.how === 'no_scripts' || v.match.how === 'no_client';

/** Open, and another video in its folder has its title on the same shoot: the "Check" chip and count. */
export const needsCheck = (v: MatchedVideo) => v.state !== 'approved' && v.match.check;

/** The number in a video's title, for ordering and its script ("Organic 05" → 5); null when it has none. */
export const titleNumber = (title: string): number | null => { const m = /\d+/.exec(title); return m ? Number(m[0]) : null; };

const CLIP_EXT = /\.(mp4|mov|mxf|m4v|avi|braw|r3d|mts|insv)$/i;
/** first letters that make a name a titled video, not a camera's clip ("Ad003", "EP101") */
const TITLE_LETTERS = /^(ad|ads|ep)$/i;

/**
 * A raw camera clip rather than a titled video: after any video file extension (and a copy's " (1)"), the title
 * is only a camera's name for a clip:
 * - letters a camera puts first (IMG, DSC, MVI, GX, GOPR, DJI, PXL, VID, C, A, CLIP…, up to five, maybe with an
 *   underscore) and a number of three or more digits, maybe followed by more numbers after _ or - (a date, a time,
 *   a take) and a lens letter: "C0045", "IMG_1234.MOV", "DSC_0102", "PXL_20261006_143022", "DJI_20261006143022_0001_D";
 * - a cinema camera's reel and clip: "A001_08241432_C001" (Blackmagic), "A001_C002_0101AB" (RED),
 *   "A001C003_221010_R2VK" (ARRI);
 * - only digits: four or more ("1234"), or groups joined by _ or - with six or more in all ("20261006_143022").
 * "Ad003" and "EP101" are titles. The footage is uploaded under the client right after a shoot; editors cut it
 * into titled, numbered videos ("05 – Morning routine", "Ad 3"), so a raw clip never says which script it is.
 */
export function isRawTitle(title: string): boolean {
  const t = title.trim().replace(CLIP_EXT, '').replace(/\s*\(\d{1,3}\)$/, '');
  if (!t || /\s/.test(t)) return false;
  const camera = /^([A-Za-z]{1,5})_?\d{3,}(?:[_-]\d+)*(?:[_-][A-Za-z]{1,2})?$/.exec(t);
  if (camera) return !TITLE_LETTERS.test(camera[1]);
  if (/^[A-Za-z]\d{3}(?:[A-Za-z]\d{3})?(?:[_-](?=[A-Za-z]*\d)[A-Za-z0-9]+)+$/.test(t)) return true;
  if (/^\d{4,}$/.test(t)) return true;
  return /^\d+(?:[_-]\d+)+$/.test(t) && t.replace(/\D/g, '').length >= 6;
}

/** "Organic 26", "Organic 27"… "Organic 30" → "Organic 26–30": titles that differ only by their number, as ranges. */
export function compressTitles(titles: string[]): string {
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
    ...[...groups.values()].map((g) => `${g.pre}${compressRanges(g.nums).replace(/\d+/g, (d) => d.padStart(g.width, '0'))}${g.post}`),
    ...plain,
  ].join(', ');
}

/** An "I'm on this" still running after this long is almost certainly one they forgot to pause. */
export const FOCUS_STALE_HOURS = 10;

/**
 * Still marked as editing, but probably not: the current stretch has run FOCUS_STALE_HOURS or more, or the
 * editor is outside their working hours. The Editors tab shows it as still marked, not as editing now.
 */
export const isFocusStale = (f: { state: 'on' | 'paused'; since: string }, offHours: boolean, now: number) =>
  f.state === 'on' && (offHours || now - Date.parse(f.since) >= FOCUS_STALE_HOURS * 3600_000);
