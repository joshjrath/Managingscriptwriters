// Shapes returned by the API. The server builds these; the client renders them.

import type { Clock, DayMode, ISODate } from './dates';
import type { WorkspaceTheme } from './palettes';
import type { Milestone, Progress, Role, ScriptStatus, Stage } from './workflow';

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
}

/** Someone shown in the Control Center (city, local time, hours) who doesn't use the platform. */
export interface Editor {
  id: number;
  name: string;
  /** "London, United Kingdom" */
  city: string;
  /** IANA time zone: the city's, unless one was chosen */
  timezone: string;
  workHours: [number, number];
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
  /** the colour palette the admin picked for the whole site (null = the original) */
  theme: WorkspaceTheme | null;
}

export interface ClientLite {
  id: number;
  name: string;
  /** prospect = a potential client, not signed yet */
  status: 'prospect' | 'active' | 'archived';
}

export interface Counts {
  myOpenScripts: number;
  reviewQueue: number;
  unreadNotifications: number;
  unreadMessages: number;
  attention: number;
}

/** approved = every script in it approved or delivered; delivered = all delivered to Timeliner */
export type DeliverableState = 'in_progress' | 'in_review' | 'revisions' | 'approved' | 'delivered';

/** One document (a PDF or a link) covering a writer's scripts for a batch: one entry in the Script bank. */
export interface Deliverable {
  key: string;
  kind: 'file' | 'link';
  href: string;
  name: string | null;
  note: string | null;
  /** the newest version is listed; older ones are on the batch page */
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
  shootDate: string | null;
  scripts: { id: number; number: number; title: string | null; status: ScriptStatus }[];
  /** set for scripts from before the platform, uploaded straight to the Script bank */
  past: { id: number; scriptCount: number | null; writtenOn: string | null } | null;
  /** "1–45" */
  ranges: string;
  state: DeliverableState;
  /** the version a manager approved with their own edits */
  edited: { kind: 'file' | 'link'; href: string; name: string | null; at: string } | null;
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
  items: { batchId: number; batchTitle: string; clientName: string; kind: 'draft' | 'final'; total: number; done: number; overdue: boolean }[];
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

export interface Bootstrap {
  /** who the site is showing (the viewed person while viewing as someone) */
  me: Me;
  mode: SessionMode | null;
  /** reading pasted notes with AI is set up on the server (ANTHROPIC_API_KEY) */
  notesImport: boolean;
  /** the newest What's new entry this person has opened */
  whatsNewSeen: string | null;
  /** this person's own time zone (times across the site show in it) and whether they've confirmed it */
  timezone: { mine: string | null; confirmed: boolean };
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
  title: string | null;
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
  verification: 'writer_confirmed';
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
  type: 'writing' | 'draft' | 'final' | 'shoot';
  start: ISODate;
  end: ISODate;
  title: string;
  clientName: string;
  batchId: number | null;
  shootId: number | null;
  overdue: boolean;
  complete: boolean;
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
  batches: { batch: BatchSummary; mine: Script[]; myProgress: Progress; briefings: Briefing[]; resources: Resource[]; groups: ReviewGroup[]; submissions: Submission[] }[];
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
}

export interface SearchResults {
  clients: ClientLite[];
  batches: { id: number; title: string; clientName: string }[];
  resources: { id: number; title: string; clientName: string; url: string | null; fileId: number | null }[];
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

/** A direct message between two team members. */
export interface ChatMessage {
  id: number;
  fromId: number;
  toId: number;
  body: string;
  createdAt: string;
  readAt: string | null;
}

/** One conversation in the list: the other person, the latest message and how many you haven't read. */
export interface ChatThread {
  userId: number;
  name: string;
  role: Role;
  last: ChatMessage;
  unread: number;
}

export interface ChatInbox {
  threads: ChatThread[];
  unread: number;
}
