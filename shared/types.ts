// Shapes returned by the API. The server builds these; the client renders them.

import type { Clock, DayMode, ISODate } from './dates';
import type { WorkspaceTheme } from './palettes';
import type { DocumentState, Milestone, Progress, Role, ScriptStatus, Stage, VideoState } from './workflow';

/** Every change request carries `x-scale-media: 1`; a page can't send it cross-site without a CORS preflight, which the server never grants. */
export const CSRF_HEADER = 'x-scale-media';
/** Sent while the page is in Recording mode (its `startedAt`), so a change never lands on the real workspace once the practice copy is gone. */
export const RECORDING_HEADER = 'x-scale-recording';

export type Priority = 'low' | 'normal' | 'high' | 'urgent';
export const PRIORITIES: Priority[] = ['low', 'normal', 'high', 'urgent'];
export const PRIORITY_LABEL: Record<Priority, string> = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };

export type DateMode = 'auto' | 'manual';

export interface Me {
  id: number;
  name: string;
  email: string;
  role: Role;
  capacityPerDay: number | null;
}

export interface UserSummary extends Me {
  active: boolean;
  removed: boolean;
  /** the temporary password, readable until the person sets their own (owners and managers only) */
  tempPassword: string | null;
  /** where they work from ("Toronto, Canada"), for their local time */
  city: string | null;
  /** their IANA time zone: the city's, unless one was chosen */
  timezone: string | null;
  /** local working hours; the end may pass midnight (e.g. [20, 28]) */
  workHours: [number, number] | null;
  /**
   * the email Timeliner knows them by, when it isn't their sign-in email (null when it's the same, or not set). A
   * Timeliner member is this person when the member's email is their sign-in email or this one. Never used to sign in
   */
  timelinerEmail: string | null;
}

/** An editor kept in Settings → Editors (city, local time, hours) who doesn't use the platform. */
export interface Editor {
  id: number;
  name: string;
  /** "London, United Kingdom" */
  city: string;
  /** IANA time zone: the city's, unless one was chosen */
  timezone: string;
  workHours: [number, number];
  /** the email Timeliner knows them by: a Timeliner member with it is this editor (else one with the same name is) */
  timelinerEmail: string | null;
}

export interface Settings {
  orgName: string;
  timezone: string;
  cutoff: string;
  draftOffsetDays: number;
  finalOffsetDays: number;
  dayMode: DayMode;
  workingDays: number[];
  reminderLeadDays: number;
  /** remind managers this many days before a shoot whose scripts aren't planned or assigned */
  planReminderDays: number;
  isDemo: boolean;
  remindersLastRunAt: string | null;
  /** false when reminders are switched off on this server */
  remindersEnabled: boolean;
  /** the colour palette the admin picked for the whole site (null = the original) */
  theme: WorkspaceTheme | null;
  /**
   * the day the team began giving each client one editor: only videos made in Timeliner on or after it (in the
   * workspace's time zone) count for the Editors tab's one-editor-per-client checks (`underOneEditorRule`)
   */
  oneEditorSince: ISODate;
}

export interface ClientLite {
  id: number;
  name: string;
  /** prospect = a potential client, not signed yet */
  status: 'prospect' | 'active' | 'archived';
}

export interface Counts {
  myOpenScripts: number;
  /** batches with work given to me this week that I haven't started */
  myNewWork: number;
  reviewQueue: number;
  unreadNotifications: number;
  attention: number;
}

/** approved = every script in it approved or delivered; delivered = all delivered to Timeliner */
export type DeliverableState = DocumentState;

/** One document (a PDF or a link) covering a writer's scripts for a batch: one entry in the Script bank. */
export interface Deliverable {
  key: string;
  /** none: scripts that were sent or finished without any document attached */
  kind: 'file' | 'link' | 'none';
  href: string | null;
  name: string | null;
  note: string | null;
  /** each script is listed under the newest document it was sent in; older versions are on the batch page */
  version: number;
  sentAt: string;
  writerId: number | null;
  writerName: string | null;
  /** null for past scripts added by hand, which aren't part of a batch */
  batchId: number | null;
  /** the batch, or the past document's title */
  batchTitle: string;
  batchArchived: boolean;
  clientId: number;
  clientName: string;
  shootId: number | null;
  shootDate: string | null;
  scripts: { id: number; number: number; status: ScriptStatus }[];
  /** how many of its scripts are approved or delivered */
  finished: number;
  /** set for scripts from before the platform, uploaded straight to the Script bank */
  past: { id: number; scriptCount: number | null; writtenOn: string | null } | null;
  /** "1–45" */
  ranges: string;
  state: DeliverableState;
  /** the version a manager approved with their own edits: the one to use, for the scripts in `ranges` */
  edited: { kind: 'file' | 'link'; href: string; name: string | null; at: string; by: string; note: string | null; ranges: string } | null;
  timelinerUrl: string | null;
}

export interface ScriptBankPage {
  deliverables: Deliverable[];
  total: number;
  /** scripts across all matching deliverables */
  scriptCount: number;
  nextOffset: number | null;
}

/** What's due today (and anything overdue still open, or finished today), counted in scripts. */
export interface TodayTasks {
  date: string;
  /** me = the viewer's own scripts; person = one writer (managers); team = everyone */
  scope: 'me' | 'person' | 'team';
  total: number;
  done: number;
  /** script deadlines per batch, plus to-dos due today or overdue (kind 'todo', one each) */
  items: { batchId: number | null; batchTitle: string; clientName: string; kind: 'draft' | 'final' | 'todo'; text?: string; total: number; done: number; overdue: boolean }[];
}

/** An admin's View as / Recording mode state (null for everyone else). */
export interface SessionMode {
  realId: number;
  realName: string;
  /** whose eyes the site is showing, when it isn't the admin's own */
  viewingAs: { id: number; name: string; role: Role; roleLabel: string } | null;
  /** a practice copy of the workspace: anything goes, and it's all thrown away when turned off */
  recording: { startedAt: string } | null;
}

/** The error code when a page in Recording mode tries a change after its practice copy is gone (a restart, or the copy was closed). */
export const RECORDING_ENDED = 'recording_ended';

export interface Bootstrap {
  /** who the site is showing (the viewed person while viewing as someone) */
  me: Me;
  mode: SessionMode | null;
  /** reading pasted notes with AI is set up on the server (ANTHROPIC_API_KEY) */
  notesImport: boolean;
  /** the largest file the server accepts, in MB (UPLOAD_LIMIT_MB) */
  uploadLimitMb: number;
  /** the newest What's new entry this person has opened */
  whatsNewSeen: string | null;
  /** this person's own time zone (times across the site show in it) and whether they've confirmed it */
  timezone: { mine: string | null; confirmed: boolean };
  /** signed in with a temporary password an admin or manager set */
  mustChangePassword: boolean;
  settings: Settings;
  users: UserSummary[];
  clients: ClientLite[];
  clock: Clock;
  counts: Counts;
}

export interface WriterShare {
  userId: number | null;
  name: string;
  count: number;
  ranges: string;
  draftReady: number;
  /** approved, including delivered */
  approved: number;
  delivered: number;
  /** sent back for revisions, waiting to be resubmitted */
  revisions: number;
  /** the writer's own "written so far" count (never less than what they've sent) */
  written: number;
  writtenAt: string | null;
  /** how far their counter went up today (workspace time) */
  writtenToday: number;
}

export interface BatchSummary {
  id: number;
  title: string;
  clientId: number;
  clientName: string;
  shootId: number | null;
  shootTitle: string | null;
  shootStart: ISODate | null;
  shootEnd: ISODate | null;
  targetCount: number;
  priority: Priority;
  plannedStart: ISODate | null;
  draftDue: ISODate | null;
  draftDueMode: DateMode;
  finalDue: ISODate | null;
  finalDueMode: DateMode;
  blocked: boolean;
  blockerNote: string | null;
  blockedAt: string | null;
  blockedBy: number | null;
  blockedByName: string | null;
  nextAction: string | null;
  needsDateReview: boolean;
  dateReviewNote: string | null;
  archivedAt: string | null;
  progress: Progress;
  /** scripts written so far, from writers' progress counters plus everything already sent */
  written: number;
  /** how far writers' counters went up today, across the batch */
  writtenToday: number;
  stage: Stage;
  writers: WriterShare[];
  draft: Milestone;
  final: Milestone;
  next: Milestone | null;
  unresolvedRevisions: number;
  updatedAt: string;
}

export interface Script {
  id: number;
  batchId: number;
  number: number;
  assigneeId: number | null;
  assigneeName: string | null;
  status: ScriptStatus;
  docUrl: string | null;
  timelinerUrl: string | null;
  notes: string | null;
  version: number;
  submittedAt: string | null;
  approvedAt: string | null;
  approvedByName: string | null;
  deliveredAt: string | null;
  deliveredByName: string | null;
  deliveryId: number | null;
  openRevision: RevisionRequest | null;
  /** when it was given to its current writer */
  assignedAt: string | null;
  updatedAt: string;
}

export interface RevisionRequest {
  id: number;
  scriptId: number;
  scriptNumber: number;
  batchId: number;
  note: string;
  requestedByName: string;
  requestedAt: string;
  resolvedAt: string | null;
  resolvedByName: string | null;
  resolution: string | null;
  reviewId: number | null;
}

export interface Resource {
  id: number;
  clientId: number;
  clientName: string;
  briefingId: number | null;
  briefingTitle: string | null;
  batchId: number | null;
  batchTitle: string | null;
  kind: 'link' | 'file';
  category: ResourceCategory;
  title: string;
  url: string | null;
  fileId: number | null;
  fileName: string | null;
  fileSize: number | null;
  notes: string | null;
  createdByName: string;
  createdById: number;
  createdAt: string;
  /** a client resource picked for this batch (only set when loaded for a batch) */
  attached?: boolean;
}

export type ResourceCategory = 'folder' | 'example' | 'asset' | 'recording' | 'document' | 'other';
export const RESOURCE_CATEGORIES: ResourceCategory[] = ['folder', 'example', 'asset', 'recording', 'document', 'other'];
export const RESOURCE_LABEL: Record<ResourceCategory, string> = {
  folder: 'Folder', example: 'Example', asset: 'Asset', recording: 'Recording', document: 'Document', other: 'Other',
};

export interface Briefing {
  id: number;
  clientId: number;
  title: string;
  callDate: ISODate | null;
  recordingUrl: string | null;
  documentUrl: string | null;
  summary: string | null;
  instructions: string | null;
  resources: Resource[];
  batchIds: number[];
  createdByName: string;
  createdAt: string;
}

export interface Shoot {
  id: number;
  clientId: number;
  clientName: string;
  title: string | null;
  startDate: ISODate;
  endDate: ISODate | null;
  location: string | null;
  notes: string | null;
  batchIds: number[];
  cancelledAt: string | null;
  /** the synced-calendar event it was planned from */
  calendarUid: string | null;
}

/** Editors' view of a shoot: are its scripts ready to cut from? */
export interface ShootReadiness {
  shoot: Shoot;
  total: number;
  /** approved or delivered */
  finished: number;
  /** the earliest final-delivery date among its batches */
  finalDue: ISODate | null;
  /** ready = every script finished; late = final delivery has passed (or the shoot is here) without them; on_track otherwise */
  state: 'ready' | 'on_track' | 'late' | 'no_scripts';
}

export interface Delivery {
  id: number;
  batchId: number;
  confirmedById: number;
  confirmedByName: string;
  confirmedAt: string;
  timelinerUrl: string | null;
  note: string | null;
  scriptNumbers: number[];
  /** who said it's delivered: a person on the team, or Timeliner itself when the script document landed there */
  verification: 'writer_confirmed' | 'timeliner';
  /** writers it was confirmed for, when someone else (a manager) confirmed it */
  forNames: string[];
}

export interface Activity {
  id: number;
  actorName: string | null;
  action: string;
  summary: string;
  detail: Record<string, unknown> | null;
  batchId: number | null;
  batchTitle: string | null;
  clientId: number | null;
  createdAt: string;
}

export interface BatchDetail extends BatchSummary {
  brief: string | null;
  clientBrandVoice: string | null;
  clientGuidance: string | null;
  scripts: Script[];
  briefings: Briefing[];
  resources: Resource[];
  revisions: RevisionRequest[];
  deliveries: Delivery[];
  activity: Activity[];
  draftRule: string | null;
  finalRule: string | null;
  canEdit: boolean;
  isAssigned: boolean;
  submissions: Submission[];
  groups: ReviewGroup[];
}

export interface ClientSummary {
  id: number;
  name: string;
  /** prospect = a potential client, not signed yet */
  status: 'prospect' | 'active' | 'archived';
  ownerId: number | null;
  ownerName: string | null;
  description: string | null;
  activeBatches: number;
  scriptsTotal: number;
  scriptsDelivered: number;
  nextShoot: ISODate | null;
  overdueBatches: number;
  createdAt: string;
  becameClientAt: string | null;
}

export interface ClientDetail extends ClientSummary {
  brandVoice: string | null;
  guidance: string | null;
  briefings: Briefing[];
  resources: Resource[];
  shoots: Shoot[];
  batches: BatchSummary[];
  activity: Activity[];
}

export interface Notification {
  id: number;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface WriterLoad {
  userId: number;
  name: string;
  role: Role;
  activeBatches: number;
  assigned: number;
  remaining: number;
  toDeliver: number;
  overdueScripts: number;
  blockedBatches: number;
  nextDeadline: { date: ISODate; kind: 'draft' | 'final'; batchId: number; batchTitle: string; clientName: string } | null;
  capacityPerDay: number | null;
  /** scripts not yet draft-ready with drafts due in the next 7 days (incl. overdue) */
  dueNext7: number;
  /** capacity over the same window, when configured */
  capacityNext7: number | null;
  overCapacity: boolean;
}

export interface DueBucketItem {
  batchId: number;
  batchTitle: string;
  clientName: string;
  count: number;
  byCategory: Record<DueCategory, number>;
  /** the deadline this batch is counted against (an overdue one is before today) */
  dueDate: ISODate;
  /** writers with scripts in this count */
  writerIds: number[];
}

export type DueCategory = 'not_started' | 'writing' | 'in_review' | 'to_deliver';
export const DUE_CATEGORIES: DueCategory[] = ['not_started', 'writing', 'in_review', 'to_deliver'];
export const DUE_CATEGORY_LABEL: Record<DueCategory, string> = {
  not_started: 'Not started',
  writing: 'Writing',
  in_review: 'In review',
  to_deliver: 'Approved · to deliver',
};

export interface DueDay {
  date: ISODate | 'overdue';
  total: number;
  byCategory: Record<DueCategory, number>;
  items: DueBucketItem[];
}

export type AttentionKind = 'overdue' | 'blocked' | 'due_today' | 'date_review' | 'unassigned' | 'revisions';

export interface AttentionItem {
  /** the most severe issue on the batch */
  kind: AttentionKind;
  batch: BatchSummary;
  issues: { kind: AttentionKind; text: string }[];
}

export interface Dashboard {
  clock: Clock;
  /** team = everyone's work (admins and managers); mine = only the viewer's own scripts (writers) */
  scope: 'team' | 'mine';
  cards: {
    overdueBatches: number;
    overdueScripts: number;
    dueTodayBatches: number;
    dueTodayScripts: number;
    awaitingReviewScripts: number;
    awaitingReviewBatches: number;
    deliveredThisWeekScripts: number;
    deliveredThisWeekBatches: number;
    /** scripts delivered on each day of this week, Monday first */
    deliveredByDay: number[];
    /** when the longest-waiting script in review was sent */
    oldestInReviewAt: string | null;
    lastReviewAt: string | null;
  };
  due: { draft: DueDay[]; final: DueDay[] };
  attention: AttentionItem[];
  upcomingShoots: (Shoot & { batches: BatchSummary[]; daysUntil: number })[];
  activeBatches: BatchSummary[];
  workload: WriterLoad[];
  recentDeliveries: (Delivery & { batchTitle: string; clientName: string })[];
  unassignedScripts: number;
}

export interface CalendarEvent {
  id: string;
  type: 'writing' | 'draft' | 'final' | 'shoot' | 'external';
  start: ISODate;
  end: ISODate;
  title: string;
  clientName: string;
  batchId: number | null;
  shootId: number | null;
  overdue: boolean;
  complete: boolean;
  /** an event from a synced calendar (Google Calendar) */
  external?: ExternalEventInfo;
}

export interface ExternalEventInfo {
  feedId: number;
  feedName: string;
  color: string;
  allDay: boolean;
  startAt: string;
  endAt: string;
  location: string | null;
  description: string | null;
  /** the event's id in its calendar */
  uid: string;
  /** the site shoot planned from this event, if any (and its first batch) */
  linkedShootId: number | null;
  linkedBatchId: number | null;
}

/** A synced calendar, as managers see it in Settings (the secret address is never sent back in full). */
export interface CalendarFeed {
  id: number;
  name: string;
  urlHint: string;
  color: string;
  /** managers: admins and managers · editors: and editors · everyone: and writers too */
  visibility: 'managers' | 'editors' | 'everyone';
  lastSyncedAt: string | null;
  lastError: string | null;
  eventCount: number;
}

/** A document (PDF upload or link) a writer sent for a set of their scripts. */
export interface Attachment {
  url: string | null;
  fileId: number | null;
  fileName: string | null;
  fileSize: number | null;
}

export interface ReviewRecord extends Attachment {
  id: number;
  batchId: number;
  submissionId: number | null;
  action: 'approved' | 'revisions';
  scriptNumbers: number[];
  note: string | null;
  reviewedByName: string;
  createdAt: string;
}

export type SubmissionState = 'in_review' | 'revisions_requested' | 'approved' | 'delivered' | 'superseded' | 'withdrawn';

export interface Submission extends Attachment {
  id: number;
  batchId: number;
  writerId: number | null;
  writerName: string | null;
  submittedByName: string;
  version: number;
  previousId: number | null;
  note: string | null;
  createdAt: string;
  /** every script this document was sent for */
  scriptNumbers: number[];
  /** scripts for which this is still the latest document */
  currentNumbers: number[];
  counts: { inReview: number; approved: number; delivered: number; revisions: number; notSubmitted: number };
  state: SubmissionState;
  reviews: ReviewRecord[];
  /** when this is a revised version: the send-back it answers */
  afterFeedback: { note: string | null; byName: string; at: string } | null;
}

/** Scripts reviewed together: everything one writer sent as one document, or sent back in one go. */
export interface ReviewGroup {
  key: string;
  kind: 'waiting' | 'sent_back';
  batch: BatchSummary;
  writerId: number | null;
  writerName: string;
  submission: Submission | null;
  /** for sent_back: the decision that sent them back (note and any attached changes) */
  review: ReviewRecord | null;
  scripts: Script[];
  since: string | null;
}

export interface ReviewQueue {
  waiting: ReviewGroup[];
  sentBack: ReviewGroup[];
}

export interface MyWork {
  batches: {
    batch: BatchSummary; mine: Script[]; myProgress: Progress;
    /** deadlines measured on this writer's own scripts */
    myDraft: Milestone; myFinal: Milestone; myNext: Milestone | null;
    /** when the writer last looked at this batch (Got it, opened it, sent or updated the counter) */
    seenAt: string | null;
    briefings: Briefing[]; resources: Resource[]; groups: ReviewGroup[]; submissions: Submission[];
  }[];
  sentBack: ReviewGroup[];
  recentDeliveries: (Delivery & { batchTitle: string; clientName: string })[];
}

export interface AuditEntry {
  id: string;
  at: string;
  userId: number | null;
  userName: string | null;
  kind: 'view' | 'change' | 'auth' | 'denied';
  summary: string;
  link: string | null;
  ip: string | null;
}

/** What the notes reader understood from pasted notes: previewed and edited before anything is saved. */
export interface ImportPlan {
  summary: string;
  clients: ImportClient[];
  /** things it had to assume; answer them and it reads the notes again */
  questions: { clientName: string | null; question: string; assumed: string }[];
}

export interface ImportClient {
  name: string;
  /** set by the server when the name matches an existing client */
  existingClientId: number | null;
  status: 'active' | 'prospect';
  description: string | null;
  brandVoice: string | null;
  /** posting instructions, formats to use, anything writers should always know */
  guidance: string | null;
  briefings: { title: string; summary: string | null; instructions: string | null }[];
  shoots: { key: string; title: string | null; startDate: ISODate; endDate: ISODate | null }[];
  batches: {
    title: string; targetCount: number | null; shootKey: string | null; plannedStart: ISODate | null;
    draftDue: ISODate | null; finalDue: ISODate | null; brief: string | null; writerNames: string[]; nextAction: string | null;
  }[];
  /** assumptions and reminders for this client, shown in the preview */
  notes: string[];
}

export interface ImportResult {
  clients: { clientId: number; name: string; created: boolean; lines: string[] }[];
  warnings: string[];
}

export type MomentKind = 'approved' | 'revisions' | 'drafts_done' | 'batch_done' | 'team_drafts_done' | 'team_batch_done';

/** Something worth celebrating (or knowing about), shown once as an animation. */
export interface Moment {
  id: number;
  kind: MomentKind;
  batchId: number | null;
  batchTitle: string;
  clientName: string;
  numbers: number[];
  count: number;
  /** who approved / sent back, or which writer finished */
  byName: string | null;
  note: string | null;
  /** approved: every one of their scripts in the batch is now approved */
  allMine: boolean;
  withAttachment: boolean;
  /** the person did this themselves (shown straight away) */
  self: boolean;
  createdAt: string;
}

export interface ReschedulePreview {
  shoot: Shoot;
  newStart: ISODate;
  newEnd: ISODate | null;
  /** how many days the shoot moves (negative = earlier) */
  days: number;
  /** planned writing starts move by the same number of days */
  plannedStarts: { batchId: number; batchTitle: string; from: ISODate; to: ISODate }[];
  /** batches named after the shoot's dates get the new dates in their name */
  renames: { batchId: number; from: string; to: string }[];
  /** manual deadlines that could be moved too (see shiftManual) */
  manualCount: number;
  changes: {
    batchId: number;
    batchTitle: string;
    field: 'draftDue' | 'finalDue';
    mode: DateMode;
    from: ISODate | null;
    to: ISODate | null;
    kept: boolean;
    inPast: boolean;
  }[];
  affectedWriters: string[];
  /** batches where drafts would be due after final delivery */
  outOfOrder: { batchId: number; batchTitle: string; draftDue: ISODate; finalDue: ISODate }[];
}

export interface SearchResults {
  clients: ClientLite[];
  batches: { id: number; title: string; clientName: string }[];
  resources: { id: number; title: string; clientName: string; url: string | null; fileId: number | null }[];
  people: { id: number; name: string; role: Role }[];
  shoots: { id: number; title: string; clientId: number; clientName: string; startDate: string; batchId: number | null }[];
  /** "#12" or "script 12": that script number in every active batch */
  scripts: { batchId: number; batchTitle: string; clientName: string; number: number }[];
  briefings: { id: number; title: string; clientId: number; clientName: string; callDate: string | null }[];
}

export interface ApiErrorBody {
  error: { message: string; code?: string; fields?: Record<string, string> };
}

/** Something a manager asked a writer to do, or a note-to-self. */
export interface Todo {
  id: number;
  userId: number;
  userName: string;
  text: string;
  due: ISODate | null;
  batchId: number | null;
  batchTitle: string | null;
  clientName: string | null;
  createdById: number;
  createdByName: string;
  createdAt: string;
  doneAt: string | null;
  /** may change the text, date or remove it (the person who added it, or a manager) */
  canEdit: boolean;
}

/** A shoot on a synced calendar (e.g. Joshua's Google Calendar) that still needs planning on the site. */
export interface CalendarShoot {
  uid: string;
  feedName: string;
  color: string;
  title: string;
  start: ISODate;
  end: ISODate;
  location: string | null;
  /** the client it seems to be for, from the event's title */
  client: { id: number; name: string } | null;
  /** no_shoot: not on the site yet · no_scripts: on the site, no scripts planned · unassigned: scripts without a writer */
  status: 'no_shoot' | 'no_scripts' | 'unassigned';
  shootId: number | null;
  batchId: number | null;
  unassigned: number;
  total: number;
  /** what this client's last batch had, to start from */
  suggested: { count: number; split: { writerId: number; name: string; count: number }[] } | null;
}

// ── Timeliner ─────────────────────────────────────────────────────────────

/**
 * What happened to one message from Timeliner. `new_version`: a later version of a scripts PDF already linked to
 * its batch, with nothing new to deliver (a version that delivers newly approved scripts is `delivered`).
 */
export type TimelinerOutcome = 'delivered' | 'unmatched' | 'nothing_approved' | 'already_delivered' | 'ignored' | 'test' | 'new_version';

export interface TimelinerEvent {
  id: string;
  receivedAt: string;
  fileName: string | null;
  /** the Timeliner brand / project / task it arrived in, as far as known */
  where: string | null;
  uploader: string | null;
  /**
   * What became of it, among the outcomes Settings → Timeliner has always listed: a `new_version` is listed here as
   * `already_delivered` (nothing to pick). `result` says exactly what happened.
   */
  outcome: Exclude<TimelinerOutcome, 'new_version'>;
  /** exactly what became of it, `new_version` included ("New version of the scripts PDF") */
  result: TimelinerOutcome;
  /** the version number Timeliner gave the file (a raw project file counts up from 1); null for older messages */
  version: number | null;
  /** why it couldn't be placed, or what was delivered */
  detail: string | null;
  batch: { id: number; title: string; clientName: string } | null;
  /** the batch it most likely belongs to, when it couldn't be placed for sure: preselect it in Pick batch */
  suggestedBatch: { id: number; title: string; clientName: string } | null;
}

/**
 * How a scripts PDF in Timeliner was matched to its batch, once: a date in its name (`name`), the only shoot
 * waiting for its scripts (`date`), the earliest of several (`earliest`), a shoot that just happened (`late`), the
 * client's only undated batch (`only`), a manager's pick (`manager`), or carried over from a delivery made before
 * PDFs were linked (`backfill`). Every later version of the same PDF follows the link.
 */
export type TimelinerPdfHow = 'name' | 'date' | 'earliest' | 'late' | 'only' | 'manager' | 'backfill';

/** A scripts PDF in Timeliner linked to its batch (one per shoot); its versions follow it. */
export interface TimelinerPdfLink {
  /** Timeliner's task id, or `file:<id>` for a file uploaded straight into a project */
  key: string;
  kind: 'task' | 'file';
  batch: { id: number; title: string; clientName: string };
  fileName: string | null;
  /** the task's title in Timeliner */
  title: string | null;
  version: number;
  /** when the PDF was first made (its task's creation), and when its latest version arrived */
  firstAt: string;
  latestAt: string;
  how: TimelinerPdfHow;
  /** false when picked by date among several shoots, or because a shoot had just happened */
  sure: boolean;
  /** trashed in Timeliner (it comes back if a new version arrives or it's restored) */
  gone: boolean;
  /** its task is back in review in Timeliner (not approved or with the client) */
  inReview: boolean;
  /** the manager who picked its batch, for `manager` */
  linkedBy: string | null;
}

/**
 * What the Timeliner key needs: read the videos (tasks), where they and uploads sit (projects and brands), and who
 * is who (workspace members). Registering the webhook also needs Webhooks; without it the videos are still read on
 * a timer. Settings → Timeliner and the server's errors both say this.
 */
export const TIMELINER_KEY_PERMISSIONS = 'Tasks (read), Projects (read), Workspace (read) and Webhooks (read & write)';

/** Settings → Timeliner. */
export interface TimelinerStatus {
  /** TIMELINER_API_KEY is set on the server */
  keySet: boolean;
  /** the address Timeliner calls; null when the site doesn't know its public address (set PUBLIC_URL) */
  webhookUrl: string | null;
  connected: { at: string; byName: string | null } | null;
  /** when Timeliner's test message last arrived and checked out */
  testAt: string | null;
  events: TimelinerEvent[];
  /**
   * batches to place an upload with (Pick batch): those with approved scripts not yet delivered, any batch an upload
   * in `events` suggests, and every batch still without a scripts PDF whose shoot is around when those uploads came
   * in. Picking one links the PDF to it (its later versions follow), even when nothing is approved yet; a PDF already
   * linked elsewhere moves once its delivery there is undone.
   */
  openBatches: { id: number; title: string; clientName: string; approved: number }[];
  /** the scripts PDFs linked to batches, newest version first */
  pdfs: TimelinerPdfLink[];
}

// ── Editing: the videos editors cut, read from Timeliner ─────────────────

/** A script document an editor cuts from. */
export interface ScriptDoc {
  /**
   * opens the file (/api/files/…) or the link; for the scripts PDF in Timeliner, /api/editing/script-pdf/:batchId,
   * which redirects to a fresh download link each time (Timeliner's links expire, so none is ever stored or sent)
   */
  href: string;
  name: string | null;
  /** the manager's edited version: the one to use */
  edited: boolean;
  /** which scripts it holds, "1–30" (for the scripts PDF: the batch's delivered scripts) */
  ranges: string;
  batchId: number;
  batchTitle: string;
  /** `timeliner`: the shoot's scripts PDF in Timeliner, its newest version ("Scripts PDF · v3 · from Timeliner"); `site`: a document sent here, or the manager's edited version */
  source: 'site' | 'timeliner';
  /** the scripts PDF's version in Timeliner; null for the site's documents */
  version: number | null;
  /** when that version arrived in Timeliner, or when the site's document was sent or approved with edits */
  updatedAt: string | null;
  /** the scripts PDF is in Needs review or Revisions requested in Timeliner ("being reviewed again"); false for the site's documents */
  inReview: boolean;
  /**
   * the second link: the site's document for the same script when the scripts PDF comes first, or the scripts PDF
   * when the script was approved on the site after the PDF's newest version (the site's document comes first then).
   * Only on a video's own `script`: a list of a batch's documents (`scripts`) has none.
   */
  alt: ScriptDoc | null;
}

/**
 * How a video was matched to its shoot's batch: pinned by a manager, a version of another video (`parent`), its
 * folder made for one shoot's scripts (`place`), its folder or title naming the shoot's date (`name`), the shoot
 * whose raw clips its editor has been cutting (`editor`), the latest shoot before it was made (`date`), the shoot
 * just after (`next`, when it was made ahead), or the client's only undated batch (`undated`).
 *
 * Two answers that are normal work, not gaps (never "Not matched"): `no_scripts`, its Timeliner brand is a site
 * client that has no scripts on the site (clientId set, no batch); `no_client`, its brand (or project) is no site
 * client (no client, no batch; `EditingVideo.brand` names it).
 */
export type VideoMatchHow = 'pinned' | 'parent' | 'place' | 'name' | 'editor' | 'date' | 'next' | 'undated' | 'no_scripts' | 'no_client';

/** How sure the site is of a video's batch. */
export interface VideoMatch {
  /**
   * null: not matched (the editor sees "Not matched yet — a manager has been asked"). `no_scripts` and `no_client`
   * aren't gaps: a client without scripts on the site, or a brand that isn't a site client ("No scripts on the site")
   */
  how: VideoMatchHow | null;
  /** matched before and kept: it has been in review (or was made ahead of its shoot), so later changes don't move it */
  kept: boolean;
  /**
   * pinned, by name, by its folder, a raw clip by its date, or a titled video by its editor's raw clips; a parent's
   * or a kept match is as sure as the match it came from. Not sure (a titled video by its date alone, made ahead, or
   * the only undated batch): the editor sees "matched by date"
   */
  sure: boolean;
  /** another video in the same folder has the same title and batch: one of them may be from another shoot (a "Check" chip) */
  check: boolean;
  /** for managers: why, like "Made Oct 16, 2 days after the Oct 14 shoot", or why it couldn't be matched. Never sent to editors (null in /api/editing/me) */
  note: string | null;
}

/** One video (a Timeliner task) assigned to an editor: on the video itself, or through its client (`assignedBy`). */
export interface EditingVideo {
  /** Timeliner's task id */
  id: string;
  /** as named in Timeliner ("Organic 05") */
  title: string;
  state: VideoState;
  /** Timeliner's step in the team's words ("To be edited", "Needs review"…) */
  step: string;
  /** the Timeliner folder it sits in ("My Videos › Organic") */
  folder: string | null;
  client: { id: number; name: string } | null;
  /** the Timeliner brand (client) it's under, by its name there: shown where the client's name goes when there's no site client */
  brand: string | null;
  /**
   * how it came to its editor in Timeliner: assigned on the video (`video`), or nobody is on the video and it's its
   * client's, whose dedicated editor is assigned on the brand (`client`, shown quietly as "via client")
   */
  assignedBy: 'video' | 'client';
  /** the batch whose scripts it's cut from, when it could be matched */
  batch: { id: number; title: string; shootDate: ISODate | null } | null;
  /**
   * the script it's cut from: "#12", "Script 12", or the number standing alone in its title, within that batch.
   * Never for a raw clip, and for a video still To be edited only when its title says "#12", "Script 12" or "No. 12"
   */
  scriptNumber: number | null;
  /**
   * the document to cut from: with a number, that script's document (the scripts PDF from Timeliner first, else
   * the manager's edited version, else the document it was sent in); without one (a raw clip), the shoot's whole
   * scripts PDF when it's in Timeliner
   */
  script: ScriptDoc | null;
  /**
   * why there's no `script`: not matched to a batch, that script isn't approved yet ("Script 6 isn't approved yet"),
   * no document an editor can open, or no scripts on the site for its client (`match.how` is `no_scripts` or `no_client`)
   */
  scriptIssue: 'not_matched' | 'not_approved' | 'no_document' | 'no_scripts' | null;
  /** a raw camera clip ("C0045", "IMG_1234.MOV"), shown as "Raw clip C0045": footage the editor cuts into a titled video */
  raw: boolean;
  match: VideoMatch;
  /** Timeliner's team deadline, else the client one */
  due: ISODate | null;
  /** revision rounds so far (team and client) */
  revisionRound: number;
  /** when it moved to its current step, as far as known */
  movedAt: string | null;
  /** the editor marked it done here; it moves on when Timeliner has it in review */
  doneAt: string | null;
}

/** What an editor said they're on: the one tap Timeliner can't give. */
export interface EditorFocus {
  video: EditingVideo;
  state: 'on' | 'paused';
  /** when the current stretch began (the tap, or Resume) */
  since: string;
  /** time on it before the current stretch, in seconds */
  workedSeconds: number;
  pausedAt: string | null;
}

/** How many of an editor's videos are at each state. */
export interface EditorPlate {
  toEdit: number;
  /** of those to edit, the raw camera clips ("24 clips to edit" when they all are) */
  rawToEdit: number;
  revisions: number;
  /** in review in Timeliner, or marked done here: waiting on the managers either way */
  inReview: number;
  withClient: number;
  /** approved in the last 7 days */
  approvedWeek: number;
}

/**
 * Why an editor's card needs fixing, one line each, ready to show. Each comes with what fixes it on the Editors tab:
 * - `not_on_site`: in Timeliner with videos, nobody on the site with that email as their sign-in or Timeliner email
 *   ("Not on the site — add them to the team, or link them to someone on the site"): Add to the team (their
 *   Timeliner email filled in as their Timeliner email), or link them to someone already there
 * - `no_site_access`: the same, but they're in Settings → Editors (the list of editors who don't sign in), by their
 *   Timeliner email there or by name, whose city, time zone and hours the card uses: Give site access, or link them
 * - `email_differs`: on the site under the same name with another email ("Timeliner knows Sam Lee as
 *   sam.lee@…"); their Timeliner work is on the card, but their taps (I'm on this) can't reach it until it's linked:
 *   Link adds that email as their Timeliner email
 * - `nothing_assigned`: an editor on the site with nothing in Timeliner, a quiet note ("Nothing assigned in Timeliner
 *   under a@…"), with a field to add their Timeliner email
 */
export type EditorFlagKind = 'not_on_site' | 'no_site_access' | 'email_differs' | 'nothing_assigned';
export interface EditorFlag {
  kind: EditorFlagKind;
  text: string;
  /** their email in Timeliner (null when Timeliner has none, and for `nothing_assigned` when they have no Timeliner email here) */
  timelinerEmail: string | null;
  /** their sign-in email on the site (`email_differs`, `nothing_assigned`) */
  siteEmail: string | null;
  /** `no_site_access`: their entry in Settings → Editors (to give them site access from the card) */
  offSiteId: number | null;
}

/** Someone who cuts a client's videos, as the Editors tab names them. */
export interface EditorRef {
  name: string;
  /** their site account (null when they aren't on the site) */
  userId: number | null;
  /** their Timeliner member id */
  memberId: string;
  /** their card's `key` on the board */
  key: string;
}

/** One client on an editor's card: "Joshua Shalimar · 32 videos". */
export interface EditorClient {
  /** the site client's name, else the Timeliner brand's */
  name: string;
  clientId: number | null;
  /** their videos of that client on the card (open, plus approved in the last 7 days) */
  count: number;
  /**
   * that client has more than one editor (this one among them): the one-line flag ("Brightside: 18 with Maya, 3 with
   * Sam — one editor per client", or "Brightside has 2 editors in Timeliner — one editor per client"), else null
   */
  split: string | null;
  /** they're this client's editor in Timeliner (on its brand), so its videos nobody is on are theirs ("via client") */
  viaClient: boolean;
}

/** One editor on the Editors tab: everyone in Timeliner with videos, and the site's editors. */
export interface EditorRow {
  /** stable and unique on the board: `u<userId>` for someone on the site, `m<memberId>` for someone only in Timeliner */
  key: string;
  /** their site account: matched by email, or by name when the emails differ (`flag.kind` is `email_differs`); null when not on the site */
  userId: number | null;
  /** their Timeliner member id (the one with the most videos); null for a site editor with nothing in Timeliner */
  memberId: string | null;
  /** on the site: a site account matched by email, or by name when the emails differ. Only an email match brings their taps (`focus`) */
  site: boolean;
  /** something to fix about who they are (null when nothing is) */
  flag: EditorFlag | null;
  /** the clients whose videos are on their card, most first: the card leads with them */
  clients: EditorClient[];
  name: string;
  city: string | null;
  timezone: string | null;
  workHours: [number, number] | null;
  /** outside their working hours right now (from their site profile, or from Settings → Editors when they aren't on the site) */
  offHours: boolean;
  /** what they tapped on the site (always null when they aren't on the site under their Timeliner email) */
  focus: EditorFocus | null;
  /** what's next by deadline (revisions first) */
  nextUp: EditingVideo | null;
  plate: EditorPlate;
  /** videos still to edit or fix that are due today or earlier */
  dueToday: number;
  /** the last video that left their plate: marked done here, or moved on in Timeliner */
  lastFinished: { title: string; at: string; onSite: boolean } | null;
  /** the script documents for what they're working on, each once (without a video's second link) */
  scripts: ScriptDoc[];
  /** their videos, for the drill-down: everything open, plus approved in the last 7 days */
  videos: EditingVideo[];
}

/** How fresh the copy of Timeliner is. */
export interface EditingSync {
  /** TIMELINER_API_KEY is set on the server */
  keySet: boolean;
  /** the last complete read of Timeliner */
  syncedAt: string | null;
  /** why the last read failed, when it did */
  error: string | null;
  /**
   * what the last complete read found: the videos it kept, the people with videos, the Timeliner brands (clients)
   * with videos, and the tasks, members, brands or projects it skipped because they couldn't be read. null before
   * the first read, and always for an editor (it's the managers')
   */
  counts: { videos: number; people: number; clients: number; skipped: number } | null;
}

/**
 * A client on the Editors tab's "Editors by client" strip: each client has one editor, who gets every video of
 * every shoot (worked out from Timeliner, nothing to fill in here).
 */
export interface ClientEditing {
  /** stable and unique on the board: `c<clientId>` for a site client, `b<brandId>` for a Timeliner brand that isn't one */
  key: string;
  /** the site client's name, else the Timeliner brand's */
  name: string;
  clientId: number | null;
  /** the Timeliner brand's name, when known */
  brand: string | null;
  /**
   * its editor: the one assigned to the client (its brand) in Timeliner; else whoever has the most of its videos made
   * in the last 60 days and since the one-editor rule began (a tie: whoever had one most recently). With several on
   * the brand, the one of them with the most of those videos. null when there's nobody, and for a client whose videos
   * are all from before the rule (`beforeRule`) unless exactly one editor is on it in Timeliner
   */
  editor: EditorRef | null;
  /** where `editor` comes from: assigned on the client in Timeliner, worked out from who has its videos, or nobody */
  editorFrom: 'client' | 'videos' | null;
  /** everyone assigned to the client (its brand) as an editor in Timeliner: more than one is flagged */
  editors: EditorRef[];
  /** its open videos (not approved), anyone's or nobody's */
  open: number;
  /**
   * its videos still to be edited that nobody has been given (made in the last 60 days, as in `unassigned`): no
   * assignee on the video, and nobody assigned to the client
   */
  notAssigned: number;
  /**
   * who has its open videos made since the one-editor rule began, most first, when more than one editor does (empty
   * otherwise). A video two people have (both on the client in Timeliner, say) counts for each
   */
  split: (EditorRef & { count: number })[];
  /**
   * one line each, calm, ready to show: "Brightside has 2 editors in Timeliner — one editor per client" when more
   * than one is on the client, else "Brightside: 18 with Maya, 3 with Sam — one editor per client" when split;
   * "Joshua Shalimar · 9 clips not assigned (usually Leo)" when some aren't assigned. Only videos made since the
   * one-editor rule began (`EditingBoard.oneEditorSince`) can raise the one-editor flags
   */
  flags: string[];
  /**
   * none of its videos were made since the one-editor rule began: nothing is worked out from its videos and it's
   * never flagged as split or as having two editors. Its tile says "Before the one-editor rule", unless exactly one
   * editor is on it in Timeliner (then `editor` is them, `editorFrom` is `client`)
   */
  beforeRule: boolean;
}

/** The managers' Editors tab. */
export interface EditingBoard {
  sync: EditingSync;
  /** the day the one-editor-per-client rule began (`Settings.oneEditorSince`): older videos never raise its flags */
  oneEditorSince: ISODate;
  /** over all the work in Timeliner, whoever has it (each video once), not only people on the site */
  totals: {
    /** on a video right now (site taps only); one left running (isFocusStale in shared/workflow.ts) isn't counted */
    editingNow: number;
    paused: number;
    /** videos still to edit or fix, due today or earlier */
    dueToday: number;
    revisions: number;
    /** in review with Josh and Joshua (Timeliner's internal review steps), anyone's, or marked done here */
    waitingOnYou: number;
    notAssigned: number;
    /**
     * open videos on the editors' cards not matched to a batch (`isNotMatched`; their editors see "Not matched yet"):
     * the ones a manager can pin. Never a video whose client has no scripts on the site (`no_scripts`, `no_client`)
     */
    notMatched: number;
    /** open videos on the editors' cards whose match is worth a look (`needsCheck`) */
    toCheck: number;
  };
  /**
   * a card for everyone in Timeliner with videos in the copy (any state) and every editor on the site; people to
   * fix carry a `flag` and sort with the rest. Editing now first, then paused (or left running), due today,
   * revisions, the rest; off hours last
   */
  editors: EditorRow[];
  /**
   * videos still to be edited in Timeliner with nobody assigned (nobody on the video, nobody on its client), by
   * folder; raw clips by the shoot they matched (else by folder)
   */
  unassigned: {
    folder: string; clientName: string | null; count: number;
    /** raw camera clips: "Oct 6 shoot · 9 clips not assigned" */
    raw: boolean;
    /** the batch they matched, for raw clips grouped by shoot */
    batch: { id: number; title: string; shootDate: ISODate | null } | null;
    /** "Organic 26–30" */
    titles: string;
    due: ISODate | null;
    /** each video's title, in number order, for its square */
    videoTitles: string[];
    /** the script documents they're cut from, as far as matched */
    scripts: ScriptDoc[];
    /** the Timeliner brand they're under, when known */
    brand: string | null;
    /** whom to give them: their client's editor ("usually Leo"), when it has one */
    suggested: EditorRef | null;
  }[];
  /** each client with videos in Timeliner (open ones, or made in the last 60 days), the most open videos first */
  clients: ClientEditing[];
  /**
   * people in Timeliner with open videos (on the video, or through their client) whose email doesn't match anyone
   * on the site. Kept for older screens: each of them now has a card in `editors`, flagged
   */
  unknownAssignees: { name: string; email: string | null; count: number }[];
}

/** An editor's own Home: their videos, straight from Timeliner. */
export interface MyEditing {
  sync: EditingSync;
  focus: EditorFocus | null;
  nextUp: EditingVideo | null;
  revisions: EditingVideo[];
  toEdit: EditingVideo[];
  /** in review with the team or the client, or marked done here */
  waiting: EditingVideo[];
  approvedWeek: EditingVideo[];
  scripts: ScriptDoc[];
}

export type FocusAction = 'start' | 'pause' | 'resume' | 'done';
