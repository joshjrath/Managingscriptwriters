// Control Center access. Hiding the link is only an aesthetic choice: the
// world is served only to a sign-in that has been cleared for it.
//
// Clearance uses the existing accounts. Only admins get in: an admin re-enters
// their own password (or signs in with it, when they arrive signed out), and their
// session is cleared for CLEARANCE_HOURS. It's checked on every request,
// ends when they sign out or lock it, and nothing secret ever reaches the page.
// To replace this with another identity provider, swap `verifyOperator`.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db';
import type { Ctx } from '../core';
import { loadSettings } from '../core';
import {
  checkThrottle, clearFailures, createSession, recordFailure, SESSION_COOKIE, setSessionCookie, sha, verifyPassword,
} from '../auth';
import { auditEvent } from '../audit';
import { HttpError, parse } from '../http';
import { callsignOf, type ControlStatus, type ControlWorld } from '../../shared/control';
import { simulatedWorld } from './simulated';
import { isAdmin } from './access';
import { workspaceWorld } from './workspace';

export const CLEARANCE_HOURS = 12;

/** Where the world comes from: the real workspace, or (only when set on the server) the simulated network. */
export type ControlData = 'simulated' | 'workspace';

const SIM_START = Date.now();

export async function loadWorld(ctx: Ctx): Promise<ControlWorld> {
  const at = ctx.now();
  if (ctx.controlData !== 'simulated') return workspaceWorld(ctx.db, at);
  // deadlines run on a 12-hour cycle from when the server started, so they tick down between refreshes
  const cycle = 12 * 3_600_000;
  const epoch = new Date(SIM_START + Math.floor((at.getTime() - SIM_START) / cycle) * cycle);
  return simulatedWorld(at, (await loadSettings(ctx.db)).orgName, epoch);
}

interface Operator { id: number; name: string; role: 'owner' | 'manager' | 'writer'; active: boolean }

/** Checks an operator's password; the one place to swap in another identity check. */
async function verifyOperator(db: Db, who: { id: number } | { email: string }, password: string): Promise<Operator | null> {
  const u = 'id' in who
    ? await db.one<Operator & { password_hash: string }>(`select id, name, role, password_hash, active and removed_at is null as active from users where id = $1`, [who.id])
    : await db.one<Operator & { password_hash: string }>(`select id, name, role, password_hash, active and removed_at is null as active from users where lower(email) = $1`, [who.email]);
  // same work whether or not the account exists, so timing doesn't reveal it
  const ok = u ? await verifyPassword(password, u.password_hash) : await verifyPassword(password, 'scrypt$AAAA$AAAA');
  return u && ok ? { id: u.id, name: u.name, role: u.role, active: u.active } : null;
}

export function registerControlRoutes(app: FastifyInstance, ctx: Ctx) {
  // sign-ins live on the real workspace, even in Recording mode
  const sessions = () => ctx.realDb ?? ctx.db;

  async function clearedUntil(req: FastifyRequest): Promise<string | null> {
    const token = req.cookies[SESSION_COOKIE];
    if (!token || !req.realUser || !isAdmin(req.realUser.role)) return null;
    const r = await sessions().one<{ until: string | null }>(`select control_until as until from sessions where token_hash = $1`, [sha(token)]);
    return r?.until && new Date(r.until).getTime() > ctx.now().getTime() ? r.until : null;
  }

  app.get('/api/control/status', async (req): Promise<ControlStatus> => {
    const real = req.realUser;
    const until = await clearedUntil(req);
    const settings = await loadSettings(ctx.db);
    return {
      signedIn: !!real,
      eligible: !!real && isAdmin(real.role),
      cleared: !!until,
      clearedUntil: until,
      operator: real ? { name: real.name, callsign: callsignOf(real.name) } : null,
      demo: settings.isDemo,
    };
  });

  app.post('/api/control/authorize', async (req, reply) => {
    const input = parse(z.object({
      email: z.string().trim().toLowerCase().email('Enter your email').max(200).optional(),
      password: z.string().min(1, 'Enter your key').max(200),
    }), req.body);
    const real = req.realUser;
    if (!real && !input.email) throw new HttpError(400, 'Identify yourself first', { email: 'Enter your email' });
    const key = `control|${req.ip}|${real ? `#${real.id}` : input.email}`;
    try {
      checkThrottle(key);
    } catch {
      throw new HttpError(429, 'Channel locked. Try again in 15 minutes.', undefined, 'throttled');
    }
    const op = await verifyOperator(sessions(), real ? { id: real.id } : { email: input.email! }, input.password);
    if (!op || !op.active) {
      recordFailure(key);
      await auditEvent(sessions(), { userId: real?.id ?? null, kind: 'auth', summary: `Failed Control Center authorization${real ? '' : ` for ${input.email}`}`, ip: req.ip });
      throw new HttpError(401, 'Key rejected', undefined, 'rejected');
    }
    clearFailures(key);
    if (!isAdmin(op.role)) {
      await auditEvent(sessions(), { userId: op.id, kind: 'denied', summary: 'Tried to open the Control Center — only admins can', ip: req.ip });
      throw new HttpError(403, 'Clearance is limited to admins', undefined, 'clearance');
    }
    let token = req.cookies[SESSION_COOKIE];
    if (!real || !token) {
      token = await createSession(sessions(), op.id);
      setSessionCookie(reply, token, ctx.secureCookies);
      await auditEvent(sessions(), { userId: op.id, kind: 'auth', summary: 'Signed in (Control Center)', ip: req.ip });
    }
    const until = new Date(ctx.now().getTime() + CLEARANCE_HOURS * 3_600_000).toISOString();
    await sessions().query(`update sessions set control_until = $2 where token_hash = $1`, [sha(token), until]);
    await auditEvent(sessions(), { userId: op.id, kind: 'auth', summary: 'Opened the Control Center', ip: req.ip });
    return { ok: true, clearedUntil: until };
  });

  app.get('/api/control/world', async (req): Promise<ControlWorld> => {
    if (!req.realUser) throw new HttpError(403, 'Control Center locked', undefined, 'control_locked');
    if (!(await clearedUntil(req))) throw new HttpError(403, 'Control Center locked', undefined, 'control_locked');
    return loadWorld(ctx);
  });

  app.post('/api/control/lock', async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await sessions().query(`update sessions set control_until = null where token_hash = $1`, [sha(token)]);
    return { ok: true };
  });
}
