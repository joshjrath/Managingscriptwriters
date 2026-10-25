// The next shoot, estimated (admins and managers): for each active client whose last shoot is over with nothing
// booked after it, when the next shoot will probably be, when its scripts are due, and who wrote them last time.
// The pace comes from the client's own past shoots and how many scripts each had (`estimateNextShoot` in
// shared/dates.ts). A shoot's scripts are what its document holds when Claude has counted them (server/doc-counts.ts:
// the scripts PDF, or every document the writers sent), else its scripts on the site. Only the next shoot is
// estimated, never a run of them. Nothing here is assigned: booking the shoot (Plan this shoot) is the manager's.

import type { FastifyInstance } from 'fastify';
import { clockFor, loadBatches, loadSettings, loadUsers, rulesOf, type Ctx } from './core';
import { requireManager } from './auth';
import { findCalendarShoots } from './calendar-shoots';
import { batchDocuments, readDocuments, type DocRef } from './doc-counts';
import { loadShoots } from './records';
import { estimateNextShoot, PACE_GAPS, shootPaces, suggestStart, dueState, type PastShoot } from '../shared/dates';
import { canWrite, scaleSplit } from '../shared/workflow';
import type { ShootForecast, ShootForecasts } from '../shared/types';

/** The estimates, and the documents of the shoots they count from that Claude hasn't read yet. */
export async function loadShootForecasts(ctx: Ctx): Promise<{ forecasts: ShootForecast[]; unread: DocRef[] }> {
  const { db } = ctx;
  const settings = await loadSettings(db);
  const clock = await clockFor(ctx, settings);
  const rules = rulesOf(settings);
  const clients = await db.query<{ id: number; name: string }>(`select id, name from clients where status = 'active' order by lower(name)`);
  const shoots = (await loadShoots(db, { activeClientsOnly: true })).filter((s) => !s.cancelledAt);
  // archived batches still say how many scripts a past shoot had
  const { summaries } = await loadBatches(ctx, { includeArchived: true }, clock);
  const users = new Map((await loadUsers(db)).map((u) => [u.id, u]));

  // what's booked already: a shoot on the site that isn't over, one on a synced calendar, or scripts planned without a shoot
  const booked = new Set(shoots.filter((s) => (s.endDate ?? s.startDate) >= clock.today).map((s) => s.clientId));
  for (const s of await findCalendarShoots(ctx)) if (s.client) booked.add(s.client.id);
  for (const b of summaries) {
    if (!b.shootId && !b.archivedAt && b.stage !== 'delivered' && b.progress.total > 0 && (b.finalDue ?? b.draftDue ?? '') >= clock.today) booked.add(b.clientId);
  }

  // each past shoot's scripts: what its batches' documents hold, else their scripts on the site
  const over = shoots.filter((s) => (s.endDate ?? s.startDate) < clock.today);
  const overIds = new Set(over.map((s) => s.id));
  const docs = await batchDocuments(db, summaries.filter((b) => b.shootId != null && overIds.has(b.shootId)).map((b) => b.id));
  const past = new Map<number, (PastShoot & { id: number; site: number; fromDocument: boolean; unread: DocRef[] })[]>();
  for (const s of over) {
    const bs = summaries.filter((b) => b.shootId === s.id);
    const site = bs.reduce((n, b) => n + b.progress.total, 0);
    const scripts = bs.reduce((n, b) => n + (docs.get(b.id)?.scripts ?? b.progress.total), 0);
    const fromDocument = bs.some((b) => docs.get(b.id)?.scripts != null);
    past.set(s.clientId, [...(past.get(s.clientId) ?? []), { id: s.id, start: s.startDate, scripts, site, fromDocument, unread: bs.flatMap((b) => docs.get(b.id)?.unread ?? []) }]);
  }
  // every client's gaps, for a client with only one shoot so far
  const teamPaces = [...past.values()].flatMap((list) => shootPaces(list));

  const out: ShootForecast[] = [];
  const unread: DocRef[] = [];
  for (const c of clients) {
    const list = past.get(c.id);
    if (!list?.length || booked.has(c.id)) continue;
    // the documents that pace this client: its latest shoots, newest first
    unread.push(...list.slice(-(PACE_GAPS + 1)).reverse().flatMap((s) => s.unread));
    const lastPast = list[list.length - 1];
    const last = shoots.find((s) => s.id === lastPast.id)!;
    const est = estimateNextShoot(list, teamPaces, rules);
    let estimate: ShootForecast['estimate'] = null;
    if (est) {
      // the writers of the shoot it counts from (and any shoot merged into it), by their share last time
      const fromIds = new Set(list.filter((s) => s.start >= est.from.start && s.scripts > 0).map((s) => s.id));
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
      // when the document held more (or fewer) scripts than the site had, each writer keeps their share of it
      const byWriter = [...shares];
      const scaled = scaleSplit([...byWriter.map(([, x]) => x.count), unassigned], est.scripts);
      const writers = byWriter.map(([writerId, x], i) => {
        const perDay = users.get(writerId)?.capacityPerDay;
        return { writerId, name: x.name, count: scaled[i], startBy: perDay && scaled[i] ? suggestStart(est.draftDue, scaled[i], perDay, settings.workingDays) : null };
      }).filter((w) => w.count > 0).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
      estimate = { ...est, writers, unassigned: scaled[scaled.length - 1], late: dueState(est.finalDue, clock).overdue };
    }
    out.push({
      clientId: c.id, clientName: c.name, estimate,
      lastShoot: {
        id: last.id, title: last.title, startDate: last.startDate, endDate: last.endDate,
        scripts: lastPast.scripts, siteScripts: lastPast.site, fromDocument: lastPast.fromDocument,
      },
    });
  }
  out.sort((a, b) => (a.estimate?.shootDate ?? '9999').localeCompare(b.estimate?.shootDate ?? '9999') || a.clientName.localeCompare(b.clientName));
  return { forecasts: out, unread };
}

export function registerForecastRoutes(app: FastifyInstance, ctx: Ctx) {
  const answer = async (): Promise<ShootForecasts> => {
    const { forecasts, unread } = await loadShootForecasts(ctx);
    return { forecasts, documents: { unread: unread.length, canRead: !!ctx.scriptCounter } };
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
}
