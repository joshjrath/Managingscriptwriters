// Read-only views built from the same batch summaries: overview dashboard,
// calendar, review queue, My work, and the bootstrap payload.

import type { FastifyInstance } from 'fastify';
import { isManager } from '../../shared/workflow';
import { z } from 'zod';
import { clockFor, lastDeliveredAt, loadBatches, loadSettings, loadUsers, type Ctx, type ScriptLiteRow } from '../core';
import { requireUser } from '../auth';
import { parse, zs } from '../http';
import { loadBriefings, loadDeliveries, loadResources, loadRevisions, loadScripts, loadShoots } from '../records';
import { addDays, diffDays, nowInZone, startOfWeek, workingDaysBetween, type Clock, type ISODate } from '../../shared/dates';
import { isDraftReady, summarize, type ScriptStatus } from '../../shared/workflow';
import { plural } from '../../shared/format';
import type {
  AttentionItem, AttentionKind, BatchSummary, Bootstrap, CalendarEvent, Counts, Dashboard, DueCategory, DueDay, Me,
  MyWork, ReviewQueue, WriterLoad,
} from '../../shared/types';

const emptyCats = (): Record<DueCategory, number> => ({ not_started: 0, writing: 0, in_review: 0, to_deliver: 0 });

function category(status: ScriptStatus): DueCategory | null {
  switch (status) {
    case 'not_started': return 'not_started';
    case 'in_progress':
    case 'revisions_needed': return 'writing';
    case 'ready_for_review': return 'in_review';
    case 'approved': return 'to_deliver';
    default: return null;
  }
}

/** 14 days of due work plus an overdue bucket, counted in scripts. */
function dueByDay(kind: 'draft' | 'final', batches: BatchSummary[], scripts: Map<number, ScriptLiteRow[]>, clock: Clock): DueDay[] {
  const days: DueDay[] = [{ date: 'overdue', total: 0, byCategory: emptyCats(), items: [] }];
  const index = new Map<string, DueDay>();
  for (let i = 0; i < 14; i++) {
    const d = addDays(clock.today, i);
    const day: DueDay = { date: d, total: 0, byCategory: emptyCats(), items: [] };
    days.push(day);
    index.set(d, day);
  }
  for (const b of batches) {
    const m = kind === 'draft' ? b.draft : b.final;
    if (!m.date || m.complete) continue;
    const bucket = m.overdue ? days[0] : index.get(m.date);
    if (!bucket) continue;
    const cats = emptyCats();
    let count = 0;
    for (const s of scripts.get(b.id) ?? []) {
      if (kind === 'draft' && isDraftReady(s.status)) continue;
      const c = category(s.status);
      if (!c) continue;
      cats[c]++;
      count++;
    }
    if (!count) continue;
    bucket.total += count;
    for (const c of Object.keys(cats) as DueCategory[]) bucket.byCategory[c] += cats[c];
    bucket.items.push({ batchId: b.id, batchTitle: b.title, clientName: b.clientName, count, byCategory: cats });
  }
  return days;
}

const RANK: Record<AttentionKind, number> = { overdue: 0, blocked: 1, due_today: 2, date_review: 3, unassigned: 4, revisions: 5 };

export function attentionFor(batches: BatchSummary[]): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const b of batches) {
    if (b.stage === 'delivered') continue;
    const issues: AttentionItem['issues'] = [];
    if (b.final.overdue) issues.push({ kind: 'overdue', text: `Final delivery ${b.final.label.toLowerCase()} · ${plural(b.final.remaining, 'script')} not delivered` });
    else if (b.draft.overdue) issues.push({ kind: 'overdue', text: `Drafts ${b.draft.label.toLowerCase()} · ${plural(b.draft.remaining, 'script')} not draft-ready` });
    if (b.blocked) issues.push({ kind: 'blocked', text: `Blocked: ${b.blockerNote ?? 'no details'}` });
    if (b.final.dueToday) issues.push({ kind: 'due_today', text: `Final delivery due today · ${b.final.remaining} left` });
    else if (b.draft.dueToday) issues.push({ kind: 'due_today', text: `Drafts due today · ${b.draft.remaining} left` });
    if (b.needsDateReview) issues.push({ kind: 'date_review', text: b.dateReviewNote ?? 'Deadlines need review' });
    if (b.progress.unassigned) issues.push({ kind: 'unassigned', text: `${plural(b.progress.unassigned, 'script')} unassigned` });
    if (b.progress.revisions) issues.push({ kind: 'revisions', text: `${plural(b.progress.revisions, 'script')} returned for revisions` });
    if (!issues.length) continue;
    issues.sort((a, c) => RANK[a.kind] - RANK[c.kind]);
    out.push({ kind: issues[0].kind, batch: b, issues });
  }
  return out.sort((a, c) => RANK[a.kind] - RANK[c.kind] || (a.batch.next?.date ?? '9999').localeCompare(c.batch.next?.date ?? '9999'));
}

export function workloadFor(batches: BatchSummary[], scripts: Map<number, ScriptLiteRow[]>, users: Awaited<ReturnType<typeof loadUsers>>, clock: Clock, workingDays: number[]): WriterLoad[] {
  const active = batches.filter((b) => b.stage !== 'delivered');
  const horizon = addDays(clock.today, 6);
  const loads: WriterLoad[] = [];
  for (const u of users.filter((x) => x.active)) {
    let assigned = 0, remaining = 0, toDeliver = 0, overdueScripts = 0, dueNext7 = 0;
    const batchIds = new Set<number>();
    let blocked = 0;
    let next: WriterLoad['nextDeadline'] = null;
    for (const b of active) {
      const mine = (scripts.get(b.id) ?? []).filter((s) => s.assignee_id === u.id);
      if (!mine.length) continue;
      const p = summarize(mine.map((s) => ({ status: s.status, assigneeId: u.id })));
      if (p.delivered === p.total) continue;
      batchIds.add(b.id);
      if (b.blocked) blocked++;
      assigned += p.total;
      remaining += p.total - p.draftReady;
      toDeliver += p.awaitingDelivery;
      if (b.final.overdue) overdueScripts += p.total - p.delivered;
      else if (b.draft.overdue) overdueScripts += p.total - p.draftReady;
      if (b.draftDue && b.draftDue <= horizon) dueNext7 += p.total - p.draftReady;
      const cand = p.draftReady < p.total && b.draftDue
        ? { date: b.draftDue, kind: 'draft' as const }
        : b.finalDue ? { date: b.finalDue, kind: 'final' as const } : null;
      if (cand && (!next || cand.date < next.date)) next = { ...cand, batchId: b.id, batchTitle: b.title, clientName: b.clientName };
    }
    if (!assigned && isManager(u.role)) continue;
    const capacityNext7 = u.capacityPerDay ? Math.floor(u.capacityPerDay * workingDaysBetween(clock.today, horizon, workingDays)) : null;
    loads.push({
      userId: u.id, name: u.name, role: u.role, activeBatches: batchIds.size, assigned, remaining, toDeliver, overdueScripts,
      blockedBatches: blocked, nextDeadline: next, capacityPerDay: u.capacityPerDay, dueNext7, capacityNext7,
      overCapacity: capacityNext7 != null && dueNext7 > capacityNext7,
    });
  }
  return loads.sort((a, b) => b.overdueScripts - a.overdueScripts || b.remaining - a.remaining || a.name.localeCompare(b.name));
}

export async function computeCounts(ctx: Ctx, me: Me, batches?: BatchSummary[], scripts?: Map<number, ScriptLiteRow[]>): Promise<Counts> {
  const data = batches && scripts ? { summaries: batches, scripts } : await loadBatches(ctx);
  let myOpen = 0;
  for (const b of data.summaries) {
    for (const s of data.scripts.get(b.id) ?? []) {
      if (s.assignee_id === me.id && s.status !== 'delivered' && s.status !== 'ready_for_review') myOpen++;
    }
  }
  const unread = await ctx.db.one<{ n: number }>(`select count(*) as n from notifications where user_id = $1 and read_at is null`, [me.id]);
  return {
    myOpenScripts: myOpen,
    reviewQueue: isManager(me.role) ? data.summaries.reduce((n, b) => n + b.progress.inReview, 0) : 0,
    unreadNotifications: unread?.n ?? 0,
    attention: attentionFor(data.summaries).length,
  };
}

export function registerViewRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  app.get('/api/bootstrap', async (req): Promise<Bootstrap> => {
    const me = requireUser(req);
    const settings = await loadSettings(db);
    const clock = await clockFor(ctx, settings);
    const { summaries, scripts } = await loadBatches(ctx, {}, clock);
    const users = await loadUsers(db);
    const clients = await db.query<{ id: number; name: string; status: 'active' | 'archived' }>(`select id, name, status from clients order by lower(name)`);
    return { me, settings, users, clients, clock, counts: await computeCounts(ctx, me, summaries, scripts) };
  });

  app.get('/api/counts', async (req) => computeCounts(ctx, requireUser(req)));

  app.get('/api/dashboard', async (req): Promise<Dashboard> => {
    requireUser(req);
    const settings = await loadSettings(db);
    const clock = await clockFor(ctx, settings);
    const { summaries, scripts } = await loadBatches(ctx, {}, clock);
    const users = await loadUsers(db);

    const overdue = summaries.filter((b) => b.draft.overdue || b.final.overdue);
    const dueToday = summaries.filter((b) => b.draft.dueToday || b.final.dueToday);
    const weekStart = startOfWeek(clock.today);
    let deliveredWeek = 0;
    const deliveredBatches = new Set<number>();
    for (const b of summaries) {
      for (const s of scripts.get(b.id) ?? []) {
        if (s.status === 'delivered' && s.delivered_at && nowInZone(clock.timezone, new Date(s.delivered_at)).date >= weekStart) {
          deliveredWeek++;
          deliveredBatches.add(b.id);
        }
      }
    }
    const shoots = (await loadShoots(db, { from: clock.today, to: addDays(clock.today, 45), activeClientsOnly: true }))
      .filter((s) => !s.cancelledAt)
      .slice(0, 6)
      .map((s) => ({ ...s, batches: summaries.filter((b) => b.shootId === s.id), daysUntil: diffDays(s.startDate, clock.today) }));
    const deliveries = await loadDeliveries(db, { limit: 8 });
    const titles = new Map((await db.query<{ id: number; title: string; client_name: string }>(
      `select b.id, b.title, c.name as client_name from batches b join clients c on c.id = b.client_id`,
    )).map((r) => [r.id, r]));

    return {
      clock,
      cards: {
        overdueBatches: overdue.length,
        overdueScripts: overdue.reduce((n, b) => n + (b.final.overdue ? b.final.remaining : b.draft.remaining), 0),
        dueTodayBatches: dueToday.length,
        dueTodayScripts: dueToday.reduce((n, b) => n + Math.max(b.draft.dueToday ? b.draft.remaining : 0, b.final.dueToday ? b.final.remaining : 0), 0),
        awaitingReviewScripts: summaries.reduce((n, b) => n + b.progress.inReview, 0),
        awaitingReviewBatches: summaries.filter((b) => b.progress.inReview > 0).length,
        deliveredThisWeekScripts: deliveredWeek,
        deliveredThisWeekBatches: deliveredBatches.size,
      },
      due: { draft: dueByDay('draft', summaries, scripts, clock), final: dueByDay('final', summaries, scripts, clock) },
      attention: attentionFor(summaries),
      upcomingShoots: shoots,
      activeBatches: summaries
        .filter((b) => b.stage !== 'delivered')
        .sort((a, b) => (a.next?.date ?? '9999').localeCompare(b.next?.date ?? '9999')),
      workload: workloadFor(summaries, scripts, users, clock, settings.workingDays),
      recentDeliveries: deliveries.map((d) => ({ ...d, batchTitle: titles.get(d.batchId)?.title ?? '', clientName: titles.get(d.batchId)?.client_name ?? '' })),
      unassignedScripts: summaries.reduce((n, b) => n + b.progress.unassigned, 0),
    };
  });

  app.get('/api/calendar', async (req) => {
    requireUser(req);
    const q = parse(z.object({ from: zs.date, to: zs.date, writerId: zs.id.optional(), clientId: zs.id.optional() }), req.query);
    const clock = await clockFor(ctx);
    const { summaries } = await loadBatches(ctx, { clientId: q.clientId }, clock);
    const events: CalendarEvent[] = [];
    const within = (a: ISODate, b: ISODate) => a <= q.to && b >= q.from;
    for (const b of summaries) {
      if (q.writerId && !b.writers.some((w) => w.userId === q.writerId)) continue;
      const base = { clientName: b.clientName, batchId: b.id, shootId: b.shootId };
      if (b.plannedStart && b.draftDue && within(b.plannedStart, b.draftDue)) {
        events.push({ ...base, id: `w${b.id}`, type: 'writing', start: b.plannedStart, end: b.draftDue, title: b.title, overdue: b.draft.overdue, complete: b.draft.complete });
      }
      if (b.draftDue && within(b.draftDue, b.draftDue)) {
        events.push({ ...base, id: `d${b.id}`, type: 'draft', start: b.draftDue, end: b.draftDue, title: b.title, overdue: b.draft.overdue, complete: b.draft.complete });
      }
      if (b.finalDue && within(b.finalDue, b.finalDue)) {
        events.push({ ...base, id: `f${b.id}`, type: 'final', start: b.finalDue, end: b.finalDue, title: b.title, overdue: b.final.overdue, complete: b.final.complete });
      }
    }
    const shootBatchIds = new Set(summaries.filter((b) => !q.writerId || b.writers.some((w) => w.userId === q.writerId)).map((b) => b.shootId));
    for (const s of await loadShoots(db, { from: q.from, to: q.to, clientId: q.clientId, activeClientsOnly: !q.clientId })) {
      if (s.cancelledAt) continue;
      if (q.writerId && !shootBatchIds.has(s.id)) continue;
      events.push({
        id: `s${s.id}`, type: 'shoot', start: s.startDate, end: s.endDate ?? s.startDate, title: s.title || 'Shoot', clientName: s.clientName,
        batchId: s.batchIds[0] ?? null, shootId: s.id, overdue: false, complete: (s.endDate ?? s.startDate) < clock.today,
      });
    }
    return { events, clock };
  });

  app.get('/api/review', async (req): Promise<ReviewQueue> => {
    requireUser(req);
    const clock = await clockFor(ctx);
    const { summaries } = await loadBatches(ctx, {}, clock);
    const byId = new Map(summaries.map((b) => [b.id, b]));
    const waiting = (await loadScripts(db, { status: 'ready_for_review' })).filter((s) => byId.has(s.batchId));
    const grouped = new Map<number, typeof waiting>();
    for (const s of waiting) grouped.set(s.batchId, [...(grouped.get(s.batchId) ?? []), s]);
    const batches = [...grouped.entries()]
      .map(([bid, list]) => ({ batch: byId.get(bid)!, scripts: list }))
      .sort((a, b) => (a.batch.finalDue ?? '9999').localeCompare(b.batch.finalDue ?? '9999'));
    return { batches, revisions: await openRevisions(ctx, summaries) };
  });

  app.get('/api/my-work', async (req): Promise<MyWork> => {
    const me = requireUser(req);
    const q = parse(z.object({ userId: zs.id.optional() }), req.query);
    const uid = isManager(me.role) && q.userId ? q.userId : me.id;
    const clock = await clockFor(ctx);
    const { summaries, scripts } = await loadBatches(ctx, {}, clock);
    const recentCut = new Date(ctx.now().getTime() - 7 * 86400_000).toISOString();
    const mineBatches = summaries.filter((b) => {
      const mine = (scripts.get(b.id) ?? []).filter((s) => s.assignee_id === uid);
      if (!mine.length) return false;
      if (mine.every((s) => s.status === 'delivered')) {
        const last = lastDeliveredAt(mine);
        return !!last && last > recentCut; // keep just-finished work visible for a week
      }
      return true;
    });
    const allScripts = await loadScripts(db, { assigneeId: uid });
    const briefings = await Promise.all(mineBatches.map((b) => loadBriefings(db, { batchId: b.id })));
    const resources = await Promise.all(mineBatches.map((b) => loadResources(db, { batchId: b.id, includeArchivedClients: true })));
    const rank = (b: BatchSummary) => (b.next?.overdue ? 0 : b.next?.dueToday ? 1 : 2);
    const list = mineBatches.map((b, i) => {
      const mine = allScripts.filter((s) => s.batchId === b.id);
      return { batch: b, mine, myProgress: summarize(mine.map((s) => ({ status: s.status, assigneeId: s.assigneeId }))), briefings: briefings[i], resources: resources[i] };
    }).sort((a, b) => {
      const doneA = a.myProgress.delivered === a.myProgress.total ? 1 : 0;
      const doneB = b.myProgress.delivered === b.myProgress.total ? 1 : 0;
      return doneA - doneB || rank(a.batch) - rank(b.batch) || (a.batch.next?.date ?? '9999').localeCompare(b.batch.next?.date ?? '9999');
    });
    const revisions = (await openRevisions(ctx, summaries)).filter((r) => allScripts.some((s) => s.id === r.scriptId));
    const deliveries = await loadDeliveries(db, { confirmedBy: uid, limit: 5 });
    const byId = new Map(summaries.map((b) => [b.id, b]));
    return {
      batches: list, revisions,
      recentDeliveries: deliveries.map((d) => ({ ...d, batchTitle: byId.get(d.batchId)?.title ?? '', clientName: byId.get(d.batchId)?.clientName ?? '' })),
    };
  });
}

async function openRevisions(ctx: Ctx, summaries: BatchSummary[]): Promise<ReviewQueue['revisions']> {
  const byId = new Map(summaries.map((b) => [b.id, b]));
  const open = await loadRevisions(ctx.db, { openOnly: true, batchIds: summaries.map((b) => b.id) });
  if (!open.length) return [];
  const scripts = await loadScripts(ctx.db, { ids: [...new Set(open.map((r) => r.scriptId))] });
  const sById = new Map(scripts.map((s) => [s.id, s]));
  return open.map((r) => ({
    ...r,
    batchTitle: byId.get(r.batchId)?.title ?? '',
    clientName: byId.get(r.batchId)?.clientName ?? '',
    assigneeName: sById.get(r.scriptId)?.assigneeName ?? null,
    scriptStatus: sById.get(r.scriptId)?.status ?? 'revisions_needed',
  }));
}
