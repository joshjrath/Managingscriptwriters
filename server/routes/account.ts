// Sign-in, first-run setup, team management, organisation settings and notifications.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  checkThrottle, clearFailures, createSession, destroySession, hashPassword, recordFailure, requireManager, requireUser,
  SESSION_COOKIE, setSessionCookie, sha, validatePassword, verifyPassword,
} from '../auth';
import { assigneesOf, batchLink, loadSettings, loadUsers, logActivity, notify, rulesOf, type Ctx } from '../core';
import { conflict, HttpError, notFound, parse, zs } from '../http';
import { computeDeadlines, isValidTimeZone } from '../../shared/dates';
import { fmtDate } from '../../shared/format';
import type { Notification } from '../../shared/types';

const email = z.string().trim().toLowerCase().email('Enter a valid email').max(200);
const password = z.string().min(1, 'Enter a password').max(200);

export function registerAccountRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  app.get('/api/auth/status', async (req) => {
    const users = await db.one<{ n: number }>(`select count(*) as n from users`);
    const settings = await loadSettings(db);
    return {
      signedIn: !!req.user,
      needsSetup: (users?.n ?? 0) === 0,
      setupAllowed: ctx.allowSetup,
      demo: settings.isDemo,
      orgName: settings.orgName,
    };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const input = parse(z.object({ email, password }), req.body);
    const key = `${req.ip}|${input.email}`;
    checkThrottle(key);
    const u = await db.one<{ id: number; password_hash: string; active: boolean }>(`select id, password_hash, active from users where lower(email) = $1`, [input.email]);
    const ok = u ? await verifyPassword(input.password, u.password_hash) : await verifyPassword(input.password, 'scrypt$AAAA$AAAA');
    if (!u || !ok || !u.active) {
      recordFailure(key);
      throw new HttpError(401, u && ok && !u.active ? 'This account has been deactivated' : 'Email or password is incorrect');
    }
    clearFailures(key);
    const token = await createSession(db, u.id);
    setSessionCookie(reply, token, ctx.secureCookies);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await destroySession(db, req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // First run only: creates the first manager when there are no users yet.
  app.post('/api/auth/setup', async (req, reply) => {
    if (!ctx.allowSetup) throw new HttpError(403, 'Setup from the browser is disabled here. Set MANAGER_EMAIL and MANAGER_PASSWORD on the server instead.');
    const input = parse(z.object({ name: zs.name('Name', 120), email, password }), req.body);
    const pwErr = validatePassword(input.password);
    if (pwErr) throw new HttpError(400, pwErr, { password: pwErr });
    const id = await db.tx(async (t) => {
      const n = await t.one<{ n: number }>(`select count(*) as n from users`);
      if ((n?.n ?? 0) > 0) throw conflict('Setup has already been completed');
      const row = await t.one<{ id: number }>(
        `insert into users (email, name, role, password_hash) values ($1, $2, 'manager', $3) returning id`,
        [input.email, input.name, await hashPassword(input.password)],
      );
      return row!.id;
    });
    setSessionCookie(reply, await createSession(db, id), ctx.secureCookies);
    return { ok: true };
  });

  app.post('/api/me/password', async (req) => {
    const me = requireUser(req);
    const input = parse(z.object({ current: password, next: password }), req.body);
    const u = await db.one<{ password_hash: string }>(`select password_hash from users where id = $1`, [me.id]);
    if (!u || !(await verifyPassword(input.current, u.password_hash))) throw new HttpError(400, 'Current password is incorrect', { current: 'Current password is incorrect' });
    const err = validatePassword(input.next);
    if (err) throw new HttpError(400, err, { next: err });
    await db.query(`update users set password_hash = $2, updated_at = now() where id = $1`, [me.id, await hashPassword(input.next)]);
    const token = req.cookies[SESSION_COOKIE];
    await db.query(`delete from sessions where user_id = $1 and token_hash <> $2`, [me.id, sha(token ?? '')]);
    return { ok: true };
  });

  // ── team ───────────────────────────────────────────────────────────────

  app.get('/api/users', async (req) => {
    requireUser(req);
    return { users: await loadUsers(db) };
  });

  const capacity = z.coerce.number().positive('Use a positive number').max(50).nullable().optional();

  app.post('/api/users', async (req) => {
    const me = requireManager(req);
    const input = parse(z.object({
      name: zs.name('Name', 120), email, role: z.enum(['manager', 'writer']), password, capacityPerDay: capacity,
    }), req.body);
    const err = validatePassword(input.password);
    if (err) throw new HttpError(400, err, { password: err });
    const exists = await db.one(`select 1 from users where lower(email) = $1`, [input.email]);
    if (exists) throw new HttpError(409, 'Someone with that email already has an account', { email: 'Already in use' });
    const row = await db.one<{ id: number }>(
      `insert into users (email, name, role, password_hash, capacity_per_day) values ($1,$2,$3,$4,$5) returning id`,
      [input.email, input.name, input.role, await hashPassword(input.password), input.capacityPerDay ?? null],
    );
    await logActivity(db, { actor: me, action: 'user.created', entityType: 'user', entityId: row!.id, summary: `Added ${input.name} as ${input.role}` });
    return { users: await loadUsers(db) };
  });

  app.patch('/api/users/:id', async (req) => {
    const me = requireManager(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const input = parse(z.object({
      name: zs.name('Name', 120).optional(), role: z.enum(['manager', 'writer']).optional(), active: z.boolean().optional(),
      capacityPerDay: capacity, password: z.string().max(200).optional(),
    }), req.body);
    const u = await db.one<{ role: string; active: boolean; name: string }>(`select role, active, name from users where id = $1`, [id]);
    if (!u) throw notFound('User');
    if ((input.role === 'writer' || input.active === false) && u.role === 'manager') {
      const others = await db.one<{ n: number }>(`select count(*) as n from users where role = 'manager' and active and id <> $1`, [id]);
      if (!others?.n) throw new HttpError(400, 'Keep at least one active manager');
    }
    if (input.active === false && id === me.id) throw new HttpError(400, 'You can’t deactivate your own account');
    const set: Record<string, unknown> = {};
    if (input.name !== undefined) set.name = input.name;
    if (input.role !== undefined) set.role = input.role;
    if (input.active !== undefined) set.active = input.active;
    if (input.capacityPerDay !== undefined) set.capacity_per_day = input.capacityPerDay;
    if (input.password) {
      const err = validatePassword(input.password);
      if (err) throw new HttpError(400, err, { password: err });
      set.password_hash = await hashPassword(input.password);
    }
    const keys = Object.keys(set);
    if (keys.length) {
      await db.query(`update users set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1`, [id, ...keys.map((k) => set[k])]);
      if (input.active === false || input.password) await db.query(`delete from sessions where user_id = $1`, [id]);
      await logActivity(db, { actor: me, action: 'user.updated', entityType: 'user', entityId: id, summary: `Updated ${u.name}: ${keys.map((k) => (k === 'password_hash' ? 'password reset' : k.replace(/_/g, ' '))).join(', ')}` });
    }
    return { users: await loadUsers(db) };
  });

  // ── settings ───────────────────────────────────────────────────────────

  app.get('/api/settings', async (req) => {
    requireUser(req);
    return { settings: await loadSettings(db) };
  });

  app.patch('/api/settings', async (req) => {
    const me = requireManager(req);
    const input = parse(z.object({
      orgName: zs.name('Organisation name', 120).optional(),
      timezone: z.string().refine(isValidTimeZone, 'Choose a valid timezone').optional(),
      cutoff: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 17:00').optional(),
      draftOffsetDays: z.coerce.number().int().min(0).max(60).optional(),
      finalOffsetDays: z.coerce.number().int().min(0).max(60).optional(),
      dayMode: z.enum(['calendar', 'business']).optional(),
      workingDays: z.array(z.number().int().min(0).max(6)).min(1, 'Pick at least one working day').max(7).optional(),
      reminderLeadDays: z.coerce.number().int().min(0).max(14).optional(),
      recalculate: z.boolean().default(false),
    }), req.body);
    const before = await loadSettings(db);
    const draft = input.draftOffsetDays ?? before.draftOffsetDays;
    const final = input.finalOffsetDays ?? before.finalOffsetDays;
    if (final > draft) throw new HttpError(400, 'Final delivery should come after drafts, so its offset must be smaller', { finalOffsetDays: 'Must be ≤ the draft offset' });
    const map: Record<string, string> = {
      orgName: 'org_name', timezone: 'timezone', cutoff: 'cutoff', draftOffsetDays: 'draft_offset_days', finalOffsetDays: 'final_offset_days',
      dayMode: 'day_mode', workingDays: 'working_days', reminderLeadDays: 'reminder_lead_days',
    };
    const keys = Object.keys(map).filter((k) => (input as Record<string, unknown>)[k] !== undefined);
    let recalculated = 0;
    await db.tx(async (t) => {
      if (keys.length) {
        await t.query(
          `update settings set ${keys.map((k, i) => `${map[k]} = $${i + 1}${k === 'workingDays' ? '::jsonb' : ''}`).join(', ')}, updated_at = now() where id = 1`,
          keys.map((k) => (k === 'workingDays' ? JSON.stringify([...new Set(input.workingDays)].sort()) : (input as Record<string, unknown>)[k])),
        );
        await logActivity(t, { actor: me, action: 'settings.updated', entityType: 'settings', summary: `Updated settings: ${keys.join(', ')}` });
      }
      if (input.recalculate) {
        const s = await loadSettings(t);
        const rows = await t.query<{ id: number; client_id: number; title: string; start_date: string; draft_due: string | null; final_due: string | null; draft_due_mode: string; final_due_mode: string }>(
          `select b.id, b.client_id, b.title, s.start_date, b.draft_due, b.final_due, b.draft_due_mode, b.final_due_mode
             from batches b join shoots s on s.id = b.shoot_id where b.archived_at is null and (b.draft_due_mode = 'auto' or b.final_due_mode = 'auto')`,
        );
        for (const r of rows) {
          const d = computeDeadlines(r.start_date, rulesOf(s));
          const nd = r.draft_due_mode === 'auto' ? d.draftDue : r.draft_due;
          const nf = r.final_due_mode === 'auto' ? d.finalDue : r.final_due;
          if (nd === r.draft_due && nf === r.final_due) continue;
          recalculated++;
          await t.query(`update batches set draft_due = $2, final_due = $3, updated_at = now() where id = $1`, [r.id, nd, nf]);
          const msg = [nd !== r.draft_due ? `Drafts ${fmtDate(r.draft_due)} → ${fmtDate(nd)}` : null, nf !== r.final_due ? `Final delivery ${fmtDate(r.final_due)} → ${fmtDate(nf)}` : null].filter(Boolean).join(' · ');
          await logActivity(t, { actor: me, action: 'batch.deadlines', entityType: 'batch', entityId: r.id, batchId: r.id, clientId: r.client_id, summary: `Deadline rules changed: ${msg}` });
          await notify(t, await assigneesOf(t, r.id, { undeliveredOnly: true }), { type: 'deadline_change', title: `Deadline changed · ${r.title}`, body: msg, link: batchLink(r.id) }, me.id);
        }
      }
    });
    return { settings: await loadSettings(db), recalculated };
  });

  // ── notifications ──────────────────────────────────────────────────────

  app.get('/api/notifications', async (req) => {
    const me = requireUser(req);
    const rows = await db.query<{ id: number; type: string; title: string; body: string | null; link: string | null; read_at: string | null; created_at: string }>(
      `select id, type, title, body, link, read_at, created_at from notifications where user_id = $1 order by created_at desc, id desc limit 60`, [me.id],
    );
    const unread = await db.one<{ n: number }>(`select count(*) as n from notifications where user_id = $1 and read_at is null`, [me.id]);
    const notifications: Notification[] = rows.map((r) => ({ id: r.id, type: r.type, title: r.title, body: r.body, link: r.link, readAt: r.read_at, createdAt: r.created_at }));
    return { notifications, unread: unread?.n ?? 0 };
  });

  app.post('/api/notifications/read', async (req) => {
    const me = requireUser(req);
    const input = parse(z.object({ ids: z.array(zs.id).max(200).optional(), all: z.boolean().optional() }), req.body);
    if (input.all) await db.query(`update notifications set read_at = now() where user_id = $1 and read_at is null`, [me.id]);
    else if (input.ids?.length) {
      await db.query(`update notifications set read_at = now() where user_id = $1 and read_at is null and id in (${input.ids.map((_, i) => `$${i + 2}`).join(',')})`, [me.id, ...input.ids]);
    }
    return { ok: true };
  });
}
