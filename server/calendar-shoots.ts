// Shoots on a synced calendar (e.g. Joshua's Google Calendar) that aren't
// planned on the site yet: no shoot here, a shoot with no scripts, or scripts
// nobody is writing. Admins and managers see them on the Overview with a
// one-click "Plan scripts", and get a notification when new ones appear.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clockFor, loadBatches, managerIds, notify, type Ctx } from './core';
import { requireManager } from './auth';
import { parse } from './http';
import { loadShoots } from './records';
import { addDays, nowInZone, type ISODate } from '../shared/dates';
import { fmtRange, plural } from '../shared/format';
import type { CalendarShoot } from '../shared/types';

/** What counts as a shoot in a calendar title. */
export const SHOOT_WORDS = /\b(shoots?|shooting|filming|film day|photo ?shoot|video ?shoot|content day|production day)\b/i;

const STOP = new Set(['the', 'and', 'of', 'co', 'inc', 'llc', 'ltd', 'group', 'company', 'studio', 'studios', 'shoot', 'shoots', 'shooting', 'film', 'filming', 'day', 'with', 'for']);
const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** The client a calendar title is about: the full name if it's there, else a distinctive word of it ("Shimonov"). */
export function matchClient(text: string, clients: { id: number; name: string }[]): { id: number; name: string } | null {
  const t = ` ${norm(text)} `;
  let best: { c: { id: number; name: string }; score: number } | null = null;
  for (const c of clients) {
    const n = norm(c.name);
    if (!n) continue;
    let score = 0;
    if (t.includes(` ${n} `)) score = 100 + n.length;
    else {
      const words = n.split(' ').filter((w) => w.length >= 4 && !STOP.has(w));
      const hits = words.filter((w) => t.includes(` ${w} `));
      if (hits.length && (hits.length === words.length || hits.some((w) => w.length >= 5))) score = 10 * hits.length + hits.join('').length;
    }
    if (score && (!best || score > best.score)) best = { c, score };
  }
  return best?.c ?? null;
}

export async function findCalendarShoots(ctx: Ctx, opts: { includeDismissed?: boolean } = {}): Promise<CalendarShoot[]> {
  const { db } = ctx;
  const clock = await clockFor(ctx);
  const today = clock.today;
  const until = addDays(today, 180);
  const events = await db.query<{ uid: string; feed_name: string; color: string; title: string; location: string | null; description: string | null; all_day: boolean; start_at: string; end_at: string; start_date: string | null; end_date: string | null }>(
    `select e.uid, f.name as feed_name, f.color, e.title, e.location, e.description, e.all_day, e.start_at, e.end_at, e.start_date::text as start_date, e.end_date::text as end_date
       from calendar_events e join calendar_feeds f on f.id = e.feed_id
      where e.end_at >= ($2::date - 1)::timestamptz and e.start_at < ($1::date + 1)::timestamptz
      order by e.start_at`, [until, today],
  );
  const shootsOnCal = events.filter((e) => SHOOT_WORDS.test(e.title));
  if (!shootsOnCal.length) return [];
  const marks = new Map((await db.query<{ uid: string; dismissed_at: string | null }>(`select uid, dismissed_at from calendar_shoot_marks`)).map((m) => [m.uid, m]));
  const clients = await db.query<{ id: number; name: string }>(`select id, name from clients where status <> 'archived'`);
  const siteShoots = (await loadShoots(db, { from: addDays(today, -2), activeClientsOnly: true })).filter((s) => !s.cancelledAt);
  const { summaries } = await loadBatches(ctx, {}, clock);
  const day = (at: string) => nowInZone(clock.timezone, new Date(at)).date;
  const out: CalendarShoot[] = [];
  for (const e of shootsOnCal) {
    if (!opts.includeDismissed && marks.get(e.uid)?.dismissed_at) continue;
    const start = (e.all_day ? e.start_date : day(e.start_at)) as ISODate;
    const end = (e.all_day ? e.end_date : day(new Date(new Date(e.end_at).getTime() - 1).toISOString())) as ISODate;
    if (end < today) continue;
    const client = matchClient(`${e.title} ${e.location ?? ''}`, clients);
    // the site's shoot for that client on the same days (a day either side); without a client we don't guess
    const shoot = client ? siteShoots.find((s) => s.clientId === client.id && s.startDate <= addDays(end, 1) && (s.endDate ?? s.startDate) >= addDays(start, -1)) : undefined;
    const batches = shoot ? summaries.filter((b) => b.shootId === shoot.id) : [];
    const unassigned = batches.reduce((n, b) => n + b.progress.unassigned, 0);
    const total = batches.reduce((n, b) => n + b.progress.total, 0);
    const status: CalendarShoot['status'] | null = !shoot ? 'no_shoot' : !batches.length || !total ? 'no_scripts' : unassigned ? 'unassigned' : null;
    if (!status) continue;
    // start from what this client had last time
    const last = client ? summaries.filter((b) => b.clientId === client!.id && b.progress.total > 0).sort((a, b) => b.id - a.id)[0] : undefined;
    const suggested = last ? {
      count: last.progress.total,
      split: last.writers.filter((w) => w.userId != null).map((w) => ({ writerId: w.userId!, name: w.name, count: w.count })),
    } : null;
    out.push({
      uid: e.uid, feedName: e.feed_name, color: e.color, title: e.title, start, end, location: e.location, client,
      status, shootId: shoot?.id ?? null, batchId: batches.find((b) => b.progress.unassigned)?.id ?? batches[0]?.id ?? null,
      unassigned, total, suggested,
    });
  }
  return out;
}

/** After a sync: tell admins and managers once about shoots they haven't been told about yet. */
export async function notifyNewCalendarShoots(ctx: Ctx): Promise<number> {
  const list = await findCalendarShoots(ctx);
  if (!list.length) return 0;
  const told = new Set((await ctx.db.query<{ uid: string }>(`select uid from calendar_shoot_marks where notified_at is not null`)).map((r) => r.uid));
  const fresh = list.filter((s) => !told.has(s.uid));
  if (!fresh.length) return 0;
  for (const s of fresh) {
    await ctx.db.query(`insert into calendar_shoot_marks (uid, notified_at) values ($1, now()) on conflict (uid) do update set notified_at = now()`, [s.uid]);
  }
  const first = fresh[0];
  const what = (s: CalendarShoot) => `${s.client?.name ?? s.title} · ${fmtRange(s.start, s.end !== s.start ? s.end : null)}`;
  await notify(ctx.db, await managerIds(ctx.db), {
    type: 'planning',
    title: fresh.length === 1 ? `Shoot needs writers · ${first.client?.name ?? first.title}` : `${plural(fresh.length, 'shoot')} on ${first.feedName} need writers`,
    body: fresh.length === 1 ? `${what(first)} is on ${first.feedName} but ${first.status === 'unassigned' ? `${plural(first.unassigned, 'script')} aren’t assigned` : 'no scripts are planned'}.` : fresh.slice(0, 5).map(what).join(', ') + (fresh.length > 5 ? ` and ${fresh.length - 5} more` : ''),
    link: '/overview',
  });
  return fresh.length;
}

export function registerCalendarShootRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/api/calendar-shoots', async (req) => {
    requireManager(req);
    return { shoots: await findCalendarShoots(ctx) };
  });
  app.post('/api/calendar-shoots/dismiss', async (req) => {
    const me = requireManager(req);
    const { uid, undo } = parse(z.object({ uid: z.string().min(1).max(600), undo: z.boolean().default(false) }), req.body);
    await ctx.db.query(
      `insert into calendar_shoot_marks (uid, dismissed_at, dismissed_by) values ($1, ${undo ? 'null' : 'now()'}, $2)
       on conflict (uid) do update set dismissed_at = excluded.dismissed_at, dismissed_by = excluded.dismissed_by`, [uid, undo ? null : me.id],
    );
    return { ok: true };
  });
}
