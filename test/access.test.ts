// Who may call each API route, declared in one table and checked against the
// running server. A route that isn't in ACCESS fails the first test, so every
// new route has to say who can use it; the others prove that anonymous
// callers, writers and managers are refused where they should be (the UI
// hiding a button is never the protection).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import type { Db } from '../server/db';
import type { Ctx } from '../server/core';
import { editorRoutesFor } from '../server/editor-access';
import { EDITOR_KINDS, type EditorKind } from '../shared/workflow';
import { freshDb } from './db';

/**
 * public: no sign-in needed · user: anyone signed in (the route checks ownership itself)
 * manager: admins and managers · admin: admins only
 */
type Access = 'public' | 'user' | 'manager' | 'admin';

const ACCESS: Record<string, Access> = {
  'GET /healthz': 'public',
  'GET /api/auth/status': 'public',
  'POST /api/auth/login': 'public',
  'POST /api/auth/logout': 'public',
  'POST /api/auth/setup': 'public',

  'POST /api/me/password': 'user',
  'POST /api/me/whats-new': 'user',
  'POST /api/me/timezone': 'user',
  'GET /api/users': 'user',
  'GET /api/settings': 'user',
  'GET /api/notifications': 'user',
  'POST /api/notifications/read': 'user',
  'GET /api/bootstrap': 'user',
  'GET /api/shoot-readiness': 'user',
  'POST /api/batches/:id/seen': 'user',
  'GET /api/calendar-feeds': 'manager',
  'POST /api/calendar-feeds': 'manager',
  'PATCH /api/calendar-feeds/:id': 'manager',
  'DELETE /api/calendar-feeds/:id': 'manager',
  'POST /api/calendar-feeds/:id/sync': 'manager',
  'GET /api/calendar-shoots': 'manager',
  'POST /api/calendar-shoots/dismiss': 'manager',
  'GET /api/shoot-forecast': 'manager',
  'POST /api/shoot-forecast/read-documents': 'manager',
  'POST /api/shoot-forecast/estimate': 'manager',
  'POST /api/shoot-forecast/:clientId/change': 'manager',
  'POST /api/shoot-forecast/:clientId/deny': 'manager',
  'POST /api/reviews/:id/undo': 'manager',
  'POST /api/settings/recalculate-preview': 'manager',
  'GET /api/counts': 'user',
  'GET /api/dashboard': 'user',
  'GET /api/calendar': 'user',
  'GET /api/review': 'user',
  'GET /api/my-work': 'user',
  'GET /api/today': 'user',
  'GET /api/batches': 'user',
  'GET /api/batches/:id': 'user',
  'POST /api/batches/:id/blocker': 'user',
  'POST /api/batches/:id/scripts/action': 'user',
  'PATCH /api/scripts/:id': 'user',
  'POST /api/batches/:id/written': 'user',
  'POST /api/batches/:id/submissions': 'user',
  'GET /api/shoots': 'user',
  'GET /api/clients': 'user',
  'GET /api/clients/:id': 'user',
  'GET /api/resources': 'user',
  'POST /api/resources': 'user',
  'POST /api/resources/upload': 'user',
  'DELETE /api/resources/:id': 'user',
  'GET /api/files/:id': 'user',
  'GET /api/search': 'user',
  'GET /api/script-bank': 'user',
  'GET /api/moments': 'user',
  'POST /api/moments/seen': 'user',
  'GET /api/todos': 'user',
  'POST /api/todos': 'user',
  'PATCH /api/todos/:id': 'user',
  'DELETE /api/todos/:id': 'user',
  // their own videos from Timeliner, and saying which one they're on (only ever their own: test/editing.test.ts)
  'GET /api/editing/me': 'user',
  'POST /api/editing/focus': 'user',
  // the scripts PDF of a batch they have a video from (only theirs: test/editing.test.ts)
  'GET /api/editing/script-pdf/:batchId': 'user',
  // Thumbnail Studio: thumbnail designers (their own briefs only) and, for the two reads, managers; writers and video
  // editors are refused (test/thumbnails.test.ts covers whose brief and file is whose)
  'GET /api/studio': 'user',
  // a designer's portfolio and private growth: their own, or a manager's look at one (test/thumbnail-phase4.test.ts)
  'GET /api/studio/portfolio': 'user',
  'GET /api/thumbnails/:id': 'user',
  'POST /api/thumbnails/:id/options': 'user',
  'DELETE /api/thumbnail-options/:id': 'user',
  'POST /api/thumbnails/:id/send': 'user',
  // a designer's AI second look on an option of their own (only its maker: test/thumbnail-feedback.test.ts)
  'POST /api/thumbnail-options/:id/second-look': 'user',
  // a designer's own reference boards: thumbnail designers only, managers refused too (only their own refs, and only
  // they open an uploaded one: test/thumbnail-studio-3.test.ts)
  'GET /api/thumbnail-refs': 'user',
  'POST /api/thumbnail-refs': 'user',
  'PATCH /api/thumbnail-refs/:id': 'user',
  'DELETE /api/thumbnail-refs/:id': 'user',

  'POST /api/users': 'manager',
  'PATCH /api/users/:id': 'manager',
  'GET /api/users/:id/open-work': 'manager',
  'POST /api/users/:id/remove': 'manager',
  'PATCH /api/settings': 'manager',
  'POST /api/batches': 'manager',
  'PATCH /api/batches/:id': 'manager',
  'POST /api/batches/:id/dates-reviewed': 'manager',
  'POST /api/batches/:id/archive': 'manager',
  'GET /api/batches/:id/target-preview': 'manager',
  'POST /api/batches/:id/target': 'manager',
  'POST /api/batches/:id/scripts/assign': 'manager',
  'POST /api/batches/:id/review': 'manager',
  'POST /api/shoots': 'manager',
  'PATCH /api/shoots/:id': 'manager',
  'POST /api/shoots/:id/reschedule-preview': 'manager',
  'POST /api/shoots/:id/reschedule': 'manager',
  'POST /api/clients': 'manager',
  'PATCH /api/clients/:id': 'manager',
  'POST /api/clients/:id/stage': 'manager',
  'POST /api/clients/:id/archive': 'manager',
  'POST /api/clients/:id/briefings': 'manager',
  'PATCH /api/clients/:id/brand': 'manager',
  'PATCH /api/briefings/:id': 'manager',
  'POST /api/script-bank/past': 'manager',
  'DELETE /api/script-bank/past/:id': 'manager',
  'POST /api/import/read': 'manager',
  'POST /api/import/apply': 'manager',
  'GET /api/thumbnails': 'manager',
  'POST /api/thumbnails': 'manager',
  'PATCH /api/thumbnails/:id': 'manager',
  'POST /api/thumbnails/:id/decision': 'manager',
  // marking a picked thumbnail live, and New thumbnail's "Timeliner video" picker (from the site's copy of Timeliner)
  'POST /api/thumbnails/:id/published': 'manager',
  'GET /api/thumbnails/timeliner-videos': 'manager',
  // AI brief ideas in New thumbnail (nothing is saved)
  'POST /api/thumbnails/suggest': 'manager',

  'GET /api/audit': 'admin',
  'PUT /api/settings/theme': 'admin',
  'POST /api/admin/view-as': 'admin',
  'POST /api/admin/view-as/stop': 'admin',
  'POST /api/admin/recording/start': 'admin',
  'POST /api/admin/recording/stop': 'admin',
  'GET /api/editors': 'admin',
  'POST /api/editors': 'admin',
  'PATCH /api/editors/:id': 'admin',
  'DELETE /api/editors/:id': 'admin',

  'GET /api/timeliner': 'manager',
  'POST /api/timeliner/connect': 'manager',
  'POST /api/timeliner/test': 'manager',
  'POST /api/timeliner/events/:id/assign': 'manager',
  'GET /api/editing': 'manager',
  'POST /api/editing/sync': 'manager',
  'POST /api/editing/videos/:id/pin': 'manager',
  'DELETE /api/editing/videos/:id/pin': 'manager',
  // Timeliner calls it; the signature is the protection (test/timeliner.test.ts)
  'POST /hooks/timeliner': 'public',
};

/** Every route the server registers, read from its source (`app.get('/api/…'` and friends). */
function registeredRoutes(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) files.push(p);
    }
  };
  walk(path.resolve(__dirname, '../server'));
  const out: string[] = [];
  for (const f of files) {
    for (const m of readFileSync(f, 'utf8').matchAll(/app\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) out.push(`${m[1].toUpperCase()} ${m[2]}`);
  }
  return out.sort();
}

let db: Db;
let app: FastifyInstance;
let admin = '';
let manager = '';
let writer = '';
/** a signed-in editor of each kind: a video editor and a thumbnail designer */
const editors: Record<EditorKind, string> = { short_form: '', thumbnail: '' };

const call = async (method: string, url: string, cookie?: string) => {
  const headers: Record<string, string> = { 'x-scale-media': '1' };
  if (cookie) headers.cookie = cookie;
  const body = method === 'GET' ? undefined : '{}';
  if (body) headers['content-type'] = 'application/json';
  return (await app.inject({ method: method as 'GET', url, headers, payload: body })).statusCode;
};
const concrete = (route: string) => route.replace(/:[a-zA-Z]+/g, '1');

beforeAll(async () => {
  db = await freshDb();
  const ctx: Ctx = { db, now: () => new Date('2026-09-28T16:00:00Z'), secureCookies: false, allowSetup: true, uploadLimitBytes: 1024 * 1024 };
  app = await buildApp(ctx);
  const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0];
  const json = (method: string, url: string, body: unknown, cookie?: string) =>
    app.inject({ method: method as 'POST', url, headers: { 'x-scale-media': '1', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, payload: JSON.stringify(body) });
  admin = cookieOf(await json('POST', '/api/auth/setup', { name: 'Ada Admin', email: 'ada@scale.test', password: 'admin-password-1' }));
  for (const [name, email, role] of [['Max Manager', 'max@scale.test', 'manager'], ['Wes Writer', 'wes@scale.test', 'writer']]) {
    expect((await json('POST', '/api/users', { name, email, role, password: 'team-password-1' }, admin)).statusCode).toBe(200);
  }
  manager = cookieOf(await json('POST', '/api/auth/login', { email: 'max@scale.test', password: 'team-password-1' }));
  writer = cookieOf(await json('POST', '/api/auth/login', { email: 'wes@scale.test', password: 'team-password-1' }));
  for (const kind of EDITOR_KINDS) {
    const email = `${kind}@scale.test`;
    expect((await json('POST', '/api/users', { name: `Ed ${kind}`, email, role: 'editor', editorKind: kind, password: 'team-password-1' }, admin)).statusCode).toBe(200);
    editors[kind] = cookieOf(await json('POST', '/api/auth/login', { email, password: 'team-password-1' }));
  }
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('route access', () => {
  it('declares who may call every route the server has', () => {
    const routes = registeredRoutes();
    const undeclared = routes.filter((r) => !(r in ACCESS));
    const gone = Object.keys(ACCESS).filter((r) => !routes.includes(r));
    // a new route: add it to ACCESS above, with who may call it
    expect(undeclared).toEqual([]);
    expect(gone).toEqual([]);
  });

  it('refuses anyone signed out, except on public routes', async () => {
    const let_in: string[] = [];
    for (const [route, access] of Object.entries(ACCESS)) {
      if (access === 'public') continue;
      const [method, url] = route.split(' ');
      const status = await call(method, concrete(url));
      if (status !== 401) let_in.push(`${route} → ${status}`);
    }
    expect(let_in).toEqual([]);
  });

  it('refuses writers on every manager and admin route', async () => {
    const let_in: string[] = [];
    for (const [route, access] of Object.entries(ACCESS)) {
      if (access !== 'manager' && access !== 'admin') continue;
      const [method, url] = route.split(' ');
      const status = await call(method, concrete(url), writer);
      if (status !== 403) let_in.push(`${route} → ${status}`);
    }
    expect(let_in).toEqual([]);
  });

  it('refuses managers on every admin-only route', async () => {
    const let_in: string[] = [];
    for (const [route, access] of Object.entries(ACCESS)) {
      if (access !== 'admin') continue;
      const [method, url] = route.split(' ');
      const status = await call(method, concrete(url), manager);
      if (status !== 403) let_in.push(`${route} → ${status}`);
    }
    expect(let_in).toEqual([]);
    // and the admin gets past the role check on them
    expect(await call('GET', '/api/audit', admin)).toBe(200);
  });
});

describe('editors, by kind', () => {
  const allowed = (kind: EditorKind) => Object.entries(editorRoutesFor(kind)).flatMap(([method, set]) => [...set].map((r) => `${method} ${r}`)).sort();

  it('gives video editors exactly what editors had before kinds', () => {
    expect(allowed('short_form')).toEqual([
      'GET /api/auth/status', 'GET /api/bootstrap', 'GET /api/counts', 'GET /api/moments', 'GET /api/notifications',
      'GET /api/calendar', 'GET /api/script-bank', 'GET /api/files/:id', 'GET /api/shoot-readiness', 'GET /api/search',
      'GET /api/clients', 'GET /api/clients/:id', 'GET /api/resources',
      'GET /api/todos', 'GET /api/editing/me', 'GET /api/editing/script-pdf/:batchId',
      'POST /api/auth/login', 'POST /api/auth/logout', 'POST /api/me/password', 'POST /api/me/timezone', 'POST /api/me/whats-new',
      'POST /api/moments/seen', 'POST /api/notifications/read',
      'POST /api/todos', 'POST /api/editing/focus',
      'PATCH /api/todos/:id',
      'DELETE /api/todos/:id',
    ].sort());
  });

  it('allows each kind only routes that exist and that anyone signed in may call', () => {
    for (const kind of EDITOR_KINDS) {
      const odd = allowed(kind).filter((r) => ACCESS[r] !== 'user' && ACCESS[r] !== 'public');
      expect([kind, odd]).toEqual([kind, []]);
    }
  });

  it('gives thumbnail designers their Studio, and nobody else but managers (who only read it)', async () => {
    const studio = allowed('thumbnail').filter((r) => !allowed('short_form').includes(r));
    expect(studio).toEqual([
      'DELETE /api/thumbnail-options/:id', 'DELETE /api/thumbnail-refs/:id', 'GET /api/studio', 'GET /api/studio/portfolio', 'GET /api/thumbnail-refs', 'GET /api/thumbnails/:id',
      'PATCH /api/thumbnail-refs/:id', 'POST /api/thumbnail-options/:id/second-look', 'POST /api/thumbnail-refs', 'POST /api/thumbnails/:id/options',
      'POST /api/thumbnails/:id/send',
    ]);
    const let_in: string[] = [];
    for (const route of studio) {
      const [method, url] = route.split(' ');
      // writers have no Studio; video editors are refused before the route runs (code 'editor', above)
      for (const [who, cookie] of [['writer', writer], ['video editor', editors.short_form]] as const) {
        const status = await call(method, concrete(url), cookie);
        if (status !== 403) let_in.push(`${who}: ${route} → ${status}`);
      }
      // managers read a Studio and a brief, but never add, remove, send or ask for a second look on a designer's options
      if (method !== 'GET' && (await call(method, concrete(url), manager)) !== 403) let_in.push(`manager: ${route}`);
    }
    expect(let_in).toEqual([]);
    // a designer reaches them (brief 1 doesn't exist, so it's not found rather than refused)
    expect(await call('GET', '/api/studio', editors.thumbnail)).toBe(200);
    expect(await call('GET', '/api/studio/portfolio', editors.thumbnail)).toBe(200);
    expect(await call('GET', '/api/thumbnails/1', editors.thumbnail)).toBe(404);
    expect(await call('POST', '/api/thumbnail-options/1/second-look', editors.thumbnail)).toBe(404);
    // a reference board is the designer's own: managers don't read it either
    expect(await call('GET', '/api/thumbnail-refs', manager)).toBe(403);
    expect(await call('GET', '/api/thumbnail-refs', editors.thumbnail)).toBe(200);
    expect(await call('DELETE', '/api/thumbnail-refs/1', editors.thumbnail)).toBe(404);
  });

  it('refuses each kind every other route, in words for their kind', async () => {
    for (const kind of EDITOR_KINDS) {
      const mine = new Set(allowed(kind));
      const let_in: string[] = [];
      for (const [route, access] of Object.entries(ACCESS)) {
        if (access === 'public' || mine.has(route)) continue;
        const [method, url] = route.split(' ');
        const headers: Record<string, string> = { 'x-scale-media': '1', cookie: editors[kind] };
        if (method !== 'GET') headers['content-type'] = 'application/json';
        const r = await app.inject({ method: method as 'GET', url: concrete(url), headers, payload: method === 'GET' ? undefined : '{}' });
        const code = r.statusCode === 403 ? (JSON.parse(r.body) as { error: { code?: string } }).error.code : undefined;
        if (r.statusCode !== 403 || code !== 'editor') let_in.push(`${kind}: ${route} → ${r.statusCode} ${code ?? ''}`);
      }
      expect(let_in).toEqual([]);
    }
    // a video editor's Home isn't a designer's, and the refusal says what a designer can do
    const r = await app.inject({ method: 'GET', url: '/api/editing/me', headers: { cookie: editors.thumbnail } });
    expect(r.statusCode).toBe(403);
    expect((JSON.parse(r.body) as { error: { message: string } }).error.message).toMatch(/Thumbnail designers can use their Studio/);
  });
});

describe('sessions and first-run setup', () => {
  const json = (method: string, url: string, body: unknown, cookie?: string) =>
    app.inject({ method: method as 'POST', url, headers: { 'x-scale-media': '1', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, payload: JSON.stringify(body) });
  const signIn = async (email: string, password: string) => {
    const r = await json('POST', '/api/auth/login', { email, password });
    expect(r.statusCode).toBe(200);
    return String(r.headers['set-cookie']).split(';')[0];
  };
  const signedIn = async (cookie: string) => (await app.inject({ method: 'GET', url: '/api/bootstrap', headers: { cookie } })).statusCode === 200;

  it('a workspace set up without a name is called SCALE Media', async () => {
    expect((await db.one<{ org_name: string }>(`select org_name from settings where id = 1`))?.org_name).toBe('SCALE Media');
  });

  it('setup only ever creates the first account', async () => {
    const again = await json('POST', '/api/auth/setup', { name: 'Late Comer', email: 'late@scale.test', password: 'late-password-1' });
    expect(again.statusCode).toBe(409);
    expect(await db.one(`select id from users where email = 'late@scale.test'`)).toBeUndefined();
  });

  it('setup from the browser can be switched off (production without ALLOW_SETUP)', async () => {
    const { openDb } = await import('../server/db');
    const other = await openDb({ memory: true });
    const locked = await buildApp({ db: other, now: () => new Date(), secureCookies: false, allowSetup: false, uploadLimitBytes: 1024 });
    try {
      const r = await locked.inject({ method: 'POST', url: '/api/auth/setup', headers: { 'x-scale-media': '1', 'content-type': 'application/json' }, payload: JSON.stringify({ name: 'Anyone', email: 'any@scale.test', password: 'any-password-1' }) });
      expect(r.statusCode).toBe(403);
      expect((await other.one<{ n: number }>(`select count(*) as n from users`))?.n).toBe(0);
    } finally {
      await locked.close();
      await other.close();
    }
  });

  it('changing, resetting or switching off an account ends its other sessions', async () => {
    await json('POST', '/api/users', { name: 'Sid Sessions', email: 'sid@scale.test', role: 'writer', password: 'sid-temp-pass1' }, admin);
    const sid = (await db.one<{ id: number }>(`select id from users where email = 'sid@scale.test'`))!.id;
    const a = await signIn('sid@scale.test', 'sid-temp-pass1');
    const b = await signIn('sid@scale.test', 'sid-temp-pass1');
    // a wrong current password changes nothing
    const wrong = await json('POST', '/api/me/password', { current: 'not-it-at-all', next: 'sid-own-password' }, a);
    expect(wrong.statusCode).toBe(400);
    expect(JSON.parse(wrong.body).error.fields.current).toBeTruthy();
    // their own change keeps this session and ends the other one
    expect((await json('POST', '/api/me/password', { current: 'sid-temp-pass1', next: 'sid-own-password' }, a)).statusCode).toBe(200);
    expect([await signedIn(a), await signedIn(b)]).toEqual([true, false]);
    // a reset by a manager ends theirs
    expect((await json('PATCH', `/api/users/${sid}`, { password: 'sid-reset-pass1' }, manager)).statusCode).toBe(200);
    expect(await signedIn(a)).toBe(false);
    // and so does switching the account off
    const c = await signIn('sid@scale.test', 'sid-reset-pass1');
    expect((await json('PATCH', `/api/users/${sid}`, { active: false }, manager)).statusCode).toBe(200);
    expect(await signedIn(c)).toBe(false);
    expect((await json('POST', '/api/auth/login', { email: 'sid@scale.test', password: 'sid-reset-pass1' })).statusCode).toBe(401);
  });
});
