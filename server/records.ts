// Loaders that turn rows into the API shapes in shared/types.

import type { Db } from './db';
import type { Activity, Briefing, Deliverable, Delivery, Resource, RevisionRequest, Script, Shoot } from '../shared/types';
import type { ISODate } from '../shared/dates';
import { compressRanges, documentState, type ScriptStatus } from '../shared/workflow';

const inList = (ids: number[], params: unknown[]) =>
  ids.map((id) => { params.push(id); return `$${params.length}`; }).join(',');

// ── scripts ──────────────────────────────────────────────────────────────

interface ScriptRow {
  id: number; batch_id: number; number: number; assignee_id: number | null; assignee_name: string | null;
  status: ScriptStatus; doc_url: string | null; timeliner_url: string | null; notes: string | null; version: number;
  submitted_at: string | null; approved_at: string | null; approved_by_name: string | null; delivered_at: string | null;
  delivered_by_name: string | null; delivery_id: number | null; assigned_at: string | null; updated_at: string;
}

export async function loadScripts(db: Db, where: { batchId?: number; batchIds?: number[]; ids?: number[]; status?: ScriptStatus; statuses?: ScriptStatus[]; assigneeId?: number }): Promise<Script[]> {
  const cond = ['s.removed_at is null'];
  const params: unknown[] = [];
  if (where.batchId) { params.push(where.batchId); cond.push(`s.batch_id = $${params.length}`); }
  if (where.batchIds) { if (!where.batchIds.length) return []; cond.push(`s.batch_id in (${inList(where.batchIds, params)})`); }
  if (where.statuses) { if (!where.statuses.length) return []; params.push(where.statuses); cond.push(`s.status = any($${params.length}::text[])`); }
  if (where.ids) { if (!where.ids.length) return []; cond.push(`s.id in (${inList(where.ids, params)})`); }
  if (where.status) { params.push(where.status); cond.push(`s.status = $${params.length}`); }
  if (where.assigneeId) { params.push(where.assigneeId); cond.push(`s.assignee_id = $${params.length}`); }
  const rows = await db.query<ScriptRow>(
    `select s.id, s.batch_id, s.number, s.assignee_id, u.name as assignee_name, s.status, s.doc_url, s.timeliner_url,
            s.notes, s.version, s.submitted_at, s.approved_at, ab.name as approved_by_name, s.delivered_at,
            dl.name as delivered_by_name, s.delivery_id, s.assigned_at, s.updated_at
       from scripts s
       left join users u on u.id = s.assignee_id
       left join users ab on ab.id = s.approved_by
       left join users dl on dl.id = s.delivered_by
      where ${cond.join(' and ')}
      order by s.batch_id, s.number`,
    params,
  );
  const open = await loadRevisions(db, { scriptIds: rows.map((r) => r.id), openOnly: true });
  const openBy = new Map(open.map((r) => [r.scriptId, r]));
  return rows.map((r) => ({
    id: r.id, batchId: r.batch_id, number: r.number, assigneeId: r.assignee_id, assigneeName: r.assignee_name,
    status: r.status, docUrl: r.doc_url, timelinerUrl: r.timeliner_url, notes: r.notes, version: r.version,
    submittedAt: r.submitted_at, approvedAt: r.approved_at, approvedByName: r.approved_by_name,
    deliveredAt: r.delivered_at, deliveredByName: r.delivered_by_name, deliveryId: r.delivery_id,
    openRevision: openBy.get(r.id) ?? null, assignedAt: r.assigned_at, updatedAt: r.updated_at,
  }));
}

// ── revision requests ────────────────────────────────────────────────────

interface RevisionRow {
  id: number; script_id: number; script_number: number; batch_id: number; note: string; requested_by_name: string;
  requested_at: string; resolved_at: string | null; resolved_by_name: string | null; resolution: string | null; review_id: number | null;
}

export async function loadRevisions(db: Db, where: { batchId?: number; scriptIds?: number[]; openOnly?: boolean; batchIds?: number[] }): Promise<RevisionRequest[]> {
  const cond: string[] = [];
  const params: unknown[] = [];
  if (where.batchId) { params.push(where.batchId); cond.push(`r.batch_id = $${params.length}`); }
  if (where.scriptIds) { if (!where.scriptIds.length) return []; cond.push(`r.script_id in (${inList(where.scriptIds, params)})`); }
  if (where.batchIds) { if (!where.batchIds.length) return []; cond.push(`r.batch_id in (${inList(where.batchIds, params)})`); }
  if (where.openOnly) cond.push(`r.resolved_at is null`);
  const rows = await db.query<RevisionRow>(
    `select r.id, r.script_id, s.number as script_number, r.batch_id, r.note, rq.name as requested_by_name, r.requested_at,
            r.resolved_at, rs.name as resolved_by_name, r.resolution, r.review_id
       from revision_requests r
       join scripts s on s.id = r.script_id
       join users rq on rq.id = r.requested_by
       left join users rs on rs.id = r.resolved_by
      ${cond.length ? 'where ' + cond.join(' and ') : ''}
      order by r.requested_at desc`,
    params,
  );
  return rows.map((r) => ({
    id: r.id, scriptId: r.script_id, scriptNumber: r.script_number, batchId: r.batch_id, note: r.note,
    requestedByName: r.requested_by_name, requestedAt: r.requested_at, resolvedAt: r.resolved_at,
    resolvedByName: r.resolved_by_name, resolution: r.resolution, reviewId: r.review_id,
  }));
}

// ── deliveries ───────────────────────────────────────────────────────────

interface DeliveryRow { id: number; batch_id: number; confirmed_by: number; confirmed_by_name: string; confirmed_at: string; timeliner_url: string | null; note: string | null; source: string | null }

export async function loadDeliveries(db: Db, where: { batchIds?: number[]; confirmedBy?: number; limit?: number }): Promise<Delivery[]> {
  const cond: string[] = [];
  const params: unknown[] = [];
  if (where.batchIds) { if (!where.batchIds.length) return []; cond.push(`d.batch_id in (${inList(where.batchIds, params)})`); }
  if (where.confirmedBy) { params.push(where.confirmedBy); cond.push(`d.confirmed_by = $${params.length}`); }
  const rows = await db.query<DeliveryRow>(
    `select d.id, d.batch_id, d.confirmed_by, u.name as confirmed_by_name, d.confirmed_at, d.timeliner_url, d.note, d.source
       from deliveries d join users u on u.id = d.confirmed_by
       ${cond.length ? 'where ' + cond.join(' and ') : ''}
      order by d.confirmed_at desc ${where.limit ? `limit ${Number(where.limit)}` : ''}`,
    params,
  );
  const ids = rows.map((r) => r.id);
  const numbers = new Map<number, number[]>();
  const writers = new Map<number, Set<string>>();
  if (ids.length) {
    const p: unknown[] = [];
    const srows = await db.query<{ delivery_id: number; number: number; assignee_id: number | null; assignee_name: string | null }>(
      `select s.delivery_id, s.number, s.assignee_id, u.name as assignee_name from scripts s left join users u on u.id = s.assignee_id
        where s.removed_at is null and s.delivery_id in (${inList(ids, p)}) order by s.number`, p,
    );
    const by = new Map(rows.map((r) => [r.id, r.confirmed_by]));
    for (const s of srows) {
      numbers.set(s.delivery_id, [...(numbers.get(s.delivery_id) ?? []), s.number]);
      if (s.assignee_id != null && s.assignee_id !== by.get(s.delivery_id) && s.assignee_name) writers.set(s.delivery_id, (writers.get(s.delivery_id) ?? new Set()).add(s.assignee_name));
    }
  }
  return rows.map((r) => {
    const forNames = [...(writers.get(r.id) ?? [])].sort();
    return {
      id: r.id, batchId: r.batch_id, confirmedById: r.confirmed_by, confirmedByName: r.confirmed_by_name,
      confirmedAt: r.confirmed_at, timelinerUrl: r.timeliner_url, note: r.note,
      scriptNumbers: numbers.get(r.id) ?? [], verification: r.source === 'timeliner' ? 'timeliner' : 'writer_confirmed', forNames,
    };
  });
}

// ── resources ────────────────────────────────────────────────────────────

interface ResourceRow {
  id: number; client_id: number; client_name: string; briefing_id: number | null; briefing_title: string | null;
  batch_id: number | null; batch_title: string | null; kind: 'link' | 'file'; category: Resource['category']; title: string;
  url: string | null; file_id: number | null; file_name: string | null; file_size: number | null; notes: string | null;
  created_by: number; created_by_name: string; created_at: string; attached: boolean;
}

export async function loadResources(db: Db, where: { clientId?: number; batchId?: number; briefingIds?: number[]; clientOnly?: boolean; q?: string; category?: string; id?: number; includeArchivedClients?: boolean } = {}): Promise<Resource[]> {
  const cond = ['r.removed_at is null'];
  const params: unknown[] = [];
  if (where.id) { params.push(where.id); cond.push(`r.id = $${params.length}`); }
  if (where.clientId) { params.push(where.clientId); cond.push(`r.client_id = $${params.length}`); }
  // a batch's own resources plus the client resources picked for it
  let attached = 'false';
  if (where.batchId) {
    params.push(where.batchId);
    const p = `$${params.length}`;
    attached = `exists (select 1 from batch_resources br where br.batch_id = ${p} and br.resource_id = r.id)`;
    cond.push(`(r.batch_id = ${p} or ${attached})`);
  }
  if (where.briefingIds) { if (!where.briefingIds.length) return []; cond.push(`r.briefing_id in (${inList(where.briefingIds, params)})`); }
  if (where.clientOnly) cond.push(`r.batch_id is null and r.briefing_id is null`);
  if (where.category) { params.push(where.category); cond.push(`r.category = $${params.length}`); }
  if (where.q) {
    params.push(`%${where.q.toLowerCase()}%`);
    const p = `$${params.length}`;
    cond.push(`(lower(r.title) like ${p} or lower(coalesce(r.notes,'')) like ${p} or lower(c.name) like ${p} or lower(coalesce(b.title,'')) like ${p} or lower(coalesce(bf.title,'')) like ${p} or lower(coalesce(f.filename,'')) like ${p})`);
  }
  if (!where.includeArchivedClients && !where.clientId && !where.id) cond.push(`c.status <> 'archived'`);
  const rows = await db.query<ResourceRow>(
    `select r.id, r.client_id, c.name as client_name, r.briefing_id, bf.title as briefing_title, r.batch_id, b.title as batch_title,
            r.kind, r.category, r.title, r.url, r.file_id, f.filename as file_name, f.size as file_size, r.notes,
            r.created_by, u.name as created_by_name, r.created_at, ${attached} as attached
       from resources r
       join clients c on c.id = r.client_id
       join users u on u.id = r.created_by
       left join briefings bf on bf.id = r.briefing_id
       left join batches b on b.id = r.batch_id
       left join files f on f.id = r.file_id
      where ${cond.join(' and ')}
      order by r.created_at desc`,
    params,
  );
  return rows.map((r) => ({
    id: r.id, clientId: r.client_id, clientName: r.client_name, briefingId: r.briefing_id, briefingTitle: r.briefing_title,
    batchId: r.batch_id, batchTitle: r.batch_title, kind: r.kind, category: r.category, title: r.title, url: r.url,
    fileId: r.file_id, fileName: r.file_name, fileSize: r.file_size, notes: r.notes,
    createdById: r.created_by, createdByName: r.created_by_name, createdAt: r.created_at,
    ...(r.attached ? { attached: true } : {}),
  }));
}

// ── briefings ────────────────────────────────────────────────────────────

interface BriefingRow {
  id: number; client_id: number; title: string; call_date: ISODate | null; recording_url: string | null; document_url: string | null;
  summary: string | null; instructions: string | null; created_by_name: string | null; created_at: string;
}

export async function loadBriefings(db: Db, where: { clientId?: number; batchId?: number; ids?: number[] }): Promise<Briefing[]> {
  const cond: string[] = [];
  const params: unknown[] = [];
  if (where.clientId) { params.push(where.clientId); cond.push(`bf.client_id = $${params.length}`); }
  if (where.batchId) { params.push(where.batchId); cond.push(`bf.id in (select briefing_id from batch_briefings where batch_id = $${params.length})`); }
  if (where.ids) { if (!where.ids.length) return []; cond.push(`bf.id in (${inList(where.ids, params)})`); }
  const rows = await db.query<BriefingRow>(
    `select bf.id, bf.client_id, bf.title, bf.call_date, bf.recording_url, bf.document_url, bf.summary, bf.instructions,
            u.name as created_by_name, bf.created_at
       from briefings bf left join users u on u.id = bf.created_by
      ${cond.length ? 'where ' + cond.join(' and ') : ''}
      order by bf.call_date desc nulls last, bf.id desc`,
    params,
  );
  const ids = rows.map((r) => r.id);
  const resources = ids.length ? await loadResources(db, { briefingIds: ids, includeArchivedClients: true }) : [];
  const links = new Map<number, number[]>();
  if (ids.length) {
    const p: unknown[] = [];
    const lrows = await db.query<{ briefing_id: number; batch_id: number }>(
      `select briefing_id, batch_id from batch_briefings where briefing_id in (${inList(ids, p)})`, p,
    );
    for (const l of lrows) links.set(l.briefing_id, [...(links.get(l.briefing_id) ?? []), l.batch_id]);
  }
  return rows.map((r) => ({
    id: r.id, clientId: r.client_id, title: r.title, callDate: r.call_date, recordingUrl: r.recording_url,
    documentUrl: r.document_url, summary: r.summary, instructions: r.instructions,
    resources: resources.filter((x) => x.briefingId === r.id), batchIds: links.get(r.id) ?? [],
    createdByName: r.created_by_name ?? 'Unknown', createdAt: r.created_at,
  }));
}

// ── shoots ───────────────────────────────────────────────────────────────

interface ShootRow {
  id: number; client_id: number; client_name: string; title: string | null; start_date: ISODate; end_date: ISODate | null;
  location: string | null; notes: string | null; cancelled_at: string | null; calendar_uid: string | null;
}

export async function loadShoots(db: Db, where: { clientId?: number; id?: number; from?: ISODate; to?: ISODate; activeClientsOnly?: boolean }): Promise<Shoot[]> {
  const cond: string[] = [];
  const params: unknown[] = [];
  if (where.id) { params.push(where.id); cond.push(`sh.id = $${params.length}`); }
  if (where.clientId) { params.push(where.clientId); cond.push(`sh.client_id = $${params.length}`); }
  if (where.from) { params.push(where.from); cond.push(`coalesce(sh.end_date, sh.start_date) >= $${params.length}`); }
  if (where.to) { params.push(where.to); cond.push(`sh.start_date <= $${params.length}`); }
  if (where.activeClientsOnly) cond.push(`c.status <> 'archived'`);
  const rows = await db.query<ShootRow>(
    `select sh.id, sh.client_id, c.name as client_name, sh.title, sh.start_date, sh.end_date, sh.location, sh.notes, sh.cancelled_at, sh.calendar_uid
       from shoots sh join clients c on c.id = sh.client_id
      ${cond.length ? 'where ' + cond.join(' and ') : ''}
      order by sh.start_date`,
    params,
  );
  const ids = rows.map((r) => r.id);
  const batchIds = new Map<number, number[]>();
  if (ids.length) {
    const p: unknown[] = [];
    const b = await db.query<{ id: number; shoot_id: number }>(
      `select id, shoot_id from batches where archived_at is null and shoot_id in (${inList(ids, p)}) order by id`, p,
    );
    for (const x of b) batchIds.set(x.shoot_id, [...(batchIds.get(x.shoot_id) ?? []), x.id]);
  }
  return rows.map((r) => ({
    id: r.id, clientId: r.client_id, clientName: r.client_name, title: r.title, startDate: r.start_date, endDate: r.end_date,
    location: r.location, notes: r.notes, batchIds: batchIds.get(r.id) ?? [], cancelledAt: r.cancelled_at, calendarUid: r.calendar_uid,
  }));
}

// ── activity ─────────────────────────────────────────────────────────────

interface ActivityRow {
  id: number; actor_name: string | null; action: string; summary: string; detail: Record<string, unknown> | string | null;
  batch_id: number | null; batch_title: string | null; client_id: number | null; created_at: string;
}

export async function loadActivity(db: Db, where: { batchId?: number; clientId?: number; limit?: number }): Promise<Activity[]> {
  const cond: string[] = [];
  const params: unknown[] = [];
  if (where.batchId) { params.push(where.batchId); cond.push(`a.batch_id = $${params.length}`); }
  if (where.clientId) { params.push(where.clientId); cond.push(`a.client_id = $${params.length}`); }
  const rows = await db.query<ActivityRow>(
    `select a.id, u.name as actor_name, a.action, a.summary, a.detail, a.batch_id, b.title as batch_title, a.client_id, a.created_at
       from activity a left join users u on u.id = a.actor_id left join batches b on b.id = a.batch_id
      ${cond.length ? 'where ' + cond.join(' and ') : ''}
      order by a.created_at desc, a.id desc
      limit ${Number(where.limit ?? 100)}`,
    params,
  );
  return rows.map((r) => ({
    id: r.id, actorName: r.actor_name, action: r.action, summary: r.summary,
    detail: typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail,
    batchId: r.batch_id, batchTitle: r.batch_title, clientId: r.client_id, createdAt: r.created_at,
  }));
}

// ── documents sent: the Script bank, and the scripts editors cut from ─────

interface SubRow {
  id: number; previous_id: number | null; version: number; url: string | null; file_id: number | null; file_name: string | null; note: string | null;
  created_at: string; writer_id: number | null; writer_name: string | null;
  batch_id: number; batch_title: string; batch_archived: boolean; client_id: number; client_name: string; shoot_id: number | null; shoot_date: string | null;
}
interface SentScriptRow { submission_id: number; id: number; number: number; status: ScriptStatus; timeliner_url: string | null }
interface EditRow { script_ids: number[]; url: string | null; file_id: number | null; file_name: string | null; note: string | null; reviewer: string; created_at: string }
interface BareRow {
  id: number; number: number; status: ScriptStatus; timeliner_url: string | null; updated_at: string;
  writer_id: number | null; writer_name: string | null;
  batch_id: number; batch_title: string; batch_archived: boolean; client_id: number; client_name: string; shoot_id: number | null; shoot_date: string | null;
}
interface PastRow {
  id: number; title: string; file_id: number | null; file_name: string | null; url: string | null; writer_id: number | null; writer_name: string | null;
  script_count: number | null; written_on: string | null; note: string | null; created_at: string; client_id: number; client_name: string;
}
interface LooseRow {
  id: number; number: number; title: string | null; status: ScriptStatus; doc_url: string; timeliner_url: string | null; updated_at: string;
  writer_id: number | null; writer_name: string | null;
  batch_id: number; batch_title: string; batch_archived: boolean; client_id: number; client_name: string; shoot_id: number | null; shoot_date: string | null;
}

const FINISHED = new Set<ScriptStatus>(['approved', 'delivered']);

/** A version a manager approved scripts with, edited by them: what the editors cut from. */
export type ScriptEdit = Omit<NonNullable<Deliverable['edited']>, 'ranges'>;

/**
 * The manager's edited versions, by script id: the newest approved review with an edited version (a link or a
 * file) that covers that script. Scripts approved with the same review share one object.
 */
export async function loadScriptEdits(db: Db, by: { clientId?: number | null; batchIds?: number[] } = {}): Promise<Map<number, ScriptEdit>> {
  const out = new Map<number, ScriptEdit>();
  if (by.batchIds && !by.batchIds.length) return out;
  const edits = await db.query<EditRow>(
    `select r.script_ids, r.url, r.file_id, f.filename as file_name, r.note, u.name as reviewer, r.created_at
       from reviews r left join files f on f.id = r.file_id join batches b on b.id = r.batch_id join users u on u.id = r.reviewed_by
      where r.action = 'approved' and (r.url is not null or r.file_id is not null)
        and ($1::bigint is null or b.client_id = $1) and ($2::bigint[] is null or r.batch_id = any($2::bigint[]))
      order by r.created_at`, [by.clientId ?? null, by.batchIds ?? null],
  );
  // oldest first, so a later approval of a script replaces an earlier one
  for (const e of edits) {
    const edit: ScriptEdit = { kind: e.file_id ? 'file' : 'link', href: e.file_id ? `/api/files/${e.file_id}` : e.url!, name: e.file_name, at: e.created_at, by: e.reviewer, note: e.note };
    for (const id of (Array.isArray(e.script_ids) ? e.script_ids : [])) out.set(Number(id), edit);
  }
  return out;
}

/**
 * Every document sent (one row each), finished scripts sent without one, scripts tracked by their own link, and
 * past scripts, as the Script bank lists them (filters, search and paging are the caller's). `batchIds` narrows it
 * to those batches' documents, leaving out past scripts, which belong to none.
 */
export async function loadDeliverables(db: Db, by: { clientId?: number | null; writerId?: number | null; batchIds?: number[] } = {}): Promise<Deliverable[]> {
  if (by.batchIds && !by.batchIds.length) return [];
  const subs = await db.query<SubRow>(
    `select s.id, s.previous_id, s.version, s.url, s.file_id, f.filename as file_name, s.note, s.created_at,
            coalesce(s.writer_id, s.submitted_by) as writer_id, w.name as writer_name,
            b.id as batch_id, b.title as batch_title, b.archived_at is not null as batch_archived, c.id as client_id, c.name as client_name,
            b.shoot_id, sh.start_date::text as shoot_date
       from submissions s
       join batches b on b.id = s.batch_id join clients c on c.id = b.client_id
       left join users w on w.id = coalesce(s.writer_id, s.submitted_by)
       left join shoots sh on sh.id = b.shoot_id
       left join files f on f.id = s.file_id
      where ($1::bigint is null or b.client_id = $1) and ($2::bigint[] is null or b.id = any($2::bigint[]))
      order by s.created_at, s.id`, [by.clientId ?? null, by.batchIds ?? null],
  );
  const subIds = subs.map((x) => x.id);
  const scripts = await db.query<SentScriptRow>(
    `select ss.submission_id, sc.id, sc.number, sc.status, sc.timeliner_url
       from submission_scripts ss join scripts sc on sc.id = ss.script_id
      where sc.removed_at is null and ss.submission_id = any($1::bigint[]) order by sc.number`, [subIds],
  );
  // each script belongs under the newest document it was sent in (subs are oldest first)
  const order = new Map(subs.map((x, i) => [x.id, i]));
  const current = new Map<number, SentScriptRow>();
  for (const r of scripts) { const was = current.get(r.id); if (!was || order.get(r.submission_id)! > order.get(was.submission_id)!) current.set(r.id, r); }
  const scriptsBySub = new Map<number, SentScriptRow[]>();
  for (const r of current.values()) { const l = scriptsBySub.get(r.submission_id) ?? []; l.push(r); scriptsBySub.set(r.submission_id, l); }
  for (const l of scriptsBySub.values()) l.sort((a, b) => a.number - b.number);

  // the manager's edited version, for the scripts it was approved with
  const editOfScript = await loadScriptEdits(db, by);
  const editFor = (list: { id: number; number: number; status: ScriptStatus }[]): Deliverable['edited'] => {
    const covered = list.filter((x) => FINISHED.has(x.status) && editOfScript.has(x.id));
    if (!covered.length) return null;
    const e = covered.map((x) => editOfScript.get(x.id)!).sort((a, b) => b.at.localeCompare(a.at))[0];
    return { ...e, ranges: compressRanges(covered.filter((x) => editOfScript.get(x.id) === e).map((x) => x.number)) };
  };

  const out: Deliverable[] = [];
  for (const s of subs) {
    const list = scriptsBySub.get(s.id) ?? [];
    if (!list.length || (by.writerId && s.writer_id !== by.writerId)) continue;
    const mine = list.map((x) => ({ id: x.id, number: x.number, status: x.status }));
    out.push({
      key: `s${s.id}`,
      kind: s.file_id ? 'file' : 'link',
      href: s.file_id ? `/api/files/${s.file_id}` : s.url!,
      name: s.file_name, note: s.note, version: s.version, sentAt: s.created_at,
      writerId: s.writer_id, writerName: s.writer_name,
      batchId: s.batch_id, batchTitle: s.batch_title, batchArchived: s.batch_archived,
      clientId: s.client_id, clientName: s.client_name, shootId: s.shoot_id, shootDate: s.shoot_date,
      scripts: mine,
      ranges: compressRanges(list.map((x) => x.number)),
      state: documentState(list.map((x) => x.status)),
      finished: list.filter((x) => FINISHED.has(x.status)).length,
      edited: editFor(mine),
      timelinerUrl: list.find((x) => x.timeliner_url)?.timeliner_url ?? null,
      past: null,
    });
  }

  // Scripts sent, approved or delivered without any document (marked ready by hand): one row per
  // writer in a batch, so finished work never goes missing from the bank.
  const bare = await db.query<BareRow>(
    `select sc.id, sc.number, sc.status, sc.timeliner_url, sc.updated_at, sc.assignee_id as writer_id, u.name as writer_name,
            b.id as batch_id, b.title as batch_title, b.archived_at is not null as batch_archived, c.id as client_id, c.name as client_name,
            b.shoot_id, sh.start_date::text as shoot_date
       from scripts sc join batches b on b.id = sc.batch_id join clients c on c.id = b.client_id
       left join users u on u.id = sc.assignee_id left join shoots sh on sh.id = b.shoot_id
      where sc.removed_at is null and sc.doc_url is null and sc.status in ('ready_for_review', 'revisions_needed', 'approved', 'delivered')
        and not exists (select 1 from submission_scripts ss where ss.script_id = sc.id)
        and ($1::bigint is null or b.client_id = $1) and ($2::bigint is null or sc.assignee_id = $2)
        and ($3::bigint[] is null or b.id = any($3::bigint[]))
      order by sc.number`, [by.clientId ?? null, by.writerId ?? null, by.batchIds ?? null],
  );
  const bareGroups = new Map<string, BareRow[]>();
  for (const r of bare) { const k = `${r.batch_id}|${r.writer_id ?? 0}`; const l = bareGroups.get(k) ?? []; l.push(r); bareGroups.set(k, l); }
  for (const list of bareGroups.values()) {
    const r = list[0];
    const mine = list.map((x) => ({ id: x.id, number: x.number, status: x.status }));
    out.push({
      key: `n${r.id}`, kind: 'none', href: null, name: null, note: null, version: 1,
      sentAt: list.reduce((m, x) => (x.updated_at > m ? x.updated_at : m), r.updated_at),
      writerId: r.writer_id, writerName: r.writer_name,
      batchId: r.batch_id, batchTitle: r.batch_title, batchArchived: r.batch_archived,
      clientId: r.client_id, clientName: r.client_name, shootId: r.shoot_id, shootDate: r.shoot_date,
      scripts: mine,
      ranges: compressRanges(list.map((x) => x.number)),
      state: documentState(list.map((x) => x.status)),
      finished: list.filter((x) => FINISHED.has(x.status)).length,
      edited: editFor(mine),
      timelinerUrl: list.find((x) => x.timeliner_url)?.timeliner_url ?? null,
      past: null,
    });
  }

  // Scripts tracked with their own document link and never sent through the
  // app: one deliverable per distinct link in a batch.
  const loose = await db.query<LooseRow>(
    `select sc.id, sc.number, sc.status, sc.doc_url, sc.timeliner_url, sc.updated_at, sc.assignee_id as writer_id, u.name as writer_name,
            b.id as batch_id, b.title as batch_title, b.archived_at is not null as batch_archived, c.id as client_id, c.name as client_name,
            b.shoot_id, sh.start_date::text as shoot_date
       from scripts sc join batches b on b.id = sc.batch_id join clients c on c.id = b.client_id
       left join users u on u.id = sc.assignee_id left join shoots sh on sh.id = b.shoot_id
      where sc.removed_at is null and sc.doc_url is not null and not exists (select 1 from submission_scripts ss where ss.script_id = sc.id)
        and ($1::bigint is null or b.client_id = $1) and ($2::bigint is null or sc.assignee_id = $2)
        and ($3::bigint[] is null or b.id = any($3::bigint[]))
      order by sc.number`, [by.clientId ?? null, by.writerId ?? null, by.batchIds ?? null],
  );
  const groups = new Map<string, LooseRow[]>();
  for (const r of loose) { const k = `${r.batch_id}|${r.doc_url}`; const l = groups.get(k) ?? []; l.push(r); groups.set(k, l); }
  for (const list of groups.values()) {
    const r = list[0];
    out.push({
      key: `d${list[0].id}`, kind: 'link', href: r.doc_url, name: null, note: null, version: 1,
      sentAt: list.reduce((m, x) => (x.updated_at > m ? x.updated_at : m), r.updated_at),
      writerId: r.writer_id, writerName: list.every((x) => x.writer_id === r.writer_id) ? r.writer_name : 'Several writers',
      batchId: r.batch_id, batchTitle: r.batch_title, batchArchived: r.batch_archived,
      clientId: r.client_id, clientName: r.client_name, shootId: r.shoot_id, shootDate: r.shoot_date,
      scripts: list.map((x) => ({ id: x.id, number: x.number, status: x.status })),
      ranges: compressRanges(list.map((x) => x.number)),
      state: documentState(list.map((x) => x.status)),
      finished: list.filter((x) => FINISHED.has(x.status)).length,
      edited: editFor(list),
      timelinerUrl: list.find((x) => x.timeliner_url)?.timeliner_url ?? null,
      past: null,
    });
  }

  // Past scripts from before the platform, added straight to the bank (they belong to no batch).
  if (by.batchIds) return out;
  const past = await db.query<PastRow>(
    `select p.id, p.title, p.file_id, f.filename as file_name, p.url, p.writer_id, coalesce(u.name, p.writer_name) as writer_name,
            p.script_count, p.written_on, p.note, p.created_at, c.id as client_id, c.name as client_name
       from past_documents p join clients c on c.id = p.client_id
       left join users u on u.id = p.writer_id left join files f on f.id = p.file_id
      where p.removed_at is null and ($1::bigint is null or p.client_id = $1) and ($2::bigint is null or p.writer_id = $2)`,
    [by.clientId ?? null, by.writerId ?? null],
  );
  for (const r of past) {
    out.push({
      key: `p${r.id}`, kind: r.file_id ? 'file' : 'link', href: r.file_id ? `/api/files/${r.file_id}` : r.url!,
      name: r.file_name, note: r.note, version: 1, sentAt: r.written_on ? `${r.written_on}T12:00:00.000Z` : r.created_at,
      writerId: r.writer_id, writerName: r.writer_name,
      batchId: null, batchTitle: r.title, batchArchived: false,
      clientId: r.client_id, clientName: r.client_name, shootId: null, shootDate: null,
      scripts: [], ranges: '', state: 'delivered', finished: 0, edited: null, timelinerUrl: null,
      past: { id: r.id, scriptCount: r.script_count, writtenOn: r.written_on },
    });
  }
  return out;
}
