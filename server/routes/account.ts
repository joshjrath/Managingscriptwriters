// Sign-in, first-run setup, team management, organisation settings and notifications.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  checkThrottle, clearFailures, createSession, destroySession, hashPassword, recordFailure, requireAdmin, requireManager, requireUser,
  SESSION_COOKIE, setSessionCookie, sha, validatePassword, verifyPassword,
} from '../auth';
import { assigneesOf, batchLink, loadSettings, loadUsers, logActivity, notify, rulesOf, settingsFor, type Ctx } from '../core';
import { compressRanges, isAdmin, isEditor, isManager, ROLE_LABEL, type Role } from '../../shared/workflow';
import { auditEvent } from '../audit';
import { LOCKS, type Db } from '../db';
import type { Me, Settings, UserSummary } from '../../shared/types';
import { conflict, forbidden, HttpError, notFound, parse, zs } from '../http';
import { computeDeadlines, isValidTimeZone } from '../../shared/dates';
import { findCity, shiftOf, zoneFor } from '../../shared/cities';
import { fmtDate } from '../../shared/format';
import type { Notification } from '../../shared/types';
import { ACCENTS, darkTextContrast, HEX, MIN_ACCENT_CONTRAST, PALETTES, resolveTheme, SURFACES, type Accent, type WorkspaceTheme } from '../../shared/palettes';

const PLACE_KEYS = new Set(['city', 'city_code', 'country', 'lat', 'lon', 'timezone']);
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
      theme: settings.theme,
    };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const input = parse(z.object({ email, password }), req.body);
    checkThrottle(req.ip, input.email);
    const u = await db.one<{ id: number; password_hash: string; active: boolean }>(`select id, password_hash, active and removed_at is null as active from users where lower(email) = $1`, [input.email]);
    const ok = u ? await verifyPassword(input.password, u.password_hash) : await verifyPassword(input.password, 'scrypt$AAAA$AAAA');
    if (!u || !ok || !u.active) {
      recordFailure(req.ip, input.email);
      await auditEvent(db, { userId: u?.id ?? null, kind: 'auth', summary: u ? (ok ? 'Tried to sign in to a deactivated account' : 'Failed sign-in (wrong password)') : `Failed sign-in for unknown email ${input.email}`, ip: req.ip });
      throw new HttpError(401, u && ok && !u.active ? 'This account has been deactivated' : 'Email or password is incorrect');
    }
    clearFailures(req.ip, input.email);
    await auditEvent(db, { userId: u.id, kind: 'auth', summary: 'Signed in', ip: req.ip });
    const token = await createSession(db, u.id);
    setSessionCookie(reply, token, ctx.secureCookies);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await destroySession(db, req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    // the person actually signed in, not whoever they were viewing as; and a
    // failed log entry must never leave them signed in
    const who = req.realUser ?? req.user;
    if (who) await auditEvent(db, { userId: who.id, kind: 'auth', summary: 'Signed out', ip: req.ip }).catch((err: unknown) => req.log.warn({ err }, 'master log write failed'));
    return { ok: true };
  });

  // First run only: creates the first manager when there are no users yet.
  app.post('/api/auth/setup', async (req, reply) => {
    if (!ctx.allowSetup) throw new HttpError(403, 'Setup from the browser is disabled here. Set MANAGER_EMAIL and MANAGER_PASSWORD on the server instead.');
    const input = parse(z.object({
      name: zs.name('Name', 120), email, password,
      // the basics, asked once: the organisation's name, its HQ time zone and when deadlines end each day
      orgName: z.string().trim().min(1, 'Enter your organisation’s name').max(120).optional(),
      timezone: z.string().trim().refine(isValidTimeZone, 'Pick a time zone from the list').optional(),
      cutoff: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 17:00').optional(),
    }), req.body);
    const pwErr = validatePassword(input.password);
    if (pwErr) throw new HttpError(400, pwErr, { password: pwErr });
    const id = await db.tx(async (t) => {
      // one setup at a time: two at once would both see no users and both create an admin
      await t.query(`select pg_advisory_xact_lock(${LOCKS.setup})`);
      const n = await t.one<{ n: number }>(`select count(*) as n from users`);
      if ((n?.n ?? 0) > 0) throw conflict('Setup has already been completed');
      const row = await t.one<{ id: number }>(
        `insert into users (email, name, role, password_hash, timezone) values ($1, $2, 'owner', $3, $4) returning id`,
        [input.email, input.name, await hashPassword(input.password), input.timezone ?? null],
      );
      if (input.orgName || input.timezone || input.cutoff) {
        await t.query(`update settings set org_name = coalesce($1, org_name), timezone = coalesce($2, timezone), cutoff = coalesce($3, cutoff) where id = 1`,
          [input.orgName ?? null, input.timezone ?? null, input.cutoff ?? null]);
      }
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
    if (input.next === input.current) throw new HttpError(400, 'Choose a new password, not the one you were given', { next: 'Choose a new password, not the one you were given' });
    await db.query(`update users set password_hash = $2, temp_password = null, updated_at = now() where id = $1`, [me.id, await hashPassword(input.next)]);
    await logActivity(db, { actor: me, action: 'user.password', entityType: 'user', entityId: me.id, summary: 'Changed their own password' });
    const token = req.cookies[SESSION_COOKIE];
    await db.query(`delete from sessions where user_id = $1 and token_hash <> $2`, [me.id, sha(token ?? '')]);
    return { ok: true };
  });

  /** Remembers the newest What's new entry this person has opened, for the "new" dot. */
  app.post('/api/me/whats-new', async (req) => {
    const me = requireUser(req);
    const { seen } = parse(z.object({ seen: z.string().trim().min(1).max(80) }), req.body);
    await db.query(`update users set whats_new_seen = $2 where id = $1`, [me.id, seen]);
    return { ok: true };
  });

  // your own time zone: everything time-of-day on the site shows in it
  app.post('/api/me/timezone', async (req) => {
    const me = requireUser(req);
    const { timezone } = parse(z.object({ timezone: z.string().trim().refine(isValidTimeZone, 'Pick a time zone from the list') }), req.body);
    await db.query(`update users set timezone = $2, timezone_confirmed_at = now(), updated_at = now() where id = $1`, [me.id, timezone]);
    return { timezone: { mine: timezone, confirmed: true } };
  });

  // ── team ───────────────────────────────────────────────────────────────

  const ROLES = ['owner', 'manager', 'writer', 'editor'] as const;
  const MANAGER_ROLES = `role in ('owner', 'manager')`;

  /**
   * The team list. Admins and managers also see temporary passwords that haven't been replaced
   * yet, except an admin's, which only admins see (reading it back would be signing in as them).
   */
  async function teamFor(me: Me): Promise<UserSummary[]> {
    const users = await loadUsers(db);
    if (!isManager(me.role)) return users;
    const temps = new Map((await db.query<{ id: number; temp_password: string }>(`select id, temp_password from users where temp_password is not null and removed_at is null`)).map((r) => [r.id, r.temp_password]));
    // only the Admin sees (and can reset) the Admin's own sign-in details
    return users.map((u) => ({ ...u, tempPassword: isAdmin(u.role) && !isAdmin(me.role) ? null : temps.get(u.id) ?? null }));
  }

  /**
   * The Admin role can only be given, taken away or edited by the Admin. Managers manage the team, but
   * the admin-only tools (Master log, View as, Recording mode, Editors) only mean something
   * if a manager can't become an admin, or sign in as one, on their own.
   */
  function guardAdmin(me: Me, target: { role: Role } | null, nextRole?: Role) {
    if (isAdmin(me.role)) return;
    if (nextRole && isAdmin(nextRole)) throw forbidden('Only the Admin can make someone an Admin');
    if (target && isAdmin(target.role)) throw forbidden('Only the Admin can change the Admin’s account');
  }

  /**
   * Hands someone's unfinished scripts to another person (or leaves them unassigned), with a history
   * line per batch and a notification for whoever takes them. Used when removing or deactivating someone.
   */
  async function moveOpenScripts(t: Parameters<Parameters<typeof db.tx>[0]>[0], me: Me, u: { id: number; name: string }, target: { id: number; name: string } | null, why: string) {
    const scripts = await t.query<{ id: number; number: number; batch_id: number; client_id: number; title: string }>(
      `select s.id, s.number, s.batch_id, b.client_id, b.title from scripts s join batches b on b.id = s.batch_id
        where s.assignee_id = $1 and s.removed_at is null and s.status <> 'delivered' order by s.batch_id, s.number for update of s`, [u.id],
    );
    if (scripts.length) {
      await t.query(`update scripts set assignee_id = $1, assigned_at = case when $1::bigint is null then null else now() end, version = version + 1, updated_at = now() where id in (${scripts.map((_, i) => `$${i + 2}`).join(',')})`, [target?.id ?? null, ...scripts.map((x) => x.id)]);
    }
    const byBatch = new Map<number, typeof scripts>();
    for (const x of scripts) byBatch.set(x.batch_id, [...(byBatch.get(x.batch_id) ?? []), x]);
    for (const [batchId, list] of byBatch) {
      const nums = compressRanges(list.map((x) => x.number));
      await logActivity(t, {
        actor: me, action: 'scripts.assigned', entityType: 'batch', entityId: batchId, batchId, clientId: list[0].client_id,
        summary: `${u.name} ${why}: scripts ${nums} ${target ? `moved to ${target.name}` : 'are now unassigned'}`,
      });
      if (target) await notify(t, [target.id], { type: 'assignment', title: `Assigned · ${list[0].title}`, body: `Scripts ${nums} moved to you from ${u.name}.`, link: batchLink(batchId) }, me.id);
    }
    return scripts.length;
  }

  async function takeoverTarget(reassignTo: number | null | undefined, fromId: number) {
    if (!reassignTo) return null;
    if (reassignTo === fromId) throw new HttpError(400, 'Choose someone else to take over their scripts', { reassignTo: 'Choose someone else' });
    const t = await db.one<{ id: number; name: string }>(`select id, name from users where id = $1 and active and removed_at is null and role <> 'editor'`, [reassignTo]);
    if (!t) throw new HttpError(400, 'Choose an active team member', { reassignTo: 'Choose an active team member' });
    return t;
  }

  async function keepAManager(excludeId: number) {
    const others = await db.one<{ n: number }>(`select count(*) as n from users where ${MANAGER_ROLES} and active and removed_at is null and id <> $1`, [excludeId]);
    if (!others?.n) throw new HttpError(400, 'Keep at least one active admin or manager');
  }

  async function keepAnAdmin(excludeId: number) {
    const others = await db.one<{ n: number }>(`select count(*) as n from users where role = 'owner' and active and removed_at is null and id <> $1`, [excludeId]);
    if (!others?.n) throw new HttpError(400, 'Keep at least one active admin');
  }

  app.get('/api/users', async (req) => {
    return { users: await teamFor(requireUser(req)) };
  });

  const capacity = z.coerce.number().positive('Use a positive number').max(50).nullable().optional();
  const city = z.string().trim().max(120).nullable().optional();
  const timezone = z.string().trim().refine(isValidTimeZone, 'Pick a time zone from the list').optional();
  const hour = z.coerce.number().int().min(0).max(47);

  /** Where someone works from and their hours, as columns; a city must come from the list. */
  /** The time zone follows the city unless one is chosen; a chosen one is kept while the city stays the same. */
  function placeColumns(
    input: { city?: string | null; timezone?: string; workStart?: number; workEnd?: number },
    current?: { city: string | null; country: string | null; timezone: string | null } | null,
  ): Record<string, unknown> {
    const set: Record<string, unknown> = {};
    if (input.city !== undefined) {
      // clearing the city keeps their time zone: people can set that themselves without a city
      if (!input.city) Object.assign(set, { city: null, city_code: null, country: null, lat: null, lon: null, timezone: input.timezone ?? current?.timezone ?? null });
      else {
        const c = findCity(input.city);
        if (!c) throw new HttpError(400, 'Pick a city from the list', { city: 'Pick a city from the list' });
        Object.assign(set, { city: c.name, city_code: c.code, country: c.country, lat: c.lat, lon: c.lon, timezone: zoneFor(c, input.timezone, current) });
      }
    } else if (input.timezone !== undefined) {
      set.timezone = input.timezone;
    }
    if (input.workStart !== undefined || input.workEnd !== undefined) {
      const start = input.workStart ?? 9;
      if (start > 23) throw new HttpError(400, 'Pick a start time', { workStart: 'Pick a start time' });
      const [, end] = shiftOf(start, input.workEnd ?? 18);
      Object.assign(set, { work_start: start, work_end: end });
    }
    return set;
  }

  app.post('/api/users', async (req) => {
    const me = requireManager(req);
    const input = parse(z.object({
      name: zs.name('Name', 120), email, role: z.enum(ROLES), password, capacityPerDay: capacity,
      city, timezone, workStart: hour.optional(), workEnd: hour.optional(),
    }), req.body);
    guardAdmin(me, null, input.role);
    const place = placeColumns(input);
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
    const placeKeys = Object.keys(place);
    if (placeKeys.length) await db.query(`update users set ${placeKeys.map((k, i) => `${k} = $${i + 2}`).join(', ')} where id = $1`, [id, ...placeKeys.map((k) => place[k])]);
    await logActivity(db, { actor: me, action: 'user.created', entityType: 'user', entityId: id, summary: `${existing ? 'Re-added' : 'Added'} ${input.name} as ${ROLE_LABEL[input.role]}` });
    return { users: await teamFor(me) };
  });

  app.patch('/api/users/:id', async (req) => {
    const me = requireManager(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const input = parse(z.object({
      name: zs.name('Name', 120).optional(), email: email.optional(), role: z.enum(ROLES).optional(), active: z.boolean().optional(),
      capacityPerDay: capacity, password: z.string().max(200).optional(),
      city, timezone, workStart: hour.optional(), workEnd: hour.optional(),
      /** when deactivating: who takes over their unfinished scripts (null leaves them unassigned) */
      reassignTo: zs.id.nullable().optional(),
    }), req.body);
    const u = await db.one<{ role: Role; active: boolean; name: string; email: string; removed_at: string | null; city: string | null; country: string | null; timezone: string | null; capacity_per_day: number | null; work_start: number | null; work_end: number | null }>(
      `select role, active, name, email, removed_at, city, country, timezone, capacity_per_day, work_start, work_end from users where id = $1`, [id],
    );
    if (!u || u.removed_at) throw notFound('Team member');
    guardAdmin(me, u, input.role);
    // the form sends every field, so only an actual change of role counts
    const roleChange = input.role !== undefined && input.role !== u.role;
    if (isAdmin(u.role) && (roleChange || input.active === false)) await keepAnAdmin(id);
    if (isManager(u.role) && ((input.role && !isManager(input.role)) || input.active === false)) await keepAManager(id);
    // an editor writes nothing: move their unfinished scripts first
    if (input.role && isEditor(input.role) && !isEditor(u.role)) {
      const open = await db.one<{ n: number }>(`select count(*)::int as n from scripts where assignee_id = $1 and removed_at is null and status <> 'delivered'`, [id]);
      if (open && Number(open.n) > 0) throw new HttpError(400, `${u.name} still has ${open.n} unfinished script${Number(open.n) === 1 ? '' : 's'}. Reassign them before making ${u.name.split(' ')[0]} an editor.`, { role: 'Reassign their scripts first' });
    }
    if (input.active === false && id === me.id) throw new HttpError(400, 'You can’t deactivate your own account');
    const deactivating = input.active === false && u.active;
    const target = deactivating ? await takeoverTarget(input.reassignTo, id) : null;
    const set: Record<string, unknown> = {};
    if (input.name !== undefined && input.name !== u.name) set.name = input.name;
    if (input.email !== undefined && input.email !== u.email) {
      const taken = await db.one<{ id: number }>(`select id from users where lower(email) = $1 and id <> $2 and removed_at is null`, [input.email, id]);
      if (taken) throw new HttpError(409, 'Someone else on the team already uses that email', { email: 'Already used by someone else' });
      set.email = input.email;
    }
    if (input.role !== undefined && input.role !== u.role) set.role = input.role;
    if (input.active !== undefined && input.active !== u.active) set.active = input.active;
    if (input.capacityPerDay !== undefined && Number(input.capacityPerDay ?? 0) !== Number(u.capacity_per_day ?? 0)) set.capacity_per_day = input.capacityPerDay;
    const place = placeColumns(input, u);
    if (place.city !== undefined && place.city === u.city) for (const k of PLACE_KEYS) if (k !== 'timezone') delete place[k];
    if (place.timezone !== undefined && place.timezone === u.timezone) delete place.timezone;
    if (place.work_start !== undefined && place.work_start === u.work_start && place.work_end === u.work_end) { delete place.work_start; delete place.work_end; }
    Object.assign(set, place);
    if (input.password) {
      const err = validatePassword(input.password);
      if (err) throw new HttpError(400, err, { password: err });
      set.password_hash = await hashPassword(input.password);
      set.temp_password = input.password;
    }
    const keys = Object.keys(set);
    let moved = 0;
    if (keys.length) {
      await db.tx(async (t) => {
        await t.query(`update users set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1`, [id, ...keys.map((k) => set[k])]);
        if (input.active === false || input.password) await t.query(`delete from sessions where user_id = $1`, [id]);
        if (deactivating) moved = await moveOpenScripts(t, me, { id, name: u.name }, target, 'was deactivated');
        // say what changed, in words
        const what: string[] = [];
        if (set.name !== undefined) what.push(`name ${u.name} → ${input.name}`);
        if (set.email !== undefined) what.push(`email → ${input.email}`);
        if (set.role !== undefined) what.push(`role ${ROLE_LABEL[u.role]} → ${ROLE_LABEL[input.role!]}`);
        if (set.active === false) what.push(`deactivated${moved ? ` (${moved} unfinished scripts ${target ? `moved to ${target.name}` : 'unassigned'})` : ''}`);
        if (set.active === true) what.push('reactivated');
        if (set.capacity_per_day !== undefined) what.push(`capacity ${u.capacity_per_day ?? 'not set'} → ${input.capacityPerDay ?? 'not set'} a day`);
        if (keys.some((k) => PLACE_KEYS.has(k) && k !== 'timezone')) what.push(`city → ${set.city ?? 'none'}`);
        else if (set.timezone !== undefined) what.push(`time zone → ${set.timezone}`);
        if (keys.some((k) => k.startsWith('work_'))) what.push('working hours');
        if (set.password_hash) what.push('password reset (signed out)');
        await logActivity(t, { actor: me, action: 'user.updated', entityType: 'user', entityId: id, summary: `${u.name}: ${what.join(', ')}` });
      });
    }
    return { users: await teamFor(me), moved };
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
    const u = await db.one<{ role: Role; name: string; removed_at: string | null }>(`select role, name, removed_at from users where id = $1`, [id]);
    if (!u || u.removed_at) throw notFound('Team member');
    guardAdmin(me, u);
    if (isManager(u.role)) await keepAManager(id);
    if (isAdmin(u.role)) await keepAnAdmin(id);
    const target = await takeoverTarget(reassignTo, id);
    const moved = await db.tx(async (t) => {
      const n = await moveOpenScripts(t, me, { id, name: u.name }, target, 'was removed from the team');
      await t.query(`update users set active = false, removed_at = now(), temp_password = null, updated_at = now() where id = $1`, [id]);
      await t.query(`delete from sessions where user_id = $1`, [id]);
      await logActivity(t, { actor: me, action: 'user.removed', entityType: 'user', entityId: id, summary: `Removed ${u.name} from the team${n ? ` (${n} unfinished scripts ${target ? `moved to ${target.name}` : 'unassigned'})` : ''}` });
      return n;
    });
    return { moved, users: await teamFor(me) };
  });

  // ── settings ───────────────────────────────────────────────────────────

  app.get('/api/settings', async (req) => {
    requireUser(req);
    return { settings: await settingsFor(ctx) };
  });

  // the colour palette: the admin's choice, applied to the whole site for everyone
  app.put('/api/settings/theme', async (req) => {
    const me = requireAdmin(req, 'Only the admin can change the colour palette');
    const hex = z.string().regex(HEX, 'Use a colour like #F2A599').refine((v) => darkTextContrast(v) >= MIN_ACCENT_CONTRAST, 'Too dark: dark text on this colour would be hard to read. Pick a lighter shade.');
    const input = parse(z.object({
      preset: z.enum(PALETTES.map((p) => p.id) as [string, ...string[]], { message: 'Choose one of the palettes' }),
      surfaces: z.enum(SURFACES).optional(),
      colors: z.object(Object.fromEntries(ACCENTS.map((k) => [k, hex.optional()])) as Record<Accent, z.ZodOptional<typeof hex>>).optional(),
    }), req.body);
    const r = resolveTheme(input);
    // keep only what differs from the preset, so presets stay clean
    const colors = Object.fromEntries(ACCENTS.filter((k) => r.colors[k] !== r.palette.colors[k]).map((k) => [k, r.colors[k]]));
    const theme: WorkspaceTheme = { preset: r.palette.id, ...(r.surfaces !== r.palette.surfaces ? { surfaces: r.surfaces } : {}), ...(Object.keys(colors).length ? { colors } : {}) };
    await db.tx(async (t) => {
      await t.query(`update settings set theme = $1::jsonb, updated_at = now() where id = 1`, [JSON.stringify(theme)]);
      await logActivity(t, { actor: me, action: 'settings.theme', entityType: 'settings', summary: `Changed the colour palette to ${r.palette.name}${r.custom ? ' (customised)' : ''}` });
    });
    return { settings: await settingsFor(ctx) };
  });

  const rulesInput = {
    draftOffsetDays: z.coerce.number({ message: 'Enter a number of days' }).int('Use whole days').min(0, 'Use 0 or more days').max(60, 'Use 60 days or fewer').optional(),
    finalOffsetDays: z.coerce.number({ message: 'Enter a number of days' }).int('Use whole days').min(0, 'Use 0 or more days').max(60, 'Use 60 days or fewer').optional(),
    dayMode: z.enum(['calendar', 'business']).optional(),
    workingDays: z.array(z.number().int().min(0).max(6)).min(1, 'Pick at least one working day').max(7).optional(),
  };
  /** Active batches whose automatic deadlines these rules would change, and the new dates. */
  async function recalcPlan(t: Db, s: Settings) {
    const rows = await t.query<{ id: number; client_id: number; title: string; start_date: string; draft_due: string | null; final_due: string | null; draft_due_mode: string; final_due_mode: string }>(
      `select b.id, b.client_id, b.title, s.start_date, b.draft_due, b.final_due, b.draft_due_mode, b.final_due_mode
         from batches b join shoots s on s.id = b.shoot_id where b.archived_at is null and (b.draft_due_mode = 'auto' or b.final_due_mode = 'auto')`,
    );
    const out: { r: (typeof rows)[number]; nd: string | null; nf: string | null }[] = [];
    for (const r of rows) {
      const d = computeDeadlines(r.start_date, rulesOf(s));
      const nd = r.draft_due_mode === 'auto' ? d.draftDue : r.draft_due;
      const nf = r.final_due_mode === 'auto' ? d.finalDue : r.final_due;
      if (nd !== r.draft_due || nf !== r.final_due) out.push({ r, nd, nf });
    }
    return out;
  }
  const finalAfterDrafts = (draft: number, final: number) =>
    new HttpError(400, `Final delivery can’t come before the drafts. Use ${draft} days or fewer: drafts are due ${draft} days before the shoot.`, { finalOffsetDays: `Use ${draft} or fewer (drafts are due ${draft} days before)` });

  // what applying rules to existing batches would change, before anything is saved
  app.post('/api/settings/recalculate-preview', async (req) => {
    requireManager(req);
    const input = parse(z.object(rulesInput), req.body);
    const before = await loadSettings(db);
    const next = { ...before, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as Settings;
    if (next.finalOffsetDays > next.draftOffsetDays) throw finalAfterDrafts(next.draftOffsetDays, next.finalOffsetDays);
    const plan = await recalcPlan(db, next);
    const writers = plan.length ? await db.query<{ n: number }>(
      `select count(distinct assignee_id)::int as n from scripts where removed_at is null and status <> 'delivered' and assignee_id is not null and batch_id = any($1::bigint[])`, [plan.map((p) => p.r.id)],
    ) : [{ n: 0 }];
    return { batches: plan.length, writers: writers[0]?.n ?? 0 };
  });

  app.patch('/api/settings', async (req) => {
    const me = requireManager(req);
    const input = parse(z.object({
      orgName: zs.name('Organisation name', 120).optional(),
      timezone: z.string().refine(isValidTimeZone, 'Choose a valid timezone').optional(),
      cutoff: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 17:00').optional(),
      ...rulesInput,
      reminderLeadDays: z.coerce.number({ message: 'Enter a number of days' }).int().min(0, 'Use 0 or more days').max(14, 'Use 14 days or fewer').optional(),
      planReminderDays: z.coerce.number({ message: 'Enter a number of days' }).int().min(3, 'Use at least 3 days').max(60, 'Use 60 days or fewer').optional(),
      recalculate: z.boolean().default(false),
    }), req.body);
    const before = await loadSettings(db);
    const draft = input.draftOffsetDays ?? before.draftOffsetDays;
    const final = input.finalOffsetDays ?? before.finalOffsetDays;
    if (final > draft) throw finalAfterDrafts(draft, final);
    const map: Record<string, string> = {
      orgName: 'org_name', timezone: 'timezone', cutoff: 'cutoff', draftOffsetDays: 'draft_offset_days', finalOffsetDays: 'final_offset_days',
      dayMode: 'day_mode', workingDays: 'working_days', reminderLeadDays: 'reminder_lead_days', planReminderDays: 'plan_reminder_days',
    };
    const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const shown = (k: string, v: unknown) => (k === 'workingDays' ? (v as number[]).map((d) => DAY[d]).join(' ') : k === 'dayMode' ? (v === 'business' ? 'working days' : 'calendar days') : String(v));
    const label: Record<string, string> = {
      orgName: 'Organisation name', timezone: 'HQ time zone', cutoff: 'Daily cutoff', draftOffsetDays: 'Drafts due (days before)', finalOffsetDays: 'Final delivery (days before)',
      dayMode: 'Count days as', workingDays: 'Working week', reminderLeadDays: 'Remind writers (days before)', planReminderDays: 'Remind managers to plan (days before)',
    };
    // only what actually changed
    const keys = Object.keys(map).filter((k) => {
      const v = (input as Record<string, unknown>)[k];
      if (v === undefined) return false;
      const was = (before as unknown as Record<string, unknown>)[k];
      return k === 'workingDays' ? [...new Set(v as number[])].sort().join() !== [...(was as number[])].sort().join() : v !== was;
    });
    let recalculated = 0;
    await db.tx(async (t) => {
      if (keys.length) {
        await t.query(
          `update settings set ${keys.map((k, i) => `${map[k]} = $${i + 1}${k === 'workingDays' ? '::jsonb' : ''}`).join(', ')}, updated_at = now() where id = 1`,
          keys.map((k) => (k === 'workingDays' ? JSON.stringify([...new Set(input.workingDays)].sort()) : (input as Record<string, unknown>)[k])),
        );
        await logActivity(t, {
          actor: me, action: 'settings.updated', entityType: 'settings',
          summary: `Settings: ${keys.map((k) => `${label[k]} ${shown(k, (before as unknown as Record<string, unknown>)[k])} → ${shown(k, k === 'workingDays' ? [...new Set(input.workingDays)].sort() : (input as Record<string, unknown>)[k])}`).join(' · ')}`,
        });
      }
      if (input.recalculate) {
        const plan = await recalcPlan(t, await loadSettings(t));
        for (const { r, nd, nf } of plan) {
          recalculated++;
          await t.query(`update batches set draft_due = $2, final_due = $3, updated_at = now() where id = $1`, [r.id, nd, nf]);
          const msg = [nd !== r.draft_due ? `Drafts ${fmtDate(r.draft_due)} → ${fmtDate(nd)}` : null, nf !== r.final_due ? `Final delivery ${fmtDate(r.final_due)} → ${fmtDate(nf)}` : null].filter(Boolean).join(' · ');
          await logActivity(t, { actor: me, action: 'batch.deadlines', entityType: 'batch', entityId: r.id, batchId: r.id, clientId: r.client_id, summary: `Deadline rules changed: ${msg}` });
          await notify(t, await assigneesOf(t, r.id, { undeliveredOnly: true }), { type: 'deadline_change', title: `Deadline changed · ${r.title}`, body: msg, link: batchLink(r.id) }, me.id);
        }
      }
    });
    return { settings: await settingsFor(ctx), recalculated, changed: keys.length };
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
