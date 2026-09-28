// Shapes returned by the API. The server builds these; the client renders them.

import type { Clock, DayMode, ISODate } from './dates';
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
  isDemo: boolean;
  remindersLastRunAt: string | null;
}

export interface ClientLite {
  id: number;
  name: string;
  status: 'active' | 'archived';
}

export interface Counts {
  myOpenScripts: number;
  reviewQueue: number;
  unreadNotifications: number;
  attention: number;
}

export interface Bootstrap {
  me: Me;
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
  delivered: number;
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
}

export interface ClientSummary {
  id: number;
  name: string;
  status: 'active' | 'archived';
  ownerId: number | null;
  ownerName: string | null;
  description: string | null;
  activeBatches: number;
  scriptsTotal: number;
  scriptsDelivered: number;
  nextShoot: ISODate | null;
  overdueBatches: number;
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

export interface ReviewQueue {
  batches: { batch: BatchSummary; scripts: Script[] }[];
  revisions: (RevisionRequest & { batchTitle: string; clientName: string; assigneeName: string | null; scriptStatus: ScriptStatus })[];
}

export interface MyWork {
  batches: { batch: BatchSummary; mine: Script[]; myProgress: Progress; briefings: Briefing[]; resources: Resource[] }[];
  revisions: ReviewQueue['revisions'];
  recentDeliveries: (Delivery & { batchTitle: string; clientName: string })[];
}

export interface ReschedulePreview {
  shoot: Shoot;
  newStart: ISODate;
  newEnd: ISODate | null;
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
