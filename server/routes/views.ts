// Read-only views built from the same batch summaries: overview dashboard,
// calendar, review queue, My work, and the bootstrap payload.

import type { FastifyInstance } from 'fastify';
import { isManager } from '../../shared/workflow';
import { z } from 'zod';
import { clockFor, lastDeliveredAt, loadBatches, loadSeen, loadSettings, loadUsers, type Ctx, type ScriptLiteRow } from '../core';
import { requireUser } from '../auth';
import { buildGroups, loadReviewQueue, publicSubmission } from '../submissions';
import { parse, zs } from '../http';
import { loadBriefings, loadDeliveries, loadResources, loadScripts, loadShoots } from '../records';
import { addDays, diffDays, nowInZone, startOfWeek, workingDaysBetween, type Clock, type ISODate } from '../../shared/dates';
import { bothLate, isDraftReady, isNewWork, milestone, nextMilestone, summarize, type Milestone, type ScriptStatus } from '../../shared/workflow';
import { plural } from '../../shared/format';
import { sessionMode } from '../recording';
import type {
  AttentionItem, AttentionKind, BatchSummary, Bootstrap, CalendarEvent, Counts, Dashboard, DueCategory, DueDay, Me,
  MyWork, ReviewQueue, ShootReadiness, WriterLoad,
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

/** People who can't sign in any more (deactivated or removed), by id. */
export async function inactivePeople(db: Ctx['db']): Promise<Map<number, string>> {
  const rows = await db.query<{ id: number; name: string }>(`select id, name from users where not active or removed_at is not null`);
  return new Map(rows.map((r) => [r.id, r.name]));
}

export function attentionFor(batches: BatchSummary[], inactive: Map<number, string> = new Map()): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const b of batches) {
    if (b.stage === 'delivered') continue;
    const issues: AttentionItem['issues'] = [];
    // scripts left with someone who can't sign in any more
    for (const w of b.writers) {
      const left = w.count - w.delivered;
      if (w.userId != null && inactive.has(w.userId) && left > 0) issues.push({ kind: 'unassigned', text: `${plural(left, 'script')} still with ${w.name}, who’s deactivated · reassign them` });
    }
    const both = bothLate(b.draft, b.final);
    if (both) issues.push({ kind: 'overdue', text: `${both} · ${plural(b.final.remaining, 'script')} not delivered` });
    else if (b.final.overdue) issues.push({ kind: 'overdue', text: `Final delivery ${b.final.label.toLowerCase()} · ${plural(b.final.remaining, 'script')} not delivered` });
    else if (b.draft.overdue) issues.push({ kind: 'overdue', text: `Drafts ${b.draft.label.toLowerCase()} · ${plural(b.draft.remaining, 'script')} with drafts not sent` });
    if (b.blocked) issues.push({ kind: 'blocked', text: `Blocked: ${b.blockerNote ?? 'no details'}` });
    if (b.final.dueToday) issues.push({ kind: 'due_today', text: `Final delivery due today · ${b.final.remaining} left` });
    else if (b.draft.dueToday) issues.push({ kind: 'due_today', text: `Drafts due today · ${b.draft.remaining} left` });
    if (b.needsDateReview) issues.push({ kind: 'date_review', text: b.dateReviewNote ?? 'Deadlines need review' });
    if (b.progress.unassigned) issues.push({ kind: 'unassigned', text: `${plural(b.progress.unassigned, 'script')} unassigned` });
    if (b.progress.revisions) issues.push({ kind: 'revisions', text: `${plural(b.progress.revisions, 'script')} sent back` });
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
  for (const u of users.filter((x) => x.active && x.role !== 'editor')) {
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
  let myNew = 0;
  const now = ctx.now();
  const seen = await loadSeen(ctx.db, me.id);
  for (const b of data.summaries) {
    const mine = (data.scripts.get(b.id) ?? []).filter((s) => s.assignee_id === me.id);
    for (const s of mine) {
      if (s.status !== 'delivered' && s.status !== 'ready_for_review') myOpen++;
    }
    const written = b.writers.find((w) => w.userId === me.id)?.written ?? 0;
    if (isNewWork(mine.map((s) => ({ status: s.status, assignedAt: s.assigned_at ?? null })), written, now, seen.get(b.id) ?? null)) myNew++;
  }
  const unread = await ctx.db.one<{ n: number }>(`select count(*) as n from notifications where user_id = $1 and read_at is null`, [me.id]);
  return {
    myOpenScripts: myOpen,
    myNewWork: myNew,
    reviewQueue: isManager(me.role) ? data.summaries.reduce((n, b) => n + b.progress.inReview, 0) : 0,
    unreadNotifications: unread?.n ?? 0,
    attention: isManager(me.role) ? attentionFor(data.summaries, await inactivePeople(ctx.db)).length : attentionFor(data.summaries).length,
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
    const clients = await db.query<{ id: number; name: string; status: 'prospect' | 'active' | 'archived' }>(`select id, name, status from clients order by lower(name)`);
    const seen = await db.one<{ whats_new_seen: string | null; timezone: string | null; timezone_confirmed_at: string | null; temp: boolean }>(
      `select whats_new_seen, timezone, timezone_confirmed_at, temp_password is not null as temp from users where id = $1`, [me.id]);
    return {
      me, mode: sessionMode(req), notesImport: !!ctx.notesReader, whatsNewSeen: seen?.whats_new_seen ?? null,
      timezone: { mine: seen?.timezone ?? null, confirmed: !!seen?.timezone_confirmed_at },
      // still on the temporary password someone gave them: ask for their own
      mustChangePassword: !!seen?.temp && !sessionMode(req)?.viewingAs,
      settings, users, clients, clock, counts: await computeCounts(ctx, me, summaries, scripts),
    };
  });

  app.get('/api/counts', async (req) => computeCounts(ctx, requireUser(req)));

  app.get('/api/dashboard', async (req): Promise<Dashboard> => {
    const me = requireUser(req);
    // Admins and managers see the whole team; a writer sees only their own scripts.
    const mine = !isManager(me.role);
    const settings = await loadSettings(db);
    const clock = await clockFor(ctx, settings);
    const { summaries, scripts } = await loadBatches(ctx, mine ? { assigneeId: me.id } : {}, clock);
    const users = (await loadUsers(db)).filter((u) => !mine || u.id === me.id);

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
      .filter((s) => !s.cancelledAt && (!mine || summaries.some((b) => b.shootId === s.id)))
      .slice(0, 6)
      .map((s) => ({ ...s, batches: summaries.filter((b) => b.shootId === s.id), daysUntil: diffDays(s.startDate, clock.today) }));
    const deliveries = await loadDeliveries(db, mine ? { confirmedBy: me.id, limit: 8 } : { limit: 8 });
    const titles = new Map((await db.query<{ id: number; title: string; client_name: string }>(
      `select b.id, b.title, c.name as client_name from batches b join clients c on c.id = b.client_id`,
    )).map((r) => [r.id, r]));

    return {
      clock,
      scope: mine ? 'mine' : 'team',
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
      attention: attentionFor(summaries, mine ? new Map() : await inactivePeople(db)),
      upcomingShoots: shoots,
      activeBatches: summaries
        .filter((b) => b.stage !== 'delivered')
        .sort((a, b) => (a.next?.date ?? '9999').localeCompare(b.next?.date ?? '9999')),
      workload: workloadFor(summaries, scripts, users, clock, settings.workingDays),
      recentDeliveries: deliveries.map((d) => ({ ...d, batchTitle: titles.get(d.batchId)?.title ?? '', clientName: titles.get(d.batchId)?.client_name ?? '' })),
      unassignedScripts: summaries.reduce((n, b) => n + b.progress.unassigned, 0),
    };
  });

  /** Events from synced calendars (Google Calendar), on the days they fall in the viewer's own time zone. */
  const syncedEvents = async (me: Me, from: ISODate, to: ISODate, today: ISODate): Promise<CalendarEvent[]> => {
    const tzRow = await db.one<{ timezone: string | null }>(`select timezone from users where id = $1`, [me.id]);
    const tz = tzRow?.timezone ?? (await loadSettings(db)).timezone;
    // a day either side catches events that land on a different date in someone's own zone
    const rows = await db.query<{ id: number; feed_id: number; feed_name: string; color: string; uid: string; title: string; location: string | null; description: string | null; all_day: boolean; start_at: string; end_at: string; start_date: string | null; end_date: string | null }>(
      `select e.id, e.feed_id, f.name as feed_name, f.color, e.uid, e.title, e.location, e.description, e.all_day, e.start_at, e.end_at, e.start_date::text as start_date, e.end_date::text as end_date
         from calendar_events e join calendar_feeds f on f.id = e.feed_id
        where e.start_at < ($2::date + 2)::timestamptz and e.end_at > ($1::date - 1)::timestamptz ${isManager(me.role) ? '' : me.role === 'editor' ? `and f.visibility in ('editors', 'everyone')` : `and f.visibility = 'everyone'`}
        order by e.start_at limit 2000`, [from, to],
    );
    const dayIn = (at: string | Date) => nowInZone(tz, new Date(at)).date;
    // shoots planned from these events, so the calendar can show them as one
    const uids = [...new Set(rows.map((r) => r.uid))];
    const linked = new Map<string, { shoot: number; batch: number | null }>();
    if (uids.length) {
      const ls = await db.query<{ id: number; calendar_uid: string; batch_id: number | null }>(
        `select s.id, s.calendar_uid, (select min(b.id) from batches b where b.shoot_id = s.id and b.archived_at is null) as batch_id
           from shoots s where s.calendar_uid = any($1) and s.cancelled_at is null`, [uids],
      );
      for (const l of ls) linked.set(l.calendar_uid, { shoot: Number(l.id), batch: l.batch_id == null ? null : Number(l.batch_id) });
    }
    const out: CalendarEvent[] = [];
    for (const r of rows) {
      const start = r.all_day ? r.start_date! : dayIn(r.start_at);
      // an event ending exactly at midnight belongs to the day before
      const end = r.all_day ? r.end_date! : dayIn(new Date(Math.max(new Date(r.start_at).getTime(), new Date(r.end_at).getTime() - 1)));
      if (end < from || start > to) continue;
      out.push({
        id: `x${r.id}`, type: 'external', start, end, title: r.title, clientName: r.feed_name, batchId: null, shootId: null,
        overdue: false, complete: end < today,
        external: {
          feedId: Number(r.feed_id), feedName: r.feed_name, color: r.color, allDay: r.all_day,
          startAt: new Date(r.start_at).toISOString(), endAt: new Date(r.end_at).toISOString(), location: r.location, description: r.description,
          uid: r.uid, linkedShootId: linked.get(r.uid)?.shoot ?? null, linkedBatchId: linked.get(r.uid)?.batch ?? null,
        },
      });
    }
    return out;
  };

  app.get('/api/calendar', async (req) => {
    const me = requireUser(req);
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
    events.push(...(await syncedEvents(me, q.from, q.to, clock.today)));
    // editors plan around shoots and when scripts are final, not the writing in between
    if (me.role === 'editor') return { events: events.filter((e) => e.type === 'shoot' || e.type === 'final' || e.type === 'external'), clock };
    return { events, clock };
  });

  app.get('/api/review', async (req): Promise<ReviewQueue> => {
    requireUser(req);
    return loadReviewQueue(ctx);
  });

  // editors: each upcoming shoot and how many of its scripts are final
  app.get('/api/shoot-readiness', async (req): Promise<{ shoots: ShootReadiness[] }> => {
    requireUser(req);
    const clock = await clockFor(ctx);
    const shoots = (await loadShoots(db, { from: addDays(clock.today, -2), to: addDays(clock.today, 42), activeClientsOnly: true })).filter((s) => !s.cancelledAt);
    const { summaries } = await loadBatches(ctx, {}, clock);
    const out: ShootReadiness[] = shoots.map((s) => {
      const bs = summaries.filter((b) => b.shootId === s.id);
      const total = bs.reduce((n, b) => n + b.progress.total, 0);
      const finished = bs.reduce((n, b) => n + b.progress.approved, 0);
      const finals = bs.map((b) => b.finalDue).filter((d): d is ISODate => !!d).sort();
      const finalDue = finals[0] ?? null;
      const state: ShootReadiness['state'] = !total ? 'no_scripts' : finished >= total ? 'ready'
        : (finalDue && finalDue < clock.today) || s.startDate <= clock.today ? 'late' : 'on_track';
      return { shoot: s, total, finished, finalDue, state };
    }).sort((a, b) => a.shoot.startDate.localeCompare(b.shoot.startDate));
    return { shoots: out };
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
    const seen = await loadSeen(db, uid);
    // the writer's own deadlines: drafts are done when *their* scripts are sent, not the whole batch's
    const rank = (m: Milestone | null) => (m?.overdue ? 0 : m?.dueToday ? 1 : 2);
    const list = mineBatches.map((b, i) => {
      const mine = allScripts.filter((s) => s.batchId === b.id);
      const myProgress = summarize(mine.map((s) => ({ status: s.status, assigneeId: s.assigneeId })));
      const myDraft = milestone('draft', b.draftDue, myProgress, clock);
      const myFinal = milestone('final', b.finalDue, myProgress, clock);
      return {
        batch: b, mine, myProgress, myDraft, myFinal, myNext: nextMilestone(myDraft, myFinal), seenAt: seen.get(b.id) ?? null,
        briefings: briefings[i], resources: resources[i],
      };
    }).sort((a, b) => {
      const doneA = a.myProgress.delivered === a.myProgress.total ? 1 : 0;
      const doneB = b.myProgress.delivered === b.myProgress.total ? 1 : 0;
      const backA = a.myProgress.revisions > 0 ? 0 : 1;
      const backB = b.myProgress.revisions > 0 ? 0 : 1;
      return doneA - doneB || backA - backB || rank(a.myNext) - rank(b.myNext) || (a.myNext?.date ?? '9999').localeCompare(b.myNext?.date ?? '9999');
    });
    const { groups, data } = await buildGroups(db, mineBatches, { assigneeId: uid });
    const withDocs = list.map((e) => {
      const myIds = new Set(e.mine.map((s) => s.id));
      return {
        ...e,
        groups: groups.filter((g) => g.batch.id === e.batch.id),
        submissions: data.submissions.filter((s) => s.batchId === e.batch.id && s.currentIds.some((id) => myIds.has(id))).map(publicSubmission),
      };
    });
    const deliveries = await loadDeliveries(db, { confirmedBy: uid, limit: 5 });
    const byId = new Map(summaries.map((b) => [b.id, b]));
    return {
      batches: withDocs, sentBack: groups.filter((g) => g.kind === 'sent_back'),
      recentDeliveries: deliveries.map((d) => ({ ...d, batchTitle: byId.get(d.batchId)?.title ?? '', clientName: byId.get(d.batchId)?.clientName ?? '' })),
    };
  });
}
