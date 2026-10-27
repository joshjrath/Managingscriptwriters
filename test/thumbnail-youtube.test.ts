// Past thumbnails from YouTube, through their routes, with a stand-in for YouTube (ctx.youtube): looking pasted links
// up (managers only, one row per video in the order pasted, why a row can't be added, the brief a video is already on,
// the client suggested by an earlier import's channel or by the channel's name, nothing stored), adding them (a brief
// already picked and live on the designer's wall, its round and pick backdated to noon on the day it went live, the
// option the designer's upload, its type read from its own bytes, no celebration and one quiet notification; a
// designer, client, day or video that can't be is refused, and a video already on the site is skipped, the unique
// index deciding a race), the went-live link keeping its YouTube video (and refusing one already on another brief), the
// growth figures leaving imports out of the first-round rate, and the API key never reaching an answer or a log.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import type { Db } from '../server/db';
import type { Ctx, YoutubePicture, YoutubeProblem, YoutubeReader, YoutubeVideo } from '../server/core';
import { youtubeReader } from '../server/youtube';
import type {
  PortfolioPayload, StudioPayload, ThumbnailBoard, ThumbnailBriefDetail, UserSummary, YoutubeImportResult, YoutubeLookupFound, YoutubeLookupResult,
} from '../shared/types';
import { addDays, nowInZone } from '../shared/dates';
import {
  importedRoundAt, portfolioPath, thumbImportKey, YOUTUBE_IMPORT_LIMITS, YOUTUBE_PROBLEMS, youtubeAlreadyOnSite, youtubeWatchUrl,
} from '../shared/workflow';
import { freshDb } from './db';

let db: Db;
let app: FastifyInstance;
let ctx: Ctx;
let admin = '';
let acme = 0;
let globex = 0;
let oldMill = 0;
let tz = 'America/New_York';
type Person = { id: number; cookie: string };
const people = {} as Record<'max' | 'wes' | 'vic' | 'dee' | 'dan', Person>;

type Res = { status: number; body: ReturnType<typeof JSON.parse> };

const send = async (method: string, url: string, cookie: string, body?: unknown): Promise<Res> => {
  const r = await app.inject({
    method: method as 'POST', url, headers: { 'x-scale-media': '1', cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed: ReturnType<typeof JSON.parse> = null;
  try { parsed = r.body ? JSON.parse(r.body) : null; } catch { parsed = r.body; }
  return { status: r.statusCode, body: parsed };
};
const fieldsOf = (r: Res) => [r.status, Object.keys(r.body?.error?.fields ?? {}).sort()];

async function person(name: string, role: string, editorKind?: string): Promise<Person> {
  const email = `${name.toLowerCase().replace(/\W+/g, '.')}@scale.test`;
  const r = await send('POST', '/api/users', admin, { name, email, role, password: 'team-password-1', ...(editorKind ? { editorKind } : {}) });
  expect([r.status, r.body?.error]).toEqual([200, undefined]);
  const login = await app.inject({
    method: 'POST', url: '/api/auth/login', headers: { 'x-scale-media': '1', 'content-type': 'application/json' }, payload: JSON.stringify({ email, password: 'team-password-1' }),
  });
  return { id: (r.body.users as UserSummary[]).find((u) => u.email === email)!.id, cookie: String(login.headers['set-cookie']).split(';')[0] };
}

/** A JPEG's header with its frame (start-of-frame) segment, as wide and tall as asked. */
function jpeg(width = 1280, height = 720): Buffer {
  const b = Buffer.alloc(24);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xc0;
  b.writeUInt16BE(17, 4);
  b[6] = 8;
  b.writeUInt16BE(height, 7);
  b.writeUInt16BE(width, 9);
  b[11] = 3;
  return b;
}
/** A page that says it's a JPEG. */
const HTML = Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>');

// ── the stand-in for YouTube ─────────────────────────────────────────────

/** Video ids: 11 letters, digits, - or _. */
const ID = {
  roast: 'roastDay001', farm: 'farmTrip002', gone: 'goneVideo03', priv: 'privVideo04', html: 'htmlThumb05', huge: 'hugeThumb06', race: 'raceVideo07',
  todays: 'todayVideo8', later: 'laterVid009', named: 'namedChan10', again: 'againChan11', cancel: 'cancelVid12', live: 'liveLink013', taken: 'takenLink14',
  rae1: 'raeVideo015', solo: 'soloVideo16', nodate: 'noDateVid17', noprev: 'noPreview18', future: 'futureVid19', newer: 'newerVid020',
} as const;
const videos = new Map<string, YoutubeVideo | YoutubeProblem>();
const pictures = new Map<string, YoutubePicture | YoutubeProblem>();
const asked: string[] = [];
/** run while YouTube is being read for a video (the race below) */
const during = new Map<string, () => Promise<void>>();
const fake: YoutubeReader = {
  async video(id) {
    asked.push(`video:${id}`);
    await during.get(id)?.();
    return videos.get(id) ?? { ok: false, problem: YOUTUBE_PROBLEMS.notFound };
  },
  async picture(id, size) {
    asked.push(`picture:${id}:${size}`);
    return pictures.get(`${id}:${size}`) ?? pictures.get(id) ?? { ok: true, data: jpeg(), contentType: 'image/jpeg', name: size === 'preview' ? 'hqdefault' : 'maxresdefault' };
  },
};
const video = (id: string, o: Partial<YoutubeVideo> = {}) => {
  videos.set(id, {
    ok: true, videoId: id, title: `Video ${id}`, channel: 'Acme Outdoor', channelUrl: 'https://www.youtube.com/@acmeoutdoor', publishedAt: '2026-08-14T15:00:00Z', ...o,
  });
};

const lookup = (urls: unknown, cookie = people.max.cookie) => send('POST', '/api/thumbnails/youtube/lookup', cookie, { urls });
const found = async (urls: string[]) => {
  const r = await lookup(urls);
  expect([r.status, r.body?.error]).toEqual([200, undefined]);
  return (r.body as YoutubeLookupResult).rows;
};
const add = (body: unknown, cookie = people.max.cookie) => send('POST', '/api/thumbnails/youtube/import', cookie, body);
const added = async (designer: Person, items: { videoId: string; clientId?: number; publishedOn?: string; title?: string }[]) => {
  const r = await add({ designerId: designer.id, items: items.map((i) => ({ clientId: acme, publishedOn: '2026-08-14', ...i })) });
  expect([r.status, r.body?.error]).toEqual([200, undefined]);
  return r.body as YoutubeImportResult;
};
const count = async (table: string) => (await db.one<{ n: number }>(`select count(*)::int as n from ${table}`))!.n;
const detail = async (id: number, cookie = people.max.cookie) => (await send('GET', `/api/thumbnails/${id}`, cookie)).body as ThumbnailBriefDetail;
const today = () => nowInZone(tz, new Date()).date;

beforeAll(async () => {
  db = await freshDb();
  ctx = { db, now: () => new Date(), secureCookies: false, allowSetup: true, uploadLimitBytes: 1024 * 1024, youtube: fake };
  app = await buildApp(ctx);
  const setup = await app.inject({
    method: 'POST', url: '/api/auth/setup', headers: { 'x-scale-media': '1', 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'Ada Admin', email: 'ada@scale.test', password: 'admin-password-1' }),
  });
  admin = String(setup.headers['set-cookie']).split(';')[0];
  people.max = await person('Max Manager', 'manager');
  people.wes = await person('Wes Writer', 'writer');
  people.vic = await person('Vic Video', 'editor');
  people.dee = await person('Dee Designer', 'editor', 'thumbnail');
  people.dan = await person('Dan Drawer', 'editor', 'thumbnail');
  acme = (await send('POST', '/api/clients', admin, { name: 'Acme' })).body.clientId;
  globex = (await send('POST', '/api/clients', admin, { name: 'Globex Studios' })).body.clientId;
  oldMill = (await send('POST', '/api/clients', admin, { name: 'Old Mill' })).body.clientId;
  await db.query(`update clients set status = 'archived', archived_at = now() where id = $1`, [oldMill]);
  tz = (await db.one<{ timezone: string }>(`select timezone from settings where id = 1`))!.timezone;
  for (const id of Object.values(ID)) video(id);
  videos.set(ID.gone, { ok: false, problem: YOUTUBE_PROBLEMS.notFound });
  videos.set(ID.priv, { ok: false, problem: YOUTUBE_PROBLEMS.private });
  // YouTube's word for it is a JPEG; its bytes are a page
  pictures.set(`${ID.html}:best`, { ok: true, data: HTML, contentType: 'image/jpeg', name: 'maxresdefault' });
  pictures.set(`${ID.html}:preview`, { ok: true, data: HTML, contentType: 'image/jpeg', name: 'hqdefault' });
  const huge = Buffer.concat([jpeg(), Buffer.alloc(YOUTUBE_IMPORT_LIMITS.pictureBytes)]);
  pictures.set(`${ID.huge}:best`, { ok: true, data: huge, contentType: 'image/jpeg', name: 'maxresdefault' });
  pictures.set(`${ID.noprev}:preview`, { ok: false, problem: YOUTUBE_PROBLEMS.unreachable });
});

afterAll(async () => {
  await app.close();
  await db.close();
});

afterEach(() => {
  ctx.youtube = fake;
  vi.restoreAllMocks();
});

describe('looking pasted links up', () => {
  it('is for managers only, and on no editor’s list', async () => {
    const urls = [youtubeWatchUrl(ID.roast)];
    expect((await lookup(urls, people.wes.cookie)).status).toBe(403);
    expect((await lookup(urls, people.vic.cookie)).status).toBe(403);
    const asDesigner = await lookup(urls, people.dee.cookie);
    expect([asDesigner.status, asDesigner.body.error.code]).toEqual([403, 'editor']);
    expect((await app.inject({ method: 'POST', url: '/api/thumbnails/youtube/lookup', headers: { 'x-scale-media': '1', 'content-type': 'application/json' }, payload: '{}' })).statusCode).toBe(401);
    expect((await lookup(urls)).status).toBe(200);
  });

  it('gives one row per video in the order pasted, saying why a link can’t be added, and stores nothing', async () => {
    const before = [await count('thumbnail_briefs'), await count('files'), await count('activity')];
    asked.length = 0;
    const rows = await found([
      `  https://www.youtube.com/watch?v=${ID.roast}&t=42s  `, 'not a link at all', `https://youtu.be/${ID.roast}?si=x`, '',
      `https://www.youtube.com/shorts/${ID.gone}`, `youtube.com/watch?v=${ID.priv}`, 'https://youtube.com.evil.test/watch?v=roastDay001', 'not a link at all',
    ]);
    expect(rows.map((r) => [r.input, r.ok, r.ok ? null : r.problem])).toEqual([
      [`https://www.youtube.com/watch?v=${ID.roast}&t=42s`, true, null],
      ['not a link at all', false, YOUTUBE_PROBLEMS.notLink],
      [`https://www.youtube.com/shorts/${ID.gone}`, false, YOUTUBE_PROBLEMS.notFound],
      [`youtube.com/watch?v=${ID.priv}`, false, YOUTUBE_PROBLEMS.private],
      ['https://youtube.com.evil.test/watch?v=roastDay001', false, YOUTUBE_PROBLEMS.notLink],
    ]);
    const roast = rows[0] as YoutubeLookupFound;
    expect(roast).toMatchObject({
      videoId: ID.roast, url: youtubeWatchUrl(ID.roast), title: `Video ${ID.roast}`, channel: 'Acme Outdoor', channelUrl: 'https://www.youtube.com/@acmeoutdoor',
      // 15:00 UTC is the same day in the workspace's zone
      publishedOn: '2026-08-14',
    });
    // the preview is a data: URL of the picture's own type
    expect(roast.picture).toBe(`data:image/jpeg;base64,${jpeg().toString('base64')}`);
    expect(rows[2]).toMatchObject({ videoId: ID.gone, url: youtubeWatchUrl(ID.gone) });
    // YouTube is asked once per video, never for a link that isn't one
    expect(asked.filter((a) => a.startsWith('video:')).sort()).toEqual([`video:${ID.gone}`, `video:${ID.priv}`, `video:${ID.roast}`].sort());
    expect([await count('thumbnail_briefs'), await count('files'), await count('activity')]).toEqual(before);
  });

  it('leaves the day out when YouTube gave none or one that can’t be, and a preview that isn’t a small picture', async () => {
    video(ID.nodate, { publishedAt: null });
    video(ID.future, { publishedAt: `${addDays(today(), 3)}T12:00:00Z` });
    const rows = (await found([ID.nodate, ID.future, ID.html, ID.noprev].map((id) => `https://youtu.be/${id}`))) as YoutubeLookupFound[];
    expect(rows.map((r) => [r.videoId, r.ok, r.publishedOn, r.picture === null])).toEqual([
      [ID.nodate, true, null, false], [ID.future, true, null, false], [ID.html, true, '2026-08-14', true], [ID.noprev, true, '2026-08-14', true],
    ]);
    // a timestamp is the day it was in the workspace's zone: 02:00 UTC is still the day before in New York
    video(ID.nodate, { publishedAt: '2026-08-15T02:00:00Z' });
    expect([tz, ((await found([`https://youtu.be/${ID.nodate}`]))[0] as YoutubeLookupFound).publishedOn]).toEqual(['America/New_York', '2026-08-14']);
    video(ID.nodate, { publishedAt: null });
  });

  it('refuses no links, too many, too long or not text, all on fields.urls', async () => {
    const many = Array.from({ length: YOUTUBE_IMPORT_LIMITS.links + 1 }, (_, i) => `https://youtu.be/${String(i).padStart(11, 'x')}`);
    for (const urls of [undefined, [], many, [`https://youtu.be/${ID.roast}?${'a'.repeat(YOUTUBE_IMPORT_LIMITS.url)}`], [42], ['   ', '']]) {
      expect([JSON.stringify(urls)?.slice(0, 30), ...fieldsOf(await lookup(urls))]).toEqual([JSON.stringify(urls)?.slice(0, 30), 400, ['urls']]);
    }
    // twenty is fine
    expect((await lookup(many.slice(0, YOUTUBE_IMPORT_LIMITS.links))).status).toBe(200);
  });

  it('is 503 not_configured without a way to read YouTube', async () => {
    ctx.youtube = null;
    const r = await lookup([`https://youtu.be/${ID.roast}`]);
    expect([r.status, r.body.error.code]).toEqual([503, 'not_configured']);
  });

  it('suggests the client named like the channel, any case, spacing or accents, but never an archived one or one of two', async () => {
    video(ID.named, { channel: '  globex   STUDIOS ', channelUrl: 'https://www.youtube.com/@globexstudios' });
    expect(((await found([`https://youtu.be/${ID.named}`]))[0] as YoutubeLookupFound).suggestedClientId).toBe(globex);
    video(ID.named, { channel: 'Old Mill', channelUrl: 'https://www.youtube.com/@oldmill' });
    expect(((await found([`https://youtu.be/${ID.named}`]))[0] as YoutubeLookupFound).suggestedClientId).toBeNull();
    video(ID.named, { channel: 'Somebody else', channelUrl: 'https://www.youtube.com/@somebody' });
    expect(((await found([`https://youtu.be/${ID.named}`]))[0] as YoutubeLookupFound).suggestedClientId).toBeNull();
  });
});

describe('adding past thumbnails', () => {
  it('makes each a brief already picked and live on the designer’s wall, its round and pick backdated to noon that day', async () => {
    const moments = await db.one<{ n: number }>(`select count(*)::int as n from moments where user_id = $1`, [people.dee.id]);
    const res = await added(people.dee, [
      { videoId: ID.roast, publishedOn: '2026-08-14' },
      { videoId: ID.farm, clientId: globex, publishedOn: '2026-07-02', title: '  We went to the farm  ' },
    ]);
    expect(res.skipped).toEqual([]);
    expect(res.added.map((a) => [a.videoId, a.title])).toEqual([[ID.roast, `Video ${ID.roast}`], [ID.farm, 'We went to the farm']]);
    const [roast, farm] = res.added.map((a) => a.briefId);
    const at = importedRoundAt('2026-08-14', tz);

    expect(await db.one(
      `select title, designer_id, created_by, brief, on_image, due_on, shoot_id, options_wanted, published_url, published_on, published_by,
              published_at is not null as marked, imported_from, imported_by, imported_at is not null as imported, youtube_video_id, youtube_channel,
              youtube_channel_url, test_winner_variant_id, cancelled_at
         from thumbnail_briefs where id = $1`, [roast],
    )).toEqual({
      title: `Video ${ID.roast}`, designer_id: people.dee.id, created_by: people.max.id, brief: null, on_image: null, due_on: null, shoot_id: null, options_wanted: 1,
      published_url: youtubeWatchUrl(ID.roast), published_on: '2026-08-14', published_by: people.max.id, marked: true, imported_from: 'youtube',
      imported_by: people.max.id, imported: true, youtube_video_id: ID.roast, youtube_channel: 'Acme Outdoor', youtube_channel_url: 'https://www.youtube.com/@acmeoutdoor',
      test_winner_variant_id: null, cancelled_at: null,
    });
    // one round sent by the designer, one option of hers, and the manager's pick, all at noon on the day it went live
    const rounds = await db.query(`select number, created_by, note, created_at, sent_at from thumbnail_rounds where brief_id = $1`, [roast]);
    expect(rounds).toEqual([{ number: 1, created_by: people.dee.id, note: null, created_at: at, sent_at: at }]);
    const options = await db.query<{ id: number; letter: string; uploaded_by: number; mime: string; width: number; height: number; note: null; created_at: string; file_by: number; file_mime: string; filename: string }>(
      `select v.id, v.letter, v.uploaded_by, v.mime, v.width, v.height, v.note, v.created_at, f.uploaded_by as file_by, f.mime as file_mime, f.filename
         from thumbnail_variants v join thumbnail_rounds r on r.id = v.round_id join files f on f.id = v.file_id where r.brief_id = $1`, [roast],
    );
    expect(options.map(({ id: _id, ...o }) => o)).toEqual([{
      letter: 'A', uploaded_by: people.dee.id, mime: 'image/jpeg', width: 1280, height: 720, note: null, created_at: at, file_by: people.dee.id, file_mime: 'image/jpeg',
      filename: `Video ${ID.roast}.jpg`,
    }]);
    const decisions = await db.query(
      `select d.action, d.variant_id, d.decided_by, d.note, d.standout, d.created_at, (select count(*)::int from thumbnail_pins p where p.decision_id = d.id) as pins
         from thumbnail_decisions d join thumbnail_rounds r on r.id = d.round_id where r.brief_id = $1`, [roast],
    );
    expect(decisions).toEqual([{ action: 'pick', variant_id: options[0].id, decided_by: people.max.id, note: null, standout: false, created_at: at, pins: 0 }]);

    // a picked, live brief like any other, which says where it came from
    const b = await detail(roast);
    expect([b.state, b.winner?.letter, b.roundsSent, b.live?.publishedOn, b.live?.url, b.can.decide, b.can.markLive]).toEqual(['picked', 'A', 1, '2026-08-14', youtubeWatchUrl(ID.roast), true, true]);
    expect(b.imported).toMatchObject({
      from: 'youtube', videoId: ID.roast, url: youtubeWatchUrl(ID.roast), channel: 'Acme Outdoor', channelUrl: 'https://www.youtube.com/@acmeoutdoor',
      importedById: people.max.id, importedByName: 'Max Manager',
    });
    expect((await detail(roast, people.dee.cookie)).imported?.url).toBe(youtubeWatchUrl(ID.roast));
    // a brief made on the site says nothing of the kind
    const site = await send('POST', '/api/thumbnails', people.max.cookie, { clientId: acme, title: 'Made here', designerId: people.dee.id });
    expect((site.body as ThumbnailBriefDetail).imported).toBeNull();

    // her wall and portfolio: the picture opens for her and the managers, not for a writer
    const studio = (await send('GET', '/api/studio', people.dee.cookie)).body as StudioPayload;
    const win = studio.wins.find((w) => w.briefId === roast)!;
    expect([win.option.uploadedById, win.pickedAt, win.imported, win.live]).toEqual([
      people.dee.id, at, { from: 'youtube', url: youtubeWatchUrl(ID.roast) }, { url: youtubeWatchUrl(ID.roast), publishedOn: '2026-08-14' },
    ]);
    const file = (cookie: string) => app.inject({ method: 'GET', url: win.option.url, headers: { cookie } });
    expect([(await file(people.dee.cookie)).headers['content-type'], (await file(people.max.cookie)).statusCode, (await file(people.wes.cookie)).statusCode])
      .toEqual(['image/jpeg', 200, 404]);
    const card = ((await send('GET', '/api/studio/portfolio', people.dee.cookie)).body as PortfolioPayload).cards.find((c) => c.briefId === farm)!;
    expect([card.title, card.clientName, card.story, card.imported]).toEqual([
      'We went to the farm', 'Globex Studios', { rounds: [], changesAsked: 0, firstRound: false, importedFrom: 'youtube' }, { from: 'youtube', url: youtubeWatchUrl(ID.farm) },
    ]);
    // it's on the board while it's newly added, and the client's recent winners
    const board = (await send('GET', '/api/thumbnails', people.max.cookie)).body as ThumbnailBoard;
    expect(board.briefs.filter((x) => x.id === roast || x.id === farm).map((x) => x.state)).toEqual(['picked', 'picked']);
    expect((await detail(site.body.id)).recentWinners.map((w) => w.briefId)).toContain(roast);

    // no celebration, no went-live message: one quiet notification for the whole import, to her portfolio
    expect((await db.one<{ n: number }>(`select count(*)::int as n from moments where user_id = $1`, [people.dee.id]))!.n).toBe(moments!.n);
    const told = await db.query(
      `select type, title, body, link, dedupe_key, thumbnail_decision_id from notifications where user_id = $1 and (link = $2 or type = 'thumbnail_live')`, [people.dee.id, portfolioPath()],
    );
    expect(told).toEqual([{
      type: 'thumbnail_picked', title: 'Max Manager added 2 past thumbnails to your wall', body: `From YouTube: “Video ${ID.roast}”, “We went to the farm”.`,
      link: portfolioPath(), dedupe_key: thumbImportKey([roast, farm]), thumbnail_decision_id: null,
    }]);
    // and logged, one line each
    const logs = await db.query<{ entity_id: number; summary: string }>(`select entity_id, summary from activity where action = 'thumbnail.imported' order by id`);
    expect(logs.map((l) => [Number(l.entity_id), l.summary])).toEqual([
      [roast, `Added the past thumbnail for “Video ${ID.roast}” (Acme) to Dee Designer’s wall, from YouTube`],
      [farm, 'Added the past thumbnail for “We went to the farm” (Globex Studios) to Dee Designer’s wall, from YouTube'],
    ]);
  });

  it('never makes one added today the Studio’s news', async () => {
    const res = await added(people.dan, [{ videoId: ID.todays, publishedOn: today() }]);
    expect(res.added).toHaveLength(1);
    const studio = (await send('GET', '/api/studio', people.dan.cookie)).body as StudioPayload;
    expect([studio.wins.map((w) => w.briefId), studio.justPicked, studio.hero.kind]).toEqual([[res.added[0].briefId], null, 'clear']);
  });

  it('reads YouTube again, and takes a picture’s type and size only from its own bytes', async () => {
    const before = [await count('thumbnail_briefs'), await count('files')];
    asked.length = 0;
    const res = await added(people.dee, [{ videoId: ID.html }, { videoId: ID.huge }, { videoId: ID.gone }, { videoId: ID.later }]);
    expect(res.skipped).toEqual([
      { videoId: ID.html, problem: YOUTUBE_PROBLEMS.notPicture },
      { videoId: ID.huge, problem: YOUTUBE_PROBLEMS.tooBig },
      { videoId: ID.gone, problem: YOUTUBE_PROBLEMS.notFound },
    ]);
    // one that can't be added never fails the others
    expect(res.added.map((a) => a.videoId)).toEqual([ID.later]);
    expect([await count('thumbnail_briefs'), await count('files')]).toEqual([before[0] + 1, before[1] + 1]);
    // the biggest picture, read again for each, never a picture the browser sent
    expect(asked.filter((a) => a.startsWith('picture:')).sort()).toEqual([ID.gone, ID.html, ID.huge, ID.later].map((id) => `picture:${id}:best`).sort());
    expect((await db.one(`select f.mime from files f join thumbnail_variants v on v.file_id = f.id join thumbnail_rounds r on r.id = v.round_id where r.brief_id = $1`, [res.added[0].briefId]))).toEqual({ mime: 'image/jpeg' });
  });

  it('refuses a designer who isn’t one, a client that can’t take it, a day that can’t be, and a video twice or that isn’t one', async () => {
    const before = [await count('thumbnail_briefs'), await count('files'), await count('notifications')];
    const item = { videoId: ID.solo, clientId: acme, publishedOn: '2026-08-14' };
    for (const designerId of [people.wes.id, people.vic.id, people.max.id, 999_999]) {
      expect(fieldsOf(await add({ designerId, items: [item] }))).toEqual([400, ['designerId']]);
    }
    expect(fieldsOf(await add({ items: [item] }))).toEqual([400, ['designerId']]);
    expect(fieldsOf(await add({ designerId: people.dee.id, items: [] }))).toEqual([400, ['items']]);
    expect(fieldsOf(await add({ designerId: people.dee.id, items: [item, { ...item, clientId: globex }] }))).toEqual([400, ['items']]);
    expect((await add({ designerId: people.dee.id, items: [item, item] })).body.error.fields.items).toBe(YOUTUBE_PROBLEMS.twice);
    expect((await add({ designerId: people.dee.id, items: [{ ...item, videoId: 'https://youtu.be/soloVideo16' }] })).body.error.fields.items).toBe(YOUTUBE_PROBLEMS.notLink);
    const tooMany = Array.from({ length: YOUTUBE_IMPORT_LIMITS.links + 1 }, (_, i) => ({ ...item, videoId: `many${String(i).padStart(7, '0')}` }));
    expect(fieldsOf(await add({ designerId: people.dee.id, items: tooMany }))).toEqual([400, ['items']]);
    // the client must exist and not be archived, and each problem is named by its item
    const clients = await add({ designerId: people.dee.id, items: [{ ...item, clientId: oldMill }, { ...item, videoId: ID.rae1, clientId: 999_999 }] });
    expect([clients.status, clients.body.error.fields]).toEqual([400, { 'items.0.clientId': 'This client is archived', 'items.1.clientId': 'Choose a client' }]);
    // the day: needed, real, not before YouTube and not still to come (the dialog's own words)
    const days = await add({
      designerId: people.dee.id,
      items: [{ ...item, publishedOn: addDays(today(), 1) }, { ...item, videoId: 'dayVideo001', publishedOn: '2026-02-30' }, { ...item, videoId: 'dayVideo002', publishedOn: '1999-01-01' }, { ...item, videoId: 'dayVideo003', publishedOn: '' }],
    });
    expect([days.status, days.body.error.fields]).toEqual([400, {
      'items.0.publishedOn': 'That day hasn’t come yet', 'items.1.publishedOn': 'Use a valid date', 'items.2.publishedOn': 'That’s before YouTube began',
      'items.3.publishedOn': 'Add the day it went live',
    }]);
    // nobody else may add them; while an Admin views as a manager it's refused like every other change
    expect((await add({ designerId: people.dee.id, items: [item] }, people.wes.cookie)).status).toBe(403);
    const asDesigner = await add({ designerId: people.dee.id, items: [item] }, people.dee.cookie);
    expect([asDesigner.status, asDesigner.body.error.code]).toEqual([403, 'editor']);
    expect((await send('POST', '/api/admin/view-as', admin, { userId: people.max.id })).status).toBe(200);
    const viewing = await add({ designerId: people.dee.id, items: [item] }, admin);
    expect([viewing.status, viewing.body.error.code]).toEqual([403, 'viewing_as']);
    const viewingLookup = await lookup([`https://youtu.be/${ID.solo}`], admin);
    expect([viewingLookup.status, viewingLookup.body.error.code]).toEqual([403, 'viewing_as']);
    expect((await send('POST', '/api/admin/view-as/stop', admin, {})).status).toBe(200);
    expect([await count('thumbnail_briefs'), await count('files'), await count('notifications')]).toEqual(before);
    // without a way to read YouTube
    ctx.youtube = null;
    const off = await add({ designerId: people.dee.id, items: [item] });
    expect([off.status, off.body.error.code]).toEqual([503, 'not_configured']);
  });

  it('skips a video already on a brief, naming it, and the unique index decides when two adds race', async () => {
    const first = await added(people.dee, [{ videoId: ID.again }]);
    const briefId = first.added[0].briefId;
    const notes = await count('notifications');
    // again, and in a lookup: named and linked, without asking YouTube
    asked.length = 0;
    const second = await added(people.dan, [{ videoId: ID.again }]);
    expect(second).toEqual({ added: [], skipped: [{ videoId: ID.again, problem: youtubeAlreadyOnSite(`Video ${ID.again}`), existing: { briefId, title: `Video ${ID.again}` } }] });
    const row = (await found([`https://m.youtube.com/watch?v=${ID.again}`]))[0];
    expect(row).toMatchObject({ ok: false, problem: youtubeAlreadyOnSite(`Video ${ID.again}`), videoId: ID.again, existing: { briefId, title: `Video ${ID.again}` } });
    expect(asked).toEqual([]);
    // an import that added nothing tells nobody
    expect(await count('notifications')).toBe(notes);

    // another manager adds the same video while YouTube is being read for this one: the index refuses the second,
    // which keeps nothing of it (its picture included)
    let raced = 0;
    during.set(ID.race, async () => {
      during.delete(ID.race);
      raced = (await added(people.dan, [{ videoId: ID.race, title: 'Got there first' }])).added[0].briefId;
    });
    const files = await count('files');
    const late = await added(people.dee, [{ videoId: ID.race }, { videoId: ID.cancel }]);
    during.delete(ID.race);
    expect(late.skipped).toEqual([{ videoId: ID.race, problem: youtubeAlreadyOnSite('Got there first'), existing: { briefId: raced, title: 'Got there first' } }]);
    expect(late.added.map((a) => a.videoId)).toEqual([ID.cancel]);
    expect(await count('files')).toBe(files + 2);

    // a cancelled brief gives its video back: changes asked on the import, then cancelled
    const cancelled = late.added[0].briefId;
    const round = (await detail(cancelled)).rounds[0];
    expect((await send('POST', `/api/thumbnails/${cancelled}/decision`, people.max.cookie, { roundId: round.id, action: 'changes', note: 'Wrong client' })).status).toBe(200);
    expect((await send('PATCH', `/api/thumbnails/${cancelled}`, people.max.cookie, { cancelled: true })).status).toBe(200);
    expect((await added(people.dee, [{ videoId: ID.cancel, clientId: globex }])).added).toHaveLength(1);
    // so the cancelled one can't be reopened while its video is on the new brief: 409, naming it, and it stays cancelled
    const reopen = await send('PATCH', `/api/thumbnails/${cancelled}`, people.max.cookie, { cancelled: false });
    expect([reopen.status, reopen.body.error.code]).toEqual([409, 'youtube_taken']);
    expect(reopen.body.error.message).toContain(`“Video ${ID.cancel}”`);
    expect((await detail(cancelled)).state).toBe('cancelled');
  });

  it('suggests the client an earlier import from the same channel went to, the newest one’s, before a name', async () => {
    const suggested = async () => ((await found([`https://youtu.be/${ID.named}`]))[0] as YoutubeLookupFound).suggestedClientId;
    // a video from a channel named like Acme: Acme, until a video from that channel was added for Globex
    video(ID.named, { channel: 'Acme', channelUrl: 'https://www.youtube.com/@SomeBody/' });
    expect(await suggested()).toBe(acme);
    video(ID.solo, { channel: 'Somebody', channelUrl: 'https://www.youtube.com/@somebody' });
    await added(people.dee, [{ videoId: ID.solo, clientId: globex }]);
    expect(await suggested()).toBe(globex);
    // the newest import from the channel wins
    video(ID.newer, { channel: 'Somebody', channelUrl: 'https://www.youtube.com/@somebody' });
    await added(people.dan, [{ videoId: ID.newer, clientId: acme }]);
    expect(await suggested()).toBe(acme);
  });
});

describe('the went-live link and its YouTube video', () => {
  /** A brief picked on the site (one option, picked). */
  async function picked(title: string): Promise<number> {
    const b = (await send('POST', '/api/thumbnails', people.max.cookie, { clientId: acme, title, designerId: people.dee.id })).body as ThumbnailBriefDetail;
    const boundary = '----yt';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), jpeg(), Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const up = await app.inject({ method: 'POST', url: `/api/thumbnails/${b.id}/options`, headers: { 'x-scale-media': '1', cookie: people.dee.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
    expect(up.statusCode).toBe(200);
    const sent = (await send('POST', `/api/thumbnails/${b.id}/send`, people.dee.cookie, {})).body as ThumbnailBriefDetail;
    expect((await send('POST', `/api/thumbnails/${b.id}/decision`, people.max.cookie, { roundId: sent.rounds[0].id, action: 'pick', optionId: sent.rounds[0].options[0].id })).status).toBe(200);
    return b.id;
  }
  const videoOf = async (id: number) => (await db.one<{ v: string | null }>(`select youtube_video_id as v from thumbnail_briefs where id = $1`, [id]))!.v;
  const mark = (id: number, body: unknown) => send('POST', `/api/thumbnails/${id}/published`, people.max.cookie, body);

  it('keeps the video of a YouTube link, clears it with any other link or none, and refuses one already on another brief', async () => {
    const p = await picked('Marked by hand');
    expect((await mark(p, { url: `https://youtu.be/${ID.live}?t=3`, publishedOn: '2026-10-20' })).status).toBe(200);
    expect(await videoOf(p)).toBe(ID.live);
    // so the lookup names it
    expect((await found([youtubeWatchUrl(ID.live)]))[0]).toMatchObject({ ok: false, existing: { briefId: p, title: 'Marked by hand' } });
    // a note alone keeps it; another link, or none, takes it away
    expect((await mark(p, { testNote: 'Won' })).status).toBe(200);
    expect(await videoOf(p)).toBe(ID.live);
    expect((await mark(p, { url: 'https://vimeo.com/123' })).status).toBe(200);
    expect(await videoOf(p)).toBeNull();
    expect((await mark(p, { url: youtubeWatchUrl(ID.live) })).status).toBe(200);
    expect(await videoOf(p)).toBe(ID.live);
    expect((await mark(p, { url: null, publishedOn: null, testNote: null })).status).toBe(200);
    expect([await videoOf(p), (await detail(p)).live]).toEqual([null, null]);

    // a link to a video already on another brief (an import here) is 409, naming it beside the link
    const q = await picked('Wrong link');
    const r = await mark(q, { url: `https://www.youtube.com/watch?v=${ID.roast}`, publishedOn: '2026-10-20' });
    expect([r.status, r.body.error.code, Object.keys(r.body.error.fields)]).toEqual([409, 'youtube_taken', ['url']]);
    expect(r.body.error.message).toContain(`“Video ${ID.roast}”`);
    expect([await videoOf(q), (await detail(q)).live]).toEqual([null, null]);

    // a new pick takes the mark back, and the video with it
    expect((await mark(q, { url: youtubeWatchUrl(ID.taken), publishedOn: '2026-10-20' })).status).toBe(200);
    expect(await videoOf(q)).toBe(ID.taken);
    const round = (await detail(q)).rounds[0];
    expect((await send('POST', `/api/thumbnails/${q}/decision`, people.max.cookie, { roundId: round.id, action: 'changes', note: 'Again' })).status).toBe(200);
    expect(await videoOf(q)).toBeNull();
  });

  it('leaves a past thumbnail from YouTube with the video it came from, whatever its link says', async () => {
    const id = (await db.one<{ id: number }>(`select id from thumbnail_briefs where youtube_video_id = $1`, [ID.roast]))!.id;
    expect((await mark(id, { url: 'https://vimeo.com/999', testNote: 'Also on Vimeo' })).status).toBe(200);
    expect(await videoOf(id)).toBe(ID.roast);
    const b = await detail(id);
    expect([b.live?.url, b.imported?.url]).toEqual(['https://vimeo.com/999', youtubeWatchUrl(ID.roast)]);
    expect((await mark(id, { url: null, publishedOn: null, testNote: null })).status).toBe(200);
    expect([await videoOf(id), (await detail(id)).imported?.videoId]).toEqual([ID.roast, ID.roast]);
  });
});

describe('growth', () => {
  it('counts a past thumbnail in the month it went live, but leaves it out of the first-round pick rate', async () => {
    const rae = await person('Rae Rows', 'editor', 'thumbnail');
    const growth = async () => ((await send('GET', '/api/studio/portfolio', rae.cookie)).body as PortfolioPayload).growth;
    // only an import: a pick, and no first-round rate to give
    const month = today().slice(0, 7);
    await added(rae, [{ videoId: ID.rae1, publishedOn: `${month}-01` }]);
    let g = await growth();
    expect([g.picks, g.importedPicks, g.roundPicks, g.firstRoundPicks, g.firstRoundRate, g.months.at(-1)?.picks]).toEqual([1, 1, 0, 0, null, 1]);
    // and a pick on the site after changes: one of one round pick wasn't from the first round (0%, not 50%)
    const b = (await send('POST', '/api/thumbnails', people.max.cookie, { clientId: acme, title: 'Rae’s own', designerId: rae.id })).body as ThumbnailBriefDetail;
    const upload = async () => {
      const boundary = '----rae';
      const payload = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), jpeg(), Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      expect((await app.inject({ method: 'POST', url: `/api/thumbnails/${b.id}/options`, headers: { 'x-scale-media': '1', cookie: rae.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload })).statusCode).toBe(200);
      return ((await send('POST', `/api/thumbnails/${b.id}/send`, rae.cookie, {})).body as ThumbnailBriefDetail).rounds.at(-1)!;
    };
    const r1 = await upload();
    expect((await send('POST', `/api/thumbnails/${b.id}/decision`, people.max.cookie, { roundId: r1.id, action: 'changes', note: 'Warmer' })).status).toBe(200);
    const r2 = await upload();
    expect((await send('POST', `/api/thumbnails/${b.id}/decision`, people.max.cookie, { roundId: r2.id, action: 'pick', optionId: r2.options[0].id })).status).toBe(200);
    g = await growth();
    expect([g.picks, g.importedPicks, g.roundPicks, g.firstRoundPicks, g.firstRoundRate]).toEqual([2, 1, 1, 0, 0]);
  });
});

describe('the YouTube API key', () => {
  it('never reaches an answer, a log or an error', async () => {
    const KEY = 'AIzaSy-secret-test-key-0000';
    const logged: string[] = [];
    for (const m of ['log', 'warn', 'error', 'info'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : String(x))).join(' ')); });
    }
    const seen: string[] = [];
    // YouTube's API turns the key down and echoes it back; everything else answers as it would
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      seen.push(url);
      if (url.startsWith('https://www.googleapis.com/')) {
        return new Response(JSON.stringify({ error: { code: 400, message: `API key not valid: ${KEY}` } }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
      if (url.startsWith('https://www.youtube.com/oembed')) {
        return url.includes(ID.gone)
          ? new Response(`Not Found ${KEY}`, { status: 404 })
          : new Response(JSON.stringify({ title: 'Keyed video', author_name: 'Acme', author_url: 'https://www.youtube.com/@acme' }), { status: 200 });
      }
      if (url.startsWith('https://www.youtube.com/watch')) return new Response('<meta itemprop="datePublished" content="2026-08-01T10:00:00-07:00">', { status: 200 });
      if (url.startsWith('https://i.ytimg.com/')) throw new TypeError(`fetch failed for ${url} with ${KEY}`);
      return new Response('', { status: 404 });
    };
    ctx.youtube = youtubeReader({ apiKey: KEY, fetch: fetchImpl });
    const rows = await lookup(['https://youtu.be/keyedVideo2', `https://youtu.be/${ID.gone}`, 'nope']);
    const imported = await add({ designerId: people.dee.id, items: [{ videoId: 'keyedVideo1', clientId: acme, publishedOn: '2026-08-01' }] });
    // the key was used (on the API's address only), and is nowhere in what came back or was logged
    expect(seen.some((u) => u.startsWith('https://www.googleapis.com/') && u.includes(encodeURIComponent(KEY)))).toBe(true);
    expect(seen.filter((u) => u.includes(KEY) || u.includes(encodeURIComponent(KEY))).every((u) => u.startsWith('https://www.googleapis.com/'))).toBe(true);
    expect([rows.status, imported.status]).toEqual([200, 200]);
    expect((rows.body as YoutubeLookupResult).rows.map((r) => [r.ok, r.ok ? r.publishedOn : r.problem])).toEqual([
      [true, '2026-08-01'], [false, YOUTUBE_PROBLEMS.notFound], [false, YOUTUBE_PROBLEMS.notLink],
    ]);
    expect(imported.body).toEqual({ added: [], skipped: [{ videoId: 'keyedVideo1', problem: YOUTUBE_PROBLEMS.unreachable }] });
    const everything = JSON.stringify([rows.body, imported.body, logged]);
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain(encodeURIComponent(KEY));
    expect(logged.length).toBeGreaterThan(0);
  });
});
