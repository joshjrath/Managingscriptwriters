// Timeliner: when a batch's script document lands in Timeliner, the batch is marked delivered by itself.
// (The editors' videos are read from Timeliner too: see server/editing.ts. This file holds the API client, the
// webhook, and passes task messages on to it.)
//
// Timeliner sends a signed message to POST /hooks/timeliner when a file is uploaded: version.uploaded for a
// file on a task, file.uploaded for a file in a project. Each message is checked against the secret Timeliner
// gave this server when it registered the webhook (Settings → Timeliner, or on start-up) and logged once
// (Timeliner can send the same message twice). Only documents count (PDF, Word, text): the videos editors upload,
// and documents on a video's task, are ignored.
//
// Each shoot has one scripts PDF in Timeliner, and its changes are new versions of the same task. So a PDF is
// linked to its batch once (timeliner_pdfs, by its task, or file:<id> for a file put straight into a project),
// and every later version follows the link, whatever it's called. The first time, the client is the one whose
// PDFs are in that project, else the one the Timeliner brand or project is named after (a batch's old project
// link is only this hint); then the batch is found by the rules in server/matching.ts (placePdf): a date in its
// name, else the shoot waiting for its scripts around when the PDF was made. Each version delivers the batch's
// approved scripts through applyScriptAction, recorded under the uploader when they are on the team (else whoever
// connected Timeliner) and labelled as Timeliner's confirmation; editors with a video from that shoot hear about
// a new version once. An upload that can't be placed for sure waits in Settings → Timeliner, with the batch it
// most likely belongs to, for a manager to pick; picking links it, so its next versions follow.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from './db';
import { batchLink, loadSettings, logActivity, managerIds, notify, type Ctx } from './core';
import { requireManager } from './auth';
import { HttpError, conflict, notFound, parse, zs } from './http';
import { applyScriptAction } from './routes/batches';
import { applyTaskMessage, dropDocumentTask, OWNER_IDS } from './editing';
import { batchDay, clientFit, dayOf, nameKey, PDF_AHEAD, PDF_LATE, PDF_LATE_FALLBACK, placePdf, type PdfBatch } from './matching';
import {
  TIMELINER_KEY_PERMISSIONS, type Me, type TimelinerEvent, type TimelinerOutcome, type TimelinerPdfHow, type TimelinerPdfLink, type TimelinerStatus,
} from '../shared/types';
import { compressRanges, isOnPlate, TIMELINER_STATUS_GROUPS, videoState } from '../shared/workflow';
import { addDays, type ISODate } from '../shared/dates';
import { fmtDate } from '../shared/format';

// the name rules live in server/matching.ts; still reachable from here
export { clientFit, nameWords, pickBatch } from './matching';

/** uploads deliver batches; task messages (and a trashed project, which takes its tasks with it) keep the editors' videos current between reads */
const UPLOAD_EVENTS = ['version.uploaded', 'file.uploaded'];
const VIDEO_EVENTS = ['task.created', 'task.updated', 'task.status_changed', 'task.trashed', 'project.trashed'];
/** Timeliner's step groups past the editor's plate (in review, with the client, approved): the shared rule's, never a list kept here */
const OFF_PLATE_GROUPS: string[] = TIMELINER_STATUS_GROUPS.filter((g) => !isOnPlate(videoState(g)));
/** the messages this server subscribes to */
export const TIMELINER_EVENTS = [...UPLOAD_EVENTS, ...VIDEO_EVENTS];
export const HOOK_PATH = '/hooks/timeliner';

// ── Timeliner's API ──────────────────────────────────────────────────────

/** A task as Timeliner sends it: one video (or document) to make. Only the fields this server reads. */
export interface TimelinerTask {
  id: string;
  /** the human handle (TL-1042), when the workspace uses them */
  taskId?: string | null;
  title: string;
  statusGroup: string;
  /** active, archived or trashed */
  status?: string | null;
  /** media or doc */
  type?: string | null;
  projectId?: string | null;
  brandId?: string | null;
  subFolderId?: string | null;
  assigneeIds?: string[];
  internalDeadline?: string | null;
  externalDeadline?: string | null;
  internalRevisions?: number;
  clientRevisions?: number;
  createdAt?: string | null;
  updatedAt?: string | null;
  approvedAt?: string | null;
  /** regular, parent or variant (a version of another task, `parentTaskId`) */
  kind?: string | null;
  parentTaskId?: string | null;
  /** the task's current file; `downloadUrl` is a presigned link that expires (never stored or sent on) */
  media?: TimelinerMedia | null;
}

/** A task's current file, as Timeliner sends it. */
export interface TimelinerMedia {
  fileId: string;
  name: string;
  mimeType: string;
  downloadUrl: string | null;
  expiresAt: string | null;
  purgedAt: string | null;
}

/** One page of a list, newest first; `nextBefore` is the cursor for the next (null at the end). */
export interface TimelinerPage<T> { data: T[]; nextBefore: string | null }

/**
 * Someone with access to a brand (a client in Timeliner), as GET /brands/{id}/members sends it: their brand-level
 * `role`, whether the access is `automatic` (a workspace admin's, on every brand: not an assignment), and the
 * member (the same shape as GET /members). Read leniently in server/editing.ts: any field may be odd.
 */
export interface TimelinerBrandMember {
  brandId?: string;
  role?: string | null;
  automatic?: boolean;
  member?: { id: string; email?: string | null; firstName?: string | null; lastName?: string | null; role?: string | null; deactivated?: boolean } | null;
}

/** The parts of Timeliner's REST API this server uses (tests pass a stand-in). */
export interface TimelinerApi {
  /** a project with its sub-folders (the level between a project and its tasks), and when each was made */
  project(id: string): Promise<{ id: string; name: string; nodeId?: string | null; createdAt?: string | null; subFolders?: { id: string; name: string; createdAt?: string | null }[] } | null>;
  brand(id: string): Promise<{ id: string; name: string } | null>;
  task(id: string): Promise<TimelinerTask | null>;
  /** 100 tasks per page, newest first */
  tasks(before: string | null): Promise<TimelinerPage<TimelinerTask>>;
  /** brands and clients, 100 per page */
  brands(before: string | null): Promise<TimelinerPage<{ id: string; name: string }>>;
  /** the team, including people who have left (tasks can still name them) */
  members(): Promise<{ id: string; email: string; firstName: string | null; lastName: string | null; role?: string | null; deactivated?: boolean }[]>;
  /**
   * who is on a brand (its active team members; a client's editors are assigned here rather than on each video).
   * null when Timeliner has no such brand
   */
  brandMembers(brandId: string): Promise<TimelinerBrandMember[] | null>;
  /** a task's latest step move: its exact step name, when, and who moved it (null when it never moved) */
  lastMove(taskId: string): Promise<{ at: string; to: string | null; byId: string | null } | null>;
  webhooks(): Promise<{ id: string; url: string; events: string[]; active: boolean }[]>;
  createWebhook(url: string, events: string[]): Promise<{ id: string; secret: string }>;
  updateWebhook(id: string, patch: { events?: string[]; active?: boolean }): Promise<void>;
  rotateSecret(id: string): Promise<{ secret: string }>;
  testWebhook(id: string): Promise<{ ok: boolean; statusCode: number | null; error: string | null }>;
}

export class TimelinerError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Timeliner's own words for an error: `error` as a string (its documented shape), or a message inside it, or beside it. */
function errorWords(body: Record<string, unknown>): string | null {
  const e = body.error;
  const v = typeof e === 'string' ? e
    : e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string' ? (e as { message: string }).message
    : typeof body.message === 'string' ? body.message : null;
  const t = v?.replace(/\s+/g, ' ').trim().slice(0, 300);
  return t || null;
}

/** What Timeliner's error means for the person reading Settings (and the Editors tab's banner): what it answered, exactly. */
function explain(status: number, body: Record<string, unknown>): string {
  if (status === 401) return 'Timeliner didn’t accept the API key. Check TIMELINER_API_KEY on the server (Timeliner → Settings → Developers).';
  if (status === 403 && body.code === 'insufficient_scope') return `The Timeliner key isn’t allowed to ${String(body.requiredScope ?? 'do this').replace(':', ' ')}. In Timeliner → Settings → Developers, make a key with ${TIMELINER_KEY_PERMISSIONS}, put it in TIMELINER_API_KEY, and connect again.`;
  if (status === 429) return 'Timeliner is limiting how often this key can call it. Try again in a minute.';
  const words = errorWords(body);
  return `Timeliner answered ${status}${words ? `: ${words.replace(/[.!]$/, '')}` : ''}.`;
}

/** Timeliner's REST API at `base` (https://timeliner.io), called with a workspace key (tlsk_…). */
export function timelinerClient(key: string, base: string, fetchImpl: typeof fetch = fetch): TimelinerApi {
  const call = async <T>(method: string, path: string, body?: unknown, retried = false): Promise<T | null> => {
    let res: Response;
    try {
      res = await fetchImpl(`${base}/api/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${key}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new TimelinerError('Couldn’t reach Timeliner. Try again in a minute.', 0);
    }
    // over the key's per-minute limit: wait as long as Timeliner asks, when that's short, and try once more
    const wait = Number(res.headers.get('retry-after') ?? NaN);
    if (res.status === 429 && !retried && Number.isFinite(wait) && wait >= 0 && wait <= 10) {
      await new Promise((r) => setTimeout(r, wait * 1000));
      return call<T>(method, path, body, true);
    }
    if (res.status === 404 && method === 'GET') return null;
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try { json = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { /* not JSON: explained by status */ }
    if (!res.ok) throw new TimelinerError(explain(res.status, json), res.status);
    return json as T;
  };
  // an answer that isn't a list is never taken for an empty one: a read would then remove every video it had
  const notAList = (path: string) => new TimelinerError(`Timeliner’s answer for ${path} wasn’t a list, so the last copy is kept.`, 200);
  const page = async <T>(path: string, before: string | null): Promise<TimelinerPage<T>> => {
    const r = await call<Partial<TimelinerPage<T>>>('GET', `${path}?limit=100${before ? `&before=${encodeURIComponent(before)}` : ''}`);
    if (!Array.isArray(r?.data)) throw notAList(path);
    return { data: r.data, nextBefore: typeof r.nextBefore === 'string' && r.nextBefore ? r.nextBefore : null };
  };
  type Move = { createdAt?: unknown; movedTo?: unknown; actor?: { id?: unknown } | null };
  return {
    project: (id) => call('GET', `/projects/${encodeURIComponent(id)}`),
    brand: (id) => call('GET', `/brands/${encodeURIComponent(id)}`),
    task: (id) => call('GET', `/tasks/${encodeURIComponent(id)}`),
    tasks: (before) => page('/tasks', before),
    brands: (before) => page('/brands', before),
    members: async () => {
      const r = await call<{ data?: unknown }>('GET', '/members?includeDeactivated=true');
      if (!Array.isArray(r?.data)) throw notAList('/members');
      return r.data as Awaited<ReturnType<TimelinerApi['members']>>;
    },
    brandMembers: async (id) => {
      const path = `/brands/${encodeURIComponent(id)}/members`;
      const r = await call<{ data?: unknown }>('GET', path);
      if (r === null) return null;
      if (!Array.isArray(r?.data)) throw notAList(path);
      return r.data as TimelinerBrandMember[];
    },
    lastMove: async (id) => {
      const r = await call<{ data?: unknown }>('GET', `/tasks/${encodeURIComponent(id)}/activity?action=moved&limit=1`);
      const last = (Array.isArray(r?.data) ? r.data[r.data.length - 1] : undefined) as Move | null | undefined;
      const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
      const at = str(last?.createdAt);
      return at ? { at, to: str(last?.movedTo), byId: str(last?.actor?.id) } : null;
    },
    webhooks: async () => (await call<{ data: Awaited<ReturnType<TimelinerApi['webhooks']>> }>('GET', '/webhooks'))?.data ?? [],
    createWebhook: async (url, events) => (await call<{ id: string; secret: string }>('POST', '/webhooks', { url, events }))!,
    updateWebhook: async (id, patch) => { await call('PATCH', `/webhooks/${encodeURIComponent(id)}`, patch); },
    rotateSecret: async (id) => (await call<{ secret: string }>('POST', `/webhooks/${encodeURIComponent(id)}/rotate-secret`, {}))!,
    testWebhook: async (id) => (await call<{ ok: boolean; statusCode: number | null; error: string | null }>('POST', `/webhooks/${encodeURIComponent(id)}/test`, {}))!,
  };
}

// ── checking a message is Timeliner's ────────────────────────────────────

/**
 * Timeliner signs each message: `X-Timeliner-Signature: t=<unix seconds>,v1=<hex>`, the hex being
 * HMAC-SHA256(secret, "<t>.<raw body>"). A message older (or newer) than five minutes is refused, so a
 * copied one can't be replayed later.
 */
export function verifySignature(secret: string, header: string | undefined, raw: string, nowSeconds: number): boolean {
  if (!header) return false;
  let t: string | undefined;
  const sigs: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1' && /^[0-9a-f]{64}$/i.test(v)) sigs.push(v.toLowerCase());
  }
  if (!t || !/^\d{1,12}$/.test(t) || !sigs.length) return false;
  if (Math.abs(nowSeconds - Number(t)) > 300) return false;
  const want = Buffer.from(createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex'), 'hex');
  return sigs.some((s) => timingSafeEqual(want, Buffer.from(s, 'hex')));
}

// ── what counts, and where it goes ───────────────────────────────────────

const DOC_EXT = /\.(pdf|docx?|odt|rtf|txt|pages|md)$/i;
const DOC_MIME = /^(application\/(pdf|msword|rtf|vnd\.openxmlformats-officedocument\.wordprocessingml\.document|vnd\.oasis\.opendocument\.text|vnd\.google-apps\.document)|text\/)/i;
/** A script document (PDF, Word, text), not the video or image an editor uploads. */
export const isScriptDocument = (fileName: string, mimeType: string | null) => DOC_EXT.test(fileName) || (!!mimeType && DOC_MIME.test(mimeType));

// ── handling a message ───────────────────────────────────────────────────

export interface UploadMessage {
  id: string;
  type: string;
  test: boolean;
  projectId: string | null;
  taskId: string | null;
  brandId: string | null;
  fileName: string | null;
  mimeType: string | null;
  uploadedBy: string | null;
  taskTitle: string | null;
  /** the file's id: a version's, or a file put straight into a project */
  fileId: string | null;
  /** the task's version number (1, 2, 3…) */
  versionNumber: number | null;
  uploadedAt: string | null;
  /** the project's file folder a file was put in */
  folderId: string | null;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : null);
const envelopeSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.string().min(1).max(80),
  test: z.boolean().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
});
export function readMessage(raw: unknown): UploadMessage {
  const e = envelopeSchema.parse(raw);
  const d = e.data;
  return {
    id: e.id, type: e.type, test: e.test === true,
    projectId: str(d.projectId), taskId: str(d.taskId), brandId: str(d.brandId),
    fileName: str(d.fileName), mimeType: str(d.mimeType), uploadedBy: str(d.uploadedBy), taskTitle: str(d.taskTitle),
    fileId: str(d.fileId), folderId: str(d.folderId),
    versionNumber: typeof d.versionNumber === 'number' && Number.isInteger(d.versionNumber) && d.versionNumber > 0 && d.versionNumber < 100_000 ? d.versionNumber : null,
    uploadedAt: typeof d.uploadedAt === 'string' && !Number.isNaN(Date.parse(d.uploadedAt)) ? new Date(d.uploadedAt).toISOString() : null,
  };
}

interface UserRow { id: number; name: string; email: string; role: Me['role']; capacity_per_day: number | null }
const asMe = (u: UserRow): Me => ({ id: u.id, name: u.name, email: u.email, role: u.role, capacityPerDay: u.capacity_per_day });

/** Whom a Timeliner delivery is recorded under: the uploader when they're on the team, else whoever connected Timeliner, else an Admin. */
async function actorFor(db: Db, uploaderEmail: string | null): Promise<Me | null> {
  const cols = `id, name, email, role, capacity_per_day`;
  const live = `active and removed_at is null and role <> 'editor'`;
  if (uploaderEmail) {
    const u = await db.one<UserRow>(`select ${cols} from users where lower(email) = lower($1) and ${live}`, [uploaderEmail]);
    if (u) return asMe(u);
  }
  const u = await db.one<UserRow>(
    `select ${cols} from users where ${live} and (id = (select timeliner_connected_by from settings where id = 1) or role = 'owner')
      order by (id = (select timeliner_connected_by from settings where id = 1)) desc, id limit 1`,
  );
  return u ? asMe(u) : null;
}

/**
 * The batches Settings → Timeliner's Pick batch offers: those with approved scripts not delivered yet, any batch an
 * upload suggests, and every batch still without a scripts PDF whose shoot is around when the uploads listed came
 * in (`from`–`to`), or that has no date, even with nothing approved yet (picking links the PDF all the same).
 */
async function pickableBatches(db: Db, also: number[], around: { from: ISODate; to: ISODate } | null): Promise<TimelinerStatus['openBatches']> {
  const rows = await db.query<{ id: number; title: string; client_name: string; approved: number }>(
    `select b.id, b.title, c.name as client_name,
            (select count(*)::int from scripts s where s.batch_id = b.id and s.removed_at is null and s.status = 'approved') as approved
       from batches b join clients c on c.id = b.client_id left join shoots sh on sh.id = b.shoot_id
      where b.archived_at is null
        and (exists (select 1 from scripts s where s.batch_id = b.id and s.removed_at is null and s.status = 'approved') or b.id = any($1::bigint[])
             or ($2::date is not null
                 and not exists (select 1 from timeliner_pdfs p where p.batch_id = b.id and p.gone_at is null)
                 and exists (select 1 from scripts s where s.batch_id = b.id and s.removed_at is null and s.status <> 'delivered')
                 and coalesce(case when sh.cancelled_at is null then sh.start_date end, b.final_due, b.draft_due, $2::date) between $2::date and $3::date))
      order by c.name, coalesce(case when sh.cancelled_at is null then sh.start_date end, b.final_due, b.draft_due) nulls last, b.id`,
    [also, around?.from ?? null, around?.to ?? null],
  );
  return rows.map((b) => ({ id: Number(b.id), title: b.title, clientName: b.client_name, approved: b.approved }));
}

/** The client a scripts PDF is for (P2): the one whose PDFs (or a batch's old project link) are in this project, else the one Timeliner's brand or project is named after. */
async function pdfClient(db: Db, projectId: string | null, names: { brand: string | null; project: string | null }, where: string | null): Promise<{ id: number; why: null } | { id: null; why: string }> {
  if (projectId) {
    const here = await db.query<{ client_id: number }>(
      `select distinct b.client_id from timeliner_pdfs p join batches b on b.id = p.batch_id where p.project_id = $1 and p.gone_at is null
       union select client_id from batches where timeliner_project_id = $1`, [projectId],
    );
    if (here.length === 1) return { id: Number(here[0].client_id), why: null };
  }
  const clients = await db.query<{ id: number; name: string }>(`select id, name from clients where archived_at is null and status <> 'prospect'`);
  const fits = clients.map((c) => ({ c, fit: Math.max(names.brand ? clientFit(c.name, names.brand) : 0, names.project ? clientFit(c.name, names.project) : 0) }))
    .filter((x) => x.fit > 0).sort((a, b) => b.fit - a.fit);
  if (!fits.length) return { id: null, why: `No client is named like ${where ? `“${where}”` : 'this Timeliner project'}.` };
  if (fits.length > 1 && fits[0].fit === fits[1].fit) return { id: null, why: `More than one client fits: ${fits.filter((x) => x.fit === fits[0].fit).map((x) => x.c.name).join(', ')}.` };
  return { id: Number(fits[0].c.id), why: null };
}

/** A client's batches as a scripts PDF's match sees them. */
async function pdfBatches(db: Db, clientId: number, tz: string): Promise<PdfBatch[]> {
  const rows = await db.query<{
    id: number; title: string; client_name: string; shoot_start: string | null; shoot_end: string | null; final_due: string | null; draft_due: string | null;
    archived: boolean; finished: number; waiting: number; total: number; delivered: number; last_delivered: string | null; from_timeliner: boolean | null;
  }>(
    `select b.id, b.title, c.name as client_name,
            case when sh.cancelled_at is null then sh.start_date::text end as shoot_start,
            case when sh.cancelled_at is null then sh.end_date::text end as shoot_end,
            b.final_due::text as final_due, b.draft_due::text as draft_due, b.archived_at is not null as archived,
            count(s.id) filter (where s.status in ('approved', 'delivered'))::int as finished,
            count(s.id) filter (where s.status = 'approved')::int as waiting,
            count(s.id)::int as total,
            count(s.id) filter (where s.status = 'delivered')::int as delivered,
            max(s.delivered_at) as last_delivered,
            bool_or(s.status = 'delivered' and d.source = 'timeliner') as from_timeliner
       from batches b join clients c on c.id = b.client_id left join shoots sh on sh.id = b.shoot_id
       left join scripts s on s.batch_id = b.id and s.removed_at is null
       left join deliveries d on d.id = s.delivery_id
      where b.client_id = $1
      group by b.id, c.name, sh.cancelled_at, sh.start_date, sh.end_date
      order by b.id`, [clientId],
  );
  const pdfs = rows.length ? await db.query<{ batch_id: number; file_name: string | null; name_key: string | null }>(
    `select batch_id, file_name, name_key from timeliner_pdfs where gone_at is null and batch_id = any($1::bigint[]) order by latest_at desc`, [rows.map((r) => r.id)],
  ) : [];
  return rows.map((r) => ({
    id: Number(r.id), title: r.title, clientName: r.client_name,
    shootStart: r.shoot_start, shootEnd: r.shoot_end, finalDue: r.final_due, draftDue: r.draft_due, archived: r.archived,
    finished: r.finished, waiting: r.waiting, allDelivered: r.total > 0 && r.delivered === r.total, fromTimeliner: !!r.from_timeliner,
    lastDelivered: r.last_delivered ? dayOf(r.last_delivered, tz) : null,
    pdfs: pdfs.filter((p) => Number(p.batch_id) === Number(r.id)).map((p) => ({ fileName: p.file_name, nameKey: p.name_key })),
  }));
}

/** `video`: a task message, applied to the editors' copy of the videos (logged as ignored: it isn't an upload) */
type Handled = { outcome: TimelinerOutcome | 'duplicate' | 'video'; batchId?: number };
interface SettleExtra {
  place?: string | null; uploader?: string | null; batchId?: number | null; deliveryId?: number | null; detail?: string | null;
  versionNumber?: number | null; suggestedBatchId?: number | null;
}
/** Records what became of a message (its row was claimed when it arrived). */
type Settle = (t: Db, outcome: TimelinerOutcome, extra?: SettleExtra) => Promise<void>;

const settleRow = (id: string): Settle => async (t, outcome, extra = {}) => {
  await t.query(
    `update timeliner_events set outcome = $2, place = coalesce($3, place), uploader = coalesce($4, uploader), batch_id = $5, delivery_id = $6, detail = $7,
            version_number = coalesce($8, version_number), suggested_batch_id = $9 where id = $1`,
    [id, outcome, extra.place ?? null, extra.uploader ?? null, extra.batchId ?? null, extra.deliveryId ?? null, extra.detail ?? null, extra.versionNumber ?? null, extra.suggestedBatchId ?? null],
  );
};

/** Places one message from Timeliner and, when it's a batch's script document, delivers that batch. */
export async function handleTimelinerMessage(ctx: Ctx, api: TimelinerApi | null, m: UploadMessage): Promise<Handled> {
  const { db } = ctx;
  // claim the message first: Timeliner may send it twice, and only one copy is acted on
  const claimed = await db.one<{ id: string }>(
    `insert into timeliner_events (id, type, project_id, task_id, brand_id, file_name, outcome, file_id, version_number, uploaded_at)
     values ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9)
     on conflict (id) do nothing returning id`,
    [m.id, m.type, m.projectId, m.taskId, m.brandId, m.fileName, m.fileId, m.versionNumber, m.uploadedAt],
  );
  if (!claimed) return { outcome: 'duplicate' };
  try {
    return await place(ctx, api, m, settleRow(m.id));
  } catch (err) {
    // let Timeliner's retry try again
    await db.query(`delete from timeliner_events where id = $1 and outcome = 'pending'`, [m.id]);
    throw err;
  }
}

/** What's known about a scripts PDF as it arrives, for its link. */
interface PdfInfo {
  /** the task's id, or file:<id>; null for an old upload whose file wasn't recorded (it's delivered without a link) */
  key: string | null;
  kind: 'task' | 'file';
  projectId: string | null;
  subFolderId: string | null;
  title: string | null;
  fileId: string | null;
  fileName: string | null;
  /** the version number Timeliner gave it; a file put straight into a project counts up by itself */
  version: number | null;
  /** when the PDF was made (its task's creation), else when it was uploaded */
  madeAt: string;
  uploadedAt: string;
  /** its task's step group */
  step: string | null;
}

const isoOf = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const strOf = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : null);

async function place(ctx: Ctx, api: TimelinerApi | null, m: UploadMessage, settle: Settle): Promise<Handled> {
  const { db } = ctx;
  if (m.test) {
    await settle(db, 'test');
    await db.query(`update settings set timeliner_test_at = $1 where id = 1`, [ctx.now().toISOString()]);
    return { outcome: 'test' };
  }
  if (VIDEO_EVENTS.includes(m.type)) {
    // a video was added, changed step, was reassigned or trashed: the Editors tab's copy follows straight away
    // (answered even when Timeliner won't give the video back: see applyTaskMessage)
    const detail = await applyTaskMessage(ctx, api, m);
    await settle(db, 'ignored', { detail });
    return { outcome: 'video' };
  }
  if (!UPLOAD_EVENTS.includes(m.type) || !m.fileName || !isScriptDocument(m.fileName, m.mimeType)) {
    await settle(db, 'ignored', { detail: m.fileName ? 'Not a document' : `A ${m.type} message` });
    return { outcome: 'ignored' };
  }
  const isFile = m.type === 'file.uploaded';
  // the names it arrived under, and when its task was made (best effort: a lookup that fails just matches less)
  const look = async <T>(f: (a: TimelinerApi) => Promise<T>) => { try { return api ? await f(api) : null; } catch { return null; } };
  const task = !isFile && m.taskId ? await look((a) => a.task(m.taskId!)) : null;

  // a document on one of the editors' videos (notes, a shot list): not a shoot's scripts. A task counts as a
  // video's when it held a video file (as last read), or holds one now; a task read while it had no file yet (a
  // scripts PDF task made empty, then given its PDF) is a scripts PDF, and leaves the editors' videos
  if (!isFile && m.taskId) {
    const copy = await db.one<{ has_video: boolean | null }>(`select has_video from timeliner_tasks where id = $1`, [m.taskId]);
    const media = task?.media;
    const holdsVideo = !!media && typeof media.name === 'string' && !isScriptDocument(media.name, typeof media.mimeType === 'string' ? media.mimeType : null);
    // read before this was known (null): a document as the task's first version can't be on a video's task
    if (holdsVideo || copy?.has_video === true || (copy && copy.has_video == null && m.versionNumber !== 1)) {
      await settle(db, 'ignored', { detail: 'A document on a video’s task, not a scripts PDF' });
      return { outcome: 'ignored' };
    }
    if (copy) await dropDocumentTask(ctx, m.taskId);
  }
  const project = m.projectId ? await look((a) => a.project(m.projectId!)) : null;
  const brand = m.brandId ? await look((a) => a.brand(m.brandId!)) : null;
  const members = m.uploadedBy ? (await look((a) => a.members())) ?? [] : [];
  // read as leniently as the Editors tab reads them: an odd member is passed over
  const found = members.find((x) => !!x && typeof x === 'object' && x.id === m.uploadedBy);
  const member = found ? { email: typeof found.email === 'string' ? found.email : null, names: [found.firstName, found.lastName].filter((x) => typeof x === 'string' && x.trim()) } : null;
  const uploader = member ? member.names.join(' ') || member.email : null;
  const subFolderId = strOf(task?.subFolderId);
  const subName = subFolderId
    ? (project?.subFolders?.find((f) => f?.id === subFolderId)?.name ?? (await db.one<{ name: string }>(`select name from timeliner_names where id = $1`, [subFolderId]))?.name ?? null)
    : null;
  const where = [brand?.name, project?.name, subName, m.taskTitle].filter(Boolean).join(' › ') || null;
  const tz = (await loadSettings(db)).timezone;
  const now = ctx.now().toISOString();
  const info: PdfInfo = {
    key: isFile ? (m.fileId ? `file:${m.fileId}` : null) : m.taskId,
    kind: isFile ? 'file' : 'task',
    projectId: m.projectId, subFolderId, title: strOf(task?.title) ?? m.taskTitle, fileId: m.fileId, fileName: m.fileName, version: m.versionNumber,
    madeAt: isoOf(task?.createdAt) ?? m.uploadedAt ?? now, uploadedAt: m.uploadedAt ?? now, step: strOf(task?.statusGroup),
  };
  const base = { place: where, uploader, uploaderEmail: member?.email ?? null, settle };

  // P1 · a scripts PDF already linked: a new version of it, whatever it's called and whenever it arrives. A file
  // put straight into the project is the same document when it has the same name as one linked there, while that
  // one's shoot isn't past (a team that names every shoot's file alike gets the next shoot's matched afresh)
  const nk = nameKey(m.fileName);
  let link = info.key ? await db.one<{ key: string; batch_id: number }>(`select key, batch_id from timeliner_pdfs where key = $1`, [info.key]) : undefined;
  if (!link && isFile && m.projectId && nk) {
    const same = await db.one<{ key: string; batch_id: number; shoot_start: string | null; final_due: string | null; draft_due: string | null }>(
      `select p.key, p.batch_id, case when sh.cancelled_at is null then sh.start_date::text end as shoot_start, b.final_due::text as final_due, b.draft_due::text as draft_due
         from timeliner_pdfs p join batches b on b.id = p.batch_id left join shoots sh on sh.id = b.shoot_id
        where p.kind = 'file' and p.project_id = $1 and p.name_key = $2 order by p.latest_at desc limit 1`, [m.projectId, nk],
    );
    const d = same ? batchDay({ shootStart: same.shoot_start, finalDue: same.final_due, draftDue: same.draft_due }) : null;
    if (same && (!d || d >= addDays(dayOf(info.uploadedAt, tz), -PDF_LATE))) link = same;
  }
  if (link) return deliverFromTimeliner(ctx, Number(link.batch_id), { ...info, key: link.key }, { ...base, how: null });

  const unmatched = async (why: string, suggested: number | null): Promise<Handled> => {
    await settle(db, 'unmatched', { place: where, uploader, detail: why, suggestedBatchId: suggested, versionNumber: info.version });
    await notify(db, await managerIds(db), {
      type: 'delivery', title: 'Timeliner upload needs a batch',
      body: `“${m.fileName}” arrived in Timeliner${where ? ` (${where})` : ''}, but it isn’t clear which batch it’s for. ${why} Pick the batch in Settings → Timeliner and it’s delivered.`,
      link: '/settings#timeliner',
    });
    return { outcome: 'unmatched' };
  };
  if (!info.key) return unmatched('Timeliner didn’t say which task or file it was.', null);

  // P2 · the client, then P3–P8 · the batch (server/matching.ts)
  const client = await pdfClient(db, m.projectId, { brand: brand?.name ?? null, project: project?.name ?? null }, where);
  if (client.id == null) return unmatched(client.why, null);
  const r = placePdf({
    u: dayOf(info.madeAt, tz), nameKey: nk, batches: await pdfBatches(db, client.id, tz),
    text: [m.taskTitle, info.title, m.fileName, subName, project?.name].filter(Boolean).join(' '),
  });
  // a file put straight into a project is taken for a scripts PDF only when it says so, or names a batch
  if (isFile && !/script/i.test(m.fileName) && !(r.batchId != null && r.how === 'name')) return unmatched('A file in the project, not a scripts PDF?', null);
  if (r.batchId == null) return unmatched(r.why, r.suggested);
  return deliverFromTimeliner(ctx, r.batchId, info, { ...base, how: r.how, why: r.why, runnerUp: r.runnerUp });
}

/**
 * Links a scripts PDF to its batch (or follows its link), records its version, and delivers the batch's approved
 * scripts as Timeliner's confirmation; then settles the message. `how` null: the PDF is already linked (a new
 * version). A manager's pick (`manager`) is settled like a first link.
 */
async function deliverFromTimeliner(
  ctx: Ctx, batchId: number, info: PdfInfo,
  o: {
    place: string | null; uploader: string | null; uploaderEmail: string | null; actor?: Me; settle: Settle;
    how: TimelinerPdfHow | null; why?: string; runnerUp?: PdfBatch | null;
  },
): Promise<Handled> {
  // a manager's pick: settled like a first link (no notice for the managers), whatever the PDF's link was
  const picked = !!o.actor;
  return ctx.db.tx(async (t) => {
    let known = o.how == null;
    let target = batchId;
    let before = 0;
    let version = info.version ?? 1;
    /** this upload is the PDF's newest version (an older one can arrive late) */
    let newest = true;
    if (info.key) {
      // the PDF's link first: two messages about the same new PDF take turns here, and the second follows the first
      if (!known) {
        const linked = await t.one(
          `insert into timeliner_pdfs (key, kind, batch_id, project_id, sub_folder_id, title, file_id, file_name, name_key, version, first_at, latest_at, step, how, linked_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) on conflict (key) do nothing returning key`,
          [info.key, info.kind, batchId, info.projectId, info.subFolderId, info.title, info.fileId, info.fileName, nameKey(info.fileName) || null,
            info.version ?? 1, info.madeAt, info.uploadedAt, info.step, o.how, o.how === 'manager' ? o.actor?.id ?? null : null],
        );
        if (!linked) known = true;
      }
      const row = await t.one<{ batch_id: number; version: number }>(`select batch_id, version from timeliner_pdfs where key = $1 for update`, [info.key]);
      if (!row) throw conflict('That scripts PDF’s link changed meanwhile. Try again.');
      target = Number(row.batch_id);
      before = known ? Number(row.version) : 0;
      // a manager's pick of an upload already counted adds no version; a file put straight into a project counts up
      version = !known ? Number(row.version)
        : picked ? Math.max(before, info.kind === 'task' ? info.version ?? before : before)
        : info.kind === 'file' ? before + 1 : Math.max(before, info.version ?? before + 1);
      newest = !known || (info.kind === 'file' && !picked) || (info.version ?? before + 1) >= before;
    }
    // the batch row first, as every path that changes a batch's scripts does
    const b = await t.one<{ title: string; client_name: string; shoot_date: string | null }>(
      `select b.title, c.name as client_name, sh.start_date::text as shoot_date
         from batches b join clients c on c.id = b.client_id left join shoots sh on sh.id = b.shoot_id where b.id = $1 for no key update of b`, [target],
    );
    if (!b) throw notFound('Batch');
    if (info.key && !known && !picked) {
      // checked again under the batch's lock: another scripts PDF may have just been linked to it
      const other = await t.one<{ file_name: string | null }>(`select file_name from timeliner_pdfs where batch_id = $1 and key <> $2 and gone_at is null limit 1`, [target, info.key]);
      if (other) {
        await t.query(`delete from timeliner_pdfs where key = $1`, [info.key]);
        const why = `${b.title} already has its scripts PDF “${other.file_name ?? 'a PDF'}”. If this is a new version of it, pick ${b.title}.`;
        await o.settle(t, 'unmatched', { place: o.place, uploader: o.uploader, detail: why, suggestedBatchId: target, versionNumber: info.version });
        await notify(t, await managerIds(t), {
          type: 'delivery', title: 'Timeliner upload needs a batch',
          body: `“${info.fileName}” arrived in Timeliner${o.place ? ` (${o.place})` : ''}, but it isn’t clear which batch it’s for. ${why} Pick the batch in Settings → Timeliner and it’s delivered.`,
          link: '/settings#timeliner',
        });
        return { outcome: 'unmatched' };
      }
    }
    if (info.projectId) await t.query(`update batches set timeliner_project_id = $2 where id = $1 and timeliner_project_id is null`, [target, info.projectId]);
    if (info.key && known) {
      // a later version: the link shows it (an older version arriving late changes nothing but the time)
      await t.query(
        `update timeliner_pdfs set version = $2, latest_at = greatest(latest_at, $3), gone_at = null,
                file_id = case when $4 then coalesce($5, file_id) else file_id end, file_name = case when $4 then coalesce($6, file_name) else file_name end,
                name_key = case when $4 then coalesce($7, name_key) else name_key end, title = coalesce($8, title), step = coalesce($9, step)
          where key = $1`,
        [info.key, version, info.uploadedAt, newest, info.fileId, info.fileName, nameKey(info.fileName) || null, info.title, info.step],
      );
    }

    const approved = await t.query<{ id: number; number: number }>(
      `select id, number from scripts where batch_id = $1 and removed_at is null and status = 'approved' order by number`, [target],
    );
    const settled = { place: o.place, uploader: o.uploader, batchId: target, versionNumber: info.key ? version : info.version };
    let outcome: TimelinerOutcome;
    if (!approved.length) {
      if (known && !picked) {
        // a new version of a linked PDF with nothing new to deliver: nothing to tell the managers
        outcome = 'new_version';
        await o.settle(t, outcome, { ...settled, detail: `Version ${version} of the scripts PDF for ${b.title}: nothing new to deliver.` });
      } else {
        const left = await t.one<{ open: number; delivered: number }>(
          `select count(*) filter (where status <> 'delivered')::int as open, count(*) filter (where status = 'delivered')::int as delivered
             from scripts where batch_id = $1 and removed_at is null`, [target],
        );
        const done = !!left && left.open === 0 && left.delivered > 0;
        outcome = done ? 'already_delivered' : 'nothing_approved';
        await o.settle(t, outcome, {
          ...settled,
          detail: done ? 'Every script in the batch was already delivered.' : 'None of its scripts are approved yet, so nothing was delivered.',
        });
        if (!done && !picked) {
          await notify(t, await managerIds(t), {
            type: 'delivery', title: `In Timeliner, not approved yet · ${b.client_name}`,
            body: `“${info.fileName}” for ${b.title} arrived in Timeliner, but none of its scripts are approved here yet, so nothing was marked delivered.`,
            link: batchLink(target),
          });
        }
      }
    } else {
      const actor = o.actor ?? (await actorFor(t, o.uploaderEmail));
      if (!actor) throw new HttpError(409, 'There’s no active Admin or manager to record the delivery under.');
      const out = await applyScriptAction({ ...ctx, db: t }, actor, target, 'deliver', approved.map((s) => s.id), {
        note: `Confirmed by Timeliner: “${info.fileName}”${o.place ? ` in ${o.place}` : ''}`,
        timelinerUrl: null,
        viaTimeliner: { fileName: info.fileName ?? 'the document', uploaderName: o.uploader },
      });
      outcome = 'delivered';
      const how = o.why && (o.how === 'earliest' || o.how === 'late') ? ` (${o.why})` : '';
      await o.settle(t, outcome, { ...settled, deliveryId: out.deliveryId ?? null, detail: `Delivered scripts ${compressRanges(approved.map((s) => s.number))}${how}` });
    }

    const shoot = b.shoot_date ? `the ${fmtDate(b.shoot_date)} shoot` : b.title;
    // a guess between two shoots: the managers hear which, and the other it could have been
    if (!known && o.how === 'earliest' && o.runnerUp) {
      await notify(t, await managerIds(t), {
        type: 'delivery', title: `Scripts PDF matched by date · ${b.client_name}`,
        body: `“${info.fileName}” went to ${b.title}, the earliest of the shoots around then still without their scripts PDF. It could also be for ${o.runnerUp.title}: if so, undo the delivery on ${b.title}’s page, then pick ${o.runnerUp.title} for this upload in Settings → Timeliner.`,
        link: batchLink(target),
      });
    }
    // a new version (its message may come after a read already saw its file): the editors cutting this shoot's
    // videos (assigned to them in Timeliner, and still on their plate) hear once per version
    if (info.key && known && !picked && newest && version > 1) {
      const editors = await t.query<{ id: number }>(
        `select distinct u.id from timeliner_tasks tt
           join timeliner_members m on m.id = any(${OWNER_IDS('tt')})
           join users u on lower(u.email) = lower(m.email) and u.active and u.removed_at is null
          where tt.batch_id = $1 and tt.status_group <> all($2::text[])`, [target, OFF_PLATE_GROUPS],
      );
      await notify(t, editors.map((e) => Number(e.id)), {
        type: 'document', title: `New scripts PDF · ${b.client_name}`,
        body: `The scripts PDF for ${shoot} has a new version (v${version}).`,
        link: '/', dedupeKey: `script-pdf:${info.key}:${version}`,
      });
    }
    return { outcome, batchId: target };
  });
}

// ── connecting ───────────────────────────────────────────────────────────

/** Registers this server's webhook with Timeliner (or takes over the one already pointing here) and keeps its secret. */
export async function connectTimeliner(ctx: Ctx, api: TimelinerApi, publicUrl: string, by: Me | null): Promise<void> {
  const url = `${publicUrl}${HOOK_PATH}`;
  const existing = (await api.webhooks()).find((w) => w.url === url);
  let id: string;
  let secret: string;
  if (existing) {
    // its secret is never shown again, so take a new one
    ({ secret } = await api.rotateSecret(existing.id));
    id = existing.id;
    if (!existing.active || TIMELINER_EVENTS.some((e) => !existing.events.includes(e))) {
      await api.updateWebhook(id, { events: [...new Set([...existing.events, ...TIMELINER_EVENTS])], active: true });
    }
  } else {
    ({ id, secret } = await api.createWebhook(url, TIMELINER_EVENTS));
  }
  await ctx.db.query(
    `update settings set timeliner_webhook_id = $1, timeliner_webhook_secret = $2, timeliner_connected_by = $3, timeliner_connected_at = $4 where id = 1`,
    [id, secret, by?.id ?? null, ctx.now().toISOString()],
  );
  await logActivity(ctx.db, { actor: by, action: 'timeliner.connected', entityType: 'settings', summary: `Connected Timeliner: uploads of script documents now mark their batch delivered, and changes to videos reach the Editors tab straight away (${url})` });
}

/**
 * On start-up: connect once when there's a key and an address but no webhook yet. Already connected, the webhook
 * is given the messages it lacks, like the video messages for a webhook connected before the videos were read
 * from Timeliner (a key that can't write webhooks can't; the timed read still keeps the videos current, just not
 * straight away). Whether it's switched on is left as Timeliner has it: someone may have paused it there on
 * purpose, and Settings → Timeliner → Connect switches it back on.
 */
export async function connectOnStart(ctx: Ctx, log: (m: string) => void): Promise<void> {
  if (!ctx.timeliner || !ctx.publicUrl) return;
  const s = await ctx.db.one<{ id: string | null }>(`select timeliner_webhook_id as id from settings where id = 1`);
  if (s?.id) {
    try {
      const hook = (await ctx.timeliner.webhooks()).find((w) => w.id === s.id);
      const missing = hook ? TIMELINER_EVENTS.filter((e) => !hook.events.includes(e)) : [];
      if (hook && missing.length) {
        await ctx.timeliner.updateWebhook(hook.id, { events: [...new Set([...hook.events, ...TIMELINER_EVENTS])] });
        log(`timeliner: the webhook now also sends ${missing.join(', ')}`);
      }
      if (hook && !hook.active) log('timeliner: the webhook is switched off in Timeliner (left as it is; Connect in Settings → Timeliner switches it back on, and the videos are still read every few minutes)');
    } catch (err) {
      log(`timeliner: couldn't update the webhook (videos are still read every few minutes): ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }
  try {
    await connectTimeliner(ctx, ctx.timeliner, ctx.publicUrl, null);
    log('timeliner: connected (uploads of script documents now mark their batch delivered)');
  } catch (err) {
    log(`timeliner: couldn't connect: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── routes ───────────────────────────────────────────────────────────────

/**
 * A scripts PDF's step in Timeliner that means it's being reviewed (Internal approval, or Revisions requested), not
 * one it was made at: a PDF at To be edited or the inProgress group (Needs review, for a video) isn't flagged.
 */
export const pdfInReview = (step: string | null) => step === 'supervisorApproval' || step === 'inRevision';
const SURE_PDF: Record<TimelinerPdfHow, boolean> = { name: true, date: true, earliest: false, late: false, only: true, manager: true, backfill: true };
/** What Pick batch can place: an upload of a scripts PDF, whatever became of it (not a video's message, a test or one still being handled). */
const PICKABLE: TimelinerOutcome[] = ['unmatched', 'nothing_approved', 'delivered', 'already_delivered', 'new_version'];

async function status(ctx: Ctx): Promise<TimelinerStatus> {
  const { db } = ctx;
  const s = await db.one<{ webhook_id: string | null; connected_at: string | null; by_name: string | null; test_at: string | null }>(
    `select s.timeliner_webhook_id as webhook_id, s.timeliner_connected_at as connected_at, u.name as by_name, s.timeliner_test_at as test_at
       from settings s left join users u on u.id = s.timeliner_connected_by where s.id = 1`,
  );
  const rows = await db.query<{
    id: string; received_at: string; file_name: string | null; place: string | null; uploader: string | null; outcome: TimelinerOutcome; detail: string | null;
    batch_id: number | null; title: string | null; client_name: string | null; version_number: number | null;
    suggested_id: number | null; suggested_title: string | null; suggested_client: string | null; uploaded_at: string | null;
  }>(
    `select e.id, e.received_at, e.file_name, e.place, e.uploader, e.outcome, e.detail, e.batch_id, b.title, c.name as client_name, e.version_number,
            e.suggested_batch_id as suggested_id, sb.title as suggested_title, sc.name as suggested_client, e.uploaded_at
       from timeliner_events e left join batches b on b.id = e.batch_id left join clients c on c.id = b.client_id
       left join batches sb on sb.id = e.suggested_batch_id left join clients sc on sc.id = sb.client_id
      where e.outcome not in ('ignored', 'test', 'pending') order by e.received_at desc limit 30`,
  );
  const iso = (x: string | Date | null) => (x ? new Date(x).toISOString() : null);
  const events: TimelinerEvent[] = rows.map((r) => ({
    id: r.id, receivedAt: iso(r.received_at)!, fileName: r.file_name, where: r.place, uploader: r.uploader,
    outcome: r.outcome === 'new_version' ? 'already_delivered' : r.outcome, result: r.outcome, version: r.version_number, detail: r.detail,
    batch: r.batch_id ? { id: Number(r.batch_id), title: r.title ?? '', clientName: r.client_name ?? '' } : null,
    suggestedBatch: r.suggested_id ? { id: Number(r.suggested_id), title: r.suggested_title ?? '', clientName: r.suggested_client ?? '' } : null,
  }));
  const suggested = events.filter((e) => e.outcome === 'unmatched' || e.outcome === 'nothing_approved').flatMap((e) => (e.suggestedBatch ? [e.suggestedBatch.id] : []));
  // the shoots around when the uploads listed came in: from a late upload's to one made well ahead
  const tz = (await loadSettings(db)).timezone;
  const days = rows.map((r) => dayOf(r.uploaded_at ?? r.received_at, tz)).sort();
  const around = days.length ? { from: addDays(days[0], -PDF_LATE_FALLBACK), to: addDays(days[days.length - 1], PDF_AHEAD) } : null;
  const links = await db.query<{
    key: string; kind: 'task' | 'file'; batch_id: number; title: string; client_name: string; file_name: string | null; task_title: string | null; version: number;
    first_at: string; latest_at: string; how: TimelinerPdfHow; gone_at: string | null; step: string | null; linked_by: string | null;
  }>(
    `select p.key, p.kind, p.batch_id, b.title, c.name as client_name, p.file_name, p.title as task_title, p.version, p.first_at, p.latest_at, p.how,
            p.gone_at, p.step, u.name as linked_by
       from timeliner_pdfs p join batches b on b.id = p.batch_id join clients c on c.id = b.client_id left join users u on u.id = p.linked_by
      order by p.latest_at desc, p.key limit 30`,
  );
  const pdfs: TimelinerPdfLink[] = links.map((p) => ({
    key: p.key, kind: p.kind, batch: { id: Number(p.batch_id), title: p.title, clientName: p.client_name },
    fileName: p.file_name, title: p.task_title, version: p.version, firstAt: iso(p.first_at)!, latestAt: iso(p.latest_at)!,
    how: p.how, sure: SURE_PDF[p.how], gone: !!p.gone_at, inReview: pdfInReview(p.step), linkedBy: p.how === 'manager' ? p.linked_by : null,
  }));
  return {
    keySet: !!ctx.timeliner,
    webhookUrl: ctx.publicUrl ? `${ctx.publicUrl}${HOOK_PATH}` : null,
    connected: s?.webhook_id && s.connected_at ? { at: iso(s.connected_at)!, byName: s.by_name } : null,
    testAt: iso(s?.test_at ?? null),
    events,
    openBatches: await pickableBatches(db, suggested, around),
    pdfs,
  };
}

export function registerTimelinerRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;
  const needApi = () => {
    if (!ctx.timeliner) throw new HttpError(400, 'Add TIMELINER_API_KEY to the server’s environment first (Timeliner → Settings → Developers).');
    return ctx.timeliner;
  };
  const failed = (err: unknown): never => {
    if (err instanceof TimelinerError) throw new HttpError(502, err.message);
    throw err;
  };

  app.get('/api/timeliner', async (req) => {
    requireManager(req);
    return status(ctx);
  });

  app.post('/api/timeliner/connect', async (req) => {
    const me = requireManager(req);
    const api = needApi();
    if (!ctx.publicUrl) throw new HttpError(400, 'The server doesn’t know its public address. Set PUBLIC_URL (like https://scripts.example.com) and try again.');
    await connectTimeliner(ctx, api, ctx.publicUrl, me).catch(failed);
    return status(ctx);
  });

  // Timeliner sends a signed sample message to the webhook; Settings shows when it arrived
  app.post('/api/timeliner/test', async (req) => {
    requireManager(req);
    const api = needApi();
    const s = await db.one<{ id: string | null }>(`select timeliner_webhook_id as id from settings where id = 1`);
    if (!s?.id) throw new HttpError(400, 'Connect Timeliner first.');
    const r = await api.testWebhook(s.id).catch(failed);
    if (!r.ok) throw new HttpError(502, `Timeliner couldn’t reach this site (${r.error ?? `status ${r.statusCode ?? 'none'}`}). Check the address is public, then connect again.`);
    return status(ctx);
  });

  // Pick batch: a manager places an upload that couldn't be matched (or found nothing approved), or moves a scripts
  // PDF linked to the wrong shoot once its delivery there is undone. The PDF is linked to that batch, so its later
  // versions follow by themselves, and whatever is approved there is delivered.
  app.post('/api/timeliner/events/:id/assign', async (req) => {
    const me = requireManager(req);
    const { id } = parse(z.object({ id: z.string().min(1).max(200) }), req.params);
    const { batchId } = parse(z.object({ batchId: zs.id }), req.body);
    const ev = await db.one<{
      type: string; project_id: string | null; task_id: string | null; file_id: string | null; file_name: string | null; place: string | null;
      uploader: string | null; outcome: TimelinerOutcome; version_number: number | null; uploaded_at: string | null; received_at: string;
    }>(
      `select type, project_id, task_id, file_id, file_name, place, uploader, outcome, version_number, uploaded_at, received_at from timeliner_events where id = $1`, [id],
    );
    if (!ev) throw notFound('Timeliner upload');
    if (!PICKABLE.includes(ev.outcome)) throw conflict('That isn’t an upload of a scripts PDF.');
    if (!(await db.one(`select 1 from batches where id = $1 and archived_at is null`, [batchId]))) throw notFound('Batch');
    const isFile = ev.type === 'file.uploaded';
    const key = isFile ? (ev.file_id ? `file:${ev.file_id}` : null) : ev.task_id;
    // when its task was made, and where it sits (best effort, before anything is locked)
    const task = key && !isFile && ctx.timeliner ? await ctx.timeliner.task(key).catch(() => null) : null;
    const at = isoOf(ev.uploaded_at) ?? isoOf(ev.received_at) ?? ctx.now().toISOString();
    await db.tx(async (t) => {
      // two managers picking at once take turns here
      const still = await t.one<{ outcome: TimelinerOutcome }>(`select outcome from timeliner_events where id = $1 for update`, [id]);
      if (!still || !PICKABLE.includes(still.outcome)) throw conflict('That isn’t an upload of a scripts PDF.');
      // the PDF's link: followed when it's this batch already; moved here when it's another
      let known = false;
      if (key) {
        const linked = await t.one<{ batch_id: number; title: string }>(
          `select p.batch_id, b.title from timeliner_pdfs p join batches b on b.id = p.batch_id where p.key = $1 for update of p`, [key],
        );
        // placed once is enough: its next version delivers what's approved there by then
        if (linked && Number(linked.batch_id) === batchId && still.outcome !== 'unmatched' && still.outcome !== 'nothing_approved') {
          throw conflict(`That scripts PDF is already linked to ${linked.title}.`);
        }
        if (linked && Number(linked.batch_id) !== batchId) {
          // moved only while none of the scripts it delivered there are still delivered (Move, which would undo
          // them too, isn't built: the manager undoes that delivery on the batch's page first)
          const holds = await t.one(
            `select 1 from timeliner_events e join scripts s on s.delivery_id = e.delivery_id
              where (e.task_id = $1 or ('file:' || e.file_id) = $1) and s.batch_id = $2 and s.status = 'delivered' and s.removed_at is null limit 1`, [key, linked.batch_id],
          );
          if (holds) throw conflict(`That scripts PDF is linked to ${linked.title}, where it delivered scripts. Undo that delivery on ${linked.title}’s page first, then pick again.`);
          // its versions so far stay with it
          await t.query(`update timeliner_pdfs set batch_id = $2, how = 'manager', linked_by = $3, linked_at = $4 where key = $1`, [key, batchId, me.id, ctx.now().toISOString()]);
        }
        known = !!linked;
      }
      await deliverFromTimeliner({ ...ctx, db: t }, batchId, {
        key, kind: isFile ? 'file' : 'task', projectId: ev.project_id, subFolderId: strOf(task?.subFolderId), title: strOf(task?.title),
        fileId: ev.file_id, fileName: ev.file_name, version: ev.version_number, madeAt: isoOf(task?.createdAt) ?? at, uploadedAt: at, step: strOf(task?.statusGroup),
      }, { place: ev.place, uploader: ev.uploader, uploaderEmail: null, actor: me, settle: settleRow(id), how: known ? null : 'manager' });
    });
    return status(ctx);
  });

  // the webhook itself: public, because Timeliner calls it, and refused unless Timeliner's signature checks out
  void app.register(async (hook) => {
    // the signature covers the exact bytes, so keep the body as it came
    hook.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 256 * 1024 }, (_req, body, done) => done(null, body));
    registerHook(hook, ctx);
  });
}

function registerHook(app: FastifyInstance, ctx: Ctx) {
  app.post('/hooks/timeliner', async (req, reply) => {
    const raw = typeof req.body === 'string' ? req.body : '';
    const s = await ctx.db.one<{ secret: string | null }>(`select timeliner_webhook_secret as secret from settings where id = 1`);
    const header = req.headers['x-timeliner-signature'];
    if (!s?.secret || !verifySignature(s.secret, Array.isArray(header) ? header[0] : header, raw, Math.floor(ctx.now().getTime() / 1000))) {
      return reply.status(401).send({ error: 'Signature didn’t check out' });
    }
    let m: UploadMessage;
    try { m = readMessage(JSON.parse(raw)); } catch { return reply.status(400).send({ error: 'Not a Timeliner message' }); }
    const out = await handleTimelinerMessage(ctx, ctx.timeliner ?? null, m);
    return { ok: true, outcome: out.outcome };
  });
}
