// Script bank: every document ever sent, across every client and batch.
// A document (a PDF or a link) covers a writer's scripts for a batch, like
// "#1–45", so it's one row, not 45. Each script is listed under the newest
// document it was sent in: when a writer resends only script 3 of a 1–3
// document, scripts 1–2 stay under the earlier one. Scripts that were
// finished without any document get a row of their own, so nothing finished
// is ever missing. The version a manager approved with edits is attached to
// the scripts it covers. Search matches the client, batch, writer, file
// name and note, and the numbers of the scripts inside, so "#12" finds the
// document script 12 is in.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from './db';
import { logActivity, type Ctx } from './core';
import { requireManager, requireUser } from './auth';
import { HttpError, notFound, parse, zs } from './http';
import { readForm } from './submissions';
import { storeFile } from './files';
import { compressRanges, documentState, isEditor, type ScriptStatus } from '../shared/workflow';
import type { Deliverable, ScriptBankPage } from '../shared/types';

interface SubRow {
  id: number; previous_id: number | null; version: number; url: string | null; file_id: number | null; file_name: string | null; note: string | null;
  created_at: string; writer_id: number | null; writer_name: string | null;
  batch_id: number; batch_title: string; batch_archived: boolean; client_id: number; client_name: string; shoot_id: number | null; shoot_date: string | null;
}
interface ScriptRow { submission_id: number; id: number; number: number; status: ScriptStatus; timeliner_url: string | null }
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
  const scripts = await db.query<ScriptRow>(
    `select ss.submission_id, sc.id, sc.number, sc.status, sc.timeliner_url
       from submission_scripts ss join scripts sc on sc.id = ss.script_id
      where sc.removed_at is null and ss.submission_id = any($1::bigint[]) order by sc.number`, [subIds],
  );
  // each script belongs under the newest document it was sent in (subs are oldest first)
  const order = new Map(subs.map((x, i) => [x.id, i]));
  const current = new Map<number, ScriptRow>();
  for (const r of scripts) { const was = current.get(r.id); if (!was || order.get(r.submission_id)! > order.get(was.submission_id)!) current.set(r.id, r); }
  const scriptsBySub = new Map<number, ScriptRow[]>();
  for (const r of current.values()) { const l = scriptsBySub.get(r.submission_id) ?? []; l.push(r); scriptsBySub.set(r.submission_id, l); }
  for (const l of scriptsBySub.values()) l.sort((a, b) => a.number - b.number);

  // the manager's edited version, for the scripts it was approved with
  const edits = await db.query<EditRow>(
    `select r.script_ids, r.url, r.file_id, f.filename as file_name, r.note, u.name as reviewer, r.created_at
       from reviews r left join files f on f.id = r.file_id join batches b on b.id = r.batch_id join users u on u.id = r.reviewed_by
      where r.action = 'approved' and (r.url is not null or r.file_id is not null)
        and ($1::bigint is null or b.client_id = $1) and ($2::bigint[] is null or r.batch_id = any($2::bigint[]))
      order by r.created_at`, [by.clientId ?? null, by.batchIds ?? null],
  );
  const editOfScript = new Map<number, EditRow>();
  for (const e of edits) for (const id of (Array.isArray(e.script_ids) ? e.script_ids : [])) editOfScript.set(Number(id), e);
  const editFor = (list: { id: number; number: number; status: ScriptStatus }[]): Deliverable['edited'] => {
    const covered = list.filter((x) => FINISHED.has(x.status) && editOfScript.has(x.id));
    if (!covered.length) return null;
    const e = covered.map((x) => editOfScript.get(x.id)!).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    return { kind: e.file_id ? 'file' : 'link', href: e.file_id ? `/api/files/${e.file_id}` : e.url!, name: e.file_name, at: e.created_at, by: e.reviewer, note: e.note, ranges: compressRanges(covered.filter((x) => editOfScript.get(x.id) === e).map((x) => x.number)) };
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

export function registerScriptBankRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  app.get('/api/script-bank', async (req): Promise<ScriptBankPage> => {
    const me = requireUser(req);
    // editors only ever see finished scripts, so they never cut from a draft
    const finishedOnly = isEditor(me.role);
    const q = parse(z.object({
      q: z.string().trim().max(120).optional(),
      clientId: zs.id.optional(),
      writerId: zs.id.optional(),
      shootId: zs.id.optional(),
      status: z.enum(['finished', 'in_review', 'revisions', 'open']).optional(),
      sort: z.enum(['recent', 'client', 'shoot']).default('recent'),
      offset: z.coerce.number().int().min(0).max(100_000).default(0),
      limit: z.coerce.number().int().min(10).max(200).default(40),
    }), req.query);

    const out = await loadDeliverables(db, { clientId: q.clientId ?? null, writerId: q.writerId ?? null });

    // filters
    const needle = q.q?.toLowerCase().replace(/^#/, '');
    const num = q.q && /^#?\d{1,4}$/.test(q.q) ? Number(q.q.replace('#', '')) : null;
    const match = (d: Deliverable) => {
      // a document counts as finished as soon as any script in it is, so finished scripts are never hidden
      if (finishedOnly && !d.past && !d.finished) return false;
      if (q.clientId && d.clientId !== q.clientId) return false;
      if (q.writerId && d.writerId !== q.writerId) return false;
      if (q.shootId && d.shootId !== q.shootId) return false;
      if (q.status === 'finished' && !d.past && !d.finished) return false;
      if (q.status === 'in_review' && !d.scripts.some((x) => x.status === 'ready_for_review')) return false;
      if (q.status === 'revisions' && !d.scripts.some((x) => x.status === 'revisions_needed')) return false;
      if (q.status === 'open' && (d.past || d.finished === d.scripts.length)) return false;
      if (!needle) return true;
      if (num != null) return d.scripts.some((s) => s.number === num);
      // past documents: their title, file name and note are searched below
      const hay = [d.clientName, d.batchTitle, d.writerName ?? '', d.name ?? '', d.note ?? ''].join('\n').toLowerCase();
      return hay.includes(needle);
    };
    const found = out.filter(match);
    found.sort(q.sort === 'client'
      ? (a, b) => a.clientName.localeCompare(b.clientName) || b.sentAt.localeCompare(a.sentAt)
      : q.sort === 'shoot'
        // soonest shoot first, then documents without a shoot
        ? (a, b) => (a.shootDate ?? '9999').localeCompare(b.shootDate ?? '9999') || b.sentAt.localeCompare(a.sentAt)
        : (a, b) => b.sentAt.localeCompare(a.sentAt));
    const page = found.slice(q.offset, q.offset + q.limit);
    return {
      deliverables: page,
      total: found.length,
      scriptCount: found.reduce((n, d) => n + (d.past ? d.past.scriptCount ?? 0 : d.scripts.length), 0),
      nextOffset: q.offset + page.length < found.length ? q.offset + page.length : null,
    };
  });

  // Past scripts: a PDF (or a link) from before the platform, filed under a client.
  app.post('/api/script-bank/past', async (req) => {
    const me = requireManager(req);
    const { fields, file } = await readForm(req, ctx.uploadLimitBytes);
    const input = parse(z.object({
      clientId: z.coerce.number().int().positive({ message: 'Choose a client' }),
      title: z.string().trim().max(200).optional(),
      // the same link rule as everywhere else: http(s) only, never javascript: or data:
      url: zs.url,
      writerName: z.string().trim().max(120).optional(),
      scriptCount: z.coerce.number().int().min(1).max(1000).optional().or(z.literal('').transform(() => undefined)),
      writtenOn: zs.date.optional().or(z.literal('').transform(() => undefined)),
      note: z.string().trim().max(2000).optional(),
    }), fields);
    if (!file && !input.url) throw new HttpError(400, 'Choose a file or paste a link', { file: 'Choose a file or paste a link' });
    const client = await db.one<{ id: number; name: string }>(`select id, name from clients where id = $1`, [input.clientId]);
    if (!client) throw new HttpError(400, 'Choose a client', { clientId: 'Choose a client' });
    const title = input.title || (file ? file.filename.replace(/\.[a-z0-9]{2,5}$/i, '') : 'Past scripts');
    // a writer's name that matches someone on the team links it to them
    const writer = input.writerName
      ? await db.one<{ id: number; name: string }>(`select id, name from users where lower(name) = lower($1) and removed_at is null order by id limit 1`, [input.writerName])
      : undefined;
    const id = await db.tx(async (t) => {
      const fileId = file ? await storeFile(t, me, file) : null;
      const row = await t.one<{ id: number }>(
        `insert into past_documents (client_id, title, file_id, url, writer_id, writer_name, script_count, written_on, note, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
        [client.id, title, fileId, file ? null : input.url || null, writer?.id ?? null, writer ? null : input.writerName || null,
          input.scriptCount ?? null, input.writtenOn ?? null, input.note || null, me.id],
      );
      await logActivity(t, { actor: me, action: 'past.added', entityType: 'past_document', entityId: row!.id, clientId: client.id, summary: `Added past scripts “${title}” to the Script bank` });
      return row!.id;
    });
    return { id };
  });

  app.delete('/api/script-bank/past/:id', async (req) => {
    const me = requireManager(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const r = await db.one<{ client_id: number; title: string }>(`update past_documents set removed_at = now() where id = $1 and removed_at is null returning client_id, title`, [id]);
    if (!r) throw notFound('Past document');
    await logActivity(db, { actor: me, action: 'past.removed', entityType: 'past_document', entityId: id, clientId: r.client_id, summary: `Removed past scripts “${r.title}” from the Script bank` });
    return { ok: true };
  });
}
