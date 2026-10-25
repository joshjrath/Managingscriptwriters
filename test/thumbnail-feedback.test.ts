// Thumbnail Studio, phase 2, through its routes: notes pinned on spots of a round's options (checked, numbered, kept
// with their decision, and shown only to managers and the designer whose round they're on), standout picks and the
// celebrations a pick records (once per person and decision, taken back when the decision is replaced), and a
// designer's AI second look (only on their own live options, kept once, limited, and private), with a stand-in critic,
// so the Anthropic API is never called. Also the migration's constraints, on a database upgraded from the one before.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Anthropic from '@anthropic-ai/sdk';
import pg from 'pg';
import { buildApp } from '../server/app';
import { migrate, openPglite, openPostgres, type Db } from '../server/db';
import { MIGRATIONS } from '../server/schema';
import type { Ctx, ThumbCritic, ThumbCritiqueInput } from '../server/core';
import { recordThumbMoment } from '../server/moments';
import { claudeThumbCritic } from '../server/second-look';
import { HttpError } from '../server/http';
import type { Moment, MomentThumb, StudioPayload, ThumbnailBriefDetail, ThumbnailSecondLook, UserSummary } from '../shared/types';
import { currentPins, MAX_PINS, pickCelebration, SECOND_LOOK_CHECKS, type SecondLookResult } from '../shared/workflow';
import { freshDb } from './db';

let db: Db;
let app: FastifyInstance;
let ctx: Ctx;
let admin = '';
let acme = 0;
let globex = 0;
const people = {} as Record<'max' | 'wes' | 'vic' | 'dee' | 'dan', { id: number; cookie: string }>;

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

async function person(name: string, role: string, editorKind?: string): Promise<{ id: number; cookie: string }> {
  const email = `${name.toLowerCase().replace(/\W+/g, '.')}@scale.test`;
  const r = await send('POST', '/api/users', admin, { name, email, role, password: 'team-password-1', ...(editorKind ? { editorKind } : {}) });
  expect([r.status, r.body?.error]).toEqual([200, undefined]);
  const login = await app.inject({
    method: 'POST', url: '/api/auth/login', headers: { 'x-scale-media': '1', 'content-type': 'application/json' }, payload: JSON.stringify({ email, password: 'team-password-1' }),
  });
  return { id: (r.body.users as UserSummary[]).find((u) => u.email === email)!.id, cookie: String(login.headers['set-cookie']).split(';')[0] };
}

/** A PNG's header, as wide and tall as asked, padded to `size` bytes when asked. */
function png(width = 1280, height = 720, size = 33): Buffer {
  const b = Buffer.alloc(Math.max(33, size));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[24] = 8;
  b[25] = 2;
  return b;
}

async function upload(briefId: number, cookie: string, data: Buffer = png()): Promise<Res> {
  const boundary = '----thumbnail-test';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="cover.png"\r\nContent-Type: image/png\r\n\r\n`), data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const r = await app.inject({
    method: 'POST', url: `/api/thumbnails/${briefId}/options`, headers: { 'x-scale-media': '1', cookie, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload,
  });
  return { status: r.statusCode, body: JSON.parse(r.body) };
}

async function brief(designerId: number | null, o: { title?: string; clientId?: number } = {}): Promise<ThumbnailBriefDetail> {
  const r = await send('POST', '/api/thumbnails', people.max.cookie, { clientId: o.clientId ?? acme, title: o.title ?? 'Morning routine', designerId });
  expect([r.status, r.body?.error]).toEqual([200, undefined]);
  return r.body as ThumbnailBriefDetail;
}

const detail = async (id: number, cookie: string) => (await send('GET', `/api/thumbnails/${id}`, cookie)).body as ThumbnailBriefDetail;
const studio = async (cookie: string) => (await send('GET', '/api/studio', cookie)).body as StudioPayload;
const sendRound = async (id: number, cookie: string) => send('POST', `/api/thumbnails/${id}/send`, cookie, {});
const decide = async (id: number, body: Record<string, unknown>) => send('POST', `/api/thumbnails/${id}/decision`, people.max.cookie, body);
const secondLook = async (optionId: number, cookie: string) => send('POST', `/api/thumbnail-options/${optionId}/second-look`, cookie);
/** Someone's pick celebrations, of one brief's decisions (or all of them). */
const moments = (userId: number, briefId?: number) => db.query<{ id: number; kind: string; batch_id: number | null; dedupe_key: string; thumbnail_decision_id: number | null; seen_at: string | null }>(
  `select m.id, m.kind, m.batch_id, m.dedupe_key, m.thumbnail_decision_id, m.seen_at from moments m
    where m.user_id = $1 and m.kind like 'thumb_%'
      and ($2::bigint is null or m.thumbnail_decision_id in (
            select d.id from thumbnail_decisions d join thumbnail_rounds r on r.id = d.round_id where r.brief_id = $2::bigint))
    order by m.id`, [userId, briefId ?? null],
);
const thumbMoments = async (cookie: string, briefId: number) => ((await send('GET', '/api/moments', cookie)).body as Moment[]).filter((m) => m.thumb?.briefId === briefId);

/** A brief with round 1 sent by its designer: options A and B (B is 1281 wide, so the two can be told apart). */
async function sentRound(designer: { id: number; cookie: string }, o: { clientId?: number; title?: string } = {}) {
  const b = await brief(designer.id, o);
  await upload(b.id, designer.cookie);
  await upload(b.id, designer.cookie, png(1281, 720));
  const r = await sendRound(b.id, designer.cookie);
  expect(r.status).toBe(200);
  const d = r.body as ThumbnailBriefDetail;
  return { id: b.id, round: d.rounds[0], a: d.rounds[0].options[0], b: d.rounds[0].options[1] };
}

/** A tray option of the designer's, not sent yet. */
async function trayOption(designer: { id: number; cookie: string }, o: { clientId?: number; title?: string; data?: Buffer } = {}) {
  const b = await brief(designer.id, o);
  const r = await upload(b.id, designer.cookie, o.data);
  expect(r.status).toBe(200);
  return { briefId: b.id, option: (r.body as ThumbnailBriefDetail).tray!.options[0] };
}

const GOOD: SecondLookResult = {
  oneLiner: 'Reads well small; the words fight the face for attention.',
  checks: SECOND_LOOK_CHECKS.map((key, i) => ({ key, status: i === 2 ? 'watch' : 'strong', note: `Note on ${key}.` })),
  suggestions: ['Cut the words to two.', 'Move them to the left third.'],
};

/** A stand-in critic: answers with `answer` (or runs it), and remembers what it was asked. */
function fakeCritic(answer: (input: ThumbCritiqueInput) => Promise<unknown> = async () => GOOD) {
  const asked: ThumbCritiqueInput[] = [];
  const critic: ThumbCritic = {
    async critique(input) {
      asked.push(input);
      return (await answer(input)) as SecondLookResult;
    },
  };
  return { critic, asked };
}

beforeAll(async () => {
  db = await freshDb();
  ctx = { db, now: () => new Date(), secureCookies: false, allowSetup: true, uploadLimitBytes: 10 * 1024 * 1024 };
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
});

afterAll(async () => {
  await app.close();
  await db.close();
});

// ── pins ─────────────────────────────────────────────────────────────────

describe('notes pinned on the image', () => {
  it('checks every pin: on an option of this round, on the image, a note of 1 to 500 characters, a known tag, 20 at most', async () => {
    const s = await sentRound(people.dee);
    const other = await sentRound(people.dee);
    const pin = { optionId: s.a.id, x: 0.5, y: 0.5, body: 'Bigger words' };
    const changes = (pins: unknown[]) => decide(s.id, { roundId: s.round.id, action: 'changes', note: 'See the notes', pins });
    const fieldsOf = async (pins: unknown[]) => { const r = await changes(pins); return [r.status, Object.keys(r.body.error?.fields ?? {})]; };
    expect(await fieldsOf(Array.from({ length: MAX_PINS + 1 }, () => pin))).toEqual([400, ['pins']]);
    expect(await fieldsOf([{ ...pin, x: 1.2 }])).toEqual([400, ['pins.0.x']]);
    expect(await fieldsOf([pin, { ...pin, y: -0.01 }])).toEqual([400, ['pins.1.y']]);
    expect(await fieldsOf([{ ...pin, body: '   ' }])).toEqual([400, ['pins.0.body']]);
    expect(await fieldsOf([{ ...pin, body: 'x'.repeat(501) }])).toEqual([400, ['pins.0.body']]);
    expect(await fieldsOf([{ ...pin, tag: 'vibes' }])).toEqual([400, ['pins.0.tag']]);
    // on another brief's option: refused once the round is locked, in words
    const elsewhere = await changes([pin, { ...pin, optionId: other.a.id }]);
    expect([elsewhere.status, elsewhere.body.error.fields]).toEqual([400, { pins: 'Each note has to be on an option of this round' }]);
    // nothing was kept from any of those
    const kept = await db.one<{ d: number; p: number }>(
      `select (select count(*) from thumbnail_decisions where round_id = $1) as d, (select count(*) from thumbnail_pins) as p`, [s.round.id],
    );
    expect(kept).toEqual({ d: 0, p: 0 });
    // twenty is fine, on the edges too
    const full = await changes(Array.from({ length: MAX_PINS }, (_, i) => ({ ...pin, x: i % 2, y: i / (MAX_PINS - 1), body: `Note ${i + 1}` })));
    expect(full.status).toBe(200);
    expect((full.body as ThumbnailBriefDetail).decision?.pins?.map((p) => p.n)).toEqual(Array.from({ length: MAX_PINS }, (_, i) => i + 1));
  });

  it('keeps pins with their decision, numbered in the order placed; deciding again replaces what the round shows', async () => {
    const s = await sentRound(people.dee, { title: 'Pinned' });
    const first = await decide(s.id, {
      roundId: s.round.id, action: 'changes', note: 'Two things',
      pins: [{ optionId: s.b.id, x: 0.1234, y: 0.9, body: '  Fewer   words  ', tag: 'text' }, { optionId: s.a.id, x: 0, y: 1, body: 'Crop tighter' }],
    });
    expect(first.status).toBe(200);
    const d1 = first.body as ThumbnailBriefDetail;
    const firstId = d1.decision!.id;
    expect(currentPins(d1.rounds[0]).map(({ decisionId, optionId, optionLetter, x, y, n, body, tag }) => ({ decisionId, optionId, optionLetter, x, y, n, body, tag }))).toEqual([
      { decisionId: firstId, optionId: s.b.id, optionLetter: 'B', x: 0.1234, y: 0.9, n: 1, body: 'Fewer   words', tag: 'text' },
      { decisionId: firstId, optionId: s.a.id, optionLetter: 'A', x: 0, y: 1, n: 2, body: 'Crop tighter', tag: null },
    ]);
    expect(d1.decision?.standout).toBe(false);
    const told = await db.one<{ body: string }>(`select body from notifications where thumbnail_decision_id = $1`, [firstId]);
    expect(told?.body).toBe('Max Manager on round 1: “Two things” (2 notes on the image)');
    const log = await db.one<{ summary: string }>(`select summary from activity where entity_id = $1 and action = 'thumbnail.changes'`, [s.id]);
    expect(log?.summary).toBe('Asked for changes on round 1 of “Pinned”, with 2 notes on the image');

    // decided again: the new decision's pins are the round's; the old ones stay with their decision
    const second = (await decide(s.id, { roundId: s.round.id, action: 'pick', optionId: s.a.id, pins: [{ optionId: s.a.id, x: 0.5, y: 0.25, body: 'This face' }] })).body as ThumbnailBriefDetail;
    const round = second.rounds[0];
    expect(currentPins(round).map((p) => [p.n, p.body])).toEqual([[1, 'This face']]);
    expect(round.decisions.map((d) => [d.action, d.superseded, d.pins?.length])).toEqual([['pick', false, 1], ['changes', true, 2]]);
    expect(second.decision?.pins?.map((p) => p.body)).toEqual(['This face']);
    // the earlier decision keeps its pins, as history
    expect((await db.one<{ n: number }>(`select count(*) as n from thumbnail_pins where decision_id = $1`, [firstId]))?.n).toBe(2);
  });

  it('shows pins only to managers and to the designer whose round they’re on', async () => {
    // a designer of her own, so the changes hero is this brief
    const pia = await person('Pia Pins', 'editor', 'thumbnail');
    const s = await sentRound(pia, { title: 'Hand-off with notes' });
    await decide(s.id, { roundId: s.round.id, action: 'changes', note: 'Brighter', pins: [{ optionId: s.a.id, x: 0.3, y: 0.3, body: 'Pia: lift the shadows here' }] });
    // Pia: on her round, beside the brief's decision, and in the Studio's changes hero
    const mine = await detail(s.id, pia.cookie);
    expect([currentPins(mine.rounds[0]).length, mine.decision?.pins?.length]).toEqual([1, 1]);
    const hero = (await studio(pia.cookie)).hero;
    expect(hero.kind === 'changes' && [hero.brief.id, hero.decision.pins?.map((p) => p.body), hero.round.options.map((o) => o.id)]).toEqual([
      s.id, ['Pia: lift the shadows here'], [s.a.id, s.b.id],
    ]);
    // managers: on the brief and the board
    expect(currentPins((await detail(s.id, people.max.cookie)).rounds[0]).length).toBe(1);
    const board = (await send('GET', '/api/thumbnails', people.max.cookie)).body as { briefs: { id: number; decision: { pins?: unknown[] } | null }[] };
    expect(board.briefs.find((b) => b.id === s.id)?.decision?.pins).toHaveLength(1);

    // moved to Dan: he reads what was asked on Pia's round, but not her pins (they're on her options)
    await send('PATCH', `/api/thumbnails/${s.id}`, people.max.cookie, { designerId: people.dan.id });
    const dan = await detail(s.id, people.dan.cookie);
    expect([dan.viewer, dan.decision?.note, dan.decision?.pins, dan.rounds[0].decisions.map((d) => d.pins)]).toEqual(['designer', 'Brighter', [], [[]]]);
    expect(JSON.stringify(dan)).not.toContain('lift the shadows');
    expect(JSON.stringify(await studio(people.dan.cookie))).not.toContain('lift the shadows');
    // Pia still reads hers
    expect(currentPins((await detail(s.id, pia.cookie)).rounds[0]).map((p) => p.body)).toEqual(['Pia: lift the shadows here']);

    // Dan's round 2, with notes on his option: his to read, never Pia's
    await upload(s.id, people.dan.cookie);
    const two = (await sendRound(s.id, people.dan.cookie)).body as ThumbnailBriefDetail;
    await decide(s.id, { roundId: two.rounds[1].id, action: 'changes', note: 'Closer', pins: [{ optionId: two.rounds[1].options[0].id, x: 0.7, y: 0.4, body: 'Dan: tighter crop' }] });
    expect((await detail(s.id, people.dan.cookie)).decision?.pins?.map((p) => p.body)).toEqual(['Dan: tighter crop']);
    const pastPia = await detail(s.id, pia.cookie);
    expect([pastPia.viewer, pastPia.rounds.map((r) => r.number)]).toEqual(['past_designer', [1]]);
    expect(JSON.stringify(pastPia)).not.toContain('tighter crop');
  });
});

// ── standouts and celebrations ───────────────────────────────────────────

describe('standouts and celebrations', () => {
  it('celebrates a pick once, for whoever made the option: bigger from the first round, a ring for a standout', async () => {
    const s = await sentRound(people.dee, { title: 'First try', clientId: globex });
    const noPick = await decide(s.id, { roundId: s.round.id, action: 'changes', note: 'Nope', standout: true });
    expect([noPick.status, noPick.body.error.fields]).toEqual([400, { standout: 'Only a pick can be marked Standout' }]);
    const picked = (await decide(s.id, { roundId: s.round.id, action: 'pick', optionId: s.a.id, note: 'Love it', standout: true })).body as ThumbnailBriefDetail;
    const decisionId = picked.decision!.id;
    expect([picked.state, picked.decision?.standout]).toEqual(['picked', true]);
    expect((await db.one<{ summary: string }>(`select summary from activity where entity_id = $1 and action = 'thumbnail.picked'`, [s.id]))?.summary)
      .toBe('Picked option A of round 1 for “First try” as a standout');
    expect(await moments(people.dee.id, s.id)).toEqual([{
      id: expect.any(Number), kind: 'thumb_standout', batch_id: null, dedupe_key: `thumb_standout:${people.dee.id}:${decisionId}`, thumbnail_decision_id: decisionId, seen_at: null,
    }]);
    // the manager who picked it isn't celebrated
    expect(await moments(people.max.id)).toEqual([]);

    const shown = await thumbMoments(people.dee.cookie, s.id);
    expect(shown).toEqual([{
      id: expect.any(Number), kind: 'thumb_standout', batchId: null, batchTitle: 'First try', clientName: 'Globex', numbers: [], count: 0,
      byName: 'Max Manager', note: 'Love it', allMine: false, withAttachment: false, self: false, createdAt: expect.any(String),
      thumb: {
        briefId: s.id, title: 'First try', roundNumber: 1, firstRound: true,
        option: { id: s.a.id, letter: 'A', url: `/api/files/${s.a.fileId}`, width: 1280, height: 720 }, link: `/studio/briefs/${s.id}`,
      } satisfies MomentThumb,
    }]);
    expect(pickCelebration({ firstRound: shown[0].thumb!.firstRound, standout: shown[0].kind === 'thumb_standout' })).toEqual({ size: 'big', ring: true });
    // its picture opens for her
    expect((await app.inject({ method: 'GET', url: shown[0].thumb!.option.url, headers: { cookie: people.dee.cookie } })).statusCode).toBe(200);
    // seen once, it's gone
    await send('POST', '/api/moments/seen', people.dee.cookie, { ids: [shown[0].id] });
    expect(await thumbMoments(people.dee.cookie, s.id)).toEqual([]);
  });

  it('never celebrates asking for changes, and a later round’s pick is the smaller celebration', async () => {
    const s = await sentRound(people.dee, { title: 'Second time lucky' });
    const changes = (await decide(s.id, { roundId: s.round.id, action: 'changes', note: 'Warmer' })).body as ThumbnailBriefDetail;
    expect([changes.decision?.standout, await moments(people.dee.id, s.id)]).toEqual([false, []]);
    await upload(s.id, people.dee.cookie);
    const two = (await sendRound(s.id, people.dee.cookie)).body as ThumbnailBriefDetail;
    const picked = (await decide(s.id, { roundId: two.rounds[1].id, action: 'pick', optionId: two.rounds[1].options[0].id })).body as ThumbnailBriefDetail;
    const [m] = await thumbMoments(people.dee.cookie, s.id);
    expect([m.kind, m.note, m.thumb?.roundNumber, m.thumb?.firstRound, m.thumb?.option.id]).toEqual(['thumb_picked', null, 2, false, picked.winner?.id]);
    expect(pickCelebration({ firstRound: m.thumb!.firstRound, standout: false })).toEqual({ size: 'small', ring: false });
  });

  it('takes back an unseen celebration when the decision is replaced, and keeps one already seen', async () => {
    const s = await sentRound(people.dee, { title: 'Changed my mind' });
    const ofRound = () => moments(people.dee.id, s.id);
    const one = (await decide(s.id, { roundId: s.round.id, action: 'pick', optionId: s.a.id })).body as ThumbnailBriefDetail;
    expect((await ofRound()).map((m) => [m.kind, m.thumbnail_decision_id])).toEqual([['thumb_picked', one.decision!.id]]);
    // changed before Dee opened the site: the celebration goes, and changes bring none
    await decide(s.id, { roundId: s.round.id, action: 'changes', note: 'After all: brighter' });
    expect(await ofRound()).toEqual([]);
    // picked again (a standout this time): a new decision, so a new celebration with its own key
    const three = (await decide(s.id, { roundId: s.round.id, action: 'pick', optionId: s.b.id, standout: true })).body as ThumbnailBriefDetail;
    const [shown] = await ofRound();
    expect([shown.kind, shown.dedupe_key]).toEqual(['thumb_standout', `thumb_standout:${people.dee.id}:${three.decision!.id}`]);
    // once she has seen it, it stays, even when the pick is replaced
    await send('POST', '/api/moments/seen', people.dee.cookie, { ids: [shown.id] });
    await decide(s.id, { roundId: s.round.id, action: 'changes', note: 'Sorry, one more go' });
    expect((await ofRound()).map((m) => [m.id, !!m.seen_at])).toEqual([[shown.id, true]]);
  });

  it('records a pick once per person and decision, so keys never collide across people or decisions', async () => {
    const d1 = await sentRound(people.dee, { title: 'Dee’s' });
    const d2 = await sentRound(people.dan, { title: 'Dan’s' });
    const p1 = (await decide(d1.id, { roundId: d1.round.id, action: 'pick', optionId: d1.a.id })).body as ThumbnailBriefDetail;
    const p2 = (await decide(d2.id, { roundId: d2.round.id, action: 'pick', optionId: d2.a.id })).body as ThumbnailBriefDetail;
    const keys = await db.query<{ user_id: number; dedupe_key: string }>(
      `select user_id, dedupe_key from moments where thumbnail_decision_id = any($1::bigint[]) order by user_id`, [[p1.decision!.id, p2.decision!.id]],
    );
    expect(keys).toEqual([
      { user_id: people.dee.id, dedupe_key: `thumb_picked:${people.dee.id}:${p1.decision!.id}` },
      { user_id: people.dan.id, dedupe_key: `thumb_picked:${people.dan.id}:${p2.decision!.id}` },
    ].sort((a, b) => a.user_id - b.user_id));
    // recording the same pick again changes nothing
    await recordThumbMoment(db, p1.decision!.id, { name: 'Max Manager' });
    expect((await db.one<{ n: number }>(`select count(*) as n from moments where thumbnail_decision_id = $1`, [p1.decision!.id]))?.n).toBe(1);
    // a designer who has left isn't celebrated
    const gone = await person('Gail Gone', 'editor', 'thumbnail');
    const g = await sentRound(gone, { title: 'Left before the pick' });
    await db.query(`update users set active = false where id = $1`, [gone.id]);
    const p3 = (await decide(g.id, { roundId: g.round.id, action: 'pick', optionId: g.a.id })).body as ThumbnailBriefDetail;
    expect([p3.state, await moments(gone.id, g.id)]).toEqual(['picked', []]);
  });

  it('shows a designer Standout only on their own picks among the client’s recent winners', async () => {
    const hooli = (await send('POST', '/api/clients', admin, { name: 'Hooli' })).body.clientId as number;
    const dans = await sentRound(people.dan, { clientId: hooli, title: 'Dan’s standout' });
    await decide(dans.id, { roundId: dans.round.id, action: 'pick', optionId: dans.a.id, standout: true });
    const dees = await sentRound(people.dee, { clientId: hooli, title: 'Dee’s standout' });
    await decide(dees.id, { roundId: dees.round.id, action: 'pick', optionId: dees.b.id, standout: true });
    const deeNext = await brief(people.dee.id, { clientId: hooli, title: 'Dee’s next' });
    const danNext = await brief(people.dan.id, { clientId: hooli, title: 'Dan’s next' });
    const winners = async (id: number, cookie: string) => (await detail(id, cookie)).recentWinners.map((w) => [w.title, w.standout]);
    // both picks are beside her brief (the owner's rule), but how Dan's was rated is his
    expect(await winners(deeNext.id, people.dee.cookie)).toEqual([['Dee’s standout', true], ['Dan’s standout', false]]);
    expect(await winners(danNext.id, people.dan.cookie)).toEqual([['Dee’s standout', false], ['Dan’s standout', true]]);
    // managers see every rating
    expect(await winners(deeNext.id, people.max.cookie)).toEqual([['Dee’s standout', true], ['Dan’s standout', true]]);
  });

  it('doesn’t celebrate a pick for someone who is no longer a thumbnail designer', async () => {
    const kim = await person('Kim Kind', 'editor', 'thumbnail');
    const s = await sentRound(kim, { title: 'Picked, then moved' });
    await decide(s.id, { roundId: s.round.id, action: 'pick', optionId: s.a.id });
    const [m] = await thumbMoments(kim.cookie, s.id);
    expect(m.kind).toBe('thumb_picked');
    // made a video editor before she next opens the site: the picture and the brief no longer open for her
    expect((await send('PATCH', `/api/users/${kim.id}`, admin, { editorKind: 'short_form' })).status).toBe(200);
    expect((await app.inject({ method: 'GET', url: m.thumb!.option.url, headers: { cookie: kim.cookie } })).statusCode).toBe(404);
    expect(await thumbMoments(kim.cookie, s.id)).toEqual([]);
    expect((await moments(kim.id, s.id)).map((x) => !!x.seen_at)).toEqual([false]);
    // a designer again, it's hers to see
    expect((await send('PATCH', `/api/users/${kim.id}`, admin, { editorKind: 'thumbnail' })).status).toBe(200);
    expect((await thumbMoments(kim.cookie, s.id)).map((x) => x.id)).toEqual([m.id]);
  });

  it('puts this month’s standouts in “Your best this month”, newest first', async () => {
    const sky = await person('Sky Standout', 'editor', 'thumbnail');
    expect((await studio(sky.cookie)).best).toEqual([]);
    const plain = await sentRound(sky, { title: 'Plain pick' });
    await decide(plain.id, { roundId: plain.round.id, action: 'pick', optionId: plain.a.id });
    const old = await sentRound(sky, { title: 'Standout, long ago' });
    await decide(old.id, { roundId: old.round.id, action: 'pick', optionId: old.a.id, standout: true });
    await db.query(`update thumbnail_decisions set created_at = now() - interval '45 days' where round_id = $1`, [old.round.id]);
    const best = await sentRound(sky, { title: 'Standout' });
    await decide(best.id, { roundId: best.round.id, action: 'pick', optionId: best.b.id, standout: true });
    const s = await studio(sky.cookie);
    expect(s.best?.map((w) => [w.title, w.option.id, w.standout])).toEqual([['Standout', best.b.id, true]]);
    expect(s.wins.map((w) => [w.title, !!w.standout])).toEqual([['Standout', true], ['Plain pick', false], ['Standout, long ago', true]]);
    // a manager opening her Studio sees the same strip
    expect((await send('GET', `/api/studio?userId=${sky.id}`, people.max.cookie)).body.best.map((w: { title: string }) => w.title)).toEqual(['Standout']);
  });
});

// ── the AI second look ───────────────────────────────────────────────────

describe('a second look', () => {
  it('isn’t offered without an AI key, and says how to turn it on', async () => {
    ctx.thumbCritic = null;
    const { option } = await trayOption(people.dee);
    expect((await send('GET', '/api/bootstrap', people.dee.cookie)).body.secondLook).toBe(false);
    const r = await secondLook(option.id, people.dee.cookie);
    expect([r.status, r.body.error.code]).toEqual([503, 'not_configured']);
    expect(r.body.error.message).toMatch(/ANTHROPIC_API_KEY/);
    const { critic } = fakeCritic();
    ctx.thumbCritic = critic;
    expect((await send('GET', '/api/bootstrap', people.dee.cookie)).body.secondLook).toBe(true);
  });

  it('is only for the option’s maker, on a live option of theirs: 404 for anyone else’s, refused for everyone else', async () => {
    const { critic, asked } = fakeCritic();
    ctx.thumbCritic = critic;
    const { briefId, option } = await trayOption(people.dee);
    // another designer, a manager, a writer and a video editor
    expect((await secondLook(option.id, people.dan.cookie)).status).toBe(404);
    expect((await secondLook(option.id, people.max.cookie)).status).toBe(403);
    expect((await secondLook(option.id, people.wes.cookie)).status).toBe(403);
    const vic = await secondLook(option.id, people.vic.cookie);
    expect([vic.status, vic.body.error.code]).toEqual([403, 'editor']);
    expect((await secondLook(999999, people.dee.cookie)).status).toBe(404);
    expect(asked).toHaveLength(0);
    // hers, in her tray
    const r = await secondLook(option.id, people.dee.cookie);
    expect([r.status, r.body]).toEqual([200, { ...GOOD, optionId: option.id, createdAt: expect.any(String) } satisfies ThumbnailSecondLook]);
    // taken out of the tray, it's gone
    const other = await upload(briefId, people.dee.cookie);
    const second = (other.body as ThumbnailBriefDetail).tray!.options[1];
    await send('DELETE', `/api/thumbnail-options/${second.id}`, people.dee.cookie);
    expect((await secondLook(second.id, people.dee.cookie)).status).toBe(404);

    // a round she sent stays hers after the brief moves on; the new designer can't ask on her options
    const s = await sentRound(people.dee);
    await send('PATCH', `/api/thumbnails/${s.id}`, people.max.cookie, { designerId: people.dan.id });
    expect((await secondLook(s.a.id, people.dee.cookie)).status).toBe(200);
    expect((await secondLook(s.b.id, people.dan.cookie)).status).toBe(404);
  });

  it('keeps one per option and returns it without asking again; only its maker ever sees it', async () => {
    const { critic, asked } = fakeCritic();
    ctx.thumbCritic = critic;
    const { briefId, option } = await trayOption(people.dee, { title: 'Looked at' });
    await upload(briefId, people.dee.cookie);
    const first = (await secondLook(option.id, people.dee.cookie)).body as ThumbnailSecondLook;
    const again = await secondLook(option.id, people.dee.cookie);
    expect([again.status, again.body, asked.length]).toEqual([200, first, 1]);
    // even with no AI key any more, the kept one is still there
    ctx.thumbCritic = null;
    expect((await secondLook(option.id, people.dee.cookie)).body).toEqual(first);
    ctx.thumbCritic = critic;
    // it rides on her option (null on the one she hasn't asked about), in her tray and once sent
    const mine = await detail(briefId, people.dee.cookie);
    expect(mine.tray!.options.map((o) => o.secondLook)).toEqual([first, null]);
    const sent = (await sendRound(briefId, people.dee.cookie)).body as ThumbnailBriefDetail;
    expect(sent.rounds[0].options.map((o) => o.secondLook)).toEqual([first, null]);
    // managers, and the designer it moves to, never get it
    const forMax = await detail(briefId, people.max.cookie);
    expect(forMax.rounds[0].options.map((o) => 'secondLook' in o)).toEqual([false, false]);
    expect(JSON.stringify(forMax)).not.toContain(GOOD.oneLiner);
    expect(JSON.stringify((await send('GET', '/api/thumbnails', people.max.cookie)).body)).not.toContain(GOOD.oneLiner);
    await decide(briefId, { roundId: sent.rounds[0].id, action: 'pick', optionId: option.id });
    await send('PATCH', `/api/thumbnails/${briefId}`, people.max.cookie, { designerId: people.dan.id });
    expect(JSON.stringify(await detail(briefId, people.dan.cookie))).not.toContain(GOOD.oneLiner);
    expect(JSON.stringify(await studio(people.dan.cookie))).not.toContain(GOOD.oneLiner);
  });

  it('stays private while an Admin views the site as its maker, and can’t be asked for then, even in Recording mode', async () => {
    const { critic, asked } = fakeCritic();
    ctx.thumbCritic = critic;
    const una = await person('Una Viewed', 'editor', 'thumbnail');
    const { briefId, option } = await trayOption(una, { title: 'Viewed as' });
    const other = ((await upload(briefId, una.cookie)).body as ThumbnailBriefDetail).tray!.options[1];
    await secondLook(option.id, una.cookie);
    expect(asked).toHaveLength(1);
    const as = (method: string, url: string) => send(method, url, admin, method === 'POST' ? {} : undefined);
    expect((await send('POST', '/api/admin/view-as', admin, { userId: una.id })).status).toBe(200);
    try {
      const look = async () => {
        const boot = (await as('GET', '/api/bootstrap')).body;
        const seen = await detail(briefId, admin);
        return {
          who: boot.me.id, button: boot.secondLook, keys: seen.tray!.options.map((o) => 'secondLook' in o),
          leaked: [JSON.stringify(seen), JSON.stringify((await as('GET', '/api/studio')).body)].some((j) => j.includes(GOOD.oneLiner)),
        };
      };
      expect(await look()).toEqual({ who: una.id, button: false, keys: [false, false], leaked: false });
      // practising as her: still not shown, and asking would bill a real read to her limits, so it's refused
      expect((await as('POST', '/api/admin/recording/start')).status).toBe(200);
      try {
        expect(await look()).toEqual({ who: una.id, button: false, keys: [false, false], leaked: false });
        const r = await secondLook(other.id, admin);
        expect([r.status, r.body.error.code]).toEqual([403, 'viewing_as']);
        expect(r.body.error.message).toBe('A second look is private to Una Viewed, so it’s off while you’re viewing as them.');
        expect(asked).toHaveLength(1);
      } finally {
        await as('POST', '/api/admin/recording/stop');
      }
    } finally {
      await as('POST', '/api/admin/view-as/stop');
    }
    // she still has hers
    expect((await detail(briefId, una.cookie)).tray!.options.map((o) => o.secondLook?.oneLiner ?? null)).toEqual([GOOD.oneLiner, null]);
  });

  it('sends the option, the client’s picked thumbnails she may see (three at most, newest first) and the brief', async () => {
    const { critic, asked } = fakeCritic();
    ctx.thumbCritic = critic;
    const initech = (await send('POST', '/api/clients', admin, { name: 'Initech', brandVoice: 'Bright and plain', guidance: 'Always the logo top right' })).body.clientId as number;
    // four of Dan's picks for Initech, oldest first, each with an option of his that wasn't picked
    const widths = [1300, 1301, 1302, 1303];
    for (const [i, w] of widths.entries()) {
      const b = await brief(people.dan.id, { clientId: initech, title: `Initech win ${i + 1}` });
      await upload(b.id, people.dan.cookie, png(w, 720));
      await upload(b.id, people.dan.cookie, png(1400, 720));
      const r = ((await sendRound(b.id, people.dan.cookie)).body as ThumbnailBriefDetail).rounds[0];
      await decide(b.id, { roundId: r.id, action: 'pick', optionId: r.options[0].id });
      await db.query(`update thumbnail_decisions set created_at = now() - make_interval(mins => $2::int) where round_id = $1`, [r.id, 100 - i]);
    }
    const b = await brief(people.dee.id, { clientId: initech, title: 'Pantry tour' });
    await send('PATCH', `/api/thumbnails/${b.id}`, people.max.cookie, { brief: 'Open pantry, morning light', onImage: 'WHAT WE EAT' });
    const own = png(1280, 720, 64);
    const option = ((await upload(b.id, people.dee.cookie, own)).body as ThumbnailBriefDetail).tray!.options[0];
    expect((await secondLook(option.id, people.dee.cookie)).status).toBe(200);
    const input = asked[0];
    expect(input.option).toEqual({ mime: 'image/png', base64: own.toString('base64') });
    expect(input.references.map((r) => r.base64)).toEqual([1303, 1302, 1301].map((w) => png(w, 720).toString('base64')));
    expect(input.references.some((r) => r.base64 === png(1400, 720).toString('base64'))).toBe(false);
    expect([input.brief, input.client]).toEqual([
      { title: 'Pantry tour', brief: 'Open pantry, morning light', onImage: 'WHAT WE EAT' },
      { name: 'Initech', brandVoice: 'Bright and plain', guidance: 'Always the logo top right' },
    ]);
  });

  it('refuses an image over 7 MB in plain words, without asking', async () => {
    const { critic, asked } = fakeCritic();
    ctx.thumbCritic = critic;
    const { option } = await trayOption(people.dee, { data: png(1280, 720, 7 * 1024 * 1024 + 1) });
    const r = await secondLook(option.id, people.dee.cookie);
    expect([r.status, r.body.error.code, asked.length]).toEqual([413, 'too_big', 0]);
    expect(r.body.error.message).toMatch(/up to 7 MB/);
    // it's advice: the round still goes
    expect((await sendRound(option.briefId, people.dee.cookie)).status).toBe(200);
  });

  it('keeps nothing when Claude declines, runs out of room or answers something unusable, so she can ask again', async () => {
    const replies: (() => Promise<unknown>)[] = [
      async () => { throw new HttpError(422, 'This image couldn’t be given a second look.'); },
      async () => ({ oneLiner: 'Fine', checks: [], suggestions: [] }),
      async () => ({
        // too long, out of order, a key twice and too many suggestions: tidied before it's kept
        oneLiner: `${'Very '.repeat(40)}long`,
        checks: [...[...GOOD.checks].reverse(), { key: 'words', status: 'ok', note: 'second words' }],
        suggestions: ['One', '', 'Two', 'Three', 'Four'],
      }),
    ];
    const { critic, asked } = fakeCritic(() => replies[asked.length - 1]());
    ctx.thumbCritic = critic;
    const { option } = await trayOption(people.dee);
    const kept = async () => (await db.one<{ n: number }>(`select count(*) as n from thumbnail_second_looks where variant_id = $1`, [option.id]))?.n;
    const declined = await secondLook(option.id, people.dee.cookie);
    expect([declined.status, await kept()]).toEqual([422, 0]);
    const odd = await secondLook(option.id, people.dee.cookie);
    expect([odd.status, await kept()]).toEqual([502, 0]);
    const ok = (await secondLook(option.id, people.dee.cookie)).body as ThumbnailSecondLook;
    expect([asked.length, await kept(), ok.oneLiner.length <= 140, ok.oneLiner.endsWith('…')]).toEqual([3, 1, true, true]);
    expect([ok.checks.map((c) => c.key), ok.checks.find((c) => c.key === 'words')?.note, ok.suggestions]).toEqual([
      [...SECOND_LOOK_CHECKS], GOOD.checks.find((c) => c.key === 'words')?.note, ['One', 'Two', 'Three'],
    ]);
  });

  it('reads one at a time per person, and at most 30 an hour', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const slow = fakeCritic(async () => { await gate; return GOOD; });
    ctx.thumbCritic = slow.critic;
    const ivy = await person('Ivy Ink', 'editor', 'thumbnail');
    const a = await trayOption(ivy, { title: 'Slow one' });
    const b = await trayOption(ivy, { title: 'Impatient' });
    const first = secondLook(a.option.id, ivy.cookie);
    await vi.waitFor(() => expect(slow.asked).toHaveLength(1));
    const meanwhile = await secondLook(b.option.id, ivy.cookie);
    expect(meanwhile.status).toBe(429);
    // someone else isn't held up
    const dee = await trayOption(people.dee, { title: 'Not waiting' });
    ctx.thumbCritic = fakeCritic().critic;
    expect((await secondLook(dee.option.id, people.dee.cookie)).status).toBe(200);
    ctx.thumbCritic = slow.critic;
    release();
    expect((await first).status).toBe(200);

    // every read sent to the AI counts, even one that kept nothing (the first above was one); a kept one asked again doesn't
    const junk = fakeCritic(async () => ({ oneLiner: '' }));
    ctx.thumbCritic = junk.critic;
    for (let i = 0; i < 29; i++) expect((await secondLook(b.option.id, ivy.cookie)).status).toBe(502);
    expect((await secondLook(a.option.id, ivy.cookie)).status).toBe(200);
    const limited = await secondLook(b.option.id, ivy.cookie);
    expect([limited.status, junk.asked.length]).toEqual([429, 29]);
    expect(limited.body.error.message).toMatch(/in an hour/);
  });
});

// ── the Claude critic itself, with a stand-in client ─────────────────────

describe('the Claude critic', () => {
  const input: ThumbCritiqueInput = {
    option: { mime: 'image/webp', base64: 'b3B0aW9u' },
    references: [{ mime: 'image/jpeg', base64: 'cmVmMQ==' }, { mime: 'image/png', base64: 'cmVmMg==' }],
    brief: { title: 'Pantry tour', brief: null, onImage: 'WHAT WE EAT' },
    client: { name: 'Globex', brandVoice: 'Bright', guidance: null },
  };
  const clientThat = (parse: (body: Record<string, unknown>) => Promise<unknown>) => ({ beta: { messages: { parse } } }) as unknown as Anthropic;

  it('asks with the images first, then the brief and the client, and answers with what it parsed', async () => {
    const sent: Record<string, unknown>[] = [];
    const critic = claudeThumbCritic(clientThat(async (body) => { sent.push(body); return { stop_reason: 'end_turn', parsed_output: GOOD }; }));
    expect(await critic.critique(input)).toEqual(GOOD);
    const body = sent[0];
    expect([body.model, body.max_tokens, body.betas, body.fallbacks]).toEqual(['claude-opus-5-5', 8000, ['server-side-fallback-2026-07-01'], 'default']);
    for (const banned of ['thinking', 'temperature', 'top_p', 'top_k']) expect(body).not.toHaveProperty(banned);
    expect((body.output_config as { effort: string }).effort).toBe('medium');
    const [message] = body.messages as { role: string; content: { type: string; text?: string; source?: { media_type: string; data: string } }[] }[];
    expect(message.content.map((c) => c.type === 'image' ? `${c.source!.media_type}:${c.source!.data}` : c.text!.split('\n')[0])).toEqual([
      'The option:', 'image/webp:b3B0aW9u', 'Reference 1:', 'image/jpeg:cmVmMQ==', 'Reference 2:', 'image/png:cmVmMg==', 'The brief:',
    ]);
    const context = message.content[message.content.length - 1].text!;
    for (const words of ['Video title: Pantry tour', 'What it should show: not given', 'Words on the image: WHAT WE EAT', 'The client: Globex', 'Brand voice: Bright', '2 thumbnails picked']) {
      expect(context).toContain(words);
    }
    expect(String(body.system)).toMatch(/never name anyone/i);
  });

  it('says plainly when Claude declines or runs out of room', async () => {
    const answers: [Record<string, unknown>, RegExp][] = [
      [{ stop_reason: 'refusal', parsed_output: GOOD }, /couldn’t be given a second look/],
      [{ stop_reason: 'max_tokens', parsed_output: null }, /ran too long/],
      [{ stop_reason: 'end_turn', parsed_output: null }, /ran too long/],
    ];
    for (const [answer, words] of answers) {
      const err = await claudeThumbCritic(clientThat(async () => answer)).critique(input).catch((e: unknown) => e);
      expect([answer.stop_reason, err instanceof HttpError && err.status]).toEqual([answer.stop_reason, 422]);
      expect((err as HttpError).message).toMatch(words);
    }
  });

  it('maps the API’s failures the way Paste notes does, never with the key', async () => {
    const SDK = (await import('@anthropic-ai/sdk')).default;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const h = new Headers({ 'request-id': 'req_123' });
      const cases: [Error, number, RegExp][] = [
        [new SDK.AuthenticationError(401, { message: 'invalid x-api-key sk-ant-secret' }, undefined, h), 503, /ANTHROPIC_API_KEY/],
        [new SDK.PermissionDeniedError(403, { message: 'no' }, undefined, h), 503, /isn’t set up correctly/],
        [new SDK.NotFoundError(404, { message: 'model not found' }, undefined, h), 503, /isn’t set up correctly/],
        [new SDK.RateLimitError(429, { message: 'slow down' }, undefined, h), 429, /Try again in a minute/],
        [new SDK.BadRequestError(400, { message: 'image too large' }, undefined, h), 400, /image too large/],
        [new SDK.InternalServerError(500, { message: 'boom' }, undefined, h), 502, /didn’t answer/],
        [new SDK.APIConnectionError({ message: 'offline' }), 502, /didn’t answer/],
      ];
      for (const [thrown, status, words] of cases) {
        const err = await claudeThumbCritic(clientThat(async () => { throw thrown; })).critique(input).catch((e: unknown) => e);
        expect([thrown.constructor.name, err instanceof HttpError ? err.status : err]).toEqual([thrown.constructor.name, status]);
        expect((err as HttpError).message).toMatch(words);
        expect((err as HttpError).message).not.toContain('sk-ant');
      }
      // the request id is logged to look it up
      expect(warn.mock.calls.some(([line]) => String(line).includes('req_123'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

// ── migration 40, on a database upgraded from 39 ────────────────────────

describe('the phase 2 migration', () => {
  it('upgrades a workspace from the migration before, keeping its moments and decisions, on this engine', async () => {
    const at = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes('create table thumbnail_pins'));
    expect(at).toBe(39);
    // a database of its own: in-memory PGlite, or a schema of its own on PostgreSQL (TEST_DATABASE_URL)
    const url = process.env.TEST_DATABASE_URL;
    const schema = 'phase2_upgrade';
    if (url) {
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      await c.query(`drop schema if exists ${schema} cascade; create schema ${schema};`);
      await c.end();
    }
    const old = url ? await openPostgres(url, { schema }) : await openPglite();
    try {
      // migrations 1 to 39, as the runner applies them
      await old.query(`create table schema_migrations (version int primary key, applied_at timestamptz not null default now())`);
      for (const [i, sql] of MIGRATIONS.slice(0, at).entries()) {
        await old.tx(async (t) => {
          if (typeof sql === 'function') await sql(t);
          else for (const stmt of sql.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) await t.query(stmt);
          await t.query(`insert into schema_migrations (version) values ($1)`, [i + 1]);
        });
      }
      const user = (await old.one<{ id: number }>(`insert into users (email, name, role, editor_kind, password_hash) values ('d@x.test', 'D', 'editor', 'thumbnail', 'x') returning id`))!.id;
      const client = (await old.one<{ id: number }>(`insert into clients (name, created_by) values ('C', $1) returning id`, [user]))!.id;
      const brief = (await old.one<{ id: number }>(`insert into thumbnail_briefs (client_id, title, designer_id, created_by) values ($1, 'T', $2, $2) returning id`, [client, user]))!.id;
      const round = (await old.one<{ id: number }>(`insert into thumbnail_rounds (brief_id, number, created_by, sent_at) values ($1, 1, $2, now()) returning id`, [brief, user]))!.id;
      const file = (await old.one<{ id: number }>(`insert into files (filename, mime, size, sha256, data, uploaded_by) values ('a.png', 'image/png', 1, 'x', '\\x00'::bytea, $1) returning id`, [user]))!.id;
      const variant = (await old.one<{ id: number }>(
        `insert into thumbnail_variants (round_id, letter, file_id, mime, width, height, uploaded_by) values ($1, 'A', $2, 'image/png', 1280, 720, $3) returning id`, [round, file, user],
      ))!.id;
      const decision = (await old.one<{ id: number }>(`insert into thumbnail_decisions (round_id, action, variant_id, decided_by) values ($1, 'pick', $2, $3) returning id`, [round, variant, user]))!.id;
      for (const kind of ['approved', 'revisions', 'drafts_done', 'batch_done', 'team_drafts_done', 'team_batch_done']) {
        await old.query(`insert into moments (user_id, kind, dedupe_key) values ($1, $2, $2)`, [user, kind]);
      }
      await expect(old.query(`insert into moments (user_id, kind) values ($1, 'thumb_picked')`, [user])).rejects.toThrow();

      await migrate(old);
      expect((await old.query<{ kind: string }>(`select kind from moments order by id`)).map((m) => m.kind)).toEqual([
        'approved', 'revisions', 'drafts_done', 'batch_done', 'team_drafts_done', 'team_batch_done',
      ]);
      expect(await old.one(`select standout from thumbnail_decisions where id = $1`, [decision])).toEqual({ standout: false });
      const names = (await old.query<{ conname: string }>(
        `select conname from pg_constraint where conrelid in ('moments'::regclass, 'thumbnail_decisions'::regclass, 'thumbnail_pins'::regclass) and contype in ('c', 'u') order by conname`,
      )).map((c) => c.conname);
      expect(names).toEqual(expect.arrayContaining(['moments_kind_check', 'thumbnail_decisions_standout_check', 'thumbnail_pins_number_key']));
      // the new kinds go in; the one that was never a celebration doesn't
      await old.query(`insert into moments (user_id, kind, thumbnail_decision_id) values ($1, 'thumb_picked', $2), ($1, 'thumb_standout', $2)`, [user, decision]);
      await expect(old.query(`insert into moments (user_id, kind) values ($1, 'thumb_changes')`, [user])).rejects.toThrow();
      // a standout is only ever a pick
      await old.query(`update thumbnail_decisions set standout = true where id = $1`, [decision]);
      await expect(old.query(`insert into thumbnail_decisions (round_id, action, decided_by, note, standout) values ($1, 'changes', $2, 'x', true)`, [round, user])).rejects.toThrow();
      // pins: on the picture, numbered once per decision, and gone with their decision
      const pin = (n: number, x: number) => old.query(`insert into thumbnail_pins (decision_id, variant_id, x, y, n, body) values ($1, $2, $3, 0.5, $4, 'note')`, [decision, variant, x, n]);
      await pin(1, 0.25);
      await expect(pin(1, 0.5)).rejects.toThrow();
      await expect(pin(2, 1.5)).rejects.toThrow();
      await expect(pin(0, 0.5)).rejects.toThrow();
      await old.query(`insert into thumbnail_second_looks (variant_id, requested_by, result) values ($1, $2, '{}'::jsonb)`, [variant, user]);
      await expect(old.query(`insert into thumbnail_second_looks (variant_id, requested_by, result) values ($1, $2, '{}'::jsonb)`, [variant, user])).rejects.toThrow();
      await old.query(`delete from moments where thumbnail_decision_id = $1`, [decision]);
      await old.query(`delete from thumbnail_decisions where id = $1`, [decision]);
      expect(await old.one(`select count(*) as n from thumbnail_pins`)).toEqual({ n: 0 });
    } finally {
      await old.close();
      if (url) {
        const c = new pg.Client({ connectionString: url });
        await c.connect();
        await c.query(`drop schema if exists ${schema} cascade`);
        await c.end();
      }
    }
  });
});
