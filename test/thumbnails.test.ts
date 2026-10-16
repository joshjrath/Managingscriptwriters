// Thumbnail Studio through its routes: managers hand out briefs, a designer lines up options in a private tray and
// sends them as rounds, managers pick one or ask for changes. Who may read, upload, send and open each image (in every
// direction), the round and decision rules, and that an upload is kept as what its bytes say, never the browser's word.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import type { Db } from '../server/db';
import type { Ctx } from '../server/core';
import type { Counts, StudioPayload, ThumbnailBoard, ThumbnailBriefDetail, UserSummary } from '../shared/types';
import { isOpenThumb } from '../shared/workflow';
import { freshDb } from './db';

let db: Db;
let app: FastifyInstance;
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

/** Someone new on the team, signed in. */
async function person(name: string, role: string, editorKind?: string): Promise<{ id: number; cookie: string }> {
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
/** A baseline JPEG's start: the image marker, then its frame header. */
const jpeg = (width: number, height: number) =>
  Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);

type Upload = { name: string; type: string; data: Buffer };
const PNG_FILE: Upload = { name: 'cover.png', type: 'image/png', data: png() };

async function upload(briefId: number, cookie: string, file: Upload | null = PNG_FILE, note?: string): Promise<Res> {
  const boundary = '----thumbnail-test';
  const parts: Buffer[] = [];
  if (note) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\n${note}\r\n`));
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.data, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const r = await app.inject({
    method: 'POST', url: `/api/thumbnails/${briefId}/options`,
    headers: { 'x-scale-media': '1', cookie, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(parts),
  });
  return { status: r.statusCode, body: JSON.parse(r.body) };
}

/** A brief handed out by Max, the manager. */
async function brief(designerId: number | null, o: { title?: string; clientId?: number; dueOn?: string } = {}): Promise<ThumbnailBriefDetail> {
  const r = await send('POST', '/api/thumbnails', people.max.cookie, { clientId: o.clientId ?? acme, title: o.title ?? 'Morning routine', designerId, dueOn: o.dueOn ?? null });
  expect([r.status, r.body?.error]).toEqual([200, undefined]);
  return r.body as ThumbnailBriefDetail;
}

const detail = async (id: number, cookie: string) => send('GET', `/api/thumbnails/${id}`, cookie);
const sendRound = async (id: number, cookie: string, note?: string) => send('POST', `/api/thumbnails/${id}/send`, cookie, note ? { note } : {});
const decide = async (id: number, body: Record<string, unknown>) => send('POST', `/api/thumbnails/${id}/decision`, people.max.cookie, body);
const fileStatus = async (fileId: number, cookie: string) => (await app.inject({ method: 'GET', url: `/api/files/${fileId}`, headers: { cookie } })).statusCode;
const notes = (userId: number) => db.query<{ id: number; type: string; link: string | null; read_at: string | null; thumbnail_decision_id: number | null }>(
  `select id, type, link, read_at, thumbnail_decision_id from notifications where user_id = $1 and type like 'thumbnail_%' order by id`, [userId],
);

/** A brief with round 1 sent by its designer: options A and B. */
async function sentRound(designer: { id: number; cookie: string }, o: { clientId?: number; title?: string } = {}) {
  const b = await brief(designer.id, o);
  await upload(b.id, designer.cookie);
  await upload(b.id, designer.cookie);
  const r = await sendRound(b.id, designer.cookie);
  expect(r.status).toBe(200);
  const d = r.body as ThumbnailBriefDetail;
  return { id: b.id, round: d.rounds[0], a: d.rounds[0].options[0], b: d.rounds[0].options[1] };
}

beforeAll(async () => {
  db = await freshDb();
  // the site's clock is the database's (just picked, this week), so tests that need a date pick it far off
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
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('handing out a brief', () => {
  it('gives it to a thumbnail designer, who is told straight away', async () => {
    const b = await brief(people.dee.id, { title: 'Ten-minute dinners', dueOn: '2999-01-04' });
    expect(b).toMatchObject({
      title: 'Ten-minute dinners', clientName: 'Acme', designerName: 'Dee Designer', needsDesigner: false, state: 'to_design', optionsWanted: 3,
      roundsSent: 0, nextRound: 1, viewer: 'manager', tray: null, rounds: [], can: { upload: false, send: false, decide: false, edit: true },
    });
    const [n] = (await notes(people.dee.id)).filter((x) => x.link === `/studio/briefs/${b.id}`);
    expect(n.type).toBe('thumbnail_new');
    const log = await db.one<{ action: string; summary: string }>(`select action, summary from activity where entity_type = 'thumbnail' and entity_id = $1`, [b.id]);
    expect(log).toEqual({ action: 'thumbnail.created', summary: 'Gave out the thumbnail for “Ten-minute dinners” to Dee Designer' });
    // the designer opens it in their Studio
    expect((await detail(b.id, people.dee.cookie)).body).toMatchObject({ viewer: 'designer', can: { upload: true, send: false, decide: false, edit: false } });
  });

  it('gives thumbnails only to an active thumbnail designer, never a writer, manager or video editor', async () => {
    for (const who of [people.wes.id, people.max.id, people.vic.id, 999999]) {
      const r = await send('POST', '/api/thumbnails', people.max.cookie, { clientId: acme, title: 'Nope', designerId: who });
      expect([r.status, r.body.error.fields]).toEqual([400, { designerId: 'Choose a thumbnail designer' }]);
    }
    const b = await brief(people.dee.id);
    for (const who of [people.wes.id, people.max.id, people.vic.id]) {
      const r = await send('PATCH', `/api/thumbnails/${b.id}`, people.max.cookie, { designerId: who });
      expect([r.status, r.body.error.fields]).toEqual([400, { designerId: 'Choose a thumbnail designer' }]);
    }
    expect((await detail(b.id, people.dee.cookie)).status).toBe(200);
    // no designer yet is fine: it waits under "Needs a designer"
    expect((await brief(null)).needsDesigner).toBe(true);
  });

  it('checks the client, its shoot and the title', async () => {
    const shoot = (await db.one<{ id: number }>(`insert into shoots (client_id, start_date) values ($1, '2026-11-02') returning id`, [globex]))!.id;
    const wrongShoot = await send('POST', '/api/thumbnails', people.max.cookie, { clientId: acme, shootId: shoot, title: 'Shoot day' });
    expect([wrongShoot.status, Object.keys(wrongShoot.body.error.fields)]).toEqual([400, ['shootId']]);
    const ok = await send('POST', '/api/thumbnails', people.max.cookie, { clientId: globex, shootId: shoot, title: 'Shoot day', optionsWanted: 2 });
    expect([ok.status, ok.body.shootDate, ok.body.optionsWanted]).toEqual([200, '2026-11-02', 2]);
    const noTitle = await send('POST', '/api/thumbnails', people.max.cookie, { clientId: acme, title: ' ' });
    expect([noTitle.status, Object.keys(noTitle.body.error.fields)]).toEqual([400, ['title']]);
    const tooMany = await send('POST', '/api/thumbnails', people.max.cookie, { clientId: acme, title: 'Lots', optionsWanted: 7 });
    expect([tooMany.status, Object.keys(tooMany.body.error.fields)]).toEqual([400, ['optionsWanted']]);
    const old = (await send('POST', '/api/clients', admin, { name: 'Old Co' })).body.clientId;
    await db.query(`update clients set status = 'archived', archived_at = now() where id = $1`, [old]);
    const archived = await send('POST', '/api/thumbnails', people.max.cookie, { clientId: old, title: 'Gone' });
    expect([archived.status, Object.keys(archived.body.error.fields)]).toEqual([400, ['clientId']]);
  });

  it('edits only the fields sent that changed, and cancels and reopens', async () => {
    const b = await brief(people.dee.id, { title: 'Bread at home' });
    const logs = async () => (await db.query<{ action: string; summary: string }>(`select action, summary from activity where entity_type = 'thumbnail' and entity_id = $1 order by id`, [b.id])).slice(1);
    // the form sent everything back, with only the due date changed
    const r = await send('PATCH', `/api/thumbnails/${b.id}`, people.max.cookie, { title: 'Bread at home', brief: null, onImage: null, optionsWanted: 3, dueOn: '2999-02-01', designerId: people.dee.id });
    expect([r.status, r.body.dueOn]).toEqual([200, '2999-02-01']);
    expect(await logs()).toEqual([{ action: 'thumbnail.updated', summary: 'Thumbnail for “Bread at home”: due Feb 1' }]);
    // nothing different: nothing written
    expect((await send('PATCH', `/api/thumbnails/${b.id}`, people.max.cookie, { title: 'Bread at home', dueOn: '2999-02-01' })).status).toBe(200);
    expect(await logs()).toHaveLength(1);
    const cancelled = await send('PATCH', `/api/thumbnails/${b.id}`, people.max.cookie, { cancelled: true });
    expect([cancelled.body.state, !!cancelled.body.cancelledAt]).toEqual(['cancelled', true]);
    const reopened = await send('PATCH', `/api/thumbnails/${b.id}`, people.max.cookie, { cancelled: false, onImage: 'NO KNEAD' });
    expect([reopened.body.state, reopened.body.cancelledAt, reopened.body.onImage]).toEqual(['to_design', null, 'NO KNEAD']);
    expect((await logs()).map((l) => l.action)).toEqual(['thumbnail.updated', 'thumbnail.cancelled', 'thumbnail.reopened']);
  });
});

describe('the tray and its rounds', () => {
  it('letters options A, B, C…, holds six at most, and lets one go only before it’s sent', async () => {
    const b = await brief(people.dee.id);
    const letters = async () => ((await detail(b.id, people.dee.cookie)).body as ThumbnailBriefDetail).tray?.options.map((o) => o.letter);
    for (const note of ['Big face', 'Bold words', undefined]) expect((await upload(b.id, people.dee.cookie, PNG_FILE, note)).status).toBe(200);
    const d = (await detail(b.id, people.dee.cookie)).body as ThumbnailBriefDetail;
    expect(d.tray?.options.map((o) => [o.letter, o.note, o.mime, o.width, o.height])).toEqual([
      ['A', 'Big face', 'image/png', 1280, 720], ['B', 'Bold words', 'image/png', 1280, 720], ['C', null, 'image/png', 1280, 720],
    ]);
    expect([d.state, d.draftOptions, d.nextRound, d.can.send]).toEqual(['drafting', 3, 1, true]);
    // taking B out frees its letter for the next one; a second tap (or another tab) is told it's already out, and refreshes
    expect((await send('DELETE', `/api/thumbnail-options/${d.tray!.options[1].id}`, people.dee.cookie)).status).toBe(200);
    const twice = await send('DELETE', `/api/thumbnail-options/${d.tray!.options[1].id}`, people.dee.cookie);
    expect([twice.status, twice.body.error.code]).toEqual([409, 'removed']);
    expect(await letters()).toEqual(['A', 'C']);
    for (let i = 0; i < 4; i++) expect((await upload(b.id, people.dee.cookie)).status).toBe(200);
    expect(await letters()).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    const seventh = await upload(b.id, people.dee.cookie);
    expect([seventh.status, seventh.body.error.code]).toEqual([409, 'full']);
    expect(((await detail(b.id, people.dee.cookie)).body as ThumbnailBriefDetail).can.upload).toBe(false);
    // the round is sent with a note, and managers are told
    const sent = (await sendRound(b.id, people.dee.cookie, 'Went brighter on all of them')).body as ThumbnailBriefDetail;
    expect([sent.state, sent.roundsSent, sent.tray, sent.rounds[0].note, sent.rounds[0].options.length]).toEqual(['in_review', 1, null, 'Went brighter on all of them', 6]);
    expect((await notes(people.max.id)).filter((n) => n.link === `/thumbnails/${b.id}`).map((n) => n.type)).toEqual(['thumbnail_sent']);
    // a sent option stays: a page from before the send is told so, and refreshes (a 409); for anyone else it doesn't exist
    const stale = await send('DELETE', `/api/thumbnail-options/${sent.rounds[0].options[0].id}`, people.dee.cookie);
    expect([stale.status, stale.body.error.code, stale.body.error.message]).toEqual([409, 'sent', 'Option A was already sent with round 1, so it stays. The page has been refreshed.']);
    expect((await send('DELETE', `/api/thumbnail-options/${sent.rounds[0].options[0].id}`, people.dan.cookie)).status).toBe(404);
    expect(((await detail(b.id, people.dee.cookie)).body as ThumbnailBriefDetail).rounds[0].options).toHaveLength(6);
  });

  it('refuses an empty tray, and a newer round makes a decision on the old one stale', async () => {
    const b = await brief(people.dee.id);
    const empty = await sendRound(b.id, people.dee.cookie);
    expect([empty.status, Object.keys(empty.body.error.fields)]).toEqual([400, ['options']]);
    await upload(b.id, people.dee.cookie);
    const one = (await sendRound(b.id, people.dee.cookie)).body as ThumbnailBriefDetail;
    // sending again (a double tap, another tab) finds it already sent: a 409, so the stale page refreshes
    const again = await sendRound(b.id, people.dee.cookie);
    expect([again.status, again.body.error.code, again.body.error.message]).toEqual([409, 'sent', 'Round 1 was already sent. The page has been refreshed.']);
    expect(((await detail(b.id, people.dee.cookie)).body as ThumbnailBriefDetail).rounds.map((r) => r.number)).toEqual([1]);
    // the tray emptied by a removal can't be sent either
    await upload(b.id, people.dee.cookie);
    const draft = ((await detail(b.id, people.dee.cookie)).body as ThumbnailBriefDetail).tray!.options[0];
    await send('DELETE', `/api/thumbnail-options/${draft.id}`, people.dee.cookie);
    const emptied = await sendRound(b.id, people.dee.cookie);
    expect([emptied.status, Object.keys(emptied.body.error.fields)]).toEqual([400, ['options']]);
    // round 2 goes while round 1 waits
    await upload(b.id, people.dee.cookie);
    const two = (await sendRound(b.id, people.dee.cookie)).body as ThumbnailBriefDetail;
    expect(two.rounds.map((r) => [r.number, r.superseded])).toEqual([[1, true], [2, false]]);
    expect([two.state, two.roundsSent, two.nextRound]).toEqual(['in_review', 2, 3]);
    const stale = await decide(b.id, { roundId: one.rounds[0].id, action: 'pick', optionId: one.rounds[0].options[0].id });
    expect([stale.status, stale.body.error.code]).toEqual([409, 'stale']);
    expect(stale.body.error.message).toMatch(/Dee Designer sent a newer round \(round 2\)/);
    // a manager never decides on a tray, nor on another brief's round
    await upload(b.id, people.dee.cookie);
    const trayId = (await db.one<{ id: number }>(`select id from thumbnail_rounds where brief_id = $1 and sent_at is null`, [b.id]))!.id;
    expect((await decide(b.id, { roundId: trayId, action: 'changes', note: 'x' })).status).toBe(404);
    const other = await sentRound(people.dee);
    expect((await decide(b.id, { roundId: other.round.id, action: 'changes', note: 'x' })).status).toBe(404);
  });

  it('picks an option of that round, and asks for changes only with a note', async () => {
    const s = await sentRound(people.dee);
    const other = await sentRound(people.dee);
    const noNote = await decide(s.id, { roundId: s.round.id, action: 'changes' });
    expect([noNote.status, Object.keys(noNote.body.error.fields)]).toEqual([400, ['note']]);
    const noOption = await decide(s.id, { roundId: s.round.id, action: 'pick' });
    expect([noOption.status, Object.keys(noOption.body.error.fields)]).toEqual([400, ['optionId']]);
    const elsewhere = await decide(s.id, { roundId: s.round.id, action: 'pick', optionId: other.a.id });
    expect([elsewhere.status, Object.keys(elsewhere.body.error.fields)]).toEqual([400, ['optionId']]);
    const picked = (await decide(s.id, { roundId: s.round.id, action: 'pick', optionId: s.b.id, note: 'The face reads at any size' })).body as ThumbnailBriefDetail;
    expect([picked.state, picked.winner?.letter, picked.cover?.id, picked.decision?.note]).toEqual(['picked', 'B', s.b.id, 'The face reads at any size']);
    expect(picked.rounds[0].options.map((o) => o.picked)).toEqual([false, true]);
    const log = await db.one<{ summary: string }>(`select summary from activity where entity_id = $1 and action = 'thumbnail.picked'`, [s.id]);
    expect(log!.summary).toBe('Picked option B of round 1 for “Morning routine”');
  });

  it('deciding again on the same round takes back what the designer hasn’t read about the first decision', async () => {
    const s = await sentRound(people.dee);
    const mine = async () => (await notes(people.dee.id)).filter((n) => n.link === `/studio/briefs/${s.id}` && n.type !== 'thumbnail_new');
    const first = (await decide(s.id, { roundId: s.round.id, action: 'changes', note: 'Fewer words' })).body as ThumbnailBriefDetail;
    expect(first.state).toBe('changes');
    expect((await mine()).map((n) => [n.type, n.thumbnail_decision_id])).toEqual([['thumbnail_changes', first.decision!.id]]);
    // changed their mind before Dee looked: the "changes" message goes, the pick's arrives
    const second = (await decide(s.id, { roundId: s.round.id, action: 'pick', optionId: s.a.id })).body as ThumbnailBriefDetail;
    expect(second.rounds[0].decisions.map((d) => [d.action, d.superseded])).toEqual([['pick', false], ['changes', true]]);
    expect((await mine()).map((n) => [n.type, n.thumbnail_decision_id])).toEqual([['thumbnail_picked', second.decision!.id]]);
    // once read, a message stays
    const [read] = await mine();
    expect((await send('POST', '/api/notifications/read', people.dee.cookie, { ids: [read.id] })).status).toBe(200);
    const third = (await decide(s.id, { roundId: s.round.id, action: 'changes', note: 'After all: try a red background' })).body as ThumbnailBriefDetail;
    expect((await mine()).map((n) => [n.type, n.thumbnail_decision_id, !!n.read_at])).toEqual([
      ['thumbnail_picked', second.decision!.id, true], ['thumbnail_changes', third.decision!.id, false],
    ]);
  });

  it('takes no more options once one is picked, and nothing at all once cancelled', async () => {
    const s = await sentRound(people.dee);
    await upload(s.id, people.dee.cookie);
    await decide(s.id, { roundId: s.round.id, action: 'pick', optionId: s.a.id });
    const after = await upload(s.id, people.dee.cookie);
    expect([after.status, after.body.error.code]).toEqual([409, 'picked']);
    expect((await sendRound(s.id, people.dee.cookie)).status).toBe(409);
    const d = (await detail(s.id, people.dee.cookie)).body as ThumbnailBriefDetail;
    expect([d.state, d.can.upload, d.can.send]).toEqual(['picked', false, false]);
    // a manager asking for changes after all opens it back up
    await decide(s.id, { roundId: s.round.id, action: 'changes', note: 'Try the blue one again' });
    expect((await upload(s.id, people.dee.cookie)).status).toBe(200);

    const c = await sentRound(people.dee);
    await send('PATCH', `/api/thumbnails/${c.id}`, people.max.cookie, { cancelled: true });
    const up = await upload(c.id, people.dee.cookie);
    expect([up.status, up.body.error.code]).toEqual([409, 'cancelled']);
    const dec = await decide(c.id, { roundId: c.round.id, action: 'pick', optionId: c.a.id });
    expect([dec.status, dec.body.error.code]).toEqual([409, 'cancelled']);
    expect(((await detail(c.id, people.max.cookie)).body as ThumbnailBriefDetail).can.decide).toBe(false);
  });

  it('cancels only an open brief: a picked one keeps its win on the designer’s wall', async () => {
    const s = await sentRound(people.dee, { title: 'Picked and kept' });
    await decide(s.id, { roundId: s.round.id, action: 'pick', optionId: s.a.id });
    const r = await send('PATCH', `/api/thumbnails/${s.id}`, people.max.cookie, { cancelled: true });
    expect([r.status, r.body.error.code]).toEqual([409, 'picked']);
    const d = (await detail(s.id, people.max.cookie)).body as ThumbnailBriefDetail;
    expect([d.state, d.cancelledAt, d.winner?.id]).toEqual(['picked', null, s.a.id]);
    const wall = ((await send('GET', '/api/studio', people.dee.cookie)).body as StudioPayload).wins.map((w) => w.option.id);
    expect(wall).toContain(s.a.id);
    // asked for changes after all, it's open again, and can be cancelled
    await decide(s.id, { roundId: s.round.id, action: 'changes', note: 'The video moved: hold it' });
    const cancelled = await send('PATCH', `/api/thumbnails/${s.id}`, people.max.cookie, { cancelled: true });
    expect([cancelled.status, cancelled.body.state]).toEqual([200, 'cancelled']);
  });
});

describe('whose brief and image is whose', () => {
  it('keeps one designer out of another’s brief, tray and options', async () => {
    const b = await brief(people.dan.id);
    await upload(b.id, people.dan.cookie);
    const draft = ((await detail(b.id, people.dan.cookie)).body as ThumbnailBriefDetail).tray!.options[0];
    expect((await detail(b.id, people.dee.cookie)).status).toBe(404);
    expect((await upload(b.id, people.dee.cookie)).status).toBe(404);
    expect((await sendRound(b.id, people.dee.cookie)).status).toBe(404);
    expect((await send('DELETE', `/api/thumbnail-options/${draft.id}`, people.dee.cookie)).status).toBe(404);
    expect(await fileStatus(draft.fileId, people.dee.cookie)).toBe(404);
    await sendRound(b.id, people.dan.cookie);
    expect(await fileStatus(draft.fileId, people.dee.cookie)).toBe(404);
    expect(await fileStatus(draft.fileId, people.dan.cookie)).toBe(200);
  });

  it('shows managers sent rounds only: never a tray or its images', async () => {
    const b = await brief(people.dee.id);
    await upload(b.id, people.dee.cookie);
    const draft = ((await detail(b.id, people.dee.cookie)).body as ThumbnailBriefDetail).tray!.options[0];
    const seen = (await detail(b.id, people.max.cookie)).body as ThumbnailBriefDetail;
    expect([seen.state, seen.draftOptions, seen.tray, seen.cover, seen.rounds]).toEqual(['drafting', 1, null, null, []]);
    expect(await fileStatus(draft.fileId, people.max.cookie)).toBe(404);
    // a manager never touches a designer's options
    expect((await upload(b.id, people.max.cookie)).status).toBe(403);
    expect((await send('DELETE', `/api/thumbnail-options/${draft.id}`, people.max.cookie)).status).toBe(403);
    await sendRound(b.id, people.dee.cookie);
    const img = await app.inject({ method: 'GET', url: `/api/files/${draft.fileId}`, headers: { cookie: people.max.cookie } });
    expect([img.statusCode, img.headers['content-type'], String(img.headers['content-disposition']).split(';')[0]]).toEqual([200, 'image/png', 'inline']);
    expect(((await detail(b.id, people.max.cookie)).body as ThumbnailBriefDetail).cover?.id).toBe(draft.id);
  });

  it('never lets writers or video editors open an option, sent or not, or reach a brief', async () => {
    const s = await sentRound(people.dee);
    await upload(s.id, people.dee.cookie);
    const draft = ((await detail(s.id, people.dee.cookie)).body as ThumbnailBriefDetail).tray!.options[0];
    for (const who of [people.wes, people.vic]) {
      expect([await fileStatus(s.a.fileId, who.cookie), await fileStatus(draft.fileId, who.cookie)]).toEqual([404, 404]);
      expect((await detail(s.id, who.cookie)).status).toBe(403);
      expect((await send('GET', '/api/studio', who.cookie)).status).toBe(403);
    }
  });

  it('keeps an image as what its bytes say, never the browser’s word for it', async () => {
    const b = await brief(people.dee.id);
    // a PNG the browser called HTML: stored and served as a PNG, under a .png name
    const r = await upload(b.id, people.dee.cookie, { name: 'thumb.html', type: 'text/html', data: png(1280, 720) });
    expect(r.status).toBe(200);
    const o = (r.body as ThumbnailBriefDetail).tray!.options[0];
    expect([o.mime, o.fileName]).toEqual(['image/png', 'thumb.png']);
    expect(await db.one(`select mime, filename from files where id = $1`, [o.fileId])).toEqual({ mime: 'image/png', filename: 'thumb.png' });
    const img = await app.inject({ method: 'GET', url: `/api/files/${o.fileId}`, headers: { cookie: people.dee.cookie } });
    expect([img.statusCode, img.headers['content-type']]).toEqual([200, 'image/png']);
    // a JPEG called a PNG is a JPEG, with its own size
    const j = await upload(b.id, people.dee.cookie, { name: 'small.png', type: 'image/png', data: jpeg(640, 360) });
    expect((j.body as ThumbnailBriefDetail).tray!.options[1]).toMatchObject({ mime: 'image/jpeg', fileName: 'small.jpg', width: 640, height: 360 });
    // HTML, SVG and GIF dressed as pictures are refused, and nothing is kept
    const files = async () => (await db.one<{ n: number }>(`select count(*) as n from files`))!.n;
    const before = await files();
    for (const bad of [
      { name: 'cover.png', type: 'image/png', data: Buffer.from('<!doctype html><script>alert(1)</script>') },
      { name: 'cover.svg', type: 'image/svg+xml', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"></svg>') },
      { name: 'cover.gif', type: 'image/gif', data: Buffer.from('GIF89a\x00\x05\xd0\x02', 'latin1') },
      { name: 'cover.png', type: 'image/png', data: png().subarray(0, 20) },
    ]) {
      const res = await upload(b.id, people.dee.cookie, bad);
      expect([bad.name, res.status, Object.keys(res.body.error.fields ?? {})]).toEqual([bad.name, 400, ['file']]);
    }
    expect((await upload(b.id, people.dee.cookie, null)).status).toBe(400);
    expect(await files()).toBe(before);
  });

  it('moves a brief to another designer: the first keeps the rounds they sent and loses their tray', async () => {
    const s = await sentRound(people.dee);
    await upload(s.id, people.dee.cookie);
    const draft = ((await detail(s.id, people.dee.cookie)).body as ThumbnailBriefDetail).tray!.options[0];
    const moved = await send('PATCH', `/api/thumbnails/${s.id}`, people.max.cookie, { designerId: people.dan.id });
    expect([moved.status, moved.body.designerName, moved.body.draftOptions, moved.body.state]).toEqual([200, 'Dan Drawer', 0, 'in_review']);
    expect((await notes(people.dan.id)).filter((n) => n.link === `/studio/briefs/${s.id}`).map((n) => n.type)).toEqual(['thumbnail_new']);
    // Dee: read-only, her round only; her tray is gone
    const dee = (await detail(s.id, people.dee.cookie)).body as ThumbnailBriefDetail;
    expect([dee.viewer, dee.tray, dee.rounds.map((r) => r.number), dee.can]).toEqual(['past_designer', null, [1], { upload: false, send: false, decide: false, edit: false }]);
    expect([await fileStatus(s.a.fileId, people.dee.cookie), await fileStatus(draft.fileId, people.dee.cookie)]).toEqual([200, 404]);
    expect((await upload(s.id, people.dee.cookie)).status).toBe(404);
    // Dan carries on in the same tray, and round 2 is his; Dee's round shows, but her unpicked options stay hers
    const dan = (await upload(s.id, people.dan.cookie)).body as ThumbnailBriefDetail;
    expect([dan.viewer, dan.tray?.number, dan.tray?.options.map((o) => o.letter), dan.rounds.map((r) => [r.number, r.options.length])]).toEqual(['designer', 2, ['A'], [[1, 0]]]);
    expect([await fileStatus(draft.fileId, people.dan.cookie), await fileStatus(s.a.fileId, people.dan.cookie), await fileStatus(s.b.fileId, people.dan.cookie)]).toEqual([404, 404, 404]);
    const two = (await sendRound(s.id, people.dan.cookie)).body as ThumbnailBriefDetail;
    expect(two.rounds.map((r) => [r.number, r.createdByName])).toEqual([[1, 'Dee Designer'], [2, 'Dan Drawer']]);
    // Dee still sees only her own round; Dan's new option isn't hers to open
    const later = (await detail(s.id, people.dee.cookie)).body as ThumbnailBriefDetail;
    expect([later.rounds.map((r) => r.number), later.cover?.id]).toEqual([[1], s.a.id]);
    expect(await fileStatus(two.rounds[1].options[0].fileId, people.dee.cookie)).toBe(404);
  });

  it('after a move, keeps each designer’s unpicked options and what was said since to themselves', async () => {
    const s = await sentRound(people.dee, { title: 'Hand-off' });
    await decide(s.id, { roundId: s.round.id, action: 'changes', note: 'Dee: both weak' });
    await send('PATCH', `/api/thumbnails/${s.id}`, people.max.cookie, { designerId: people.dan.id });
    // Dan: Dee's round and what was asked on it (to go on from), never her options
    const dan = (await detail(s.id, people.dan.cookie)).body as ThumbnailBriefDetail;
    expect([dan.viewer, dan.state, dan.decision?.note, dan.cover, dan.rounds.map((r) => [r.number, r.createdByName, r.options])]).toEqual([
      'designer', 'changes', 'Dee: both weak', null, [[1, 'Dee Designer', []]],
    ]);
    expect([await fileStatus(s.a.fileId, people.dan.cookie), await fileStatus(s.b.fileId, people.dan.cookie)]).toEqual([404, 404]);
    const danStudio = JSON.stringify((await send('GET', '/api/studio', people.dan.cookie)).body);
    expect([danStudio.includes(`/api/files/${s.a.fileId}"`), danStudio.includes(`/api/files/${s.b.fileId}"`)]).toEqual([false, false]);
    // managers still see every sent round
    expect([await fileStatus(s.a.fileId, people.max.cookie), ((await detail(s.id, people.max.cookie)).body as ThumbnailBriefDetail).rounds[0].options.length]).toEqual([200, 2]);

    // Dan sends round 2, changes are asked on it, and he starts round 3
    await upload(s.id, people.dan.cookie);
    const two = (await sendRound(s.id, people.dan.cookie)).body as ThumbnailBriefDetail;
    await decide(s.id, { roundId: two.rounds[1].id, action: 'changes', note: 'Dan: amateurish' });
    await upload(s.id, people.dan.cookie);
    // Dee: her round and the note on it; nothing about Dan's round, the decision on it or his tray
    const dee = (await detail(s.id, people.dee.cookie)).body as ThumbnailBriefDetail;
    expect([dee.viewer, dee.rounds.map((r) => r.number), dee.decision, dee.draftOptions, dee.roundsSent, dee.sentAt, dee.state]).toEqual([
      'past_designer', [1], null, 0, 1, s.round.sentAt, 'to_design',
    ]);
    expect(dee.rounds[0].decisions.map((x) => x.note)).toEqual(['Dee: both weak']);
    expect(JSON.stringify(dee)).not.toContain('amateurish');
    // while her round is still the newest, she sees where it stands
    const t = await sentRound(people.dee, { title: 'Hand-off, waiting' });
    await send('PATCH', `/api/thumbnails/${t.id}`, people.max.cookie, { designerId: people.dan.id });
    await upload(t.id, people.dan.cookie);
    const waiting = (await detail(t.id, people.dee.cookie)).body as ThumbnailBriefDetail;
    expect([waiting.state, waiting.draftOptions, waiting.roundsSent]).toEqual(['in_review', 0, 1]);
  });

  it('tells whoever made the option it was picked, and the brief’s designer that it’s done', async () => {
    const s = await sentRound(people.dee, { title: 'Moved while waiting' });
    await send('PATCH', `/api/thumbnails/${s.id}`, people.max.cookie, { designerId: people.dan.id });
    const picked = (await decide(s.id, { roundId: s.round.id, action: 'pick', optionId: s.b.id, note: 'Bold' })).body as ThumbnailBriefDetail;
    const told = async (decisionId: number) => db.query<{ user_id: number; title: string; body: string }>(
      `select user_id, title, body from notifications where type = 'thumbnail_picked' and thumbnail_decision_id = $1 and link = $2 order by user_id`,
      [decisionId, `/studio/briefs/${s.id}`],
    );
    expect(await told(picked.decision!.id)).toEqual([
      { user_id: people.dee.id, title: 'Option B picked · Moved while waiting', body: 'Max Manager picked option B of round 1: “Bold”' },
      { user_id: people.dan.id, title: 'Picked · Moved while waiting', body: 'Max Manager picked Dee Designer’s option B from round 1, so this brief is done: “Bold”' },
    ].sort((a, b) => a.user_id - b.user_id));
    // the win is on Dee's wall, not Dan's
    const wall = async (cookie: string) => ((await send('GET', '/api/studio', cookie)).body as StudioPayload).wins.map((w) => w.option.id);
    expect([(await wall(people.dee.cookie)).includes(s.b.id), (await wall(people.dan.cookie)).includes(s.b.id)]).toEqual([true, false]);
    // deciding again takes both messages back; changes go to Dan, who makes the next round
    const changed = (await decide(s.id, { roundId: s.round.id, action: 'changes', note: 'After all: brighter' })).body as ThumbnailBriefDetail;
    expect(await told(picked.decision!.id)).toEqual([]);
    const changes = await db.query<{ user_id: number }>(`select user_id from notifications where type = 'thumbnail_changes' and thumbnail_decision_id = $1`, [changed.decision!.id]);
    expect(changes.map((n) => n.user_id)).toEqual([people.dan.id]);
  });

  it('takes back what a designer hasn’t read about a brief moved before they sent anything on it', async () => {
    const unread = async (userId: number, briefId: number) => (await notes(userId)).filter((n) => n.link === `/studio/briefs/${briefId}` && !n.read_at).map((n) => n.type);
    const b = await brief(people.dee.id, { title: 'Never started' });
    expect(await unread(people.dee.id, b.id)).toEqual(['thumbnail_new']);
    await send('PATCH', `/api/thumbnails/${b.id}`, people.max.cookie, { designerId: people.dan.id });
    // it would only open "not found" for her now
    expect([await unread(people.dee.id, b.id), (await detail(b.id, people.dee.cookie)).status]).toEqual([[], 404]);
    expect(await unread(people.dan.id, b.id)).toEqual(['thumbnail_new']);
    // given back, she's told again; moved to nobody, the message goes again
    await send('PATCH', `/api/thumbnails/${b.id}`, people.max.cookie, { designerId: people.dee.id });
    expect([await unread(people.dee.id, b.id), await unread(people.dan.id, b.id)]).toEqual([['thumbnail_new'], []]);
    await send('PATCH', `/api/thumbnails/${b.id}`, people.max.cookie, { designerId: null });
    expect(await unread(people.dee.id, b.id)).toEqual([]);
    // a designer who sent a round on it can still open it, so what they were told stays
    const s = await sentRound(people.dee, { title: 'Started' });
    await decide(s.id, { roundId: s.round.id, action: 'changes', note: 'Warmer' });
    await send('PATCH', `/api/thumbnails/${s.id}`, people.max.cookie, { designerId: people.dan.id });
    expect([await unread(people.dee.id, s.id), (await detail(s.id, people.dee.cookie)).status]).toEqual([['thumbnail_new', 'thumbnail_changes'], 200]);
  });

  it('shows a client’s picked winners beside a brief, to any designer who works for that client', async () => {
    const won = await sentRound(people.dan, { clientId: globex, title: 'Kitchen tour' });
    await decide(won.id, { roundId: won.round.id, action: 'pick', optionId: won.b.id, note: 'Clean and bright' });
    const mine = await brief(people.dee.id, { clientId: globex, title: 'Pantry tour' });
    const d = (await detail(mine.id, people.dee.cookie)).body as ThumbnailBriefDetail;
    expect(d.recentWinners.map((w) => [w.title, w.option.id, w.option.uploadedByName, w.reason])).toContainEqual(['Kitchen tour', won.b.id, 'Dan Drawer', 'Clean and bright']);
    expect(d.recentWinners.every((w) => w.clientId === globex && w.briefId !== mine.id)).toBe(true);
    // the winner opens for Dee; Dan's unpicked option doesn't
    expect([await fileStatus(won.b.fileId, people.dee.cookie), await fileStatus(won.a.fileId, people.dee.cookie)]).toEqual([200, 404]);
    expect(d.look).toMatchObject({ clientId: globex, clientName: 'Globex', images: [], resources: [] });
  });
});

describe('the Studio, the board and the badges', () => {
  it('leads with changes asked, then the next brief, then a fresh pick, else all clear', async () => {
    const sky = await person('Sky Studio', 'editor', 'thumbnail');
    const studio = async (cookie = sky.cookie, q = '') => (await send('GET', `/api/studio${q}`, cookie)).body as StudioPayload;
    expect([(await studio()).hero, (await studio()).justPicked]).toEqual([{ kind: 'clear' }, null]);

    const later = await brief(sky.id, { title: 'Later', dueOn: '2999-03-01' });
    const soon = await brief(sky.id, { title: 'Soon', dueOn: '2000-01-01' });
    let s = await studio();
    expect([s.hero.kind, s.hero.kind === 'next' && s.hero.brief.id, s.board.map((b) => b.title)]).toEqual(['next', soon.id, ['Soon', 'Later']]);
    expect(s.counts).toEqual({ pickedThisMonth: 0, waitingOnReview: 0, dueThisWeek: 1, onPlate: 2 });

    // Soon is sent; changes are asked on it
    await upload(soon.id, sky.cookie);
    const sent = (await sendRound(soon.id, sky.cookie)).body as ThumbnailBriefDetail;
    expect((await studio()).counts).toMatchObject({ waitingOnReview: 1, onPlate: 1 });
    await decide(soon.id, { roundId: sent.rounds[0].id, action: 'changes', note: 'Make the title huge' });
    s = await studio();
    expect(s.hero.kind).toBe('changes');
    if (s.hero.kind === 'changes') expect([s.hero.brief.id, s.hero.decision.note, s.hero.round.id, s.hero.brief.nextRound]).toEqual([soon.id, 'Make the title huge', sent.rounds[0].id, 2]);

    // Later picked while Soon waits on its changes: the pick shows on top of the changes hero, not only once all is clear
    await upload(later.id, sky.cookie);
    const l1 = (await sendRound(later.id, sky.cookie)).body as ThumbnailBriefDetail;
    await decide(later.id, { roundId: l1.rounds[0].id, action: 'pick', optionId: l1.rounds[0].options[0].id });
    s = await studio();
    expect([s.hero.kind, s.justPicked?.title, s.justPicked?.option.id]).toEqual(['changes', 'Later', l1.rounds[0].options[0].id]);
    // Soon cancelled: the fresh pick is the hero itself, then all clear
    await send('PATCH', `/api/thumbnails/${soon.id}`, people.max.cookie, { cancelled: true });
    s = await studio();
    expect([s.hero.kind, s.justPicked?.title, s.board, s.wins.map((w) => w.title)]).toEqual(['picked', 'Later', [], ['Later']]);
    expect(s.counts).toEqual({ pickedThisMonth: 1, waitingOnReview: 0, dueThisWeek: 0, onPlate: 0 });
    await db.query(`update thumbnail_decisions set created_at = now() - interval '13 hours' where round_id = $1`, [l1.rounds[0].id]);
    expect([(await studio()).hero, (await studio()).justPicked]).toEqual([{ kind: 'clear' }, null]);
  });

  it('opens a designer’s Studio to managers read-only, without the tray', async () => {
    const ivy = await person('Ivy Ink', 'editor', 'thumbnail');
    const b = await brief(ivy.id);
    await upload(b.id, ivy.cookie);
    const own = (await send('GET', '/api/studio', ivy.cookie)).body as StudioPayload;
    expect([own.readOnly, own.designer.name, own.board[0].draftOptions, own.board[0].cover?.letter]).toEqual([false, 'Ivy Ink', 1, 'A']);
    // a designer's ?userId= is ignored: it's always their own
    expect(((await send('GET', `/api/studio?userId=${people.dee.id}`, ivy.cookie)).body as StudioPayload).designer.id).toBe(ivy.id);
    const r = await send('GET', `/api/studio?userId=${ivy.id}`, people.max.cookie);
    const seen = r.body as StudioPayload;
    expect([r.status, seen.readOnly, seen.designer.id, seen.board[0].draftOptions, seen.board[0].cover, seen.board[0].state]).toEqual([200, true, ivy.id, 1, null, 'drafting']);
    for (const q of [`?userId=${people.wes.id}`, `?userId=${people.vic.id}`, '']) expect((await send('GET', `/api/studio${q}`, people.max.cookie)).status).toBe(404);
  });

  it('gives managers a board, a review queue and each designer’s load, counted from rows', async () => {
    const zed = await person('Zed Zoom', 'editor', 'thumbnail');
    const waiting = await sentRound(zed, { title: 'Waiting' });
    const asked = await sentRound(zed, { title: 'Asked' });
    await decide(asked.id, { roundId: asked.round.id, action: 'changes', note: 'Warmer colours' });
    const done = await sentRound(zed, { title: 'Done' });
    await decide(done.id, { roundId: done.round.id, action: 'pick', optionId: done.a.id });
    await brief(zed.id, { title: 'Fresh', dueOn: '2000-01-01' });
    const board = (await send('GET', `/api/thumbnails?designerId=${zed.id}`, people.max.cookie)).body as ThumbnailBoard;
    expect(board.briefs.map((b) => [b.title, b.state])).toEqual([['Asked', 'changes'], ['Fresh', 'to_design'], ['Waiting', 'in_review'], ['Done', 'picked']]);
    expect(board.toReview.map((x) => [x.brief.id, x.round.id, x.round.options.length])).toEqual([[waiting.id, waiting.round.id, 2]]);
    expect(board.counts).toEqual({ toReview: 1, changes: 1, withDesigners: 2, pickedThisWeek: 1, needsDesigner: 0 });
    expect(board.designers.find((d) => d.id === zed.id)).toEqual({ id: zed.id, name: 'Zed Zoom', open: 3, dueThisWeek: 1, inReview: 1 });
    expect(board.designers.every((d) => d.id !== people.vic.id && d.id !== people.wes.id)).toBe(true);
    // narrowed by client
    const globexOnly = (await send('GET', `/api/thumbnails?designerId=${zed.id}&clientId=${globex}`, people.max.cookie)).body as ThumbnailBoard;
    expect(globexOnly.briefs).toEqual([]);
    expect((await send('GET', '/api/thumbnails?clientId=nope', people.max.cookie)).status).toBe(400);

    // the menu badges agree with the board and the Studio
    const all = (await send('GET', '/api/thumbnails', people.max.cookie)).body as ThumbnailBoard;
    const counts = async (cookie: string) => (await send('GET', '/api/counts', cookie)).body as Counts;
    const maxCounts = await counts(people.max.cookie);
    expect([maxCounts.thumbnailsToReview, maxCounts.thumbnailsOpen]).toEqual([all.toReview.length, all.briefs.filter((b) => isOpenThumb(b.state)).length]);
    const zedCounts = await counts(zed.cookie);
    expect([zedCounts.myThumbnails, zedCounts.thumbnailsToReview, zedCounts.thumbnailsOpen]).toEqual([2, 0, 0]);
    // a brief with no designer yet counts as open (the Thumbnails item shows for it); cancelled, it doesn't
    const loose = await brief(null, { title: 'Nobody yet' });
    expect((await counts(people.max.cookie)).thumbnailsOpen).toBe(maxCounts.thumbnailsOpen + 1);
    await send('PATCH', `/api/thumbnails/${loose.id}`, people.max.cookie, { cancelled: true });
    expect((await counts(people.max.cookie)).thumbnailsOpen).toBe(maxCounts.thumbnailsOpen);
    expect(((await send('GET', '/api/studio', zed.cookie)).body as StudioPayload).counts.onPlate).toBe(2);
    // a designer who has left: their open briefs need a designer
    await db.query(`update users set active = false where id = $1`, [zed.id]);
    const left = (await send('GET', `/api/thumbnails?designerId=${zed.id}`, people.max.cookie)).body as ThumbnailBoard;
    expect([left.counts.needsDesigner, left.counts.withDesigners, left.designers.some((d) => d.id === zed.id)]).toEqual([3, 0, false]);
  });
});
