// Sign-in, first-run setup, team management, organisation settings and notifications.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  checkThrottle, clearFailures, createSession, destroySession, hashPassword, recordFailure, requireManager, requireUser,
  SESSION_COOKIE, setSessionCookie, sha, validatePassword, verifyPassword,
} from '../auth';
import { assigneesOf, batchLink, loadSettings, loadUsers, logActivity, notify, rulesOf, type Ctx } from '../core';
import { compressRanges, isManager } from '../../shared/workflow';
import type { Me, UserSummary } from '../../shared/types';
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
      setupHint: ctx.setupHint ?? null,
      demo: settings.isDemo,
      orgName: settings.orgName,
    };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const input = parse(z.object({ email, password }), req.body);
    const key = `${req.ip}|${input.email}`;
    checkThrottle(key);
    const u = await db.one<{ id: number; password_hash: string; active: boolean }>(`select id, password_hash, active and removed_at is null as active from users where lower(email) = $1`, [input.email]);
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
        `insert into users (email, name, role, password_hash) values ($1, $2, 'owner', $3) returning id`,
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
    await db.query(`update users set password_hash = $2, temp_password = null, updated_at = now() where id = $1`, [me.id, await hashPassword(input.next)]);
    const token = req.cookies[SESSION_COOKIE];
    await db.query(`delete from sessions where user_id = $1 and token_hash <> $2`, [me.id, sha(token ?? '')]);
    return { ok: true };
  });

  // ── team ───────────────────────────────────────────────────────────────

  const ROLES = ['owner', 'manager', 'writer'] as const;
  const MANAGER_ROLES = `role in ('owner', 'manager')`;

  /** The team list. Owners and managers also see temporary passwords that haven't been replaced yet. */
  async function teamFor(me: Me): Promise<UserSummary[]> {
    const users = await loadUsers(db);
    if (!isManager(me.role)) return users;
    const temps = new Map((await db.query<{ id: number; temp_password: string }>(`select id, temp_password from users where temp_password is not null and removed_at is null`)).map((r) => [r.id, r.temp_password]));
    return users.map((u) => ({ ...u, tempPassword: temps.get(u.id) ?? null }));
  }

  async function keepAManager(excludeId: number) {
    const others = await db.one<{ n: number }>(`select count(*) as n from users where ${MANAGER_ROLES} and active and removed_at is null and id <> $1`, [excludeId]);
    if (!others?.n) throw new HttpError(400, 'Keep at least one active owner or manager');
  }

  app.get('/api/users', async (req) => {
    return { users: await teamFor(requireUser(req)) };
  });

  const capacity = z.coerce.number().positive('Use a positive number').max(50).nullable().optional();

  app.post('/api/users', async (req) => {
    const me = requireManager(req);
    const input = parse(z.object({
      name: zs.name('Name', 120), email, role: z.enum(ROLES), password, capacityPerDay: capacity,
    }), req.body);
    const err = validatePassword(input.password);
    if (err) throw new HttpError(400, err, { password: err });
    const existing = await db.one<{ id: number; removed_at: string | null }>(`select id, removed_at from users where lower(email) = $1`, [input.email]);
    if (existing && !existing.removed_at) throw new HttpError(409, 'Someone with that email is already on the team', { email: 'Already on the team' });
    const hash = await hashPassword(input.password);
    let id: number;
    if (existing) {
      // someone who was removed earlier comes back with their history intact
      await db.query(
        `update users set name = $2, role = $3, password_hash = $4, temp_password = $5, capacity_per_day = $6, active = true, removed_at = null, updated_at = now() where id = $1`,
        [existing.id, input.name, input.role, hash, input.password, input.capacityPerDay ?? null],
      );
      id = existing.id;
    } else {
      const row = await db.one<{ id: number }>(
        `insert into users (email, name, role, password_hash, temp_password, capacity_per_day) values ($1,$2,$3,$4,$5,$6) returning id`,
        [input.email, input.name, input.role, hash, input.password, input.capacityPerDay ?? null],
      );
      id = row!.id;
    }
    await logActivity(db, { actor: me, action: 'user.created', entityType: 'user', entityId: id, summary: `${existing ? 'Re-added' : 'Added'} ${input.name} as ${input.role}` });
    return { users: await teamFor(me) };
  });

  app.patch('/api/users/:id', async (req) => {
    const me = requireManager(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const input = parse(z.object({
      name: zs.name('Name', 120).optional(), role: z.enum(ROLES).optional(), active: z.boolean().optional(),
      capacityPerDay: capacity, password: z.string().max(200).optional(),
    }), req.body);
    const u = await db.one<{ role: 'owner' | 'manager' | 'writer'; active: boolean; name: string; removed_at: string | null }>(`select role, active, name, removed_at from users where id = $1`, [id]);
    if (!u || u.removed_at) throw notFound('Team member');
    if (isManager(u.role) && (input.role === 'writer' || input.active === false)) await keepAManager(id);
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
      set.temp_password = input.password;
    }
    const keys = Object.keys(set);
    if (keys.length) {
      await db.query(`update users set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1`, [id, ...keys.map((k) => set[k])]);
      if (input.active === false || input.password) await db.query(`delete from sessions where user_id = $1`, [id]);
      await logActivity(db, { actor: me, action: 'user.updated', entityType: 'user', entityId: id, summary: `Updated ${u.name}: ${keys.filter((k) => k !== 'temp_password').map((k) => (k === 'password_hash' ? 'password reset' : k.replace(/_/g, ' '))).join(', ')}` });
    }
    return { users: await teamFor(me) };
  });

  /** What removing someone would affect: their unfinished scripts. */
  app.get('/api/users/:id/open-work', async (req) => {
    requireManager(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const rows = await db.query<{ batch_id: number; title: string; client_name: string; n: number }>(
      `select s.batch_id, b.title, c.name as client_name, count(*) as n from scripts s join batches b on b.id = s.batch_id join clients c on c.id = b.client_id
        where s.assignee_id = $1 and s.removed_at is null and s.status <> 'delivered' and b.archived_at is null
        group by s.batch_id, b.title, c.name order by b.title`, [id],
    );
    return { scripts: rows.reduce((n, r) => n + r.n, 0), batches: rows.map((r) => ({ id: r.batch_id, title: r.title, clientName: r.client_name, scripts: r.n })) };
  });

  // Removing takes someone off the team: they're signed out and can't sign in, their unfinished
  // scripts go to another person or back to unassigned, and their name stays in the history.
  app.post('/api/users/:id/remove', async (req) => {
    const me = requireManager(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const { reassignTo } = parse(z.object({ reassignTo: zs.id.nullable().optional() }), req.body);
    if (id === me.id) throw new HttpError(400, 'You can’t remove yourself');
    const u = await db.one<{ role: 'owner' | 'manager' | 'writer'; name: string; removed_at: string | null }>(`select role, name, removed_at from users where id = $1`, [id]);
    if (!u || u.removed_at) throw notFound('Team member');
    if (isManager(u.role)) await keepAManager(id);
    let target: { id: number; name: string } | null = null;
    if (reassignTo) {
      if (reassignTo === id) throw new HttpError(400, 'Choose someone else to take over their scripts');
      const t = await db.one<{ id: number; name: string }>(`select id, name from users where id = $1 and active and removed_at is null`, [reassignTo]);
      if (!t) throw new HttpError(400, 'Choose an active team member', { reassignTo: 'Choose an active team member' });
      target = t;
    }
    const moved = await db.tx(async (t) => {
      const scripts = await t.query<{ id: number; number: number; batch_id: number; client_id: number; title: string }>(
        `select s.id, s.number, s.batch_id, b.client_id, b.title from scripts s join batches b on b.id = s.batch_id
          where s.assignee_id = $1 and s.removed_at is null and s.status <> 'delivered' order by s.batch_id, s.number for update of s`, [id],
      );
      if (scripts.length) {
        await t.query(`update scripts set assignee_id = $1, version = version + 1, updated_at = now() where id in (${scripts.map((_, i) => `$${i + 2}`).join(',')})`, [target?.id ?? null, ...scripts.map((x) => x.id)]);
      }
      const byBatch = new Map<number, typeof scripts>();
      for (const x of scripts) byBatch.set(x.batch_id, [...(byBatch.get(x.batch_id) ?? []), x]);
      for (const [batchId, list] of byBatch) {
        const nums = compressRanges(list.map((x) => x.number));
        await logActivity(t, {
          actor: me, action: 'scripts.assigned', entityType: 'batch', entityId: batchId, batchId, clientId: list[0].client_id,
          summary: `${u.name} was removed from the team: scripts ${nums} ${target ? `moved to ${target.name}` : 'are now unassigned'}`,
        });
        if (target) await notify(t, [target.id], { type: 'assignment', title: `Assigned · ${list[0].title}`, body: `Scripts ${nums} moved to you from ${u.name}.`, link: batchLink(batchId) }, me.id);
      }
      await t.query(`update users set active = false, removed_at = now(), temp_password = null, updated_at = now() where id = $1`, [id]);
      await t.query(`delete from sessions where user_id = $1`, [id]);
      await logActivity(t, { actor: me, action: 'user.removed', entityType: 'user', entityId: id, summary: `Removed ${u.name} from the team${scripts.length ? ` (${scripts.length} unfinished scripts ${target ? `moved to ${target.name}` : 'unassigned'})` : ''}` });
      return scripts.length;
    });
    return { moved, users: await teamFor(me) };
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
