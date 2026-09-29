// Script bank: every deliverable ever sent, across every client and batch.
// A deliverable is one document (a PDF or a link) covering a writer's
// scripts for a batch, like "#1–45" — so it's one row, not 45. Only the
// newest version of each is listed, with the version a manager approved
// with edits beside it. Search matches the client, batch, writer, file name
// and note, plus the titles and numbers of the scripts inside, so "#12"
// finds the document script 12 is in.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from './core';
import { requireUser } from './auth';
import { parse, zs } from './http';
import { compressRanges, type ScriptStatus } from '../shared/workflow';
import type { Deliverable, DeliverableState, ScriptBankPage } from '../shared/types';

interface SubRow {
  id: number; previous_id: number | null; version: number; url: string | null; file_id: number | null; file_name: string | null; note: string | null;
  created_at: string; writer_id: number | null; writer_name: string | null;
  batch_id: number; batch_title: string; batch_archived: boolean; client_id: number; client_name: string; shoot_date: string | null;
}
interface ScriptRow { submission_id: number; id: number; number: number; title: string | null; status: ScriptStatus; timeliner_url: string | null }
interface EditRow { submission_id: number; url: string | null; file_id: number | null; file_name: string | null; created_at: string }
interface LooseRow {
  id: number; number: number; title: string | null; status: ScriptStatus; doc_url: string; timeliner_url: string | null; updated_at: string;
  writer_id: number | null; writer_name: string | null;
  batch_id: number; batch_title: string; batch_archived: boolean; client_id: number; client_name: string; shoot_date: string | null;
}

export function stateOf(statuses: ScriptStatus[]): DeliverableState {
  if (statuses.length && statuses.every((s) => s === 'delivered')) return 'delivered';
  if (statuses.length && statuses.every((s) => s === 'approved' || s === 'delivered')) return 'approved';
  if (statuses.some((s) => s === 'revisions_needed')) return 'revisions';
  if (statuses.some((s) => s === 'ready_for_review')) return 'in_review';
  return 'in_progress';
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
        order by s.created_at, s.id`,
    );
    // a newer version replaces the one it revises; follow each chain to its newest
    const replacedBy = new Map<number, number>();
    for (const s of subs) if (s.previous_id) replacedBy.set(s.previous_id, s.id);
    const newestOf = (id: number) => { let cur = id; for (let i = 0; i < 100 && replacedBy.has(cur); i++) cur = replacedBy.get(cur)!; return cur; };
    const latest = subs.filter((s) => !replacedBy.has(s.id));

    const scripts = await db.query<ScriptRow>(
      `select ss.submission_id, sc.id, sc.number, sc.title, sc.status, sc.timeliner_url
         from submission_scripts ss join scripts sc on sc.id = ss.script_id where sc.removed_at is null order by sc.number`,
    );
    const scriptsBySub = new Map<number, ScriptRow[]>();
    for (const r of scripts) { const l = scriptsBySub.get(r.submission_id) ?? []; l.push(r); scriptsBySub.set(r.submission_id, l); }

    const edits = await db.query<EditRow>(
      `select r.submission_id, r.url, r.file_id, f.filename as file_name, r.created_at from reviews r left join files f on f.id = r.file_id
        where r.action = 'approved' and r.submission_id is not null and (r.url is not null or r.file_id is not null) order by r.created_at`,
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
        state: stateOf(list.map((x) => x.status)),
        edited: e ? { kind: e.file_id ? 'file' : 'link', href: e.file_id ? `/api/files/${e.file_id}` : e.url!, name: e.file_name, at: e.created_at } : null,
        timelinerUrl: list.find((x) => x.timeliner_url)?.timeliner_url ?? null,
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
        order by sc.number`,
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
        state: stateOf(list.map((x) => x.status)),
        edited: null,
        timelinerUrl: list.find((x) => x.timeliner_url)?.timeliner_url ?? null,
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
      scriptCount: found.reduce((n, d) => n + d.scripts.length, 0),
      nextOffset: q.offset + page.length < found.length ? q.offset + page.length : null,
    };
  });
}
