// Shoots. Creating one also creates its script batch with calculated
// deadlines. Moving one previews the changes, recalculates automatic dates,
// moves planned writing starts by the same number of days, renames batches
// that were named after the shoot's dates, keeps manual overrides (flagging
// them for review) unless asked to move them too, logs, and notifies.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db';
import { assigneesOf, batchLink, clockFor, loadBatch, loadSettings, logActivity, notify, rulesOf, type Ctx } from '../core';
import { requireManager, requireUser } from '../auth';
import { HttpError, notFound, optionalDate, parse, zs } from '../http';
import { loadShoots } from '../records';
import { batchFields, insertBatch } from './batches';
import { addDays, computeDeadlines, diffDays, dueState, type Clock, type ISODate } from '../../shared/dates';
import { fmtDate, fmtRange } from '../../shared/format';
import type { Me, ReschedulePreview, Settings } from '../../shared/types';

const shootCreate = z.object({
  clientId: zs.id.optional(),
  /** a client that isn't on the site yet (e.g. a new name on the synced calendar): created with the shoot */
  newClientName: z.string().trim().min(1).max(120).optional(),
  /** the synced-calendar event this shoot was planned from, so it drops off "Shoots that need writers" */
  calendarUid: z.string().max(600).optional(),
  title: zs.text(200),
  startDate: zs.date,
  endDate: optionalDate,
  location: zs.text(300),
  notes: zs.text(4000),
  batch: z.object({
    title: zs.text(200),
    targetCount: batchFields.targetCount,
    priority: batchFields.priority,
    plannedStart: batchFields.plannedStart,
    draftDue: batchFields.draftDue,
    finalDue: batchFields.finalDue,
    brief: batchFields.brief,
    nextAction: batchFields.nextAction,
    briefingIds: batchFields.briefingIds,
    resourceIds: z.array(zs.id).max(100).optional(),
    split: batchFields.split,
  }).optional(), // leave out to schedule the shoot now and plan its scripts later
});

const datesSchema = z.object({ startDate: zs.date, endDate: optionalDate, shiftManual: z.boolean().optional() });

export async function insertShoot(t: Db, me: Me, input: z.infer<typeof shootCreate>, settings: Settings, clock: Clock) {
  if (input.endDate && input.endDate < input.startDate) {
    throw new HttpError(400, 'The shoot can’t end before it starts', { endDate: 'The shoot can’t end before it starts' });
  }
  let clientId = input.clientId;
  if (!clientId && input.newClientName) {
    const same = await t.one<{ id: number }>(`select id from clients where lower(name) = lower($1) and status <> 'archived' order by id limit 1`, [input.newClientName]);
    if (same) clientId = same.id;
    else {
      const c = await t.one<{ id: number }>(`insert into clients (name, status, owner_id, created_by) values ($1, 'active', $2, $2) returning id`, [input.newClientName, me.id]);
      clientId = c!.id;
      await logActivity(t, { actor: me, action: 'client.created', entityType: 'client', entityId: clientId, clientId, summary: `Created client ${input.newClientName} while planning a shoot` });
    }
  }
  if (!clientId) throw new HttpError(400, 'Choose a client', { clientId: 'Choose a client' });
  const client = await t.one<{ name: string; status: string }>(`select name, status from clients where id = $1`, [clientId]);
  if (!client) throw new HttpError(400, 'Choose a client', { clientId: 'Choose a client' });
  if (client.status === 'archived') throw new HttpError(400, 'This client is archived', { clientId: 'This client is archived' });
  const endDate = input.endDate && input.endDate !== input.startDate ? input.endDate : null;
  const shoot = await t.one<{ id: number }>(
    `insert into shoots (client_id, title, start_date, end_date, location, notes, created_by, calendar_uid) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [clientId, input.title ?? null, input.startDate, endDate, input.location ?? null, input.notes ?? null, me.id, input.calendarUid ?? null],
  );
  const shootId = shoot!.id;
  await logActivity(t, {
    actor: me, action: 'shoot.created', entityType: 'shoot', entityId: shootId, clientId,
    summary: `Scheduled shoot ${fmtRange(input.startDate, endDate)}${input.title ? ` (“${input.title}”)` : ''}`,
  });
  if (!input.batch) {
    const planBy = addDays(input.startDate, -settings.planReminderDays);
    return {
      shootId, batchId: null,
      warnings: [`No scripts planned yet. Add them from the shoot when you know the count and writers — you’ll get a reminder ${planBy > clock.today ? `on ${fmtDate(planBy)}` : 'soon'} if they’re still not planned.`],
    };
  }
  // a batch with no name of its own is called after the shoot, or the client when the shoot has no name
  const title = input.batch.title || autoTitle(input.title ?? null, input.startDate, endDate, client.name);
  const created = await insertBatch(t, me, { ...input.batch, title, clientId, shootId }, settings, clock);
  return { shootId, clientId, ...created };
}

/** The name a batch gets when it's created with its shoot and no title of its own. */
const autoTitle = (shootTitle: string | null, start: ISODate, end: ISODate | null, clientName?: string) => `${shootTitle || clientName || 'Shoot'} · ${fmtRange(start, end)}`;

export async function reschedulePreview(db: Db, settings: Settings, clock: Clock, shootId: number, startDate: ISODate, endDate: ISODate | null, shiftManual = false): Promise<ReschedulePreview> {
  const [shoot] = await loadShoots(db, { id: shootId });
  if (!shoot) throw notFound('Shoot');
  const days = diffDays(startDate, shoot.startDate);
  const next = computeDeadlines(startDate, rulesOf(settings));
  const batches = await db.query<{ id: number; title: string; planned_start: ISODate | null; draft_due: ISODate | null; draft_due_mode: 'auto' | 'manual'; final_due: ISODate | null; final_due_mode: 'auto' | 'manual' }>(
    `select id, title, planned_start, draft_due, draft_due_mode, final_due, final_due_mode from batches where shoot_id = $1 and archived_at is null order by id`, [shootId],
  );
  const changes: ReschedulePreview['changes'] = [];
  const plannedStarts: ReschedulePreview['plannedStarts'] = [];
  const renames: ReschedulePreview['renames'] = [];
  const newEnd = endDate && endDate !== startDate ? endDate : null;
  // batches named after the shoot (either way it can be named) follow its dates
  const oldNames = [autoTitle(shoot.title, shoot.startDate, shoot.endDate), autoTitle(shoot.title, shoot.startDate, shoot.endDate, shoot.clientName)];
  for (const b of batches) {
    for (const field of ['draftDue', 'finalDue'] as const) {
      const mode = field === 'draftDue' ? b.draft_due_mode : b.final_due_mode;
      const from = field === 'draftDue' ? b.draft_due : b.final_due;
      const shifted = mode === 'manual' && shiftManual && !!from;
      const to = mode === 'auto' ? (field === 'draftDue' ? next.draftDue : next.finalDue) : shifted ? addDays(from!, days) : from;
      changes.push({ batchId: b.id, batchTitle: b.title, field, mode, from, to, kept: mode === 'manual' && !shifted, inPast: !!to && dueState(to, clock).overdue });
    }
    if (b.planned_start && days) plannedStarts.push({ batchId: b.id, batchTitle: b.title, from: b.planned_start, to: addDays(b.planned_start, days) });
    const k = oldNames.indexOf(b.title);
    const newName = k === 0 ? autoTitle(shoot.title, startDate, newEnd) : autoTitle(shoot.title, startDate, newEnd, shoot.clientName);
    if (k >= 0 && b.title !== newName) renames.push({ batchId: b.id, from: b.title, to: newName });
  }
  const writerRows = batches.length
    ? await db.query<{ name: string }>(
      `select distinct u.name from scripts s join users u on u.id = s.assignee_id
        where s.removed_at is null and s.status <> 'delivered' and s.batch_id in (${batches.map((_, i) => `$${i + 1}`).join(',')}) order by u.name`,
      batches.map((b) => b.id),
    )
    : [];
  // drafts must never end up due after final delivery
  const outOfOrder: ReschedulePreview['outOfOrder'] = [];
  for (const b of batches) {
    const d = changes.find((c) => c.batchId === b.id && c.field === 'draftDue')?.to;
    const f = changes.find((c) => c.batchId === b.id && c.field === 'finalDue')?.to;
    if (d && f && d > f) outOfOrder.push({ batchId: b.id, batchTitle: b.title, draftDue: d, finalDue: f });
  }
  return {
    shoot, newStart: startDate, newEnd: endDate && endDate !== startDate ? endDate : null, days, changes, plannedStarts, renames,
    manualCount: changes.filter((c) => c.mode === 'manual' && c.from).length, affectedWriters: writerRows.map((r) => r.name), outOfOrder,
  };
}

export function registerShootRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  app.get('/api/shoots', async (req) => {
    requireUser(req);
    const q = parse(z.object({ clientId: zs.id.optional(), from: zs.date.optional(), to: zs.date.optional() }), req.query);
    return { shoots: await loadShoots(db, { ...q, activeClientsOnly: !q.clientId }) };
  });

  app.post('/api/shoots', async (req) => {
    const me = requireManager(req);
    const input = parse(shootCreate, req.body);
    const settings = await loadSettings(db);
    const clock = await clockFor(ctx, settings);
    const created = await db.tx((t) => insertShoot(t, me, input, settings, clock));
    const deadlines = computeDeadlines(input.startDate, rulesOf(settings));
    return { ...created, deadlines, batch: created.batchId ? await loadBatch(ctx, created.batchId, clock) : null };
  });

  app.patch('/api/shoots/:id', async (req) => {
    const me = requireManager(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const input = parse(z.object({ title: zs.text(200), location: zs.text(300), notes: zs.text(4000) }), req.body);
    const s = await db.one<{ client_id: number }>(
      `update shoots set title = coalesce($2, title), location = $3, notes = $4, updated_at = now() where id = $1 returning client_id`,
      [id, input.title ?? null, input.location ?? null, input.notes ?? null],
    );
    if (!s) throw notFound('Shoot');
    await logActivity(db, { actor: me, action: 'shoot.updated', entityType: 'shoot', entityId: id, clientId: s.client_id, summary: 'Updated shoot details' });
    return { shoot: (await loadShoots(db, { id }))[0] };
  });

  app.post('/api/shoots/:id/reschedule-preview', async (req) => {
    requireManager(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const input = parse(datesSchema, req.body);
    if (input.endDate && input.endDate < input.startDate) throw new HttpError(400, 'The shoot can’t end before it starts', { endDate: 'The shoot can’t end before it starts' });
    const settings = await loadSettings(db);
    return reschedulePreview(db, settings, await clockFor(ctx, settings), id, input.startDate, input.endDate ?? null, input.shiftManual);
  });

  app.post('/api/shoots/:id/reschedule', async (req) => {
    const me = requireManager(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const input = parse(datesSchema, req.body);
    if (input.endDate && input.endDate < input.startDate) throw new HttpError(400, 'The shoot can’t end before it starts', { endDate: 'The shoot can’t end before it starts' });
    const settings = await loadSettings(db);
    const clock = await clockFor(ctx, settings);
    const endDate = input.endDate && input.endDate !== input.startDate ? input.endDate : null;

    const preview = await db.tx(async (t) => {
      const old = await t.one<{ client_id: number; start_date: ISODate; end_date: ISODate | null }>(`select client_id, start_date, end_date from shoots where id = $1 for update`, [id]);
      if (!old) throw notFound('Shoot');
      const p = await reschedulePreview(t, settings, clock, id, input.startDate, endDate, input.shiftManual);
      if (old.start_date === input.startDate && old.end_date === endDate) return p;
      await t.query(`update shoots set start_date = $2, end_date = $3, updated_at = now() where id = $1`, [id, input.startDate, endDate]);
      const moved = `Shoot moved ${fmtRange(old.start_date, old.end_date)} → ${fmtRange(input.startDate, endDate)}`;
      await logActivity(t, { actor: me, action: 'shoot.rescheduled', entityType: 'shoot', entityId: id, clientId: old.client_id, summary: moved });

      for (const batchId of [...new Set(p.changes.map((c) => c.batchId))]) {
        const rows = p.changes.filter((c) => c.batchId === batchId);
        const draft = rows.find((c) => c.field === 'draftDue')!;
        const final = rows.find((c) => c.field === 'finalDue')!;
        const kept = rows.filter((c) => c.kept);
        const note = kept.length
          ? `${moved}. Manual ${kept.map((k) => `${k.field === 'draftDue' ? 'draft' : 'final delivery'} date (${fmtDate(k.from)})`).join(' and ')} kept — confirm ${kept.length > 1 ? 'they still work' : 'it still works'}.`
          : null;
        const planned = p.plannedStarts.find((x) => x.batchId === batchId);
        const rename = p.renames.find((x) => x.batchId === batchId);
        await t.query(
          `update batches set draft_due = $2, final_due = $3, needs_date_review = needs_date_review or $4, date_review_note = coalesce($5, date_review_note),
                  planned_start = coalesce($6, planned_start), title = coalesce($7, title), updated_at = now() where id = $1`,
          [batchId, draft.to, final.to, kept.length > 0, note, planned?.to ?? null, rename?.to ?? null],
        );
        const parts = [
          ...rows.filter((c) => !c.kept && c.from !== c.to).map((c) => `${c.field === 'draftDue' ? 'Drafts' : 'Final delivery'}${c.mode === 'manual' ? ' (manual, moved too)' : ''} ${fmtDate(c.from)} → ${fmtDate(c.to)}`),
          ...(planned ? [`Writing start ${fmtDate(planned.from)} → ${fmtDate(planned.to)}`] : []),
          ...(rename ? [`Renamed to “${rename.to}”`] : []),
        ];
        const past = rows.filter((c) => c.inPast).map((c) => `${c.field === 'draftDue' ? 'Drafts' : 'Final delivery'} date ${fmtDate(c.to)} is already past`);
        const summary = [moved, ...parts, ...(kept.length ? [`kept manual ${kept.map((k) => (k.field === 'draftDue' ? 'draft' : 'final')).join(' & ')} date`] : []), ...past].join(' · ');
        await logActivity(t, { actor: me, action: 'batch.deadlines', entityType: 'batch', entityId: batchId, batchId, clientId: old.client_id, summary, detail: { changes: rows } });
        await notify(t, await assigneesOf(t, batchId, { undeliveredOnly: true }), {
          type: 'deadline_change', title: `Shoot moved · ${rename?.to ?? draft.batchTitle}`,
          body: [moved + '.', ...parts.map((x) => x + '.'), ...(kept.length ? ['Manual dates were kept for now.'] : []), ...past.map((x) => x + '.')].join(' '),
          link: batchLink(batchId),
        }, me.id);
      }
      return p;
    });
    return preview;
  });
}
