// Timeliner: when a batch's script document lands in Timeliner, the batch is marked delivered by itself.
//
// Timeliner sends a signed message to POST /hooks/timeliner when a file is uploaded: version.uploaded for a
// file on a task, file.uploaded for a file in a project. Each message is checked against the secret Timeliner
// gave this server when it registered the webhook (Settings → Timeliner, or on start-up), logged once (Timeliner
// can send the same message twice) and matched to a batch: the Timeliner project the batch is linked to, else
// the client whose name the Timeliner brand or project carries, narrowed to its batches with approved scripts.
// That batch's approved scripts are delivered through applyScriptAction, recorded under the uploader when they
// are on the team (else whoever connected Timeliner) and labelled as Timeliner's confirmation. Only documents
// count (PDF, Word, text): the videos editors upload are ignored. An upload that can't be placed waits in
// Settings → Timeliner for a manager to pick its batch, and the batch is linked for next time.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from './db';
import { batchLink, logActivity, managerIds, notify, type Ctx } from './core';
import { requireManager } from './auth';
import { HttpError, conflict, notFound, parse, zs } from './http';
import { applyScriptAction } from './routes/batches';
import type { Me, TimelinerEvent, TimelinerOutcome, TimelinerStatus } from '../shared/types';
import { compressRanges } from '../shared/workflow';

/** the messages this server subscribes to */
export const TIMELINER_EVENTS = ['version.uploaded', 'file.uploaded'];
/** what the key needs: register the webhook, read where an upload landed, and who uploaded it */
export const KEY_PERMISSIONS = 'Webhooks (read & write), Projects (read) and Workspace (read)';
export const HOOK_PATH = '/hooks/timeliner';

// ── Timeliner's API ──────────────────────────────────────────────────────

/** The parts of Timeliner's REST API this server uses (tests pass a stand-in). */
export interface TimelinerApi {
  project(id: string): Promise<{ id: string; name: string } | null>;
  brand(id: string): Promise<{ id: string; name: string } | null>;
  task(id: string): Promise<{ id: string; taskId: string | null; title: string } | null>;
  members(): Promise<{ id: string; email: string; firstName: string | null; lastName: string | null }[]>;
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

/** What Timeliner's error means for the person reading Settings. */
function explain(status: number, body: Record<string, unknown>): string {
  if (status === 401) return 'Timeliner didn’t accept the API key. Check TIMELINER_API_KEY on the server (Timeliner → Settings → Developers).';
  if (status === 403 && body.code === 'insufficient_scope') return `The Timeliner key isn’t allowed to ${String(body.requiredScope ?? 'do this').replace(':', ' ')}. In Timeliner → Settings → Developers, make a key with ${KEY_PERMISSIONS}, put it in TIMELINER_API_KEY, and connect again.`;
  if (status === 429) return 'Timeliner is limiting how often this key can call it. Try again in a minute.';
  return `Timeliner answered ${status}${typeof body.error === 'string' ? `: ${body.error}` : ''}.`;
}

/** Timeliner's REST API at `base` (https://timeliner.io), called with a workspace key (tlsk_…). */
export function timelinerClient(key: string, base: string, fetchImpl: typeof fetch = fetch): TimelinerApi {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T | null> => {
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
    if (res.status === 404 && method === 'GET') return null;
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try { json = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { /* not JSON: explained by status */ }
    if (!res.ok) throw new TimelinerError(explain(res.status, json), res.status);
    return json as T;
  };
  return {
    project: (id) => call('GET', `/projects/${encodeURIComponent(id)}`),
    brand: (id) => call('GET', `/brands/${encodeURIComponent(id)}`),
    task: (id) => call('GET', `/tasks/${encodeURIComponent(id)}`),
    members: async () => (await call<{ data: Awaited<ReturnType<TimelinerApi['members']>> }>('GET', '/members'))?.data ?? [],
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

const STOP = new Set(['the', 'and', 'of', 'co', 'company', 'inc', 'llc', 'ltd', 'group']);
export const nameWords = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' ')
  .split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w));

/** How well a Timeliner name fits a client: how many of the client's name words it holds, if it holds them all (else 0). */
export function clientFit(clientName: string, timelinerName: string): number {
  const client = nameWords(clientName);
  const there = new Set(nameWords(timelinerName));
  if (!client.length || !there.size) return 0;
  // "Lumen" (the brand) is Lumen Skincare; "Old Mill Bakery · Winter" (a project) is Old Mill Bakery
  if (client.every((w) => there.has(w))) return client.length;
  if ([...there].every((w) => client.includes(w))) return there.size;
  return 0;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** The ways a date shows up in a project or task name: "Oct 13", "13 Oct", "10/13", "2026-10-13". */
function dateForms(iso: string): string[] {
  const [y, m, d] = iso.split('-').map(Number);
  const mon = MONTHS[m - 1];
  return [`${mon} ${d}`, `${d} ${mon}`, `${m}/${d}`, `${d}/${m}`, iso, `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`];
}

interface Candidate { id: number; title: string; client_id: number; client_name: string; shoot_date: string | null; final_due: string | null; approved: number }

/** Which of these batches a Timeliner name points at: the only one, or the one whose title or date it carries. */
export function pickBatch(cands: Candidate[], text: string): Candidate | null {
  if (cands.length <= 1) return cands[0] ?? null;
  const hay = ` ${text.toLowerCase().replace(/[^a-z0-9/-]+/g, ' ')} `;
  const scored = cands.map((c) => {
    const words = nameWords(c.title).filter((w) => w.length > 2 && !nameWords(c.client_name).includes(w));
    let score = words.filter((w) => hay.includes(` ${w} `)).length;
    for (const d of [c.shoot_date, c.final_due]) if (d && dateForms(d).some((f) => hay.includes(` ${f} `))) score += 3;
    return { c, score };
  }).sort((a, b) => b.score - a.score);
  return scored[0].score > 0 && scored[0].score > scored[1].score ? scored[0].c : null;
}

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

async function candidates(db: Db, where: string, params: unknown[]): Promise<Candidate[]> {
  return db.query<Candidate>(
    `select b.id, b.title, b.client_id, c.name as client_name, sh.start_date::text as shoot_date, b.final_due::text as final_due,
            (select count(*)::int from scripts s where s.batch_id = b.id and s.removed_at is null and s.status = 'approved') as approved
       from batches b join clients c on c.id = b.client_id left join shoots sh on sh.id = b.shoot_id
      where b.archived_at is null and ${where}
      order by b.final_due nulls last, b.id`, params,
  );
}

type Handled = { outcome: TimelinerOutcome | 'duplicate'; batchId?: number };
/** Records what became of a message (its row was claimed when it arrived). */
type Settle = (t: Db, outcome: TimelinerOutcome, extra?: { place?: string | null; uploader?: string | null; batchId?: number | null; deliveryId?: number | null; detail?: string | null }) => Promise<void>;

const settleRow = (id: string): Settle => async (t, outcome, extra = {}) => {
  await t.query(
    `update timeliner_events set outcome = $2, place = coalesce($3, place), uploader = coalesce($4, uploader), batch_id = $5, delivery_id = $6, detail = $7 where id = $1`,
    [id, outcome, extra.place ?? null, extra.uploader ?? null, extra.batchId ?? null, extra.deliveryId ?? null, extra.detail ?? null],
  );
};

/** Places one message from Timeliner and, when it's a batch's script document, delivers that batch. */
export async function handleTimelinerMessage(ctx: Ctx, api: TimelinerApi | null, m: UploadMessage): Promise<Handled> {
  const { db } = ctx;
  // claim the message first: Timeliner may send it twice, and only one copy is acted on
  const claimed = await db.one<{ id: string }>(
    `insert into timeliner_events (id, type, project_id, task_id, brand_id, file_name, outcome) values ($1,$2,$3,$4,$5,$6,'pending')
     on conflict (id) do nothing returning id`,
    [m.id, m.type, m.projectId, m.taskId, m.brandId, m.fileName],
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

async function place(ctx: Ctx, api: TimelinerApi | null, m: UploadMessage, settle: Settle): Promise<Handled> {
  const { db } = ctx;
  if (m.test) {
    await settle(db, 'test');
    await db.query(`update settings set timeliner_test_at = $1 where id = 1`, [ctx.now().toISOString()]);
    return { outcome: 'test' };
  }
  if (!TIMELINER_EVENTS.includes(m.type) || !m.fileName || !isScriptDocument(m.fileName, m.mimeType)) {
    await settle(db, 'ignored', { detail: m.fileName ? 'Not a document' : `A ${m.type} message` });
    return { outcome: 'ignored' };
  }

  // the names it arrived under, for matching and for the log (best effort: a lookup that fails just matches less)
  const look = async <T>(f: (a: TimelinerApi) => Promise<T>) => { try { return api ? await f(api) : null; } catch { return null; } };
  const project = m.projectId ? await look((a) => a.project(m.projectId!)) : null;
  const brand = m.brandId ? await look((a) => a.brand(m.brandId!)) : null;
  const members = m.uploadedBy ? (await look((a) => a.members())) ?? [] : [];
  const member = members.find((x) => x.id === m.uploadedBy);
  const uploader = member ? [member.firstName, member.lastName].filter(Boolean).join(' ') || member.email : null;
  const where = [brand?.name, project?.name, m.taskTitle].filter(Boolean).join(' › ') || null;

  // the batch: one linked to this Timeliner project, else the client the brand or project is named after
  let cands = m.projectId ? await candidates(db, `b.timeliner_project_id = $1`, [m.projectId]) : [];
  let why = '';
  if (!cands.length) {
    const clients = await db.query<{ id: number; name: string }>(`select id, name from clients where archived_at is null and status <> 'prospect'`);
    const fits = clients.map((c) => ({ c, fit: Math.max(brand ? clientFit(c.name, brand.name) : 0, project ? clientFit(c.name, project.name) : 0) }))
      .filter((x) => x.fit > 0).sort((a, b) => b.fit - a.fit);
    if (!fits.length) why = `No client is named like ${where ? `“${where}”` : 'this Timeliner project'}.`;
    else if (fits.length > 1 && fits[0].fit === fits[1].fit) why = `More than one client fits: ${fits.filter((x) => x.fit === fits[0].fit).map((x) => x.c.name).join(', ')}.`;
    else {
      const client = fits[0].c;
      cands = await candidates(db, `b.client_id = $1 and exists (select 1 from scripts s where s.batch_id = b.id and s.removed_at is null and s.status = 'approved')`, [client.id]);
      if (!cands.length) why = `${client.name} has no batch with approved scripts waiting to be delivered.`;
    }
  }
  const batch = cands.length ? pickBatch(cands, [project?.name, m.taskTitle, m.fileName].filter(Boolean).join(' ')) : null;
  if (!batch) {
    if (cands.length > 1) why = `It could be ${cands.map((c) => c.title).join(', ')}.`;
    await settle(db, 'unmatched', { place: where, uploader, detail: why || 'Couldn’t tell which batch it’s for.' });
    await notify(db, await managerIds(db), {
      type: 'delivery', title: 'Timeliner upload needs a batch',
      body: `“${m.fileName}” arrived in Timeliner${where ? ` (${where})` : ''}, but it isn’t clear which batch it’s for. Pick the batch in Settings → Timeliner and it’s delivered.`,
      link: '/settings#timeliner',
    });
    return { outcome: 'unmatched' };
  }
  return deliverFromTimeliner(ctx, m, batch.id, { place: where, uploader, uploaderEmail: member?.email ?? null, settle });
}

/** Delivers a batch's approved scripts as Timeliner's confirmation, links the batch to the Timeliner project, and settles the message. */
async function deliverFromTimeliner(
  ctx: Ctx, m: Pick<UploadMessage, 'projectId' | 'fileName'>, batchId: number,
  o: { place: string | null; uploader: string | null; uploaderEmail: string | null; actor?: Me; settle: Settle },
): Promise<Handled> {
  return ctx.db.tx(async (t) => {
    // the batch row first, as every path that changes a batch's scripts does
    const b = await t.one<{ title: string; client_name: string }>(
      `select b.title, c.name as client_name from batches b join clients c on c.id = b.client_id where b.id = $1 for no key update of b`, [batchId],
    );
    if (!b) throw notFound('Batch');
    if (m.projectId) await t.query(`update batches set timeliner_project_id = $2 where id = $1 and timeliner_project_id is null`, [batchId, m.projectId]);
    const approved = await t.query<{ id: number; number: number }>(
      `select id, number from scripts where batch_id = $1 and removed_at is null and status = 'approved' order by number`, [batchId],
    );
    if (!approved.length) {
      const left = await t.one<{ open: number; delivered: number }>(
        `select count(*) filter (where status <> 'delivered')::int as open, count(*) filter (where status = 'delivered')::int as delivered
           from scripts where batch_id = $1 and removed_at is null`, [batchId],
      );
      const done = !!left && left.open === 0 && left.delivered > 0;
      await o.settle(t, done ? 'already_delivered' : 'nothing_approved', {
        place: o.place, uploader: o.uploader, batchId,
        detail: done ? 'Every script in the batch was already delivered.' : 'None of its scripts are approved yet, so nothing was delivered.',
      });
      if (!done) {
        await notify(t, await managerIds(t), {
          type: 'delivery', title: `In Timeliner, not approved yet · ${b.client_name}`,
          body: `“${m.fileName}” for ${b.title} arrived in Timeliner, but none of its scripts are approved here yet, so nothing was marked delivered.`,
          link: batchLink(batchId),
        });
      }
      return { outcome: done ? 'already_delivered' : 'nothing_approved', batchId };
    }
    const actor = o.actor ?? (await actorFor(t, o.uploaderEmail));
    if (!actor) throw new HttpError(409, 'There’s no active Admin or manager to record the delivery under.');
    const out = await applyScriptAction({ ...ctx, db: t }, actor, batchId, 'deliver', approved.map((s) => s.id), {
      note: `Confirmed by Timeliner: “${m.fileName}”${o.place ? ` in ${o.place}` : ''}`,
      timelinerUrl: null,
      viaTimeliner: { fileName: m.fileName ?? 'the document', uploaderName: o.uploader },
    });
    await o.settle(t, 'delivered', { place: o.place, uploader: o.uploader, batchId, deliveryId: out.deliveryId ?? null, detail: `Delivered scripts ${compressRanges(approved.map((s) => s.number))}` });
    return { outcome: 'delivered', batchId };
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
  await logActivity(ctx.db, { actor: by, action: 'timeliner.connected', entityType: 'settings', summary: `Connected Timeliner: uploads of script documents now mark their batch delivered (${url})` });
}

/** On start-up: connect once when there's a key and an address but no webhook yet. */
export async function connectOnStart(ctx: Ctx, log: (m: string) => void): Promise<void> {
  if (!ctx.timeliner || !ctx.publicUrl) return;
  const s = await ctx.db.one<{ id: string | null }>(`select timeliner_webhook_id as id from settings where id = 1`);
  if (s?.id) return;
  try {
    await connectTimeliner(ctx, ctx.timeliner, ctx.publicUrl, null);
    log('timeliner: connected (uploads of script documents now mark their batch delivered)');
  } catch (err) {
    log(`timeliner: couldn't connect: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── routes ───────────────────────────────────────────────────────────────

async function status(ctx: Ctx): Promise<TimelinerStatus> {
  const { db } = ctx;
  const s = await db.one<{ webhook_id: string | null; connected_at: string | null; by_name: string | null; test_at: string | null }>(
    `select s.timeliner_webhook_id as webhook_id, s.timeliner_connected_at as connected_at, u.name as by_name, s.timeliner_test_at as test_at
       from settings s left join users u on u.id = s.timeliner_connected_by where s.id = 1`,
  );
  const rows = await db.query<{ id: string; received_at: string; file_name: string | null; place: string | null; uploader: string | null; outcome: TimelinerOutcome; detail: string | null; batch_id: number | null; title: string | null; client_name: string | null }>(
    `select e.id, e.received_at, e.file_name, e.place, e.uploader, e.outcome, e.detail, e.batch_id, b.title, c.name as client_name
       from timeliner_events e left join batches b on b.id = e.batch_id left join clients c on c.id = b.client_id
      where e.outcome not in ('ignored', 'test', 'pending') order by e.received_at desc limit 30`,
  );
  const open = await candidates(db, `exists (select 1 from scripts s where s.batch_id = b.id and s.removed_at is null and s.status = 'approved')`, []);
  const iso = (x: string | Date | null) => (x ? new Date(x).toISOString() : null);
  const events: TimelinerEvent[] = rows.map((r) => ({
    id: r.id, receivedAt: iso(r.received_at)!, fileName: r.file_name, where: r.place, uploader: r.uploader, outcome: r.outcome, detail: r.detail,
    batch: r.batch_id ? { id: r.batch_id, title: r.title ?? '', clientName: r.client_name ?? '' } : null,
  }));
  return {
    keySet: !!ctx.timeliner,
    webhookUrl: ctx.publicUrl ? `${ctx.publicUrl}${HOOK_PATH}` : null,
    connected: s?.webhook_id && s.connected_at ? { at: iso(s.connected_at)!, byName: s.by_name } : null,
    testAt: iso(s?.test_at ?? null),
    events,
    openBatches: open.map((b) => ({ id: b.id, title: b.title, clientName: b.client_name, approved: b.approved })),
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

  // a manager places an upload that couldn't be matched; the batch is linked to that Timeliner project for next time
  app.post('/api/timeliner/events/:id/assign', async (req) => {
    const me = requireManager(req);
    const { id } = parse(z.object({ id: z.string().min(1).max(200) }), req.params);
    const { batchId } = parse(z.object({ batchId: zs.id }), req.body);
    const ev = await db.one<{ project_id: string | null; file_name: string | null; place: string | null; uploader: string | null; outcome: TimelinerOutcome }>(
      `select project_id, file_name, place, uploader, outcome from timeliner_events where id = $1`, [id],
    );
    if (!ev) throw notFound('Timeliner upload');
    if (ev.outcome !== 'unmatched' && ev.outcome !== 'nothing_approved') throw conflict('That upload is already placed.');
    if (!(await db.one(`select 1 from batches where id = $1 and archived_at is null`, [batchId]))) throw notFound('Batch');
    const out = await deliverFromTimeliner(ctx, { projectId: ev.project_id, fileName: ev.file_name }, batchId,
      { place: ev.place, uploader: ev.uploader, uploaderEmail: null, actor: me, settle: settleRow(id) });
    if (out.outcome !== 'delivered') throw conflict('None of that batch’s scripts are approved yet, so there’s nothing to deliver.');
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
