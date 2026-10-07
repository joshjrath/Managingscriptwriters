// Shared server plumbing: context, settings, users, activity, notifications,
// and the batch summaries every screen is built from.

import type { Db } from './db';
import { makeClock, type Clock, type DeadlineRules, type ISODate } from '../shared/dates';
import {
  compressRanges, deriveStage, milestone, nextMilestone, summarize,
  type ScriptLite, type ScriptStatus,
} from '../shared/workflow';
import type { WorkspaceTheme } from '../shared/palettes';
import type { BatchSummary, Me, Priority, Settings, UserSummary, WriterShare, DateMode } from '../shared/types';

export interface Ctx {
  db: Db;
  now: () => Date;
  secureCookies: boolean;
  allowSetup: boolean;
  uploadLimitBytes: number;
  /** Why the first manager couldn't be created from the environment, shown on the sign-in page. */
  setupHint?: string;
  /** reads pasted notes into an import plan (Claude); absent when no API key is configured */
  notesReader?: import('./notes-import').NotesReader | null;
  /** reads a synced calendar's iCal link (tests pass a stand-in) */
  fetchCalendar?: (url: string) => Promise<string>;
  /** the real workspace; `db` points at a practice copy for requests made in Recording mode */
  realDb?: Db;
  /** the database this request is using right now (for work that outlives the handler, like streaming a file) */
  dbNow?: () => Db;
  /** what the Control Center shows: the simulated network, the live workspace, or live once the team is placed (default) */
  controlData?: import('./control/routes').ControlData;
}

// ── settings ─────────────────────────────────────────────────────────────

interface SettingsRow {
  org_name: string; timezone: string; cutoff: string; draft_offset_days: number; final_offset_days: number;
  day_mode: 'calendar' | 'business'; working_days: number[] | string; reminder_lead_days: number; plan_reminder_days: number;
  is_demo: boolean; reminders_last_run_at: string | null; theme: WorkspaceTheme | string | null;
}

export async function loadSettings(db: Db): Promise<Settings> {
  const r = await db.one<SettingsRow>(`select * from settings where id = 1`);
  if (!r) throw new Error('settings row missing');
  const wd = typeof r.working_days === 'string' ? JSON.parse(r.working_days) : r.working_days;
  return {
    orgName: r.org_name, timezone: r.timezone, cutoff: r.cutoff,
    draftOffsetDays: r.draft_offset_days, finalOffsetDays: r.final_offset_days,
    dayMode: r.day_mode, workingDays: wd, reminderLeadDays: r.reminder_lead_days, planReminderDays: r.plan_reminder_days ?? 14,
    isDemo: r.is_demo, remindersLastRunAt: r.reminders_last_run_at,
    theme: typeof r.theme === 'string' ? JSON.parse(r.theme) : r.theme ?? null,
  };
}

export const rulesOf = (s: Settings): DeadlineRules => ({
  draftOffsetDays: s.draftOffsetDays, finalOffsetDays: s.finalOffsetDays, dayMode: s.dayMode, workingDays: s.workingDays,
});

export async function clockFor(ctx: Ctx, settings?: Settings): Promise<Clock> {
  const s = settings ?? (await loadSettings(ctx.db));
  return makeClock(s.timezone, s.cutoff, ctx.now());
}

// ── users ────────────────────────────────────────────────────────────────

interface UserRow {
  id: number; name: string; email: string; role: 'owner' | 'manager' | 'writer'; active: boolean; capacity_per_day: number | null;
  removed_at: string | null; temp_password: string | null; city: string | null; country: string | null; timezone: string | null; work_start: number | null; work_end: number | null;
}

export async function loadUsers(db: Db): Promise<UserSummary[]> {
  const rows = await db.query<UserRow>(`select id, name, email, role, active, capacity_per_day, removed_at, temp_password, city, country, timezone, work_start, work_end from users order by active desc, name`);
  // temp passwords are stripped here; only the team endpoint adds them back for owners and managers
  return rows.map((r) => ({
    id: r.id, name: r.name, email: r.email, role: r.role, active: r.active && !r.removed_at, removed: !!r.removed_at, capacityPerDay: r.capacity_per_day, tempPassword: null,
    city: r.city ? `${r.city}${r.country ? `, ${r.country}` : ''}` : null,
    timezone: r.timezone,
    workHours: r.work_start != null && r.work_end != null ? [r.work_start, r.work_end] : null,
  }));
}

export async function managerIds(db: Db): Promise<number[]> {
  return (await db.query<{ id: number }>(`select id from users where role in ('owner', 'manager') and active and removed_at is null`)).map((r) => r.id);
}

// ── activity ─────────────────────────────────────────────────────────────

export async function logActivity(
  db: Db,
  a: { actor: Me | null; action: string; summary: string; entityType: string; entityId?: number | null; batchId?: number | null; clientId?: number | null; detail?: Record<string, unknown> },
): Promise<void> {
  await db.query(
    `insert into activity (client_id, batch_id, entity_type, entity_id, actor_id, action, summary, detail)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [a.clientId ?? null, a.batchId ?? null, a.entityType, a.entityId ?? null, a.actor?.id ?? null, a.action, a.summary, a.detail ? JSON.stringify(a.detail) : null],
  );
}

// ── notifications ────────────────────────────────────────────────────────

export interface NotifyInput {
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
  /** Same key for the same user never creates a second notification. */
  dedupeKey?: string | null;
  /** With a dedupe key: refresh the existing notification instead of skipping it. */
  refresh?: boolean;
}

export async function notify(db: Db, userIds: Iterable<number>, n: NotifyInput, exceptUserId?: number): Promise<number> {
  let created = 0;
  for (const uid of new Set(userIds)) {
    if (uid === exceptUserId) continue;
    if (n.dedupeKey && n.refresh) {
      await db.query(
        `insert into notifications (user_id, type, title, body, link, dedupe_key) values ($1,$2,$3,$4,$5,$6)
         on conflict (user_id, dedupe_key) do update set title = excluded.title, body = excluded.body, link = excluded.link, created_at = now(), read_at = null`,
        [uid, n.type, n.title, n.body ?? null, n.link ?? null, n.dedupeKey],
      );
      created++;
    } else {
      const rows = await db.query(
        `insert into notifications (user_id, type, title, body, link, dedupe_key) values ($1,$2,$3,$4,$5,$6)
         on conflict (user_id, dedupe_key) do nothing returning id`,
        [uid, n.type, n.title, n.body ?? null, n.link ?? null, n.dedupeKey ?? null],
      );
      created += rows.length;
    }
  }
  return created;
}

// ── batch summaries ──────────────────────────────────────────────────────

export interface BatchRow {
  id: number; client_id: number; client_name: string; shoot_id: number | null; shoot_title: string | null;
  shoot_start: ISODate | null; shoot_end: ISODate | null; title: string; brief: string | null; target_count: number;
  priority: Priority; planned_start: ISODate | null; draft_due: ISODate | null; draft_due_mode: DateMode;
  final_due: ISODate | null; final_due_mode: DateMode; needs_date_review: boolean; date_review_note: string | null;
  blocked: boolean; blocker_note: string | null; blocked_at: string | null; blocked_by_name: string | null;
  next_action: string | null; archived_at: string | null; updated_at: string; open_revisions: number;
  brand_voice: string | null; guidance: string | null;
}

export const BATCH_SELECT = `
  select b.id, b.client_id, c.name as client_name, b.shoot_id, s.title as shoot_title, s.start_date as shoot_start,
         s.end_date as shoot_end, b.title, b.brief, b.target_count, b.priority, b.planned_start, b.draft_due,
         b.draft_due_mode, b.final_due, b.final_due_mode, b.needs_date_review, b.date_review_note, b.blocked,
         b.blocker_note, b.blocked_at, bu.name as blocked_by_name, b.next_action, b.archived_at, b.updated_at,
         c.brand_voice, c.guidance,
         (select count(*) from revision_requests r where r.batch_id = b.id and r.resolved_at is null) as open_revisions
    from batches b
    join clients c on c.id = b.client_id
    left join shoots s on s.id = b.shoot_id
    left join users bu on bu.id = b.blocked_by`;

export interface ScriptLiteRow { id: number; batch_id: number; number: number; status: ScriptStatus; assignee_id: number | null; delivered_at: string | null }

export async function loadScriptsFor(db: Db, batchIds: number[]): Promise<Map<number, ScriptLiteRow[]>> {
  const map = new Map<number, ScriptLiteRow[]>();
  if (!batchIds.length) return map;
  const rows = await db.query<ScriptLiteRow>(
    `select id, batch_id, number, status, assignee_id, delivered_at from scripts
      where removed_at is null and batch_id in (${batchIds.map((_, i) => `$${i + 1}`).join(',')})
      order by batch_id, number`,
    batchIds,
  );
  for (const r of rows) {
    const list = map.get(r.batch_id) ?? [];
    list.push(r);
    map.set(r.batch_id, list);
  }
  return map;
}

export const lite = (r: ScriptLiteRow): ScriptLite => ({ id: r.id, number: r.number, status: r.status, assigneeId: r.assignee_id });

/** Writers' "written so far" counters, keyed `${batchId}:${userId}`. */
export type WrittenMap = Map<string, { written: number; at: string; day: string | null; dayStart: number | null }>;

export async function loadWritten(db: Db, batchIds: number[]): Promise<WrittenMap> {
  const map: WrittenMap = new Map();
  if (!batchIds.length) return map;
  const rows = await db.query<{ batch_id: number; user_id: number; written: number; updated_at: string; day: string | null; day_start: number | null }>(
    `select batch_id, user_id, written, updated_at, day::text as day, day_start from writer_progress where batch_id in (${batchIds.map((_, i) => `$${i + 1}`).join(',')})`, batchIds,
  );
  for (const r of rows) map.set(`${r.batch_id}:${r.user_id}`, { written: Number(r.written), at: r.updated_at, day: r.day, dayStart: r.day_start == null ? null : Number(r.day_start) });
  return map;
}

export function buildSummary(row: BatchRow, scriptRows: ScriptLiteRow[], names: Map<number, string>, clock: Clock, written: WrittenMap = new Map()): BatchSummary {
  const scripts = scriptRows.map(lite);
  const progress = summarize(scripts);
  const draft = milestone('draft', row.draft_due, progress, clock);
  const final = milestone('final', row.final_due, progress, clock);

  const groups = new Map<number | null, ScriptLite[]>();
  for (const s of scripts) {
    const list = groups.get(s.assigneeId) ?? [];
    list.push(s);
    groups.set(s.assigneeId, list);
  }
  const writers: WriterShare[] = [...groups.entries()]
    .map(([uid, list]) => {
      const p = summarize(list);
      const rep = uid == null ? undefined : written.get(`${row.id}:${uid}`);
      const writtenNow = Math.min(list.length, Math.max(p.draftReady, rep?.written ?? 0));
      return {
        userId: uid, name: uid == null ? 'Unassigned' : names.get(uid) ?? 'Unknown',
        count: list.length, ranges: compressRanges(list.map((s) => s.number)),
        draftReady: p.draftReady, approved: p.approved, delivered: p.delivered, revisions: p.revisions,
        written: writtenNow, writtenAt: rep?.at ?? null,
        writtenToday: rep && rep.day === clock.today && rep.dayStart != null ? Math.max(0, writtenNow - rep.dayStart) : 0,
        first: Math.min(...list.map((s) => s.number)),
      };
    })
    .sort((a, b) => (a.userId == null ? 1 : b.userId == null ? -1 : a.first - b.first))
    .map(({ first: _first, ...w }) => w);

  return {
    id: row.id, title: row.title, clientId: row.client_id, clientName: row.client_name,
    shootId: row.shoot_id, shootTitle: row.shoot_title, shootStart: row.shoot_start, shootEnd: row.shoot_end,
    targetCount: row.target_count, priority: row.priority, plannedStart: row.planned_start,
    draftDue: row.draft_due, draftDueMode: row.draft_due_mode, finalDue: row.final_due, finalDueMode: row.final_due_mode,
    blocked: row.blocked, blockerNote: row.blocker_note, blockedAt: row.blocked_at, blockedByName: row.blocked_by_name,
    nextAction: row.next_action, needsDateReview: row.needs_date_review, dateReviewNote: row.date_review_note,
    archivedAt: row.archived_at, progress, written: writers.reduce((n, w) => n + w.written, 0), writtenToday: writers.reduce((n, w) => n + w.writtenToday, 0), stage: deriveStage(progress), writers,
    draft, final, next: nextMilestone(draft, final),
    unresolvedRevisions: row.open_revisions, updatedAt: row.updated_at,
  };
}

export interface BatchQuery {
  ids?: number[];
  clientId?: number;
  shootId?: number;
  includeArchived?: boolean;
  onlyArchived?: boolean;
  /** only this person's scripts: progress and deadlines count just their share, and batches without any of theirs are left out */
  assigneeId?: number;
}

export async function loadBatches(ctx: Ctx, q: BatchQuery = {}, clock?: Clock): Promise<{ summaries: BatchSummary[]; rows: BatchRow[]; scripts: Map<number, ScriptLiteRow[]> }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.ids) {
    if (!q.ids.length) return { summaries: [], rows: [], scripts: new Map() };
    where.push(`b.id in (${q.ids.map((id) => { params.push(id); return `$${params.length}`; }).join(',')})`);
  }
  if (q.clientId) { params.push(q.clientId); where.push(`b.client_id = $${params.length}`); }
  if (q.shootId) { params.push(q.shootId); where.push(`b.shoot_id = $${params.length}`); }
  if (q.onlyArchived) where.push(`b.archived_at is not null`);
  else if (!q.includeArchived && !q.ids) where.push(`b.archived_at is null`);
  let rows = await ctx.db.query<BatchRow>(
    `${BATCH_SELECT} ${where.length ? 'where ' + where.join(' and ') : ''} order by b.final_due nulls last, b.id`,
    params,
  );
  let scripts = await loadScriptsFor(ctx.db, rows.map((r) => r.id));
  if (q.assigneeId) {
    const mine = new Map<number, ScriptLiteRow[]>();
    for (const [id, list] of scripts) {
      const own = list.filter((s) => s.assignee_id === q.assigneeId);
      if (own.length) mine.set(id, own);
    }
    scripts = mine;
    rows = rows.filter((r) => mine.has(r.id));
  }
  const users = await loadUsers(ctx.db);
  const names = new Map(users.map((u) => [u.id, u.name]));
  const c = clock ?? (await clockFor(ctx));
  const written = await loadWritten(ctx.db, rows.map((r) => r.id));
  return { rows, scripts, summaries: rows.map((r) => buildSummary(r, scripts.get(r.id) ?? [], names, c, written)) };
}

export async function loadBatch(ctx: Ctx, id: number, clock?: Clock): Promise<BatchSummary | null> {
  const { summaries } = await loadBatches(ctx, { ids: [id] }, clock);
  return summaries[0] ?? null;
}

/** Latest delivery time across a batch's scripts, used to age out old completed work. */
export function lastDeliveredAt(scripts: ScriptLiteRow[]): string | null {
  let max: string | null = null;
  for (const s of scripts) if (s.delivered_at && (!max || s.delivered_at > max)) max = s.delivered_at;
  return max;
}

export async function assigneesOf(db: Db, batchId: number, opts: { undeliveredOnly?: boolean } = {}): Promise<number[]> {
  const rows = await db.query<{ assignee_id: number }>(
    `select distinct assignee_id from scripts where batch_id = $1 and removed_at is null and assignee_id is not null
       ${opts.undeliveredOnly ? `and status <> 'delivered'` : ''}`,
    [batchId],
  );
  return rows.map((r) => r.assignee_id);
}

export async function isAssignedTo(db: Db, batchId: number, userId: number): Promise<boolean> {
  const r = await db.one(`select 1 from scripts where batch_id = $1 and assignee_id = $2 and removed_at is null limit 1`, [batchId, userId]);
  return !!r;
}

export const batchLink = (id: number) => `/batches/${id}`;
