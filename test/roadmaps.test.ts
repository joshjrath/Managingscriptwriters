// Content roadmaps: tidying what Claude read from a PDF, who each role goes to, where a deliverable stands, and the
// routes with a stand-in for Claude (ctx.roadmapReader): a manager uploads the November roadmap, each role is given
// to someone and told, everyone reads it (editors included), the person on a deliverable or a manager ticks it, a
// manager moves a role, the Calendar shows the deliverables, and a roadmap is removed.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import type { Db } from '../server/db';
import type { Ctx } from '../server/core';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { ROADMAP_SCHEMA, type RoadmapReader } from '../server/roadmaps';
import { NOVEMBER_2026_ROADMAP } from '../server/roadmap-sample';
import { autoAssign, taskState, tidyRoadmap, type AssignCandidate } from '../shared/roadmap';
import type { CalendarEvent, RoadmapDetail, UserSummary } from '../shared/types';
import { freshDb } from './db';

describe('tidyRoadmap', () => {
  it('keeps the November roadmap as read: 4 videos in order, their deliverables, 5 roles and the playbook', () => {
    const r = tidyRoadmap(NOVEMBER_2026_ROADMAP, 'America/Toronto')!;
    expect(r.month).toBe('2026-11');
    expect(r.timezone).toBe('America/New_York');
    expect(r.videos.map((v) => v.publishDate)).toEqual(['2026-11-03', '2026-11-10', '2026-11-17', '2026-11-24']);
    expect(r.videos.map((v) => v.tasks.length)).toEqual([13, 12, 12, 12]);
    // sorted by day, the results on Oct 28 at noon between filming and the rough edit
    expect(r.videos[0].tasks.map((t) => t.step).slice(4, 7)).toEqual(['film', 'results', 'rough_edit']);
    expect(r.roles.map((x) => x.key)).toEqual(['approver', 'writer', 'host', 'thumbnail', 'editor']);
    expect(r.workflow).toHaveLength(5);
    expect(r.checklist).toHaveLength(4);
  });

  it('drops what isn’t real, adds a publish day, and refuses a PDF with no videos', () => {
    const r = tidyRoadmap({
      title: '  Spring  ', timezone: 'Not/AZone', defaultTime: '25:00',
      videos: [
        { title: 'No day', publishDate: '2026-02-30', tasks: [] },
        { title: 'Real', publishDate: '2026-03-10', publishTime: '9:30', tasks: [
          { step: 'script', title: 'Script', date: '2026-03-02', time: null, role: 'writer' },
          { step: 'script', title: 'Script', date: '2026-03-02', time: null, role: 'writer' },
          { step: 'film', title: 'Film', date: 'soon', time: '10:00', role: 'host' },
          { step: 'mystery', title: 'Odd', date: '2026-03-03', time: null, role: 'intern' },
        ] },
      ],
    }, 'America/New_York')!;
    expect([r.title, r.timezone, r.defaultTime, r.month]).toEqual(['Spring', 'America/New_York', '17:00', '2026-03']);
    expect(r.videos).toHaveLength(1);
    expect(r.videos[0].publishTime).toBe('09:30');
    expect(r.videos[0].tasks.map((t) => [t.step, t.role])).toEqual([['script', 'writer'], ['other', 'other'], ['publish', 'approver']]);
    // every role a deliverable names has a row
    expect(r.roles.map((x) => x.key)).toEqual(['approver', 'writer', 'other']);
    expect(tidyRoadmap({ videos: [{ title: 'x', publishDate: 'never' }] }, 'UTC')).toBeNull();
    expect(tidyRoadmap(null, 'UTC')).toBeNull();
  });
});

describe('what Claude is asked for', () => {
  it('has no union types (a nullable field is one): nested in lists they make the schema too complex for the API to compile', () => {
    const json = JSON.stringify(betaZodOutputFormat(ROADMAP_SCHEMA));
    expect(json.match(/"anyOf"|"type":\[/g) ?? []).toEqual([]);
    // and tidyRoadmap reads an empty string as nothing given
    const r = tidyRoadmap({ ...NOVEMBER_2026_ROADMAP, brand: '', videos: [{ ...NOVEMBER_2026_ROADMAP.videos[0], tag: '', publishTime: '', tasks: [] }] }, 'UTC')!;
    expect([r.brand, r.videos[0].tag, r.videos[0].publishTime]).toEqual([null, null, null]);
  });
});

describe('autoAssign', () => {
  const p = (id: number, name: string, role: AssignCandidate['role'], load = 0, editorKind: AssignCandidate['editorKind'] = null, active = true): AssignCandidate => ({ id, name, role, editorKind, active, load });
  const team = [
    p(1, 'Josh Rath', 'owner'), p(2, 'Max Manager', 'manager'), p(3, 'Wes Writer', 'writer', 6), p(4, 'Rae Writer', 'writer', 2),
    p(5, 'Old Writer', 'writer', 0, null, false), p(6, 'Dee Designer', 'editor', 0, 'thumbnail'), p(7, 'Vic Video', 'editor', 0, 'short_form'), p(8, 'Josh Other', 'writer', 9),
  ];
  it('gives a named person their role, by full name or an only first name', () => {
    expect(autoAssign({ key: 'approver', person: 'Josh Rath' }, team)).toBe(1);
    expect(autoAssign({ key: 'host', person: 'Max' }, team)).toBe(2);
    // two Joshes: the name decides nothing, so the approver goes to the Admin
    expect(autoAssign({ key: 'approver', person: 'Josh' }, team)).toBe(1);
    expect(autoAssign({ key: 'writer', person: 'Josh' }, team)).toBe(4);
  });
  it('else gives each kind of job to the least busy active person who does it, and a host to nobody', () => {
    expect(autoAssign({ key: 'writer', person: null }, team)).toBe(4);
    expect(autoAssign({ key: 'thumbnail', person: null }, team)).toBe(6);
    expect(autoAssign({ key: 'editor', person: null }, team)).toBe(7);
    expect(autoAssign({ key: 'host', person: null }, team)).toBeNull();
    expect(autoAssign({ key: 'approver', person: null }, team.filter((x) => x.role !== 'owner'))).toBe(2);
  });
});

describe('taskState', () => {
  const now = { date: '2026-10-28', minutes: 13 * 60 };
  it('is overdue once its day and time have passed in the roadmap’s zone', () => {
    expect(taskState({ date: '2026-10-28', time: '12:00', done: false }, now)).toBe('overdue');
    expect(taskState({ date: '2026-10-28', time: null, done: false }, now)).toBe('today');
    expect(taskState({ date: '2026-10-27', time: null, done: true }, now)).toBe('done');
    expect(taskState({ date: '2026-10-31', time: null, done: false }, now)).toBe('soon');
    expect(taskState({ date: '2026-11-05', time: null, done: false }, now)).toBe('upcoming');
  });
});

// ── the routes ───────────────────────────────────────────────────────────

let db: Db;
let app: FastifyInstance;
let ctx: Ctx;
let admin = '';
type Person = { id: number; cookie: string };
const people = {} as Record<'max' | 'wes' | 'dee' | 'vic', Person>;
let reads = 0;
const reader: RoadmapReader = { async read() { reads++; return NOVEMBER_2026_ROADMAP; } };

type Res = { status: number; body: ReturnType<typeof JSON.parse> };
const send = async (method: string, url: string, cookie: string, body?: unknown): Promise<Res> => {
  const r = await app.inject({
    method: method as 'POST', url, headers: { 'x-scale-media': '1', cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
const upload = async (cookie: string, file: string, fields: Record<string, string> = {}): Promise<Res> => {
  const boundary = '----roadmap';
  const payload = [
    ...Object.entries(fields).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}`),
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="November Roadmap.pdf"\r\nContent-Type: application/pdf\r\n\r\n${file}`,
    `--${boundary}--\r\n`,
  ].join('\r\n');
  const r = await app.inject({ method: 'POST', url: '/api/roadmaps/import', headers: { 'x-scale-media': '1', cookie, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
  return { status: r.statusCode, body: JSON.parse(r.body) };
};

async function person(name: string, role: string, editorKind?: string): Promise<Person> {
  const email = `${name.toLowerCase().replace(/\W+/g, '.')}@scale.test`;
  const r = await send('POST', '/api/users', admin, { name, email, role, password: 'team-password-1', ...(editorKind ? { editorKind } : {}) });
  expect([r.status, r.body?.error]).toEqual([200, undefined]);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-scale-media': '1', 'content-type': 'application/json' }, payload: JSON.stringify({ email, password: 'team-password-1' }) });
  return { id: (r.body.users as UserSummary[]).find((u) => u.email === email)!.id, cookie: String(login.headers['set-cookie']).split(';')[0] };
}

beforeAll(async () => {
  db = await freshDb();
  // Oct 28, 2026 at 1 PM in New York
  ctx = { db, now: () => new Date('2026-10-28T17:00:00Z'), secureCookies: false, allowSetup: true, uploadLimitBytes: 5 * 1024 * 1024, roadmapReader: reader };
  app = await buildApp(ctx);
  const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { 'x-scale-media': '1', 'content-type': 'application/json' }, payload: JSON.stringify({ name: 'Josh Rath', email: 'josh@scale.test', password: 'admin-password-1' }) });
  admin = String(setup.headers['set-cookie']).split(';')[0];
  people.max = await person('Max Manager', 'manager');
  people.wes = await person('Wes Writer', 'writer');
  people.dee = await person('Dee Designer', 'editor', 'thumbnail');
  people.vic = await person('Vic Video', 'editor', 'short_form');
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('content roadmaps', () => {
  let r: RoadmapDetail;
  const josh = () => db.one<{ id: number }>(`select id from users where email = 'josh@scale.test'`).then((x) => Number(x!.id));

  it('only managers upload, and only a PDF', async () => {
    expect((await upload(people.wes.cookie, '%PDF-1.7 x')).status).toBe(403);
    const notPdf = await upload(people.max.cookie, 'hello, I am a text file');
    expect([notPdf.status, Object.keys(notPdf.body.error.fields)]).toEqual([400, ['file']]);
    expect(reads).toBe(0);
  });

  it('reads the PDF, gives each role to someone, marks what’s past done, and tells each person', async () => {
    const res = await upload(people.max.cookie, '%PDF-1.7 roadmap', { markPast: '1' });
    expect(res.status).toBe(200);
    r = res.body.roadmap;
    expect([r.title, r.month, r.videos.length, r.tasks.length, r.sourceName]).toEqual(['Scale Media November 2026 YouTube Roadmap', '2026-11', 4, 49, 'November Roadmap.pdf']);
    const by = Object.fromEntries(r.roles.map((x) => [x.key, x.userId]));
    expect(by).toEqual({ approver: await josh(), writer: people.wes.id, host: null, thumbnail: people.dee.id, editor: people.vic.id });
    // before Oct 28 is done; the results due at noon today are overdue (it's 1 PM), filming yesterday is done
    const done = r.tasks.filter((t) => t.doneAt).map((t) => t.date);
    expect(done.every((d) => d < '2026-10-28')).toBe(true);
    expect(done).toHaveLength(5);
    expect(r.tasks.find((t) => t.step === 'results')!.doneAt).toBeNull();
    const notes = await db.query<{ user_id: number; body: string; link: string }>(`select user_id, body, link from notifications where dedupe_key = $1 order by user_id`, [`roadmap:${r.id}`]);
    // the manager who uploaded it isn't told; Josh, Wes, Dee and Vic are
    expect(notes.map((n) => Number(n.user_id)).sort((a, b) => a - b)).toEqual([await josh(), people.wes.id, people.dee.id, people.vic.id].sort((a, b) => a - b));
    expect(notes.find((n) => Number(n.user_id) === people.wes.id)!.body).toBe('You own 5 deliverables · next due Oct 28.');
  });

  it('everyone reads it, editors included', async () => {
    for (const p of [people.wes, people.dee, people.vic]) {
      expect((await send('GET', '/api/roadmaps', p.cookie)).body.roadmaps.map((x: { id: number }) => x.id)).toEqual([r.id]);
      expect((await send('GET', `/api/roadmaps/${r.id}`, p.cookie)).status).toBe(200);
    }
    expect((await send('GET', '/api/roadmaps/999', people.wes.cookie)).status).toBe(404);
  });

  it('the person on a deliverable or a manager ticks it, nobody else', async () => {
    const script = r.tasks.find((t) => t.step === 'script' && !t.doneAt)!;
    const approval = r.tasks.find((t) => t.step === 'approval' && !t.doneAt)!;
    expect((await send('POST', `/api/roadmap-tasks/${approval.id}/done`, people.wes.cookie, { done: true })).status).toBe(403);
    expect((await send('POST', `/api/roadmap-tasks/${script.id}/done`, people.dee.cookie, { done: true })).status).toBe(403);
    const ok = await send('POST', `/api/roadmap-tasks/${script.id}/done`, people.wes.cookie, { done: true });
    expect(ok.status).toBe(200);
    expect((ok.body.roadmap as RoadmapDetail).tasks.find((t) => t.id === script.id)!.doneByName).toBe('Wes Writer');
    const back = await send('POST', `/api/roadmap-tasks/${script.id}/done`, people.max.cookie, { done: false });
    expect((back.body.roadmap as RoadmapDetail).tasks.find((t) => t.id === script.id)!.doneAt).toBeNull();
  });

  it('a manager moves a role: its deliverables go with it, and the new person is told', async () => {
    expect((await send('PATCH', `/api/roadmaps/${r.id}/roles/host`, people.wes.cookie, { userId: people.wes.id })).status).toBe(403);
    expect((await send('PATCH', `/api/roadmaps/${r.id}/roles/host`, people.max.cookie, { userId: 9999 })).status).toBe(400);
    const res = await send('PATCH', `/api/roadmaps/${r.id}/roles/host`, people.max.cookie, { userId: people.max.id });
    expect(res.status).toBe(200);
    const film = (res.body.roadmap as RoadmapDetail).tasks.filter((t) => t.role === 'host');
    expect(film.map((t) => t.assigneeId)).toEqual([people.max.id, people.max.id, people.max.id, people.max.id]);
    // Max moved it to himself, so he isn't told
    expect(await db.one(`select 1 from notifications where user_id = $1 and dedupe_key = $2`, [people.max.id, `roadmap:${r.id}`])).toBeUndefined();
    await send('PATCH', `/api/roadmaps/${r.id}/roles/host`, admin, { userId: people.max.id });
  });

  it('shows the deliverables on the Calendar, a writer’s own and every publish day', async () => {
    const all = (await send('GET', '/api/calendar?from=2026-11-01&to=2026-11-30', people.max.cookie)).body.events as CalendarEvent[];
    const content = all.filter((e) => e.type === 'content');
    expect(content.length).toBe(r.tasks.filter((t) => t.date >= '2026-11-01' && t.date <= '2026-11-30').length);
    const pub = content.find((e) => e.start === '2026-11-03' && e.content?.step === 'publish')!;
    expect(pub.title).toBe('Publish · I Let 10 Strangers Choose Their Lawyer');
    expect(pub.content).toMatchObject({ roadmapId: r.id, time: '12:00' });
    const wes = (await send('GET', `/api/calendar?from=2026-11-01&to=2026-11-30&writerId=${people.wes.id}`, people.wes.cookie)).body.events as CalendarEvent[];
    expect(new Set(wes.filter((e) => e.type === 'content').map((e) => e.content!.step))).toEqual(new Set(['script', 'publish']));
    const vic = (await send('GET', '/api/calendar?from=2026-11-01&to=2026-11-30', people.vic.cookie)).body.events as CalendarEvent[];
    expect(vic.some((e) => e.type === 'content')).toBe(true);
  });

  it('a manager removes it: gone from the tab and the Calendar', async () => {
    expect((await send('DELETE', `/api/roadmaps/${r.id}`, people.wes.cookie)).status).toBe(403);
    expect((await send('DELETE', `/api/roadmaps/${r.id}`, people.max.cookie)).status).toBe(200);
    expect((await send('GET', '/api/roadmaps', people.wes.cookie)).body.roadmaps).toEqual([]);
    expect((await send('GET', `/api/roadmaps/${r.id}`, people.wes.cookie)).status).toBe(404);
    const events = (await send('GET', '/api/calendar?from=2026-11-01&to=2026-11-30', people.max.cookie)).body.events as CalendarEvent[];
    expect(events.some((e) => e.type === 'content')).toBe(false);
  });

  it('without the AI key, uploading says it isn’t set up', async () => {
    const off = await buildApp({ ...ctx, roadmapReader: null });
    try {
      const r2 = await off.inject({ method: 'POST', url: '/api/roadmaps/import', headers: { 'x-scale-media': '1', cookie: people.max.cookie, 'content-type': 'application/json' }, payload: '{}' });
      expect([r2.statusCode, JSON.parse(r2.body).error.code]).toEqual([503, 'not_configured']);
    } finally {
      await off.close();
    }
  });
});
