// Script workflow and progress, derived only from individual script records.
//
// Progress counts are cumulative stages:
//   draft-ready = ready for review + approved + delivered
//   approved    = approved + delivered   (delivery requires approval)
//   delivered   = delivered to Timeliner (writer-confirmed)
// A script returned for revisions is not draft-ready until it is resubmitted.

import { dueState, describeDue, type Clock, type ISODate } from './dates';
import { fmtBytes } from './format';

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

// ── kinds of editor ──────────────────────────────────────────────────────
// An Editor sign-in (role 'editor', read-only, never given scripts) has one job: cutting the videos
// (short_form) or making thumbnails (thumbnail). It's stored in users.editor_kind, which the database allows
// only while the role is editor; a null kind on an editor is a video editor, as every editor was before kinds.

export const EDITOR_KINDS = ['short_form', 'thumbnail'] as const;
export type EditorKind = (typeof EDITOR_KINDS)[number];
export const EDITOR_KIND_LABEL: Record<EditorKind, string> = { short_form: 'Video editor', thumbnail: 'Thumbnail designer' };

/** Someone as the kind rules see them: a Me, a UserSummary, or just a role and kind. */
export interface KindOf { role: Role; editorKind?: EditorKind | null }

/** The kinds that cut videos: the Editors tab, Timeliner's assignees and the "Scripts final" and "Shoot moved" notices are theirs. */
export const VIDEO_EDITOR_KINDS: readonly EditorKind[] = ['short_form'];
/** Every other kind: never anyone's video editor. */
export const NON_VIDEO_EDITOR_KINDS: readonly EditorKind[] = EDITOR_KINDS.filter((k) => !VIDEO_EDITOR_KINDS.includes(k));

/** What kind of editor someone is: null unless their role is editor; an editor with no kind is a video editor. */
export const editorKindOf = (p: KindOf): EditorKind | null => (isEditor(p.role) ? p.editorKind ?? 'short_form' : null);
/** Makes thumbnails: their home is the Studio. */
export const isThumbnailDesigner = (p: KindOf) => editorKindOf(p) === 'thumbnail';
/** Cuts the videos: their home is /editor, and Timeliner's videos can be theirs. */
export const isVideoEditor = (p: KindOf) => { const k = editorKindOf(p); return k != null && VIDEO_EDITOR_KINDS.includes(k); };

/**
 * Kinds written into SQL as a list for `in (…)`: `'thumbnail'`. Only these constants ever go in, never input, and an
 * empty list is `null` (so `x in (null)` matches nothing).
 */
export const kindsSql = (kinds: readonly EditorKind[]): string => {
  if (kinds.some((k) => !(EDITOR_KINDS as readonly string[]).includes(k))) throw new Error('not an editor kind');
  return kinds.length ? kinds.map((k) => `'${k}'`).join(', ') : 'null';
};

/** Where someone lands when they sign in (and where a page they can't use sends them). */
export function homePath(p: KindOf): '/overview' | '/my-work' | '/editor' | '/studio' {
  if (isManager(p.role)) return '/overview';
  if (isThumbnailDesigner(p)) return '/studio';
  if (isEditor(p.role)) return '/editor';
  return '/my-work';
}

/** What someone is, in a word or two: "Admin", "Writer", "Video editor", "Thumbnail designer". */
export function personLabel(p: KindOf): string {
  const kind = editorKindOf(p);
  return kind ? EDITOR_KIND_LABEL[kind] : ROLE_LABEL[p.role];
}

/** Why an editor's sign-in was refused a route (server/editor-access.ts), worded for their kind. */
export const EDITOR_REFUSAL: Record<EditorKind, string> = {
  short_form: 'Editors can see the calendar, finished scripts, clients and resources. Ask an admin for anything else.',
  thumbnail: 'Thumbnail designers can use their Studio and see the calendar, finished scripts, clients and resources. Ask an admin for anything else.',
};

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

/** One of a client's past batches, as far as who wrote it goes (a `BatchSummary` fits). */
export interface PastBatch { id: number; title: string; draftDue: ISODate | null; finalDue: ISODate | null; writers: { userId: number | null; name: string; count: number }[] }

/**
 * Who has written a client's scripts before: its newest batch with a writer (and that batch's split), and everyone
 * who has, most scripts first, with how many scripts and batches. Only people `canStill` says can write today;
 * unassigned scripts aren't anyone's.
 */
export function writerHistory(batches: PastBatch[], canStill: (userId: number) => boolean) {
  const theirs = (b: PastBatch) => b.writers.filter((w) => w.userId != null && w.count > 0 && canStill(w.userId)) as { userId: number; name: string; count: number }[];
  const newest = [...batches].sort((a, b) => b.id - a.id);
  const lastBatch = newest.find((b) => theirs(b).length);
  const people = new Map<number, { userId: number; name: string; scripts: number; batches: number }>();
  for (const b of newest) {
    for (const w of theirs(b)) {
      const p = people.get(w.userId) ?? { userId: w.userId, name: w.name, scripts: 0, batches: 0 };
      p.scripts += w.count;
      p.batches += 1;
      people.set(w.userId, p);
    }
  }
  return {
    last: lastBatch ? { batchId: lastBatch.id, title: lastBatch.title, date: lastBatch.finalDue ?? lastBatch.draftDue, writers: theirs(lastBatch).sort((a, b) => b.count - a.count) } : null,
    everyone: [...people.values()].sort((a, b) => b.scripts - a.scripts || a.name.localeCompare(b.name)),
  };
}

/**
 * Last time's split scaled to a new total, keeping each writer's share: 20 and 11 of 31 become 29 and 16 of 45.
 * Whole scripts by the largest remainder (ties to the earlier writer), so the counts always add up to `total`.
 */
export function scaleSplit(counts: number[], total: number): number[] {
  const sum = counts.reduce((n, c) => n + c, 0);
  if (!sum || total <= 0) return counts.map(() => 0);
  const exact = counts.map((c) => (c * total) / sum);
  const out = exact.map(Math.floor);
  let left = total - out.reduce((n, c) => n + c, 0);
  for (const i of exact.map((x, i) => ({ r: x - Math.floor(x), i })).sort((a, b) => b.r - a.r || a.i - b.i).map((x) => x.i)) {
    if (left <= 0) break;
    out[i]++;
    left--;
  }
  return out;
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

/** Timeliner's web app, where the team is signed in (its home page, timeliner.io, is for visitors). */
export const TIMELINER_APP = 'https://timeliner.io/app';
/** One video in Timeliner's web app: it opens the task named by `?task=`, as the address bar shows with a video open. */
export const timelinerVideoUrl = (taskId: string) => `${TIMELINER_APP}?task=${encodeURIComponent(taskId)}`;

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

// ── Thumbnail Studio ─────────────────────────────────────────────────────
// Managers hand out thumbnail briefs; the brief's designer lines up options (A–F) in a private tray and sends
// them as a round; a manager picks one or asks for changes. Long videos only: widescreen 1280×720. Where a brief
// stands is never stored: it's worked out from its rounds and decisions.

export const THUMB_STATES = ['to_design', 'drafting', 'in_review', 'changes', 'picked', 'cancelled'] as const;
export type ThumbState = (typeof THUMB_STATES)[number];

export const THUMB_STATE_LABEL: Record<ThumbState, string> = {
  to_design: 'To design', drafting: 'Drafting', in_review: 'In review', changes: 'Changes asked', picked: 'Picked', cancelled: 'Cancelled',
};
/**
 * The Chip colour of each state (ui.tsx `Chip color`), keeping the tokens' meanings: in review lavender, changes pink,
 * picked mint, drafting cyan. Due today (yellow) and overdue (red) come from the due date, not the state.
 */
export const THUMB_STATE_COLOR: Record<ThumbState, string> = {
  to_design: 'neutral', drafting: 'cyan', in_review: 'lavender', changes: 'pink', picked: 'mint', cancelled: 'neutral',
};

/** A manager's decision on a sent round. */
export const THUMB_ACTIONS = ['pick', 'changes'] as const;
export type ThumbAction = (typeof THUMB_ACTIONS)[number];

/** Still has work in it: not picked, not cancelled. A designer's kind can't change while they have one. */
export const isOpenThumb = (s: ThumbState) => s !== 'picked' && s !== 'cancelled';
/** On the designer's plate: nothing sent yet, or changes asked. In review is waiting on a manager. */
export const isDesignerTurn = (s: ThumbState) => s === 'to_design' || s === 'drafting' || s === 'changes';

/**
 * Where a brief stands, from its rows:
 * - cancelled, whatever else happened;
 * - nothing sent yet: to_design, or drafting once the tray holds a live option;
 * - its newest sent round has no decision: in_review (a decision on an older round never counts, so a new round
 *   supersedes a waiting one);
 * - else that round's newest decision: picked, or changes (still changes while the next round is drafted).
 */
export function thumbnailState(
  brief: { cancelledAt: string | null; draftOptions: number },
  latestSentRound: { id: number } | null,
  latestDecision: { roundId: number; action: ThumbAction } | null,
): ThumbState {
  if (brief.cancelledAt) return 'cancelled';
  if (!latestSentRound) return brief.draftOptions > 0 ? 'drafting' : 'to_design';
  if (!latestDecision || latestDecision.roundId !== latestSentRound.id) return 'in_review';
  return latestDecision.action === 'pick' ? 'picked' : 'changes';
}

const THUMB_ORDER: Record<ThumbState, number> = { changes: 0, drafting: 1, to_design: 1, in_review: 2, picked: 3, cancelled: 4 };

/** The order briefs are listed in a designer's board: changes asked first, then the rest of their plate, in review, done; each by due date (undated last), then oldest first. */
export const briefOrder = (a: { id: number; state: ThumbState; dueOn: ISODate | null }, b: { id: number; state: ThumbState; dueOn: ISODate | null }) =>
  THUMB_ORDER[a.state] - THUMB_ORDER[b.state] || (a.dueOn ?? '9999-12-31').localeCompare(b.dueOn ?? '9999-12-31') || a.id - b.id;

/** The brief to make next (the Studio's "Next up"): changes asked first, then by due date. Never one in review, picked or cancelled. */
export function nextBrief<T extends { id: number; state: ThumbState; dueOn: ISODate | null }>(briefs: readonly T[]): T | null {
  return briefs.filter((b) => isDesignerTurn(b.state)).sort(briefOrder)[0] ?? null;
}

export const OPTION_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
export type OptionLetter = (typeof OPTION_LETTERS)[number];
/** The most options a round can hold (one per letter). */
export const MAX_OPTIONS = 6;
/** How many options a new brief asks for, unless the manager says otherwise. */
export const DEFAULT_OPTIONS = 3;
/** The first letter no live option in the round has, or null when all six are taken. */
export const nextLetter = (used: readonly string[]): OptionLetter | null => OPTION_LETTERS.find((l) => !used.includes(l)) ?? null;

/** How long a pick stays the Studio's "Just picked" hero. */
export const JUST_PICKED_MS = 12 * 3600_000;

/** Where a brief opens: a designer's workbench in their Studio, or the manager's review page. */
export const thumbBriefPath = (p: KindOf, briefId: number) => (isManager(p.role) ? `/thumbnails/${briefId}` : `/studio/briefs/${briefId}`);

/** The image types the site keeps as a thumbnail option, read from the file's own bytes (server/images.ts). Never SVG. */
export const THUMB_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type ThumbMime = (typeof THUMB_MIMES)[number];
export const THUMB_MIME_LABEL: Record<ThumbMime, string> = { 'image/png': 'PNG', 'image/jpeg': 'JPG', 'image/webp': 'WebP' };

/**
 * YouTube's guidance for a video's custom thumbnail (YouTube Help, "Add video thumbnails", checked 2026-10-16):
 * 1280×720 with a minimum width of 640, 16:9, under 2 MB, as JPG, GIF or PNG. It changes now and then, so it lives
 * here only. These only warn; they never stop a hand-in. The 2 MB is YouTube's limit, not the site's: every upload
 * is capped by UPLOAD_LIMIT_MB.
 */
export const THUMB_SPEC = {
  width: 1280,
  height: 720,
  minWidth: 640,
  ratio: 16 / 9,
  ratioLabel: '16:9',
  maxBytes: 2 * 1024 * 1024,
  maxBytesLabel: 'YouTube’s 2 MB limit',
  /** of the types the site keeps, the ones YouTube's help lists */
  youtubeMimes: ['image/jpeg', 'image/png'] as readonly string[],
} as const;

export type ThumbCheckKey = 'size' | 'shape' | 'bytes' | 'format';
/** One quick check on an option, as its chip shows it: `label` always, `detail` when it isn't ok. */
export interface ThumbCheck { key: ThumbCheckKey; ok: boolean; label: string; detail: string | null }

/** The four quick checks on an image against THUMB_SPEC: size, widescreen shape, YouTube's 2 MB, and file type. */
export function thumbSpecChecks(img: { width: number; height: number; size: number; mime: string }): ThumbCheck[] {
  const S = THUMB_SPEC;
  const { width: w, height: h } = img;
  const big = w >= S.width && h >= S.height;
  const shape = w > 0 && h > 0 && Math.abs(w / h - S.ratio) / S.ratio <= 0.01;
  const light = img.size <= S.maxBytes;
  const format = S.youtubeMimes.includes(img.mime);
  // "21 KB", "1.4 MB": a small export reads as what it is, never "0.0 MB"
  const weight = fmtBytes(img.size);
  return [
    {
      key: 'size', ok: big, label: `${w}×${h}`,
      detail: big ? null : w < S.minWidth ? `Under ${S.minWidth} wide: YouTube needs at least ${S.minWidth}` : `Smaller than ${S.width}×${S.height}: it may look soft on big screens`,
    },
    { key: 'shape', ok: shape, label: shape ? S.ratioLabel : `Not ${S.ratioLabel}`, detail: shape ? null : 'Not widescreen: YouTube will show it with bars or cropped' },
    { key: 'bytes', ok: light, label: light ? `${weight}, under 2 MB` : weight, detail: light ? null : `Over ${S.maxBytesLabel}: export it smaller` },
    {
      key: 'format', ok: format, label: THUMB_MIME_LABEL[img.mime as ThumbMime] ?? 'Unknown type',
      detail: format ? null : 'YouTube’s help lists JPG and PNG: export one of those to be safe',
    },
  ];
}

/** The checks an image doesn't pass (warnings only). */
export const thumbSpecIssues = (img: { width: number; height: number; size: number; mime: string }): ThumbCheck[] => thumbSpecChecks(img).filter((c) => !c.ok);

/** Stored files the site shows as a picture (an <img>, as a client's logo or reference): the image types it serves inline. Never SVG. */
export const PICTURE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export const isPictureMime = (mime: string | null | undefined) => !!mime && (PICTURE_MIMES as readonly string[]).includes(mime);

// ── Thumbnail Studio: pins, standouts and celebrations ──────────────────
// With either decision a manager can drop numbered notes on exact spots of the round's options (pins), and a pick
// can be marked Standout. A pick is celebrated for whoever made the option; asking for changes never is.

/** What a pin is about: its optional tag chip. */
export const THUMB_PIN_TAGS = ['text', 'faces', 'contrast', 'composition', 'brand', 'crop', 'other'] as const;
export type ThumbPinTag = (typeof THUMB_PIN_TAGS)[number];
export const THUMB_PIN_TAG_LABEL: Record<ThumbPinTag, string> = {
  text: 'Text', faces: 'Faces', contrast: 'Contrast', composition: 'Composition', brand: 'Brand', crop: 'Crop', other: 'Other',
};
/** The most pins one decision carries. */
export const MAX_PINS = 20;
/** The longest note on a pin. */
export const PIN_NOTE_MAX = 500;

/** A box on the page, in the same units as the point measured against it (a DOMRect fits). */
export interface Box { left: number; top: number; width: number; height: number }

/**
 * The picture's own box inside a frame that shows it whole (object-fit: contain), relative to the frame: centred,
 * with bars on two sides when its shape isn't the frame's. Pins sit on this box, so a pin stays on its spot when an
 * option that isn't 16:9 is letterboxed. Until the picture's size is known, it's the whole frame.
 */
export function fitContain(frame: { width: number; height: number }, image: { width: number; height: number }): Box {
  const fw = Math.max(0, frame.width || 0);
  const fh = Math.max(0, frame.height || 0);
  if (!(fw > 0 && fh > 0 && image.width > 0 && image.height > 0)) return { left: 0, top: 0, width: fw, height: fh };
  const scale = Math.min(fw / image.width, fh / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  return { left: (fw - width) / 2, top: (fh - height) / 2, width, height };
}

/**
 * Where a click or tap lands on an option's picture, as a pin keeps it: 0 to 1 across from the picture's left edge
 * and down from its top edge (so it's the same spot at every size), kept on the picture and rounded to 4 places.
 * `box` is the picture as drawn (see fitContain), in the point's units. Null when the box has no size.
 */
export function pinAt(point: { x: number; y: number }, box: Box): { x: number; y: number } | null {
  if (!(box.width > 0 && box.height > 0) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const unit = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 10_000) / 10_000;
  return { x: unit((point.x - box.left) / box.width), y: unit((point.y - box.top) / box.height) };
}

/**
 * The pins a round shows: its newest decision's (the API lists a round's decisions newest first). Deciding again
 * replaces them; earlier pins stay with their own decision, as history.
 */
export const currentPins = <P>(round: { decisions: readonly { pins?: readonly P[] }[] }): readonly P[] => round.decisions[0]?.pins ?? [];

/** The celebrations a pick records for whoever made the option: a pick, or a pick marked Standout. Asking for changes is never one. */
export const THUMB_MOMENT_KINDS = ['thumb_picked', 'thumb_standout'] as const;
export type ThumbMomentKind = (typeof THUMB_MOMENT_KINDS)[number];
export const thumbMomentKind = (standout: boolean): ThumbMomentKind => (standout ? 'thumb_standout' : 'thumb_picked');
/**
 * A pick's moment key (moments.dedupe_key). The key is unique across the whole table, not per person, so it names
 * both the person and the decision: each pick is celebrated once for each person, and deciding again is a new one.
 */
export const thumbMomentKey = (kind: ThumbMomentKind, userId: number, decisionId: number) => `${kind}:${userId}:${decisionId}`;
/** How a pick is celebrated: one from the first round sent gets the bigger celebration, any other the smaller; a standout adds a ring. */
export const pickCelebration = (p: { firstRound: boolean; standout: boolean }): { size: 'big' | 'small'; ring: boolean } => ({
  size: p.firstRound ? 'big' : 'small', ring: p.standout,
});

// ── Thumbnail Studio: the AI second look ────────────────────────────────
// A designer can ask Claude for a quick, private critique of one of their own options (only when the server has an
// ANTHROPIC_API_KEY). It's advice and never stops a round being sent. One is kept per option, since an option's
// image never changes; only its maker ever sees it.

/** What a second look judges, in this order: how it reads at the sizes viewers meet it, then against the brief and the client. */
export const SECOND_LOOK_CHECKS = ['reads_small', 'focal_point', 'words', 'contrast', 'brief_fit', 'brand_fit'] as const;
export type SecondLookCheckKey = (typeof SECOND_LOOK_CHECKS)[number];
export const SECOND_LOOK_CHECK_LABEL: Record<SecondLookCheckKey, string> = {
  reads_small: 'Reads small', focal_point: 'Focal point', words: 'Words', contrast: 'Contrast', brief_fit: 'Fits the brief', brand_fit: 'Fits the client',
};
export const SECOND_LOOK_STATUSES = ['strong', 'ok', 'watch'] as const;
export type SecondLookStatus = (typeof SECOND_LOOK_STATUSES)[number];
export const SECOND_LOOK_STATUS_LABEL: Record<SecondLookStatus, string> = { strong: 'Strong', ok: 'OK', watch: 'Watch' };
/** Each status's Chip colour (ui.tsx `Chip color`): strong mint, ok neutral, watch yellow. */
export const SECOND_LOOK_STATUS_COLOR: Record<SecondLookStatus, string> = { strong: 'mint', ok: 'neutral', watch: 'yellow' };
/** The longest headline, check note and suggestion a second look keeps, and how many suggestions. */
export const SECOND_LOOK_LIMITS = { oneLiner: 140, note: 160, suggestion: 160, suggestions: 3 } as const;
/**
 * The largest option a second look sends. The API takes at most 10 MB per image once base64-encoded, which is 4/3 the
 * size of the file, so 7 MB leaves room.
 */
export const SECOND_LOOK_MAX_BYTES = 7 * 1024 * 1024;

/** One of the six checks: how it does, and a short note on why. */
export interface SecondLookCheck { key: SecondLookCheckKey; status: SecondLookStatus; note: string }
/** What a second look says (kept as thumbnail_second_looks.result). */
export interface SecondLookResult {
  /** the headline, at most SECOND_LOOK_LIMITS.oneLiner characters */
  oneLiner: string;
  /** exactly the six SECOND_LOOK_CHECKS, in that order */
  checks: SecondLookCheck[];
  /** up to three concrete things to do in the design file */
  suggestions: string[];
}

/** Why an option can't have a second look, in plain words, or null when it can. Only its size: who may ask is the route's rule. */
export function secondLookRefusal(option: { size: number }): string | null {
  if (option.size <= SECOND_LOOK_MAX_BYTES) return null;
  return `This image is ${fmtBytes(option.size)}, and a second look takes images up to ${SECOND_LOOK_MAX_BYTES / 1024 / 1024} MB. Export a lighter copy (a JPG is usually much smaller) to ask for one.`;
}

/** Text as a second look keeps it: spaces collapsed, trimmed, and cut at a word break with an ellipsis when it's over `max`. */
function clipText(v: unknown, max: number): string {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const at = cut.lastIndexOf(' ');
  // never half an emoji (the database refuses a lone surrogate), nor a dangling comma before the ellipsis
  return `${(at >= max * 0.6 ? cut.slice(0, at) : cut).replace(/[\uD800-\uDBFF]$/, '').replace(/[\s,;:–—-]+$/, '')}…`;
}

/**
 * A second look's answer made safe to keep and show: every text trimmed and cut to its limit (SECOND_LOOK_LIMITS) at
 * a word break, the six checks in their order (the first of each key; anything else dropped), and at most three
 * suggestions, empty ones dropped. Null when it can't be used: no headline, a check missing, or a status that isn't
 * one of the three. The server runs every answer through this before keeping it.
 */
export function tidySecondLook(raw: unknown): SecondLookResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { oneLiner?: unknown; checks?: unknown; suggestions?: unknown };
  const L = SECOND_LOOK_LIMITS;
  const oneLiner = clipText(r.oneLiner, L.oneLiner);
  if (!oneLiner) return null;
  const given = (Array.isArray(r.checks) ? r.checks : []).filter((c): c is { key?: unknown; status?: unknown; note?: unknown } => !!c && typeof c === 'object');
  const checks: SecondLookCheck[] = [];
  for (const key of SECOND_LOOK_CHECKS) {
    const c = given.find((x) => x.key === key);
    if (!c || !(SECOND_LOOK_STATUSES as readonly unknown[]).includes(c.status)) return null;
    checks.push({ key, status: c.status as SecondLookStatus, note: clipText(c.note, L.note) });
  }
  const suggestions = (Array.isArray(r.suggestions) ? r.suggestions : [])
    .map((s) => clipText(s, L.suggestion))
    .filter(Boolean)
    .slice(0, L.suggestions);
  return { oneLiner, checks, suggestions };
}
