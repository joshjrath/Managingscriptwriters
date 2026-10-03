// View as and Recording mode, for admins.
//
// View as: the whole site shows exactly what another team member sees. On the
// real workspace it's view-only: changes are refused, and background writes
// (dismissing their celebrations, reading their notifications, opening What's
// new) quietly do nothing, so nothing happens under their name.
//
// Recording mode: a throwaway copy of the whole workspace for this one
// sign-in, kept in a private schema of the same database (so it costs the
// server almost no memory). Everything works (send scripts, approve, drag shoots, view
// as anyone and act as them) and it all disappears when recording is turned
// off, the admin signs out, it's left idle for 6 hours, or the server
// restarts. Every request from that sign-in is sent to the copy through
// AsyncLocalStorage, so routes don't need to know it exists.

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { migrate, type Db } from './db';
import { requireUser, SESSION_COOKIE, sha, userForToken } from './auth';
import { auditEvent } from './audit';
import { HttpError, isApiRequest, parse, requestPath, zs } from './http';
import type { Ctx } from './core';
import { RECORDING_ENDED, RECORDING_HEADER, type Me, type SessionMode } from '../shared/types';
import { isAdmin, ROLE_LABEL } from '../shared/workflow';

const IDLE_MS = 6 * 3600_000;
const MAX_SANDBOXES = 2;

interface Sandbox {
  db: Db;
  startedAt: string;
  lastUsed: number;
}

interface Mode {
  viewAs: number | null;
  sandbox: Sandbox | null;
  /** a copy being made right now, so a double click doesn't make two */
  starting?: Promise<Sandbox>;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** who is actually signed in (differs from `user` while viewing as someone) */
    realUser: Me | null;
    viewingAs: Me | null;
    recording: { startedAt: string } | null;
  }
}

// ── the copy ─────────────────────────────────────────────────────────────

// Tables left empty in the copy: sign-ins stay on the real workspace.
const SKIP = new Set(['schema_migrations', 'sessions']);

/**
 * A copy of `src` for Recording mode: a private schema in the same database,
 * filled by the database itself (`insert … select`), so no rows pass through
 * the server and no second database engine is started (one would cost ~500 MB).
 * File contents stay on the real workspace (see the /api/files route), and only the
 * newest Master log entries are copied. Closing the copy drops the schema.
 */
const SANDBOX_PREFIX = 'rec_';
/** A practice copy's schema name, exactly: `rec_` and 12 hex digits. Nothing else is ever dropped as one. */
const SANDBOX_NAME = '^rec_[0-9a-f]{12}$';
const AUDIT_ROWS = 500;

/** Drops practice copies left behind by an earlier process (they live only as long as the process that made them). */
export async function dropLeftoverSandboxes(db: Db): Promise<number> {
  const rows = await db.query<{ s: string }>(`select nspname as s from pg_namespace where nspname ~ $1`, [SANDBOX_NAME]);
  const names = rows.map((r) => r.s).filter((s) => new RegExp(SANDBOX_NAME).test(s));
  for (const s of names) await db.query(`drop schema if exists "${s}" cascade`);
  return names.length;
}

export async function cloneDb(src: Db): Promise<Db> {
  const schema = `${SANDBOX_PREFIX}${randomBytes(6).toString('hex')}`;
  const from = (await src.one<{ s: string }>(`select current_schema() as s`))!.s;
  await src.query(`create schema ${schema}`);
  const drop = () => src.query(`drop schema if exists ${schema} cascade`).then(() => {}, () => {});
  let dst: Db | null = null;
  try {
    dst = await src.withSchema(schema);
    await migrate(dst);
    const d = dst;
    const tables = (await d.query<{ name: string }>(
      `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relkind = 'r' order by c.oid`, [schema],
    )).map((r) => r.name).filter((t) => !SKIP.has(t));
    const cols = await d.query<{ tbl: string; col: string }>(
      `select table_name as tbl, column_name as col from information_schema.columns where table_schema = $1 order by table_name, ordinal_position`, [schema],
    );
    const fks = await d.query<{ tbl: string; con: string }>(
      `select c.conrelid::regclass::text as tbl, c.conname as con from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = $1 and c.contype = 'f'`, [schema],
    );
    const identity = await d.query<{ tbl: string; col: string }>(
      `select table_name as tbl, column_name as col from information_schema.columns where table_schema = $1 and is_identity = 'YES'`, [schema],
    );
    for (const f of fks) await d.query(`alter table ${f.tbl} alter constraint "${f.con}" deferrable initially deferred`);
    await d.tx(async (t) => {
      // one snapshot for every table, so a batch created mid-copy can't leave scripts pointing at nothing
      await t.query(`set transaction isolation level repeatable read`);
      for (const name of tables) await t.query(`delete from "${name}"`);
      for (const name of tables) {
        const list = cols.filter((c) => c.tbl === name).map((c) => c.col);
        const pick = list.map((c) => (name === 'files' && c === 'data' ? `''::bytea` : `"${c}"`));
        const only = name === 'audit_log' ? ` where id in (select id from "${from}"."audit_log" order by id desc limit ${AUDIT_ROWS})` : '';
        await t.query(`insert into "${name}" (${list.map((c) => `"${c}"`).join(', ')}) overriding system value select ${pick.join(', ')} from "${from}"."${name}"${only}`);
      }
    });
    for (const c of identity) {
      await d.query(`select setval(pg_get_serial_sequence('${c.tbl}', '${c.col}'), coalesce((select max("${c.col}") from "${c.tbl}"), 0) + 1, false)`);
    }
    return { ...d, close: async () => { await d.close().catch(() => {}); await drop(); } };
  } catch (err) {
    await dst?.close().catch(() => {});
    await drop();
    throw err;
  }
}


// ── routing requests ─────────────────────────────────────────────────────

/** A Db that runs each query on the current request's workspace: the copy while recording, otherwise the real one. */
export function routedDb(real: Db, als: AsyncLocalStorage<Db>): Db {
  const cur = () => als.getStore() ?? real;
  return {
    kind: real.kind,
    query: (sql, params) => cur().query(sql, params),
    one: (sql, params) => cur().one(sql, params),
    tx: (fn) => cur().tx(fn),
    close: () => real.close(),
    withSchema: (schema) => real.withSchema(schema),
  };
}

async function loadMember(db: Db, id: number): Promise<Me | null> {
  const r = await db.one<{ id: number; name: string; email: string; role: Me['role']; capacity_per_day: number | null }>(
    `select id, name, email, role, capacity_per_day from users where id = $1 and active and removed_at is null`, [id],
  );
  return r ? { id: r.id, name: r.name, email: r.email, role: r.role, capacityPerDay: r.capacity_per_day } : null;
}

// Background writes the app makes on its own; while only viewing, they succeed without doing anything.
const QUIET: Record<string, unknown> = {
  '/api/moments/seen': { ok: true },
  '/api/notifications/read': { ok: true },
  '/api/me/whats-new': { ok: true },
};

export function registerRecording(app: FastifyInstance, ctx: Ctx, realDb: Db, als: AsyncLocalStorage<Db>) {
  const modes = new Map<string, Mode>();
  // Practice copies live only as long as this process; drop any left behind by a restart.
  dropLeftoverSandboxes(realDb).catch((err: unknown) => app.log.warn({ err }, 'could not clean up old practice copies'));

  const closeSandbox = async (m: Mode) => {
    const sb = m.sandbox;
    m.sandbox = null;
    if (sb) await sb.db.close().catch(() => {});
  };
  const sweep = async (forget = true) => {
    const now = Date.now();
    for (const [key, m] of modes) {
      if (m.sandbox && m.sandbox.lastUsed < now - IDLE_MS) {
        await closeSandbox(m);
        m.viewAs = null;
      }
      if (forget && !m.sandbox && !m.viewAs && !m.starting) modes.delete(key);
    }
  };
  const timer = setInterval(() => { void sweep(); }, 10 * 60_000);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    for (const m of modes.values()) await closeSandbox(m);
    modes.clear();
  });

  app.decorateRequest('realUser', null);
  app.decorateRequest('viewingAs', null);
  app.decorateRequest('recording', null);

  // Who's asking, and which workspace they're working in.
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isApiRequest(req)) return;
    const token = req.cookies[SESSION_COOKIE];
    const real = await userForToken(realDb, token);
    req.user = real;
    req.realUser = real;
    req.viewingAs = null;
    req.recording = null;
    if (!real || !token) return;
    const key = sha(token);
    const m = modes.get(key);
    // The page thinks it's recording but its practice copy is gone (the server restarted, or the copy
    // was closed to make room or after hours idle): refuse changes rather than make them for real.
    const claimed = req.headers[RECORDING_HEADER];
    if (typeof claimed === 'string' && claimed && m?.sandbox?.startedAt !== claimed && req.method !== 'GET' && req.method !== 'HEAD') {
      const path = requestPath(req);
      if (!path.startsWith('/api/admin/') && !path.startsWith('/api/auth/')) {
        throw new HttpError(409, 'Recording mode has ended (the practice copy was closed), so nothing was saved. Reload the page to carry on.', undefined, RECORDING_ENDED);
      }
    }
    if (!m) return;
    if (!isAdmin(real.role)) { await closeSandbox(m); modes.delete(key); return; }
    if (m.sandbox) {
      m.sandbox.lastUsed = Date.now();
      req.recording = { startedAt: m.sandbox.startedAt };
    }
    if (m.viewAs) {
      const target = await loadMember(m.sandbox?.db ?? realDb, m.viewAs);
      if (target && target.id !== real.id) { req.user = target; req.viewingAs = target; } else m.viewAs = null;
    }
    // Viewing the real workspace as someone: look, don't touch.
    if (req.viewingAs && !req.recording) {
      const path = requestPath(req);
      if (path.startsWith('/api/admin/') || path === '/api/auth/logout') return;
      if (req.method === 'GET' && path === '/api/moments') return reply.send([]);
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        if (path in QUIET || /^\/api\/messages\/\d+\/read$/.test(path)) return reply.send(QUIET[path] ?? { ok: true });
        throw new HttpError(403, `You’re viewing as ${req.viewingAs.name}, so changes are off. Turn on Recording mode to try things out.`, undefined, 'viewing_as');
      }
    }
  });

  // Run everything after this point on the copy while recording. Sign-in and
  // these admin controls always use the real workspace. Entered again just
  // before the handler in case body parsing lost the context.
  const enter = (req: FastifyRequest, _reply: FastifyReply, done: () => void) => {
    const path = requestPath(req);
    const sb = req.recording && req.realUser ? modes.get(sha(req.cookies[SESSION_COOKIE] ?? ''))?.sandbox : null;
    if (sb && !path.startsWith('/api/auth/') && !path.startsWith('/api/admin/')) als.run(sb.db, done);
    else done();
  };
  app.addHook('onRequest', enter);
  app.addHook('preHandler', enter);

  const requireAdmin = (req: FastifyRequest): { me: Me; key: string; mode: Mode } => {
    const me = req.realUser;
    if (!me) throw new HttpError(401, 'Please sign in');
    if (!isAdmin(me.role)) throw new HttpError(403, 'Only admins can do this');
    const key = sha(req.cookies[SESSION_COOKIE] ?? '');
    let mode = modes.get(key);
    if (!mode) { mode = { viewAs: null, sandbox: null }; modes.set(key, mode); }
    return { me, key, mode };
  };
  const state = async (req: FastifyRequest): Promise<SessionMode> => {
    const { me, mode } = requireAdmin(req);
    const who = mode.viewAs ? await loadMember(mode.sandbox?.db ?? realDb, mode.viewAs) : null;
    return modeFor(me, who, mode.sandbox ? { startedAt: mode.sandbox.startedAt } : null);
  };

  app.post('/api/admin/view-as', async (req) => {
    const { me, mode } = requireAdmin(req);
    const { userId } = parse(z.object({ userId: zs.id }), req.body);
    if (userId === me.id) {
      mode.viewAs = null;
      return state(req);
    }
    const target = await loadMember(mode.sandbox?.db ?? realDb, userId);
    if (!target) throw new HttpError(404, 'That person isn’t on the team any more');
    mode.viewAs = target.id;
    await auditEvent(realDb, { userId: me.id, kind: 'auth', summary: `Started viewing as ${target.name}${mode.sandbox ? ' in Recording mode' : ''}`, ip: req.ip });
    return state(req);
  });

  app.post('/api/admin/view-as/stop', async (req) => {
    const { me, mode } = requireAdmin(req);
    if (mode.viewAs) {
      const was = await loadMember(mode.sandbox?.db ?? realDb, mode.viewAs);
      mode.viewAs = null;
      await auditEvent(realDb, { userId: me.id, kind: 'auth', summary: `Stopped viewing as ${was?.name ?? 'a team member'}`, ip: req.ip });
    }
    return state(req);
  });

  app.post('/api/admin/recording/start', async (req) => {
    const { me, mode } = requireAdmin(req);
    if (!mode.sandbox) {
      if (!mode.starting) {
        await sweep(false);
        const open = [...modes.values()].filter((m) => m.sandbox).sort((a, b) => a.sandbox!.lastUsed - b.sandbox!.lastUsed);
        while (open.length >= MAX_SANDBOXES) { const m = open.shift()!; await closeSandbox(m); m.viewAs = null; }
        mode.starting = cloneDb(realDb).then((db) => ({ db, startedAt: ctx.now().toISOString(), lastUsed: Date.now() }));
        try {
          mode.sandbox = await mode.starting;
        } finally {
          mode.starting = undefined;
        }
        // whoever you were viewing as stays, if they exist in the copy (they always do)
        await auditEvent(realDb, { userId: me.id, kind: 'auth', summary: 'Turned on Recording mode (a practice copy; nothing is saved)', ip: req.ip });
      } else {
        await mode.starting;
      }
    }
    return state(req);
  });

  app.post('/api/admin/recording/stop', async (req) => {
    const { me, mode } = requireAdmin(req);
    if (mode.starting) await mode.starting.catch(() => {});
    if (mode.sandbox) {
      await closeSandbox(mode);
      // someone added while recording doesn't exist any more
      if (mode.viewAs && !(await loadMember(realDb, mode.viewAs))) mode.viewAs = null;
      await auditEvent(realDb, { userId: me.id, kind: 'auth', summary: 'Turned off Recording mode; everything done in it was discarded', ip: req.ip });
    }
    return state(req);
  });

  // Signing out ends both.
  app.addHook('onResponse', async (req) => {
    if (requestPath(req) !== '/api/auth/logout') return;
    const key = sha(req.cookies[SESSION_COOKIE] ?? '');
    const m = modes.get(key);
    if (m) { await closeSandbox(m); modes.delete(key); }
  });
}

export function modeFor(real: Me, viewingAs: Me | null, recording: { startedAt: string } | null): SessionMode {
  return {
    realId: real.id,
    realName: real.name,
    viewingAs: viewingAs ? { id: viewingAs.id, name: viewingAs.name, role: viewingAs.role, roleLabel: ROLE_LABEL[viewingAs.role] } : null,
    recording,
  };
}

/** The bootstrap's view of the above, or null for anyone who isn't an admin. */
export function sessionMode(req: FastifyRequest): SessionMode | null {
  const real = req.realUser ?? requireUser(req);
  if (!isAdmin(real.role)) return null;
  return modeFor(real, req.viewingAs, req.recording);
}
