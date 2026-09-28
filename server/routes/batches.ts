// Batches and their scripts: creation, deadlines, assignments, progress,
// review, delivery confirmation, blockers and target changes.

import type { FastifyInstance } from 'fastify';
import { isManager } from '../../shared/workflow';
import { z } from 'zod';
import type { Db } from '../db';
import {
  assigneesOf, batchLink, buildSummary, clockFor, isAssignedTo, lastDeliveredAt, loadBatch, loadBatches,
  loadSettings, loadUsers, loadWritten, logActivity, managerIds, notify, rulesOf, type BatchRow, type Ctx, BATCH_SELECT, loadScriptsFor,
} from '../core';
import { requireManager, requireUser } from '../auth';
import { buildGroups, publicSubmission } from '../submissions';
import { recordMoments } from '../moments';
import { conflict, forbidden, HttpError, notFound, optionalDate, parse, zs } from '../http';
import {
  loadActivity, loadBriefings, loadDeliveries, loadResources, loadRevisions, loadScripts,
} from '../records';
import { computeDeadlines, dueState, ruleText, type Clock, type ISODate } from '../../shared/dates';
import {
  ACTION_RULES, checkAction, compressRanges, isDraftReady, SCRIPT_ACTIONS, splitAssignments, STAGES, summarize,
  type ScriptAction, type ScriptStatus,
} from '../../shared/workflow';
import { fmtDate, plural } from '../../shared/format';
import type { BatchDetail, BatchSummary, Me, Settings } from '../../shared/types';

// ── schemas ──────────────────────────────────────────────────────────────

export const splitSchema = z
  .array(z.object({ writerId: zs.id, count: z.coerce.number().int().min(0).max(500) }))
  .max(30)
  .default([]);

export const batchFields = {
  title: zs.name('Title', 200),
  targetCount: z.coerce.number({ message: 'Enter a number' }).int('Use a whole number').min(1, 'At least 1 script').max(500, 'At most 500 scripts'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  plannedStart: optionalDate,
  draftDue: optionalDate,
  finalDue: optionalDate,
  brief: zs.text(),
  nextAction: zs.text(500),
  briefingIds: z.array(zs.id).max(50).default([]),
  split: splitSchema,
};

const createSchema = z.object({ clientId: zs.id, shootId: zs.id.nullable().optional(), ...batchFields });
export type BatchInput = z.infer<typeof createSchema>;

const dateChange = z.object({ mode: z.enum(['auto', 'manual']), date: optionalDate });

const patchSchema = z.object({
  title: zs.name('Title', 200).optional(),
  brief: zs.text(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  plannedStart: optionalDate,
  nextAction: zs.text(500),
  briefingIds: z.array(zs.id).max(50).optional(),
  shootId: zs.id.nullable().optional(),
  draftDue: dateChange.optional(),
  finalDue: dateChange.optional(),
});

// ── creation (shared with shoots and clients) ────────────────────────────

export interface CreatedBatch {
  batchId: number;
  warnings: string[];
}

interface ShootRef { id: number; start_date: ISODate; end_date: ISODate | null; client_id: number }

export async function insertBatch(
  t: Db, me: Me, input: Omit<BatchInput, 'shootId'> & { shootId?: number | null }, settings: Settings, clock: Clock,
): Promise<CreatedBatch> {
  const fields: Record<string, string> = {};
  const client = await t.one<{ id: number; name: string; status: string }>(`select id, name, status from clients where id = $1`, [input.clientId]);
  if (!client) throw new HttpError(400, 'Choose a client', { clientId: 'Choose a client' });
  if (client.status === 'archived') throw new HttpError(400, 'This client is archived', { clientId: 'This client is archived' });
  if (client.status === 'prospect') throw new HttpError(400, `${client.name} is still a potential client. Mark them as a client first.`, { clientId: 'Still a potential client — mark them as a client first' });

  let shoot: ShootRef | undefined;
  if (input.shootId) {
    shoot = await t.one<ShootRef>(`select id, start_date, end_date, client_id from shoots where id = $1`, [input.shootId]);
    if (!shoot || shoot.client_id !== input.clientId) throw new HttpError(400, 'That shoot belongs to another client', { shootId: 'Choose a shoot for this client' });
  }

  const auto = shoot ? computeDeadlines(shoot.start_date, rulesOf(settings)) : null;
  const draftDue = input.draftDue ?? auto?.draftDue ?? null;
  const finalDue = input.finalDue ?? auto?.finalDue ?? null;
  const draftMode = input.draftDue || !auto ? 'manual' : 'auto';
  const finalMode = input.finalDue || !auto ? 'manual' : 'auto';

  if (draftDue && finalDue && draftDue > finalDue) fields.draftDue = 'Drafts must be due on or before final delivery';
  if (input.plannedStart && draftDue && input.plannedStart > draftDue) fields.plannedStart = 'Writing should start before drafts are due';

  // writers
  const users = await loadUsers(t);
  const active = new Map(users.filter((u) => u.active).map((u) => [u.id, u]));
  const split = input.split.filter((s) => s.count > 0);
  const seen = new Set<number>();
  for (const s of split) {
    if (!active.has(s.writerId)) fields.split = 'One of the writers is not an active team member';
    if (seen.has(s.writerId)) fields.split = 'Each writer can appear only once — combine their counts';
    seen.add(s.writerId);
  }
  const assigned = split.reduce((n, s) => n + s.count, 0);
  if (assigned > input.targetCount) fields.split = `${assigned} scripts assigned but the batch only has ${input.targetCount}`;
  if (Object.keys(fields).length) throw new HttpError(400, Object.values(fields)[0], fields, 'validation');

  // briefings must belong to the same client
  if (input.briefingIds.length) {
    const ok = await t.query<{ id: number }>(
      `select id from briefings where client_id = $1 and id in (${input.briefingIds.map((_, i) => `$${i + 2}`).join(',')})`,
      [input.clientId, ...input.briefingIds],
    );
    if (ok.length !== new Set(input.briefingIds).size) throw new HttpError(400, 'A selected briefing belongs to another client', { briefingIds: 'Choose briefings for this client' });
  }

  const row = await t.one<{ id: number }>(
    `insert into batches (client_id, shoot_id, title, brief, target_count, priority, planned_start, draft_due, draft_due_mode,
                          final_due, final_due_mode, next_action, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
    [input.clientId, shoot?.id ?? null, input.title, input.brief ?? null, input.targetCount, input.priority, input.plannedStart ?? null,
      draftDue, draftMode, finalDue, finalMode, input.nextAction ?? null, me.id],
  );
  const batchId = row!.id;

  const owners = splitAssignments(input.targetCount, split);
  await insertPlaceholders(t, batchId, owners.map((assignee, i) => ({ number: i + 1, assignee })));

  for (const bid of new Set(input.briefingIds)) {
    await t.query(`insert into batch_briefings (batch_id, briefing_id) values ($1, $2) on conflict do nothing`, [batchId, bid]);
  }

  const shareText = describeSplit(owners, active);
  await logActivity(t, {
    actor: me, action: 'batch.created', entityType: 'batch', entityId: batchId, batchId, clientId: input.clientId,
    summary: `Created “${input.title}” with ${plural(input.targetCount, 'script')}${shareText ? ` · ${shareText}` : ''}`,
    detail: { draftDue, draftMode, finalDue, finalMode, shootId: shoot?.id ?? null },
  });

  // notify each writer about their share
  let n = 1;
  for (const s of split) {
    const range = `${n}–${n + s.count - 1}`;
    n += s.count;
    await notify(t, [s.writerId], {
      type: 'assignment',
      title: `New assignment · ${client.name}`,
      body: `${input.title}: scripts ${s.count === 1 ? n - 1 : range} (${plural(s.count, 'script')}).${draftDue ? ` Drafts due ${fmtDate(draftDue)}.` : ''}${finalDue ? ` Final delivery ${fmtDate(finalDue)}.` : ''}`,
      link: batchLink(batchId),
    }, me.id);
  }

  const warnings: string[] = [];
  if (draftDue && dueState(draftDue, clock).overdue) warnings.push(`Drafts were due ${fmtDate(draftDue)} — that date has already passed.`);
  if (finalDue && dueState(finalDue, clock).overdue) warnings.push(`Final delivery was due ${fmtDate(finalDue)} — that date has already passed.`);
  if (assigned < input.targetCount) warnings.push(`${plural(input.targetCount - assigned, 'script')} unassigned.`);
  return { batchId, warnings };
}

async function insertPlaceholders(t: Db, batchId: number, items: { number: number; assignee: number | null }[]) {
  for (let i = 0; i < items.length; i += 200) {
    const chunk = items.slice(i, i + 200);
    const params: unknown[] = [];
    const values = chunk.map((it) => {
      params.push(batchId, it.number, it.assignee);
      return `($${params.length - 2}, $${params.length - 1}, $${params.length})`;
    });
    await t.query(`insert into scripts (batch_id, number, assignee_id) values ${values.join(',')}`, params);
  }
}

function describeSplit(owners: (number | null)[], users: Map<number, { name: string }>): string {
  const by = new Map<number | null, number[]>();
  owners.forEach((o, i) => by.set(o, [...(by.get(o) ?? []), i + 1]));
  return [...by.entries()]
    .map(([uid, nums]) => `${uid == null ? 'Unassigned' : users.get(uid)?.name ?? 'Unknown'} ${compressRanges(nums)}`)
    .join('; ');
}

// ── batch detail ─────────────────────────────────────────────────────────

export async function loadBatchDetail(ctx: Ctx, id: number, me: Me): Promise<BatchDetail> {
  const settings = await loadSettings(ctx.db);
  const clock = await clockFor(ctx, settings);
  const row = await ctx.db.one<BatchRow>(`${BATCH_SELECT} where b.id = $1`, [id]);
  if (!row) throw notFound('Batch');
  const scriptsLite = (await loadScriptsFor(ctx.db, [id])).get(id) ?? [];
  const users = await loadUsers(ctx.db);
  const summary = buildSummary(row, scriptsLite, new Map(users.map((u) => [u.id, u.name])), clock, await loadWritten(ctx.db, [id]));
  const [scripts, briefings, batchResources, clientResources, revisions, deliveries, activity] = await Promise.all([
    loadScripts(ctx.db, { batchId: id }),
    loadBriefings(ctx.db, { batchId: id }),
    loadResources(ctx.db, { batchId: id, includeArchivedClients: true }),
    loadResources(ctx.db, { clientId: row.client_id, clientOnly: true }),
    loadRevisions(ctx.db, { batchId: id }),
    loadDeliveries(ctx.db, { batchIds: [id] }),
    loadActivity(ctx.db, { batchId: id, limit: 150 }),
  ]);
  const hasShoot = !!row.shoot_id;
  const { groups, data } = await buildGroups(ctx.db, [summary]);
  return {
    ...summary,
    brief: row.brief,
    clientBrandVoice: row.brand_voice,
    clientGuidance: row.guidance,
    scripts, briefings, resources: [...batchResources, ...clientResources], revisions, deliveries, activity,
    draftRule: hasShoot && row.draft_due_mode === 'auto' ? ruleText(settings.draftOffsetDays, settings.dayMode) : null,
    finalRule: hasShoot && row.final_due_mode === 'auto' ? ruleText(settings.finalOffsetDays, settings.dayMode) : null,
    canEdit: isManager(me.role),
    isAssigned: scripts.some((s) => s.assigneeId === me.id),
    submissions: data.submissions.map(publicSubmission),
    groups,
  };
}

// ── list filtering ───────────────────────────────────────────────────────

const listQuery = z.object({
  clientId: zs.id.optional(),
  writerId: z.union([zs.id, z.literal('unassigned')]).optional(),
  stage: z.enum(STAGES).optional(),
  flag: z.enum(['overdue', 'blocked', 'unassigned', 'due_today', 'review', 'revisions', 'date_review', 'active']).optional(),
  from: zs.date.optional(),
  to: zs.date.optional(),
  q: z.string().trim().max(200).optional(),
  archived: z.enum(['0', '1', 'only']).optional(),
  completed: z.enum(['0', '1']).optional(),
});

export function matchesFlag(b: BatchSummary, flag: string): boolean {
  switch (flag) {
    case 'overdue': return b.draft.overdue || b.final.overdue;
    case 'blocked': return b.blocked;
    case 'unassigned': return b.progress.unassigned > 0;
    case 'due_today': return b.draft.dueToday || b.final.dueToday;
    case 'review': return b.progress.inReview > 0;
    case 'revisions': return b.progress.revisions > 0;
    case 'date_review': return b.needsDateReview;
    case 'active': return b.stage !== 'delivered';
    default: return true;
  }
}

// ── routes ───────────────────────────────────────────────────────────────

export function registerBatchRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  app.get('/api/batches', async (req) => {
    requireUser(req);
    const q = parse(listQuery, req.query);
    const clock = await clockFor(ctx);
    const { summaries, scripts } = await loadBatches(ctx, { includeArchived: q.archived === '1', onlyArchived: q.archived === 'only', clientId: q.clientId }, clock);
    const needle = q.q?.toLowerCase();
    const cutoff = new Date(ctx.now().getTime() - 30 * 86400_000).toISOString();
    const batches = summaries.filter((b) => {
      if (q.writerId === 'unassigned' && b.progress.unassigned === 0) return false;
      if (typeof q.writerId === 'number' && !b.writers.some((w) => w.userId === q.writerId)) return false;
      if (q.stage && b.stage !== q.stage) return false;
      if (q.flag && !matchesFlag(b, q.flag)) return false;
      if (needle && ![b.title, b.clientName, b.shootTitle ?? ''].some((s) => s.toLowerCase().includes(needle))) return false;
      if (q.from || q.to) {
        const dates = [b.draftDue, b.finalDue, b.shootStart, b.plannedStart].filter(Boolean) as ISODate[];
        if (!dates.some((d) => (!q.from || d >= q.from) && (!q.to || d <= q.to))) return false;
      }
      if (q.completed !== '1' && b.stage === 'delivered' && !q.stage && q.archived !== 'only') {
        const last = lastDeliveredAt(scripts.get(b.id) ?? []);
        if (last && last < cutoff) return false;
      }
      return true;
    });
    return { batches, clock };
  });

  app.get('/api/batches/:id', async (req) => {
    const me = requireUser(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    return loadBatchDetail(ctx, id, me);
  });

  app.post('/api/batches', async (req) => {
    const me = requireManager(req);
    const input = parse(createSchema, req.body);
    const settings = await loadSettings(db);
    const clock = await clockFor(ctx, settings);
    const created = await db.tx((t) => insertBatch(t, me, input, settings, clock));
    return { ...created, batch: await loadBatch(ctx, created.batchId, clock) };
  });

  app.patch('/api/batches/:id', async (req) => {
    const me = requireManager(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const input = parse(patchSchema, req.body);
    const settings = await loadSettings(db);
    await db.tx(async (t) => {
      const b = await t.one<{
        id: number; client_id: number; title: string; shoot_id: number | null; draft_due: ISODate | null; draft_due_mode: string;
        final_due: ISODate | null; final_due_mode: string; planned_start: ISODate | null; priority: string; next_action: string | null; brief: string | null;
      }>(`select * from batches where id = $1 for update`, [id]);
      if (!b) throw notFound('Batch');

      const set: Record<string, unknown> = {};
      const changes: string[] = [];
      if (input.title !== undefined && input.title !== b.title) { set.title = input.title; changes.push(`title → “${input.title}”`); }
      if (input.brief !== undefined && input.brief !== b.brief) { set.brief = input.brief; changes.push('brief updated'); }
      if (input.priority && input.priority !== b.priority) { set.priority = input.priority; changes.push(`priority → ${input.priority}`); }
      if (input.nextAction !== undefined && input.nextAction !== b.next_action) { set.next_action = input.nextAction; changes.push('next action updated'); }
      if (input.plannedStart !== undefined && input.plannedStart !== b.planned_start) {
        set.planned_start = input.plannedStart;
        changes.push(`planned start → ${input.plannedStart ? fmtDate(input.plannedStart) : 'none'}`);
      }

      // shoot link
      let shootId = b.shoot_id;
      if (input.shootId !== undefined && input.shootId !== b.shoot_id) {
        if (input.shootId) {
          const s = await t.one<{ client_id: number }>(`select client_id from shoots where id = $1`, [input.shootId]);
          if (!s || s.client_id !== b.client_id) throw new HttpError(400, 'Choose a shoot for this client', { shootId: 'Choose a shoot for this client' });
        }
        shootId = input.shootId ?? null;
        set.shoot_id = shootId;
        changes.push(shootId ? 'linked to a shoot' : 'unlinked from its shoot');
        if (!shootId) { set.draft_due_mode = 'manual'; set.final_due_mode = 'manual'; }
      }

      // deadlines
      const shoot = shootId ? await t.one<{ start_date: ISODate }>(`select start_date from shoots where id = $1`, [shootId]) : undefined;
      const auto = shoot ? computeDeadlines(shoot.start_date, rulesOf(settings)) : null;
      let draftDue = b.draft_due;
      let finalDue = b.final_due;
      const resolve = (field: 'draftDue' | 'finalDue', ch: z.infer<typeof dateChange>) => {
        if (ch.mode === 'auto') {
          if (!auto) throw new HttpError(400, 'Automatic dates need a linked shoot', { [field]: 'Automatic dates need a linked shoot' });
          return { date: field === 'draftDue' ? auto.draftDue : auto.finalDue, mode: 'auto' as const };
        }
        return { date: ch.date ?? null, mode: 'manual' as const };
      };
      const dateMsgs: string[] = [];
      if (input.draftDue) {
        const r = resolve('draftDue', input.draftDue);
        if (r.date !== b.draft_due || r.mode !== b.draft_due_mode) {
          set.draft_due = r.date; set.draft_due_mode = r.mode; draftDue = r.date;
          dateMsgs.push(`Drafts due ${fmtDate(b.draft_due)} → ${fmtDate(r.date)}${r.mode === 'manual' ? ' (manual)' : ' (automatic)'}`);
        }
      }
      if (input.finalDue) {
        const r = resolve('finalDue', input.finalDue);
        if (r.date !== b.final_due || r.mode !== b.final_due_mode) {
          set.final_due = r.date; set.final_due_mode = r.mode; finalDue = r.date;
          dateMsgs.push(`Final delivery ${fmtDate(b.final_due)} → ${fmtDate(r.date)}${r.mode === 'manual' ? ' (manual)' : ' (automatic)'}`);
        }
      }
      if (draftDue && finalDue && draftDue > finalDue) throw new HttpError(400, 'Drafts must be due on or before final delivery', { draftDue: 'Drafts must be due on or before final delivery' });
      const planned = (set.planned_start as ISODate | null | undefined) ?? b.planned_start;
      if (planned && draftDue && planned > draftDue) throw new HttpError(400, 'Writing should start before drafts are due', { plannedStart: 'Writing should start before drafts are due' });
      if (input.draftDue || input.finalDue) { set.needs_date_review = false; set.date_review_note = null; }

      if (input.briefingIds) {
        const ids = [...new Set(input.briefingIds)];
        if (ids.length) {
          const ok = await t.query(`select id from briefings where client_id = $1 and id in (${ids.map((_, i) => `$${i + 2}`).join(',')})`, [b.client_id, ...ids]);
          if (ok.length !== ids.length) throw new HttpError(400, 'Choose briefings for this client', { briefingIds: 'Choose briefings for this client' });
        }
        await t.query(`delete from batch_briefings where batch_id = $1`, [id]);
        for (const bid of ids) await t.query(`insert into batch_briefings (batch_id, briefing_id) values ($1, $2)`, [id, bid]);
        changes.push('briefings updated');
      }

      const keys = Object.keys(set);
      if (keys.length) {
        await t.query(
          `update batches set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1`,
          [id, ...keys.map((k) => set[k])],
        );
      }
      if (changes.length) {
        await logActivity(t, { actor: me, action: 'batch.updated', entityType: 'batch', entityId: id, batchId: id, clientId: b.client_id, summary: `Updated ${changes.join(', ')}` });
      }
      if (dateMsgs.length) {
        await logActivity(t, { actor: me, action: 'batch.deadlines', entityType: 'batch', entityId: id, batchId: id, clientId: b.client_id, summary: dateMsgs.join(' · ') });
        await notify(t, await assigneesOf(t, id, { undeliveredOnly: true }), {
          type: 'deadline_change', title: `Deadline changed · ${(set.title as string) ?? b.title}`, body: dateMsgs.join('. '), link: batchLink(id),
        }, me.id);
      }
    });
    return loadBatchDetail(ctx, id, me);
  });

  app.post('/api/batches/:id/dates-reviewed', async (req) => {
    const me = requireManager(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const b = await db.one<{ client_id: number }>(`update batches set needs_date_review = false, date_review_note = null, updated_at = now() where id = $1 returning client_id`, [id]);
    if (!b) throw notFound('Batch');
    await logActivity(db, { actor: me, action: 'batch.dates_reviewed', entityType: 'batch', entityId: id, batchId: id, clientId: b.client_id, summary: 'Confirmed deadlines after shoot change' });
    return loadBatchDetail(ctx, id, me);
  });

  app.post('/api/batches/:id/archive', async (req) => {
    const me = requireManager(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const { archived } = parse(z.object({ archived: z.boolean() }), req.body);
    const b = await db.one<{ client_id: number; title: string }>(
      `update batches set archived_at = ${archived ? 'now()' : 'null'}, updated_at = now() where id = $1 returning client_id, title`, [id],
    );
    if (!b) throw notFound('Batch');
    await logActivity(db, { actor: me, action: archived ? 'batch.archived' : 'batch.restored', entityType: 'batch', entityId: id, batchId: id, clientId: b.client_id, summary: archived ? 'Archived batch' : 'Restored batch from archive' });
    return loadBatchDetail(ctx, id, me);
  });

  // blockers: assigned writers and managers
  app.post('/api/batches/:id/blocker', async (req) => {
    const me = requireUser(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const input = parse(z.object({ blocked: z.boolean(), note: zs.text(1000) }), req.body);
    if (input.blocked && !input.note) throw new HttpError(400, 'Say what is blocking the work', { note: 'Say what is blocking the work' });
    if (!isManager(me.role) && !(await isAssignedTo(db, id, me.id))) throw forbidden('Only writers on this batch can flag blockers');
    const b = input.blocked
      ? await db.one<{ client_id: number; title: string }>(
        `update batches set blocked = true, blocker_note = $2, blocked_at = now(), blocked_by = $3, updated_at = now() where id = $1 returning client_id, title`,
        [id, input.note, me.id])
      : await db.one<{ client_id: number; title: string }>(
        `update batches set blocked = false, blocker_note = null, blocked_at = null, blocked_by = null, updated_at = now() where id = $1 returning client_id, title`,
        [id]);
    if (!b) throw notFound('Batch');
    await logActivity(db, {
      actor: me, action: input.blocked ? 'batch.blocked' : 'batch.unblocked', entityType: 'batch', entityId: id, batchId: id, clientId: b.client_id,
      summary: input.blocked ? `Flagged blocker: ${input.note}` : 'Cleared blocker',
    });
    const recipients = [...(await managerIds(db)), ...(await assigneesOf(db, id))];
    await notify(db, recipients, {
      type: 'blocker', title: `${input.blocked ? 'Blocked' : 'Unblocked'} · ${b.title}`,
      body: input.blocked ? `${me.name}: ${input.note}` : `${me.name} cleared the blocker.`, link: batchLink(id),
    }, me.id);
    return loadBatchDetail(ctx, id, me);
  });

  // ── target count changes ───────────────────────────────────────────────

  app.get('/api/batches/:id/target-preview', async (req) => {
    requireManager(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const { count } = parse(z.object({ count: batchFields.targetCount }), req.query);
    return targetPreview(db, id, count);
  });

  app.post('/api/batches/:id/target', async (req) => {
    const me = requireManager(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const input = parse(z.object({
      targetCount: batchFields.targetCount,
      removeScriptIds: z.array(zs.id).default([]),
      assigneeId: zs.id.nullable().optional(),
    }), req.body);
    await db.tx(async (t) => {
      const b = await t.one<{ client_id: number; target_count: number; title: string }>(`select client_id, target_count, title from batches where id = $1 for update`, [id]);
      if (!b) throw notFound('Batch');
      const active = await t.query<{ id: number; number: number; status: ScriptStatus }>(
        `select id, number, status from scripts where batch_id = $1 and removed_at is null order by number for update`, [id],
      );
      const current = active.length;
      if (input.targetCount === current) return;
      if (input.targetCount > current) {
        let need = input.targetCount - current;
        if (input.assigneeId) {
          const u = await t.one(`select 1 from users where id = $1 and active`, [input.assigneeId]);
          if (!u) throw new HttpError(400, 'Choose an active writer', { assigneeId: 'Choose an active writer' });
        }
        // restore previously removed scripts first so their numbers and history return
        const removed = await t.query<{ id: number; number: number }>(
          `select id, number from scripts where batch_id = $1 and removed_at is not null order by number limit $2`, [id, need],
        );
        for (const r of removed) await t.query(`update scripts set removed_at = null, removed_by = null, updated_at = now(), version = version + 1 where id = $1`, [r.id]);
        need -= removed.length;
        const max = await t.one<{ max: number | null }>(`select max(number) as max from scripts where batch_id = $1`, [id]);
        const start = (max?.max ?? 0) + 1;
        const items = Array.from({ length: need }, (_, i) => ({ number: start + i, assignee: input.assigneeId ?? null }));
        await insertPlaceholders(t, id, items);
        const added = [...removed.map((r) => r.number), ...items.map((i) => i.number)];
        await t.query(`update batches set target_count = $2, updated_at = now() where id = $1`, [id, input.targetCount]);
        await logActivity(t, {
          actor: me, action: 'batch.target', entityType: 'batch', entityId: id, batchId: id, clientId: b.client_id,
          summary: `Target ${current} → ${input.targetCount}: added scripts ${compressRanges(added)}${removed.length ? ` (${removed.length} restored)` : ''}`,
        });
        if (input.assigneeId && items.length) {
          await notify(t, [input.assigneeId], { type: 'assignment', title: `New scripts · ${b.title}`, body: `Scripts ${compressRanges(items.map((i) => i.number))} were added and assigned to you.`, link: batchLink(id) }, me.id);
        }
        return;
      }
      // reduction: the manager must say exactly which scripts to remove
      const needed = current - input.targetCount;
      const chosen = [...new Set(input.removeScriptIds)];
      const byId = new Map(active.map((s) => [s.id, s]));
      if (chosen.length !== needed) {
        throw new HttpError(409, `Choose exactly ${plural(needed, 'script')} to remove`, { removeScriptIds: `Choose exactly ${needed}` }, 'resolution_required');
      }
      const bad = chosen.filter((sid) => { const s = byId.get(sid); return !s || !(s.status === 'not_started' || s.status === 'in_progress'); });
      if (bad.length) throw new HttpError(409, 'Only scripts that are not started or in progress can be removed. Submitted, approved and delivered work is kept.', undefined, 'protected_work');
      for (const sid of chosen) await t.query(`update scripts set removed_at = now(), removed_by = $2, updated_at = now(), version = version + 1 where id = $1`, [sid, me.id]);
      await t.query(`update batches set target_count = $2, updated_at = now() where id = $1`, [id, input.targetCount]);
      await logActivity(t, {
        actor: me, action: 'batch.target', entityType: 'batch', entityId: id, batchId: id, clientId: b.client_id,
        summary: `Target ${current} → ${input.targetCount}: removed scripts ${compressRanges(chosen.map((sid) => byId.get(sid)!.number))} (kept in history)`,
      });
    });
    return loadBatchDetail(ctx, id, me);
  });

  // ── script actions ─────────────────────────────────────────────────────

  const actionSchema = z.object({
    action: z.enum(SCRIPT_ACTIONS),
    scriptIds: z.array(zs.id).min(1, 'Select at least one script').max(500),
    note: zs.text(4000),
    timelinerUrl: zs.url,
    versions: z.record(z.string(), z.number().int()).optional(),
  });

  app.post('/api/batches/:id/scripts/action', async (req) => {
    const me = requireUser(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const input = parse(actionSchema, req.body);
    const result = await applyScriptAction(ctx, me, id, input.action, input.scriptIds, { note: input.note ?? null, timelinerUrl: input.timelinerUrl ?? null, versions: input.versions });
    return { ...result, batch: await loadBatchDetail(ctx, id, me) };
  });

  app.post('/api/batches/:id/scripts/assign', async (req) => {
    const me = requireManager(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const input = parse(z.object({ scriptIds: z.array(zs.id).min(1, 'Select at least one script').max(500), assigneeId: zs.id.nullable() }), req.body);
    await db.tx(async (t) => {
      const b = await t.one<{ client_id: number; title: string; draft_due: ISODate | null }>(`select client_id, title, draft_due from batches where id = $1`, [id]);
      if (!b) throw notFound('Batch');
      let name = 'Unassigned';
      if (input.assigneeId) {
        const u = await t.one<{ name: string }>(`select name from users where id = $1 and active`, [input.assigneeId]);
        if (!u) throw new HttpError(400, 'Choose an active team member', { assigneeId: 'Choose an active team member' });
        name = u.name;
      }
      const rows = await t.query<{ id: number; number: number; assignee_id: number | null }>(
        `select id, number, assignee_id from scripts where batch_id = $1 and removed_at is null and id in (${input.scriptIds.map((_, i) => `$${i + 2}`).join(',')}) for update`,
        [id, ...input.scriptIds],
      );
      if (rows.length !== new Set(input.scriptIds).size) throw conflict('Some scripts are no longer in this batch. Refresh and try again.');
      const moving = rows.filter((r) => r.assignee_id !== input.assigneeId);
      if (!moving.length) return;
      await t.query(
        `update scripts set assignee_id = $1, version = version + 1, updated_at = now() where id in (${moving.map((_, i) => `$${i + 2}`).join(',')})`,
        [input.assigneeId, ...moving.map((r) => r.id)],
      );
      const nums = compressRanges(moving.map((r) => r.number));
      await logActivity(t, { actor: me, action: 'scripts.assigned', entityType: 'batch', entityId: id, batchId: id, clientId: b.client_id, summary: `Assigned scripts ${nums} to ${name}` });
      if (input.assigneeId) {
        await notify(t, [input.assigneeId], {
          type: 'assignment', title: `Assigned · ${b.title}`,
          body: `Scripts ${nums} (${plural(moving.length, 'script')}) are now yours.${b.draft_due ? ` Drafts due ${fmtDate(b.draft_due)}.` : ''}`, link: batchLink(id),
        }, me.id);
      }
      const previous = [...new Set(moving.map((r) => r.assignee_id).filter((x): x is number => x != null && x !== input.assigneeId))];
      await notify(t, previous, { type: 'assignment', title: `Reassigned · ${b.title}`, body: `Scripts ${nums} moved to ${name}.`, link: batchLink(id) }, me.id);
    });
    return loadBatchDetail(ctx, id, me);
  });

  app.patch('/api/scripts/:id', async (req) => {
    const me = requireUser(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const input = parse(z.object({
      version: z.number().int(),
      title: zs.text(300),
      docUrl: zs.url,
      timelinerUrl: zs.url,
      notes: zs.text(4000),
    }), req.body);
    const batchId = await db.tx(async (t) => {
      const s = await t.one<{ batch_id: number; number: number; assignee_id: number | null; version: number; client_id: number }>(
        `select s.batch_id, s.number, s.assignee_id, s.version, b.client_id from scripts s join batches b on b.id = s.batch_id where s.id = $1 and s.removed_at is null for update of s`, [id],
      );
      if (!s) throw notFound('Script');
      if (!isManager(me.role) && s.assignee_id !== me.id) throw forbidden('You can only edit scripts assigned to you');
      if (s.version !== input.version) throw conflict('This script was changed by someone else. Your view has been refreshed — check it and try again.', 'stale');
      const set: Record<string, unknown> = {};
      if (input.title !== undefined) set.title = input.title;
      if (input.docUrl !== undefined) set.doc_url = input.docUrl;
      if (input.timelinerUrl !== undefined) set.timeliner_url = input.timelinerUrl;
      if (input.notes !== undefined) set.notes = input.notes;
      const keys = Object.keys(set);
      if (keys.length) {
        await t.query(`update scripts set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, version = version + 1, updated_at = now() where id = $1`, [id, ...keys.map((k) => set[k])]);
        await logActivity(t, { actor: me, action: 'script.edited', entityType: 'script', entityId: id, batchId: s.batch_id, clientId: s.client_id, summary: `Edited script ${s.number} (${keys.map((k) => k.replace('_url', ' link').replace('_', ' ')).join(', ')})` });
      }
      return s.batch_id;
    });
    const [script] = await loadScripts(db, { ids: [id] });
    return { script, batchId };
  });

  // quick count control: moves the writer's own script records, never a separate counter
  /**
   * A writer's "written so far" count. Purely an update for managers: it never
   * submits, withdraws or changes any script. It can't go below what they've
   * already sent, or above how many scripts they have.
   */
  app.post('/api/batches/:id/written', async (req) => {
    const me = requireUser(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const input = parse(z.object({ written: z.number().int().min(0).max(100000), writerId: zs.id.optional() }), req.body);
    const uid = input.writerId ?? me.id;
    if (uid !== me.id && !isManager(me.role)) throw forbidden('You can only update your own progress');
    return db.tx(async (t) => {
      const b = await t.one<{ client_id: number; title: string }>(`select client_id, title from batches where id = $1`, [id]);
      if (!b) throw notFound('Batch');
      const mine = await t.query<{ status: ScriptStatus }>(`select status from scripts where batch_id = $1 and assignee_id = $2 and removed_at is null`, [id, uid]);
      if (!mine.length) throw new HttpError(400, 'No scripts in this batch are assigned to them');
      const sent = mine.filter((s) => isDraftReady(s.status)).length;
      const written = Math.min(mine.length, Math.max(sent, input.written));
      await t.query(
        `insert into writer_progress (batch_id, user_id, written) values ($1, $2, $3)
         on conflict (batch_id, user_id) do update set written = excluded.written, updated_at = now()`, [id, uid, written],
      );
      const who = uid === me.id ? '' : ` for ${(await t.one<{ name: string }>(`select name from users where id = $1`, [uid]))?.name ?? 'the writer'}`;
      const summary = `Progress update: ${written} of ${mine.length} scripts written${who}`;
      // tapping + a few times is one update in the history, not five
      const recent = await t.one<{ id: number }>(
        `select id from activity where batch_id = $1 and actor_id = $2 and action = 'progress.written' and created_at > now() - interval '15 minutes'
          and detail->>'writerId' = $3 order by created_at desc limit 1`, [id, me.id, String(uid)],
      );
      if (recent) await t.query(`update activity set summary = $2, created_at = now() where id = $1`, [recent.id, summary]);
      else await logActivity(t, { actor: me, action: 'progress.written', entityType: 'batch', entityId: id, batchId: id, clientId: b.client_id, summary, detail: { writerId: String(uid), written, total: mine.length } });
      return { written, total: mine.length, sent };
    });
  });

  app.post('/api/batches/:id/quick-progress', async (req) => {
    const me = requireUser(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const input = parse(z.object({
      draftReady: z.number().int().min(0).max(500),
      expected: z.number().int().min(0),
      writerId: zs.id.optional(),
    }), req.body);
    const writerId = input.writerId ?? me.id;
    if (writerId !== me.id && !isManager(me.role)) throw forbidden('You can only update your own progress');
    const mine = await db.query<{ id: number; number: number; status: ScriptStatus }>(
      `select id, number, status from scripts where batch_id = $1 and assignee_id = $2 and removed_at is null order by number`, [id, writerId],
    );
    if (!mine.length) throw forbidden('No scripts in this batch are assigned to you');
    const p = summarize(mine.map((s) => ({ status: s.status, assigneeId: writerId })));
    if (p.draftReady !== input.expected) {
      throw conflict(`Progress changed since you loaded it — it’s now ${p.draftReady} / ${p.total}. Check the new count and try again.`, 'stale');
    }
    const min = p.approved;
    const max = p.total - p.revisions;
    if (input.draftReady < min) throw new HttpError(400, `${plural(min, 'script is', 'scripts are')} already approved or delivered, so the count can’t go below ${min}.`);
    if (input.draftReady > max) throw new HttpError(400, p.revisions ? `Scripts with revision requests need to be resubmitted individually. The most you can set here is ${max}.` : `You have ${p.total} scripts in this batch.`);
    if (input.draftReady === p.draftReady) return { changed: [], batch: await loadBatchDetail(ctx, id, me) };
    let result;
    if (input.draftReady > p.draftReady) {
      // submit the writer's next scripts in order, preferring ones already in progress
      const candidates = [...mine.filter((s) => s.status === 'in_progress'), ...mine.filter((s) => s.status === 'not_started')];
      const pick = candidates.slice(0, input.draftReady - p.draftReady).map((s) => s.id);
      result = await applyScriptAction(ctx, me, id, 'submit', pick, { note: null, timelinerUrl: null, actingFor: writerId });
    } else {
      const inReview = mine.filter((s) => s.status === 'ready_for_review').reverse();
      const pick = inReview.slice(0, p.draftReady - input.draftReady).map((s) => s.id);
      result = await applyScriptAction(ctx, me, id, 'withdraw', pick, { note: null, timelinerUrl: null, actingFor: writerId });
    }
    return { ...result, batch: await loadBatchDetail(ctx, id, me) };
  });
}

// ── the one place script status changes happen ───────────────────────────

export async function applyScriptAction(
  ctx: Ctx, me: Me, batchId: number, action: ScriptAction, scriptIds: number[],
  opts: {
    note: string | null; timelinerUrl: string | null; versions?: Record<string, number>; actingFor?: number;
    /** a reviewer's attachment (marked-up PDF or edited doc) and the document being reviewed */
    review?: { url: string | null; fileId: number | null; submissionId?: number | null };
    /** set when scripts are sent as one document */
    submission?: { id: number; label: string; version: number };
  },
): Promise<{ changed: number[]; deliveryId?: number; reviewId?: number }> {
  const rule = ACTION_RULES[action];
  if (action === 'request_revisions' && !opts.note) throw new HttpError(400, 'Add a note so the writer knows what to change', { note: 'Add a note so the writer knows what to change' });
  const ids = [...new Set(scriptIds)];
  if (!ids.length) throw new HttpError(400, 'Select at least one script');

  return ctx.db.tx(async (t) => {
    const b = await t.one<{ client_id: number; title: string; client_name: string; archived_at: string | null }>(
      `select b.client_id, b.title, c.name as client_name, b.archived_at from batches b join clients c on c.id = b.client_id where b.id = $1`, [batchId],
    );
    if (!b) throw notFound('Batch');
    const rows = await t.query<{ id: number; number: number; status: ScriptStatus; assignee_id: number | null; version: number }>(
      `select id, number, status, assignee_id, version from scripts
        where batch_id = $1 and removed_at is null and id in (${ids.map((_, i) => `$${i + 2}`).join(',')})
        order by number for update`,
      [batchId, ...ids],
    );
    if (rows.length !== ids.length) throw conflict('Some selected scripts are no longer in this batch. Refresh and try again.');
    if (opts.versions) {
      const stale = rows.filter((r) => opts.versions![String(r.id)] !== undefined && opts.versions![String(r.id)] !== r.version);
      if (stale.length) throw conflict(`Script${stale.length > 1 ? 's' : ''} ${compressRanges(stale.map((r) => r.number))} changed since you loaded this page. Refresh and try again.`, 'stale');
    }
    const problems = new Map<string, number[]>();
    for (const r of rows) {
      const why = checkAction(action, { status: r.status, assigneeId: r.assignee_id }, me);
      if (why) problems.set(why, [...(problems.get(why) ?? []), r.number]);
    }
    if (problems.size) {
      const [why, nums] = [...problems.entries()][0];
      const permission = why.startsWith('Only') || why.startsWith('You can only');
      const extra = action === 'deliver' && why.startsWith('Not possible') ? ' Only approved scripts can be marked delivered.' : '';
      throw new HttpError(permission ? 403 : 409, `Script${nums.length > 1 ? 's' : ''} ${compressRanges(nums)}: ${why}.${extra}`, undefined, permission ? 'forbidden' : 'invalid_transition');
    }

    const nums = compressRanges(rows.map((r) => r.number));
    const idList = rows.map((r) => r.id);
    const inIds = idList.map((_, i) => `$${i + 1}`).join(',');
    let deliveryId: number | undefined;
    let reviewId: number | undefined;
    const attached = !!(opts.review?.url || opts.review?.fileId);

    if (action === 'approve' || action === 'request_revisions') {
      // one review record per decision, tied to the document when there is one
      let submissionId = opts.review?.submissionId ?? null;
      if (!submissionId) {
        const cur = await t.query<{ script_id: number; submission_id: number }>(
          `select script_id, max(submission_id) as submission_id from submission_scripts where script_id in (${inIds}) group by script_id`, idList,
        );
        const distinct = [...new Set(cur.map((c) => c.submission_id))];
        if (cur.length === idList.length && distinct.length === 1) submissionId = distinct[0];
      }
      const r = await t.one<{ id: number }>(
        `insert into reviews (batch_id, submission_id, action, script_ids, note, url, file_id, reviewed_by) values ($1,$2,$3,$4::jsonb,$5,$6,$7,$8) returning id`,
        [batchId, submissionId, action === 'approve' ? 'approved' : 'revisions', JSON.stringify(idList), opts.note, opts.review?.url ?? null, opts.review?.fileId ?? null, me.id],
      );
      reviewId = r!.id;
    }

    switch (action) {
      case 'submit':
        await t.query(`update scripts set status = 'ready_for_review', submitted_at = now(), version = version + 1, updated_at = now() where id in (${inIds})`, idList);
        await t.query(`update revision_requests set resolved_at = now(), resolved_by = $1, resolution = 'resubmitted' where resolved_at is null and script_id in (${idList.map((_, i) => `$${i + 2}`).join(',')})`, [me.id, ...idList]);
        break;
      case 'approve':
        await t.query(`update scripts set status = 'approved', approved_at = now(), approved_by = $1, version = version + 1, updated_at = now() where id in (${idList.map((_, i) => `$${i + 2}`).join(',')})`, [me.id, ...idList]);
        await t.query(`update revision_requests set resolved_at = now(), resolved_by = $1, resolution = 'approved' where resolved_at is null and script_id in (${idList.map((_, i) => `$${i + 2}`).join(',')})`, [me.id, ...idList]);
        break;
      case 'request_revisions':
        await t.query(`update scripts set status = 'revisions_needed', approved_at = null, approved_by = null, version = version + 1, updated_at = now() where id in (${inIds})`, idList);
        for (const sid of idList) {
          await t.query(`insert into revision_requests (script_id, batch_id, note, requested_by, review_id) values ($1, $2, $3, $4, $5)`, [sid, batchId, opts.note, me.id, reviewId]);
        }
        break;
      case 'deliver': {
        const d = await t.one<{ id: number }>(`insert into deliveries (batch_id, confirmed_by, timeliner_url, note) values ($1, $2, $3, $4) returning id`, [batchId, me.id, opts.timelinerUrl, opts.note]);
        deliveryId = d!.id;
        await t.query(
          `update scripts set status = 'delivered', delivered_at = now(), delivered_by = $1, delivery_id = $2,
                  timeliner_url = coalesce(timeliner_url, $3), version = version + 1, updated_at = now()
            where id in (${idList.map((_, i) => `$${i + 4}`).join(',')})`,
          [me.id, deliveryId, opts.timelinerUrl, ...idList],
        );
        break;
      }
      case 'undo_delivery':
        await t.query(`update scripts set status = 'approved', delivered_at = null, delivered_by = null, delivery_id = null, version = version + 1, updated_at = now() where id in (${inIds})`, idList);
        break;
      default:
        await t.query(`update scripts set status = $1, version = version + 1, updated_at = now() where id in (${idList.map((_, i) => `$${i + 2}`).join(',')})`, [rule.to, ...idList]);
    }

    const onBehalf = opts.actingFor && opts.actingFor !== me.id ? ' (on behalf of the writer)' : '';
    const verb: Record<ScriptAction, string> = {
      start: 'Started', reset: 'Marked not started', submit: 'Submitted for review', withdraw: 'Withdrew from review',
      approve: 'Approved', request_revisions: 'Requested revisions on', deliver: 'Confirmed delivery to Timeliner for', undo_delivery: 'Undid delivery of',
    };
    const scriptsWord = `script${rows.length > 1 ? 's' : ''} ${nums}`;
    const summary = action === 'submit' && opts.submission
      ? `Sent ${scriptsWord} for review as one document: “${opts.submission.label}”${opts.submission.version > 1 ? ` (version ${opts.submission.version})` : ''}${onBehalf}`
      : `${verb[action]} ${scriptsWord}${onBehalf}${opts.note && action !== 'deliver' ? ` — “${opts.note}”` : ''}${attached ? (action === 'approve' ? ' (edited version attached)' : ' (changes attached)') : ''}`;
    await logActivity(t, {
      actor: me, action: `scripts.${action}`, entityType: 'batch', entityId: batchId, batchId, clientId: b.client_id,
      summary,
      detail: { action, scripts: rows.map((r) => r.number), note: opts.note, timelinerUrl: opts.timelinerUrl, deliveryId: deliveryId ?? null },
    });

    // notifications
    const link = batchLink(batchId);
    const writers = [...new Set(rows.map((r) => r.assignee_id).filter((x): x is number => x != null))];
    if (action === 'submit') {
      const today = (await clockFor({ ...ctx, db: t })).today;
      const waiting = await t.query<{ number: number }>(`select number from scripts where batch_id = $1 and status = 'ready_for_review' and removed_at is null order by number`, [batchId]);
      if (opts.submission) {
        await notify(t, await managerIds(t), {
          type: 'review_request', title: `Ready for review · ${b.client_name}`,
          body: `${me.name} sent ${scriptsWord} of ${b.title} as one document (“${opts.submission.label}”${opts.submission.version > 1 ? `, version ${opts.submission.version}` : ''}).`,
          link: `/review`,
        }, me.id);
      } else {
        await notify(t, await managerIds(t), {
          type: 'review_request', title: `Ready for review · ${b.client_name}`,
          body: `${b.title}: ${plural(waiting.length, 'script')} waiting (${compressRanges(waiting.map((w) => w.number))}). Latest from ${me.name}.`,
          link: `/review`, dedupeKey: `review:${batchId}:${today}`, refresh: true,
        }, me.id);
      }
    } else if (action === 'approve') {
      await notify(t, writers, { type: 'approval', title: `Approved · ${b.title}`, body: `${me.name} approved ${scriptsWord}.${attached ? ' They attached their edited version — use that one.' : ''} Add ${rows.length > 1 ? 'them' : 'it'} to Timeliner and confirm delivery.`, link: '/my-work' }, me.id);
    } else if (action === 'request_revisions') {
      await notify(t, writers, { type: 'revision_request', title: `Revisions requested · ${b.title}`, body: `${scriptsWord}: ${opts.note}${attached ? ' (their changes are attached)' : ''}`, link: '/my-work' }, me.id);
    } else if (action === 'deliver') {
      await notify(t, await managerIds(t), {
        type: 'delivery', title: `Delivered to Timeliner · ${b.client_name}`,
        body: `${me.name} confirmed script${rows.length > 1 ? 's' : ''} ${nums} of ${b.title} (writer-confirmed).`, link,
      }, me.id);
    } else if (action === 'undo_delivery') {
      await notify(t, writers, { type: 'delivery', title: `Delivery undone · ${b.title}`, body: `${me.name} moved script${rows.length > 1 ? 's' : ''} ${nums} back to approved.`, link }, me.id);
    }
    await recordMoments(t, me, batchId, action, rows, b, { note: opts.note, attached });
    await t.query(`update batches set updated_at = now() where id = $1`, [batchId]);
    return { changed: idList, deliveryId, reviewId };
  });
}

// ── target preview ───────────────────────────────────────────────────────

export async function targetPreview(db: Db, batchId: number, count: number) {
  const active = await loadScripts(db, { batchId });
  const current = active.length;
  if (count >= current) {
    const removed = await db.query<{ number: number }>(`select number from scripts where batch_id = $1 and removed_at is not null order by number`, [batchId]);
    return { current, target: count, add: count - current, restore: removed.slice(0, count - current).map((r) => r.number), removable: [], defaultRemove: [], protectedCount: 0 };
  }
  const needed = current - count;
  const removable = active.filter((s) => s.status === 'not_started' || s.status === 'in_progress');
  // default: highest-numbered untouched placeholders first, then in-progress ones
  const ordered = [...removable].sort((a, b) => (a.status === b.status ? b.number - a.number : a.status === 'not_started' ? -1 : 1));
  return {
    current, target: count, add: 0, restore: [],
    needed,
    removable,
    defaultRemove: ordered.slice(0, needed).map((s) => s.id),
    protectedCount: current - removable.length,
    possible: removable.length >= needed,
  };
}

