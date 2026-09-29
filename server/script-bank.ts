// Script bank: every script ever planned, across every client and batch, with
// its latest document one click away. Search by title, number, client, batch
// or writer, and filter by client, writer and status.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from './core';
import { requireUser } from './auth';
import { parse, zs } from './http';
import { SCRIPT_STATUSES, type ScriptStatus } from '../shared/workflow';
import type { ScriptBankItem, ScriptBankPage } from '../shared/types';

const STATUS_GROUPS: Record<string, ScriptStatus[]> = {
  finished: ['approved', 'delivered'],
  open: ['not_started', 'in_progress', 'ready_for_review', 'revisions_needed'],
};

interface Row {
  id: number; number: number; title: string | null; status: ScriptStatus; version: number;
  assignee_id: number | null; writer: string | null; doc_url: string | null; timeliner_url: string | null;
  updated_at: string; approved_at: string | null; delivered_at: string | null;
  batch_id: number; batch_title: string; batch_archived: boolean; client_id: number; client_name: string; shoot_date: string | null;
  d_src: 'submission' | 'edited' | null; d_at: string | null; d_url: string | null; d_file: number | null; d_version: number | null; d_name: string | null;
}

export function registerScriptBankRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  app.get('/api/script-bank', async (req): Promise<ScriptBankPage> => {
    requireUser(req);
    const q = parse(z.object({
      q: z.string().trim().max(120).optional(),
      clientId: zs.id.optional(),
      writerId: z.union([zs.id, z.literal('none')]).optional(),
      status: z.enum(['finished', 'open', ...SCRIPT_STATUSES]).optional(),
      sort: z.enum(['recent', 'client']).default('recent'),
      offset: z.coerce.number().int().min(0).max(100_000).default(0),
      limit: z.coerce.number().int().min(10).max(200).default(60),
    }), req.query);

    const p: unknown[] = [];
    const where: string[] = ['s.removed_at is null'];
    const add = (sql: (n: string) => string, v: unknown) => { p.push(v); where.push(sql(`$${p.length}`)); };
    if (q.clientId) add((n) => `c.id = ${n}`, q.clientId);
    if (q.writerId === 'none') where.push('s.assignee_id is null');
    else if (q.writerId) add((n) => `s.assignee_id = ${n}`, q.writerId);
    if (q.status) add((n) => `s.status = any(${n}::text[])`, STATUS_GROUPS[q.status] ?? [q.status]);
    if (q.q) {
      const num = /^#?(\d{1,4})$/.exec(q.q);
      p.push(`%${q.q.toLowerCase()}%`);
      const like = `$${p.length}`;
      let cond = `lower(coalesce(s.title, '')) like ${like} or lower(c.name) like ${like} or lower(b.title) like ${like} or lower(coalesce(u.name, '')) like ${like}`;
      if (num) { p.push(Number(num[1])); cond += ` or s.number = $${p.length}`; }
      where.push(`(${cond})`);
    }
    const joins = `
      from scripts s
      join batches b on b.id = s.batch_id
      join clients c on c.id = b.client_id
      left join users u on u.id = s.assignee_id
      left join shoots sh on sh.id = b.shoot_id`;
    const filter = `where ${where.join(' and ')}`;

    const total = (await db.one<{ n: number }>(`select count(*)::int as n ${joins} ${filter}`, p))?.n ?? 0;
    const order = q.sort === 'client'
      ? `lower(c.name), b.created_at desc, b.id desc, s.number`
      : `(d.created_at is null and s.doc_url is null), coalesce(d.created_at, s.updated_at) desc, s.id desc`;
    // The newest document covering each script: the writer's latest send, or
    // the version a manager approved with their own edits, whichever is newer.
    const rows = await db.query<Row>(
      `select s.id, s.number, s.title, s.status, s.version, s.assignee_id, u.name as writer, s.doc_url, s.timeliner_url,
              s.updated_at, s.approved_at, s.delivered_at,
              b.id as batch_id, b.title as batch_title, b.archived_at is not null as batch_archived, c.id as client_id, c.name as client_name,
              sh.start_date as shoot_date,
              d.src as d_src, d.created_at as d_at, d.url as d_url, d.file_id as d_file, d.version as d_version, f.filename as d_name
         ${joins}
         left join lateral (
           select * from (
             select sub.created_at, sub.url, sub.file_id, sub.version, 'submission' as src
               from submission_scripts ss join submissions sub on sub.id = ss.submission_id where ss.script_id = s.id
             union all
             select r.created_at, r.url, r.file_id, null::int as version, 'edited' as src
               from reviews r where r.batch_id = s.batch_id and r.action = 'approved' and (r.url is not null or r.file_id is not null) and r.script_ids @> jsonb_build_array(s.id)
           ) x order by created_at desc limit 1
         ) d on true
         left join files f on f.id = d.file_id
         ${filter}
        order by ${order}
        limit ${q.limit} offset ${q.offset}`,
      p,
    );

    const scripts: ScriptBankItem[] = rows.map((r) => ({
      id: r.id, number: r.number, title: r.title, status: r.status,
      writerId: r.assignee_id, writerName: r.writer,
      batchId: r.batch_id, batchTitle: r.batch_title, batchArchived: r.batch_archived,
      clientId: r.client_id, clientName: r.client_name, shootDate: r.shoot_date,
      timelinerUrl: r.timeliner_url,
      document: r.d_src
        ? { kind: r.d_file ? 'file' : 'link', href: r.d_file ? `/api/files/${r.d_file}` : r.d_url!, name: r.d_name, version: r.d_version, edited: r.d_src === 'edited', at: r.d_at! }
        : r.doc_url ? { kind: 'link', href: r.doc_url, name: null, version: null, edited: false, at: r.updated_at } : null,
      updatedAt: r.delivered_at ?? r.approved_at ?? r.d_at ?? r.updated_at,
    }));
    return { scripts, total, nextOffset: q.offset + rows.length < total ? q.offset + rows.length : null };
  });
}
