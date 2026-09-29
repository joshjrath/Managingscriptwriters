// Loaders that turn rows into the API shapes in shared/types.

import type { Db } from './db';
import type { Activity, Briefing, Delivery, Resource, RevisionRequest, Script, Shoot } from '../shared/types';
import type { ISODate } from '../shared/dates';
import type { ScriptStatus } from '../shared/workflow';

const inList = (ids: number[], params: unknown[]) =>
  ids.map((id) => { params.push(id); return `$${params.length}`; }).join(',');

// ── scripts ──────────────────────────────────────────────────────────────

interface ScriptRow {
  id: number; batch_id: number; number: number; title: string | null; assignee_id: number | null; assignee_name: string | null;
  status: ScriptStatus; doc_url: string | null; timeliner_url: string | null; notes: string | null; version: number;
  submitted_at: string | null; approved_at: string | null; approved_by_name: string | null; delivered_at: string | null;
  delivered_by_name: string | null; delivery_id: number | null; updated_at: string;
}

export async function loadScripts(db: Db, where: { batchId?: number; ids?: number[]; status?: ScriptStatus; assigneeId?: number }): Promise<Script[]> {
  const cond = ['s.removed_at is null'];
  const params: unknown[] = [];
  if (where.batchId) { params.push(where.batchId); cond.push(`s.batch_id = $${params.length}`); }
  if (where.ids) { if (!where.ids.length) return []; cond.push(`s.id in (${inList(where.ids, params)})`); }
  if (where.status) { params.push(where.status); cond.push(`s.status = $${params.length}`); }
  if (where.assigneeId) { params.push(where.assigneeId); cond.push(`s.assignee_id = $${params.length}`); }
  const rows = await db.query<ScriptRow>(
    `select s.id, s.batch_id, s.number, s.title, s.assignee_id, u.name as assignee_name, s.status, s.doc_url, s.timeliner_url,
            s.notes, s.version, s.submitted_at, s.approved_at, ab.name as approved_by_name, s.delivered_at,
            dl.name as delivered_by_name, s.delivery_id, s.updated_at
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
    id: r.id, batchId: r.batch_id, number: r.number, title: r.title, assigneeId: r.assignee_id, assigneeName: r.assignee_name,
    status: r.status, docUrl: r.doc_url, timelinerUrl: r.timeliner_url, notes: r.notes, version: r.version,
    submittedAt: r.submitted_at, approvedAt: r.approved_at, approvedByName: r.approved_by_name,
    deliveredAt: r.delivered_at, deliveredByName: r.delivered_by_name, deliveryId: r.delivery_id,
    openRevision: openBy.get(r.id) ?? null, updatedAt: r.updated_at,
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

interface DeliveryRow { id: number; batch_id: number; confirmed_by: number; confirmed_by_name: string; confirmed_at: string; timeliner_url: string | null; note: string | null }

export async function loadDeliveries(db: Db, where: { batchIds?: number[]; confirmedBy?: number; limit?: number }): Promise<Delivery[]> {
  const cond: string[] = [];
  const params: unknown[] = [];
  if (where.batchIds) { if (!where.batchIds.length) return []; cond.push(`d.batch_id in (${inList(where.batchIds, params)})`); }
  if (where.confirmedBy) { params.push(where.confirmedBy); cond.push(`d.confirmed_by = $${params.length}`); }
  const rows = await db.query<DeliveryRow>(
    `select d.id, d.batch_id, d.confirmed_by, u.name as confirmed_by_name, d.confirmed_at, d.timeliner_url, d.note
       from deliveries d join users u on u.id = d.confirmed_by
       ${cond.length ? 'where ' + cond.join(' and ') : ''}
      order by d.confirmed_at desc ${where.limit ? `limit ${Number(where.limit)}` : ''}`,
    params,
  );
  const ids = rows.map((r) => r.id);
  const numbers = new Map<number, number[]>();
  if (ids.length) {
    const p: unknown[] = [];
    const srows = await db.query<{ delivery_id: number; number: number }>(
      `select delivery_id, number from scripts where removed_at is null and delivery_id in (${inList(ids, p)}) order by number`, p,
    );
    for (const s of srows) numbers.set(s.delivery_id, [...(numbers.get(s.delivery_id) ?? []), s.number]);
  }
  return rows.map((r) => ({
    id: r.id, batchId: r.batch_id, confirmedById: r.confirmed_by, confirmedByName: r.confirmed_by_name,
    confirmedAt: r.confirmed_at, timelinerUrl: r.timeliner_url, note: r.note,
    scriptNumbers: numbers.get(r.id) ?? [], verification: 'writer_confirmed',
  }));
}

// ── resources ────────────────────────────────────────────────────────────

interface ResourceRow {
  id: number; client_id: number; client_name: string; briefing_id: number | null; briefing_title: string | null;
  batch_id: number | null; batch_title: string | null; kind: 'link' | 'file'; category: Resource['category']; title: string;
  url: string | null; file_id: number | null; file_name: string | null; file_size: number | null; notes: string | null;
  created_by: number; created_by_name: string; created_at: string;
}

export async function loadResources(db: Db, where: { clientId?: number; batchId?: number; briefingIds?: number[]; clientOnly?: boolean; q?: string; category?: string; id?: number; includeArchivedClients?: boolean } = {}): Promise<Resource[]> {
  const cond = ['r.removed_at is null'];
  const params: unknown[] = [];
  if (where.id) { params.push(where.id); cond.push(`r.id = $${params.length}`); }
  if (where.clientId) { params.push(where.clientId); cond.push(`r.client_id = $${params.length}`); }
  if (where.batchId) { params.push(where.batchId); cond.push(`r.batch_id = $${params.length}`); }
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
            r.created_by, u.name as created_by_name, r.created_at
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
  location: string | null; notes: string | null; cancelled_at: string | null;
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
    `select sh.id, sh.client_id, c.name as client_name, sh.title, sh.start_date, sh.end_date, sh.location, sh.notes, sh.cancelled_at
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
    location: r.location, notes: r.notes, batchIds: batchIds.get(r.id) ?? [], cancelledAt: r.cancelled_at,
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
