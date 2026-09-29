// Today's tasks: what's due today, and anything overdue that's still open (or
// was finished today). Drafts count as done once they're sent for review;
// final delivery once delivered. A writer sees their own scripts; admins and
// managers see the whole team, or one person with ?userId=.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clockFor, type Ctx } from './core';
import { requireUser } from './auth';
import { parse, zs } from './http';
import { isDraftReady, isManager, type ScriptStatus } from '../shared/workflow';
import { nowInZone, type ISODate } from '../shared/dates';
import type { TodayTasks } from '../shared/types';

interface Row {
  batch_id: number; title: string; client_name: string; draft_due: ISODate | null; final_due: ISODate | null;
  status: ScriptStatus; submitted_at: string | null; delivered_at: string | null;
}

export function registerTodayRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/api/today', async (req): Promise<TodayTasks> => {
    const me = requireUser(req);
    const q = parse(z.object({ userId: zs.id.optional() }), req.query);
    const uid = !isManager(me.role) ? me.id : q.userId ?? null;
    const clock = await clockFor(ctx);
    const today = clock.today;
    const p: unknown[] = [today];
    if (uid) p.push(uid);
    const rows = await ctx.db.query<Row>(
      `select b.id as batch_id, b.title, c.name as client_name, b.draft_due, b.final_due, s.status, s.submitted_at, s.delivered_at
         from scripts s join batches b on b.id = s.batch_id join clients c on c.id = b.client_id
        where s.removed_at is null and b.archived_at is null and c.status <> 'archived'
          and (b.draft_due <= $1 or b.final_due <= $1) ${uid ? 'and s.assignee_id = $2' : ''}
        order by b.id`, p,
    );
    const on = (at: string | null) => !!at && nowInZone(clock.timezone, new Date(at)).date === today;
    const items = new Map<string, TodayTasks['items'][number]>();
    const add = (r: Row, kind: 'draft' | 'final', done: boolean, overdue: boolean) => {
      const key = `${r.batch_id}:${kind}`;
      const it = items.get(key) ?? { batchId: r.batch_id, batchTitle: r.title, clientName: r.client_name, kind, total: 0, done: 0, overdue };
      it.total++;
      if (done) it.done++;
      items.set(key, it);
    };
    for (const r of rows) {
      const ready = isDraftReady(r.status);
      if (r.draft_due && (r.draft_due === today || (r.draft_due < today && (!ready || on(r.submitted_at))))) add(r, 'draft', ready, r.draft_due < today);
      const delivered = r.status === 'delivered';
      if (r.final_due && (r.final_due === today || (r.final_due < today && (!delivered || on(r.delivered_at))))) add(r, 'final', delivered, r.final_due < today);
    }
    const list = [...items.values()].sort((a, b) => Number(a.done === a.total) - Number(b.done === b.total) || Number(b.overdue) - Number(a.overdue));
    return {
      date: today,
      scope: uid ? (uid === me.id ? 'me' : 'person') : 'team',
      total: list.reduce((n, i) => n + i.total, 0),
      done: list.reduce((n, i) => n + i.done, 0),
      items: list,
    };
  });
}
