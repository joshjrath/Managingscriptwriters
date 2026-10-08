// Script bank: every document ever sent, across every client and batch.
// A document (a PDF or a link) covers a writer's scripts for a batch, like
// "#1–45", so it's one row, not 45. Each script is listed under the newest
// document it was sent in: when a writer resends only script 3 of a 1–3
// document, scripts 1–2 stay under the earlier one. Scripts that were
// finished without any document get a row of their own, so nothing finished
// is ever missing. The version a manager approved with edits is attached to
// the scripts it covers. (loadDeliverables in server/records.ts builds the
// list; the Editors tab uses it too.) Search matches the client, batch,
// writer, file name and note, and the numbers of the scripts inside, so
// "#12" finds the document script 12 is in.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { logActivity, type Ctx } from './core';
import { requireManager, requireUser } from './auth';
import { HttpError, notFound, parse, zs } from './http';
import { readForm } from './submissions';
import { storeFile } from './files';
import { loadDeliverables } from './records';
import { isEditor } from '../shared/workflow';
import type { Deliverable, ScriptBankPage } from '../shared/types';

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
