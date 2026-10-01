// Direct messages between team members: the chat windows that pop up in the
// bottom-right corner. Anyone active can message anyone else on the team.
// The client polls (cheaply: an inbox summary, and a thread only while its
// window is open, asking just for what's newer than what it has).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from './core';
import { requireUser } from './auth';
import { HttpError, parse, zs } from './http';
import type { ChatInbox, ChatMessage, Me } from '../shared/types';
import type { Role } from '../shared/workflow';

interface Row { id: number; sender_id: number; recipient_id: number; body: string; created_at: string; read_at: string | null }
const toMsg = (r: Row): ChatMessage => ({ id: Number(r.id), fromId: Number(r.sender_id), toId: Number(r.recipient_id), body: r.body, createdAt: r.created_at, readAt: r.read_at });
const COLS = 'm.id, m.sender_id, m.recipient_id, m.body, m.created_at, m.read_at';

export function registerMessageRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  const other = async (me: Me, id: number) => {
    if (id === me.id) throw new HttpError(400, 'You can’t message yourself');
    const u = await db.one<{ id: number; name: string }>(`select id, name from users where id = $1 and active and removed_at is null`, [id]);
    if (!u) throw new HttpError(404, 'That person isn’t on the team any more');
    return u;
  };

  /** Your conversations, newest first, with unread counts. */
  app.get('/api/messages', async (req): Promise<ChatInbox> => {
    const me = requireUser(req);
    const rows = await db.query<Row & { other_id: number; name: string; role: Role; unread: number }>(
      `select distinct on (o.other_id) ${COLS}, o.other_id, u.name, u.role,
              (select count(*) from messages x where x.recipient_id = $1 and x.sender_id = o.other_id and x.read_at is null)::int as unread
         from (select id, case when sender_id = $1 then recipient_id else sender_id end as other_id from messages where sender_id = $1 or recipient_id = $1) o
         join messages m on m.id = o.id join users u on u.id = o.other_id
        where u.active and u.removed_at is null
        order by o.other_id, m.id desc`, [me.id],
    );
    const threads = rows
      .map((r) => ({ userId: Number(r.other_id), name: r.name, role: r.role, last: toMsg(r), unread: Number(r.unread) }))
      .sort((a, b) => b.last.id - a.last.id);
    return { threads, unread: threads.reduce((n, t) => n + t.unread, 0) };
  });

  /** One conversation. ?after=id returns only newer messages; otherwise the latest 100 (older with ?before=id). */
  app.get('/api/messages/:userId', async (req) => {
    const me = requireUser(req);
    const { userId } = parse(z.object({ userId: zs.id }), req.params);
    const q = parse(z.object({ after: zs.id.optional(), before: zs.id.optional() }), req.query);
    const p: unknown[] = [me.id, userId];
    let extra = '';
    if (q.after) { p.push(q.after); extra = `and m.id > $3`; }
    else if (q.before) { p.push(q.before); extra = `and m.id < $3`; }
    const rows = await db.query<Row>(
      `select ${COLS} from messages m
        where least(m.sender_id, m.recipient_id) = least($1::bigint, $2::bigint) and greatest(m.sender_id, m.recipient_id) = greatest($1::bigint, $2::bigint) ${extra}
        order by m.id ${q.after ? 'asc' : 'desc'} limit 100`, p,
    );
    const list = rows.map(toMsg);
    return { messages: q.after ? list : list.reverse(), more: !q.after && rows.length === 100 };
  });

  app.post('/api/messages/:userId', async (req) => {
    const me = requireUser(req);
    const { userId } = parse(z.object({ userId: zs.id }), req.params);
    const input = parse(z.object({ body: z.string().trim().min(1, 'Write a message').max(4000, 'Keep it under 4,000 characters') }), req.body);
    await other(me, userId);
    const r = await db.one<Row>(`insert into messages (sender_id, recipient_id, body) values ($1, $2, $3) returning id, sender_id, recipient_id, body, created_at, read_at`, [me.id, userId, input.body]);
    return { message: toMsg(r!) };
  });

  /** You've seen everything they sent you. */
  app.post('/api/messages/:userId/read', async (req) => {
    const me = requireUser(req);
    const { userId } = parse(z.object({ userId: zs.id }), req.params);
    await db.query(`update messages set read_at = now() where recipient_id = $1 and sender_id = $2 and read_at is null`, [me.id, userId]);
    return { ok: true };
  });
}
