// Ask AI and the roadmap changes it proposes. The changes route (managers): a video moved with its deliverables, one
// video's scripting given to Ben while the month's writer keeps the rest, a video added on another's schedule, a
// deliverable changed and removed, all-or-nothing when one change is wrong. The assistant route, with a stand-in for
// Claude (ctx.assistant): what it reads (the page, the team, the batches, the roadmap with its ids), and how its tool
// calls become proposals the browser applies through the site's own routes, merged when they're one roadmap's, with
// anything that doesn't fit left out and said so.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import type { Db } from '../server/db';
import type { Ctx } from '../server/core';
import { saveRoadmap } from '../server/roadmaps';
import { assistantTools, type SiteAssistant } from '../server/assistant';
import { NOVEMBER_2026_ROADMAP } from '../server/roadmap-sample';
import { tidyRoadmap } from '../shared/roadmap';
import type { AssistantReply, RoadmapDetail, UserSummary } from '../shared/types';
import { diffDays } from '../shared/dates';
import { freshDb } from './db';

let db: Db;
let app: FastifyInstance;
let ctx: Ctx;
let admin = '';
type Person = { id: number; cookie: string };
const people = {} as Record<'max' | 'ben' | 'sarah', Person>;
let rid = 0;
let batchId = 0;
let seen: { context: string; messages: { role: string; content: string }[] } | null = null;
let answer: Awaited<ReturnType<SiteAssistant['ask']>> = { reply: '', calls: [] };
const assistant: SiteAssistant = { async ask(input) { seen = input; return answer; } };

type Res = { status: number; body: ReturnType<typeof JSON.parse> };
const send = async (method: string, url: string, cookie: string, body?: unknown): Promise<Res> => {
  const r = await app.inject({
    method: method as 'POST', url, headers: { 'x-scale-media': '1', cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
async function person(name: string, role: string): Promise<Person> {
  const email = `${name.toLowerCase().replace(/\W+/g, '.')}@scale.test`;
  const r = await send('POST', '/api/users', admin, { name, email, role, password: 'team-password-1' });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-scale-media': '1', 'content-type': 'application/json' }, payload: JSON.stringify({ email, password: 'team-password-1' }) });
  return { id: (r.body.users as UserSummary[]).find((u) => u.email === email)!.id, cookie: String(login.headers['set-cookie']).split(';')[0] };
}
const roadmap = async () => (await send('GET', `/api/roadmaps/${rid}`, people.max.cookie)).body.roadmap as RoadmapDetail;
const changes = (ops: unknown[], cookie = people.max.cookie) => send('POST', `/api/roadmaps/${rid}/changes`, cookie, { ops });

beforeAll(async () => {
  db = await freshDb();
  ctx = { db, now: () => new Date('2026-10-29T16:00:00Z'), secureCookies: false, allowSetup: true, uploadLimitBytes: 1024 * 1024, assistant };
  app = await buildApp(ctx);
  const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { 'x-scale-media': '1', 'content-type': 'application/json' }, payload: JSON.stringify({ name: 'Josh Rath', email: 'josh@scale.test', password: 'admin-password-1' }) });
  admin = String(setup.headers['set-cookie']).split(';')[0];
  people.max = await person('Max Manager', 'manager');
  people.sarah = await person('Sarah Chen', 'writer');
  people.ben = await person('Ben Nassim', 'writer');
  const josh = (await db.one<{ id: number }>(`select id from users where email = 'josh@scale.test'`))!;
  rid = await saveRoadmap(db, tidyRoadmap(NOVEMBER_2026_ROADMAP, 'America/New_York')!, { me: { id: Number(josh.id), name: 'Josh Rath', email: '', role: 'owner', capacityPerDay: null, editorKind: null }, sourceName: 'november.pdf' });
  // the month's writer is Sarah
  expect((await changes([{ op: 'assign_role', role: 'writer', userId: people.sarah.id }])).status).toBe(200);
  const clientId = (await send('POST', '/api/clients', admin, { name: 'Acme Dental' })).body.clientId as number;
  batchId = (await send('POST', '/api/batches', admin, { clientId, title: 'November reels', targetCount: 6, draftDue: '2026-11-02', finalDue: '2026-11-06', split: [{ writerId: people.sarah.id, count: 6 }] })).body.batchId;
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('changing a roadmap', () => {
  it('moves a video a day later with all its deliverables, keeping its week', async () => {
    const before = await roadmap();
    const week3 = before.videos[2];
    const res = await changes([{ op: 'update_video', videoId: week3.id, publishDate: '2026-11-18' }]);
    expect(res.status).toBe(200);
    expect(res.body.lines).toEqual([expect.stringMatching(/^Week 3 “\$0 vs \$3,000 vs \$10,000 Law Firm Marketing”: move to Wed, Nov 18 with its 12 deliverables$/)]);
    const after = res.body.roadmap as RoadmapDetail;
    const was = before.tasks.filter((t) => t.videoId === week3.id);
    for (const t of after.tasks.filter((k) => k.videoId === week3.id)) {
      const old = was.find((k) => k.id === t.id)!;
      expect([t.title, diffDays(t.date, old.date)]).toEqual([t.title, 1]);
    }
    expect(after.videos[2]).toMatchObject({ id: week3.id, position: 3, publishDate: '2026-11-18' });
  });

  it('gives one video’s scripting to Ben, tells him, and lets him tick it; the other weeks stay with Sarah', async () => {
    const r = await roadmap();
    const week3 = r.videos[2];
    const res = await changes([{ op: 'assign_video', videoId: week3.id, role: 'writer', userId: people.ben.id }]);
    expect(res.status).toBe(200);
    const after = res.body.roadmap as RoadmapDetail;
    const writerTasks = after.tasks.filter((t) => t.role === 'writer');
    expect(writerTasks.filter((t) => t.videoId === week3.id).map((t) => [t.assigneeId, t.ownAssignee])).toEqual([[people.ben.id, true]]);
    expect(new Set(writerTasks.filter((t) => t.videoId !== week3.id).map((t) => t.assigneeId))).toEqual(new Set([people.sarah.id]));
    expect(await db.one<{ body: string }>(`select body from notifications where user_id = $1 and dedupe_key = $2`, [people.ben.id, `roadmap:${rid}`])).toEqual({ body: expect.stringMatching(/^You own 1 deliverable/) });
    const script = writerTasks.find((t) => t.videoId === week3.id)!;
    expect((await send('POST', `/api/roadmap-tasks/${script.id}/done`, people.sarah.cookie, { done: true })).status).toBe(403);
    expect((await send('POST', `/api/roadmap-tasks/${script.id}/done`, people.ben.cookie, { done: true })).status).toBe(200);
    // the Calendar shows it as Ben's
    const cal = (await send('GET', `/api/calendar?from=2026-11-01&to=2026-11-30&writerId=${people.ben.id}`, people.ben.cookie)).body.events as { content?: { taskId: number } }[];
    expect(cal.some((e) => e.content?.taskId === script.id)).toBe(true);
  });

  it('adds a video on the closest video’s schedule, and changes and removes one deliverable', async () => {
    const res = await changes([{ op: 'add_video', title: 'A Bonus Upload', publishDate: '2026-12-01', publishTime: '12:00', idea: 'An extra one.' }]);
    expect(res.status).toBe(200);
    const r = res.body.roadmap as RoadmapDetail;
    const added = r.videos.find((v) => v.title === 'A Bonus Upload')!;
    const week4 = r.videos.find((v) => v.publishDate === '2026-11-24')!;
    const mine = r.tasks.filter((t) => t.videoId === added.id);
    // the same deliverables as Week 4, a week later
    expect(mine.map((t) => [t.step, t.title, diffDays(t.date, added.publishDate)])).toEqual(
      r.tasks.filter((t) => t.videoId === week4.id).map((t) => [t.step, t.title, diffDays(t.date, week4.publishDate)]),
    );
    expect([added.position, added.idea, mine.find((t) => t.step === 'publish')!.time]).toEqual([5, 'An extra one.', '12:00']);
    const rough = mine.find((t) => t.step === 'rough_edit')!;
    const moved = await changes([{ op: 'update_task', taskId: rough.id, date: '2026-11-27', time: '10:00', assigneeId: people.max.id }]);
    expect((moved.body.roadmap as RoadmapDetail).tasks.find((t) => t.id === rough.id)).toMatchObject({ date: '2026-11-27', time: '10:00', assigneeId: people.max.id, ownAssignee: true });
    const gone = await changes([{ op: 'remove_task', taskId: rough.id }]);
    expect((gone.body.roadmap as RoadmapDetail).tasks.some((t) => t.id === rough.id)).toBe(false);
    const removed = await changes([{ op: 'remove_video', videoId: added.id }]);
    expect((removed.body.roadmap as RoadmapDetail).videos.map((v) => v.position)).toEqual([1, 2, 3, 4]);
  });

  it('is all or nothing, managers only', async () => {
    const r = await roadmap();
    const bad = await changes([{ op: 'update_video', videoId: r.videos[0].id, title: 'Changed' }, { op: 'remove_video', videoId: 999999 }]);
    expect([bad.status, bad.body.error.message]).toEqual([400, 'Change 2: that video isn’t on this roadmap']);
    expect((await roadmap()).videos[0].title).toBe(r.videos[0].title);
    expect((await changes([{ op: 'assign_role', role: 'host', userId: 999999 }])).status).toBe(400);
    expect((await changes([{ op: 'update_video', videoId: r.videos[0].id, title: 'Mine now' }], people.sarah.cookie)).status).toBe(403);
    expect((await changes([])).status).toBe(400);
  });
});

describe('Ask AI', () => {
  it('builds tools the API takes', () => {
    const tools = assistantTools();
    expect(tools.length).toBeGreaterThan(15);
    for (const t of tools) {
      expect([t.name, t.input_schema.type, '$schema' in t.input_schema]).toEqual([t.name, 'object', false]);
    }
  });

  it('reads the page and the workspace, and turns its calls into proposals the browser applies', async () => {
    const r = await roadmap();
    const week3 = r.videos[2];
    answer = {
      reply: 'Here’s Week 3 rebuilt around your idea, with Ben scripting it.',
      calls: [
        { name: 'roadmap_update_video', input: { roadmapId: rid, videoId: week3.id, title: 'I Hired 3 Law Firms Undercover', idea: 'Call three firms as a new client.', beats: [{ title: 'The calls', body: 'Three calls, one script.' }], thumbnailText: 'WHO CALLED BACK?' } },
        { name: 'roadmap_assign_video', input: { roadmapId: rid, videoId: week3.id, role: 'writer', userId: people.ben.id } },
        { name: 'update_batch', input: { batchId, finalDue: '2026-11-09', priority: 'high' } },
        { name: 'assign_scripts', input: { batchId, scriptNumbers: [5, 6, 99], writerId: people.ben.id } },
        { name: 'open_page', input: { path: `/content/${rid}` } },
        { name: 'delete_everything', input: {} },
        { name: 'roadmap_remove_video', input: { roadmapId: rid } },
        { name: 'open_page', input: { path: 'https://evil.example' } },
      ],
    };
    const res = await send('POST', '/api/assistant', people.max.cookie, { path: `/batches/${batchId}`, messages: [{ role: 'user', content: 'Change the 3rd video to my undercover idea, Ben scripts it; and push this batch to the 9th' }] });
    expect(res.status).toBe(200);
    const out = res.body as AssistantReply;
    // what Claude read
    expect(seen!.messages).toEqual([{ role: 'user', content: expect.stringContaining('undercover') }]);
    for (const bit of [`page /batches/${batchId}`, 'Ben Nassim', `Batch #${batchId} “November reels”`, `Video #${week3.id}, Week 3`, 'On this page: batch', '#5 not started (Sarah Chen)']) expect(seen!.context).toContain(bit);
    // what came back
    expect(out.reply).toMatch(/^Here’s Week 3/);
    expect(out.proposals).toHaveLength(4);
    const [road, batch, scripts, go] = out.proposals;
    expect(road.lines).toEqual([
      expect.stringMatching(/^Week 3 “.+”: rename to “I Hired 3 Law Firms Undercover”, rewrite its brief$/),
      expect.stringMatching(/^Week 3 “.+”: the writer’s deliverables to Ben Nassim$/),
    ]);
    expect(road.request).toMatchObject({ method: 'POST', path: `/api/roadmaps/${rid}/changes` });
    expect((road.request!.body as { ops: unknown[] }).ops).toHaveLength(2);
    expect(batch).toMatchObject({ lines: ['Acme Dental · “November reels”: high priority, final delivery Nov 9'], request: { method: 'PATCH', path: `/api/batches/${batchId}`, body: { priority: 'high', finalDue: { mode: 'manual', date: '2026-11-09' } } } });
    expect(scripts.lines).toEqual(['“November reels” (Acme Dental): scripts #5, #6 to Ben Nassim']);
    expect((scripts.request!.body as { scriptIds: number[] }).scriptIds).toHaveLength(2);
    expect(go).toEqual({ lines: [`Open /content/${rid}`], navigate: `/content/${rid}` });
    expect(out.skipped).toEqual(['an unknown change (delete_everything)', 'a roadmap change that wasn’t complete (remove video)', 'a page that isn’t on the site']);

    // the browser applies them through the site's own routes
    for (const p of [road, batch, scripts]) expect((await send(p.request!.method, p.request!.path, people.max.cookie, p.request!.body)).status).toBe(200);
    const after = await roadmap();
    expect(after.videos[2]).toMatchObject({ title: 'I Hired 3 Law Firms Undercover', thumbnailText: 'WHO CALLED BACK?', beats: [{ title: 'The calls', body: 'Three calls, one script.' }] });
    const b = (await send('GET', `/api/batches/${batchId}`, people.max.cookie)).body;
    expect([b.finalDue, b.priority, b.scripts.filter((s: { assigneeId: number }) => s.assigneeId === people.ben.id).length]).toEqual(['2026-11-09', 'high', 2]);
  });

  it('is for managers, needs the key, and answers a question last', async () => {
    const msg = { path: '/', messages: [{ role: 'user', content: 'Hi' }] };
    expect((await send('POST', '/api/assistant', people.sarah.cookie, msg)).status).toBe(403);
    expect((await send('POST', '/api/assistant', people.max.cookie, { path: '/', messages: [{ role: 'assistant', content: 'Hi' }] })).status).toBe(400);
    const off = await buildApp({ ...ctx, assistant: null });
    try {
      const r = await off.inject({ method: 'POST', url: '/api/assistant', headers: { 'x-scale-media': '1', cookie: people.max.cookie, 'content-type': 'application/json' }, payload: JSON.stringify(msg) });
      expect([r.statusCode, JSON.parse(r.body).error.code]).toEqual([503, 'not_configured']);
    } finally {
      await off.close();
    }
    const boot = async (cookie: string) => (await send('GET', '/api/bootstrap', cookie)).body.assistant;
    expect([await boot(people.max.cookie), await boot(people.sarah.cookie)]).toEqual([true, false]);
  });
});
