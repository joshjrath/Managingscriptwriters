// Thumbnail Studio, phase 4, through its routes: marking a picked thumbnail live (managers only, picked only, https
// links, the day, a Test & Compare winner among the brief's sent options, only the fields sent changing, clearing, its
// maker told once per pick and that taken back, and a new pick taking the mark back), the Timeliner video a brief is
// for (the picker's list, managers only and scoped to the client, and the link checked on New thumbnail and Edit), the
// board's "mark it live?" prompt, a designer's portfolio (their own unless a manager names one, the filters checked,
// the round story and the growth figures worked out again after a superseding decision and a cancel), and the longer
// cache on thumbnail pictures (which signing out clears).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import type { Db } from '../server/db';
import type { Ctx } from '../server/core';
import type {
  PortfolioPayload, StudioPayload, ThumbnailBoard, ThumbnailBriefDetail, TimelinerVideoChoices, UserSummary,
} from '../shared/types';
import { monthOf } from '../shared/dates';
import { fmtDate } from '../shared/format';
import { portfolioPath, thumbLiveKey, timelinerVideoUrl } from '../shared/workflow';
import { freshDb } from './db';

let db: Db;
let app: FastifyInstance;
let admin = '';
let acme = 0;
let globex = 0;
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

/** The status and the fields a refusal names. */
const fieldsOf = (r: Res) => [r.status, Object.keys(r.body?.error?.fields ?? {})];

async function person(name: string, role: string, editorKind?: string): Promise<Person> {
  const email = `${name.toLowerCase().replace(/\W+/g, '.')}@scale.test`;
  const r = await send('POST', '/api/users', admin, { name, email, role, password: 'team-password-1', ...(editorKind ? { editorKind } : {}) });
  expect([r.status, r.body?.error]).toEqual([200, undefined]);
  const login = await app.inject({
    method: 'POST', url: '/api/auth/login', headers: { 'x-scale-media': '1', 'content-type': 'application/json' }, payload: JSON.stringify({ email, password: 'team-password-1' }),
  });
  return { id: (r.body.users as UserSummary[]).find((u) => u.email === email)!.id, cookie: String(login.headers['set-cookie']).split(';')[0] };
}

/** A PNG's header, as wide and tall as asked. */
function png(width = 1280, height = 720): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[24] = 8;
  b[25] = 2;
  return b;
}

type Upload = { name: string; type: string; data: Buffer };

/** A multipart form: text fields, then one file. */
async function form(url: string, cookie: string, fields: Record<string, string>, file: Upload): Promise<Res> {
  const boundary = '----phase-four';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.data, Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const r = await app.inject({ method: 'POST', url, headers: { 'x-scale-media': '1', cookie, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(parts) });
  return { status: r.statusCode, body: JSON.parse(r.body) };
}

const option = async (briefId: number, cookie: string) => {
  const r = await form(`/api/thumbnails/${briefId}/options`, cookie, {}, { name: 'cover.png', type: 'image/png', data: png() });
  expect([r.status, r.body?.error]).toEqual([200, undefined]);
  return r.body as ThumbnailBriefDetail;
};
const sendRound = async (id: number, cookie: string) => {
  const r = await send('POST', `/api/thumbnails/${id}/send`, cookie, {});
  expect([r.status, r.body?.error]).toEqual([200, undefined]);
  return r.body as ThumbnailBriefDetail;
};
const decide = async (id: number, body: Record<string, unknown>) => {
  const r = await send('POST', `/api/thumbnails/${id}/decision`, people.max.cookie, body);
  expect([r.status, r.body?.error]).toEqual([200, undefined]);
  return r.body as ThumbnailBriefDetail;
};
const detail = async (id: number, cookie: string) => (await send('GET', `/api/thumbnails/${id}`, cookie)).body as ThumbnailBriefDetail;
const published = (id: number, body: unknown, cookie = people.max.cookie) => send('POST', `/api/thumbnails/${id}/published`, cookie, body);
const portfolio = (cookie: string, q = '') => send('GET', `/api/studio/portfolio${q}`, cookie);
const mine = async (who: Person, q = '') => {
  const r = await portfolio(who.cookie, q);
  expect([r.status, r.body?.error]).toEqual([200, undefined]);
  return r.body as PortfolioPayload;
};
const board = async (q = '') => (await send('GET', `/api/thumbnails${q}`, people.max.cookie)).body as ThumbnailBoard;
const videos = (cookie: string, q: string) => send('GET', `/api/thumbnails/timeliner-videos${q}`, cookie);

async function brief(designerId: number | null, o: { title?: string; clientId?: number; timelinerTaskId?: string | null } = {}): Promise<ThumbnailBriefDetail> {
  const r = await send('POST', '/api/thumbnails', people.max.cookie, {
    clientId: o.clientId ?? acme, title: o.title ?? 'Morning routine', designerId, ...(o.timelinerTaskId !== undefined ? { timelinerTaskId: o.timelinerTaskId } : {}),
  });
  expect([r.status, r.body?.error]).toEqual([200, undefined]);
  return r.body as ThumbnailBriefDetail;
}

/** A brief picked from round 1 (options A and B by its designer, A picked). */
async function picked(designer: Person, o: { title?: string; clientId?: number; timelinerTaskId?: string; standout?: boolean } = {}) {
  const b = await brief(designer.id, o);
  await option(b.id, designer.cookie);
  await option(b.id, designer.cookie);
  const round = (await sendRound(b.id, designer.cookie)).rounds[0];
  await decide(b.id, { roundId: round.id, action: 'pick', optionId: round.options[0].id, standout: !!o.standout });
  return { id: b.id, round, a: round.options[0], b: round.options[1] };
}

/** The decision that counts on a round. */
const decisionOn = async (roundId: number) =>
  (await db.one<{ id: number }>(`select id from thumbnail_decisions where round_id = $1 order by created_at desc, id desc limit 1`, [roundId]))!.id;
const markRow = (id: number) => db.one<{
  published_url: string | null; published_on: string | null; published_by: number | null; published_at: string | null; test_winner_variant_id: number | null; test_note: string | null;
}>(`select published_url, published_on, published_by, published_at, test_winner_variant_id, test_note from thumbnail_briefs where id = $1`, [id]);
/** What someone was told about one brief going live, any of its picks (dedupe keys thumbLiveKey(briefId, optionId)). */
const liveNotes = (userId: number, briefId: number) => db.query<{
  id: number; title: string; body: string; link: string | null; read_at: string | null; thumbnail_decision_id: number | null; dedupe_key: string;
}>(
  `select id, title, body, link, read_at, thumbnail_decision_id, dedupe_key from notifications
    where user_id = $1 and type = 'thumbnail_live' and dedupe_key like $2 order by id`,
  [userId, `thumbnail_live:${briefId}:%`],
);
const logs = (briefId: number, action: string) =>
  db.query<{ summary: string }>(`select summary from activity where entity_type = 'thumbnail' and entity_id = $1 and action = $2 order by id`, [briefId, action]);

/** A video in the site's copy of Timeliner, matched to a client. */
async function task(id: string, title: string, clientId: number | null, statusGroup: string, o: { createdAt?: string; movedAt?: string | null; stepLabel?: string } = {}) {
  await db.query(
    `insert into timeliner_tasks (id, title, status_group, step_label, client_id, created_at, updated_at, moved_at) values ($1, $2, $3, $4, $5, $6, $6, $7)`,
    [id, title, statusGroup, o.stepLabel ?? null, clientId, o.createdAt ?? ago(1), o.movedAt ?? null],
  );
}
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

beforeAll(async () => {
  db = await freshDb();
  // the site's clock is the database's: picks, notes and moves all happen "now"
  const ctx: Ctx = { db, now: () => new Date(), secureCookies: false, allowSetup: true, uploadLimitBytes: 1024 * 1024 };
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
  globex = (await send('POST', '/api/clients', admin, { name: 'Globex' })).body.clientId;
  tz = (await db.one<{ timezone: string }>(`select timezone from settings where id = 1`))!.timezone;
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('marking a picked thumbnail live', () => {
  it('is for managers only, and only while the brief is picked', async () => {
    const b = await brief(people.dee.id, { title: 'Not yet' });
    await option(b.id, people.dee.cookie);
    const round = (await sendRound(b.id, people.dee.cookie)).rounds[0];
    const day = { publishedOn: '2026-10-20' };
    // waiting for a decision, then changes asked: not picked
    let r = await published(b.id, day);
    expect([r.status, r.body.error.code]).toEqual([409, 'not_picked']);
    expect((await detail(b.id, people.max.cookie)).can.markLive).toBe(false);
    await decide(b.id, { roundId: round.id, action: 'changes', note: 'Warmer' });
    r = await published(b.id, day);
    expect([r.status, r.body.error.code]).toEqual([409, 'not_picked']);
    expect(await markRow(b.id)).toMatchObject({ published_on: null });
    // nobody else may, picked or not; an unknown brief is not found
    const p = await picked(people.dee, { title: 'Picked one' });
    expect((await published(p.id, day, people.wes.cookie)).status).toBe(403);
    const asDesigner = await published(p.id, day, people.dee.cookie);
    expect([asDesigner.status, asDesigner.body.error.code]).toEqual([403, 'editor']);
    expect((await published(p.id, day, people.vic.cookie)).status).toBe(403);
    expect((await published(999_999, day)).status).toBe(404);
    expect(await markRow(p.id)).toMatchObject({ published_on: null });
    // the manager may, and only the manager is offered it
    expect((await detail(p.id, people.max.cookie)).can.markLive).toBe(true);
    expect((await detail(p.id, people.dee.cookie)).can.markLive).toBe(false);
    expect((await published(p.id, day)).status).toBe(200);
  });

  it('checks the link (https only), the day, the note and that the test winner was sent on this brief', async () => {
    const b = await brief(people.dee.id, { title: 'Checked' });
    await option(b.id, people.dee.cookie);
    await option(b.id, people.dee.cookie);
    const round = (await sendRound(b.id, people.dee.cookie)).rounds[0];
    // changes asked, an option put in the next round's tray, and then the manager picks from round 1 after all
    await decide(b.id, { roundId: round.id, action: 'changes', note: 'Try a close-up' });
    const tray = (await option(b.id, people.dee.cookie)).tray!.options[0];
    await decide(b.id, { roundId: round.id, action: 'pick', optionId: round.options[0].id });
    const other = await picked(people.dan, { title: 'Elsewhere' });
    const ok = { url: 'https://youtu.be/abc123', publishedOn: '2026-10-20' };
    for (const [body, field] of [
      [{ ...ok, url: 'http://youtu.be/abc123' }, 'url'],
      [{ ...ok, url: 'javascript:alert(1)' }, 'url'],
      [{ ...ok, url: 'youtu.be/abc123' }, 'url'],
      [{ ...ok, url: `https://youtu.be/${'a'.repeat(500)}` }, 'url'],
      [{ ...ok, publishedOn: null }, 'publishedOn'],
      [{ url: ok.url }, 'publishedOn'],
      [{ ...ok, publishedOn: '2026-02-30' }, 'publishedOn'],
      [{ ...ok, publishedOn: '0026-10-20' }, 'publishedOn'],
      [{ ...ok, testNote: 'x'.repeat(301) }, 'testNote'],
      [{ ...ok, testWinnerOptionId: other.a.id }, 'testWinnerOptionId'],
      [{ ...ok, testWinnerOptionId: tray.id }, 'testWinnerOptionId'],
    ] as const) {
      expect([JSON.stringify(body).slice(0, 60), ...fieldsOf(await published(b.id, body))]).toEqual([JSON.stringify(body).slice(0, 60), 400, [field]]);
    }
    expect(await markRow(b.id)).toMatchObject({ published_on: null, published_url: null, test_winner_variant_id: null });
    // a sent option of an earlier decision's round, the pick or not, is fine; the note may be 300 characters
    const r = await published(b.id, { ...ok, testWinnerOptionId: round.options[1].id, testNote: 'y'.repeat(300) });
    expect([r.status, r.body?.error]).toEqual([200, undefined]);
    expect((r.body as ThumbnailBriefDetail).live?.testWinner).toEqual({ optionId: round.options[1].id, letter: 'B', roundNumber: 1, isPick: false, url: round.options[1].url });
  });

  it('shows the mark, tells the maker once, and takes it back when cleared', async () => {
    const p = await picked(people.dee, { title: 'Went out' });
    const pick = await decisionOn(p.round.id);
    const r = await published(p.id, { url: '  https://youtu.be/went-out ', publishedOn: '2026-10-20', testWinnerOptionId: p.a.id, testNote: '  A won on clicks ' });
    expect([r.status, r.body?.error]).toEqual([200, undefined]);
    const live = (r.body as ThumbnailBriefDetail).live!;
    expect(live).toMatchObject({
      url: 'https://youtu.be/went-out', publishedOn: '2026-10-20', publishedById: people.max.id, publishedByName: 'Max Manager',
      testWinner: { optionId: p.a.id, letter: 'A', roundNumber: 1, isPick: true, url: p.a.url }, testNote: 'A won on clicks',
    });
    expect(typeof live.publishedAt).toBe('string');
    // the designer reads it on the brief, and the win on their Studio carries the Live badge
    expect((await detail(p.id, people.dee.cookie)).live).toEqual(live);
    const studio = (await send('GET', '/api/studio', people.dee.cookie)).body as StudioPayload;
    expect(studio.wins.find((w) => w.briefId === p.id)?.live).toEqual({ url: 'https://youtu.be/went-out', publishedOn: '2026-10-20' });
    // told once, linking to their portfolio card, and naming the pick (so deciding again takes it back)
    const told = await liveNotes(people.dee.id, p.id);
    expect(told.map((n) => [n.title, n.link, n.thumbnail_decision_id, n.dedupe_key])).toEqual([
      ['Your thumbnail for “Went out” went live', portfolioPath({ card: p.a.id }), pick, thumbLiveKey(p.id, p.a.id)],
    ]);
    expect(await logs(p.id, 'thumbnail.live')).toEqual([{ summary: `Marked the thumbnail for “Went out” live on ${fmtDate('2026-10-20')}` }]);
    // the same again changes nothing; a new link is logged, but not told again
    expect((await published(p.id, { url: 'https://youtu.be/went-out', publishedOn: '2026-10-20', testWinnerOptionId: p.a.id, testNote: 'A won on clicks' })).status).toBe(200);
    expect(await logs(p.id, 'thumbnail.live')).toHaveLength(1);
    expect((await published(p.id, { url: 'https://youtu.be/new-link', publishedOn: '2026-10-20', testWinnerOptionId: p.a.id, testNote: 'A won on clicks' })).status).toBe(200);
    expect((await logs(p.id, 'thumbnail.live')).map((l) => l.summary)).toEqual([
      `Marked the thumbnail for “Went out” live on ${fmtDate('2026-10-20')}`, 'Went-live mark on the thumbnail for “Went out”: the video’s link',
    ]);
    expect(await liveNotes(people.dee.id, p.id)).toHaveLength(1);
    // every field null takes it all back, and what she hasn't read yet
    const cleared = await published(p.id, { url: null, publishedOn: null, testWinnerOptionId: null, testNote: null });
    expect([cleared.status, (cleared.body as ThumbnailBriefDetail).live]).toEqual([200, null]);
    expect(await markRow(p.id)).toEqual({ published_url: null, published_on: null, published_by: null, published_at: null, test_winner_variant_id: null, test_note: null });
    expect(await liveNotes(people.dee.id, p.id)).toEqual([]);
    expect(await logs(p.id, 'thumbnail.unlive')).toEqual([{ summary: 'Took back the went-live mark on the thumbnail for “Went out”' }]);
    expect((await published(p.id, { publishedOn: null })).status).toBe(200);
    expect(await logs(p.id, 'thumbnail.unlive')).toHaveLength(1);
    // marked again: told afresh; once read, taking it back and marking it again never tells her a second time
    expect((await published(p.id, { publishedOn: '2026-10-21' })).status).toBe(200);
    expect(await liveNotes(people.dee.id, p.id)).toHaveLength(1);
    await db.query(`update notifications set read_at = now() where user_id = $1 and type = 'thumbnail_live'`, [people.dee.id]);
    expect((await published(p.id, { publishedOn: null })).status).toBe(200);
    expect((await published(p.id, { publishedOn: '2026-10-22' })).status).toBe(200);
    expect((await liveNotes(people.dee.id, p.id)).map((n) => !!n.read_at)).toEqual([true]);
  });

  it('changes only the fields sent, so a day fixed alone or two managers’ edits keep everything else', async () => {
    const p = await picked(people.dee, { title: 'Two editors' });
    expect((await published(p.id, { url: 'https://youtu.be/u1', publishedOn: '2026-10-20', testWinnerOptionId: p.b.id, testNote: 'B won' })).status).toBe(200);
    // only the day sent: the link, the test winner and the note stay
    const day = await published(p.id, { publishedOn: '2026-10-21' });
    expect([day.status, (day.body as ThumbnailBriefDetail).live]).toMatchObject([200, {
      url: 'https://youtu.be/u1', publishedOn: '2026-10-21', testWinner: { optionId: p.b.id }, testNote: 'B won',
    }]);
    // two managers in the dialog at once: one corrects the link, then the other saves a new note; both stay
    const sam = await person('Sam Second', 'manager');
    expect((await published(p.id, { url: 'https://youtu.be/u2' }, sam.cookie)).status).toBe(200);
    const note = await published(p.id, { testNote: 'B won, mostly on phones' });
    expect((note.body as ThumbnailBriefDetail).live).toMatchObject({
      url: 'https://youtu.be/u2', publishedOn: '2026-10-21', testWinner: { optionId: p.b.id }, testNote: 'B won, mostly on phones', publishedById: people.max.id,
    });
    expect((await logs(p.id, 'thumbnail.live')).map((l) => l.summary)).toEqual([
      `Marked the thumbnail for “Two editors” live on ${fmtDate('2026-10-20')}`, `Went-live mark on the thumbnail for “Two editors”: live on ${fmtDate('2026-10-21')}`,
      'Went-live mark on the thumbnail for “Two editors”: the video’s link', 'Went-live mark on the thumbnail for “Two editors”: the note',
    ]);
    // a mark keeps its day (emptying it alone is refused), and every field sent empty takes it back
    expect(fieldsOf(await published(p.id, { publishedOn: null }))).toEqual([400, ['publishedOn']]);
    expect(fieldsOf(await published(p.id, { url: 'http://youtu.be/u3' }))).toEqual([400, ['url']]);
    expect((await detail(p.id, people.max.cookie)).live?.url).toBe('https://youtu.be/u2');
    const back = await published(p.id, { url: null, publishedOn: null, testWinnerOptionId: null, testNote: null });
    expect([back.status, (back.body as ThumbnailBriefDetail).live]).toEqual([200, null]);
  });

  it('tells the maker afresh when another option is picked later and marked live', async () => {
    const p = await picked(people.dee, { title: 'Second winner' });
    expect((await published(p.id, { url: 'https://youtu.be/first', publishedOn: '2026-10-20' })).status).toBe(200);
    await db.query(`update notifications set read_at = now() where user_id = $1 and type = 'thumbnail_live'`, [people.dee.id]);
    // changes asked: the mark goes, while the message she has read stays in her history
    await decide(p.id, { roundId: p.round.id, action: 'changes', note: 'Brighter, please' });
    expect(await markRow(p.id)).toMatchObject({ published_on: null });
    await option(p.id, people.dee.cookie);
    const next = (await sendRound(p.id, people.dee.cookie)).rounds.find((r) => r.number === 2)!;
    await decide(p.id, { roundId: next.id, action: 'pick', optionId: next.options[0].id });
    expect((await published(p.id, { url: 'https://youtu.be/second', publishedOn: '2026-10-24' })).status).toBe(200);
    // the new pick is news of its own, linking to the card that's on her wall now
    const told = async () => (await liveNotes(people.dee.id, p.id)).map((n) => [n.dedupe_key, n.link, !!n.read_at]);
    expect(await told()).toEqual([
      [thumbLiveKey(p.id, p.a.id), portfolioPath({ card: p.a.id }), true],
      [thumbLiveKey(p.id, next.options[0].id), portfolioPath({ card: next.options[0].id }), false],
    ]);
    // and still told once about it, however the mark changes
    expect((await published(p.id, { url: 'https://youtu.be/second-cut' })).status).toBe(200);
    expect(await told()).toHaveLength(2);
  });

  it('shows another designer’s Test & Compare option to a designer only by its letter', async () => {
    const b = await brief(people.dee.id, { title: 'Handed over' });
    await option(b.id, people.dee.cookie);
    await option(b.id, people.dee.cookie);
    const first = (await sendRound(b.id, people.dee.cookie)).rounds[0];
    expect((await send('PATCH', `/api/thumbnails/${b.id}`, people.max.cookie, { designerId: people.dan.id })).status).toBe(200);
    await option(b.id, people.dan.cookie);
    const second = (await sendRound(b.id, people.dan.cookie)).rounds.find((r) => r.number === 2)!;
    await decide(b.id, { roundId: second.id, action: 'pick', optionId: second.options[0].id });
    const deesB = first.options[1];
    const r = await published(b.id, { url: 'https://youtu.be/handed', publishedOn: '2026-10-19', testWinnerOptionId: deesB.id });
    expect((r.body as ThumbnailBriefDetail).live?.testWinner).toEqual({ optionId: deesB.id, letter: 'B', roundNumber: 1, isPick: false, url: deesB.url });
    // Dan made the pick and is told; Dee's unpicked option stays hers, so he reads only its letter
    expect((await detail(b.id, people.dan.cookie)).live?.testWinner).toEqual({ optionId: deesB.id, letter: 'B', roundNumber: 1, isPick: false, url: null });
    expect((await liveNotes(people.dan.id, b.id)).map((n) => n.link)).toEqual([portfolioPath({ card: second.options[0].id })]);
    expect(await liveNotes(people.dee.id, b.id)).toEqual([]);
    // Dee reads only her own round, nothing of the brief since
    const dee = await detail(b.id, people.dee.cookie);
    expect([dee.viewer, dee.live]).toEqual(['past_designer', null]);
    // the same on Dan's portfolio card, while a manager looking at it sees the picture
    const card = (await mine(people.dan)).cards.find((c) => c.briefId === b.id)!;
    expect(card.live?.testWinner?.url).toBeNull();
    expect(card.story).toEqual({
      rounds: [{ number: 1, mine: false, options: 2, outcome: 'none', note: null }, { number: 2, mine: true, options: 1, outcome: 'picked', note: null }],
      changesAsked: 0, firstRound: false,
    });
    const managers = (await mine(people.max, `?userId=${people.dan.id}`)).cards.find((c) => c.briefId === b.id)!;
    expect(managers.live?.testWinner?.url).toBe(deesB.url);
  });

  it('is taken back when a new decision changes the pick, and kept when the same option is picked again', async () => {
    const p = await picked(people.dee, { title: 'Changed mind' });
    expect((await published(p.id, { url: 'https://youtu.be/changed', publishedOn: '2026-10-20' })).status).toBe(200);
    // the same option again (now a standout): the mark and what she was told stay, on the new decision
    await decide(p.id, { roundId: p.round.id, action: 'pick', optionId: p.a.id, standout: true });
    expect((await detail(p.id, people.max.cookie)).live?.url).toBe('https://youtu.be/changed');
    const told = await liveNotes(people.dee.id, p.id);
    expect(told.map((n) => n.thumbnail_decision_id)).toEqual([await decisionOn(p.round.id)]);
    // changes asked instead: the mark goes, with her unread note about it
    await decide(p.id, { roundId: p.round.id, action: 'changes', note: 'Brighter after all' });
    expect(await markRow(p.id)).toMatchObject({ published_url: null, published_on: null, published_by: null });
    expect(await liveNotes(people.dee.id, p.id)).toEqual([]);
    expect(await logs(p.id, 'thumbnail.unlive')).toEqual([{ summary: 'Took back the went-live mark on the thumbnail for “Changed mind”: the pick changed' }]);
    // the next pick starts with no mark
    await option(p.id, people.dee.cookie);
    const next = (await sendRound(p.id, people.dee.cookie)).rounds.find((r) => r.number === 2)!;
    const after = await decide(p.id, { roundId: next.id, action: 'pick', optionId: next.options[0].id });
    expect([after.state, after.live]).toEqual(['picked', null]);
  });
});

describe('the Timeliner video a thumbnail is for', () => {
  it('lists the client’s videos from the copy of Timeliner, for managers only', async () => {
    await task('v_open', 'Acme 01', acme, 'toDo', { createdAt: ago(3) });
    await task('v_approved', 'Acme 02', acme, 'approved', { createdAt: ago(2), stepLabel: 'Approved by client' });
    await task('v_posted', 'Acme 03', acme, 'posted', { createdAt: ago(20), movedAt: ago(10) });
    await task('v_old', 'Acme 04', acme, 'posted', { createdAt: ago(130), movedAt: ago(120) });
    await task('v_raw', 'C0045.MP4', acme, 'toDo', { createdAt: ago(1) });
    await task('v_pdf', 'Scripts', acme, 'approved', { createdAt: ago(1) });
    const batch = (await db.one<{ id: number }>(`insert into batches (client_id, title, target_count) values ($1, 'Shoot', 3) returning id`, [acme]))!.id;
    await db.query(`insert into timeliner_pdfs (key, kind, batch_id, first_at, latest_at, how) values ('v_pdf', 'task', $1, now(), now(), 'manager')`, [batch]);
    await task('g_one', 'Globex 01', globex, 'toDo', { createdAt: ago(1) });
    const linked = await brief(people.dee.id, { title: 'Acme 01', timelinerTaskId: 'v_open' });

    const r = await videos(people.max.cookie, `?clientId=${acme}`);
    expect(r.status).toBe(200);
    const list = r.body as TimelinerVideoChoices;
    // open (Approved counts as open) or Posted in the last 90 days, newest made first; never raw clips, a scripts PDF or another client's
    expect(list.videos.map((v) => [v.taskId, v.title, v.step, v.statusGroup, v.posted, v.briefId])).toEqual([
      ['v_approved', 'Acme 02', 'Approved by client', 'approved', false, null],
      ['v_open', 'Acme 01', 'To be edited', 'toDo', false, linked.id],
      ['v_posted', 'Acme 03', 'Posted', 'posted', true, null],
    ]);
    expect(list.syncedAt).toBeNull();
    await db.query(`update settings set timeliner_synced_at = '2026-10-26T12:00:00Z' where id = 1`);
    expect(((await videos(people.max.cookie, `?clientId=${globex}`)).body as TimelinerVideoChoices)).toEqual({
      videos: [{ taskId: 'g_one', title: 'Globex 01', step: 'To be edited', statusGroup: 'toDo', posted: false, createdAt: expect.any(String), briefId: null }],
      syncedAt: '2026-10-26T12:00:00.000Z',
    });
    // managers only, and the client must be named and real
    expect((await videos(people.wes.cookie, `?clientId=${acme}`)).status).toBe(403);
    expect((await videos(people.dee.cookie, `?clientId=${acme}`)).status).toBe(403);
    expect(fieldsOf(await videos(people.max.cookie, ''))).toEqual([400, ['clientId']]);
    expect((await videos(people.max.cookie, '?clientId=999999')).status).toBe(404);
  });

  it('links a brief to one of its client’s videos, shown to managers only', async () => {
    // another client's video, an unknown one and a scripts PDF are refused
    for (const id of ['g_one', 'nope', 'v_pdf']) {
      const r = await send('POST', '/api/thumbnails', people.max.cookie, { clientId: acme, title: 'Linked', designerId: people.dee.id, timelinerTaskId: id });
      expect([id, ...fieldsOf(r)]).toEqual([id, 400, ['timelinerTaskId']]);
    }
    const b = await brief(people.dee.id, { title: 'Linked', timelinerTaskId: 'v_open' });
    expect([b.timelinerTaskId, b.video]).toEqual(['v_open', {
      taskId: 'v_open', title: 'Acme 01', step: 'To be edited', statusGroup: 'toDo', posted: false, url: timelinerVideoUrl('v_open'),
    }]);
    const dees = await detail(b.id, people.dee.cookie);
    expect(['timelinerTaskId' in dees, 'video' in dees]).toEqual([false, false]);
    // Edit: only a change is checked
    expect(fieldsOf(await send('PATCH', `/api/thumbnails/${b.id}`, people.max.cookie, { timelinerTaskId: 'g_one' }))).toEqual([400, ['timelinerTaskId']]);
    const moved = await send('PATCH', `/api/thumbnails/${b.id}`, people.max.cookie, { timelinerTaskId: 'v_approved' });
    expect((moved.body as ThumbnailBriefDetail).video).toMatchObject({ taskId: 'v_approved', title: 'Acme 02', step: 'Approved by client' });
    expect((await logs(b.id, 'thumbnail.updated')).map((l) => l.summary)).toEqual(['Thumbnail for “Linked”: Timeliner video “Acme 02”']);
    // a kept link outlives the copy losing the video
    await db.query(`delete from timeliner_tasks where id = 'v_approved'`);
    const kept = await send('PATCH', `/api/thumbnails/${b.id}`, people.max.cookie, { title: 'Linked still', timelinerTaskId: 'v_approved' });
    expect([kept.status, (kept.body as ThumbnailBriefDetail).video]).toEqual([200, {
      taskId: 'v_approved', title: null, step: null, statusGroup: null, posted: false, url: timelinerVideoUrl('v_approved'),
    }]);
    const gone = (await send('PATCH', `/api/thumbnails/${b.id}`, people.max.cookie, { timelinerTaskId: null })).body as ThumbnailBriefDetail;
    expect([gone.timelinerTaskId, gone.video]).toEqual([null, null]);
  });

  it('asks managers to mark a picked thumbnail live once its video is Posted', async () => {
    await task('v_soon', 'Acme 09', acme, 'clientApproval', { createdAt: ago(1) });
    const p = await picked(people.dee, { title: 'Acme 09', timelinerTaskId: 'v_soon' });
    expect((await board()).toMarkLive).toEqual([]);
    await db.query(`update timeliner_tasks set status_group = 'posted', moved_at = now() where id = 'v_soon'`);
    const asked = await board();
    expect([asked.toMarkLive?.map((b) => b.id), asked.counts.toMarkLive]).toEqual([[p.id], 1]);
    expect(asked.toMarkLive?.[0].video).toMatchObject({ taskId: 'v_soon', step: 'Posted', posted: true });
    // narrowed like the rest of the board, and gone once it's marked
    expect((await board(`?clientId=${globex}`)).toMarkLive).toEqual([]);
    expect((await board(`?designerId=${people.dan.id}`)).toMarkLive).toEqual([]);
    expect((await published(p.id, { publishedOn: '2026-10-25' })).status).toBe(200);
    expect([(await board()).toMarkLive, (await board()).counts.toMarkLive]).toEqual([[], 0]);
  });
});

describe('a designer’s portfolio', () => {
  it('is always the session designer’s own, and a manager names an active designer', async () => {
    const pia = await person('Pia Portfolio', 'editor', 'thumbnail');
    const p = await picked(pia, { title: 'Pia’s first' });
    const own = await mine(pia);
    expect([own.designer, own.readOnly, own.cards.map((c) => c.option.id), own.total]).toEqual([{ id: pia.id, name: 'Pia Portfolio' }, false, [p.a.id], 1]);
    // ?userId= means nothing to a designer: Dee gets her own, and Pia's win isn't in it
    const dee = await mine(people.dee, `?userId=${pia.id}`);
    expect([dee.designer.id, dee.cards.some((c) => c.option.id === p.a.id)]).toEqual([people.dee.id, false]);
    // a manager must name an active thumbnail designer
    expect((await portfolio(people.max.cookie)).status).toBe(404);
    expect((await portfolio(people.max.cookie, `?userId=${people.wes.id}`)).status).toBe(404);
    const looked = await mine(people.max, `?userId=${pia.id}`);
    expect([looked.designer.id, looked.readOnly, looked.cards.map((c) => c.option.id)]).toEqual([pia.id, true, [p.a.id]]);
    // nobody else has one
    expect((await portfolio(people.wes.cookie)).status).toBe(403);
    const vic = await portfolio(people.vic.cookie);
    expect([vic.status, vic.body.error.code]).toEqual([403, 'editor']);
    // the filters are checked
    for (const [q, field] of [['?month=2026-13', 'month'], ['?month=nope', 'month'], ['?month=2026-1', 'month'], ['?clientId=abc', 'clientId'], ['?clientId=0', 'clientId']]) {
      expect([q, ...fieldsOf(await portfolio(pia.cookie, q))]).toEqual([q, 400, [field]]);
    }
  });

  it('filters the wall by client and month, keeping the lists, the total and the growth whole', async () => {
    const quin = await person('Quin Quill', 'editor', 'thumbnail');
    const one = await picked(quin, { title: 'Acme one' });
    const two = await picked(quin, { title: 'Acme two' });
    const three = await picked(quin, { title: 'Globex one', clientId: globex });
    const all = await mine(quin);
    expect(all.cards.map((c) => c.briefId)).toEqual([three.id, two.id, one.id]);
    const month = monthOf(all.cards[0].pickedAt, tz)!;
    expect([all.clients, all.months, all.total, all.filter]).toEqual([
      [{ id: acme, name: 'Acme', wins: 2 }, { id: globex, name: 'Globex', wins: 1 }], [{ month, wins: 3 }], 3, { clientId: null, month: null },
    ]);
    expect(all.cards[0]).toMatchObject({
      coverUrl: three.a.url, title: 'Globex one', clientName: 'Globex', pickedByName: 'Max Manager', live: null,
      story: { rounds: [{ number: 1, mine: true, options: 2, outcome: 'picked', note: null }], changesAsked: 0, firstRound: true },
    });
    const globexOnly = await mine(quin, `?clientId=${globex}`);
    expect([globexOnly.cards.map((c) => c.briefId), globexOnly.clients, globexOnly.total, globexOnly.filter]).toEqual([
      [three.id], all.clients, 3, { clientId: globex, month: null },
    ]);
    expect(globexOnly.growth).toEqual(all.growth);
    expect((await mine(quin, `?month=${month}`)).cards).toHaveLength(3);
    const elsewhen = await mine(quin, '?month=2001-01');
    expect([elsewhen.cards, elsewhen.months, elsewhen.total, elsewhen.growth.picks]).toEqual([[], all.months, 3, 3]);
  });

  it('works out the growth figures from rows, again after a superseding decision and a cancel', async () => {
    const rae = await person('Rae Rows', 'editor', 'thumbnail');
    const growth = async () => (await mine(rae)).growth;
    // a first-round pick, marked Standout
    const g1 = await picked(rae, { title: 'Growth one', standout: true });
    let g = await growth();
    expect([g.months.length, g.months.at(-1)?.picks, g.picks, g.firstRoundPicks, g.firstRoundRate, g.standouts, g.themes, g.notes])
      .toEqual([6, 1, 1, 1, 100, 1, [], 0]);
    // notes on the image of another brief's round: what they're about, by tag
    const b2 = await brief(rae.id, { title: 'Growth two', clientId: globex });
    await option(b2.id, rae.cookie);
    await option(b2.id, rae.cookie);
    const r2 = (await sendRound(b2.id, rae.cookie)).rounds[0];
    const [a2, b2opt] = r2.options;
    await decide(b2.id, {
      roundId: r2.id, action: 'changes', note: 'Closer', pins: [
        { optionId: a2.id, x: 0.2, y: 0.3, body: 'Bigger face', tag: 'faces' },
        { optionId: b2opt.id, x: 0.5, y: 0.5, body: 'Eyes to camera', tag: 'faces' },
        { optionId: a2.id, x: 0.7, y: 0.2, body: 'Darker sky', tag: 'contrast' },
        { optionId: b2opt.id, x: 0.1, y: 0.9, body: 'Fine as is' },
      ],
    });
    g = await growth();
    expect([g.themes, g.notes]).toEqual([[{ tag: 'faces', count: 2 }, { tag: 'contrast', count: 1 }], 4]);
    // a cancelled brief counts for nothing
    expect((await send('PATCH', `/api/thumbnails/${b2.id}`, people.max.cookie, { cancelled: true })).status).toBe(200);
    g = await growth();
    expect([g.themes, g.notes, g.picks]).toEqual([[], 0, 1]);
    // deciding again on the picked round asks for changes: the pick (and its standout) is gone, and the new notes count
    await decide(g1.id, { roundId: g1.round.id, action: 'changes', note: 'Warmer, actually', pins: [{ optionId: g1.a.id, x: 0.5, y: 0.5, body: 'Too tight', tag: 'crop' }] });
    g = await growth();
    expect([g.picks, g.firstRoundPicks, g.firstRoundRate, g.standouts, g.themes, g.notes, g.months.at(-1)?.picks]).toEqual([0, 0, null, 0, [{ tag: 'crop', count: 1 }], 1, 0]);
    expect((await mine(rae)).cards).toEqual([]);
    // the next round is picked: a pick again, but not from the first round
    await option(g1.id, rae.cookie);
    const next = (await sendRound(g1.id, rae.cookie)).rounds.find((r) => r.number === 2)!;
    await decide(g1.id, { roundId: next.id, action: 'pick', optionId: next.options[0].id, note: 'That’s it' });
    g = await growth();
    expect([g.picks, g.firstRoundPicks, g.firstRoundRate, g.standouts, g.themes, g.notes]).toEqual([1, 0, 0, 0, [{ tag: 'crop', count: 1 }], 1]);
    const [card] = (await mine(rae)).cards;
    expect([card.option.id, card.standout, card.story]).toEqual([next.options[0].id, false, {
      rounds: [{ number: 1, mine: true, options: 2, outcome: 'changes', note: 'Warmer, actually' }, { number: 2, mine: true, options: 1, outcome: 'picked', note: 'That’s it' }],
      changesAsked: 1, firstRound: false,
    }]);
  });
});

describe('faster walls', () => {
  const headersOf = async (fileId: number, cookie: string) => {
    const r = await app.inject({ method: 'GET', url: `/api/files/${fileId}`, headers: { cookie } });
    return [r.statusCode, r.headers['cache-control']];
  };
  const DAY = 'private, max-age=86400, immutable';

  it('keeps option and reference pictures for a day, and every other file for five minutes', async () => {
    const p = await picked(people.dee, { title: 'Cached' });
    expect(await headersOf(p.a.fileId, people.dee.cookie)).toEqual([200, DAY]);
    expect(await headersOf(p.b.fileId, people.max.cookie)).toEqual([200, DAY]);
    const ref = await form('/api/thumbnail-refs', people.dee.cookie, {}, { name: 'mood.png', type: 'image/png', data: png(800, 450) });
    expect([ref.status, ref.body?.error]).toEqual([200, undefined]);
    expect(await headersOf(ref.body.fileId, people.dee.cookie)).toEqual([200, DAY]);
    // a client's picture is an ordinary file, whatever its type
    const logo = await form('/api/resources/upload', people.max.cookie, { clientId: String(acme), category: 'logo' }, { name: 'logo.png', type: 'image/png', data: png(400, 400) });
    expect([logo.status, logo.body?.error]).toEqual([200, undefined]);
    expect(await headersOf(logo.body.resource.fileId, people.dee.cookie)).toEqual([200, 'private, max-age=300']);
    // who may open a file is unchanged: a ref's upload is still only its designer's
    expect((await headersOf(ref.body.fileId, people.max.cookie))[0]).toBe(404);
  });

  it('has the browser forget the pictures it kept when someone signs out', async () => {
    const lou = await person('Lou Leaving', 'editor', 'thumbnail');
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { 'x-scale-media': '1', cookie: lou.cookie, 'content-type': 'application/json' }, payload: '{}' });
    expect([out.statusCode, out.headers['clear-site-data']]).toEqual([200, '"cache"']);
  });
});
