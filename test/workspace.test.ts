// Workspace-wide operations, each on its own database so they can't disturb
// the long scenario in api.test.ts: recalculating deadlines when the rules
// change, archiving a batch, and seeding the demo workspace.

import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { openDb, type Db } from '../server/db';
import type { Ctx } from '../server/core';
import { DEMO_PASSWORD, seedDemo } from '../server/seed-demo';
import {
  fileUrl, type BatchDetail, type Bootstrap, type ClientDetail, type ClientSummary, type Counts, type Moment, type Notification, type PortfolioPayload,
  type StudioPayload, type ThumbnailBoard, type ThumbnailBriefDetail, type ThumbnailRefBoard,
} from '../shared/types';
import { brandContrast, MAX_REFS, portfolioPath, SECOND_LOOK_CHECKS, thumbSpecIssues } from '../shared/workflow';
import { dominantColours } from '../shared/palettes';
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

  it('keeps two clients’ brand kits with their logos, and Ana’s reference boards private to her', async () => {
    const demo = await openDb({ memory: true });
    const demoApp = await buildApp({ db: demo, now: () => NOW, secureCookies: false, allowSetup: false, uploadLimitBytes: 1024 * 1024 });
    try {
      expect(await seedDemo(demo, NOW)).toBe(true);
      const signIn = async (email: string) => String((await demoApp.inject({
        method: 'POST', url: '/api/auth/login', headers: { 'x-scale-media': '1', 'content-type': 'application/json' }, payload: JSON.stringify({ email, password: DEMO_PASSWORD }),
      })).headers['set-cookie']).split(';')[0];
      const get = async (url: string, cookie: string) => {
        const r = await demoApp.inject({ method: 'GET', url, headers: { cookie } });
        return { status: r.statusCode, raw: r.rawPayload, json: () => JSON.parse(r.body) };
      };
      const [ana, josh, sarah] = [await signIn('ana@scalemedia.demo'), await signIn('josh@scalemedia.demo'), await signIn('sarah@scalemedia.demo')];
      const clients = ((await get('/api/clients', josh)).json() as { clients: ClientSummary[] }).clients;
      const idOf = (name: string) => clients.find((c) => c.name === name)!.id;

      // Acme's kit, as a writer reads it: colours in order with hex in capitals, a font to get, do's and don'ts
      const acme = (await get(`/api/clients/${idOf('Acme Outdoor Co.')}`, sarah)).json() as ClientDetail;
      expect(acme.brand?.colours.map((c) => [c.name, c.hex])).toEqual([['Trail green', '#2F5D50'], ['Ember', '#E8743B'], ['Bone', '#F3EDE2'], ['Charcoal', '#23262B']]);
      expect(acme.brand?.fonts).toEqual([{ name: 'Bricolage Grotesque', url: 'https://fonts.google.com/specimen/Bricolage+Grotesque', resourceId: null, file: null }]);
      expect([!!acme.brand?.dos, !!acme.brand?.donts, acme.brand?.updatedByName]).toEqual([true, true, 'Josh Rath']);
      expect(brandContrast(acme.brand!.colours)).toMatchObject({ dark: '#23262B', light: '#F3EDE2', readable: true });
      expect('recentWinners' in acme).toBe(false);
      const northwind = (await get(`/api/clients/${idOf('Northwind Coffee Roasters')}`, josh)).json() as ClientDetail;
      expect(northwind.brand?.colours.map((c) => c.name)).toEqual(['Roast', 'Crema', 'Oat', 'Leaf']);
      for (const c of clients.filter((x) => x.id !== acme.id && x.id !== northwind.id)) {
        expect(((await get(`/api/clients/${c.id}`, josh)).json() as ClientDetail).brand).toBeNull();
      }

      // each has a logo resource (a PNG, which a writer may open), and "Pick colours from logo" finds the kit's own
      // colours in it: the browser runs dominantColours on the canvas's pixels; here the PNG is decoded by hand
      for (const c of [acme, northwind]) {
        const logos = c.resources.filter((r) => r.category === 'logo');
        expect(logos.map((r) => [r.kind, r.fileMime])).toEqual([['file', 'image/png']]);
        const file = await get(fileUrl(logos[0].fileId!), sarah);
        expect(file.status).toBe(200);
        const found = dominantColours(pngPixels(file.raw));
        expect(found).toHaveLength(3);
        expect(found.filter((hex) => c.brand!.colours.some((k) => k.hex === hex))).toEqual(found);
      }

      // Ana sees the kit with the client's winners, and beside her brief; the AI ideas are off without a key
      const anaAcme = (await get(`/api/clients/${acme.id}`, ana)).json() as ClientDetail;
      expect(anaAcme.brand?.colours).toHaveLength(4);
      expect(anaAcme.recentWinners?.map((w) => [w.title, w.standout])).toEqual([['The jacket that folds into itself', true], ['Autumn in one bag', false]]);
      const studio = (await get('/api/studio', ana)).json() as StudioPayload;
      const jacket = studio.wins.find((w) => w.title === 'The jacket that folds into itself')!;
      const brief = (await get(`/api/thumbnails/${jacket.briefId}`, ana)).json() as ThumbnailBriefDetail;
      expect(brief.look.brand?.colours.map((c) => c.name)).toEqual(['Trail green', 'Ember', 'Bone', 'Charcoal']);
      expect(brief.look.images.map((r) => r.title)).toContain('Acme logo');
      expect(((await get('/api/bootstrap', josh)).json() as Bootstrap).briefIdeas).toBe(false);

      // her boards: Acme's logo, her first Acme winner and an upload of her own on General, newest first
      const refs = (await get('/api/thumbnail-refs', ana)).json() as ThumbnailRefBoard;
      expect([refs.total, refs.max]).toEqual([3, MAX_REFS]);
      expect(refs.refs.map((r) => [r.source, r.clientName, r.mime])).toEqual([
        ['resource', 'Acme Outdoor Co.', 'image/png'], ['winner', 'Acme Outdoor Co.', 'image/png'], ['upload', null, 'image/png'],
      ]);
      expect(refs.refs[1].winner).toMatchObject({ title: 'Autumn in one bag', letter: 'A', madeByName: 'Ana Torres' });
      expect(refs.refs[0].resource).toMatchObject({ title: 'Acme logo', category: 'logo' });
      expect(((await get('/api/thumbnail-refs?clientId=general', ana)).json() as ThumbnailRefBoard).refs.map((r) => r.source)).toEqual(['upload']);
      expect(((await get(`/api/thumbnail-refs?clientId=${acme.id}`, ana)).json() as ThumbnailRefBoard).refs.map((r) => r.source)).toEqual(['resource', 'winner']);
      // the picture she uploaded opens only for her, and managers have no boards
      const upload = refs.refs[2];
      expect([(await get(upload.url, ana)).status, (await get(upload.url, josh)).status, (await get(upload.url, sarah)).status]).toEqual([200, 404, 404]);
      expect([(await get('/api/thumbnail-refs', josh)).status, (await get('/api/thumbnail-refs', sarah)).status]).toEqual([403, 403]);
    } finally {
      await demoApp.close();
      await demo.close();
    }
  });

  it('marks one of Ana’s wins live, and shows her portfolio and private growth to her and the managers only', async () => {
    const demo = await openDb({ memory: true });
    const demoApp = await buildApp({ db: demo, now: () => NOW, secureCookies: false, allowSetup: false, uploadLimitBytes: 1024 * 1024 });
    try {
      expect(await seedDemo(demo, NOW)).toBe(true);
      const signIn = async (email: string) => String((await demoApp.inject({
        method: 'POST', url: '/api/auth/login', headers: { 'x-scale-media': '1', 'content-type': 'application/json' }, payload: JSON.stringify({ email, password: DEMO_PASSWORD }),
      })).headers['set-cookie']).split(';')[0];
      const get = async (url: string, cookie: string) => {
        const r = await demoApp.inject({ method: 'GET', url, headers: { cookie } });
        return { status: r.statusCode, cache: String(r.headers['cache-control'] ?? ''), json: () => JSON.parse(r.body) };
      };
      const [ana, josh, sarah] = [await signIn('ana@scalemedia.demo'), await signIn('josh@scalemedia.demo'), await signIn('sarah@scalemedia.demo')];
      const liveOn = '2026-09-20'; // two days after the pick, eight before NOW

      // the Studio's wall: the bag went live (its badge links to the video), the jacket isn't marked yet
      const studio = (await get('/api/studio', ana)).json() as StudioPayload;
      expect(studio.wins.map((w) => [w.title, w.live])).toEqual([
        ['The jacket that folds into itself', null], ['Autumn in one bag', { url: 'https://www.youtube.com/watch?v=dmAutumnBag', publishedOn: liveOn }],
      ]);
      const bag = studio.wins.find((w) => w.title === 'Autumn in one bag')!;
      // its picture is kept by the browser for a day, as every option's is
      expect((await get(bag.option.url, ana)).cache).toBe('private, max-age=86400, immutable');

      // her portfolio: both wins, newest pick first, each with its round story; the bag with where it went live and
      // the Test & Compare winner (her own option, the pick, so its picture shows)
      const mine = (await get('/api/studio/portfolio', ana)).json() as PortfolioPayload;
      expect([mine.designer.name, mine.readOnly, mine.total, mine.filter]).toEqual(['Ana Torres', false, 2, { clientId: null, month: null }]);
      expect(mine.cards.map((c) => [c.title, c.option.letter, c.coverUrl === c.option.url, c.story.firstRound, c.story.changesAsked])).toEqual([
        ['The jacket that folds into itself', 'B', true, false, 1], ['Autumn in one bag', 'A', true, true, 0],
      ]);
      expect(mine.cards[0].story.rounds.map((s) => [s.number, s.mine, s.options, s.outcome, s.note])).toEqual([
        [1, true, 3, 'changes', 'Keep B’s face, but make the words bigger and cut them to three.'], [2, true, 2, 'picked', 'Two words read best small.'],
      ]);
      const card = mine.cards[1];
      expect(card.live).toMatchObject({ url: 'https://www.youtube.com/watch?v=dmAutumnBag', publishedOn: liveOn, publishedByName: 'Josh Rath' });
      expect(card.live?.testWinner).toEqual({ optionId: bag.option.id, letter: 'A', roundNumber: 1, isPick: true, url: bag.option.url });
      expect(card.live?.testNote).toMatch(/watching longer/);
      expect(mine.cards[0].live).toBeNull();
      // growth over the last six months (September 2026 back to April): both picks this month, one from the first round,
      // the jacket's standout, and the tags of the notes pinned on the harvest box's round 1
      expect(mine.growth.months.map((m) => [m.month, m.picks])).toEqual([
        ['2026-04', 0], ['2026-05', 0], ['2026-06', 0], ['2026-07', 0], ['2026-08', 0], ['2026-09', 2],
      ]);
      expect(mine.growth).toMatchObject({ picks: 2, firstRoundPicks: 1, firstRoundRate: 50, standouts: 1, notes: 3 });
      expect(mine.growth.themes).toEqual([{ tag: 'text', count: 1 }, { tag: 'contrast', count: 1 }, { tag: 'composition', count: 1 }]);
      expect([mine.clients.map((c) => [c.name, c.wins]), mine.months]).toEqual([[['Acme Outdoor Co.', 2]], [{ month: '2026-09', wins: 2 }]]);
      // a filter narrows only the wall; a bad one is refused
      const august = (await get('/api/studio/portfolio?month=2026-08', ana)).json() as PortfolioPayload;
      expect([august.cards.length, august.total, august.growth.picks]).toEqual([0, 2, 2]);
      expect((await get(`/api/studio/portfolio?clientId=${bag.clientId}&month=2026-09`, ana)).json().cards).toHaveLength(2);
      expect((await get('/api/studio/portfolio?month=2026-13', ana)).status).toBe(400);
      // she was told once when it went live, a while ago, with a link to that card
      const notes = ((await get('/api/notifications', ana)).json() as { notifications: Notification[] }).notifications;
      expect(notes.filter((n) => n.type === 'thumbnail_live').map((n) => [n.title, n.link, !!n.readAt])).toEqual([
        ['Your thumbnail for “Autumn in one bag” went live', portfolioPath({ card: bag.option.id }), true],
      ]);

      // a manager opens it read-only by naming her (else 404), sees the mark on the brief and may change it; a writer
      // gets no portfolio. The demo has no copy of Timeliner: no video to link, and nothing to mark live on the board
      expect((await get('/api/studio/portfolio', josh)).status).toBe(404);
      const theirs = (await get(`/api/studio/portfolio?userId=${mine.designer.id}`, josh)).json() as PortfolioPayload;
      expect([theirs.readOnly, theirs.cards.map((c) => c.option.id), theirs.growth]).toEqual([true, mine.cards.map((c) => c.option.id), mine.growth]);
      expect((await get('/api/studio/portfolio', sarah)).status).toBe(403);
      const brief = (await get(`/api/thumbnails/${bag.briefId}`, josh)).json() as ThumbnailBriefDetail;
      expect([brief.can.markLive, brief.live?.publishedOn, brief.live?.testWinner?.letter, brief.timelinerTaskId, brief.video]).toEqual([true, liveOn, 'A', null, null]);
      const board = (await get('/api/thumbnails', josh)).json() as ThumbnailBoard;
      expect([board.toMarkLive, board.counts.toMarkLive]).toEqual([[], 0]);
      expect((await get(`/api/thumbnails/timeliner-videos?clientId=${bag.clientId}`, josh)).json()).toEqual({ videos: [], syncedAt: null });
    } finally {
      await demoApp.close();
      await demo.close();
    }
  });
});

/** A PNG's pixels (8-bit RGBA, as the demo's logos are), the way a canvas's getImageData() gives them. */
function pngPixels(png: Buffer): Uint8Array {
  let [at, w, h] = [8, 0, 0];
  const idat: Buffer[] = [];
  while (at < png.length) {
    const len = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      [w, h] = [data.readUInt32BE(0), data.readUInt32BE(4)];
      if (data[8] !== 8 || data[9] !== 6) throw new Error('not an 8-bit RGBA PNG');
    }
    if (type === 'IDAT') idat.push(data);
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const [bpp, stride] = [4, w * 4];
  const out = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const guess = [0, a, b, (a + b) >> 1, paeth][filter];
      out[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + guess) & 0xff;
    }
  }
  return out;
}
