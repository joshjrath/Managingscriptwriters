// Script bank: every deliverable ever sent, across every client and batch.
// A deliverable is one document (a PDF or a link) covering a writer's
// scripts for a batch, like "#1–45" — so it's one row, not 45. Only the
// newest version of each is listed, with the version a manager approved
// with edits beside it. Search matches the client, batch, writer, file name
// and note, plus the titles and numbers of the scripts inside, so "#12"
// finds the document script 12 is in.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { logActivity, type Ctx } from './core';
import { requireManager, requireUser } from './auth';
import { HttpError, notFound, parse, zs } from './http';
import { readForm } from './submissions';
import { storeFile } from './files';
import { compressRanges, documentState, type ScriptStatus } from '../shared/workflow';
import type { Deliverable, ScriptBankPage } from '../shared/types';

interface SubRow {
  id: number; previous_id: number | null; version: number; url: string | null; file_id: number | null; file_name: string | null; note: string | null;
  created_at: string; writer_id: number | null; writer_name: string | null;
  batch_id: number; batch_title: string; batch_archived: boolean; client_id: number; client_name: string; shoot_date: string | null;
}
interface ScriptRow { submission_id: number; id: number; number: number; title: string | null; status: ScriptStatus; timeliner_url: string | null }
interface EditRow { submission_id: number; url: string | null; file_id: number | null; file_name: string | null; created_at: string }
interface PastRow {
  id: number; title: string; file_id: number | null; file_name: string | null; url: string | null; writer_id: number | null; writer_name: string | null;
  script_count: number | null; written_on: string | null; note: string | null; created_at: string; client_id: number; client_name: string;
}
interface LooseRow {
  id: number; number: number; title: string | null; status: ScriptStatus; doc_url: string; timeliner_url: string | null; updated_at: string;
  writer_id: number | null; writer_name: string | null;
  batch_id: number; batch_title: string; batch_archived: boolean; client_id: number; client_name: string; shoot_date: string | null;
}

export function registerScriptBankRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  app.get('/api/script-bank', async (req): Promise<ScriptBankPage> => {
    requireUser(req);
    const q = parse(z.object({
      q: z.string().trim().max(120).optional(),
      clientId: zs.id.optional(),
      writerId: zs.id.optional(),
      status: z.enum(['finished', 'in_review', 'revisions', 'open']).optional(),
      sort: z.enum(['recent', 'client']).default('recent'),
      offset: z.coerce.number().int().min(0).max(100_000).default(0),
      limit: z.coerce.number().int().min(10).max(200).default(40),
    }), req.query);

    const subs = await db.query<SubRow>(
      `select s.id, s.previous_id, s.version, s.url, s.file_id, f.filename as file_name, s.note, s.created_at,
              coalesce(s.writer_id, s.submitted_by) as writer_id, w.name as writer_name,
              b.id as batch_id, b.title as batch_title, b.archived_at is not null as batch_archived, c.id as client_id, c.name as client_name,
              sh.start_date as shoot_date
         from submissions s
         join batches b on b.id = s.batch_id join clients c on c.id = b.client_id
         left join users w on w.id = coalesce(s.writer_id, s.submitted_by)
         left join shoots sh on sh.id = b.shoot_id
         left join files f on f.id = s.file_id
        where ($1::bigint is null or b.client_id = $1)
        order by s.created_at, s.id`, [q.clientId ?? null],
    );
    // a newer version replaces the one it revises; follow each chain to its newest
    const replacedBy = new Map<number, number>();
    for (const s of subs) if (s.previous_id) replacedBy.set(s.previous_id, s.id);
    const newestOf = (id: number) => { let cur = id; for (let i = 0; i < 100 && replacedBy.has(cur); i++) cur = replacedBy.get(cur)!; return cur; };
    // the writer filter applies to the newest version (an older one may have been sent by someone else)
    const latest = subs.filter((s) => !replacedBy.has(s.id) && (!q.writerId || s.writer_id === q.writerId));
    const latestIds = latest.map((s) => s.id);

    const scripts = await db.query<ScriptRow>(
      `select ss.submission_id, sc.id, sc.number, sc.title, sc.status, sc.timeliner_url
         from submission_scripts ss join scripts sc on sc.id = ss.script_id
        where sc.removed_at is null and ss.submission_id = any($1::bigint[]) order by sc.number`, [latestIds],
    );
    const scriptsBySub = new Map<number, ScriptRow[]>();
    for (const r of scripts) { const l = scriptsBySub.get(r.submission_id) ?? []; l.push(r); scriptsBySub.set(r.submission_id, l); }

    const edits = await db.query<EditRow>(
      `select r.submission_id, r.url, r.file_id, f.filename as file_name, r.created_at from reviews r left join files f on f.id = r.file_id
         join batches b on b.id = r.batch_id
        where r.action = 'approved' and r.submission_id is not null and (r.url is not null or r.file_id is not null)
          and ($1::bigint is null or b.client_id = $1)
        order by r.created_at`, [q.clientId ?? null],
    );
    const editOf = new Map<number, EditRow>();
    for (const e of edits) editOf.set(newestOf(e.submission_id), e);

    const out: Deliverable[] = [];
    for (const s of latest) {
      const list = scriptsBySub.get(s.id) ?? [];
      if (!list.length) continue;
      const e = editOf.get(s.id);
      out.push({
        key: `s${s.id}`,
        kind: s.file_id ? 'file' : 'link',
        href: s.file_id ? `/api/files/${s.file_id}` : s.url!,
        name: s.file_name, note: s.note, version: s.version, sentAt: s.created_at,
        writerId: s.writer_id, writerName: s.writer_name,
        batchId: s.batch_id, batchTitle: s.batch_title, batchArchived: s.batch_archived,
        clientId: s.client_id, clientName: s.client_name, shootDate: s.shoot_date,
        scripts: list.map((x) => ({ id: x.id, number: x.number, title: x.title, status: x.status })),
        ranges: compressRanges(list.map((x) => x.number)),
        state: documentState(list.map((x) => x.status)),
        edited: e ? { kind: e.file_id ? 'file' : 'link', href: e.file_id ? `/api/files/${e.file_id}` : e.url!, name: e.file_name, at: e.created_at } : null,
        timelinerUrl: list.find((x) => x.timeliner_url)?.timeliner_url ?? null,
        past: null,
      });
    }

    // Scripts tracked with their own document link and never sent through the
    // app: one deliverable per distinct link in a batch.
    const loose = await db.query<LooseRow>(
      `select sc.id, sc.number, sc.title, sc.status, sc.doc_url, sc.timeliner_url, sc.updated_at, sc.assignee_id as writer_id, u.name as writer_name,
              b.id as batch_id, b.title as batch_title, b.archived_at is not null as batch_archived, c.id as client_id, c.name as client_name, sh.start_date as shoot_date
         from scripts sc join batches b on b.id = sc.batch_id join clients c on c.id = b.client_id
         left join users u on u.id = sc.assignee_id left join shoots sh on sh.id = b.shoot_id
        where sc.removed_at is null and sc.doc_url is not null and not exists (select 1 from submission_scripts ss where ss.script_id = sc.id)
          and ($1::bigint is null or b.client_id = $1) and ($2::bigint is null or sc.assignee_id = $2)
        order by sc.number`, [q.clientId ?? null, q.writerId ?? null],
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
        clientId: r.client_id, clientName: r.client_name, shootDate: r.shoot_date,
        scripts: list.map((x) => ({ id: x.id, number: x.number, title: x.title, status: x.status })),
        ranges: compressRanges(list.map((x) => x.number)),
        state: documentState(list.map((x) => x.status)),
        edited: null,
        timelinerUrl: list.find((x) => x.timeliner_url)?.timeliner_url ?? null,
        past: null,
      });
    }

    // Past scripts from before the platform, added straight to the bank.
    const past = await db.query<PastRow>(
      `select p.id, p.title, p.file_id, f.filename as file_name, p.url, p.writer_id, coalesce(u.name, p.writer_name) as writer_name,
              p.script_count, p.written_on, p.note, p.created_at, c.id as client_id, c.name as client_name
         from past_documents p join clients c on c.id = p.client_id
         left join users u on u.id = p.writer_id left join files f on f.id = p.file_id
        where p.removed_at is null and ($1::bigint is null or p.client_id = $1) and ($2::bigint is null or p.writer_id = $2)`,
      [q.clientId ?? null, q.writerId ?? null],
    );
    for (const r of past) {
      out.push({
        key: `p${r.id}`, kind: r.file_id ? 'file' : 'link', href: r.file_id ? `/api/files/${r.file_id}` : r.url!,
        name: r.file_name, note: r.note, version: 1, sentAt: r.written_on ? `${r.written_on}T12:00:00.000Z` : r.created_at,
        writerId: r.writer_id, writerName: r.writer_name,
        batchId: null, batchTitle: r.title, batchArchived: false,
        clientId: r.client_id, clientName: r.client_name, shootDate: null,
        scripts: [], ranges: '', state: 'delivered', edited: null, timelinerUrl: null,
        past: { id: r.id, scriptCount: r.script_count, writtenOn: r.written_on },
      });
    }

    // filters
    const needle = q.q?.toLowerCase().replace(/^#/, '');
    const num = q.q && /^#?\d{1,4}$/.test(q.q) ? Number(q.q.replace('#', '')) : null;
    const match = (d: Deliverable) => {
      if (q.clientId && d.clientId !== q.clientId) return false;
      if (q.writerId && d.writerId !== q.writerId) return false;
      if (q.status === 'finished' && d.state !== 'approved' && d.state !== 'delivered') return false;
      if (q.status === 'in_review' && d.state !== 'in_review') return false;
      if (q.status === 'revisions' && d.state !== 'revisions') return false;
      if (q.status === 'open' && (d.state === 'approved' || d.state === 'delivered')) return false;
      if (!needle) return true;
      if (num != null) return d.scripts.some((s) => s.number === num);
      // past documents: their title, file name and note are searched below
      const hay = [d.clientName, d.batchTitle, d.writerName ?? '', d.name ?? '', d.note ?? '', ...d.scripts.map((s) => s.title ?? '')].join('\n').toLowerCase();
      return hay.includes(needle);
    };
    const found = out.filter(match);
    found.sort(q.sort === 'client'
      ? (a, b) => a.clientName.localeCompare(b.clientName) || b.sentAt.localeCompare(a.sentAt)
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
