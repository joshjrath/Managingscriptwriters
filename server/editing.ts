// Editing: the videos editors cut, read from Timeliner.
//
// Videos are given to editors in Timeliner; this site never assigns them and editors never claim them here.
// Every TIMELINER_SYNC_MINUTES (and on "Read Timeliner now") the server reads Timeliner's members, brands and
// tasks and keeps a copy. Each video is matched to a client (the client a batch linked to its Timeliner project
// belongs to, else the Timeliner brand's name, else the project's), a batch (of the client's batches with finished
// scripts: by the folder's word, then the linked one unless a newer shoot came before the video, then the shoot
// date) and a script (the number in its title), so its editor sees the document to cut from. A read-only key is
// enough. When the webhook is connected, task messages update one video straight away; a message that changes or
// removes a video after a read began isn't undone by that read. When Timeliner can't be read, its error is kept
// for the page and the last copy stays.
//
// The site's own layer is what each editor is doing right now: "I'm on this", Pause, Resume and Done. Done
// tells the managers and never changes Timeliner; the video moves on here when Timeliner has it in review.
// A focus ends by itself when Timeliner moves its video on (that becomes the editor's last finished video),
// gives it to someone else or removes it (then it's just over: the video isn't theirs any more).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LOCKS, type Db } from './db';
import { loadSettings, loadUsers, logActivity, managerIds, notify, type Ctx } from './core';
import { requireManager, requireUser } from './auth';
import { HttpError, conflict, forbidden, notFound, parse } from './http';
import { clientFit, nameWords, pickBatch, TimelinerError, type TimelinerApi } from './timeliner';
import { loadDeliverables, loadScriptEdits, type ScriptEdit } from './records';
import { EDITOR_FILES } from './files';
import { diffDays, isISODate, isValidTimeZone, makeClock, nowInZone, type ISODate } from '../shared/dates';
import { onShift } from '../shared/cities';
import {
  compressRanges, compressTitles, isApproved, isEditor, isFocusStale, isOnPlate, TIMELINER_STEP_LABEL, titleNumber, videoState,
  type TimelinerStatusGroup, type VideoState,
} from '../shared/workflow';
import { fmtWorked } from '../shared/format';
import type {
  Deliverable, EditingBoard, EditingSync, EditingVideo, EditorFocus, EditorPlate, EditorRow, FocusAction, Me, MyEditing, ScriptDoc, UserSummary,
} from '../shared/types';

/** pages of 100 tasks read each time, newest first (a read that stops here removes only what vanished from the stretch it read) */
const TASK_PAGES = 30;
const BRAND_PAGES = 10;
/** approved or posted and untouched this long: not kept */
const KEEP_FINISHED_DAYS = 30;
/** a project's name and sub-folders are read again at most this often */
const PROJECT_REFRESH_MS = 3600_000;
const PROJECTS_PER_READ = 60;
/** a video's last step move is read when its step changes, at most this many each time */
const MOVES_PER_READ = 40;
/** videos nobody has been given are listed when created this recently */
const NOT_ASSIGNED_DAYS = 60;
const DAY_MS = 86400_000;
/** steps whose exact name matters (Needs review or Internal approval) and whose time is shown */
const STEP_GROUPS = new Set(['inRevision', 'supervisorApproval', 'clientApproval', 'endClientApproval']);

const time = (v: string | null | undefined) => (v ? Date.parse(v) : NaN);
const iso = (v: string | Date | null | undefined) => {
  const d = v ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
};

// ── reading Timeliner ────────────────────────────────────────────────────

const text = (max: number) => z.string().trim().min(1).max(max).nullish().catch(null);
const day = z.string().transform((v) => v.slice(0, 10)).refine(isISODate).nullish().catch(null);
const stamp = z.string().refine((v) => !Number.isNaN(Date.parse(v))).nullish().catch(null);
const rounds = z.number().int().min(0).max(10_000).catch(0);
/** A task as read from Timeliner, checked field by field: an odd value is dropped, never trusted. */
const taskSchema = z.object({
  id: z.string().trim().min(1).max(200),
  title: z.string().trim().max(500).catch(''),
  statusGroup: z.string().max(60).catch('toDo'),
  status: text(40),
  type: text(40),
  projectId: text(200),
  brandId: text(200),
  subFolderId: text(200),
  assigneeIds: z.array(z.string().min(1).max(200)).max(100).catch([]),
  internalDeadline: day,
  externalDeadline: day,
  internalRevisions: rounds,
  clientRevisions: rounds,
  createdAt: stamp,
  updatedAt: stamp,
  approvedAt: stamp,
});
type Task = z.infer<typeof taskSchema>;
const readTask = (raw: unknown): Task | null => {
  const r = taskSchema.safeParse(raw);
  return r.success ? r.data : null;
};

/** Why a task isn't kept as a video: trashed or archived, a document rather than a video, or long finished. */
function skipReason(t: Task, now: Date): string | null {
  if (t.status && t.status !== 'active') return 'it was trashed or archived in Timeliner';
  if (t.type === 'doc') return 'it’s a document, not a video';
  if (videoState(t.statusGroup) === 'approved' && time(t.updatedAt ?? t.approvedAt) < now.getTime() - KEEP_FINISHED_DAYS * DAY_MS) return 'it was finished long ago';
  return null;
}

async function readPages<T>(page: (before: string | null) => Promise<{ data: T[]; nextBefore: string | null }>, cap: number): Promise<{ items: T[]; complete: boolean }> {
  const items: T[] = [];
  let before: string | null = null;
  for (let i = 0; i < cap; i++) {
    const p = await page(before);
    items.push(...p.data);
    if (!p.nextBefore) return { items, complete: true };
    // a cursor that doesn't move would read the same page for ever
    if (p.nextBefore === before) break;
    before = p.nextBefore;
  }
  return { items, complete: false };
}

/** Too many calls, or Timeliner out of reach: stop the optional lookups for this read. */
const stopLooking = (err: unknown) => err instanceof TimelinerError && (err.status === 429 || err.status === 0);

interface NameRow { id: string; kind: 'brand' | 'project' | 'subfolder'; name: string; parent_id: string | null; synced_at: string }
type ProjectRead = { name: string; nodeId: string | null; subFolders: { id: string; name: string }[] } | null;
type Move = { at: string; to: string | null; byId: string | null } | null;

/** The projects these videos sit in, open videos' first, unless read in the last hour. */
async function readProjects(api: TimelinerApi, tasks: Task[], cached: Map<string, NameRow>, now: Date, cap: number): Promise<Map<string, ProjectRead>> {
  const out = new Map<string, ProjectRead>();
  const ordered = [...tasks].sort((a, b) => Number(videoState(a.statusGroup) === 'approved') - Number(videoState(b.statusGroup) === 'approved'));
  const ids = [...new Set(ordered.map((t) => t.projectId).filter((x): x is string => !!x))];
  for (const id of ids) {
    if (out.size >= cap) break;
    const c = cached.get(id);
    if (c && now.getTime() - time(c.synced_at) < PROJECT_REFRESH_MS) continue;
    try {
      const p = await api.project(id);
      const name = typeof p?.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 300) : null;
      out.set(id, p && name ? {
        name, nodeId: typeof p.nodeId === 'string' ? p.nodeId : null,
        subFolders: (Array.isArray(p.subFolders) ? p.subFolders : [])
          .filter((f) => typeof f?.id === 'string' && typeof f.name === 'string' && f.name.trim())
          .map((f) => ({ id: f.id, name: f.name.trim().slice(0, 300) })),
      } : null);
    } catch (err) {
      if (stopLooking(err)) break;
    }
  }
  return out;
}

interface Prev {
  id: string; status_group: string; step_label: string | null; history_group: string | null; updated_at: string | null;
  moved_at: string | null; moved_by: string | null; left_plate_at: string | null;
}

/** A video's last step move is worth reading when it's in a step whose name or time is shown and that changed. */
const needsMove = (t: Task, p: Prev | undefined) => STEP_GROUPS.has(t.statusGroup)
  && (!p || p.history_group !== t.statusGroup || time(p.updated_at) !== time(t.updatedAt));

async function readMoves(api: TimelinerApi, tasks: Task[], prev: Map<string, Prev>, cap: number): Promise<Map<string, Move>> {
  const out = new Map<string, Move>();
  const changedStep = (t: Task) => prev.get(t.id)?.status_group !== t.statusGroup;
  const need = tasks.filter((t) => needsMove(t, prev.get(t.id))).sort((a, b) => Number(changedStep(b)) - Number(changedStep(a)));
  for (const t of need.slice(0, cap)) {
    try {
      out.set(t.id, await api.lastMove(t.id));
    } catch (err) {
      if (stopLooking(err)) break;
    }
  }
  return out;
}

// ── matching a video to the site ─────────────────────────────────────────

interface BatchCand {
  id: number; title: string; client_id: number; client_name: string; timeliner_project_id: string | null;
  shoot_date: string | null; final_due: string | null; approved: number; size: number | null;
}
interface Matching { clients: { id: number; name: string }[]; batches: BatchCand[]; timezone: string }

async function loadMatching(db: Db): Promise<Matching> {
  const clients = await db.query<{ id: number; name: string }>(`select id, name from clients where archived_at is null and status <> 'prospect'`);
  const batches = await db.query<BatchCand>(
    `select b.id, b.title, b.client_id, c.name as client_name, b.timeliner_project_id, sh.start_date::text as shoot_date, b.final_due::text as final_due,
            (select count(*)::int from scripts s where s.batch_id = b.id and s.removed_at is null and s.status in ('approved', 'delivered')) as approved,
            (select max(s.number)::int from scripts s where s.batch_id = b.id and s.removed_at is null) as size
       from batches b join clients c on c.id = b.client_id left join shoots sh on sh.id = b.shoot_id
      order by b.id`,
  );
  return { clients, batches, timezone: (await loadSettings(db)).timezone };
}

/** Words that say nothing about which batch a video is from. */
const GENERIC = new Set(['my', 'video', 'script', 'shoot', 'batch', 'content', 'edit', 'reel', 'final']);
/** "Ads" and "Ad" are the same word here. */
const stem = (w: string) => (w.length >= 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

export interface VideoPlace {
  title: string; projectId: string | null; createdAt: string | null;
  brandName: string | null; projectName: string | null;
  /** the innermost folder: the sub-folder, else the project */
  folderName: string | null;
  folder: string | null;
}

const batchDate = (b: BatchCand) => b.shoot_date ?? b.final_due;

/**
 * Which of these batches a video is cut from: the ones whose title shares the folder's (or the title's) word,
 * like Organic or Ads; then the one whose title or date the folder carries; then one linked to the video's
 * Timeliner project, unless the client has a newer shoot (or final delivery) the video was made after (one
 * project, like "My Videos", can hold many shoots' videos); then the latest shoot (or final delivery) on or
 * before the video was created, else the nearest, a linked batch first among equals.
 */
function chooseBatch(cands: BatchCand[], v: VideoPlace, timezone: string, linked: Set<number>): BatchCand | null {
  if (cands.length <= 1) return cands[0] ?? null;
  const own = new Set(nameWords(cands[0].client_name).map(stem));
  const want = new Set([...nameWords(v.folderName ?? ''), ...nameWords(v.title)].map(stem)
    .filter((w) => !/^\d+$/.test(w) && !own.has(w) && !GENERIC.has(w)));
  const sharing = cands.filter((b) => nameWords(b.title).some((w) => want.has(stem(w))));
  const pool = sharing.length ? sharing : cands;
  if (pool.length === 1) return pool[0];
  const named = pickBatch(pool, [v.folder, v.title].filter(Boolean).join(' '));
  if (named) return pool.find((b) => b.id === named.id) ?? null;
  const created = v.createdAt ? nowInZone(timezone, new Date(v.createdAt)).date : null;
  const linkedFirst = (a: BatchCand, b: BatchCand) => Number(linked.has(b.id)) - Number(linked.has(a.id));
  const byDate = (list: BatchCand[]): BatchCand => {
    const dated = list.flatMap((b) => { const d = batchDate(b); return d ? [{ b, d }] : []; });
    if (created && dated.length) {
      const before = dated.filter((x) => x.d <= created).sort((a, b) => b.d.localeCompare(a.d) || linkedFirst(a.b, b.b));
      if (before.length) return before[0].b;
      return dated.sort((a, b) => Math.abs(diffDays(a.d, created)) - Math.abs(diffDays(b.d, created)) || linkedFirst(a.b, b.b))[0].b;
    }
    return dated.sort((a, b) => b.d.localeCompare(a.d) || linkedFirst(a.b, b.b))[0]?.b ?? list.find((b) => linked.has(b.id)) ?? list[list.length - 1];
  };
  const linkedHere = pool.filter((b) => linked.has(b.id));
  if (linkedHere.length) {
    const l = byDate(linkedHere);
    const since = batchDate(l);
    const newer = since && created ? pool.some((b) => { const d = batchDate(b); return b.id !== l.id && !!d && d > since && d <= created; }) : false;
    if (!newer) return l;
  }
  return byDate(pool);
}

/** The client, batch and script a video is cut from, as far as can be told. */
export function matchVideo(v: VideoPlace, m: Matching): { clientId: number | null; batchId: number | null; scriptNumber: number | null } {
  const linked = v.projectId ? m.batches.filter((b) => b.timeliner_project_id === v.projectId) : [];
  let clientId: number | null = null;
  const linkedClients = [...new Set(linked.map((b) => b.client_id))];
  if (linkedClients.length === 1) clientId = linkedClients[0];
  else {
    // the brand's name, else the project's; two clients that fit equally well: don't guess
    for (const name of [v.brandName, v.projectName]) {
      if (!name) continue;
      const fits = m.clients.map((c) => ({ c, fit: clientFit(c.name, name) })).filter((x) => x.fit > 0).sort((a, b) => b.fit - a.fit);
      if (fits.length === 1 || (fits.length > 1 && fits[0].fit > fits[1].fit)) clientId = fits[0].c.id;
      if (fits.length) break;
    }
  }
  // the client's batches with finished scripts and any linked to the project: the link is a preference, not a fence
  const linkedIds = new Set(linked.map((b) => b.id));
  const cands = clientId != null
    ? m.batches.filter((b) => b.client_id === clientId && (b.approved > 0 || linkedIds.has(b.id)))
    : linked;
  const batch = chooseBatch(cands, v, m.timezone, linkedIds);
  const num = titleNumber(v.title);
  return {
    clientId: clientId ?? batch?.client_id ?? null,
    batchId: batch?.id ?? null,
    scriptNumber: batch && num != null && num >= 1 && batch.size != null && num <= batch.size ? num : null,
  };
}

// ── keeping the copy ─────────────────────────────────────────────────────

interface Row {
  id: string; title: string; status_group: string; step_label: string | null; history_group: string | null;
  project_id: string | null; brand_id: string | null; sub_folder_id: string | null; folder: string | null;
  assignee_ids: string[]; internal_deadline: string | null; external_deadline: string | null;
  internal_revisions: number; client_revisions: number; created_at: string | null; updated_at: string | null;
  moved_at: string | null; moved_by: string | null; left_plate_at: string | null;
  client_id: number | null; batch_id: number | null; script_number: number | null;
}
const COLS: (keyof Row)[] = [
  'id', 'title', 'status_group', 'step_label', 'history_group', 'project_id', 'brand_id', 'sub_folder_id', 'folder',
  'assignee_ids', 'internal_deadline', 'external_deadline', 'internal_revisions', 'client_revisions', 'created_at', 'updated_at',
  'moved_at', 'moved_by', 'left_plate_at', 'client_id', 'batch_id', 'script_number',
];

async function loadPrev(db: Db, ids?: string[]): Promise<Map<string, Prev>> {
  const rows = await db.query<Prev>(
    `select id, status_group, step_label, history_group, updated_at, moved_at, moved_by, left_plate_at from timeliner_tasks
      where $1::text[] is null or id = any($1::text[])`, [ids ?? null],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

async function loadNames(db: Db): Promise<Map<string, NameRow>> {
  return new Map((await db.query<NameRow>(`select id, kind, name, parent_id, synced_at from timeliner_names`)).map((r) => [r.id, r]));
}

/** One video's row: Timeliner's fields, its step as last read, when it left the editor's plate, and what it matched. */
function buildRow(t: Task, p: Prev | undefined, move: Move | undefined, names: Map<string, { name: string }>, m: Matching, now: Date): Row {
  const group = t.statusGroup;
  const state = videoState(group);
  let step: string | null = null;
  let historyGroup: string | null = STEP_GROUPS.has(group) ? null : group;
  let movedAt: string | null = null;
  let movedBy: string | null = null;
  if (move !== undefined) {
    step = move?.to ?? null; movedAt = move?.at ? iso(move.at) : null; movedBy = move?.byId ?? null; historyGroup = group;
  } else if (p && p.status_group === group) {
    // same step group as before: keep what was read, and read it again next time if it may have changed
    step = p.step_label; movedAt = p.moved_at; movedBy = p.moved_by; historyGroup = needsMove(t, p) ? null : p.history_group;
  }
  if (state === 'approved') movedAt = iso(t.approvedAt) ?? movedAt ?? iso(t.updatedAt);

  // when it left the plate (sent to review or further): the move seen now, else, for a video first seen in review, its move there
  let left = p?.left_plate_at ?? null;
  if (!isOnPlate(state)) {
    if (p && isOnPlate(videoState(p.status_group))) left = movedAt ?? now.toISOString();
    else if (!left && state === 'in_review') left = movedAt;
  }

  const projectName = t.projectId ? names.get(t.projectId)?.name ?? null : null;
  const subName = t.subFolderId ? names.get(t.subFolderId)?.name ?? null : null;
  const folder = [projectName, subName].filter(Boolean).join(' › ') || null;
  const where = matchVideo({
    title: t.title, projectId: t.projectId ?? null, createdAt: t.createdAt ?? null,
    brandName: t.brandId ? names.get(t.brandId)?.name ?? null : null, projectName, folderName: subName ?? projectName, folder,
  }, m);
  return {
    id: t.id, title: t.title || 'Untitled video', status_group: group, step_label: step, history_group: historyGroup,
    project_id: t.projectId ?? null, brand_id: t.brandId ?? null, sub_folder_id: t.subFolderId ?? null, folder,
    assignee_ids: [...new Set(t.assigneeIds)], internal_deadline: t.internalDeadline ?? null, external_deadline: t.externalDeadline ?? null,
    internal_revisions: t.internalRevisions, client_revisions: t.clientRevisions,
    created_at: iso(t.createdAt), updated_at: iso(t.updatedAt), moved_at: movedAt, moved_by: movedBy, left_plate_at: left,
    client_id: where.clientId, batch_id: where.batchId, script_number: where.scriptNumber,
  };
}

/** What a read (or one webhook message) found, ready to write. */
interface Found {
  rows: Row[];
  /** task ids to remove: trashed, archived, documents, long finished, or gone */
  drop: string[];
  /** every task was read, so tasks not in `rows` are gone from Timeliner */
  complete: boolean;
  /** a read that stopped early reached back to videos created then: newer tasks not in `rows` are gone */
  listedFrom?: string | null;
  members?: Awaited<ReturnType<TimelinerApi['members']>>;
  brands?: { id: string; name: string }[];
  projects: Map<string, ProjectRead>;
  /** rows written by something newer than this (a webhook during a read) are left alone */
  readSince: string;
  at: Date;
  /** a full read: recorded as the last time Timeliner was read, clearing any error */
  fullRead?: boolean;
}

const memberName = (x: { email: string; firstName: string | null; lastName: string | null }) =>
  [x.firstName, x.lastName].filter((p) => typeof p === 'string' && p.trim()).join(' ').trim() || x.email || null;

/** Inserts rows 100 at a time; `tail` follows the values (an on-conflict clause), its `tailParams` numbered from `next`. */
async function insertRows(
  t: Db, table: string, cols: string[], rows: unknown[][],
  opts: { tail?: (next: number) => string; tailParams?: unknown[]; casts?: Record<string, string> } = {},
): Promise<void> {
  for (let i = 0; i < rows.length; i += 100) {
    const params: unknown[] = [];
    const values = rows.slice(i, i + 100).map((r) => `(${r.map((v, k) => { params.push(v); return `$${params.length}${opts.casts?.[cols[k]] ?? ''}`; }).join(', ')})`);
    await t.query(`insert into ${table} (${cols.join(', ')}) values ${values.join(', ')} ${opts.tail?.(params.length + 1) ?? ''}`, [...params, ...(opts.tailParams ?? [])]);
  }
}

async function write(db: Db, f: Found): Promise<void> {
  const at = f.at.toISOString();
  await db.tx(async (t) => {
    await t.query(`select pg_advisory_xact_lock(${LOCKS.timeliner})`);
    if (f.members) {
      await t.query(`delete from timeliner_members`);
      const byId = new Map(f.members.filter((x) => typeof x?.id === 'string').map((x) => [x.id, x]));
      const rows = [...byId.values()].map((x) => [
        x.id, typeof x.email === 'string' ? x.email.trim().slice(0, 300) : null, memberName(x)?.slice(0, 200) ?? null,
        typeof x.role === 'string' ? x.role.slice(0, 40) : null, x.deactivated !== true, at,
      ]);
      await insertRows(t, 'timeliner_members', ['id', 'email', 'name', 'role', 'active', 'synced_at'], rows);
    }
    const names: unknown[][] = [];
    for (const b of f.brands ?? []) if (typeof b?.id === 'string' && typeof b.name === 'string' && b.name.trim()) names.push([b.id, 'brand', b.name.trim().slice(0, 300), null, at]);
    for (const [id, p] of f.projects) {
      if (!p) continue;
      names.push([id, 'project', p.name, p.nodeId, at]);
      await t.query(`delete from timeliner_names where kind = 'subfolder' and parent_id = $1`, [id]);
      for (const s of p.subFolders) names.push([s.id, 'subfolder', s.name, id, at]);
    }
    const unique = [...new Map(names.map((n) => [n[0], n])).values()];
    await insertRows(t, 'timeliner_names', ['id', 'kind', 'name', 'parent_id', 'synced_at'], unique, {
      tail: () => `on conflict (id) do update set kind = excluded.kind, name = excluded.name, parent_id = excluded.parent_id, synced_at = excluded.synced_at`,
    });

    // what's gone: what was dropped (unless something newer wrote it since) and, after a read, what it no longer
    // lists (all of it after a complete read; after one that stopped early, only within the stretch it read)
    const listed = f.rows.map((r) => r.id);
    if (f.drop.length) await t.query(`delete from timeliner_tasks where id = any($1::text[]) and synced_at <= $2`, [f.drop, f.readSince]);
    const vanished = f.complete || f.listedFrom ? (await t.query<{ id: string }>(
      `delete from timeliner_tasks where not (id = any($1::text[])) and synced_at <= $2 and ($3::timestamptz is null or created_at > $3) returning id`,
      [listed, f.readSince, f.complete ? null : f.listedFrom],
    )).map((r) => r.id) : [];
    // remembered for a day, so a read that began before now doesn't write them back
    const gone = [...new Set([...f.drop, ...vanished])];
    if (gone.length) {
      await t.query(
        `insert into timeliner_removed (id, removed_at) select x, $2::timestamptz from unnest($1::text[]) as x where not exists (select 1 from timeliner_tasks tt where tt.id = x)
         on conflict (id) do update set removed_at = greatest(timeliner_removed.removed_at, excluded.removed_at)`, [gone, at],
      );
    }
    await t.query(`delete from timeliner_removed where removed_at < $1`, [new Date(f.at.getTime() - DAY_MS).toISOString()]);
    const removedSince = listed.length
      ? new Set((await t.query<{ id: string }>(`select id from timeliner_removed where id = any($1::text[]) and removed_at > $2`, [listed, f.readSince])).map((r) => r.id))
      : new Set<string>();
    const rows = f.rows.filter((r) => !removedSince.has(r.id));
    const cols = [...COLS, 'synced_at'];
    await insertRows(t, 'timeliner_tasks', cols, rows.map((r) => [...COLS.map((c) => r[c]), at]), {
      casts: { assignee_ids: '::text[]' },
      tail: (n) => `on conflict (id) do update set ${cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')} where timeliner_tasks.synced_at <= $${n}`,
      tailParams: [f.readSince],
    });
    await endLeftFocus(t);
    if (f.fullRead) await t.query(`update settings set timeliner_synced_at = $1, timeliner_sync_error = null where id = 1`, [at]);
  });
}

/** Focuses whose video is gone, given to someone else, or no longer on the editor's plate end by themselves. */
async function endLeftFocus(t: Db): Promise<void> {
  const rows = await t.query<{ user_id: number; task_id: string; status_group: string | null; theirs: boolean }>(
    `select f.user_id, f.task_id, tt.status_group,
            exists (select 1 from timeliner_members m join users u on lower(u.email) = lower(m.email)
                     where u.id = f.user_id and m.id = any(tt.assignee_ids)) as theirs
       from editor_focus f left join timeliner_tasks tt on tt.id = f.task_id`,
  );
  for (const r of rows) {
    if (r.status_group && r.theirs && isOnPlate(videoState(r.status_group))) continue;
    await t.query(`delete from editor_focus where user_id = $1 and task_id = $2`, [r.user_id, r.task_id]);
  }
}

export interface SyncResult { ok: boolean; error: string | null; videos: number; complete: boolean }

/**
 * Reads Timeliner and replaces the copy: members, brands, the videos (newest first, up to a cap; long-finished
 * ones aren't kept), the projects open videos sit in, and the last step move of videos whose step changed.
 * When Timeliner can't be read the copy stays as it was and the error is kept to show.
 */
export async function syncTimeliner(db: Db, api: TimelinerApi, now: Date): Promise<SyncResult> {
  try {
    const members = await api.members();
    const brands = await readPages((b) => api.brands(b), BRAND_PAGES);
    const listed = await readPages((b) => api.tasks(b), TASK_PAGES);
    const keep = new Map<string, Task>();
    const drop: string[] = [];
    // the oldest video the list reached (it's newest first): a read that stops early covers only what's newer
    let listedFrom: string | null = null;
    for (const raw of listed.items) {
      const t = readTask(raw);
      if (!t) continue;
      const created = iso(t.createdAt);
      if (created && (!listedFrom || created < listedFrom)) listedFrom = created;
      if (skipReason(t, now)) drop.push(t.id);
      else keep.set(t.id, t);
    }
    const tasks = [...keep.values()];
    const prev = await loadPrev(db);
    const cached = await loadNames(db);
    const projects = await readProjects(api, tasks, cached, now, PROJECTS_PER_READ);
    const moves = await readMoves(api, tasks, prev, MOVES_PER_READ);
    const names = new Map<string, { name: string }>(cached);
    for (const b of brands.items) if (typeof b?.id === 'string' && typeof b.name === 'string') names.set(b.id, { name: b.name.trim() });
    for (const [id, p] of projects) if (p) { names.set(id, p); for (const s of p.subFolders) names.set(s.id, s); }
    const matching = await loadMatching(db);
    const rows = tasks.map((t) => buildRow(t, prev.get(t.id), moves.get(t.id), names, matching, now));
    await write(db, { rows, drop, complete: listed.complete, listedFrom, members, brands: brands.items, projects, readSince: now.toISOString(), at: now, fullRead: true });
    return { ok: true, error: null, videos: rows.length, complete: listed.complete };
  } catch (err) {
    const message = err instanceof TimelinerError ? err.message : 'Something went wrong reading Timeliner. It tries again in a few minutes.';
    // the copy stays as it was; the page says why it's not fresh
    await db.query(`update settings set timeliner_sync_error = $1 where id = 1`, [message.slice(0, 500)]).catch(() => {});
    if (!(err instanceof TimelinerError)) throw err;
    return { ok: false, error: message, videos: 0, complete: false };
  }
}

/**
 * A task message from Timeliner's webhook: that one video is read again (or removed) straight away, and a focus
 * on it ends if it left the editor's plate; a trashed project takes its videos with it. Returns what happened,
 * for the message log. Timeliner refusing or failing to give the video back isn't an error here: the message
 * is still answered (a failed delivery is retried for hours and then switches off the whole webhook, uploads
 * included), and the timed read picks the change up.
 */
export async function applyTaskMessage(ctx: Ctx, api: TimelinerApi | null, m: { type: string; taskId: string | null; projectId?: string | null }): Promise<string> {
  const { db } = ctx;
  const now = ctx.now();
  const base = { complete: false, projects: new Map<string, ProjectRead>(), readSince: now.toISOString(), at: now };
  if (m.type === 'project.trashed') {
    if (!m.projectId) return 'A project message without a project';
    const gone = (await db.query<{ id: string }>(`select id from timeliner_tasks where project_id = $1`, [m.projectId])).map((r) => r.id);
    if (gone.length) await write(db, { ...base, rows: [], drop: gone });
    return `A project was trashed: ${gone.length} video${gone.length === 1 ? '' : 's'} removed`;
  }
  if (!m.taskId) return 'A video message without a video';
  if (m.type === 'task.trashed') {
    await write(db, { ...base, rows: [], drop: [m.taskId] });
    return 'A video was trashed';
  }
  if (!api) return 'A video changed (no key to read it)';
  let raw: unknown;
  try {
    raw = await api.task(m.taskId);
  } catch (err) {
    if (!(err instanceof TimelinerError)) throw err;
    return `Couldn’t read the video from Timeliner, so the next timed read picks it up: ${err.message}`;
  }
  const t = readTask(raw);
  const skip = t ? skipReason(t, now) : 'it’s gone from Timeliner';
  if (!t || skip) {
    await write(db, { ...base, rows: [], drop: [m.taskId] });
    return `Video removed: ${skip}`;
  }
  const cached = await loadNames(db);
  const names = new Map<string, { name: string }>(cached);
  const projects = await readProjects(api, [t], cached, now, 1);
  for (const [id, p] of projects) if (p) { names.set(id, p); for (const s of p.subFolders) names.set(s.id, s); }
  let brands: { id: string; name: string }[] | undefined;
  if (t.brandId && !names.has(t.brandId)) {
    const b = await api.brand(t.brandId).catch(() => null);
    if (b && typeof b.name === 'string') { brands = [b]; names.set(b.id, { name: b.name.trim() }); }
  }
  const prev = await loadPrev(db, [t.id]);
  const moves = await readMoves(api, [t], prev, 1);
  const row = buildRow(t, prev.get(t.id), moves.get(t.id), names, await loadMatching(db), now);
  await write(db, { ...base, rows: [row], drop: [], brands, projects });
  return `Video “${row.title}”: ${row.step_label ?? stepLabel(row.status_group)}`;
}

/** Re-reads Timeliner every `minutes` (the real workspace, never a practice copy). */
export function startTimelinerSync(ctx: Ctx, minutes: number, log: (m: string) => void): () => void {
  let running = false;
  let lastError: string | null = null;
  const tick = async () => {
    if (running || !ctx.timeliner) return;
    running = true;
    try {
      const r = await syncTimeliner(ctx.realDb ?? ctx.db, ctx.timeliner, ctx.now());
      if (r.error && r.error !== lastError) log(`timeliner: couldn't read the videos: ${r.error}`);
      lastError = r.error;
    } catch (err) {
      log(`timeliner: reading the videos failed: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };
  // tick handles its own errors, so the timers never see a rejected promise
  const first = setTimeout(() => void tick(), 15_000);
  const every = setInterval(() => void tick(), minutes * 60_000);
  return () => { clearTimeout(first); clearInterval(every); };
}

// ── the Editors tab and an editor's Home ─────────────────────────────────

interface TaskRow extends Row { synced_at: string }
interface FocusRow { user_id: number; task_id: string; state: 'on' | 'paused'; since: string; worked_seconds: number; paused_at: string | null }
interface DoneRow { task_id: string; user_id: number; done_at: string }

const stepLabel = (group: string) => TIMELINER_STEP_LABEL[group as TimelinerStatusGroup] ?? 'To be edited';
const titleOrder = (title: string) => titleNumber(title) ?? Number.MAX_SAFE_INTEGER;
const byDue = (a: EditingVideo, b: EditingVideo) =>
  (a.due ?? '9999-12-31').localeCompare(b.due ?? '9999-12-31') || titleOrder(a.title) - titleOrder(b.title) || a.title.localeCompare(b.title);
const STATE_ORDER: Record<VideoState, number> = { revisions: 0, to_edit: 1, in_review: 2, with_client: 3, approved: 4 };
const newest = (a: string | null, b: string | null) => time(b) - time(a) || 0;

/**
 * The script document a video is cut from, for a finished script only: the edited version a manager last approved
 * it with, else the newest document it was sent in, when an editor can open it.
 */
function scriptDoc(L: Loaded, batchId: number, n: number): ScriptDoc | null {
  const inBatch = L.docs.filter((x) => x.batchId === batchId);
  const d = inBatch.find((x) => x.scripts.some((s) => s.number === n));
  const s = d?.scripts.find((x) => x.number === n);
  // editors only ever cut from a finished script
  if (!d || !s || !isApproved(s.status)) return null;
  const e = L.edits.get(s.id);
  if (e) {
    // the batch's finished scripts last approved with that same version
    const covers = inBatch.flatMap((x) => x.scripts).filter((x) => isApproved(x.status) && L.edits.get(x.id) === e).map((x) => x.number);
    return { href: e.href, name: e.name, edited: true, ranges: compressRanges(covers), batchId, batchTitle: d.batchTitle };
  }
  // a link always opens; an uploaded file, as /api/files/:id serves editors (every script ever sent in it finished)
  if (!d.href || d.kind === 'none' || (d.kind === 'file' && !L.openable.has(d.href))) return null;
  return { href: d.href, name: d.name, edited: false, ranges: d.ranges, batchId, batchTitle: d.batchTitle };
}

interface Loaded {
  sync: EditingSync;
  tasks: TaskRow[];
  users: UserSummary[];
  /** member id → the site user with that email */
  userOf: Map<string, number>;
  members: Map<string, { name: string | null; email: string | null }>;
  focus: Map<number, FocusRow>;
  done: DoneRow[];
  /** `${taskId}|${userId}` → when they marked it done here */
  doneAt: Map<string, string>;
  clients: Map<number, string>;
  batches: Map<number, { title: string; shootDate: ISODate | null }>;
  docs: Deliverable[];
  /** script id → the edited version a manager last approved it with */
  edits: Map<number, ScriptEdit>;
  /** links to the batches' uploaded documents that editors can open */
  openable: Set<string>;
  today: ISODate;
  now: Date;
}

async function loadEditing(ctx: Ctx): Promise<Loaded> {
  const { db } = ctx;
  const settings = await loadSettings(db);
  const s = await db.one<{ synced_at: string | null; error: string | null }>(`select timeliner_synced_at as synced_at, timeliner_sync_error as error from settings where id = 1`);
  const tasks = await db.query<TaskRow>(`select * from timeliner_tasks order by id`);
  const members = await db.query<{ id: string; email: string | null; name: string | null }>(`select id, email, name from timeliner_members`);
  const users = (await loadUsers(db)).filter((u) => u.active);
  const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), u.id]));
  const userOf = new Map<string, number>();
  for (const m of members) { const u = m.email ? byEmail.get(m.email.toLowerCase()) : undefined; if (u) userOf.set(m.id, u); }
  const batchIds = [...new Set(tasks.map((t) => t.batch_id).filter((x): x is number => x != null))];
  const batches = batchIds.length ? await db.query<{ id: number; title: string; shoot_date: string | null }>(
    `select b.id, b.title, sh.start_date::text as shoot_date from batches b left join shoots sh on sh.id = b.shoot_id where b.id = any($1::bigint[])`, [batchIds],
  ) : [];
  const done = (await db.query<DoneRow>(`select task_id, user_id, done_at from editing_done`)).map((d) => ({ ...d, user_id: Number(d.user_id) }));
  const openable = batchIds.length ? await db.query<{ id: number }>(
    `select f.id from files f where f.id in (select s.file_id from submissions s where s.batch_id = any($1::bigint[])) and ${EDITOR_FILES}`, [batchIds],
  ) : [];
  const now = ctx.now();
  return {
    sync: { keySet: !!ctx.timeliner, syncedAt: iso(s?.synced_at), error: s?.error ?? null },
    tasks, users, userOf,
    members: new Map(members.map((m) => [m.id, { name: m.name, email: m.email }])),
    focus: new Map((await db.query<FocusRow>(`select user_id, task_id, state, since, worked_seconds, paused_at from editor_focus`)).map((f) => [Number(f.user_id), f])),
    done, doneAt: new Map(done.map((d) => [`${d.task_id}|${d.user_id}`, d.done_at])),
    clients: new Map((await db.query<{ id: number; name: string }>(`select id, name from clients`)).map((c) => [Number(c.id), c.name])),
    batches: new Map(batches.map((b) => [Number(b.id), { title: b.title, shootDate: b.shoot_date }])),
    docs: await loadDeliverables(db, { batchIds }),
    edits: await loadScriptEdits(db, { batchIds }),
    // built as the Script bank builds a document's link
    openable: new Set(openable.map((f) => `/api/files/${f.id}`)),
    today: makeClock(settings.timezone, settings.cutoff, now).today,
    now,
  };
}

/** A done mark counts until Timeliner moves the video on (or back, after it was marked). */
const markHolds = (doneAt: string, t: Pick<Row, 'left_plate_at' | 'moved_at'>) => time(doneAt) > Math.max(time(t.left_plate_at) || 0, time(t.moved_at) || 0);

const assignedTo = (L: Loaded, t: TaskRow, userId: number) => t.assignee_ids.some((m) => L.userOf.get(m) === userId);

/** A video as one person sees it (`userId` decides whether they marked it done here). */
function toVideo(L: Loaded, t: TaskRow, userId: number | null): EditingVideo {
  const state = videoState(t.status_group);
  const mark = userId == null ? undefined : L.doneAt.get(`${t.id}|${userId}`);
  const doneAt = mark && isOnPlate(state) && markHolds(mark, t) ? iso(mark) : null;
  const batch = t.batch_id != null ? L.batches.get(Number(t.batch_id)) : undefined;
  return {
    id: t.id, title: t.title, state,
    step: t.step_label ?? stepLabel(t.status_group),
    folder: t.folder,
    client: t.client_id != null && L.clients.has(Number(t.client_id)) ? { id: Number(t.client_id), name: L.clients.get(Number(t.client_id))! } : null,
    batch: batch && t.batch_id != null ? { id: Number(t.batch_id), title: batch.title, shootDate: batch.shootDate } : null,
    scriptNumber: t.script_number,
    script: t.batch_id != null && t.script_number != null ? scriptDoc(L, Number(t.batch_id), t.script_number) : null,
    due: t.internal_deadline ?? t.external_deadline,
    revisionRound: t.internal_revisions + t.client_revisions,
    movedAt: iso(t.moved_at),
    doneAt,
  };
}

/** Everything about one person's videos: the Editors tab's card and their own Home are both made from it. */
function editorOf(L: Loaded, u: UserSummary): { row: EditorRow; mine: MyEditing } {
  const weekAgo = L.now.getTime() - 7 * DAY_MS;
  const own = L.tasks.filter((t) => assignedTo(L, t, u.id));
  const videos = own.map((t) => toVideo(L, t, u.id));
  const open = videos.filter((v) => v.state !== 'approved');
  const approvedWeek = videos.filter((v) => v.state === 'approved' && time(v.movedAt) >= weekAgo).sort((a, b) => newest(a.movedAt, b.movedAt));
  const plate = open.filter((v) => isOnPlate(v.state) && !v.doneAt);

  const f = L.focus.get(u.id);
  const fv = f ? open.find((v) => v.id === f.task_id && isOnPlate(v.state)) : undefined;
  const focus: EditorFocus | null = f && fv
    ? { video: fv, state: f.state, since: iso(f.since)!, workedSeconds: Number(f.worked_seconds), pausedAt: iso(f.paused_at) }
    : null;
  const revisions = plate.filter((v) => v.state === 'revisions').sort(byDue);
  const toEdit = plate.filter((v) => v.state === 'to_edit').sort(byDue);
  // what's next by deadline: revisions first (they're already late in someone's eyes), never the one they're on
  const nextUp = [...revisions, ...toEdit].find((v) => v.id !== focus?.video.id) ?? null;
  const waiting = open.filter((v) => v.doneAt || !isOnPlate(v.state))
    .sort((a, b) => Number(!!b.doneAt) - Number(!!a.doneAt) || STATE_ORDER[a.state] - STATE_ORDER[b.state] || newest(a.doneAt ?? a.movedAt, b.doneAt ?? b.movedAt));

  const docs = new Map<string, ScriptDoc>();
  for (const v of [...(focus ? [focus.video] : []), ...revisions, ...toEdit]) if (v.script && !docs.has(v.script.href)) docs.set(v.script.href, v.script);
  const scripts = [...docs.values()];

  // the last video that left their plate: marked done here, or moved on in Timeliner
  const titles = new Map(own.map((t) => [t.id, t.title]));
  const finished = [
    ...L.done.filter((d) => d.user_id === u.id && titles.has(d.task_id)).map((d) => ({ title: titles.get(d.task_id)!, at: iso(d.done_at)!, onSite: true })),
    ...own.filter((t) => !isOnPlate(videoState(t.status_group)) && t.left_plate_at).map((t) => ({ title: t.title, at: iso(t.left_plate_at)!, onSite: false })),
  ].sort((a, b) => newest(a.at, b.at));

  const plateCounts: EditorPlate = {
    toEdit: toEdit.length,
    revisions: revisions.length,
    // marked done here: waiting on the managers, like the ones Timeliner has in review
    inReview: open.filter((v) => v.state === 'in_review' || v.doneAt).length,
    withClient: open.filter((v) => v.state === 'with_client').length,
    approvedWeek: approvedWeek.length,
  };
  const row: EditorRow = {
    userId: u.id, name: u.name, city: u.city, timezone: u.timezone, workHours: u.workHours,
    offHours: !!(u.workHours && u.timezone && isValidTimeZone(u.timezone)) && !onShift(u.workHours!, u.timezone!, L.now),
    focus, nextUp, plate: plateCounts,
    dueToday: plate.filter((v) => v.due && v.due <= L.today).length,
    lastFinished: finished[0] ?? null,
    scripts,
    videos: [...open, ...approvedWeek].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || byDue(a, b)),
  };
  return { row, mine: { sync: L.sync, focus, nextUp, revisions, toEdit, waiting, approvedWeek, scripts } };
}

/** On a video and editing now (not one left running: isFocusStale) */
const editingNow = (e: EditorRow, now: Date) => e.focus?.state === 'on' && !isFocusStale(e.focus, e.offHours, now.getTime());

/** Editing now → paused (or left running) → due today → revisions → the rest; off hours last (unless they're editing now). */
const rank = (e: EditorRow, now: Date) => (editingNow(e, now) ? 0 : e.offHours ? 5 : e.focus ? 1 : e.dueToday ? 2 : e.plate.revisions ? 3 : 4);

export async function loadBoard(ctx: Ctx): Promise<EditingBoard> {
  const L = await loadEditing(ctx);
  const withVideos = new Set<number>();
  for (const t of L.tasks) {
    if (videoState(t.status_group) === 'approved') continue;
    for (const m of t.assignee_ids) { const u = L.userOf.get(m); if (u) withVideos.add(u); }
  }
  // editors who sign in, and anyone else on the team with open videos in Timeliner
  const roster = L.users.filter((u) => isEditor(u.role) || withVideos.has(u.id));
  const built = roster.map((u) => editorOf(L, u));
  const editors = built.map((b) => b.row).sort((a, b) => rank(a, L.now) - rank(b, L.now) || a.name.localeCompare(b.name));

  // waiting on the managers: in review in Timeliner, or marked done here and not moved yet
  const waiting = new Set(L.tasks.filter((t) => videoState(t.status_group) === 'in_review').map((t) => t.id));
  for (const b of built) for (const v of b.mine.waiting) if (v.doneAt) waiting.add(v.id);

  const recent = L.now.getTime() - NOT_ASSIGNED_DAYS * DAY_MS;
  const groups = new Map<string, { folder: string; clientName: string | null; titles: string[]; due: ISODate | null; docs: Map<string, ScriptDoc> }>();
  for (const t of L.tasks) {
    if (videoState(t.status_group) !== 'to_edit' || t.assignee_ids.length || (t.created_at && time(t.created_at) < recent)) continue;
    const clientName = t.client_id != null ? L.clients.get(Number(t.client_id)) ?? null : null;
    const key = `${t.folder ?? ''}|${t.client_id ?? ''}`;
    const g = groups.get(key) ?? { folder: t.folder ?? clientName ?? 'Timeliner', clientName, titles: [], due: null, docs: new Map<string, ScriptDoc>() };
    g.titles.push(t.title);
    const due = t.internal_deadline ?? t.external_deadline;
    if (due && (!g.due || due < g.due)) g.due = due;
    // the document whoever is given it will cut from, as the editors' cards show it
    const doc = t.batch_id != null && t.script_number != null ? scriptDoc(L, Number(t.batch_id), t.script_number) : null;
    if (doc && !g.docs.has(doc.href)) g.docs.set(doc.href, doc);
    groups.set(key, g);
  }
  const unassigned = [...groups.values()]
    .map((g) => ({
      folder: g.folder, clientName: g.clientName, count: g.titles.length, titles: compressTitles(g.titles), due: g.due,
      videoTitles: [...g.titles].sort((a, b) => titleOrder(a) - titleOrder(b) || a.localeCompare(b)),
      scripts: [...g.docs.values()],
    }))
    .sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.folder.localeCompare(b.folder));

  const unknown = new Map<string, { name: string; email: string | null; count: number }>();
  for (const t of L.tasks) {
    if (videoState(t.status_group) === 'approved') continue;
    for (const m of t.assignee_ids) {
      if (L.userOf.has(m)) continue;
      const who = L.members.get(m);
      const u = unknown.get(m) ?? { name: who?.name ?? who?.email ?? 'Someone in Timeliner', email: who?.email ?? null, count: 0 };
      u.count++;
      unknown.set(m, u);
    }
  }

  return {
    sync: L.sync,
    totals: {
      editingNow: editors.filter((e) => editingNow(e, L.now)).length,
      paused: editors.filter((e) => e.focus?.state === 'paused').length,
      dueToday: editors.reduce((n, e) => n + e.dueToday, 0),
      revisions: editors.reduce((n, e) => n + e.plate.revisions, 0),
      waitingOnYou: waiting.size,
      notAssigned: unassigned.reduce((n, g) => n + g.count, 0),
    },
    editors,
    unassigned,
    unknownAssignees: [...unknown.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  };
}

export async function loadMine(ctx: Ctx, me: Me): Promise<MyEditing> {
  const L = await loadEditing(ctx);
  const u = L.users.find((x) => x.id === me.id)
    ?? { id: me.id, name: me.name, email: me.email, role: me.role, active: true, removed: false, capacityPerDay: null, tempPassword: null, city: null, timezone: null, workHours: null };
  return editorOf(L, u).mine;
}

// ── what an editor is on ─────────────────────────────────────────────────

/**
 * I'm on this (start), Pause, Resume and Done, for the signed-in person's own videos. Start replaces whatever
 * they were on (that one just ends). Done records the mark, ends the focus and tells the managers; Timeliner
 * is never changed.
 */
export async function applyFocus(ctx: Ctx, me: Me, videoId: string, action: FocusAction): Promise<void> {
  const at = ctx.now();
  await ctx.db.tx(async (t) => {
    // the person's own row first, so two requests of theirs (two tabs, a retry) take turns even before there's a
    // focus row to lock, and two Dones can't both pass the check below
    await t.query(`select 1 from users where id = $1 for no key update`, [me.id]);
    const focus = await t.one<FocusRow>(`select user_id, task_id, state, since, worked_seconds, paused_at from editor_focus where user_id = $1 for update`, [me.id]);
    const task = await t.one<TaskRow>(`select * from timeliner_tasks where id = $1`, [videoId]);
    if (!task) throw notFound('Video');
    const theirs = await t.one(`select 1 from timeliner_members where lower(email) = lower($1) and id = any($2::text[])`, [me.email, task.assignee_ids]);
    if (!theirs) throw forbidden('That video isn’t assigned to you in Timeliner.');
    const state = videoState(task.status_group);
    const onIt = focus?.task_id === videoId ? focus : null;
    const step = task.step_label ?? stepLabel(task.status_group);

    if (action === 'start') {
      if (!isOnPlate(state)) throw conflict(`“${task.title}” is already at ${step} in Timeliner, so there’s nothing to start.`);
      if (onIt?.state === 'on') throw conflict('You’re already on this video.');
      if (onIt?.state === 'paused') throw conflict('This video is paused. Resume it to carry on.');
      await t.query(
        `insert into editor_focus (user_id, task_id, state, since, worked_seconds, paused_at, updated_at) values ($1, $2, 'on', $3, 0, null, $3)
         on conflict (user_id) do update set task_id = excluded.task_id, state = 'on', since = excluded.since, worked_seconds = 0, paused_at = null, updated_at = excluded.updated_at`,
        [me.id, videoId, at.toISOString()],
      );
      // back on a video they'd marked done: it isn't done after all
      await t.query(`delete from editing_done where task_id = $1 and user_id = $2`, [videoId, me.id]);
      return;
    }
    if (action === 'pause') {
      if (onIt?.state !== 'on') throw conflict('You can pause only the video you’re on.');
      const worked = Number(onIt.worked_seconds) + Math.max(0, Math.round((at.getTime() - time(onIt.since)) / 1000));
      await t.query(`update editor_focus set state = 'paused', worked_seconds = $2, paused_at = $3, updated_at = $3 where user_id = $1`, [me.id, worked, at.toISOString()]);
      return;
    }
    if (action === 'resume') {
      if (onIt?.state !== 'paused') throw conflict('Only a paused video can be resumed.');
      if (!isOnPlate(state)) throw conflict(`“${task.title}” has moved on to ${step} in Timeliner, so there’s nothing to resume.`);
      await t.query(`update editor_focus set state = 'on', since = $2, paused_at = null, updated_at = $2 where user_id = $1`, [me.id, at.toISOString()]);
      return;
    }

    // done: the video they're on (on or paused), or any of theirs still on their plate
    if (!onIt) {
      if (!isOnPlate(state)) throw conflict(`“${task.title}” is already at ${step} in Timeliner.`);
      const mark = await t.one<{ done_at: string }>(`select done_at from editing_done where task_id = $1 and user_id = $2`, [videoId, me.id]);
      if (mark && markHolds(mark.done_at, task)) throw conflict('You’ve already marked this video done.');
    }
    const worked = onIt ? Number(onIt.worked_seconds) + (onIt.state === 'on' ? Math.max(0, Math.round((at.getTime() - time(onIt.since)) / 1000)) : 0) : null;
    await t.query(
      `insert into editing_done (task_id, user_id, done_at) values ($1, $2, $3) on conflict (task_id, user_id) do update set done_at = excluded.done_at`,
      [videoId, me.id, at.toISOString()],
    );
    if (onIt) await t.query(`delete from editor_focus where user_id = $1`, [me.id]);
    const took = worked ? ` after ${fmtWorked(worked)}` : '';
    // one notification per video and editor: marking it done again brings that one back up rather than adding another
    await notify(t, await managerIds(t), {
      type: 'review_request',
      title: `${me.name} finished ${task.title}`,
      body: `Marked done on the site${took}. It moves on here when it’s in Needs review in Timeliner.`,
      link: '/editors',
      dedupeKey: `video-done:${videoId}:${me.id}`,
      refresh: true,
    }, me.id);
    await logActivity(t, {
      actor: me, action: 'video.done', entityType: 'video', batchId: task.batch_id, clientId: task.client_id,
      summary: `Marked the video “${task.title}” done${took}`,
      detail: { taskId: videoId, workedSeconds: worked },
    });
  });
}

// ── routes ───────────────────────────────────────────────────────────────

export function registerEditingRoutes(app: FastifyInstance, ctx: Ctx) {
  // the managers' Editors tab
  app.get('/api/editing', async (req): Promise<EditingBoard> => {
    requireManager(req);
    return loadBoard(ctx);
  });

  // "Read Timeliner now": what went wrong, if anything, comes back in the board's sync.error
  app.post('/api/editing/sync', async (req): Promise<EditingBoard> => {
    requireManager(req);
    if (!ctx.timeliner) throw new HttpError(400, 'Add TIMELINER_API_KEY to the server’s environment first (Timeliner → Settings → Developers). A read-only key is enough to read the videos.');
    await syncTimeliner(ctx.db, ctx.timeliner, ctx.now());
    return loadBoard(ctx);
  });

  // an editor's own videos, matched by their email in Timeliner
  app.get('/api/editing/me', async (req): Promise<MyEditing> => {
    const me = requireUser(req);
    return loadMine(ctx, me);
  });

  app.post('/api/editing/focus', async (req): Promise<MyEditing> => {
    const me = requireUser(req);
    const input = parse(z.object({
      videoId: z.string().trim().min(1, 'Pick a video').max(200),
      action: z.enum(['start', 'pause', 'resume', 'done']),
    }), req.body);
    await applyFocus(ctx, me, input.videoId, input.action);
    return loadMine(ctx, me);
  });
}
