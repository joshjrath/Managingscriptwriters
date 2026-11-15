// The site is closing and submissions go through Timeliner (VIEW_ONLY, Ctx.viewOnly): anyone but an Admin can only
// look. Their changes are refused on the server (403 `view_only`), while signing in and out, their own password and
// marking things read still work. Admins carry on as before. Without the setting nothing changes.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import type { Db } from '../server/db';
import type { Ctx } from '../server/core';
import type { Bootstrap } from '../shared/types';
import { VIEW_ONLY } from '../shared/types';
import { isViewOnly, isWriterOnly } from '../shared/workflow';
import { freshDb } from './db';

let db: Db;
let ctx: Ctx;
let app: FastifyInstance;
let admin = '';
let manager = '';
let writer = '';
let writerId = 0;
let clientId = 0;

const send = async (method: string, url: string, cookie: string, body?: unknown) => {
  const r = await app.inject({
    method: method as 'POST', url, headers: { 'x-scale-media': '1', cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};

beforeAll(async () => {
  db = await freshDb();
  // set up the team with changes allowed, then close the site
  ctx = { db, now: () => new Date('2026-11-15T16:00:00Z'), secureCookies: false, allowSetup: true, uploadLimitBytes: 1024 * 1024 };
  app = await buildApp(ctx);
  const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0];
  const json = (url: string, body: unknown, cookie?: string) =>
    app.inject({ method: 'POST', url, headers: { 'x-scale-media': '1', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, payload: JSON.stringify(body) });
  admin = cookieOf(await json('/api/auth/setup', { name: 'Ada Admin', email: 'ada@scale.test', password: 'admin-password-1' }));
  for (const [name, email, role] of [['Max Manager', 'max@scale.test', 'manager'], ['Wes Writer', 'wes@scale.test', 'writer']]) {
    const added = JSON.parse((await json('/api/users', { name, email, role, password: 'team-password-1' }, admin)).body);
    if (role === 'writer') writerId = added.users.find((u: { email: string }) => u.email === email).id;
  }
  manager = cookieOf(await json('/api/auth/login', { email: 'max@scale.test', password: 'team-password-1' }));
  writer = cookieOf(await json('/api/auth/login', { email: 'wes@scale.test', password: 'team-password-1' }));
  clientId = JSON.parse((await json('/api/clients', { name: 'Acme' }, admin)).body).clientId;
  ctx.viewOnly = true;
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('the view-only site', () => {
  it('only Admins can change things; writers have only their due work and the calendar', () => {
    expect(isViewOnly('owner')).toBe(false);
    for (const r of ['manager', 'writer', 'editor'] as const) expect(isViewOnly(r)).toBe(true);
    expect(isWriterOnly('writer')).toBe(true);
    for (const r of ['owner', 'manager', 'editor'] as const) expect(isWriterOnly(r)).toBe(false);
  });

  it('refuses every change from a manager or writer, and says why', async () => {
    const shoot = { clientId, startDate: '2026-11-20', endDate: null, batch: { targetCount: 2, split: [{ writerId, count: 2 }], briefingIds: [], priority: 'normal' } };
    const byManager = await send('POST', '/api/shoots', manager, shoot);
    expect(byManager.status).toBe(403);
    expect(byManager.body.error.code).toBe(VIEW_ONLY);
    expect(byManager.body.error.message).toMatch(/Timeliner/);
    const byWriter = await send('PATCH', `/api/clients/${clientId}`, writer, { name: 'Renamed' });
    expect(byWriter.status).toBe(403);
    expect(byWriter.body.error.code).toBe(VIEW_ONLY);
    // nothing was made
    const count = await db.one<{ n: number }>(`select count(*)::int as n from shoots`);
    expect(count?.n).toBe(0);
  });

  it('still lets them look, sign out and mark things read, and tells the page', async () => {
    const boot = await send('GET', '/api/bootstrap', writer);
    expect(boot.status).toBe(200);
    expect((boot.body as Bootstrap).viewOnly).toBe(true);
    expect((await send('GET', '/api/my-work', writer)).status).toBe(200);
    expect((await send('POST', '/api/notifications/read', writer, {})).status).toBe(200);
    expect((await send('POST', '/api/auth/logout', manager)).status).toBe(200);
  });

  it('lets an Admin carry on as before', async () => {
    const shoot = await send('POST', '/api/shoots', admin, { clientId, startDate: '2026-11-20', endDate: null, batch: { targetCount: 2, split: [{ writerId, count: 2 }], briefingIds: [], priority: 'normal' } });
    expect(shoot.status).toBe(200);
  });

  it('changes nothing when the site isn’t view-only', async () => {
    ctx.viewOnly = false;
    try {
      const boot = await send('GET', '/api/bootstrap', writer);
      expect((boot.body as Bootstrap).viewOnly).toBe(false);
      expect((await send('PATCH', `/api/clients/${clientId}`, writer, { name: 'Renamed' })).body?.error?.code).not.toBe(VIEW_ONLY);
    } finally { ctx.viewOnly = true; }
  });
});
