// Password hashing (scrypt), database-backed sessions, and request guards.
// The session cookie carries a random token; only its SHA-256 is stored.

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from './db';
import type { Me } from '../shared/types';
import { HttpError } from './http';
import { isManager } from '../shared/workflow';

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

export function setSessionCookie(reply: FastifyReply, token: string, secure: boolean) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/', httpOnly: true, sameSite: 'lax', secure, maxAge: SESSION_DAYS * 86400,
  });
}

// ── login throttling (per process) ───────────────────────────────────────

const attempts = new Map<string, { count: number; until: number }>();
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 8;

export function checkThrottle(key: string): void {
  const a = attempts.get(key);
  if (a && a.until > Date.now() && a.count >= MAX_ATTEMPTS) {
    throw new HttpError(429, 'Too many sign-in attempts. Try again in 15 minutes.');
  }
}

export function recordFailure(key: string): void {
  // forget expired entries so failed sign-ins from many addresses can't grow this without limit
  if (attempts.size > 500) for (const [k, v] of attempts) if (v.until < Date.now()) attempts.delete(k);
  if (attempts.size > 5_000) attempts.clear();
  const a = attempts.get(key);
  if (!a || a.until < Date.now()) attempts.set(key, { count: 1, until: Date.now() + WINDOW_MS });
  else a.count++;
}

export function clearFailures(key: string): void {
  attempts.delete(key);
}
