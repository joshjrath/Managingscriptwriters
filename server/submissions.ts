// Scripts sent as one document.
//
// A writer sends a PDF or a Google Drive/Docs link covering a set of their
// scripts (normally all of their share). Managers review the document as a
// whole: approve it, send it back with a note (and optionally their marked-up
// PDF or edited doc), or approve with their edits. Script records stay the
// source of truth for progress; documents and reviews say which scripts they
// cover. A script's "current" document is the latest one it was sent in.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from './db';
import { clockFor, loadBatches, loadUsers, logActivity, managerIds, notify, type Ctx } from './core';
import { requireManager, requireUser } from './auth';
import { conflict, forbidden, HttpError, notFound, parse, zs } from './http';
import { loadRevisions, loadScripts } from './records';
import { spool, storeFile, type UploadedFile } from './files';
import { applyScriptAction, loadBatchDetail } from './routes/batches';
import { canSendDocument, compressRanges, documentState, isManager, type DocumentState, type ScriptStatus } from '../shared/workflow';
import type { BatchSummary, Me, ReviewGroup, ReviewQueue, ReviewRecord, Submission, SubmissionState } from '../shared/types';

/** A document's state in the batch payload's words (the Script bank uses documentState's own). */
const SUBMISSION_STATE: Record<DocumentState, SubmissionState> = {
  in_review: 'in_review', revisions: 'revisions_requested', approved: 'approved', delivered: 'delivered', in_progress: 'withdrawn',
};

const inList = (ids: number[], params: unknown[]) => ids.map((id) => { params.push(id); return `$${params.length}`; }).join(',');

// ── files and form parsing ───────────────────────────────────────────────

/** Reads either a JSON body or a multipart form with at most one file (spooled to disk, not memory). */
export async function readForm(req: FastifyRequest, limitBytes: number): Promise<{ fields: Record<string, unknown>; file: UploadedFile | null }> {
  if (!req.isMultipart()) return { fields: (req.body as Record<string, unknown>) ?? {}, file: null };
  const fields: Record<string, unknown> = {};
  let file: UploadedFile | null = null;
  for await (const part of req.parts({ limits: { fileSize: limitBytes, files: 1 } })) {
    if (part.type === 'file') file = await spool(req, part, limitBytes);
    else fields[part.fieldname] = String(part.value ?? '');
  }
  return { fields, file };
}

const jsonField = (v: unknown) => {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
};
const emptyToNull = (v: unknown) => (v === '' || v === undefined ? null : v);

function docLabel(url: string | null, file: UploadedFile | null): string {
  if (file) return file.filename;
  try {
    const u = new URL(url!);
    if (/docs\.google\.com/.test(u.host)) return 'Google Doc';
    if (/drive\.google\.com/.test(u.host)) return 'Google Drive file';
    return u.host.replace(/^www\./, '');
  } catch { return 'link'; }
}

// ── loading documents, reviews and groups ────────────────────────────────

interface SubmissionData {
  submissions: (Submission & { scriptIds: number[]; currentIds: number[] })[];
  reviews: ReviewRecord[];
  /** script id → id of its latest document */
  latest: Map<number, number>;
}

export async function loadSubmissionData(db: Db, batchIds: number[]): Promise<SubmissionData> {
  const empty = { submissions: [], reviews: [], latest: new Map<number, number>() };
  if (!batchIds.length) return empty;
  const p: unknown[] = [];
  const subs = await db.query<{
    id: number; batch_id: number; writer_id: number | null; writer_name: string | null; submitted_by_name: string; version: number;
    previous_id: number | null; url: string | null; file_id: number | null; file_name: string | null; file_size: number | null; note: string | null; created_at: string;
  }>(
    `select s.id, s.batch_id, s.writer_id, w.name as writer_name, sb.name as submitted_by_name, s.version, s.previous_id, s.url, s.file_id,
            f.filename as file_name, f.size as file_size, s.note, s.created_at
       from submissions s join users sb on sb.id = s.submitted_by left join users w on w.id = s.writer_id left join files f on f.id = s.file_id
      where s.batch_id in (${inList(batchIds, p)}) order by s.id`, p,
  );
  const p2: unknown[] = [];
  const numbers = new Map((await db.query<{ id: number; number: number; status: ScriptStatus; removed_at: string | null }>(
    `select id, number, status, removed_at from scripts where batch_id in (${inList(batchIds, p2)})`, p2,
  )).map((r) => [r.id, r]));
  const p3: unknown[] = [];
  const revs = await db.query<{
    id: number; batch_id: number; submission_id: number | null; action: 'approved' | 'revisions'; script_ids: number[] | string; note: string | null;
    url: string | null; file_id: number | null; file_name: string | null; file_size: number | null; reviewed_by_name: string; created_at: string;
  }>(
    `select r.id, r.batch_id, r.submission_id, r.action, r.script_ids, r.note, r.url, r.file_id, f.filename as file_name, f.size as file_size,
            u.name as reviewed_by_name, r.created_at
       from reviews r join users u on u.id = r.reviewed_by left join files f on f.id = r.file_id
      where r.batch_id in (${inList(batchIds, p3)}) order by r.id`, p3,
  );
  // which scripts each decision covered, by id (numbers repeat from batch to batch)
  const reviewScripts = new Map<number, Set<number>>();
  const reviews: ReviewRecord[] = revs.map((r) => {
    const ids = typeof r.script_ids === 'string' ? (JSON.parse(r.script_ids) as number[]) : r.script_ids;
    reviewScripts.set(r.id, new Set(ids.map(Number)));
    return {
      id: r.id, batchId: r.batch_id, submissionId: r.submission_id, action: r.action, note: r.note, url: r.url, fileId: r.file_id,
      fileName: r.file_name, fileSize: r.file_size, reviewedByName: r.reviewed_by_name, createdAt: r.created_at,
      scriptNumbers: ids.map((id) => numbers.get(id)?.number).filter((n): n is number => n != null).sort((a, b) => a - b),
    };
  });
  if (!subs.length) return { ...empty, reviews };
  const p4: unknown[] = [];
  const links = await db.query<{ submission_id: number; script_id: number }>(
    `select submission_id, script_id from submission_scripts where submission_id in (${inList(subs.map((s) => s.id), p4)})`, p4,
  );
  const latest = new Map<number, number>();
  const bySub = new Map<number, number[]>();
  for (const l of links) {
    if (numbers.get(l.script_id)?.removed_at) continue;
    bySub.set(l.submission_id, [...(bySub.get(l.submission_id) ?? []), l.script_id]);
    if ((latest.get(l.script_id) ?? 0) < l.submission_id) latest.set(l.script_id, l.submission_id);
  }
  const submissions = subs.map((s) => {
    const scriptIds = bySub.get(s.id) ?? [];
    const currentIds = scriptIds.filter((id) => latest.get(id) === s.id);
    const counts = { inReview: 0, approved: 0, delivered: 0, revisions: 0, notSubmitted: 0 };
    for (const id of currentIds) {
      const st = numbers.get(id)!.status;
      if (st === 'ready_for_review') counts.inReview++;
      else if (st === 'approved') counts.approved++;
      else if (st === 'delivered') counts.delivered++;
      else if (st === 'revisions_needed') counts.revisions++;
      else counts.notSubmitted++;
    }
    const state: SubmissionState = !currentIds.length ? 'superseded' : SUBMISSION_STATE[documentState(currentIds.map((id) => numbers.get(id)!.status))];
    const num = (ids: number[]) => ids.map((id) => numbers.get(id)!.number).sort((a, b) => a - b);
    // the send-back this document answers: the latest one on these same scripts (same batch, by id)
    // before it was sent, provided no earlier document already answered it
    const mine = new Set(scriptIds.map(Number));
    const sentAt = new Date(s.created_at).getTime();
    const covers = (r: ReviewRecord) => r.batchId === s.batch_id && [...(reviewScripts.get(r.id) ?? [])].some((id) => mine.has(id));
    let fb = [...reviews].reverse().find((r) => r.action === 'revisions' && covers(r) && new Date(r.createdAt).getTime() <= sentAt);
    if (fb) {
      const at = new Date(fb.createdAt).getTime();
      const answered = subs.some((x) => x.id !== s.id && x.id < s.id && x.batch_id === s.batch_id && new Date(x.created_at).getTime() >= at
        && (bySub.get(x.id) ?? []).some((id) => mine.has(Number(id))));
      if (answered) fb = undefined;
    }
    return {
      afterFeedback: fb ? { note: fb.note, byName: fb.reviewedByName, at: fb.createdAt } : null,
      id: s.id, batchId: s.batch_id, writerId: s.writer_id, writerName: s.writer_name, submittedByName: s.submitted_by_name, version: s.version,
      previousId: s.previous_id, url: s.url, fileId: s.file_id, fileName: s.file_name, fileSize: s.file_size, note: s.note, createdAt: s.created_at,
      scriptNumbers: num(scriptIds), currentNumbers: num(currentIds), counts, state,
      reviews: reviews.filter((r) => r.submissionId === s.id),
      scriptIds, currentIds,
    };
  });
  return { submissions, reviews, latest };
}

const publicSubmission = ({ scriptIds: _a, currentIds: _b, ...s }: SubmissionData['submissions'][number]): Submission => s;

/**
 * Groups scripts the way people review them: everything waiting in the same
 * document together, and everything sent back in the same decision together.
 */
export async function buildGroups(db: Db, summaries: BatchSummary[], opts: { assigneeId?: number } = {}): Promise<{ groups: ReviewGroup[]; data: SubmissionData }> {
  const byId = new Map(summaries.map((b) => [b.id, b]));
  const batchIds = summaries.map((b) => b.id);
  const data = await loadSubmissionData(db, batchIds);
  if (!batchIds.length) return { groups: [], data };
  const scripts = await loadScripts(db, { batchIds, assigneeId: opts.assigneeId, statuses: ['ready_for_review', 'revisions_needed'] });
  const open = await loadRevisions(db, { openOnly: true, batchIds });
  const openByScript = new Map<number, (typeof open)[number]>();
  for (const r of open) if (!openByScript.has(r.scriptId)) openByScript.set(r.scriptId, r); // newest first
  const subById = new Map(data.submissions.map((s) => [s.id, s]));
  const reviewById = new Map(data.reviews.map((r) => [r.id, r]));
  const users = new Map((await loadUsers(db)).map((u) => [u.id, u.name]));
  const groups = new Map<string, ReviewGroup>();
  for (const s of scripts) {
    const subId = data.latest.get(s.id);
    const sub = subId ? subById.get(subId) : undefined;
    let key: string;
    let review: ReviewRecord | null = null;
    let since: string | null;
    if (s.status === 'ready_for_review') {
      key = sub ? `w-s${sub.id}` : `w-b${s.batchId}-u${s.assigneeId ?? 0}`;
      since = sub?.createdAt ?? s.submittedAt;
    } else {
      const rr = openByScript.get(s.id);
      review = rr?.reviewId ? reviewById.get(rr.reviewId) ?? null : null;
      key = `r-${review ? review.id : `${s.batchId}-${rr?.requestedAt ?? ''}-${rr?.note ?? ''}`}-u${s.assigneeId ?? 0}`;
      since = review?.createdAt ?? rr?.requestedAt ?? null;
      if (!review && rr) {
        // older revision requests made before reviews were recorded
        review = { id: 0, batchId: s.batchId, submissionId: sub?.id ?? null, action: 'revisions', scriptNumbers: [], note: rr.note, reviewedByName: rr.requestedByName, createdAt: rr.requestedAt, url: null, fileId: null, fileName: null, fileSize: null };
      }
    }
    let g = groups.get(key);
    if (!g) {
      g = {
        key, kind: s.status === 'ready_for_review' ? 'waiting' : 'sent_back', batch: byId.get(s.batchId)!,
        writerId: s.assigneeId, writerName: s.assigneeId ? users.get(s.assigneeId) ?? 'Unknown' : 'Unassigned',
        submission: sub ? publicSubmission(sub) : null, review, scripts: [], since,
      };
      groups.set(key, g);
    }
    g.scripts.push(s);
  }
  const list = [...groups.values()];
  const due = (g: ReviewGroup) => g.batch.finalDue ?? '9999';
  list.sort((a, b) => due(a).localeCompare(due(b)) || (a.since ?? '').localeCompare(b.since ?? ''));
  return { groups: list, data };
}

export async function loadReviewQueue(ctx: Ctx): Promise<ReviewQueue> {
  const clock = await clockFor(ctx);
  const { summaries } = await loadBatches(ctx, {}, clock);
  const { groups } = await buildGroups(ctx.db, summaries);
  return { waiting: groups.filter((g) => g.kind === 'waiting'), sentBack: groups.filter((g) => g.kind === 'sent_back') };
}

export { publicSubmission };

// ── sending scripts as one document ──────────────────────────────────────

export interface SendInput {
  scriptIds: number[];
  url: string | null;
  file: UploadedFile | null;
  note: string | null;
  titles: { number: number; title: string | null }[];
}

export async function sendDocument(ctx: Ctx, me: Me, batchId: number, input: SendInput): Promise<{ submissionId: number; sent: number[]; replaced: number[] }> {
  if (!input.url && !input.file) throw new HttpError(400, 'Upload the PDF or paste the link to your document', { document: 'Upload the PDF or paste the link to your document' });
  const ids = [...new Set(input.scriptIds)];
  if (!ids.length) throw new HttpError(400, 'Choose which scripts this document covers', { scriptIds: 'Choose which scripts this document covers' });
  return ctx.db.tx(async (t) => {
    // the upload first, before anything is locked, so other changes to this batch don't wait on a big
    // file (as the review route does); a check below that fails rolls it back with everything else
    const fileId = input.file ? await storeFile(t, me, input.file) : null;
    // the batch row before its scripts, as in applyScriptAction
    const b = await t.one<{ client_id: number; title: string; archived_at: string | null }>(`select client_id, title, archived_at from batches where id = $1 for no key update`, [batchId]);
    if (!b) throw notFound('Batch');
    const p: unknown[] = [batchId];
    const rows = await t.query<{ id: number; number: number; status: ScriptStatus; assignee_id: number | null; title: string | null }>(
      `select id, number, status, assignee_id, title from scripts where batch_id = $1 and removed_at is null and id in (${inList(ids, p)}) order by number for update`, p,
    );
    if (rows.length !== ids.length) throw conflict('Some of those scripts are no longer in this batch. Refresh and try again.');
    if (!isManager(me.role) && rows.some((r) => r.assignee_id !== me.id)) throw forbidden('You can only send scripts assigned to you');
    const done = rows.filter((r) => !canSendDocument(r.status));
    if (done.length) throw conflict(`Script${done.length > 1 ? 's' : ''} ${compressRanges(done.map((r) => r.number))} ${done.length > 1 ? 'are' : 'is'} already approved, so ${done.length > 1 ? 'they don’t' : 'it doesn’t'} need sending again.`);

    const p2: unknown[] = [];
    const prev = await t.one<{ id: number; version: number } | undefined>(
      `select s.id, s.version from submissions s where s.id = (select max(submission_id) from submission_scripts where script_id in (${inList(ids, p2)}))`, p2,
    );
    const writers = [...new Set(rows.map((r) => r.assignee_id))];
    const version = prev ? prev.version + 1 : 1;
    const sub = await t.one<{ id: number }>(
      `insert into submissions (batch_id, writer_id, submitted_by, version, previous_id, url, file_id, note) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [batchId, writers.length === 1 ? writers[0] : null, me.id, version, prev?.id ?? null, input.url, fileId, input.note],
    );
    const submissionId = sub!.id;
    for (const r of rows) await t.query(`insert into submission_scripts (submission_id, script_id) values ($1, $2)`, [submissionId, r.id]);

    const byNumber = new Map(rows.map((r) => [r.number, r]));
    for (const tt of input.titles) {
      const r = byNumber.get(tt.number);
      if (r && (r.title ?? null) !== (tt.title ?? null)) await t.query(`update scripts set title = $2, version = version + 1, updated_at = now() where id = $1`, [r.id, tt.title]);
    }

    const label = docLabel(input.url, input.file);
    const toSend = rows.filter((r) => r.status !== 'ready_for_review');
    const replaced = rows.filter((r) => r.status === 'ready_for_review');
    if (toSend.length) {
      await applyScriptAction({ ...ctx, db: t }, me, batchId, 'submit', toSend.map((r) => r.id), { note: null, timelinerUrl: null, submission: { id: submissionId, label, version } });
    } else {
      const nums = compressRanges(replaced.map((r) => r.number));
      await logActivity(t, { actor: me, action: 'submission.replaced', entityType: 'batch', entityId: batchId, batchId, clientId: b.client_id, summary: `Replaced the document for script${replaced.length > 1 ? 's' : ''} ${nums} with “${label}” (version ${version})` });
      await notify(t, await managerIds(t), { type: 'review_request', title: `New version · ${b.title}`, body: `${me.name} replaced the document for scripts ${nums} (“${label}”).`, link: '/review' }, me.id);
    }
    return { submissionId, sent: toSend.map((r) => r.id), replaced: replaced.map((r) => r.id) };
  });
}

// ── routes ───────────────────────────────────────────────────────────────

const titlesSchema = z.array(z.object({ number: z.coerce.number().int().positive(), title: z.string().trim().max(300).transform((v) => v || null).nullable() })).max(500).default([]);

export function registerSubmissionRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  app.post('/api/batches/:id/submissions', async (req) => {
    const me = requireUser(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const { fields, file } = await readForm(req, ctx.uploadLimitBytes);
    const input = parse(z.object({
      scriptIds: z.array(zs.id).min(1, 'Choose which scripts this document covers').max(500),
      url: zs.url,
      note: zs.text(4000),
      titles: titlesSchema,
    }), { scriptIds: jsonField(fields.scriptIds), url: emptyToNull(fields.url), note: emptyToNull(fields.note), titles: jsonField(fields.titles ?? '[]') });
    const out = await sendDocument(ctx, me, id, { scriptIds: input.scriptIds, url: input.url ?? null, file, note: input.note ?? null, titles: input.titles });
    return { ...out, batch: await loadBatchDetail(ctx, id, me) };
  });

  // one decision on a set of scripts: approve (optionally with the reviewer's edited version) or send back with a note
  app.post('/api/batches/:id/review', async (req) => {
    const me = requireManager(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const { fields, file } = await readForm(req, ctx.uploadLimitBytes);
    const input = parse(z.object({
      action: z.enum(['approve', 'revisions']),
      scriptIds: z.array(zs.id).min(1, 'Choose at least one script').max(500),
      note: zs.text(4000),
      url: zs.url,
      submissionId: zs.id.nullable().optional(),
    }), { action: fields.action, scriptIds: jsonField(fields.scriptIds), note: emptyToNull(fields.note), url: emptyToNull(fields.url), submissionId: emptyToNull(fields.submissionId) });
    if (input.action === 'revisions' && !input.note) throw new HttpError(400, 'Add a note so the writer knows what to change', { note: 'Add a note so the writer knows what to change' });
    // never decide on a version the reviewer hasn't seen: a newer document for any of these scripts wins
    if (input.submissionId) {
      const newer = await db.one<{ id: number; version: number; name: string | null }>(
        `select s.id, s.version, u.name from submission_scripts ss join submissions s on s.id = ss.submission_id
           left join users u on u.id = coalesce(s.writer_id, s.submitted_by)
          where ss.script_id = any($1::bigint[]) and s.id <> $2
            and (s.created_at, s.id) > (select created_at, id from submissions where id = $2)
          order by s.created_at desc, s.id desc limit 1`, [input.scriptIds, input.submissionId],
      );
      if (newer) throw conflict(`${newer.name ?? 'The writer'} sent a newer version (version ${newer.version}) of ${input.scriptIds.length === 1 ? 'this script' : 'these scripts'} a moment ago. The queue has been refreshed: open the new version before deciding.`, 'stale');
    }
    const result = await db.tx(async (t) => {
      const fileId = file ? await storeFile(t, me, file) : null;
      return applyScriptAction({ ...ctx, db: t }, me, id, input.action === 'approve' ? 'approve' : 'request_revisions', input.scriptIds, {
        note: input.note ?? null, timelinerUrl: null, review: { url: input.url ?? null, fileId, submissionId: input.submissionId ?? null },
      });
    });
    return { ...result, batch: await loadBatchDetail(ctx, id, me) };
  });

  // Undo a decision made a moment ago: approved or sent-back scripts go back to "in review", as if it
  // never happened. Only while nothing else has touched them, and only for 15 minutes.
  app.post('/api/reviews/:id/undo', async (req) => {
    const me = requireManager(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const out = await db.tx(async (t) => {
      const r = await t.one<{ batch_id: number; action: 'approved' | 'revisions'; script_ids: number[]; created_at: string; client_id: number; title: string }>(
        `select r.batch_id, r.action, r.script_ids, r.created_at, b.client_id, b.title from reviews r join batches b on b.id = r.batch_id where r.id = $1 for update of r`, [id],
      );
      if (!r) throw notFound('Decision');
      if (ctx.now().getTime() - new Date(r.created_at).getTime() > 15 * 60_000) throw new HttpError(409, 'It’s been more than 15 minutes, so this can’t be undone here. Use the batch page instead.', undefined, 'too_late');
      const ids = (Array.isArray(r.script_ids) ? r.script_ids : []).map(Number);
      const want = r.action === 'approved' ? 'approved' : 'revisions_needed';
      const rows = await t.query<{ id: number; number: number; status: ScriptStatus; assignee_id: number | null }>(
        `select id, number, status, assignee_id from scripts where id = any($1::bigint[]) and removed_at is null for update`, [ids],
      );
      if (rows.length !== ids.length || rows.some((x) => x.status !== want)) throw conflict('These scripts have changed since, so the decision can’t be undone. Refresh to see where they are now.', 'stale');
      const later = await t.one<{ id: number }>(
        `select id from reviews where batch_id = $1 and id > $2 and exists (select 1 from jsonb_array_elements_text(script_ids) x where x::bigint = any($3::bigint[])) limit 1`, [r.batch_id, id, ids],
      );
      if (later) throw conflict('There’s been another decision on these scripts since, so this one can’t be undone.', 'stale');
      await t.query(
        `update scripts set status = 'ready_for_review', approved_at = case when $2 then null else approved_at end, approved_by = case when $2 then null else approved_by end, version = version + 1, updated_at = now() where id = any($1::bigint[])`,
        [ids, r.action === 'approved'],
      );
      // the send-back requests it made go away; an approval re-opens the requests it resolved
      await t.query(`delete from revision_requests where review_id = $1`, [id]);
      if (r.action === 'approved') await t.query(`update revision_requests set resolved_at = null, resolved_by = null, resolution = null where resolution = 'approved' and resolved_at >= $2::timestamptz - interval '2 seconds' and script_id = any($1::bigint[])`, [ids, r.created_at]);
      // what the writers were told and shown about it, if they haven't seen it yet
      await t.query(`delete from notifications where review_id = $1 and read_at is null`, [id]);
      await t.query(`delete from moments where review_id = $1 and seen_at is null`, [id]);
      await t.query(`delete from reviews where id = $1`, [id]);
      const nums = compressRanges(rows.map((x) => x.number));
      await logActivity(t, {
        actor: me, action: 'scripts.undo_review', entityType: 'batch', entityId: r.batch_id, batchId: r.batch_id, clientId: r.client_id,
        summary: `Undid ${r.action === 'approved' ? 'the approval of' : 'sending back'} script${rows.length > 1 ? 's' : ''} ${nums}: back in review`,
      });
      return { batchId: r.batch_id, changed: ids };
    });
    return { ...out, batch: await loadBatchDetail(ctx, out.batchId, me) };
  });

  // titles for many scripts at once
  app.post('/api/batches/:id/titles', async (req) => {
    const me = requireUser(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const input = parse(z.object({ titles: titlesSchema }), req.body);
    const changed = await db.tx(async (t) => {
      const b = await t.one<{ client_id: number }>(`select client_id from batches where id = $1`, [id]);
      if (!b) throw notFound('Batch');
      const rows = await t.query<{ id: number; number: number; title: string | null; assignee_id: number | null }>(
        `select id, number, title, assignee_id from scripts where batch_id = $1 and removed_at is null`, [id],
      );
      const byNumber = new Map(rows.map((r) => [r.number, r]));
      const edits = input.titles.map((x) => ({ ...x, row: byNumber.get(x.number) })).filter((x) => x.row && (x.row.title ?? null) !== (x.title ?? null));
      if (!isManager(me.role) && edits.some((x) => x.row!.assignee_id !== me.id)) throw forbidden('You can only title scripts assigned to you');
      for (const e of edits) await t.query(`update scripts set title = $2, version = version + 1, updated_at = now() where id = $1`, [e.row!.id, e.title]);
      if (edits.length) {
        await logActivity(t, { actor: me, action: 'scripts.titled', entityType: 'batch', entityId: id, batchId: id, clientId: b.client_id, summary: `Updated titles for script${edits.length > 1 ? 's' : ''} ${compressRanges(edits.map((e) => e.number))}` });
      }
      return edits.length;
    });
    return { changed, batch: await loadBatchDetail(ctx, id, me) };
  });
}

