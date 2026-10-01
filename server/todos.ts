// To-dos: a manager can give any team member a to-do (optionally tied to a
// batch, optionally with a date); it shows on that person's My work and
// Overview. Anyone can also add their own. The person it's for ticks it off;
// whoever gave it is told when it's done.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { logActivity, notify, type Ctx } from './core';
import { requireUser } from './auth';
import { forbidden, HttpError, notFound, parse, zs } from './http';
import { isManager } from '../shared/workflow';
import type { Me, Todo } from '../shared/types';
import type { ISODate } from '../shared/dates';

interface Row {
  id: number; user_id: number; user_name: string; text: string; due: ISODate | null; batch_id: number | null; batch_title: string | null;
  client_name: string | null; created_by: number; created_by_name: string; created_at: string; done_at: string | null;
}

const SELECT = `select t.id, t.user_id, u.name as user_name, t.text, t.due::text as due, t.batch_id, b.title as batch_title, c.name as client_name,
    t.created_by, cb.name as created_by_name, t.created_at, t.done_at
  from todos t join users u on u.id = t.user_id join users cb on cb.id = t.created_by
  left join batches b on b.id = t.batch_id left join clients c on c.id = b.client_id`;

const toTodo = (r: Row, me: Me): Todo => ({
  id: r.id, userId: r.user_id, userName: r.user_name, text: r.text, due: r.due, batchId: r.batch_id, batchTitle: r.batch_title, clientName: r.client_name,
  createdById: r.created_by, createdByName: r.created_by_name, createdAt: r.created_at, doneAt: r.done_at,
  canEdit: isManager(me.role) || r.created_by === me.id,
});

export function registerTodoRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;
  const one = async (id: number) => (await db.query<Row>(`${SELECT} where t.id = $1 and t.removed_at is null`, [id]))[0];

  /** ?userId= one person's (managers can look at anyone; others only themselves); ?all=1 everyone's (managers) */
  app.get('/api/todos', async (req) => {
    const me = requireUser(req);
    const q = parse(z.object({ userId: zs.id.optional(), all: z.enum(['0', '1']).optional(), batchId: zs.id.optional() }), req.query);
    const everyone = isManager(me.role) && q.all === '1';
    const uid = isManager(me.role) ? q.userId ?? (everyone || q.batchId ? null : me.id) : me.id;
    const where = ['t.removed_at is null', 'u.active', `(t.done_at is null or t.done_at > now() - interval '7 days')`];
    const p: unknown[] = [];
    if (uid) { p.push(uid); where.push(`t.user_id = $${p.length}`); }
    if (q.batchId) { p.push(q.batchId); where.push(`t.batch_id = $${p.length}`); }
    const rows = await db.query<Row>(`${SELECT} where ${where.join(' and ')} order by t.done_at is not null, t.done_at desc, t.due nulls last, t.created_at desc limit 300`, p);
    return { todos: rows.map((r) => toTodo(r, me)) };
  });

  app.post('/api/todos', async (req) => {
    const me = requireUser(req);
    const input = parse(z.object({
      userId: zs.id.optional(),
      text: zs.name('To-do', 500),
      due: zs.date.nullable().optional(),
      batchId: zs.id.nullable().optional(),
    }), req.body);
    const uid = input.userId ?? me.id;
    if (uid !== me.id && !isManager(me.role)) throw forbidden('Only managers can give someone else a to-do');
    const u = await db.one<{ name: string }>(`select name from users where id = $1 and active`, [uid]);
    if (!u) throw new HttpError(400, 'Choose an active team member', { userId: 'Choose an active team member' });
    if (input.batchId && !(await db.one(`select 1 from batches where id = $1`, [input.batchId]))) throw new HttpError(400, 'That batch no longer exists', { batchId: 'Choose a batch' });
    const id = await db.tx(async (t) => {
      const r = await t.one<{ id: number }>(`insert into todos (user_id, batch_id, text, due, created_by) values ($1, $2, $3, $4, $5) returning id`,
        [uid, input.batchId ?? null, input.text, input.due ?? null, me.id]);
      if (uid !== me.id) {
        await notify(t, [uid], { type: 'todo', title: `New to-do from ${me.name}`, body: input.text, link: '/my-work' }, me.id);
        await logActivity(t, { actor: me, action: 'todo.added', entityType: 'todo', entityId: r!.id, batchId: input.batchId ?? null, summary: `Gave ${u.name} a to-do: “${input.text}”` });
      }
      return r!.id;
    });
    return { todo: toTodo((await one(id))!, me) };
  });

  app.patch('/api/todos/:id', async (req) => {
    const me = requireUser(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const input = parse(z.object({ done: z.boolean().optional(), text: zs.name('To-do', 500).optional(), due: zs.date.nullable().optional() }), req.body);
    const r = await one(id);
    if (!r) throw notFound('To-do');
    const mine = r.user_id === me.id;
    const editor = isManager(me.role) || r.created_by === me.id;
    if (input.done !== undefined && !mine && !isManager(me.role)) throw forbidden('Only the person it’s for can tick it off');
    if ((input.text !== undefined || input.due !== undefined) && !editor) throw forbidden('Only whoever added it, or a manager, can change it');
    await db.tx(async (t) => {
      if (input.text !== undefined) await t.query(`update todos set text = $2 where id = $1`, [id, input.text]);
      if (input.due !== undefined) await t.query(`update todos set due = $2 where id = $1`, [id, input.due]);
      if (input.done !== undefined && input.done !== !!r.done_at) {
        await t.query(`update todos set done_at = ${input.done ? 'now()' : 'null'}, done_by = $2 where id = $1`, [id, input.done ? me.id : null]);
        if (input.done && r.created_by !== me.id) {
          await notify(t, [r.created_by], { type: 'todo_done', title: `To-do done · ${r.user_name}`, body: r.text, link: r.batch_id ? `/batches/${r.batch_id}` : '/overview' }, me.id);
        }
      }
    });
    return { todo: toTodo((await one(id))!, me) };
  });

  app.delete('/api/todos/:id', async (req) => {
    const me = requireUser(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const r = await one(id);
    if (!r) throw notFound('To-do');
    if (!isManager(me.role) && r.created_by !== me.id) throw forbidden('Only whoever added it, or a manager, can remove it');
    await db.query(`update todos set removed_at = now() where id = $1`, [id]);
    return { ok: true };
  });
}
