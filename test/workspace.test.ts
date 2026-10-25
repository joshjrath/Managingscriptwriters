// Workspace-wide operations, each on its own database so they can't disturb
// the long scenario in api.test.ts: recalculating deadlines when the rules
// change, archiving a batch, and seeding the demo workspace.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { openDb, type Db } from '../server/db';
import type { Ctx } from '../server/core';
import { DEMO_PASSWORD, seedDemo } from '../server/seed-demo';
import type { BatchDetail, Counts, Moment, StudioPayload, ThumbnailBoard, ThumbnailBriefDetail } from '../shared/types';
import { SECOND_LOOK_CHECKS, thumbSpecIssues } from '../shared/workflow';
import { freshDb } from './db';

const NOW = new Date('2026-09-28T16:00:00Z'); // Monday noon in New York
let db: Db;
let app: FastifyInstance;
let admin = '';
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
  const ctx: Ctx = { db, now: () => NOW, secureCookies: false, allowSetup: true, uploadLimitBytes: 1024 * 1024 };
  app = await buildApp(ctx);
  const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0];
  const json = (url: string, body: unknown, cookie?: string) =>
    app.inject({ method: 'POST', url, headers: { 'x-scale-media': '1', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, payload: JSON.stringify(body) });
  admin = cookieOf(await json('/api/auth/setup', { name: 'Ada Admin', email: 'ada@scale.test', password: 'admin-password-1' }));
  const added = JSON.parse((await json('/api/users', { name: 'Wes Writer', email: 'wes@scale.test', role: 'writer', password: 'team-password-1' }, admin)).body);
  writerId = added.users.find((u: { email: string }) => u.email === 'wes@scale.test').id;
  writer = cookieOf(await json('/api/auth/login', { email: 'wes@scale.test', password: 'team-password-1' }));
  clientId = JSON.parse((await json('/api/clients', { name: 'Acme' }, admin)).body).clientId;
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('changing the deadline rules', () => {
  it('moves automatic deadlines only, and tells the writers', async () => {
    const shoot = (start: string) => send('POST', '/api/shoots', admin, { clientId, startDate: start, endDate: null, batch: { targetCount: 2, split: [{ writerId, count: 2 }], briefingIds: [], priority: 'normal' } });
    const auto = (await shoot('2026-11-16')).body.batchId as number;
    const manual = (await shoot('2026-11-23')).body.batchId as number;
    expect((await send('PATCH', `/api/batches/${manual}`, admin, { finalDue: { mode: 'manual', date: '2026-11-21' } })).status).toBe(200);

    const r = await send('PATCH', '/api/settings', admin, { draftOffsetDays: 6, recalculate: true });
    expect(r.status).toBe(200);
    expect(r.body.recalculated).toBe(2);
    const get = async (id: number) => (await send('GET', `/api/batches/${id}`, admin)).body as BatchDetail;
    // drafts were 5 days before the shoot, now 6; final delivery stays 3 days before, or where it was set by hand
    expect(await get(auto)).toMatchObject({ draftDue: '2026-11-10', finalDue: '2026-11-13' });
    expect(await get(manual)).toMatchObject({ draftDue: '2026-11-17', finalDue: '2026-11-21', finalDueMode: 'manual' });
    const notes = (await send('GET', '/api/notifications', writer)).body.notifications;
    expect(notes.filter((n: { type: string }) => n.type === 'deadline_change').length).toBeGreaterThanOrEqual(2);
  });
});

describe('archiving a batch', () => {
  it('takes it out of the live lists and brings it back on restore', async () => {
    const b = await send('POST', '/api/batches', admin, { clientId, title: 'Old work', targetCount: 1, draftDue: '2026-09-28', finalDue: '2026-09-30', split: [{ writerId, count: 1 }] });
    const id = b.body.batchId as number;
    const listed = async (q = '') => (await send('GET', `/api/batches${q}`, admin)).body.batches.some((x: { id: number }) => x.id === id);
    const onToday = async () => (await send('GET', '/api/today', writer)).body.items.some((i: { batchId: number }) => i.batchId === id);
    expect([await listed(), await onToday()]).toEqual([true, true]);
    expect((await send('POST', `/api/batches/${id}/archive`, admin, { archived: true })).status).toBe(200);
    expect([await listed(), await onToday(), await listed('?archived=only')]).toEqual([false, false, true]);
    expect((await send('POST', `/api/batches/${id}/archive`, admin, { archived: false })).status).toBe(200);
    expect([await listed(), await onToday()]).toEqual([true, true]);
  });
});

describe('the demo workspace', () => {
  it('seeds an empty database once, and never one that has people in it', async () => {
    const demo = await openDb({ memory: true });
    try {
      expect(await seedDemo(demo, NOW)).toBe(true);
      expect((await demo.one<{ n: number }>(`select count(*) as n from batches`))!.n).toBeGreaterThan(0);
      expect(await seedDemo(demo, NOW)).toBe(false);
    } finally {
      await demo.close();
    }
  });

  it('shows a thumbnail designer’s Studio and the managers’ Thumbnails page, drafts kept private', async () => {
    const demo = await openDb({ memory: true });
    const demoApp = await buildApp({ db: demo, now: () => NOW, secureCookies: false, allowSetup: false, uploadLimitBytes: 1024 * 1024 });
    try {
      expect(await seedDemo(demo, NOW)).toBe(true);
      const signIn = async (email: string) => String((await demoApp.inject({
        method: 'POST', url: '/api/auth/login', headers: { 'x-scale-media': '1', 'content-type': 'application/json' }, payload: JSON.stringify({ email, password: DEMO_PASSWORD }),
      })).headers['set-cookie']).split(';')[0];
      const get = async (url: string, cookie: string) => {
        const r = await demoApp.inject({ method: 'GET', url, headers: { cookie } });
        return { status: r.statusCode, type: String(r.headers['content-type'] ?? ''), json: () => JSON.parse(r.body) };
      };
      const [ana, josh, sarah] = [await signIn('ana@scalemedia.demo'), await signIn('josh@scalemedia.demo'), await signIn('sarah@scalemedia.demo')];

      const studio = (await get('/api/studio', ana)).json() as StudioPayload;
      expect(studio.hero).toMatchObject({ kind: 'changes', brief: { title: 'What’s in the harvest box' } });
      expect(studio.board.map((b) => [b.title, b.state])).toEqual([
        ['What’s in the harvest box', 'changes'], ['What the night serum actually does', 'drafting'], ['Meet coach Dana', 'to_design'], ['Same-week appointments, really', 'in_review'],
      ]);
      expect(studio.wins.map((w) => [w.title, w.option.letter])).toEqual([['The jacket that folds into itself', 'B'], ['Autumn in one bag', 'A']]);
      expect(studio.counts).toMatchObject({ waitingOnReview: 1, onPlate: 3 });
      expect(((await get('/api/counts', ana)).json() as Counts).myThumbnails).toBe(3);

      const board = (await get('/api/thumbnails', josh)).json() as ThumbnailBoard;
      expect(board.counts).toMatchObject({ toReview: 1, changes: 1, withDesigners: 3, needsDesigner: 1 });
      expect(board.toReview[0].round.options.map((o) => [o.letter, thumbSpecIssues(o).map((c) => c.key)])).toEqual([['A', []], ['B', []], ['C', ['shape']]]);
      expect(((await get('/api/counts', josh)).json() as Counts).thumbnailsToReview).toBe(1);

      // the picked option opens as a picture for its designer and the managers, never for a writer; the tray only for Ana
      const winner = studio.wins[0].option;
      expect([(await get(winner.url, ana)).type, (await get(winner.url, josh)).status, (await get(winner.url, sarah)).status]).toEqual(['image/png', 200, 404]);
      const serum = studio.board.find((b) => b.state === 'drafting')!;
      const draft = ((await get(`/api/thumbnails/${serum.id}`, ana)).json() as ThumbnailBriefDetail).tray!.options[0];
      const managerView = (await get(`/api/thumbnails/${serum.id}`, josh)).json() as ThumbnailBriefDetail;
      expect([managerView.tray, managerView.draftOptions, managerView.cover]).toEqual([null, 1, null]);
      expect([(await get(draft.url, ana)).status, (await get(draft.url, josh)).status]).toEqual([200, 404]);

      // notes pinned on the round changes were asked on, a standout in "Your best this month" with her celebration
      // waiting, and a second look kept on her tray option (only hers), all without an API key
      expect(studio.hero.kind === 'changes' && studio.hero.decision.pins?.map((p) => [p.n, p.optionLetter, p.tag])).toEqual([[1, 'A', 'composition'], [2, 'A', 'text'], [3, 'B', 'contrast']]);
      expect(studio.best?.map((w) => [w.title, w.standout])).toEqual([['The jacket that folds into itself', true]]);
      const celebrations = ((await get('/api/moments', ana)).json() as Moment[]).filter((m) => m.thumb);
      expect(celebrations.map((m) => [m.kind, m.batchId, m.thumb?.title, m.thumb?.roundNumber, m.thumb?.firstRound, m.thumb?.option.letter])).toEqual([
        ['thumb_standout', null, 'The jacket that folds into itself', 2, false, 'B'],
      ]);
      expect(draft.secondLook?.checks.map((c) => c.key)).toEqual([...SECOND_LOOK_CHECKS]);
      expect(draft.secondLook?.oneLiner).toMatch(/bottle/);
      expect(JSON.stringify(managerView)).not.toContain(draft.secondLook!.oneLiner);
    } finally {
      await demoApp.close();
      await demo.close();
    }
  });
});
