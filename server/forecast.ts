// The next shoot, estimated (admins and managers): for each active client whose last shoot is over with nothing
// booked after it, when the next shoot will probably be, when its scripts are due, and who wrote them last time.
//
// A client's past shoots are the site's shoots and the shoots on every synced calendar (the owner's included),
// merged when they're the same days. A shoot's scripts are what its document holds when Claude has counted them
// (server/doc-counts.ts), else its scripts on the site; a shoot only on a calendar has none known.
//
// Claude makes the estimate from all of that (server/shoot-estimator.ts), with the site's own rule
// (`estimateNextShoot` in shared/dates.ts) as its starting point and as the estimate until Claude has answered (or
// when there's no AI key). Answers are kept in `shoot_estimates` and asked for again only when the history changes.
// A manager can change an estimate (date, scripts) or deny it; either holds until the client's next shoot is over.
// Confirm is booking it: the New shoot form, filled in. Clients filmed without scripts get a date and no scripts.
// Only the next shoot is estimated, never a run of them, and nothing is assigned.

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clockFor, loadBatches, loadSettings, loadUsers, logActivity, rulesOf, type Ctx } from './core';
import { requireManager } from './auth';
import { HttpError, notFound, parse, zs } from './http';
import { matchClients, SHOOT_WORDS } from './calendar-shoots';
import { batchDocuments, readDocuments, type DocRef } from './doc-counts';
import { loadShoots } from './records';
import { addDays, computeDeadlines, diffDays, dueState, estimateNextShoot, nowInZone, PACE_GAPS, SAME_SHOOT_DAYS, shootPaces, suggestStart, type ISODate, type ShootEstimate } from '../shared/dates';
import { canWrite, scaleSplit } from '../shared/workflow';
import { fmtDate, plural } from '../shared/format';
import type { ShootForecast, ShootForecasts } from '../shared/types';

/** Clients estimated in one request to Claude. */
const ESTIMATES_PER_RUN = 12;

/** One past shoot of a client: on the site, on a calendar, or both. */
interface PastShootInfo {
  start: ISODate;
  end: ISODate | null;
  /** the site's shoot, when it's on the site */
  shootId: number | null;
  title: string | null;
  calendarTitle: string | null;
  scripts: number;
  siteScripts: number;
  fromDocument: boolean;
  unread: DocRef[];
  sent: { first: string; last: string; n: number } | null;
  pdfAt: string | null;
}

interface Candidate {
  clientId: number;
  clientName: string;
  scriptsRequired: boolean;
  past: PastShootInfo[];
  rule: ShootEstimate | null;
  /** what Claude is given about this client */
  history: string;
  /** a fingerprint of the history (without Timeliner's video counts, which change all day): a new one asks Claude again */
  basis: string;
}

const day = (x: string | Date | null) => (x ? new Date(x).toISOString().slice(0, 10) : null);

async function gather(ctx: Ctx) {
  const { db } = ctx;
  const settings = await loadSettings(db);
  const clock = await clockFor(ctx, settings);
  const rules = rulesOf(settings);
  const today = clock.today;
  const clients = await db.query<{ id: number; name: string; scripts_required: boolean; description: string | null; guidance: string | null }>(
    `select id, name, scripts_required, description, guidance from clients where status = 'active' order by lower(name)`);
  const shoots = (await loadShoots(db, { activeClientsOnly: true })).filter((s) => !s.cancelledAt);
  // archived batches still say how many scripts a past shoot had
  const { summaries } = await loadBatches(ctx, { includeArchived: true }, clock);
  const users = new Map((await loadUsers(db)).map((u) => [u.id, u]));

  // every synced calendar's events that name a client, a year back and ahead ("Not ours" events left out)
  const events = await db.query<{ uid: string; feed_name: string; title: string; location: string | null; all_day: boolean; start_at: string; start_date: string | null; end_at: string; end_date: string | null }>(
    `select e.uid, f.name as feed_name, e.title, e.location, e.all_day, e.start_at, e.start_date::text as start_date, e.end_at, e.end_date::text as end_date
       from calendar_events e join calendar_feeds f on f.id = e.feed_id
      where e.start_at >= ($1::date - 400)::timestamptz
        and not exists (select 1 from calendar_shoot_marks m where m.uid = e.uid and m.dismissed_at is not null)
      order by e.start_at`, [today]);
  const calendar = new Map<number, { uid: string; start: ISODate; end: ISODate; title: string; shoot: boolean }[]>();
  for (const e of events) {
    const c = matchClients(`${e.title} ${e.location ?? ''}`, clients, e.feed_name)[0];
    if (!c) continue;
    const start = (e.all_day ? e.start_date : nowInZone(clock.timezone, new Date(e.start_at)).date) as ISODate;
    const end = (e.all_day ? e.end_date : nowInZone(clock.timezone, new Date(new Date(e.end_at).getTime() - 1)).date) as ISODate;
    calendar.set(c.id, [...(calendar.get(c.id) ?? []), { uid: e.uid, start, end: end < start ? start : end, title: e.title, shoot: SHOOT_WORDS.test(e.title) }]);
  }

  // what's booked already: a shoot on the site or a calendar that isn't over, or scripts planned without a shoot
  const booked = new Set(shoots.filter((s) => (s.endDate ?? s.startDate) >= today).map((s) => s.clientId));
  for (const [clientId, list] of calendar) if (list.some((e) => e.shoot && e.end >= today)) booked.add(clientId);
  for (const b of summaries) {
    if (!b.shootId && !b.archivedAt && b.stage !== 'delivered' && b.progress.total > 0 && (b.finalDue ?? b.draftDue ?? '') >= today) booked.add(b.clientId);
  }

  // the site's past shoots: their scripts (documents first), documents sent and scripts PDFs
  const over = shoots.filter((s) => (s.endDate ?? s.startDate) < today);
  const overIds = [...new Set(over.map((s) => s.id))];
  const docs = await batchDocuments(db, summaries.filter((b) => b.shootId != null && overIds.includes(b.shootId)).map((b) => b.id));
  const sentRows = overIds.length ? await db.query<{ shoot_id: number; first: string; last: string; n: number }>(
    `select b.shoot_id, min(s.created_at) as first, max(s.created_at) as last, count(*)::int as n from submissions s join batches b on b.id = s.batch_id
      where b.shoot_id = any($1::bigint[]) group by b.shoot_id`, [overIds]) : [];
  const pdfRows = overIds.length ? await db.query<{ shoot_id: number; at: string }>(
    `select b.shoot_id, min(p.first_at) as at from timeliner_pdfs p join batches b on b.id = p.batch_id where b.shoot_id = any($1::bigint[]) group by b.shoot_id`, [overIds]) : [];
  // the videos made for each client in Timeliner, month by month, and how many aren't finished: context, not history
  const videoRows = await db.query<{ client_id: number; month: string; n: number; open: number }>(
    `select client_id, to_char(date_trunc('month', created_at), 'YYYY-MM') as month, count(*)::int as n,
            count(*) filter (where status_group not in ('approved', 'posted', 'endClientApproval'))::int as open
       from timeliner_tasks where client_id is not null and created_at >= now() - interval '200 days' group by 1, 2 order by 2`);

  const past = new Map<number, PastShootInfo[]>();
  for (const s of over) {
    const bs = summaries.filter((b) => b.shootId === s.id);
    const sent = sentRows.find((r) => Number(r.shoot_id) === s.id);
    const pdf = pdfRows.find((r) => Number(r.shoot_id) === s.id);
    past.set(s.clientId, [...(past.get(s.clientId) ?? []), {
      start: s.startDate, end: s.endDate, shootId: s.id, title: s.title, calendarTitle: null,
      scripts: bs.reduce((n, b) => n + (docs.get(b.id)?.scripts ?? b.progress.total), 0),
      siteScripts: bs.reduce((n, b) => n + b.progress.total, 0),
      fromDocument: bs.some((b) => docs.get(b.id)?.scripts != null),
      unread: bs.flatMap((b) => docs.get(b.id)?.unread ?? []),
      sent: sent ? { first: day(sent.first)!, last: day(sent.last)!, n: sent.n } : null,
      pdfAt: pdf ? day(pdf.at) : null,
    }]);
  }
  // past shoots on a calendar: the site's shoot when it's the same days (or was planned from that event), else one of their own
  for (const [clientId, list] of calendar) {
    for (const e of list.filter((x) => x.shoot && x.end < today)) {
      const mine = past.get(clientId) ?? [];
      const same = mine.find((p) => (p.shootId != null && shoots.find((s) => s.id === p.shootId)?.calendarUid === e.uid)
        || (p.start <= addDays(e.end, 1) && (p.end ?? p.start) >= addDays(e.start, -1)));
      if (same) { same.calendarTitle ??= e.title; continue; }
      past.set(clientId, [...mine, { start: e.start, end: e.end !== e.start ? e.end : null, shootId: null, title: null, calendarTitle: e.title, scripts: 0, siteScripts: 0, fromDocument: false, unread: [], sent: null, pdfAt: null }]);
    }
  }
  for (const list of past.values()) list.sort((a, b) => a.start.localeCompare(b.start));
  // every client's gaps, for a client with only one shoot so far
  const teamPaces = [...past.values()].flatMap((list) => shootPaces(list.map((p) => ({ start: p.start, scripts: p.scripts }))));
  const deadlineRule = `${rules.finalOffsetDays} ${rules.dayMode === 'business' ? 'working' : 'calendar'} days before the shoot (drafts ${rules.draftOffsetDays})`;

  const candidates: Candidate[] = [];
  const unread: DocRef[] = [];
  for (const c of clients) {
    const list = past.get(c.id);
    if (!list?.length || booked.has(c.id)) continue;
    // the documents that pace this client: its latest shoots, newest first
    unread.push(...list.slice(-(PACE_GAPS + 1)).reverse().flatMap((p) => p.unread));
    const rule = estimateNextShoot(list.map((p) => ({ start: p.start, scripts: p.scripts })), teamPaces, rules);
    const others = (calendar.get(c.id) ?? []).filter((e) => !e.shoot);
    const lines = [
      `Needs scripts: ${c.scripts_required ? 'yes' : 'no (the team films this client without scripts)'}`,
      ...(c.guidance || c.description ? [`Client notes: ${[c.description, c.guidance].filter(Boolean).join(' · ').replace(/\s+/g, ' ').slice(0, 900)}`] : []),
      'Past shoots, oldest first:',
      ...list.map((p) => `- ${p.start}${p.end ? ` to ${p.end}` : ''} (${p.shootId != null ? (p.calendarTitle ? `on the site and the calendar: "${p.calendarTitle}"` : 'on the site') : `only on the calendar: "${p.calendarTitle}"`}): `
        + (p.shootId == null ? 'scripts not known' : `${p.scripts} scripts${p.fromDocument ? ` (counted in its document; ${p.siteScripts} on the site)` : ''}`)
        + (p.sent ? `; ${plural(p.sent.n, 'document')} sent ${p.sent.first}${p.sent.last !== p.sent.first ? ` to ${p.sent.last}` : ''}` : '')
        + (p.pdfAt ? `; scripts PDF in Timeliner ${p.pdfAt}` : '')),
      ...(others.length ? [`Other calendar events: ${others.slice(-15).map((e) => `${e.start} "${e.title}"`).join('; ')}`] : []),
      rule ? `The site's own estimate: ${rule.shootDate} (${ruleWords(rule)})` : 'The site has too little history for its own estimate.',
    ];
    const basis = createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 32);
    const videos = videoRows.filter((v) => Number(v.client_id) === c.id);
    const history = [...lines, ...(videos.length ? [`Videos made in Timeliner per month: ${videos.map((v) => `${v.month}: ${v.n}`).join(', ')}; ${videos.reduce((n, v) => n + v.open, 0)} not finished yet`] : [])].join('\n');
    candidates.push({ clientId: c.id, clientName: c.name, scriptsRequired: c.scripts_required !== false, past: list, rule, history, basis });
  }
  return { settings, clock, rules, summaries, users, candidates, unread, deadlineRule };
}

/** "45 scripts from the Oct 2 shoot, at 1 day a script (this client's last gap between shoots)" */
function ruleWords(e: ShootEstimate): string {
  if (e.kind === 'gap') return `about every ${Math.round(e.pace)} days, like this client’s last ${e.gaps === 1 ? 'gap' : `${e.gaps} gaps`} between shoots`;
  return `${plural(e.from.scripts, 'script')} from the ${fmtDate(e.from.start)} shoot, at ${e.pace} day${e.pace === 1 ? '' : 's'} a script (${e.basis === 'client' ? `this client’s last ${e.gaps === 1 ? 'gap' : `${e.gaps} gaps`} between shoots` : 'other clients’ shoots: this one has had only one'})`;
}

interface EstimateRow {
  client_id: number; after_date: ISODate; basis: string; shoot_date: ISODate | null; scripts: number | null; confidence: 'high' | 'medium' | 'low' | null;
  reasoning: string | null; source: 'ai' | 'manager'; decision: 'changed' | 'denied' | null; decided_by: number | null; decided_at: string | null;
}

/** The last shoot a client's estimate follows: the newest one that's over (shoots a few days apart count as one, from their first day). */
const afterDate = (c: Candidate) => {
  let s = c.past[c.past.length - 1].start;
  for (const p of [...c.past].reverse()) { if (diffDays(s, p.start) < SAME_SHOOT_DAYS) s = p.start; else break; }
  return s;
};

/** The estimates, those denied, and what's left for Claude: unread documents and clients whose history changed. */
export async function loadShootForecasts(ctx: Ctx) {
  const g = await gather(ctx);
  const { clock, rules, summaries, users, settings } = g;
  const rows = new Map((await ctx.db.query<EstimateRow>(
    `select client_id, after_date::text as after_date, basis, shoot_date::text as shoot_date, scripts, confidence, reasoning, source, decision, decided_by, decided_at from shoot_estimates`,
  )).map((r) => [Number(r.client_id), r]));
  const forecasts: ShootForecast[] = [];
  const denied: ShootForecast[] = [];
  const stale: Candidate[] = [];
  for (const c of g.candidates) {
    const after = afterDate(c);
    // a row about an older shoot is over: the client has shot since
    const row = rows.get(c.clientId)?.after_date === after ? rows.get(c.clientId) : undefined;
    const ai = row?.source === 'ai' && row.shoot_date ? row : null;
    // Claude is asked (again) unless a manager changed it or denied it, or its answer is about this very history
    if (ctx.shootEstimator && !row?.decision && (row?.source !== 'ai' || row.basis !== c.basis)) stale.push(c);

    let shootDate: ISODate | null = null;
    let scripts: number | null = null;
    let source: 'ai' | 'manager' | 'rule' = 'rule';
    let confidence: 'high' | 'medium' | 'low' | null = null;
    let why = '';
    if (row?.decision === 'changed' && row.shoot_date) {
      shootDate = row.shoot_date; scripts = row.scripts; source = 'manager';
      why = `Changed by ${users.get(Number(row.decided_by))?.name.split(' ')[0] ?? 'a manager'}${row.decided_at ? ` on ${fmtDate(day(row.decided_at), clock.today)}` : ''}.`;
    } else if (ai) {
      shootDate = ai.shoot_date; scripts = ai.scripts; source = 'ai'; confidence = ai.confidence; why = ai.reasoning ?? '';
    } else if (c.rule) {
      shootDate = c.rule.shootDate; scripts = c.rule.scripts || null;
      const w = ruleWords(c.rule);
      why = `${w.charAt(0).toUpperCase()}${w.slice(1)}.`;
    }
    if (!c.scriptsRequired) scripts = null;

    // last time's writers, from the latest shoot on the site with scripts (and any shoot a few days around it)
    const withScripts = [...c.past].reverse().find((p) => p.shootId != null && p.siteScripts > 0);
    const fromIds = new Set(c.past.filter((p) => p.shootId != null && withScripts && Math.abs(diffDays(p.start, withScripts.start)) < SAME_SHOOT_DAYS).map((p) => p.shootId!));
    const shares = new Map<number, { name: string; count: number }>();
    let unassigned = 0;
    for (const b of summaries.filter((x) => x.shootId != null && fromIds.has(x.shootId))) {
      // the "Unassigned" share (no writer) counts here too
      for (const w of b.writers) {
        const u = w.userId != null ? users.get(w.userId) : undefined;
        if (!u || !u.active || !canWrite(u.role)) { unassigned += w.count; continue; }
        shares.set(u.id, { name: u.name, count: (shares.get(u.id)?.count ?? 0) + w.count });
      }
    }
    let estimate: ShootForecast['estimate'] = null;
    if (shootDate) {
      const d = c.scriptsRequired ? computeDeadlines(shootDate, rules) : null;
      // each writer keeps their share of however many the next shoot needs; with nobody from last time, all need a writer
      const byWriter = [...shares];
      const scaled = scripts && (byWriter.length || unassigned) ? scaleSplit([...byWriter.map(([, x]) => x.count), unassigned], scripts) : [];
      const writers = scaled.length ? byWriter.map(([writerId, x], i) => {
        const perDay = users.get(writerId)?.capacityPerDay;
        return { writerId, name: x.name, count: scaled[i], startBy: perDay && scaled[i] && d ? suggestStart(d.draftDue, scaled[i], perDay, settings.workingDays) : null };
      }).filter((w) => w.count > 0).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)) : [];
      estimate = {
        shootDate, draftDue: d?.draftDue ?? null, finalDue: d?.finalDue ?? null, scripts, source, confidence, why,
        writers, unassigned: scaled.length ? scaled[scaled.length - 1] : (scripts ?? 0),
        late: d ? dueState(d.finalDue, clock).overdue : shootDate < clock.today,
        updating: stale.includes(c),
      };
    }
    const last = c.past[c.past.length - 1];
    const f: ShootForecast = {
      clientId: c.clientId, clientName: c.clientName, scriptsRequired: c.scriptsRequired, estimate, pastShoots: c.past.length,
      lastShoot: {
        id: last.shootId, title: last.title ?? last.calendarTitle, startDate: last.start, endDate: last.end, onSite: last.shootId != null,
        scripts: last.scripts, siteScripts: last.siteScripts, fromDocument: last.fromDocument,
      },
    };
    (row?.decision === 'denied' ? denied : forecasts).push(f);
  }
  const byDate = (a: ShootForecast, b: ShootForecast) => (a.estimate?.shootDate ?? '9999').localeCompare(b.estimate?.shootDate ?? '9999') || a.clientName.localeCompare(b.clientName);
  forecasts.sort(byDate);
  denied.sort(byDate);
  return { forecasts, denied, unread: g.unread, stale, g };
}

const running = new WeakMap<object, boolean>();

/** Asks Claude for the next shoot of clients whose history changed (`ESTIMATES_PER_RUN` at a time) and keeps the answers. */
async function runEstimates(ctx: Ctx): Promise<{ estimated: number; busy: boolean }> {
  const estimator = ctx.shootEstimator;
  if (!estimator) throw new HttpError(503, 'Estimating with AI needs an AI key on the server (ANTHROPIC_API_KEY).');
  if (running.get(ctx.db)) return { estimated: 0, busy: true };
  running.set(ctx.db, true);
  try {
    const { stale, g } = await loadShootForecasts(ctx);
    const todo = stale.slice(0, ESTIMATES_PER_RUN);
    if (!todo.length) return { estimated: 0, busy: false };
    const asked = new Set(todo.map((c) => c.clientId));
    // every client goes with it, so Claude sees the team's rhythm; it answers for the ones asked about
    const answers = await estimator.estimate({
      today: g.clock.today, deadlineRule: g.deadlineRule,
      clients: g.candidates.map((c) => ({ id: c.clientId, name: c.clientName, estimate: asked.has(c.clientId), history: c.history })),
    });
    let estimated = 0;
    for (const c of todo) {
      const a = answers.find((x) => x.clientId === c.clientId);
      if (!a) continue;
      const after = afterDate(c);
      // a date that isn't after the last shoot is no estimate: kept as asked, so it isn't asked again until the history changes
      const ok = a.shootDate > after;
      await ctx.db.query(
        `insert into shoot_estimates (client_id, after_date, basis, shoot_date, scripts, confidence, reasoning, source, decision, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, 'ai', null, now())
         on conflict (client_id) do update set after_date = excluded.after_date, basis = excluded.basis, shoot_date = excluded.shoot_date,
           scripts = excluded.scripts, confidence = excluded.confidence, reasoning = excluded.reasoning, source = 'ai', decision = null,
           decided_by = null, decided_at = null, updated_at = now()
         where shoot_estimates.decision is null or shoot_estimates.after_date <> excluded.after_date`,
        [c.clientId, after, c.basis, ok ? a.shootDate : null, a.scripts, a.confidence, ok ? a.reasoning : 'The AI gave no usable date.'],
      );
      estimated++;
    }
    return { estimated, busy: false };
  } finally {
    running.delete(ctx.db);
  }
}

export function registerForecastRoutes(app: FastifyInstance, ctx: Ctx) {
  const answer = async (): Promise<ShootForecasts> => {
    const { forecasts, denied, unread, stale } = await loadShootForecasts(ctx);
    return {
      forecasts, denied,
      documents: { unread: unread.length, canRead: !!ctx.scriptCounter },
      estimates: { stale: stale.length, canEstimate: !!ctx.shootEstimator },
    };
  };
  const clientParams = z.object({ clientId: zs.id });
  /** the client's estimate as it stands, for a decision about it */
  const candidateOf = async (clientId: number) => {
    const c = (await gather(ctx)).candidates.find((x) => x.clientId === clientId);
    if (!c) throw notFound('Estimate');
    return c;
  };

  app.get('/api/shoot-forecast', async (req): Promise<ShootForecasts> => {
    requireManager(req);
    return answer();
  });

  // Claude counts the scripts in the documents the estimates count from and haven't been read: a few at a time,
  // each document once (the page asks again while some are left)
  app.post('/api/shoot-forecast/read-documents', async (req): Promise<ShootForecasts & { read: number; busy: boolean }> => {
    requireManager(req);
    const { unread } = await loadShootForecasts(ctx);
    const run = unread.length ? await readDocuments(ctx, unread) : { read: 0, busy: false };
    return { ...(await answer()), ...run };
  });

  // Claude estimates the next shoot of the clients whose history changed (the page asks by itself)
  app.post('/api/shoot-forecast/estimate', async (req): Promise<ShootForecasts & { estimated: number; busy: boolean }> => {
    requireManager(req);
    const run = await runEstimates(ctx);
    return { ...(await answer()), ...run };
  });

  // Change: the manager's own date and script count, kept until this client's next shoot is over
  app.post('/api/shoot-forecast/:clientId/change', async (req): Promise<ShootForecasts> => {
    const me = requireManager(req);
    const { clientId } = parse(clientParams, req.params);
    const input = parse(z.object({
      shootDate: zs.date,
      scripts: z.coerce.number({ message: 'Enter a number' }).int('Use a whole number').min(1, 'At least 1 script').max(500, 'At most 500 scripts').nullable().optional(),
    }), req.body);
    const c = await candidateOf(clientId);
    const after = afterDate(c);
    if (input.shootDate <= after) throw new HttpError(400, `Pick a day after the last shoot (${fmtDate(after)})`, { shootDate: `Pick a day after ${fmtDate(after)}` });
    await ctx.db.query(
      `insert into shoot_estimates (client_id, after_date, basis, shoot_date, scripts, source, decision, decided_by, decided_at, updated_at)
       values ($1, $2, $3, $4, $5, 'manager', 'changed', $6, now(), now())
       on conflict (client_id) do update set after_date = excluded.after_date, basis = excluded.basis, shoot_date = excluded.shoot_date, scripts = excluded.scripts,
         confidence = null, reasoning = null, source = 'manager', decision = 'changed', decided_by = excluded.decided_by, decided_at = now(), updated_at = now()`,
      [clientId, after, c.basis, input.shootDate, input.scripts ?? null, me.id],
    );
    await logActivity(ctx.db, {
      actor: me, action: 'shoot.estimate', entityType: 'client', entityId: clientId, clientId,
      summary: `Next shoot estimate changed to ${fmtDate(input.shootDate)}${input.scripts ? ` · ${plural(input.scripts, 'script')}` : ''}`,
    });
    return answer();
  });

  // Deny: the estimate is wrong, or this client isn't shooting again soon. Hidden until the client shoots again; undo brings it back
  app.post('/api/shoot-forecast/:clientId/deny', async (req): Promise<ShootForecasts> => {
    const me = requireManager(req);
    const { clientId } = parse(clientParams, req.params);
    const { undo } = parse(z.object({ undo: z.boolean().default(false) }), req.body ?? {});
    const c = await candidateOf(clientId);
    if (undo) {
      // undoing goes back to asking afresh: Claude's answer (or the rule) shows again
      await ctx.db.query(`delete from shoot_estimates where client_id = $1 and decision = 'denied'`, [clientId]);
    } else {
      await ctx.db.query(
        `insert into shoot_estimates (client_id, after_date, basis, source, decision, decided_by, decided_at, updated_at)
         values ($1, $2, $3, 'manager', 'denied', $4, now(), now())
         on conflict (client_id) do update set after_date = excluded.after_date, decision = 'denied', decided_by = excluded.decided_by, decided_at = now(), updated_at = now()`,
        [clientId, afterDate(c), c.basis, me.id],
      );
    }
    await logActivity(ctx.db, { actor: me, action: 'shoot.estimate', entityType: 'client', entityId: clientId, clientId, summary: undo ? 'Next shoot estimate brought back' : 'Next shoot estimate denied' });
    return answer();
  });
}
