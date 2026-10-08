// Celebration moments: approvals, send-backs, a writer finishing their drafts
// or their batch, and a whole batch being delivered. Each is shown once, as an
// animation, the next time the person has the app open (straight away if they
// did it themselves). Milestones are recorded once per person and batch, so
// resubmitting after revisions doesn't celebrate the same thing twice.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from './db';
import { managerIds, type Ctx } from './core';
import { requireUser } from './auth';
import { parse } from './http';
import { isApproved, isDraftReady, type ScriptAction, type ScriptStatus } from '../shared/workflow';
import type { Me, Moment, MomentKind } from '../shared/types';

interface Payload {
  batchTitle: string;
  clientName: string;
  numbers?: number[];
  count?: number;
  byName?: string | null;
  note?: string | null;
  allMine?: boolean;
  withAttachment?: boolean;
  self?: boolean;
}

async function add(db: Db, userId: number, kind: MomentKind, batchId: number, payload: Payload, dedupeKey: string | null = null) {
  await db.query(
    `insert into moments (user_id, kind, batch_id, payload, dedupe_key) values ($1, $2, $3, $4::jsonb, $5) on conflict (dedupe_key) do nothing`,
    [userId, kind, batchId, JSON.stringify(payload), dedupeKey],
  );
}

/** Called inside the transaction that changed the scripts, after the change. */
export async function recordMoments(
  t: Db, me: Me, batchId: number, action: ScriptAction,
  rows: { id: number; number: number; assignee_id: number | null }[],
  batch: { title: string; client_name: string }, opts: { note: string | null; attached: boolean },
) {
  if (!['submit', 'approve', 'request_revisions', 'deliver'].includes(action)) return;
  const base = { batchTitle: batch.title, clientName: batch.client_name };
  const all = await t.query<{ assignee_id: number | null; status: ScriptStatus }>(
    `select assignee_id, status from scripts where batch_id = $1 and removed_at is null`, [batchId],
  );
  const names = new Map((await t.query<{ id: number; name: string; active: boolean; removed_at: string | null }>(`select id, name, active, removed_at from users`)).map((u) => [u.id, u]));
  const live = (id: number) => { const u = names.get(id); return !!u && u.active && !u.removed_at; };
  const byWriter = new Map<number, number[]>();
  for (const r of rows) if (r.assignee_id != null) byWriter.set(r.assignee_id, [...(byWriter.get(r.assignee_id) ?? []), r.number]);
  const mineAll = (w: number) => all.filter((s) => s.assignee_id === w);
  const managers = await managerIds(t);

  for (const [w, numbers] of byWriter) {
    if (!live(w)) continue;
    const mine = mineAll(w);
    if (action === 'approve' && w !== me.id) {
      await add(t, w, 'approved', batchId, { ...base, numbers, count: numbers.length, byName: me.name, allMine: mine.every((s) => isApproved(s.status)), withAttachment: opts.attached });
    }
    if (action === 'request_revisions' && w !== me.id) {
      await add(t, w, 'revisions', batchId, { ...base, numbers, count: numbers.length, byName: me.name, note: opts.note, withAttachment: opts.attached });
    }
    if (action === 'submit' && mine.length && mine.every((s) => isDraftReady(s.status))) {
      await add(t, w, 'drafts_done', batchId, { ...base, count: mine.length, byName: names.get(w)?.name ?? null, self: w === me.id }, `drafts_done:${batchId}:${w}`);
      for (const m of managers) {
        if (m === w || m === me.id) continue;
        await add(t, m, 'team_drafts_done', batchId, { ...base, count: mine.length, byName: names.get(w)?.name ?? null }, `team_drafts_done:${batchId}:${w}:${m}`);
      }
    }
    if (action === 'deliver' && mine.length && mine.every((s) => s.status === 'delivered')) {
      await add(t, w, 'batch_done', batchId, { ...base, count: mine.length, byName: names.get(w)?.name ?? null, self: w === me.id }, `batch_done:${batchId}:${w}`);
    }
  }
  if (action === 'deliver' && all.length && all.every((s) => s.status === 'delivered')) {
    for (const m of managers) {
      await add(t, m, 'team_batch_done', batchId, { ...base, count: all.length, self: m === me.id }, `team_batch_done:${batchId}:${m}`);
    }
  }
}

export function registerMomentRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/api/moments', async (req): Promise<Moment[]> => {
    const me = requireUser(req);
    const rows = await ctx.db.query<{ id: number; kind: MomentKind; batch_id: number | null; payload: Payload | string; created_at: string }>(
      `select id, kind, batch_id, payload, created_at from moments where user_id = $1 and seen_at is null order by created_at, id limit 30`, [me.id],
    );
    // an approval that has since been sent back isn't news any more: drop those scripts (or the whole moment)
    const batchIds = [...new Set(rows.filter((r) => r.kind === 'approved' && r.batch_id != null).map((r) => Number(r.batch_id)))];
    const live = new Set<string>();
    if (batchIds.length) {
      const ok = await ctx.db.query<{ batch_id: number; number: number }>(
        `select batch_id, number from scripts where batch_id = any($1) and removed_at is null and status in ('approved', 'delivered')`, [batchIds],
      );
      for (const s of ok) live.add(`${s.batch_id}:${s.number}`);
    }
    const out: Moment[] = [];
    for (const r of rows) {
      const p = (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as Payload;
      let numbers = p.numbers ?? [];
      let count = p.count ?? numbers.length;
      if (r.kind === 'approved' && r.batch_id != null && numbers.length) {
        const kept = numbers.filter((n) => live.has(`${r.batch_id}:${n}`));
        if (!kept.length) continue;
        if (kept.length < numbers.length) { numbers = kept; count = kept.length; }
      }
      out.push({
        id: r.id, kind: r.kind, batchId: r.batch_id, batchTitle: p.batchTitle, clientName: p.clientName, numbers, count,
        byName: p.byName ?? null, note: p.note ?? null, allMine: !!p.allMine, withAttachment: !!p.withAttachment, self: !!p.self, createdAt: r.created_at,
      });
    }
    return out;
  });

  app.post('/api/moments/seen', async (req) => {
    const me = requireUser(req);
    const { ids } = parse(z.object({ ids: z.array(z.number().int().positive()).max(100) }), req.body);
    if (!ids.length) return { ok: true };
    const p: unknown[] = [me.id, ...ids];
    await ctx.db.query(`update moments set seen_at = now() where user_id = $1 and seen_at is null and id in (${ids.map((_, i) => `$${i + 2}`).join(',')})`, p);
    return { ok: true };
  });
}
