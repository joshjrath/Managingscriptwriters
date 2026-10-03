// Password hashing (scrypt), database-backed sessions, and request guards.
// The session cookie carries a random token; only its SHA-256 is stored.

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from './db';
import type { Me } from '../shared/types';
import { HttpError } from './http';
import { isAdmin, isManager } from '../shared/workflow';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const SESSION_COOKIE = 'sm_session';
const SESSION_DAYS = 30;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export function validatePassword(pw: string): string | null {
  if (pw.length < 10) return 'Use at least 10 characters';
  if (pw.length > 200) return 'Use at most 200 characters';
  return null;
}

export const sha = (token: string) => createHash('sha256').update(token).digest('hex');

export async function createSession(db: Db, userId: number): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + ($3 || ' days')::interval)`,
    [sha(token), userId, String(SESSION_DAYS)],
  );
  return token;
}

export async function destroySession(db: Db, token: string | undefined): Promise<void> {
  if (token) await db.query(`delete from sessions where token_hash = $1`, [sha(token)]);
}

interface UserRow {
  id: number;
  name: string;
  email: string;
  role: 'owner' | 'manager' | 'writer';
  capacity_per_day: number | null;
  active: boolean;
  last_seen_at: string;
}

export async function userForToken(db: Db, token: string | undefined): Promise<Me | null> {
  if (!token) return null;
  const row = await db.one<UserRow>(
    `select u.id, u.name, u.email, u.role, u.capacity_per_day, u.active, s.last_seen_at
       from sessions s join users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now()`,
    [sha(token)],
  );
  if (!row || !row.active) return null;
  // refresh last-seen at most every 10 minutes
  if (Date.now() - new Date(row.last_seen_at).getTime() > 600_000) {
    await db.query(`update sessions set last_seen_at = now() where token_hash = $1`, [sha(token)]);
  }
  return { id: row.id, name: row.name, email: row.email, role: row.role, capacityPerDay: row.capacity_per_day };
}

declare module 'fastify' {
  interface FastifyRequest {
    user: Me | null;
  }
}

export function requireUser(req: FastifyRequest): Me {
  if (!req.user) throw new HttpError(401, 'Please sign in');
  return req.user;
}

export function requireManager(req: FastifyRequest): Me {
  const me = requireUser(req);
  if (!isManager(me.role)) throw new HttpError(403, 'Only managers can do this');
  return me;
}

export function requireAdmin(req: FastifyRequest, message = 'Only admins can do this'): Me {
  const me = requireUser(req);
  if (!isAdmin(me.role)) throw new HttpError(403, message);
  return me;
}

export function setSessionCookie(reply: FastifyReply, token: string, secure: boolean) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/', httpOnly: true, sameSite: 'lax', secure, maxAge: SESSION_DAYS * 86400,
  });
}

// ── sign-in throttling (per process) ─────────────────────────────────────
// Wrong passwords are counted per address and account (8 in 15 minutes) and
// per account from any address (30): the address comes from a proxy header
// and can be forged, the account can't. Used by sign-in and Control Center
// clearance, which check the same passwords.

const WINDOW_MS = 15 * 60_000;
const LIMIT = { address: 8, account: 30 };
const MAX_ENTRIES = 5_000;
type Counters = Map<string, { count: number; until: number }>;
const byAddress: Counters = new Map();
const byAccount: Counters = new Map();

const over = (map: Counters, key: string, limit: number) => {
  const a = map.get(key);
  return !!a && a.until > Date.now() && a.count >= limit;
};

function count(map: Counters, key: string) {
  const now = Date.now();
  if (map.size >= MAX_ENTRIES) {
    for (const [k, v] of map) if (v.until < now) map.delete(k);
    // still full: forget the oldest, never everything at once
    for (const k of map.keys()) { if (map.size < MAX_ENTRIES) break; map.delete(k); }
  }
  const a = map.get(key);
  if (!a || a.until < now) map.set(key, { count: 1, until: now + WINDOW_MS });
  else a.count++;
}

/** `account` is whatever identifies who is being signed in to: an email, or `#id` for a signed-in person. */
export function checkThrottle(ip: string, account: string): void {
  if (over(byAddress, `${ip}|${account}`, LIMIT.address) || over(byAccount, account, LIMIT.account)) {
    throw new HttpError(429, 'Too many sign-in attempts. Try again in 15 minutes.');
  }
}

export function recordFailure(ip: string, account: string): void {
  count(byAddress, `${ip}|${account}`);
  count(byAccount, account);
}

/** After a successful sign-in. The account-wide count stays, so someone else's guesses aren't forgiven. */
export function clearFailures(ip: string, account: string): void {
  byAddress.delete(`${ip}|${account}`);
}
