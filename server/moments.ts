// Celebration moments: approvals, send-backs, a writer finishing their drafts
// or their batch, a whole batch being delivered, and a thumbnail designer's
// option being picked. Each is shown once, as an animation, the next time the
// person has the app open (straight away if they did it themselves).
// Milestones are recorded once per person and batch, so resubmitting after
// revisions doesn't celebrate the same thing twice; a pick, once per person and
// decision (deciding again takes back one not seen yet).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from './db';
import { managerIds, type Ctx } from './core';
import { requireUser } from './auth';
import { parse } from './http';
import {
  isApproved, isDraftReady, isThumbnailDesigner, thumbBriefPath, THUMB_MOMENT_KINDS, thumbMomentKey, thumbMomentKind,
  type EditorKind, type OptionLetter, type Role, type ScriptAction, type ScriptStatus,
} from '../shared/workflow';
import { fileUrl, type Me, type Moment, type MomentKind, type MomentThumb } from '../shared/types';

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
  /** a thumbnail pick (thumb_picked, thumb_standout), which has no batch */
  thumb?: MomentThumb;
}

/** Records a moment once: a moment with a dedupe key already taken is skipped. A thumbnail pick has no batch, and names its decision. */
async function add(
  db: Db, userId: number, kind: MomentKind, batchId: number | null, payload: Payload, dedupeKey: string | null = null, thumbnailDecisionId: number | null = null,
) {
  await db.query(
    `insert into moments (user_id, kind, batch_id, payload, dedupe_key, thumbnail_decision_id) values ($1, $2, $3, $4::jsonb, $5, $6) on conflict (dedupe_key) do nothing`,
    [userId, kind, batchId, JSON.stringify(payload), dedupeKey, thumbnailDecisionId],
  );
}

/**
 * Celebrates a pick for whoever made the picked option (its uploader, while they're an active thumbnail designer):
 * thumb_standout when the manager marked it Standout, else thumb_picked. Called inside the decision's transaction,
 * after the decision is written. Asking for changes is never celebrated, so a decision that isn't a pick records
 * nothing. Its key names the person and the decision (moments.dedupe_key is unique across the whole table), so each
 * pick is celebrated once, and deciding again is a new one; the decision route takes back the earlier decision's
 * moment if it hasn't been seen yet.
 */
export async function recordThumbMoment(t: Db, decisionId: number, pickedBy: { name: string }): Promise<void> {
  const d = await t.one<{
    action: string; standout: boolean; note: string | null; round_number: number; brief_id: number; title: string; client_name: string;
    variant_id: number; letter: OptionLetter; file_id: number; width: number; height: number; maker: number; role: Role; editor_kind: EditorKind | null;
    active: boolean; removed_at: string | null; earlier: boolean;
  }>(
    `select d.action, d.standout, d.note, r.number as round_number, b.id as brief_id, b.title, c.name as client_name,
            v.id as variant_id, v.letter, v.file_id, v.width, v.height, v.uploaded_by as maker, u.role, u.editor_kind, u.active, u.removed_at,
            exists (select 1 from thumbnail_rounds er where er.brief_id = b.id and er.sent_at is not null and er.number < r.number) as earlier
       from thumbnail_decisions d
       join thumbnail_rounds r on r.id = d.round_id
       join thumbnail_briefs b on b.id = r.brief_id
       join clients c on c.id = b.client_id
       join thumbnail_variants v on v.id = d.variant_id
       join users u on u.id = v.uploaded_by
      where d.id = $1`, [decisionId],
  );
  if (!d || d.action !== 'pick') return;
  if (!d.active || d.removed_at || !isThumbnailDesigner({ role: d.role, editorKind: d.editor_kind })) return;
  const kind = thumbMomentKind(d.standout);
  const thumb: MomentThumb = {
    briefId: d.brief_id, title: d.title, roundNumber: d.round_number, firstRound: !d.earlier,
    option: { id: d.variant_id, letter: d.letter, url: fileUrl(d.file_id), width: d.width, height: d.height },
    link: thumbBriefPath({ role: d.role, editorKind: d.editor_kind }, d.brief_id),
  };
  await add(t, d.maker, kind, null, {
    batchTitle: d.title, clientName: d.client_name, numbers: [], count: 0, byName: pickedBy.name, note: d.note, thumb,
  }, thumbMomentKey(kind, d.maker, decisionId), decisionId);
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
    // a pick's celebration shows the picture and opens the brief, which only a thumbnail designer can: someone who
    // has since become something else doesn't get it (it stays, unseen, should they be a designer again)
    const rows = await ctx.db.query<{ id: number; kind: MomentKind; batch_id: number | null; payload: Payload | string; created_at: string }>(
      `select id, kind, batch_id, payload, created_at from moments
        where user_id = $1 and seen_at is null and ($2::boolean or kind <> all($3::text[]))
        order by created_at, id limit 30`, [me.id, isThumbnailDesigner(me), [...THUMB_MOMENT_KINDS]],
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
        // a thumbnail pick: no batch (batchId is null), and the picked option for its frame
        ...(p.thumb ? { thumb: p.thumb } : {}),
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
