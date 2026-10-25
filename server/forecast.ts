// The next shoot, estimated (admins and managers): for each active client whose last shoot is over with nothing
// booked after it, when the next shoot will probably be, when its scripts are due, and who wrote them last time.
// The pace comes from the client's own past shoots and how many scripts each had (`estimateNextShoot` in
// shared/dates.ts). Only the next shoot is estimated, never a run of them. Nothing here is stored or assigned:
// booking the shoot (Plan this shoot) is the manager's.

import type { FastifyInstance } from 'fastify';
import { clockFor, loadBatches, loadSettings, loadUsers, rulesOf, type Ctx } from './core';
import { requireManager } from './auth';
import { findCalendarShoots } from './calendar-shoots';
import { loadShoots } from './records';
import { estimateNextShoot, shootPaces, suggestStart, dueState, type PastShoot } from '../shared/dates';
import { canWrite } from '../shared/workflow';
import type { ShootForecast } from '../shared/types';

export async function loadShootForecasts(ctx: Ctx): Promise<ShootForecast[]> {
  const { db } = ctx;
  const settings = await loadSettings(db);
  const clock = await clockFor(ctx, settings);
  const rules = rulesOf(settings);
  const clients = await db.query<{ id: number; name: string }>(`select id, name from clients where status = 'active' order by lower(name)`);
  const shoots = (await loadShoots(db, { activeClientsOnly: true })).filter((s) => !s.cancelledAt);
  // archived batches still say how many scripts a past shoot had
  const { summaries } = await loadBatches(ctx, { includeArchived: true }, clock);
  const users = new Map((await loadUsers(db)).map((u) => [u.id, u]));
  const scriptsOf = (shootId: number) => summaries.filter((b) => b.shootId === shootId).reduce((n, b) => n + b.progress.total, 0);

  // what's booked already: a shoot on the site that isn't over, one on a synced calendar, or scripts planned without a shoot
  const booked = new Set(shoots.filter((s) => (s.endDate ?? s.startDate) >= clock.today).map((s) => s.clientId));
  for (const s of await findCalendarShoots(ctx)) if (s.client) booked.add(s.client.id);
  for (const b of summaries) {
    if (!b.shootId && !b.archivedAt && b.stage !== 'delivered' && b.progress.total > 0 && (b.finalDue ?? b.draftDue ?? '') >= clock.today) booked.add(b.clientId);
  }

  const past = new Map<number, (PastShoot & { id: number })[]>();
  for (const s of shoots) {
    if ((s.endDate ?? s.startDate) >= clock.today) continue;
    past.set(s.clientId, [...(past.get(s.clientId) ?? []), { id: s.id, start: s.startDate, scripts: scriptsOf(s.id) }]);
  }
  // every client's gaps, for a client with only one shoot so far
  const teamPaces = [...past.values()].flatMap((list) => shootPaces(list));

  const out: ShootForecast[] = [];
  for (const c of clients) {
    const list = past.get(c.id);
    if (!list?.length || booked.has(c.id)) continue;
    const last = shoots.find((s) => s.id === list[list.length - 1].id)!;
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
      const writers = [...shares].map(([writerId, x]) => {
        const perDay = users.get(writerId)?.capacityPerDay;
        return { writerId, name: x.name, count: x.count, startBy: perDay ? suggestStart(est.draftDue, x.count, perDay, settings.workingDays) : null };
      }).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
      estimate = { ...est, writers, unassigned, late: dueState(est.finalDue, clock).overdue };
    }
    out.push({
      clientId: c.id, clientName: c.name, estimate,
      lastShoot: { id: last.id, title: last.title, startDate: last.startDate, endDate: last.endDate, scripts: list[list.length - 1].scripts },
    });
  }
  return out.sort((a, b) => (a.estimate?.shootDate ?? '9999').localeCompare(b.estimate?.shootDate ?? '9999') || a.clientName.localeCompare(b.clientName));
}

export function registerForecastRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/api/shoot-forecast', async (req): Promise<{ forecasts: ShootForecast[] }> => {
    requireManager(req);
    return { forecasts: await loadShootForecasts(ctx) };
  });
}
