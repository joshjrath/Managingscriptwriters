// The site has moved to Timeliner (ONLY_SIGN_IN, Ctx.onlySignIn): only the owner's email can sign in, everyone
// else's session counts as signed out, and setup is refused. Without the setting nothing changes.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import type { Db } from '../server/db';
import type { Ctx } from '../server/core';
import { onlySignIn } from '../server/config';
import { freshDb } from './db';

let db: Db;
let ctx: Ctx;
let app: FastifyInstance;
let writer = '';

const json = (url: string, body: unknown, cookie?: string) =>
  app.inject({ method: 'POST', url, headers: { 'x-scale-media': '1', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, payload: JSON.stringify(body) });
const get = (url: string, cookie: string) => app.inject({ method: 'GET', url, headers: { 'x-scale-media': '1', cookie } });
const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0];

beforeAll(async () => {
  db = await freshDb();
  ctx = { db, now: () => new Date('2026-11-15T16:00:00Z'), secureCookies: false, allowSetup: true, uploadLimitBytes: 1024 * 1024 };
  app = await buildApp(ctx);
  const admin = cookieOf(await json('/api/auth/setup', { name: 'Josh', email: 'owner@scale.test', password: 'admin-password-1' }));
  await json('/api/users', { name: 'Wes Writer', email: 'wes@scale.test', role: 'writer', password: 'team-password-1' }, admin);
  writer = cookieOf(await json('/api/auth/login', { email: 'wes@scale.test', password: 'team-password-1' }));
  ctx.onlySignIn = 'owner@scale.test';
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('only the owner can sign in', () => {
  it('defaults to the owner on a host, nobody locally, and off turns it off', () => {
    expect(onlySignIn(undefined, true)).toBe('joshrath@scalemedia.com');
    expect(onlySignIn(undefined, false)).toBeUndefined();
    expect(onlySignIn('off', true)).toBeUndefined();
    expect(onlySignIn(' Me@X.com ', true)).toBe('me@x.com');
  });

  it('refuses anyone else, even with the right password, and ends their session', async () => {
    const r = await json('/api/auth/login', { email: 'wes@scale.test', password: 'team-password-1' });
    expect(r.statusCode).toBe(403);
    expect(r.body).toMatch(/Timeliner/);
    expect((await get('/api/bootstrap', writer)).statusCode).toBe(401);
    const status = JSON.parse((await get('/api/auth/status', writer)).body);
    expect(status).toMatchObject({ signedIn: false, closed: true });
  });

  it('lets the owner in', async () => {
    const r = await json('/api/auth/login', { email: 'OWNER@scale.test', password: 'admin-password-1' });
    expect(r.statusCode).toBe(200);
    expect((await get('/api/bootstrap', cookieOf(r))).statusCode).toBe(200);
  });
});
