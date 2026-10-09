// Editing: the videos editors cut, read from Timeliner.
//
// Videos are given to editors in Timeliner; this site never assigns them and editors never claim them here.
// Every TIMELINER_SYNC_MINUTES (and on "Read Timeliner now") the server reads Timeliner's members, brands and
// tasks and keeps a copy. After every write to the copy (a read, a video message, a manager's pin) every video is
// matched again to a client, a batch and a script by the rules in server/matching.ts: by date, from when the
// video was made (raw camera clips belong to the shoot that had just happened; a titled video to the shoot whose
// raw clips its editor has been cutting), a manager's pin first, and a video that has been in review keeps its
// batch. Its editor then gets the script to cut from: the shoot's scripts PDF from Timeliner (opened through
// GET /api/editing/script-pdf/:batchId, which fetches a fresh link each time), else the site's document. A
// read-only key is enough. When the webhook is connected, task messages update one video straight away; a
// message that changes or removes a video after a read began isn't undone by that read. When Timeliner can't be
// read, its error is kept for the page and the last copy stays. Scripts PDFs (linked by server/timeliner.ts) are
// tasks too: a read keeps their step, version and whether they were trashed, and never takes them for videos.
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
import { HttpError, conflict, forbidden, notFound, parse, zs } from './http';
import { isScriptDocument, pdfInReview, TimelinerError, type TimelinerApi, type TimelinerMedia } from './timeliner';
import { EDITOR_SHOOT_KEEP_DAYS, isSureMatch, matchVideos, type VideoIn, type World } from './matching';
import { loadDeliverables, loadScriptEdits, type ScriptEdit } from './records';
import { EDITOR_FILES } from './files';
import { loadEditorRows } from './control/editors';
import { isISODate, isValidTimeZone, makeClock, type ISODate } from '../shared/dates';
import { cityLabel, onShift } from '../shared/cities';
import {
  compressRanges, compressTitles, hasNoScripts, isApproved, isEditor, isFocusStale, isManager, isNotMatched, isOnPlate, isRawTitle, needsCheck, TIMELINER_STEP_LABEL, titleNumber,
  videoState, type ScriptStatus, type TimelinerStatusGroup, type VideoState,
} from '../shared/workflow';
import { fmtWorked } from '../shared/format';
import type {
  ClientEditing, Deliverable, EditingBoard, EditingSync, EditingVideo, EditorClient, EditorFlag, EditorFocus, EditorPlate, EditorRef, EditorRow, FocusAction, Me,
  MyEditing, ScriptDoc, UserSummary, VideoMatch, VideoMatchHow,
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
//
// Real data can be odd: a field null, missing or of another type, a list where one item isn't what it should be.
// Every task, member, brand and project is read field by field, and an odd field takes a safe default; only an
// item that can't be read at all (not an object, or no id) is skipped, counted, and its id logged once. One odd
// item never fails the read.

/** a string without the characters Postgres can't store, trimmed and cut to `max` */
const clean = (v: string, max: number) => v.replace(/\u0000/g, '').trim().slice(0, max);
/** an id: a string, or a number Timeliner sent as one */
const idOf = (max: number) => z.union([z.string(), z.number().finite()]).transform((v) => clean(String(v), max)).pipe(z.string().min(1));
const text = (max: number) => z.string().transform((v) => clean(v, max) || null).nullish().catch(null);
const optId = (max: number) => idOf(max).nullish().catch(null);
const day = z.string().transform((v) => v.trim().slice(0, 10)).refine(isISODate).nullish().catch(null);
/** a time: an ISO string or epoch milliseconds, within reason (a year Postgres and the screens can show) */
const stamp = z.union([z.string(), z.number().finite()])
  .transform((v) => { const d = new Date(typeof v === 'number' ? v : v.trim()); return Number.isNaN(d.getTime()) ? null : d.getUTCFullYear() < 1990 || d.getUTCFullYear() > 2200 ? null : d.toISOString(); })
  .nullish().catch(null);
const rounds = z.coerce.number().int().min(0).max(10_000).catch(0);
/** a list whose odd items are dropped one by one (never the whole list) */
const ids = z.array(z.unknown()).catch([]).transform((list) => [...new Set(list.flatMap((x) => {
  const v = typeof x === 'string' || typeof x === 'number' ? x : x && typeof x === 'object' && 'id' in x ? (x as { id: unknown }).id : null;
  const id = typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) ? clean(String(v), 200) : '';
  return id ? [id] : [];
}))].slice(0, 100));

/** A task as read from Timeliner, checked field by field: an odd value is dropped, never trusted. Only its id is required. */
const taskSchema = z.object({
  id: idOf(200),
  title: z.union([z.string(), z.number().finite()]).transform((v) => clean(String(v), 500)).catch(''),
  statusGroup: z.string().transform((v) => clean(v, 60) || 'toDo').catch('toDo'),
  status: text(40).transform((v) => v?.toLowerCase() ?? null),
  type: text(40).transform((v) => v?.toLowerCase() ?? null),
  projectId: optId(200),
  brandId: optId(200),
  subFolderId: optId(200),
  assigneeIds: ids,
  internalDeadline: day,
  externalDeadline: day,
  internalRevisions: rounds,
  clientRevisions: rounds,
  createdAt: stamp,
  updatedAt: stamp,
  approvedAt: stamp,
  kind: text(40),
  parentTaskId: optId(200),
  /** its current file: only what tells a video from a document (its link expires and is never kept) */
  media: z.object({
    fileId: optId(200),
    name: z.string().transform((v) => clean(v, 500)).catch(''),
    mimeType: z.string().transform((v) => clean(v, 200)).catch(''),
  }).nullish().catch(null),
});
type Task = z.infer<typeof taskSchema>;
const readTask = (raw: unknown): Task | null => {
  const r = taskSchema.safeParse(raw);
  return r.success ? r.data : null;
};

/** A member of the Timeliner workspace, read as leniently: only the id is required. */
const memberSchema = z.object({
  id: idOf(200),
  email: z.string().transform((v) => clean(v, 300) || null).nullish().catch(null),
  firstName: text(100),
  lastName: text(100),
  /** a name Timeliner may send whole */
  name: text(200),
  role: text(40).transform((v) => v?.toLowerCase() ?? null),
  deactivated: z.boolean().catch(false),
});
type Member = z.infer<typeof memberSchema>;

/** A brand (a client in Timeliner): an id and a name, or it's no use. */
const brandSchema = z.object({ id: idOf(200), name: z.string().transform((v) => clean(v, 300)).pipe(z.string().min(1)) });

/** Something a read couldn't use: a task, member, brand, project or sub-folder, and its id when it had one. */
interface Skip { what: string; id: string | null }
const rawId = (raw: unknown): string | null => {
  const v = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : null;
  return typeof v === 'string' || typeof v === 'number' ? clean(String(v), 200) || null : null;
};

/** Each of `list` read with `schema`; what can't be read is skipped and noted. */
function readAll<T>(list: unknown, schema: z.ZodType<T>, what: string, skips: Skip[]): T[] {
  if (!Array.isArray(list)) throw new TimelinerError(`Timeliner’s answer for its ${what}s wasn’t a list, so the last copy is kept.`, 200);
  return list.flatMap((raw) => {
    const r = schema.safeParse(raw);
    if (r.success) return [r.data];
    skips.push({ what, id: rawId(raw) });
    return [];
  });
}

/** skipped items already logged (each once, by id; no content, so nothing private) */
const loggedSkips = new Set<string>();
function logSkips(skips: Skip[], log: ((m: string) => void) | undefined) {
  if (!log) return;
  for (const s of skips) {
    const k = `${s.what}|${s.id ?? ''}`;
    if (loggedSkips.has(k)) continue;
    if (loggedSkips.size > 5000) loggedSkips.clear();
    loggedSkips.add(k);
    log(`timeliner: skipped a ${s.what} the site couldn't read (${s.id ? `id ${s.id}` : 'no id'}); the rest of the read went on`);
  }
}

/** Why a task isn't kept as a video: trashed or archived, a document rather than a video, or long finished. */
function skipReason(t: Task, now: Date): string | null {
  if (t.status && t.status !== 'active') return 'it was trashed or archived in Timeliner';
  if (t.type === 'doc') return 'it’s a document, not a video';
  if (t.media && isScriptDocument(t.media.name, t.media.mimeType || null)) return 'its file is a document, not a video';
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

interface NameRow { id: string; kind: 'brand' | 'project' | 'subfolder'; name: string; parent_id: string | null; synced_at: string; created_at: string | null }
type ProjectRead = { name: string; nodeId: string | null; createdAt: string | null; subFolders: { id: string; name: string; createdAt: string | null }[] } | null;
type Move = { at: string; to: string | null; byId: string | null } | null;

/** A project (or sub-folder) as Timeliner sent it: its name, or null when it has none the site can use. */
const projectSchema = z.object({ name: z.string().transform((v) => clean(v, 300)).pipe(z.string().min(1)), nodeId: optId(200), createdAt: stamp });
const subFolderSchema = projectSchema.extend({ id: idOf(200) });

/** The projects these videos sit in, open videos' first, unless read in the last hour. A project that can't be read is skipped (and noted). */
async function readProjects(api: TimelinerApi, tasks: Task[], cached: Map<string, NameRow>, now: Date, cap: number, skips: Skip[] = []): Promise<Map<string, ProjectRead>> {
  const out = new Map<string, ProjectRead>();
  const ordered = [...tasks].sort((a, b) => Number(videoState(a.statusGroup) === 'approved') - Number(videoState(b.statusGroup) === 'approved'));
  const ids = [...new Set(ordered.map((t) => t.projectId).filter((x): x is string => !!x))];
  for (const id of ids) {
    if (out.size >= cap) break;
    const c = cached.get(id);
    if (c && now.getTime() - time(c.synced_at) < PROJECT_REFRESH_MS) continue;
    let p: unknown;
    try {
      p = await api.project(id);
    } catch (err) {
      if (stopLooking(err)) break;
      continue;
    }
    if (p == null) { out.set(id, null); continue; }
    const read = projectSchema.safeParse(p);
    if (!read.success) { skips.push({ what: 'project', id }); out.set(id, null); continue; }
    const list = (p as { subFolders?: unknown }).subFolders;
    const subFolders = (Array.isArray(list) ? list : []).flatMap((f) => {
      const r = subFolderSchema.safeParse(f);
      if (!r.success) { skips.push({ what: 'sub-folder', id: rawId(f) }); return []; }
      return [{ id: r.data.id, name: r.data.name, createdAt: r.data.createdAt ?? null }];
    });
    out.set(id, { name: read.data.name, nodeId: read.data.nodeId ?? null, createdAt: read.data.createdAt ?? null, subFolders });
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
      const m = await api.lastMove(t.id);
      // only what can be used: a time, a step's name and who moved it, each a string (else as if it never moved)
      const at = m && typeof m === 'object' ? iso(typeof m.at === 'string' ? m.at : null) : null;
      out.set(t.id, at ? { at, to: typeof m?.to === 'string' ? clean(m.to, 120) || null : null, byId: typeof m?.byId === 'string' ? clean(m.byId, 200) || null : null } : null);
    } catch (err) {
      if (stopLooking(err)) break;
    }
  }
  return out;
}

// ── keeping the copy ─────────────────────────────────────────────────────

/** What a read writes for one video (its match is worked out afterwards, on the whole copy: rematch). */
interface Row {
  id: string; title: string; status_group: string; step_label: string | null; history_group: string | null;
  project_id: string | null; brand_id: string | null; sub_folder_id: string | null; folder: string | null;
  assignee_ids: string[]; internal_deadline: string | null; external_deadline: string | null;
  internal_revisions: number; client_revisions: number; created_at: string | null; updated_at: string | null;
  moved_at: string | null; moved_by: string | null; left_plate_at: string | null; parent_task_id: string | null;
  /** its current file is a video (or an image), not none yet: a document uploaded to it later is notes, not a scripts PDF */
  has_video: boolean;
}
const COLS: (keyof Row)[] = [
  'id', 'title', 'status_group', 'step_label', 'history_group', 'project_id', 'brand_id', 'sub_folder_id', 'folder',
  'assignee_ids', 'internal_deadline', 'external_deadline', 'internal_revisions', 'client_revisions', 'created_at', 'updated_at',
  'moved_at', 'moved_by', 'left_plate_at', 'parent_task_id', 'has_video',
];

async function loadPrev(db: Db, ids?: string[]): Promise<Map<string, Prev>> {
  const rows = await db.query<Prev>(
    `select id, status_group, step_label, history_group, updated_at, moved_at, moved_by, left_plate_at from timeliner_tasks
      where $1::text[] is null or id = any($1::text[])`, [ids ?? null],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

async function loadNames(db: Db): Promise<Map<string, NameRow>> {
  return new Map((await db.query<NameRow>(`select id, kind, name, parent_id, synced_at, created_at from timeliner_names`)).map((r) => [r.id, r]));
}

/** One video's row: Timeliner's fields, its step as last read, and when it left the editor's plate. */
function buildRow(t: Task, p: Prev | undefined, move: Move | undefined, names: Map<string, { name: string }>, now: Date): Row {
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

  // when it left the plate (sent to review or further): the move seen now, else, for a video first seen in review,
  // its move there (one that never moved was made there: a titled video an editor put straight into review)
  let left = p?.left_plate_at ?? null;
  if (!isOnPlate(state)) {
    if (p && isOnPlate(videoState(p.status_group))) left = movedAt ?? now.toISOString();
    else if (!left && state === 'in_review') left = move === null ? iso(t.createdAt) ?? movedAt : movedAt;
  } else if (!left && !p && state === 'revisions') {
    // first seen back for revisions: it was in review before (the time is a bound, not shown)
    left = movedAt ?? iso(t.createdAt);
  }

  const projectName = t.projectId ? names.get(t.projectId)?.name ?? null : null;
  const subName = t.subFolderId ? names.get(t.subFolderId)?.name ?? null : null;
  const folder = [projectName, subName].filter(Boolean).join(' › ') || null;
  return {
    id: t.id, title: t.title || 'Untitled video', status_group: group, step_label: step, history_group: historyGroup,
    project_id: t.projectId ?? null, brand_id: t.brandId ?? null, sub_folder_id: t.subFolderId ?? null, folder,
    assignee_ids: [...new Set(t.assigneeIds)], internal_deadline: t.internalDeadline ?? null, external_deadline: t.externalDeadline ?? null,
    internal_revisions: t.internalRevisions, client_revisions: t.clientRevisions,
    created_at: iso(t.createdAt), updated_at: iso(t.updatedAt), moved_at: movedAt, moved_by: movedBy, left_plate_at: left,
    parent_task_id: t.parentTaskId && t.parentTaskId !== t.id ? t.parentTaskId : null,
    // a document as its file never gets this far (skipReason)
    has_video: !!t.media,
  };
}

/** A linked scripts PDF's task as a read sees it: its step, whether it was trashed, and its current file. */
interface PdfSeen { key: string; step: string; gone: boolean; fileId: string | null; fileName: string | null; updatedAt: string | null }
const pdfSeen = (t: Task): PdfSeen => ({
  key: t.id, step: t.statusGroup, gone: t.status === 'trashed', fileId: t.media?.fileId ?? null, fileName: t.media?.name || null, updatedAt: iso(t.updatedAt),
});

/** What a read (or one webhook message) found, ready to write. */
interface Found {
  rows: Row[];
  /** task ids to remove: trashed, archived, documents, long finished, or gone */
  drop: string[];
  /** every task was read, so tasks not in `rows` are gone from Timeliner */
  complete: boolean;
  /** a read that stopped early reached back to videos created then: newer tasks not in `rows` are gone */
  listedFrom?: string | null;
  members?: Member[];
  brands?: { id: string; name: string }[];
  projects: Map<string, ProjectRead>;
  /** rows written by something newer than this (a webhook during a read) are left alone */
  readSince: string;
  at: Date;
  /** a full read: recorded as the last time Timeliner was read, clearing any error */
  fullRead?: boolean;
  /** linked scripts PDFs seen in this read (R1: step, trashed, a version whose message was missed) */
  pdfs?: PdfSeen[];
  /** what a full read found, for the Editors tab's sync line */
  counts?: NonNullable<EditingSync['counts']>;
}

const memberName = (x: Member) => [x.firstName, x.lastName].filter(Boolean).join(' ').trim() || x.name || x.email || null;

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
      const byId = new Map(f.members.map((x) => [x.id, x]));
      const rows = [...byId.values()].map((x) => [x.id, x.email ?? null, memberName(x)?.slice(0, 200) ?? null, x.role ?? null, !x.deactivated, at]);
      await insertRows(t, 'timeliner_members', ['id', 'email', 'name', 'role', 'active', 'synced_at'], rows);
    }
    const names: unknown[][] = [];
    for (const b of f.brands ?? []) names.push([b.id, 'brand', b.name, null, at, null]);
    for (const [id, p] of f.projects) {
      if (!p) continue;
      names.push([id, 'project', p.name, p.nodeId, at, p.createdAt]);
      await t.query(`delete from timeliner_names where kind = 'subfolder' and parent_id = $1`, [id]);
      for (const s of p.subFolders) names.push([s.id, 'subfolder', s.name, id, at, s.createdAt]);
    }
    const unique = [...new Map(names.map((n) => [n[0], n])).values()];
    await insertRows(t, 'timeliner_names', ['id', 'kind', 'name', 'parent_id', 'synced_at', 'created_at'], unique, {
      tail: () => `on conflict (id) do update set kind = excluded.kind, name = excluded.name, parent_id = excluded.parent_id, synced_at = excluded.synced_at,
                   created_at = coalesce(excluded.created_at, timeliner_names.created_at)`,
    });

    // R1 · linked scripts PDFs: their step, trashed or restored, and a new file whose message never came (a version)
    for (const p of f.pdfs ?? []) {
      await t.query(
        `update timeliner_pdfs set step = $2, gone_at = case when $3 then coalesce(gone_at, $7::timestamptz) else null end,
                version = case when $4::text is not null and file_id is not null and file_id <> $4 then version + 1 else version end,
                latest_at = case when $4::text is not null and file_id is not null and file_id <> $4 then greatest(latest_at, coalesce($5::timestamptz, latest_at)) else latest_at end,
                file_name = case when $4::text is not null and file_id is distinct from $4 then coalesce($6, file_name) else file_name end,
                file_id = coalesce($4, file_id)
          where key = $1`,
        [p.key, p.step, p.gone, p.fileId, p.updatedAt, p.fileName, at],
      );
    }

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
    // matched afresh (not kept where it was): a video moved to another project or sub-folder, and one given to its
    // first editor after it was matched by date alone (made straight into review before anyone had it, its
    // editor's raw clips couldn't count yet)
    await insertRows(t, 'timeliner_tasks', cols, rows.map((r) => [...COLS.map((c) => r[c]), at]), {
      casts: { assignee_ids: '::text[]' },
      tail: (n) => `on conflict (id) do update set ${cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')},
                    match_how = case when timeliner_tasks.project_id is distinct from excluded.project_id or timeliner_tasks.sub_folder_id is distinct from excluded.sub_folder_id
                                     then null
                                     when cardinality(timeliner_tasks.assignee_ids) = 0 and cardinality(excluded.assignee_ids) > 0 and timeliner_tasks.match_how in ('date', 'undated')
                                     then null
                                     else timeliner_tasks.match_how end
                    where timeliner_tasks.synced_at <= $${n}`,
      tailParams: [f.readSince],
    });
    await rematch(t, f.at);
    await endLeftFocus(t);
    if (f.fullRead) {
      await t.query(`update settings set timeliner_synced_at = $1, timeliner_sync_error = null, timeliner_sync_counts = $2::jsonb where id = 1`, [at, f.counts ? JSON.stringify(f.counts) : null]);
    }
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

// ── matching the copy to the site ────────────────────────────────────────

const DAY = (v: string | null | undefined) => (v ? String(v).slice(0, 10) : null);

/** What matching needs from the site and the copy: batches, clients, scripts PDFs, folders, pins, editors' raw-clip shoots. */
async function loadWorld(t: Db, now: Date): Promise<World> {
  const tz = (await loadSettings(t)).timezone;
  const clients = (await t.query<{ id: number; name: string }>(`select id, name from clients where archived_at is null and status <> 'prospect'`))
    .map((c) => ({ id: Number(c.id), name: c.name }));
  const batches = await t.query<{
    id: number; title: string; client_id: number; client_name: string; timeliner_project_id: string | null;
    shoot_start: string | null; shoot_end: string | null; final_due: string | null; draft_due: string | null; numbers: number[] | null; finished: number;
  }>(
    `select b.id, b.title, b.client_id, c.name as client_name, b.timeliner_project_id,
            case when sh.cancelled_at is null then sh.start_date::text end as shoot_start,
            case when sh.cancelled_at is null then sh.end_date::text end as shoot_end,
            b.final_due::text as final_due, b.draft_due::text as draft_due,
            (select array_agg(s.number)::int[] from scripts s where s.batch_id = b.id and s.removed_at is null) as numbers,
            (select count(*)::int from scripts s where s.batch_id = b.id and s.removed_at is null and s.status in ('approved', 'delivered')) as finished
       from batches b join clients c on c.id = b.client_id left join shoots sh on sh.id = b.shoot_id`,
  );
  const pdfs = await t.query<{ batch_id: number; project_id: string | null; sub_folder_id: string | null; first_at: string }>(
    `select batch_id, project_id, sub_folder_id, first_at from timeliner_pdfs where gone_at is null`,
  );
  const names = await t.query<{ id: string; name: string; created_at: string | null }>(`select id, name, created_at from timeliner_names`);
  const pins = await t.query<{ task_id: string; batch_id: number | null; script_number: number | null; by_name: string | null }>(
    `select p.task_id, p.batch_id, p.script_number, u.name as by_name from timeliner_video_pins p left join users u on u.id = p.set_by`,
  );
  const clips = await t.query<{ task_id: string; member_id: string; batch_id: number; clip_at: string }>(
    `select task_id, member_id, batch_id, clip_at from timeliner_editor_clips where last_seen_at >= $1`,
    [new Date(now.getTime() - EDITOR_SHOOT_KEEP_DAYS * DAY_MS).toISOString()],
  );
  const members = await t.query<{ id: string; name: string | null; email: string | null }>(`select id, name, email from timeliner_members`);
  return {
    tz, clients,
    batches: new Map(batches.map((b) => {
      const d = b.shoot_start ?? b.final_due ?? b.draft_due ?? null;
      return [Number(b.id), {
        id: Number(b.id), title: b.title, clientId: Number(b.client_id), clientName: b.client_name,
        d, e: b.shoot_end ?? d, dFrom: b.shoot_start ? 'shoot' as const : d ? 'due' as const : null,
        numbers: new Set((b.numbers ?? []).map(Number)), finished: b.finished, legacyProject: b.timeliner_project_id,
      }];
    })),
    pdfs: pdfs.map((p) => ({ batchId: Number(p.batch_id), projectId: p.project_id, subFolderId: p.sub_folder_id, firstAt: iso(p.first_at)! })),
    names: new Map(names.map((n) => [n.id, { name: n.name, createdAt: iso(n.created_at) }])),
    pins: new Map(pins.map((p) => [p.task_id, { batchId: p.batch_id != null ? Number(p.batch_id) : null, number: p.script_number, byName: p.by_name }])),
    editorClips: clips.map((c) => ({ taskId: c.task_id, member: c.member_id, batchId: Number(c.batch_id), at: iso(c.clip_at)! })),
    memberNames: new Map(members.map((m) => [m.id, m.name ?? m.email ?? 'Its editor'])),
  };
}

interface MatchRow {
  id: string; title: string; status_group: string; created_at: string | null; project_id: string | null; sub_folder_id: string | null; brand_id: string | null;
  internal_deadline: string | null; external_deadline: string | null; assignee_ids: string[]; parent_task_id: string | null; left_plate_at: string | null;
  client_id: number | null; batch_id: number | null; script_number: number | null; match_how: string | null; match_note: string | null; match_check: boolean; match_kept: boolean;
}

/**
 * Matches every video in the copy again (server/matching.ts) and writes what changed, then remembers which shoots
 * each editor's raw clips are from. Runs inside every write to the copy, under its lock, so a read, a video message
 * and a pin all leave the copy matched the same way.
 */
export async function rematch(t: Db, now: Date): Promise<void> {
  const w = await loadWorld(t, now);
  const rows = await t.query<MatchRow>(
    `select id, title, status_group, created_at, project_id, sub_folder_id, brand_id, internal_deadline, external_deadline, assignee_ids, parent_task_id,
            left_plate_at, client_id, batch_id, script_number, match_how, match_note, match_check, match_kept
       from timeliner_tasks`,
  );
  const videos: VideoIn[] = rows.map((r) => {
    const dues = [DAY(r.internal_deadline), DAY(r.external_deadline)].filter((x): x is string => !!x).sort();
    return {
      id: r.id, title: r.title, state: videoState(r.status_group), toDo: r.status_group === 'toDo', createdAt: iso(r.created_at),
      projectId: r.project_id, subFolderId: r.sub_folder_id, brandId: r.brand_id, deadline: dues[0] ?? null,
      assignees: r.assignee_ids ?? [], parentId: r.parent_task_id, leftPlate: !!r.left_plate_at,
      prev: { how: (r.match_how as VideoMatchHow | null) ?? null, batchId: r.batch_id != null ? Number(r.batch_id) : null, note: r.match_note },
    };
  });
  const out = matchVideos(videos, w);
  const changed = rows.flatMap((r) => {
    const m = out.get(r.id);
    if (!m) return [];
    const same = (r.client_id != null ? Number(r.client_id) : null) === m.clientId && (r.batch_id != null ? Number(r.batch_id) : null) === m.batchId
      && (r.script_number ?? null) === m.number && (r.match_how ?? null) === m.how && (r.match_note ?? null) === m.note
      && !!r.match_check === m.check && !!r.match_kept === m.kept;
    return same ? [] : [{ id: r.id, ...m }];
  });
  for (let i = 0; i < changed.length; i += 500) {
    const part = changed.slice(i, i + 500);
    await t.query(
      `update timeliner_tasks tt set client_id = v.client_id, batch_id = v.batch_id, script_number = v.script_number, match_how = v.match_how,
              match_note = v.match_note, match_check = v.match_check, match_kept = v.match_kept
         from unnest($1::text[], $2::bigint[], $3::bigint[], $4::int[], $5::text[], $6::text[], $7::boolean[], $8::boolean[])
              as v(id, client_id, batch_id, script_number, match_how, match_note, match_check, match_kept)
        where tt.id = v.id`,
      [part.map((x) => x.id), part.map((x) => x.clientId), part.map((x) => x.batchId), part.map((x) => x.number), part.map((x) => x.how),
        part.map((x) => x.note), part.map((x) => x.check), part.map((x) => x.kept)],
    );
  }

  // which shoot each editor's raw clips are from, clip by clip, remembered after the clips are trashed (they usually
  // are, minutes after the titled video made from them arrives). A clip still here is written as matched now, so
  // one moved to another shoot (a shoot date fixed, a pin) takes its memory with it; one matched to no shoot, or
  // given to someone else, is forgotten for whoever doesn't have it.
  const at = now.toISOString();
  const rawIds = videos.filter((v) => isRawTitle(v.title)).map((v) => v.id);
  const was = rawIds.length ? await t.query<{ task_id: string; member_id: string; batch_id: number; last_seen_at: string }>(
    `select task_id, member_id, batch_id, last_seen_at from timeliner_editor_clips where task_id = any($1::text[])`, [rawIds],
  ) : [];
  const seen = new Map(was.map((r) => [`${r.task_id}\u0000${r.member_id}`, r]));
  const keep = new Set<string>();
  const upsert: unknown[][] = [];
  for (const v of videos) {
    const m = out.get(v.id);
    if (!m || m.batchId == null || !isRawTitle(v.title)) continue;
    for (const a of new Set(v.assignees)) {
      const k = `${v.id}\u0000${a}`;
      keep.add(k);
      const r = seen.get(k);
      // written when it's new or moved, else about daily (so it's kept while the clip is)
      if (!r || Number(r.batch_id) !== m.batchId || time(r.last_seen_at) < now.getTime() - DAY_MS) upsert.push([v.id, a, m.batchId, v.createdAt ?? at, at]);
    }
  }
  await insertRows(t, 'timeliner_editor_clips', ['task_id', 'member_id', 'batch_id', 'clip_at', 'last_seen_at'], upsert, {
    tail: () => `on conflict (task_id, member_id) do update set batch_id = excluded.batch_id, clip_at = excluded.clip_at, last_seen_at = excluded.last_seen_at`,
  });
  const gone = was.filter((r) => !keep.has(`${r.task_id}\u0000${r.member_id}`));
  if (gone.length) {
    await t.query(
      `delete from timeliner_editor_clips c using unnest($1::text[], $2::text[]) as g(task_id, member_id) where c.task_id = g.task_id and c.member_id = g.member_id`,
      [gone.map((r) => r.task_id), gone.map((r) => r.member_id)],
    );
  }
  await t.query(`delete from timeliner_editor_clips where last_seen_at < $1`, [new Date(now.getTime() - EDITOR_SHOOT_KEEP_DAYS * DAY_MS).toISOString()]);
}

export interface SyncResult { ok: boolean; error: string | null; videos: number; complete: boolean; skipped: number }

/**
 * Reads Timeliner and replaces the copy: members, brands, the videos (newest first, up to a cap; long-finished
 * ones aren't kept), the projects open videos sit in, and the last step move of videos whose step changed.
 * A task, member, brand or project that can't be read is skipped and counted (its id logged once), and the read
 * goes on. When Timeliner can't be read at all the copy stays as it was and the error is kept to show.
 */
export async function syncTimeliner(db: Db, api: TimelinerApi, now: Date, log?: (m: string) => void): Promise<SyncResult> {
  const skips: Skip[] = [];
  try {
    const listedMembers: unknown = await api.members();
    const members = readAll(listedMembers, memberSchema, 'member', skips);
    const brands = readAll((await readPages((b) => api.brands(b), BRAND_PAGES)).items, brandSchema, 'brand', skips);
    const listed = await readPages((b) => api.tasks(b), TASK_PAGES);
    const keep = new Map<string, Task>();
    const drop: string[] = [];
    // scripts PDFs linked to their batches are tasks too: kept up to date there, never taken for videos
    const linked = new Set((await db.query<{ key: string }>(`select key from timeliner_pdfs where kind = 'task'`)).map((r) => r.key));
    const pdfs: PdfSeen[] = [];
    // the oldest video the list reached (it's newest first): a read that stops early covers only what's newer
    let listedFrom: string | null = null;
    for (const raw of listed.items) {
      // every field but the id has a safe default: a task without a usable id is all that's skipped
      const t = readTask(raw);
      if (!t) { skips.push({ what: 'task', id: rawId(raw) }); continue; }
      const created = iso(t.createdAt);
      if (created && (!listedFrom || created < listedFrom)) listedFrom = created;
      if (linked.has(t.id)) { pdfs.push(pdfSeen(t)); drop.push(t.id); continue; }
      if (skipReason(t, now)) drop.push(t.id);
      else keep.set(t.id, t);
    }
    const tasks = [...keep.values()];
    const prev = await loadPrev(db);
    const cached = await loadNames(db);
    const projects = await readProjects(api, tasks, cached, now, PROJECTS_PER_READ, skips);
    const moves = await readMoves(api, tasks, prev, MOVES_PER_READ);
    const names = new Map<string, { name: string }>(cached);
    for (const b of brands) names.set(b.id, { name: b.name });
    for (const [id, p] of projects) if (p) { names.set(id, p); for (const s of p.subFolders) names.set(s.id, s); }
    const rows = tasks.map((t) => buildRow(t, prev.get(t.id), moves.get(t.id), names, now));
    const counts = {
      videos: rows.length,
      people: new Set(rows.flatMap((r) => r.assignee_ids)).size,
      clients: new Set(rows.map((r) => r.brand_id).filter(Boolean)).size,
      skipped: skips.length,
    };
    await write(db, {
      // a list of members none of which could be read keeps the last ones (else nobody would match by email)
      rows, drop, complete: listed.complete, listedFrom, members: members.length || !(listedMembers as unknown[]).length ? members : undefined, brands, projects,
      readSince: now.toISOString(), at: now, fullRead: true, pdfs, counts,
    });
    logSkips(skips, log);
    return { ok: true, error: null, videos: rows.length, complete: listed.complete, skipped: skips.length };
  } catch (err) {
    const message = err instanceof TimelinerError ? err.message : 'Something went wrong reading Timeliner. It tries again in a few minutes.';
    // the copy stays as it was; the page says why it's not fresh
    await db.query(`update settings set timeliner_sync_error = $1 where id = 1`, [message.slice(0, 500)]).catch(() => {});
    if (!(err instanceof TimelinerError)) throw err;
    return { ok: false, error: message, videos: 0, complete: false, skipped: skips.length };
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
    // its scripts PDFs go with it (a new version, or the project restored, brings them back)
    await db.query(`update timeliner_pdfs set gone_at = coalesce(gone_at, $2) where project_id = $1`, [m.projectId, now.toISOString()]);
    const gone = (await db.query<{ id: string }>(`select id from timeliner_tasks where project_id = $1`, [m.projectId])).map((r) => r.id);
    await write(db, { ...base, rows: [], drop: gone });
    return `A project was trashed: ${gone.length} video${gone.length === 1 ? '' : 's'} removed`;
  }
  if (!m.taskId) return 'A video message without a video';
  if (m.type === 'task.trashed') {
    const pdf = await db.query(`update timeliner_pdfs set gone_at = coalesce(gone_at, $2) where key = $1 returning key`, [m.taskId, now.toISOString()]);
    await write(db, { ...base, rows: [], drop: [m.taskId] });
    return pdf.length ? 'A scripts PDF was trashed' : 'A video was trashed';
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
  // sent, but in a form the site can't read: that isn't gone, so the copy stays as it was
  if (raw != null && !t) return 'Timeliner sent the video in a form the site couldn’t read, so its last copy stays';
  if (t && (await db.one(`select 1 from timeliner_pdfs where key = $1`, [t.id]))) {
    await write(db, { ...base, rows: [], drop: [t.id], pdfs: [pdfSeen(t)] });
    return `A scripts PDF: ${stepLabel(t.statusGroup)}${t.status === 'trashed' ? ', trashed' : ''}`;
  }
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
    const b = brandSchema.safeParse(await api.brand(t.brandId).catch(() => null));
    if (b.success) { brands = [b.data]; names.set(b.data.id, { name: b.data.name }); }
  }
  const prev = await loadPrev(db, [t.id]);
  const moves = await readMoves(api, [t], prev, 1);
  const row = buildRow(t, prev.get(t.id), moves.get(t.id), names, now);
  await write(db, { ...base, rows: [row], drop: [], brands, projects });
  return `Video “${row.title}”: ${row.step_label ?? stepLabel(row.status_group)}`;
}

/**
 * A task the copy took for a video while it had no file, whose file turns out to be a document (a scripts PDF
 * uploaded to a task made empty first): it leaves the copy now, as the next read would have it.
 */
export async function dropDocumentTask(ctx: Ctx, taskId: string): Promise<void> {
  const now = ctx.now();
  await write(ctx.db, { rows: [], drop: [taskId], complete: false, projects: new Map(), readSince: now.toISOString(), at: now });
}

/** Re-reads Timeliner every `minutes` (the real workspace, never a practice copy). */
export function startTimelinerSync(ctx: Ctx, minutes: number, log: (m: string) => void): () => void {
  let running = false;
  let lastError: string | null = null;
  const tick = async () => {
    if (running || !ctx.timeliner) return;
    running = true;
    try {
      const r = await syncTimeliner(ctx.realDb ?? ctx.db, ctx.timeliner, ctx.now(), log);
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

interface TaskRow extends Row {
  synced_at: string;
  client_id: number | null; batch_id: number | null; script_number: number | null;
  match_how: string | null; match_note: string | null; match_check: boolean; match_kept: boolean;
}
interface FocusRow { user_id: number; task_id: string; state: 'on' | 'paused'; since: string; worked_seconds: number; paused_at: string | null }
interface DoneRow { task_id: string; user_id: number; done_at: string }
/** A batch's scripts PDF in Timeliner, as the editors' links need it (never its download link). */
interface PdfRow { key: string; batch_id: number; file_name: string | null; title: string | null; version: number; latest_at: string; step: string | null }

const stepLabel = (group: string) => TIMELINER_STEP_LABEL[group as TimelinerStatusGroup] ?? 'To be edited';
const titleOrder = (title: string) => titleNumber(title) ?? Number.MAX_SAFE_INTEGER;
const byDue = (a: EditingVideo, b: EditingVideo) =>
  (a.due ?? '9999-12-31').localeCompare(b.due ?? '9999-12-31') || titleOrder(a.title) - titleOrder(b.title) || a.title.localeCompare(b.title);
const STATE_ORDER: Record<VideoState, number> = { revisions: 0, to_edit: 1, in_review: 2, with_client: 3, approved: 4 };
const newest = (a: string | null, b: string | null) => time(b) - time(a) || 0;

/**
 * SQL: editors may open the scripts PDF `p`: it delivered scripts that are still delivered in its batch, or every
 * script there is delivered (a PDF linked once everything was, like one replacing a trashed PDF). A PDF that
 * delivered nothing while some scripts aren't approved may hold those, so it's never offered.
 */
const DELIVERED_BY_PDF = `(exists (select 1 from timeliner_events e join scripts s on s.delivery_id = e.delivery_id
    where e.task_id = p.key and s.batch_id = p.batch_id and s.status = 'delivered' and s.removed_at is null)
  or not exists (select 1 from scripts s where s.batch_id = p.batch_id and s.removed_at is null and s.status <> 'delivered'))`;

/** Where an editor opens a batch's scripts PDF: the server fetches a fresh link from Timeliner each time. */
export const scriptPdfHref = (batchId: number) => `/api/editing/script-pdf/${batchId}`;

/**
 * The site's document for a finished script: the edited version a manager last approved it with, else the newest
 * document it was sent in, when an editor can open it.
 */
function siteDoc(L: Loaded, batchId: number, n: number): ScriptDoc | null {
  const inBatch = L.docs.filter((x) => x.batchId === batchId);
  const d = inBatch.find((x) => x.scripts.some((s) => s.number === n));
  const s = d?.scripts.find((x) => x.number === n);
  // editors only ever cut from a finished script
  if (!d || !s || !isApproved(s.status)) return null;
  const site = { source: 'site' as const, version: null, inReview: false, alt: null, batchId, batchTitle: d.batchTitle };
  const e = L.edits.get(s.id);
  if (e) {
    // the batch's finished scripts last approved with that same version
    const covers = inBatch.flatMap((x) => x.scripts).filter((x) => isApproved(x.status) && L.edits.get(x.id) === e).map((x) => x.number);
    return { ...site, href: e.href, name: e.name, edited: true, ranges: compressRanges(covers), updatedAt: iso(e.at) };
  }
  // a link always opens; an uploaded file, as /api/files/:id serves editors (every script ever sent in it finished)
  if (!d.href || d.kind === 'none' || (d.kind === 'file' && !L.openable.has(d.href))) return null;
  return { ...site, href: d.href, name: d.name, edited: false, ranges: d.ranges, updatedAt: iso(d.sentAt) };
}

/** A batch's scripts PDF from Timeliner, its newest version: offered once it has delivered scripts there (one that delivered nothing never is). */
function pdfDoc(L: Loaded, batchId: number): ScriptDoc | null {
  const p = L.pdfs.get(batchId);
  const scripts = L.scripts.get(batchId);
  const delivered = scripts ? [...scripts].filter(([, s]) => s.status === 'delivered').map(([n]) => n) : [];
  if (!p || !delivered.length) return null;
  return {
    href: scriptPdfHref(batchId), name: p.file_name ?? p.title, edited: false, ranges: compressRanges(delivered), batchId,
    batchTitle: L.batches.get(batchId)?.title ?? '', source: 'timeliner', version: p.version, updatedAt: iso(p.latest_at), inReview: pdfInReview(p.step), alt: null,
  };
}

/**
 * For a video with no script number (a raw clip): the site's document holding the most of the shoot's finished
 * scripts (the edited version when that's what they were approved with), so the editor has the shoot's scripts even
 * before a scripts PDF is linked in Timeliner (a read-only key never sees uploads).
 */
function batchSiteDoc(L: Loaded, batchId: number): ScriptDoc | null {
  const found = new Map<string, { doc: ScriptDoc; count: number }>();
  for (const [n, s] of L.scripts.get(batchId) ?? []) {
    if (!isApproved(s.status)) continue;
    const doc = siteDoc(L, batchId, n);
    if (!doc) continue;
    const hit = found.get(doc.href);
    if (hit) hit.count += 1;
    else found.set(doc.href, { doc, count: 1 });
  }
  const best = [...found.values()].sort((a, b) => b.count - a.count || newest(a.doc.updatedAt, b.doc.updatedAt))[0];
  return best?.doc ?? null;
}

/**
 * The document a video is cut from (L1–L5): with a script number, the shoot's scripts PDF from Timeliner first and
 * the site's document second (the other way round when the script was approved here after the PDF's newest
 * version); without one (a raw clip), the scripts PDF, else the site's document for the shoot. Never a script that
 * isn't approved.
 */
function scriptFor(L: Loaded, batchId: number | null, n: number | null): { script: ScriptDoc | null; issue: EditingVideo['scriptIssue'] } {
  if (batchId == null) return { script: null, issue: 'not_matched' };
  const pdf = pdfDoc(L, batchId);
  if (n == null) {
    const whole = batchSiteDoc(L, batchId);
    if (pdf) return { script: { ...pdf, alt: whole }, issue: null };
    return whole ? { script: whole, issue: null } : { script: null, issue: 'no_document' };
  }
  const s = L.scripts.get(batchId)?.get(n);
  if (!s || !isApproved(s.status)) return { script: null, issue: 'not_approved' };
  const site = siteDoc(L, batchId, n);
  if (pdf && site && s.approvedAt && time(s.approvedAt) > time(pdf.updatedAt)) return { script: { ...site, alt: pdf }, issue: null };
  if (pdf) return { script: { ...pdf, alt: site }, issue: null };
  return site ? { script: site, issue: null } : { script: null, issue: 'no_document' };
}

interface Loaded {
  sync: EditingSync;
  tasks: TaskRow[];
  byId: Map<string, TaskRow>;
  users: UserSummary[];
  /** member id → the site user with that email */
  userOf: Map<string, number>;
  members: Map<string, { name: string | null; email: string | null; role: string | null; active: boolean }>;
  /** Timeliner brand id → its name */
  brands: Map<string, string>;
  /** Settings → Editors: editors who don't sign in, with where they are and their hours */
  offSite: { name: string; city: string; timezone: string; workHours: [number, number] }[];
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
  /** batch id → its newest live scripts PDF in Timeliner */
  pdfs: Map<number, PdfRow>;
  /** batch id → script number → its status and when it was approved */
  scripts: Map<number, Map<number, { status: ScriptStatus; approvedAt: string | null }>>;
  today: ISODate;
  now: Date;
}

/** The last complete read's counts as stored (anything odd reads as none). */
function syncCounts(v: unknown): EditingSync['counts'] {
  const o = typeof v === 'string' ? (() => { try { return JSON.parse(v) as unknown; } catch { return null; } })() : v;
  if (!o || typeof o !== 'object') return null;
  const n = (k: string) => { const x = (o as Record<string, unknown>)[k]; return typeof x === 'number' && Number.isFinite(x) ? x : 0; };
  return { videos: n('videos'), people: n('people'), clients: n('clients'), skipped: n('skipped') };
}

async function loadEditing(ctx: Ctx): Promise<Loaded> {
  const { db } = ctx;
  const settings = await loadSettings(db);
  const s = await db.one<{ synced_at: string | null; error: string | null; counts: unknown }>(
    `select timeliner_synced_at as synced_at, timeliner_sync_error as error, timeliner_sync_counts as counts from settings where id = 1`,
  );
  const tasks = await db.query<TaskRow>(`select * from timeliner_tasks order by id`);
  const members = await db.query<{ id: string; email: string | null; name: string | null; role: string | null; active: boolean }>(`select id, email, name, role, active from timeliner_members`);
  const users = (await loadUsers(db)).filter((u) => u.active);
  const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), u.id]));
  const userOf = new Map<string, number>();
  for (const m of members) { const u = m.email ? byEmail.get(m.email.toLowerCase()) : undefined; if (u) userOf.set(m.id, u); }
  const batchIds = [...new Set(tasks.map((t) => t.batch_id).filter((x): x is number => x != null).map(Number))];
  const batches = batchIds.length ? await db.query<{ id: number; title: string; shoot_date: string | null }>(
    `select b.id, b.title, sh.start_date::text as shoot_date from batches b left join shoots sh on sh.id = b.shoot_id where b.id = any($1::bigint[])`, [batchIds],
  ) : [];
  const done = (await db.query<DoneRow>(`select task_id, user_id, done_at from editing_done`)).map((d) => ({ ...d, user_id: Number(d.user_id) }));
  const openable = batchIds.length ? await db.query<{ id: number }>(
    `select f.id from files f where f.id in (select s.file_id from submissions s where s.batch_id = any($1::bigint[])) and ${EDITOR_FILES}`, [batchIds],
  ) : [];
  // newest version first: a batch with two live PDFs offers the one changed last, and only one that delivered
  // scripts still delivered there (a PDF that delivered nothing may hold scripts that aren't approved)
  const pdfs = batchIds.length ? await db.query<PdfRow>(
    `select p.key, p.batch_id, p.file_name, p.title, p.version, p.latest_at, p.step from timeliner_pdfs p
      where p.gone_at is null and p.kind = 'task' and p.batch_id = any($1::bigint[]) and ${DELIVERED_BY_PDF}
      order by p.latest_at desc, p.key`, [batchIds],
  ) : [];
  const scriptRows = batchIds.length ? await db.query<{ batch_id: number; number: number; status: ScriptStatus; approved_at: string | null }>(
    `select batch_id, number, status, approved_at from scripts where removed_at is null and batch_id = any($1::bigint[])`, [batchIds],
  ) : [];
  const scripts = new Map<number, Map<number, { status: ScriptStatus; approvedAt: string | null }>>();
  for (const r of scriptRows) {
    const m = scripts.get(Number(r.batch_id)) ?? new Map<number, { status: ScriptStatus; approvedAt: string | null }>();
    m.set(r.number, { status: r.status, approvedAt: iso(r.approved_at) });
    scripts.set(Number(r.batch_id), m);
  }
  const pdfOf = new Map<number, PdfRow>();
  for (const p of pdfs) if (!pdfOf.has(Number(p.batch_id))) pdfOf.set(Number(p.batch_id), p);
  const now = ctx.now();
  return {
    sync: { keySet: !!ctx.timeliner, syncedAt: iso(s?.synced_at), error: s?.error ?? null, counts: syncCounts(s?.counts) },
    tasks, byId: new Map(tasks.map((t) => [t.id, t])), users, userOf,
    members: new Map(members.map((m) => [m.id, { name: m.name, email: m.email, role: m.role, active: m.active !== false }])),
    brands: new Map((await db.query<{ id: string; name: string }>(`select id, name from timeliner_names where kind = 'brand'`)).map((b) => [b.id, b.name])),
    offSite: (await loadEditorRows(db)).map((r) => ({
      name: r.name, city: cityLabel({ name: r.city, country: r.country }), timezone: r.timezone, workHours: [Number(r.work_start), Number(r.work_end)] as [number, number],
    })),
    focus: new Map((await db.query<FocusRow>(`select user_id, task_id, state, since, worked_seconds, paused_at from editor_focus`)).map((f) => [Number(f.user_id), f])),
    done, doneAt: new Map(done.map((d) => [`${d.task_id}|${d.user_id}`, d.done_at])),
    clients: new Map((await db.query<{ id: number; name: string }>(`select id, name from clients`)).map((c) => [Number(c.id), c.name])),
    batches: new Map(batches.map((b) => [Number(b.id), { title: b.title, shootDate: b.shoot_date }])),
    docs: await loadDeliverables(db, { batchIds }),
    edits: await loadScriptEdits(db, { batchIds }),
    // built as the Script bank builds a document's link
    openable: new Set(openable.map((f) => `/api/files/${f.id}`)),
    pdfs: pdfOf, scripts,
    today: makeClock(settings.timezone, settings.cutoff, now).today,
    now,
  };
}

/** A done mark counts until Timeliner moves the video on (or back, after it was marked). */
const markHolds = (doneAt: string, t: Pick<Row, 'left_plate_at' | 'moved_at'>) => time(doneAt) > Math.max(time(t.left_plate_at) || 0, time(t.moved_at) || 0);

/** How a video was matched, and how sure that is (a variant is as sure as its parent). */
function matchOf(L: Loaded, t: TaskRow): VideoMatch {
  const how = (t.match_how as VideoMatchHow | null) ?? null;
  const parent = how === 'parent' && t.parent_task_id ? L.byId.get(t.parent_task_id) : undefined;
  const from = parent ?? t;
  // pinned to no batch is a manager's answer too
  return { how, kept: !!t.match_kept, sure: isSureMatch((from.match_how as VideoMatchHow | null) ?? null, isRawTitle(from.title)), check: !!t.match_check, note: t.match_note };
}

/** A video as one person sees it (`userId` decides whether they marked it done here). */
function toVideo(L: Loaded, t: TaskRow, userId: number | null): EditingVideo {
  const state = videoState(t.status_group);
  const mark = userId == null ? undefined : L.doneAt.get(`${t.id}|${userId}`);
  const doneAt = mark && isOnPlate(state) && markHolds(mark, t) ? iso(mark) : null;
  const batchId = t.batch_id != null ? Number(t.batch_id) : null;
  const batch = batchId != null ? L.batches.get(batchId) : undefined;
  const match = matchOf(L, t);
  const doc = scriptFor(L, batch ? batchId : null, t.script_number);
  return {
    id: t.id, title: t.title, state,
    step: t.step_label ?? stepLabel(t.status_group),
    folder: t.folder,
    client: t.client_id != null && L.clients.has(Number(t.client_id)) ? { id: Number(t.client_id), name: L.clients.get(Number(t.client_id))! } : null,
    brand: t.brand_id ? L.brands.get(t.brand_id) ?? null : null,
    batch: batch && batchId != null ? { id: batchId, title: batch.title, shootDate: batch.shootDate } : null,
    scriptNumber: t.script_number,
    script: doc.script,
    // a client without scripts on the site (or a brand that isn't a client) isn't "not matched"
    scriptIssue: doc.issue === 'not_matched' && hasNoScripts({ match }) ? 'no_scripts' : doc.issue,
    raw: isRawTitle(t.title),
    match,
    due: t.internal_deadline ?? t.external_deadline,
    revisionRound: t.internal_revisions + t.client_revisions,
    movedAt: iso(t.moved_at),
    doneAt,
  };
}

// ── who's on the board ───────────────────────────────────────────────────

/**
 * Someone on the Editors tab: everyone in Timeliner with videos in the copy, and every editor on the site. A site
 * account matched by email (`linked`) brings their taps; one matched by name only says the emails differ.
 */
interface Person {
  key: string;
  userId: number | null;
  /** their site account has their Timeliner email: their taps and done marks count */
  linked: boolean;
  /** their Timeliner member ids (one, nearly always); the first has the most videos */
  memberIds: string[];
  name: string;
  city: string | null;
  timezone: string | null;
  workHours: [number, number] | null;
  flag: EditorFlag | null;
  /** given a card: not someone who left Timeliner with nothing open */
  card: boolean;
}

/** A name as compared across Timeliner, the team and Settings → Editors: any case, any spacing, any accents. */
const personKey = (name: string) => name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, '');

/**
 * Who does the editing of a video, for its client's editor and split: its assignees who are editors in Timeliner
 * (a manager or supervisor also on it is reviewing), else everyone on it.
 */
function editorsOn(L: Loaded, t: TaskRow): string[] {
  const all = [...new Set(t.assignee_ids)];
  const eds = all.filter((m) => { const r = L.members.get(m)?.role; return !r || r === 'editor'; });
  return eds.length ? eds : all;
}

/**
 * Everyone on the board: a site account matched by Timeliner email; else one with the same name (their emails
 * differ: flagged); else, from Timeliner alone, flagged as not on the site (with their place and hours from
 * Settings → Editors when their name is there). Editors on the site with nothing in Timeliner get a quiet note.
 */
function peopleOf(L: Loaded): Person[] {
  const work = new Map<string, { all: number; open: number }>();
  for (const t of L.tasks) {
    const open = videoState(t.status_group) !== 'approved';
    for (const m of new Set(t.assignee_ids)) {
      const w = work.get(m) ?? { all: 0, open: 0 };
      w.all++;
      if (open) w.open++;
      work.set(m, w);
    }
  }
  const users = new Map(L.users.map((u) => [u.id, u]));
  const byUser = new Map<number, Person>();
  const siteOf = (u: UserSummary): Person => {
    let p = byUser.get(u.id);
    if (!p) {
      p = { key: `u${u.id}`, userId: u.id, linked: false, memberIds: [], name: u.name, city: u.city, timezone: u.timezone, workHours: u.workHours, flag: null, card: true };
      byUser.set(u.id, p);
    }
    return p;
  };
  const mostWork = (a: string, b: string) => (work.get(b)?.all ?? 0) - (work.get(a)?.all ?? 0) || a.localeCompare(b);

  // by email: as the Editor Home and the taps match them
  for (const [m, uid] of [...L.userOf].sort(([a], [b]) => mostWork(a, b))) {
    const u = users.get(uid);
    if (!u || !work.has(m)) continue;
    const p = siteOf(u);
    p.linked = true;
    p.memberIds.push(m);
  }

  // the rest of Timeliner's people with videos: by name to someone on the site with no Timeliner work under their
  // email, or to Settings → Editors; else only in Timeliner. A name two people share here matches nobody
  const siteByName = new Map<string, UserSummary | null>();
  for (const u of L.users) { const k = personKey(u.name); siteByName.set(k, siteByName.has(k) ? null : u); }
  const offSite = new Map<string, Loaded['offSite'][number]>();
  for (const e of L.offSite) if (!offSite.has(personKey(e.name))) offSite.set(personKey(e.name), e);
  const others: Person[] = [];
  for (const m of [...work.keys()].filter((x) => !L.userOf.has(x)).sort(mostWork)) {
    const who = L.members.get(m);
    const email = who?.email ?? null;
    const name = who?.name ?? email ?? 'Someone in Timeliner';
    const k = who?.name ? personKey(who.name) : null;
    // someone who left Timeliner with only finished videos there: nothing to fix, nothing to show
    const gone = who?.active === false && !(work.get(m)?.open ?? 0);
    const u = k && !gone ? siteByName.get(k) : undefined;
    if (u && !byUser.get(u.id)?.linked) {
      const p = siteOf(u);
      p.memberIds.push(m);
      p.flag ??= {
        kind: 'email_differs', timelinerEmail: email, siteEmail: u.email,
        text: `Their email here (${u.email}) differs from Timeliner (${email ?? 'none'}) — change one so they match`,
      };
      continue;
    }
    const e = k ? offSite.get(k) : undefined;
    const tlEmail = email ?? 'the email they use in Timeliner';
    others.push({
      key: `m${m}`, userId: null, linked: false, memberIds: [m], name,
      city: e?.city ?? null, timezone: e?.timezone ?? null, workHours: e?.workHours ?? null,
      flag: e
        ? { kind: 'no_site_access', timelinerEmail: email, siteEmail: null, text: `Not on the site — give them site access in Settings → Editors with ${tlEmail}` }
        : { kind: 'not_on_site', timelinerEmail: email, siteEmail: null, text: `Not on the site — add them in Settings → Team as an Editor with ${tlEmail}` },
      card: !gone,
    });
  }

  // editors on the site with nothing in Timeliner (under their email, or their name)
  for (const u of L.users) {
    if (!isEditor(u.role) || byUser.has(u.id)) continue;
    siteOf(u).flag = { kind: 'nothing_assigned', timelinerEmail: null, siteEmail: u.email, text: `Nothing assigned in Timeliner (their Timeliner email must be ${u.email})` };
  }
  return [...byUser.values(), ...others];
}

/** The client a video is counted under on the board: the site's client, else its Timeliner brand (else none). */
function clientOfTask(L: Loaded, t: TaskRow): { key: string; name: string; clientId: number | null; brand: string | null } | null {
  const cid = t.client_id != null ? Number(t.client_id) : null;
  const brand = t.brand_id ? L.brands.get(t.brand_id) ?? null : null;
  if (cid != null && L.clients.has(cid)) return { key: `c${cid}`, name: L.clients.get(cid)!, clientId: cid, brand };
  if (t.brand_id && brand) return { key: `b${t.brand_id}`, name: brand, clientId: null, brand };
  return null;
}

/**
 * Everything about one person's videos: the Editors tab's card and their own Home are both made from it.
 * `clientKeys` names each of the card's clients (the same objects as `row.clients`), for the board's flags.
 */
function editorOf(L: Loaded, p: Person): { row: EditorRow; mine: MyEditing; clientKeys: Map<EditorClient, string> } {
  const weekAgo = L.now.getTime() - 7 * DAY_MS;
  const ids = new Set(p.memberIds);
  const own = L.tasks.filter((t) => t.assignee_ids.some((m) => ids.has(m)));
  // their taps and done marks: only from a site account with their Timeliner email
  const me = p.linked ? p.userId : null;
  const videos = own.map((t) => toVideo(L, t, me));
  const open = videos.filter((v) => v.state !== 'approved');
  const approvedWeek = videos.filter((v) => v.state === 'approved' && time(v.movedAt) >= weekAgo).sort((a, b) => newest(a.movedAt, b.movedAt));
  const plate = open.filter((v) => isOnPlate(v.state) && !v.doneAt);

  const f = me != null ? L.focus.get(me) : undefined;
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

  // the documents, each once: without a video's second link (that's one script's own version, not the batch's)
  const docs = new Map<string, ScriptDoc>();
  for (const v of [...(focus ? [focus.video] : []), ...revisions, ...toEdit]) if (v.script && !docs.has(v.script.href)) docs.set(v.script.href, { ...v.script, alt: null });
  const scripts = [...docs.values()];

  // the last video that left their plate: marked done here, moved on in Timeliner, or a titled video they put
  // straight into review (its raw clip is usually trashed then, so the titled video's name is the one to show)
  const titles = new Map(own.map((t) => [t.id, t.title]));
  const finished = [
    ...L.done.filter((d) => me != null && d.user_id === me && titles.has(d.task_id)).map((d) => ({ title: titles.get(d.task_id)!, at: iso(d.done_at)!, onSite: true })),
    ...own.filter((t) => !isOnPlate(videoState(t.status_group)) && t.left_plate_at).map((t) => ({ title: t.title, at: iso(t.left_plate_at)!, onSite: false })),
  ].sort((a, b) => newest(a.at, b.at));
  const last = finished[0] && isRawTitle(finished[0].title)
    ? finished.find((x) => !isRawTitle(x.title) && Math.abs(time(x.at) - time(finished[0].at)) <= 3600_000) ?? finished[0]
    : finished[0] ?? null;

  const plateCounts: EditorPlate = {
    toEdit: toEdit.length,
    rawToEdit: toEdit.filter((v) => v.raw).length,
    revisions: revisions.length,
    // marked done here: waiting on the managers, like the ones Timeliner has in review
    inReview: open.filter((v) => v.state === 'in_review' || v.doneAt).length,
    withClient: open.filter((v) => v.state === 'with_client').length,
    approvedWeek: approvedWeek.length,
  };
  const onCard = [...open, ...approvedWeek].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || byDue(a, b));

  // the clients whose videos are on the card, most first ("Joshua Shalimar · 32 videos")
  const shown = new Set(onCard.map((v) => v.id));
  const clients = new Map<string, EditorClient>();
  for (const t of own) {
    const c = shown.has(t.id) ? clientOfTask(L, t) : null;
    if (!c) continue;
    const e = clients.get(c.key) ?? { name: c.name, clientId: c.clientId, count: 0, split: null };
    e.count++;
    clients.set(c.key, e);
  }
  const row: EditorRow = {
    key: p.key, userId: p.userId, memberId: p.memberIds[0] ?? null, site: p.userId != null, flag: p.flag,
    clients: [...clients.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    name: p.name, city: p.city, timezone: p.timezone, workHours: p.workHours,
    offHours: !!(p.workHours && p.timezone && isValidTimeZone(p.timezone)) && !onShift(p.workHours!, p.timezone!, L.now),
    focus, nextUp, plate: plateCounts,
    dueToday: plate.filter((v) => v.due && v.due <= L.today).length,
    lastFinished: last,
    scripts,
    videos: onCard,
  };
  return { row, mine: { sync: L.sync, focus, nextUp, revisions, toEdit, waiting, approvedWeek, scripts }, clientKeys: new Map([...clients].map(([k, c]) => [c, k])) };
}

/** On a video and editing now (not one left running: isFocusStale) */
const editingNow = (e: EditorRow, now: Date) => e.focus?.state === 'on' && !isFocusStale(e.focus, e.offHours, now.getTime());

/** Editing now → paused (or left running) → due today → revisions → the rest; off hours last (unless they're editing now). */
const rank = (e: EditorRow, now: Date) => (editingNow(e, now) ? 0 : e.offHours ? 5 : e.focus ? 1 : e.dueToday ? 2 : e.plate.revisions ? 3 : 4);

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
/** First names, unless two in the list share one */
const shortNames = (names: string[]) => {
  const first = (n: string) => n.split(/\s+/)[0] || n;
  const seen = new Map<string, number>();
  for (const n of new Set(names)) seen.set(first(n), (seen.get(first(n)) ?? 0) + 1);
  return (n: string) => (seen.get(first(n))! > 1 ? n : first(n));
};

/** a client's editor is worked out from the videos made in this many days */
const CLIENT_EDITOR_DAYS = 60;

export async function loadBoard(ctx: Ctx): Promise<EditingBoard> {
  const L = await loadEditing(ctx);
  const people = peopleOf(L);
  const personOf = new Map<string, Person>();
  for (const p of people) for (const m of p.memberIds) personOf.set(m, p);
  const built = people.filter((p) => p.card).map((p) => editorOf(L, p));
  const editors = built.map((b) => b.row).sort((a, b) => rank(a, L.now) - rank(b, L.now) || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  const refOf = (p: Person, memberId: string): EditorRef => ({ name: p.name, userId: p.userId, memberId, key: p.key });

  // waiting on the managers: in review in Timeliner, or marked done here and not moved yet
  const waiting = new Set(L.tasks.filter((t) => videoState(t.status_group) === 'in_review').map((t) => t.id));
  for (const b of built) for (const v of b.mine.waiting) if (v.doneAt) waiting.add(v.id);

  // nobody given them yet: titled videos by folder, raw clips by the shoot they matched (else by folder)
  const recent = L.now.getTime() - NOT_ASSIGNED_DAYS * DAY_MS;
  const notAssigned = (t: TaskRow) => videoState(t.status_group) === 'to_edit' && !t.assignee_ids.length && !(t.created_at && time(t.created_at) < recent);
  type Group = {
    folder: string; clientName: string | null; raw: boolean; batch: EditingBoard['unassigned'][number]['batch']; titles: string[]; due: ISODate | null;
    docs: Map<string, ScriptDoc>; brand: string | null; clientKey: string | null;
  };
  const groups = new Map<string, Group>();
  for (const t of L.tasks) {
    if (!notAssigned(t)) continue;
    const clientName = t.client_id != null ? L.clients.get(Number(t.client_id)) ?? null : null;
    const raw = isRawTitle(t.title);
    const batchId = t.batch_id != null ? Number(t.batch_id) : null;
    const b = batchId != null ? L.batches.get(batchId) : undefined;
    const byShoot = raw && b && batchId != null;
    const key = byShoot ? `raw|b${batchId}` : `${raw ? 'raw' : 'titled'}|${t.folder ?? ''}|${t.client_id ?? ''}`;
    const c = clientOfTask(L, t);
    const g = groups.get(key) ?? {
      folder: t.folder ?? clientName ?? c?.name ?? 'Timeliner', clientName, raw,
      batch: byShoot ? { id: batchId, title: b.title, shootDate: b.shootDate } : null,
      titles: [], due: null, docs: new Map<string, ScriptDoc>(), brand: c?.brand ?? null, clientKey: c?.key ?? null,
    };
    g.titles.push(t.title);
    const due = t.internal_deadline ?? t.external_deadline;
    if (due && (!g.due || due < g.due)) g.due = due;
    // the document whoever is given it will cut from, as the editors' cards show it
    const doc = scriptFor(L, b ? batchId : null, t.script_number).script;
    if (doc && !g.docs.has(doc.href)) g.docs.set(doc.href, { ...doc, alt: null });
    groups.set(key, g);
  }

  // each client's editor (one editor per client): whoever has the most of its videos made in the last 60 days
  // (a tie: whoever had one most recently), and who has its open videos
  type Acc = {
    key: string; name: string; clientId: number | null; brand: string | null; open: number; notAssigned: number; rawNotAssigned: number;
    made: Map<string, { count: number; last: number; members: Map<string, number> }>; openBy: Map<string, { count: number; members: Map<string, number> }>;
  };
  const accs = new Map<string, Acc>();
  const since = L.now.getTime() - CLIENT_EDITOR_DAYS * DAY_MS;
  const tally = (m: Map<string, number>, id: string) => m.set(id, (m.get(id) ?? 0) + 1);
  for (const t of L.tasks) {
    const c = clientOfTask(L, t);
    if (!c) continue;
    const a = accs.get(c.key) ?? { ...c, open: 0, notAssigned: 0, rawNotAssigned: 0, made: new Map(), openBy: new Map() };
    accs.set(c.key, a);
    a.brand ??= c.brand;
    const isOpen = videoState(t.status_group) !== 'approved';
    if (isOpen) a.open++;
    if (notAssigned(t)) { a.notAssigned++; if (isRawTitle(t.title)) a.rawNotAssigned++; }
    // each person once per video, whichever of their Timeliner accounts it's on
    const byPerson = new Map<string, string>();
    for (const m of editorsOn(L, t)) { const p = personOf.get(m); if (p && !byPerson.has(p.key)) byPerson.set(p.key, m); }
    const made = time(t.created_at);
    for (const [pk, m] of byPerson) {
      if (isOpen) {
        const o = a.openBy.get(pk) ?? { count: 0, members: new Map<string, number>() };
        o.count++; tally(o.members, m);
        a.openBy.set(pk, o);
      }
      if (made >= since) {
        const r = a.made.get(pk) ?? { count: 0, last: 0, members: new Map<string, number>() };
        r.count++; r.last = Math.max(r.last, made); tally(r.members, m);
        a.made.set(pk, r);
      }
    }
  }
  const byKey = new Map(people.map((p) => [p.key, p]));
  const topMember = (m: Map<string, number>) => [...m].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0][0];
  const clients: ClientEditing[] = [...accs.values()]
    .map((a): ClientEditing => {
      const top = [...a.made].sort(([ka, x], [kb, y]) => y.count - x.count || y.last - x.last || byKey.get(ka)!.name.localeCompare(byKey.get(kb)!.name))[0];
      const editor = top ? refOf(byKey.get(top[0])!, topMember(top[1].members)) : null;
      const split = a.openBy.size > 1
        ? [...a.openBy].map(([pk, o]) => ({ ...refOf(byKey.get(pk)!, topMember(o.members)), count: o.count })).sort((x, y) => y.count - x.count || x.name.localeCompare(y.name))
        : [];
      const short = shortNames([...split.map((x) => x.name), ...(editor ? [editor.name] : [])]);
      const flags: string[] = [];
      if (split.length) flags.push(`${a.name}: ${split.map((x) => `${x.count} with ${short(x.name)}`).join(', ')} — one editor per client`);
      if (a.notAssigned) {
        const word = a.rawNotAssigned === a.notAssigned ? 'clip' : 'video';
        flags.push(`${a.name} · ${plural(a.notAssigned, word)} not assigned${editor ? ` (usually ${short(editor.name)})` : ''}`);
      }
      return { key: a.key, name: a.name, clientId: a.clientId, brand: a.brand, editor, open: a.open, notAssigned: a.notAssigned, split, flags };
    })
    .filter((c) => c.open > 0 || c.notAssigned > 0 || c.editor)
    .sort((a, b) => b.open - a.open || a.name.localeCompare(b.name));
  const clientByKey = new Map(clients.map((c) => [c.key, c]));

  // on each card, a client whose open videos are split across editors (this one among them) carries its flag
  for (const b of built) {
    for (const [c, k] of b.clientKeys) {
      const whole = clientByKey.get(k);
      if (whole?.split.some((x) => x.key === b.row.key)) c.split = whole.flags[0];
    }
  }

  const unassigned = [...groups.values()]
    .map((g) => ({
      folder: g.folder, clientName: g.clientName, count: g.titles.length, raw: g.raw, batch: g.batch, titles: compressTitles(g.titles), due: g.due,
      videoTitles: [...g.titles].sort((a, b) => titleOrder(a) - titleOrder(b) || a.localeCompare(b)),
      scripts: [...g.docs.values()],
      brand: g.brand,
      // whom to give them: their client's editor
      suggested: g.clientKey ? clientByKey.get(g.clientKey)?.editor ?? null : null,
    }))
    .sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.folder.localeCompare(b.folder) || Number(a.raw) - Number(b.raw));

  // kept for older screens: Timeliner's people with open videos and no site account with their email
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

  // over everyone's work, each video once (a video two people share is one video). What a manager can act on (not
  // matched, to check) is what's on the cards, which they can pin from Videos: everyone with videos has one.
  const onCards = [...new Map(editors.flatMap((e) => e.videos).map((v) => [v.id, v])).values()];
  const plates = built.flatMap((b) => [...b.mine.revisions, ...b.mine.toEdit]);
  return {
    sync: L.sync,
    totals: {
      editingNow: editors.filter((e) => editingNow(e, L.now)).length,
      paused: editors.filter((e) => e.focus?.state === 'paused').length,
      dueToday: new Set(plates.filter((v) => v.due && v.due <= L.today).map((v) => v.id)).size,
      revisions: new Set(plates.filter((v) => v.state === 'revisions').map((v) => v.id)).size,
      waitingOnYou: waiting.size,
      notAssigned: unassigned.reduce((n, g) => n + g.count, 0),
      notMatched: onCards.filter(isNotMatched).length,
      toCheck: onCards.filter(needsCheck).length,
    },
    editors,
    unassigned,
    clients,
    unknownAssignees: [...unknown.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  };
}

export async function loadMine(ctx: Ctx, me: Me): Promise<MyEditing> {
  const L = await loadEditing(ctx);
  const u = L.users.find((x) => x.id === me.id);
  // their videos: the ones given in Timeliner to their email here, as their taps check
  const person: Person = {
    key: `u${me.id}`, userId: me.id, linked: true, memberIds: [...L.userOf].filter(([, id]) => id === me.id).map(([m]) => m),
    name: me.name, city: u?.city ?? null, timezone: u?.timezone ?? null, workHours: u?.workHours ?? null, flag: null, card: true,
  };
  const mine = editorOf(L, person).mine;
  // the match note is the managers' (it can name a manager, another editor or another client): never sent here
  const own = (v: EditingVideo): EditingVideo => ({ ...v, match: { ...v.match, note: null } });
  return {
    ...mine,
    focus: mine.focus && { ...mine.focus, video: own(mine.focus.video) },
    nextUp: mine.nextUp && own(mine.nextUp),
    revisions: mine.revisions.map(own), toEdit: mine.toEdit.map(own), waiting: mine.waiting.map(own), approvedWeek: mine.approvedWeek.map(own),
  };
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

// ── the scripts PDF an editor opens ──────────────────────────────────────

/**
 * Timeliner's download links, by PDF and file, kept in this server's memory until ten minutes before they expire:
 * never stored, logged or sent in a payload (a restart just fetches them again).
 */
const pdfLinks = new WeakMap<TimelinerApi, Map<string, { url: string; until: number }>>();
const LINK_SPARE_MS = 10 * 60_000;

/** A fresh download link for a batch's scripts PDF (its newest version), from Timeliner. Needs only Tasks (read). */
async function scriptPdfLink(ctx: Ctx, batchId: number): Promise<string> {
  const p = await ctx.db.one<{ key: string; file_id: string | null }>(
    `select p.key, p.file_id from timeliner_pdfs p
      where p.batch_id = $1 and p.gone_at is null and p.kind = 'task' and ${DELIVERED_BY_PDF}
      order by p.latest_at desc, p.key limit 1`, [batchId],
  );
  if (!p) throw notFound('Scripts PDF');
  const api = ctx.timeliner;
  if (!api) throw new HttpError(502, 'Timeliner isn’t connected here, so its scripts PDF can’t be opened. Open the site’s document instead.');
  const cache = pdfLinks.get(api) ?? new Map<string, { url: string; until: number }>();
  pdfLinks.set(api, cache);
  const now = ctx.now().getTime();
  const hit = p.file_id ? cache.get(`${p.key}|${p.file_id}`) : undefined;
  if (hit && hit.until > now) return hit.url;
  let media: TimelinerMedia | null | undefined;
  try {
    media = (await api.task(p.key))?.media;
  } catch (err) {
    if (err instanceof TimelinerError) throw new HttpError(502, `Timeliner didn’t give the scripts PDF back: ${err.message}`);
    throw err;
  }
  const url = media && !media.purgedAt && typeof media.downloadUrl === 'string' && /^https:\/\//i.test(media.downloadUrl)
    && isScriptDocument(typeof media.name === 'string' ? media.name : '', typeof media.mimeType === 'string' ? media.mimeType : null) ? media.downloadUrl : null;
  if (!media || !url) throw new HttpError(502, 'Timeliner has no PDF to download on that task right now. Open the site’s document instead.');
  const until = Date.parse(media.expiresAt ?? '') - LINK_SPARE_MS;
  if (Number.isFinite(until) && until > now) {
    for (const [k, v] of cache) if (v.until <= now) cache.delete(k);
    cache.set(`${p.key}|${media.fileId}`, { url, until });
  }
  return url;
}

const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The page a browser tab shows when the scripts PDF can't be opened: why, and the way back to the site's documents. */
function pdfErrorPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scripts PDF</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:48px 20px;background:#f7f7f5;color:#1d1d1b}
main{max-width:480px;margin:0 auto}h1{font-size:20px;margin:0 0 8px}p{margin:0 0 16px;color:#4a4a46}a{color:#1d4ed8}
@media (prefers-color-scheme:dark){body{background:#151514;color:#ededea}p{color:#b4b4ae}a{color:#93b4ff}}</style></head>
<body><main><h1>The scripts PDF couldn’t be opened</h1><p>${escapeHtml(message)}</p>
<p><a href="/">Back to your videos</a>. The site’s own documents for finished scripts are there under Ready to edit, and in the <a href="/scripts">Script bank</a>.</p></main></body></html>`;
}

// ── pins: a manager says which batch a video is from ─────────────────────

/** Pins a video to a batch (and maybe a script), or to no batch, and matches the copy again at once. */
async function pinVideo(ctx: Ctx, me: Me, taskId: string, batchId: number | null, number: number | null): Promise<void> {
  await ctx.db.tx(async (t) => {
    await t.query(`select pg_advisory_xact_lock(${LOCKS.timeliner})`);
    const task = await t.one<{ title: string; client_id: number | null }>(`select title, client_id from timeliner_tasks where id = $1`, [taskId]);
    if (!task) throw notFound('Video');
    let b: { title: string; client_id: number } | undefined;
    if (batchId != null) {
      b = await t.one<{ title: string; client_id: number }>(`select title, client_id from batches where id = $1`, [batchId]);
      if (!b) throw notFound('Batch');
      // a batch of the video's client (any client's, while it has none)
      if (task.client_id != null && Number(task.client_id) !== Number(b.client_id)) {
        const client = (await t.one<{ name: string }>(`select name from clients where id = $1`, [task.client_id]))?.name ?? 'the video’s client';
        throw new HttpError(400, `${b.title} isn’t a batch of ${client}. Pick one of theirs.`, { batchId: `Pick a batch of ${client}` });
      }
      if (number != null && !(await t.one(`select 1 from scripts where batch_id = $1 and number = $2 and removed_at is null`, [batchId, number]))) {
        throw new HttpError(400, `${b.title} has no script ${number}.`, { scriptNumber: `${b.title} has no script ${number}` });
      }
    } else if (number != null) {
      throw new HttpError(400, 'Pick the batch the script is in.', { scriptNumber: 'Pick the batch the script is in' });
    }
    await t.query(
      `insert into timeliner_video_pins (task_id, batch_id, script_number, set_by, set_at) values ($1, $2, $3, $4, $5)
       on conflict (task_id) do update set batch_id = excluded.batch_id, script_number = excluded.script_number, set_by = excluded.set_by, set_at = excluded.set_at`,
      [taskId, batchId, number, me.id, ctx.now().toISOString()],
    );
    await rematch(t, ctx.now());
    await logActivity(t, {
      actor: me, action: 'video.pinned', entityType: 'video', batchId, clientId: b ? Number(b.client_id) : task.client_id,
      summary: b ? `Pinned the video “${task.title}” to ${b.title}${number != null ? `, script ${number}` : ''}` : `Pinned the video “${task.title}” as not from any batch`,
      detail: { taskId, scriptNumber: number },
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
    await syncTimeliner(ctx.db, ctx.timeliner, ctx.now(), (m) => req.log.warn(m));
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

  // a batch's scripts PDF from Timeliner, its newest version: a fresh link each time (managers, and whoever has a
  // video from that batch in Timeliner). The link is Timeliner's, so it's never kept or sent anywhere but here.
  app.get('/api/editing/script-pdf/:batchId', async (req, reply) => {
    try {
      const me = requireUser(req);
      const { batchId } = parse(z.object({ batchId: zs.id }), req.params);
      if (!isManager(me.role)) {
        const theirs = await ctx.db.one(
          `select 1 from timeliner_tasks tt join timeliner_members m on m.id = any(tt.assignee_ids)
            where tt.batch_id = $1 and lower(m.email) = lower($2) limit 1`, [batchId, me.email],
        );
        if (!theirs) throw forbidden('That scripts PDF is for videos that aren’t assigned to you in Timeliner.');
      }
      const url = await scriptPdfLink(ctx, batchId);
      // the link expires: the browser asks again next time
      void reply.header('cache-control', 'no-store');
      return await reply.redirect(url, 302);
    } catch (err) {
      // opened in a new tab: a page that says what went wrong and leads back, not the API's JSON
      if (err instanceof HttpError && /\btext\/html\b/i.test(String(req.headers.accept ?? ''))) {
        return reply.status(err.status).header('cache-control', 'no-store')
          .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
          .type('text/html; charset=utf-8').send(pdfErrorPage(err.message));
      }
      throw err;
    }
  });

  // Wrong shoot? A manager pins the video to a batch (and maybe a script), or to no batch; a read never undoes it
  const pinParams = z.object({ id: z.string().trim().min(1).max(200) });
  app.post('/api/editing/videos/:id/pin', async (req): Promise<EditingBoard> => {
    const me = requireManager(req);
    const { id } = parse(pinParams, req.params);
    const input = parse(z.object({
      batchId: zs.id.nullable(),
      scriptNumber: z.coerce.number().int().positive().max(500).nullable().optional(),
    }), req.body);
    await pinVideo(ctx, me, id, input.batchId, input.scriptNumber ?? null);
    return loadBoard(ctx);
  });

  app.delete('/api/editing/videos/:id/pin', async (req): Promise<EditingBoard> => {
    const me = requireManager(req);
    const { id } = parse(pinParams, req.params);
    await ctx.db.tx(async (t) => {
      await t.query(`select pg_advisory_xact_lock(${LOCKS.timeliner})`);
      const task = await t.one<{ title: string; client_id: number | null }>(`select title, client_id from timeliner_tasks where id = $1`, [id]);
      if (!task) throw notFound('Video');
      const gone = await t.query(`delete from timeliner_video_pins where task_id = $1 returning task_id`, [id]);
      if (!gone.length) return;
      await rematch(t, ctx.now());
      await logActivity(t, { actor: me, action: 'video.unpinned', entityType: 'video', clientId: task.client_id, summary: `Took the pin off the video “${task.title}”: it’s matched by date again`, detail: { taskId: id } });
    });
    return loadBoard(ctx);
  });
}
