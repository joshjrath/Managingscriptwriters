// Master log: who viewed what, who changed what, sign-ins, and blocked attempts.
//
// Changes come from the activity history (which already describes each change
// in words). Views, sign-ins and blocked attempts are recorded here. Repeat
// views of the same thing by the same person within 10 minutes count once,
// so background refreshes don't flood the log. Only admins can read it.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from './db';
import type { Ctx } from './core';
import { requireAdmin } from './auth';
import { parse, zs } from './http';
import type { AuditEntry, Me } from '../shared/types';

const VIEW_WINDOW_MS = 10 * 60_000;
/** A row's exact time as a fixed-width UTC string (microseconds), for paging: it sorts as text and round-trips exactly. */
const CURSOR = (t: string) => `to_char(${t}.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const recentViews = new Map<string, number>();

const STATIC_VIEWS: Record<string, string> = {
  '/api/dashboard': 'Viewed Overview',
  '/api/batches': 'Viewed Production',
  '/api/calendar': 'Viewed Calendar',
  '/api/review': 'Viewed the Review queue',
  '/api/resources': 'Viewed Resources',
  '/api/script-bank': 'Viewed the Script bank',
  '/api/clients': 'Viewed Clients',
  '/api/users': 'Viewed the Team',
  '/api/settings': 'Viewed Settings',
  '/api/audit': 'Viewed the Master log',
  '/api/control/world': 'Viewed the Control Center',
};

const MUTATIONS: Record<string, string> = {
  '/api/batches': 'create a batch',
  '/api/batches/:id': 'edit a batch',
  '/api/batches/:id/scripts/action': 'update scripts',
  '/api/batches/:id/scripts/assign': 'assign scripts',
  '/api/batches/:id/review': 'review scripts',
  '/api/batches/:id/submissions': 'send scripts for review',
  '/api/batches/:id/titles': 'title scripts',
  '/api/batches/:id/target': 'change a script count',
  '/api/batches/:id/archive': 'archive a batch',
  '/api/batches/:id/blocker': 'flag a blocker',
  '/api/batches/:id/written': 'update writing progress',
  '/api/scripts/:id': 'edit a script',
  '/api/shoots': 'schedule a shoot',
  '/api/shoots/:id/reschedule': 'move a shoot',
  '/api/clients': 'create a client',
  '/api/clients/:id': 'edit a client',
  '/api/clients/:id/archive': 'archive a client',
  '/api/clients/:id/stage': 'move a potential client',
  '/api/import/read': 'read pasted notes',
  '/api/import/apply': 'save pasted notes',
  '/api/clients/:id/briefings': 'add a briefing',
  '/api/resources': 'add a resource',
  '/api/resources/upload': 'upload a file',
  '/api/resources/:id': 'remove a resource',
  '/api/settings': 'change settings',
  '/api/settings/theme': 'change the colour palette',
  '/api/todos': 'add a to-do',
  '/api/messages/:userId': 'send a message',
  '/api/todos/:id': 'change a to-do',
  '/api/users': 'add a team member',
  '/api/users/:id': 'edit a team member',
  '/api/users/:id/remove': 'remove a team member',
  '/api/script-bank/past': 'add past scripts',
  '/api/script-bank/past/:id': 'remove past scripts',
  '/api/moments/seen': 'dismiss a celebration',
  '/api/me/whats-new': 'open What’s new',
  '/api/me/timezone': 'set their time zone',
  '/api/control/authorize': 'open the Control Center',
  '/api/editors': 'add an editor',
  '/api/editors/:id': 'change an editor',
};

async function describeView(db: Db, route: string, params: Record<string, string>, query: Record<string, string>, me: Me): Promise<{ key: string; summary: string; link: string | null } | null> {
  if (STATIC_VIEWS[route]) return { key: route, summary: STATIC_VIEWS[route], link: null };
  const id = Number(params.id);
  switch (route) {
    case '/api/my-work': {
      const uid = Number(query.userId);
      if (!uid || uid === me.id) return { key: route, summary: 'Viewed My work', link: '/my-work' };
      const u = await db.one<{ name: string }>(`select name from users where id = $1`, [uid]);
      return { key: `${route}:${uid}`, summary: `Viewed ${u?.name ?? 'a writer'}’s work`, link: `/my-work?userId=${uid}` };
    }
    case '/api/batches/:id': {
      const b = await db.one<{ title: string; client: string }>(`select b.title, c.name as client from batches b join clients c on c.id = b.client_id where b.id = $1`, [id]);
      return b ? { key: `${route}:${id}`, summary: `Viewed batch “${b.title}” (${b.client})`, link: `/batches/${id}` } : null;
    }
    case '/api/clients/:id': {
      const c = await db.one<{ name: string }>(`select name from clients where id = $1`, [id]);
      return c ? { key: `${route}:${id}`, summary: `Viewed client ${c.name}`, link: `/clients/${id}` } : null;
    }
    case '/api/files/:id': {
      const f = await db.one<{ filename: string }>(`select filename from files where id = $1`, [id]);
      return f ? { key: `${route}:${id}`, summary: `Opened file “${f.filename}”`, link: null } : null;
    }
    case '/api/search': {
      const q = String(query.q ?? '').trim().slice(0, 80);
      return q ? { key: `${route}:${q.toLowerCase()}`, summary: `Searched for “${q}”`, link: null } : null;
    }
    default:
      return null;
  }
}

export async function auditEvent(db: Db, e: { userId: number | null; kind: 'view' | 'auth' | 'denied'; summary: string; link?: string | null; ip?: string | null }) {
  await db.query(`insert into audit_log (user_id, kind, summary, link, ip) values ($1, $2, $3, $4, $5)`, [e.userId, e.kind, e.summary, e.link ?? null, e.ip ?? null]);
}

export function registerAudit(app: FastifyInstance, ctx: Ctx) {
  app.addHook('onResponse', async (req, reply) => {
    try {
      const route = req.routeOptions?.url;
      const me = req.user;
      if (!me || !route || !route.startsWith('/api/')) return;
      // Recording mode is practice: only turning it on and off is logged (by recording.ts).
      if (req.recording) return;
      // While viewing as someone, it's the admin looking.
      const actor = req.realUser ?? me;
      const as = req.viewingAs ? ` (viewing as ${req.viewingAs.name})` : '';
      const status = reply.statusCode;
      if (req.method === 'GET') {
        if (status >= 400) return;
        const v = await describeView(ctx.db, route, (req.params ?? {}) as Record<string, string>, (req.query ?? {}) as Record<string, string>, me);
        if (!v) return;
        const key = `${actor.id}|${me.id}|${v.key}`;
        const now = Date.now();
        if ((recentViews.get(key) ?? 0) > now - VIEW_WINDOW_MS) return;
        recentViews.set(key, now);
        if (recentViews.size > 10_000) for (const [k, t] of recentViews) if (t < now - VIEW_WINDOW_MS) recentViews.delete(k);
        await auditEvent(ctx.db, { userId: actor.id, kind: 'view', summary: v.summary + as, link: v.link });
      } else if (status === 403) {
        const what = MUTATIONS[route] ?? `${req.method} ${route}`;
        if (req.viewingAs) return; // refused only because it's view-only
        await auditEvent(ctx.db, { userId: actor.id, kind: 'denied', summary: `Tried to ${what} — not allowed`, ip: req.ip });
      }
    } catch (err) {
      req.log.warn({ err }, 'master log write failed');
    }
  });

  app.get('/api/audit', async (req) => {
    requireAdmin(req, 'Only admins can see the master log');
    const q = parse(z.object({
      before: z.string().datetime({ offset: true }).optional(),
      limit: z.coerce.number().int().min(10).max(300).default(120),
      userId: zs.id.optional(),
      kind: z.enum(['all', 'view', 'change', 'auth', 'denied']).default('all'),
      q: z.string().trim().max(100).optional(),
    }), req.query);
    const before = q.before ?? new Date(Date.now() + 60_000).toISOString();
    const like = q.q ? `%${q.q.toLowerCase()}%` : null;
    // Paged by an exact (microsecond) cursor, and each page takes every row that shares its oldest
    // timestamp (WITH TIES): everything one transaction writes has the same time, and a page boundary
    // inside such a group must not skip the rest of it.
    const entries: (AuditEntry & { cursor: string })[] = [];

    if (q.kind === 'all' || q.kind === 'change') {
      const p: unknown[] = [before, q.limit];
      let where = `a.created_at < $1`;
      if (q.userId) { p.push(q.userId); where += ` and a.actor_id = $${p.length}`; }
      if (like) { p.push(like); where += ` and (lower(a.summary) like $${p.length} or lower(coalesce(u.name, '')) like $${p.length} or lower(coalesce(b.title, '')) like $${p.length} or lower(coalesce(c.name, '')) like $${p.length})`; }
      const rows = await ctx.db.query<{ id: number; created_at: string; cursor: string; actor_id: number | null; name: string | null; summary: string; batch_id: number | null; client_id: number | null; batch_title: string | null; client_name: string | null }>(
        `select * from (
           select a.id, a.created_at, ${CURSOR('a')} as cursor, a.actor_id, u.name, a.summary, a.batch_id, a.client_id, b.title as batch_title, c.name as client_name
             from activity a left join users u on u.id = a.actor_id left join batches b on b.id = a.batch_id left join clients c on c.id = a.client_id
            where ${where} order by a.created_at desc fetch first $2 rows with ties
         ) s order by created_at desc, id desc`, p,
      );
      for (const r of rows) {
        const where2 = r.batch_title ? ` · ${r.client_name ? `${r.client_name} · ` : ''}${r.batch_title}` : r.client_name ? ` · ${r.client_name}` : '';
        entries.push({
          id: `a${r.id}`, at: r.created_at, cursor: r.cursor, userId: r.actor_id, userName: r.name, kind: 'change', summary: `${r.summary}${where2}`,
          link: r.batch_id ? `/batches/${r.batch_id}` : r.client_id ? `/clients/${r.client_id}` : null, ip: null,
        });
      }
    }
    if (q.kind !== 'change') {
      const p: unknown[] = [before, q.limit];
      let where = `l.created_at < $1`;
      if (q.kind !== 'all') { p.push(q.kind); where += ` and l.kind = $${p.length}`; }
      if (q.userId) { p.push(q.userId); where += ` and l.user_id = $${p.length}`; }
      if (like) { p.push(like); where += ` and (lower(l.summary) like $${p.length} or lower(coalesce(u.name, '')) like $${p.length})`; }
      const rows = await ctx.db.query<{ id: number; created_at: string; cursor: string; user_id: number | null; name: string | null; kind: 'view' | 'auth' | 'denied'; summary: string; link: string | null; ip: string | null }>(
        `select * from (
           select l.id, l.created_at, ${CURSOR('l')} as cursor, l.user_id, u.name, l.kind, l.summary, l.link, l.ip from audit_log l left join users u on u.id = l.user_id
            where ${where} order by l.created_at desc fetch first $2 rows with ties
         ) s order by created_at desc, id desc`, p,
      );
      for (const r of rows) entries.push({ id: `l${r.id}`, at: r.created_at, cursor: r.cursor, userId: r.user_id, userName: r.name, kind: r.kind, summary: r.summary, link: r.link, ip: r.ip });
    }
    entries.sort((a, b) => b.cursor.localeCompare(a.cursor));
    let page = entries.slice(0, q.limit);
    // never split entries that share a timestamp across pages
    if (entries.length > q.limit) {
      const edge = page[page.length - 1].cursor;
      page = entries.filter((e) => e.cursor >= edge);
    }
    const more = entries.length > page.length;
    const last = page[page.length - 1];
    return {
      entries: page.map(({ cursor: _cursor, ...e }): AuditEntry => e),
      nextBefore: (more || page.length >= q.limit) && last ? last.cursor : null,
    };
  });
}
