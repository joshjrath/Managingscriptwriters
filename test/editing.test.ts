// Editors: the videos editors cut, read from Timeliner (a stand-in here, no network; the webhook's messages are
// signed the way Timeliner signs them), what each editor says they're on, and the managers' Editors tab.

import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import type { Db } from '../server/db';
import type { Ctx } from '../server/core';
import { connectOnStart, TIMELINER_EVENTS, TimelinerError, type TimelinerApi, type TimelinerTask } from '../server/timeliner';
import { onShift } from '../shared/cities';
import { compressTitles, isFocusStale, isOnPlate, videoState } from '../shared/workflow';
import type { BatchDetail, EditingBoard, EditingVideo, EditorRow, MyEditing } from '../shared/types';
import { freshDb } from './db';

const NOW = new Date('2026-10-08T13:40:00Z'); // Thursday 9:40 AM in New York
let clock = NOW;
const later = (minutes: number) => { clock = new Date(clock.getTime() + minutes * 60_000); return clock.toISOString(); };
const SECRET = `whsec_${'cd'.repeat(32)}`;

// ── Timeliner, as a stand-in ─────────────────────────────────────────────

const video = (id: string, title: string, statusGroup: string, more: Partial<TimelinerTask> = {}): TimelinerTask => ({
  id, title, statusGroup, status: 'active', type: 'media', projectId: 'p_mine', brandId: 'b_js', subFolderId: 'sf_org',
  assigneeIds: [], internalDeadline: null, externalDeadline: null, internalRevisions: 0, clientRevisions: 0,
  createdAt: '2026-10-07T15:00:00Z', updatedAt: '2026-10-07T15:00:00Z', approvedAt: null, ...more,
});
let tasks: TimelinerTask[] = [
  video('t_o1', 'Organic 01', 'supervisorApproval', { assigneeIds: ['m_leo'], internalDeadline: '2026-10-09' }),
  video('t_o3', 'Organic 03', 'inRevision', { assigneeIds: ['m_leo'], internalDeadline: '2026-10-09', internalRevisions: 1 }),
  video('t_o5', 'Organic 05', 'toDo', { assigneeIds: ['m_leo'], internalDeadline: '2026-10-09' }),
  video('t_o6', 'Organic 06', 'toDo', { assigneeIds: ['m_leo'], internalDeadline: '2026-10-09' }),
  // from the shoot before: approved this week
  video('t_o4old', 'Organic 04', 'approved', { assigneeIds: ['m_leo'], createdAt: '2026-09-30T15:00:00Z', updatedAt: '2026-10-05T15:00:00Z', approvedAt: '2026-10-05T15:00:00Z' }),
  video('t_a3', 'Ad 03', 'toDo', { assigneeIds: ['m_maya'], subFolderId: 'sf_ads', internalDeadline: '2026-10-08' }),
  video('t_b1', 'Video 01', 'supervisorApproval', { assigneeIds: ['m_priya'], projectId: 'p_bright', brandId: 'b_bright', subFolderId: null }),
  // nobody has these yet
  video('t_o7', 'Organic 07', 'toDo', { internalDeadline: '2026-10-09' }),
  video('t_o8', 'Organic 08', 'toDo', { internalDeadline: '2026-10-09' }),
  // given to someone who isn't on the site
  video('t_o9', 'Organic 09', 'toDo', { assigneeIds: ['m_ghost'] }),
  // never kept: a script document, a trashed video and one finished long ago
  video('t_doc', 'Organic scripts', 'toDo', { type: 'doc' }),
  video('t_trash', 'Organic 10', 'toDo', { status: 'trashed', assigneeIds: ['m_leo'] }),
  video('t_ancient', 'Organic 99', 'approved', { assigneeIds: ['m_leo'], updatedAt: '2026-08-01T15:00:00Z', approvedAt: '2026-08-01T15:00:00Z' }),
];
const moves: Record<string, { at: string; to: string | null; byId: string | null }> = {
  t_o1: { at: '2026-10-07T17:15:00Z', to: 'Needs review', byId: 'm_leo' },
  t_o3: { at: '2026-10-08T12:00:00Z', to: 'Revisions requested', byId: 'm_ada' },
  t_b1: { at: '2026-10-07T20:00:00Z', to: 'Internal approval', byId: 'm_priya' },
};
const PAGE = 5;
let down = false;
let readOnly = false;
/** the key may not read tasks: GET /tasks/{id} is refused */
let taskRefused = false;
/** the list never ends within the read's page cap (newest first, like Timeliner's) */
let endless = false;
/** runs once while a read is between its pages, as if Timeliner sent a message just then */
let duringRead: (() => Promise<void>) | null = null;
const newestFirst = (list: TimelinerTask[]) => [...list].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
let hooks: Awaited<ReturnType<TimelinerApi['webhooks']>> = [];
const calls: string[] = [];
const fake: TimelinerApi = {
  project: async (id) => ({
    p_mine: { id, name: 'My Videos', nodeId: 'b_js', subFolders: [{ id: 'sf_org', name: 'Organic' }, { id: 'sf_ads', name: 'Ads' }] },
    p_bright: { id, name: 'Spring campaign', nodeId: 'b_bright', subFolders: [] },
    p_summer: { id, name: 'Summer campaign', nodeId: 'b_sun', subFolders: [] },
    p_autumn: { id, name: 'Autumn campaign', nodeId: 'b_sun', subFolders: [] },
  } as Record<string, Awaited<ReturnType<TimelinerApi['project']>>>)[id] ?? null,
  brand: async (id) => ({ b_js: { id, name: 'Joshua Shalimar' }, b_bright: { id, name: 'Brightside' }, b_sun: { id, name: 'Sunny Days' } } as Record<string, { id: string; name: string }>)[id] ?? null,
  task: async (id) => {
    if (taskRefused) throw new TimelinerError('The Timeliner key isn’t allowed to read tasks.', 403);
    return tasks.find((t) => t.id === id) ?? null;
  },
  // two pages, so the cursor is followed
  tasks: async (before) => {
    if (down) throw new TimelinerError('Couldn’t reach Timeliner. Try again in a minute.', 0);
    if (before && duringRead) { const run = duringRead; duringRead = null; await run(); }
    if (endless) return before ? { data: [], nextBefore: `${before}+` } : { data: newestFirst(tasks).slice(0, PAGE), nextBefore: 'more' };
    return before ? { data: tasks.slice(PAGE), nextBefore: null } : { data: tasks.slice(0, PAGE), nextBefore: tasks.length > PAGE ? '2026-10-01T00:00:00.000Z' : null };
  },
  brands: async () => ({ data: [{ id: 'b_js', name: 'Joshua Shalimar' }, { id: 'b_bright', name: 'Brightside' }], nextBefore: null }),
  members: async () => [
    { id: 'm_ada', email: 'ada@scale.test', firstName: 'Ada', lastName: 'Admin', role: 'admin' },
    { id: 'm_leo', email: 'LEO@scale.test', firstName: 'Leo', lastName: 'Martins', role: 'editor' },
    { id: 'm_maya', email: 'maya@scale.test', firstName: 'Maya', lastName: 'Reyes', role: 'editor' },
    { id: 'm_priya', email: 'priya@scale.test', firstName: 'Priya', lastName: 'Nair', role: 'editor' },
    { id: 'm_ghost', email: 'ghost@freelance.test', firstName: 'Gus', lastName: 'Ghost', role: 'editor' },
  ],
  brandMembers: async () => [],
  lastMove: async (id) => moves[id] ?? null,
  webhooks: async () => hooks,
  createWebhook: async (url, events) => { calls.push(`create ${events.join(',')}`); hooks = [{ id: 'wh_1', url, events, active: true }]; return { id: 'wh_1', secret: SECRET }; },
  updateWebhook: async (id, patch) => {
    if (readOnly) throw new TimelinerError('The Timeliner key isn’t allowed to write webhooks.', 403);
    calls.push(`update ${id} ${patch.events?.join(',')}${patch.active ? ' active' : ''}`);
  },
  rotateSecret: async () => ({ secret: SECRET }),
  testWebhook: async () => ({ ok: true, statusCode: 200, error: null }),
};

// ── the site ─────────────────────────────────────────────────────────────

let db: Db;
let app: FastifyInstance;
let ctx: Ctx;
let admin = '';
let writer = '';
let leo = '';
let maya = '';
let writerId = 0;

const send = async (method: string, url: string, cookie: string, body?: unknown) => {
  const r = await app.inject({
    method: method as 'POST', url, headers: { 'x-scale-media': '1', cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
const board = async () => (await send('GET', '/api/editing', admin)).body as EditingBoard;
const mine = async (cookie: string) => (await send('GET', '/api/editing/me', cookie)).body as MyEditing;
const focus = (cookie: string, videoId: string, action: string) => send('POST', '/api/editing/focus', cookie, { videoId, action });
const editor = (b: EditingBoard, name: string) => b.editors.find((e) => e.name === name) as EditorRow;
const find = (list: EditingVideo[], title: string) => list.find((v) => v.title === title) as EditingVideo;

let n = 0;
const hook = (type: string, data: Record<string, unknown>) => {
  const raw = JSON.stringify({ id: `evt_${++n}`, type, apiVersion: '2026-06-02', createdAt: clock.toISOString(), workspaceId: 'ws_1', data });
  const t = Math.floor(clock.getTime() / 1000);
  const signature = `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex')}`;
  return app.inject({ method: 'POST', url: '/hooks/timeliner', headers: { 'content-type': 'application/json', 'x-timeliner-signature': signature }, payload: raw });
};

/** a batch whose scripts are sent as one document and approved (with the manager's edited version, when given) */
async function finishedBatch(clientId: number, title: string, count: number, o: { shoot?: string; shootId?: number; doc: string; edited?: string }) {
  let id: number;
  let shootId = o.shootId ?? null;
  if (o.shoot) {
    const r = await send('POST', '/api/shoots', admin, { clientId, startDate: o.shoot, endDate: null, batch: { title, targetCount: count, split: [{ writerId, count }], briefingIds: [], priority: 'normal' } });
    expect([r.status, r.body?.error]).toEqual([200, undefined]);
    id = r.body.batchId;
    shootId = r.body.shootId;
  } else {
    const r = await send('POST', '/api/batches', admin, { clientId, title, targetCount: count, split: [{ writerId, count }], ...(shootId ? { shootId } : { finalDue: '2026-10-02' }) });
    expect([r.status, r.body?.error]).toEqual([200, undefined]);
    id = r.body.batchId;
  }
  const ids = ((await send('GET', `/api/batches/${id}`, admin)).body as BatchDetail).scripts.map((s) => s.id);
  expect((await send('POST', `/api/batches/${id}/submissions`, writer, { scriptIds: ids, url: o.doc })).status).toBe(200);
  expect((await send('POST', `/api/batches/${id}/review`, admin, { action: 'approve', scriptIds: ids, ...(o.edited ? { url: o.edited } : {}) })).status).toBe(200);
  await approvedNow(id);
  return { id, shootId };
}

/** approvals are stamped by the database's clock; these tests run on their own, so the batch's approvals take it */
const approvedNow = (batchId: number) => db.query(`update scripts set approved_at = $2 where batch_id = $1 and approved_at is not null`, [batchId, clock.toISOString()]);

const ids = { sep28: 0, oct6: 0, ads: 0, bright: 0, shalimar: 0, brightside: 0 };

beforeAll(async () => {
  db = await freshDb();
  ctx = { db, now: () => clock, secureCookies: false, allowSetup: true, uploadLimitBytes: 1024 * 1024, timeliner: fake, publicUrl: 'https://scripts.example.com' };
  app = await buildApp(ctx);
  const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0];
  const json = (url: string, body: unknown, cookie?: string) =>
    app.inject({ method: 'POST', url, headers: { 'x-scale-media': '1', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, payload: JSON.stringify(body) });
  admin = cookieOf(await json('/api/auth/setup', { name: 'Ada Admin', email: 'ada@scale.test', password: 'admin-password-1' }));
  const people: [string, string, string, string?][] = [
    ['Wes Writer', 'wes@scale.test', 'writer'],
    ['Leo Martins', 'leo@scale.test', 'editor', 'Europe/Lisbon'],
    ['Maya Reyes', 'maya@scale.test', 'editor', 'America/Argentina/Buenos_Aires'],
    ['Priya Nair', 'priya@scale.test', 'editor', 'Asia/Manila'],
  ];
  for (const [name, email, role, timezone] of people) {
    const r = await json('/api/users', { name, email, role, password: 'team-password-1', ...(timezone ? { timezone, workStart: 9, workEnd: 18 } : {}) }, admin);
    expect(r.statusCode).toBe(200);
    if (role === 'writer') writerId = JSON.parse(r.body).users.find((u: { email: string }) => u.email === email).id;
  }
  const login = async (email: string) => cookieOf(await json('/api/auth/login', { email, password: 'team-password-1' }));
  writer = await login('wes@scale.test');
  leo = await login('leo@scale.test');
  maya = await login('maya@scale.test');
  // the one-editor rule was on long before these videos were made (test/one-editor-rule.test.ts covers its start)
  expect((await send('PATCH', '/api/settings', admin, { oneEditorSince: '2026-01-01' })).status).toBe(200);
  ids.shalimar = JSON.parse((await json('/api/clients', { name: 'Joshua Shalimar' }, admin)).body).clientId;
  ids.brightside = JSON.parse((await json('/api/clients', { name: 'Brightside' }, admin)).body).clientId;

  ids.sep28 = (await finishedBatch(ids.shalimar, 'Organic · Sep 28', 8, { shoot: '2026-09-28', doc: 'https://docs.example/organic-sep28' })).id;
  const oct6 = await finishedBatch(ids.shalimar, 'Organic · Oct 6', 8, { shoot: '2026-10-06', doc: 'https://docs.example/organic-oct6', edited: 'https://docs.example/organic-oct6-edited' });
  ids.oct6 = oct6.id;
  ids.ads = (await finishedBatch(ids.shalimar, 'Ads · Oct 6', 4, { shootId: oct6.shootId!, doc: 'https://docs.example/ads-oct6' })).id;
  ids.bright = (await finishedBatch(ids.brightside, 'Spring scripts', 3, { doc: 'https://docs.example/bright' })).id;
  // linked to its Timeliner project when its document was uploaded there
  await db.query(`update batches set timeliner_project_id = 'p_bright' where id = $1`, [ids.bright]);
});

afterAll(async () => {
  await app.close();
  await db.close();
});

// ── rules ────────────────────────────────────────────────────────────────

describe('where a video stands', () => {
  it('maps Timeliner’s steps to a few plain states (the team skips In progress, so it’s still to edit)', () => {
    expect(['toDo', 'inProgress', 'inRevision', 'supervisorApproval', 'clientApproval', 'endClientApproval', 'approved', 'posted', 'something new'].map(videoState))
      .toEqual(['to_edit', 'to_edit', 'revisions', 'in_review', 'with_client', 'with_client', 'approved', 'approved', 'to_edit']);
    expect((['to_edit', 'revisions', 'in_review', 'with_client', 'approved'] as const).map(isOnPlate)).toEqual([true, true, false, false, false]);
  });

  it('lists videos that differ only by their number as ranges', () => {
    expect(compressTitles(['Organic 26', 'Organic 27', 'Organic 28', 'Organic 30', 'Ad 09', 'Ad 10', 'Teaser'])).toBe('Organic 26–28, 30, Ad 09–10, Teaser');
  });

  it('takes an I’m on this left running for still marked, not editing now', () => {
    const since = '2026-10-08T03:00:00Z';
    const after = (hours: number) => Date.parse(since) + hours * 3600_000;
    expect(isFocusStale({ state: 'on', since }, false, after(9.9))).toBe(false);
    expect(isFocusStale({ state: 'on', since }, false, after(10))).toBe(true);
    // outside their working hours
    expect(isFocusStale({ state: 'on', since }, true, after(1))).toBe(true);
    // paused is paused, however long
    expect(isFocusStale({ state: 'paused', since }, true, after(20))).toBe(false);
  });

  it('knows who is within their working hours, where they are', () => {
    expect(onShift([9, 18], 'Europe/Lisbon', NOW)).toBe(true); // 2:40 PM
    expect(onShift([9, 18], 'Asia/Manila', NOW)).toBe(false); // 9:40 PM
    expect(onShift([20, 28], 'Asia/Manila', NOW)).toBe(true); // a shift past midnight
    expect(onShift([9, 33], 'Asia/Manila', NOW)).toBe(true); // around the clock
  });
});

// ── reading Timeliner ────────────────────────────────────────────────────

describe('reading Timeliner', () => {
  it('shows the editors before Timeliner has been read', async () => {
    const b = await board();
    expect(b.sync).toEqual({ keySet: true, syncedAt: null, error: null, counts: null });
    expect(b.editors.map((e) => e.name).sort()).toEqual(['Leo Martins', 'Maya Reyes', 'Priya Nair']);
    expect(editor(b, 'Leo Martins').videos).toEqual([]);
    // nothing read yet: each editor's card says what Timeliner must have
    expect(editor(b, 'Leo Martins').flag).toEqual({
      kind: 'nothing_assigned', text: 'Nothing assigned in Timeliner (their Timeliner email must be leo@scale.test)', timelinerEmail: null, siteEmail: 'leo@scale.test',
    });
  });

  it('reads every video and matches it to its client, batch, script and document', async () => {
    const r = await send('POST', '/api/editing/sync', admin, {});
    expect(r.status).toBe(200);
    const b = r.body as EditingBoard;
    // ten videos kept, given to four people, under two Timeliner brands
    expect(b.sync).toEqual({ keySet: true, syncedAt: NOW.toISOString(), error: null, counts: { videos: 10, people: 4, clients: 2, skipped: 0 } });

    const leoRow = editor(b, 'Leo Martins');
    // the newest shoot on or before the video was made, in the folder's batch (Organic, not Ads). Still to be
    // edited, its title doesn't say which script it is (it would have to say "#5"), and there's no scripts PDF:
    // it gets the shoot's document from the site, the edited version its scripts were approved with
    expect(find(leoRow.videos, 'Organic 05')).toMatchObject({
      state: 'to_edit', step: 'To be edited', folder: 'My Videos › Organic', due: '2026-10-09', raw: false,
      client: { id: ids.shalimar, name: 'Joshua Shalimar' }, batch: { id: ids.oct6, title: 'Organic · Oct 6', shootDate: '2026-10-06' }, scriptNumber: null,
      script: { href: 'https://docs.example/organic-oct6-edited', edited: true, ranges: '1–8', source: 'site', alt: null }, scriptIssue: null,
      match: { how: 'date', kept: false, sure: false, check: false, note: 'Made Oct 7, 1 day after the Oct 6 shoot (the word “organic” picks Organic · Oct 6)' },
    });
    // back for revisions, its title's number is its script: the manager's edited version
    expect(find(leoRow.videos, 'Organic 03')).toMatchObject({
      batch: { id: ids.oct6 }, scriptNumber: 3, scriptIssue: null,
      script: { href: 'https://docs.example/organic-oct6-edited', edited: true, ranges: '1–8', batchId: ids.oct6, source: 'site', version: null, inReview: false, alt: null },
    });
    // a video made after the shoot before goes with that shoot's batch
    expect(find(leoRow.videos, 'Organic 04')).toMatchObject({ state: 'approved', batch: { id: ids.sep28 }, scriptNumber: 4, script: { href: 'https://docs.example/organic-sep28', edited: false } });
    // the exact step and when it moved there, from the video's history
    expect(find(leoRow.videos, 'Organic 01')).toMatchObject({ state: 'in_review', step: 'Needs review', movedAt: '2026-10-07T17:15:00.000Z' });
    expect(find(leoRow.videos, 'Organic 03')).toMatchObject({ state: 'revisions', step: 'Revisions requested', revisionRound: 1 });

    const mayaRow = editor(b, 'Maya Reyes');
    // the Ads folder's word picks the Ads batch of the same shoot
    expect(find(mayaRow.videos, 'Ad 03')).toMatchObject({ folder: 'My Videos › Ads', batch: { id: ids.ads }, scriptNumber: null });
    // a batch linked to the Timeliner project wins
    expect(find(editor(b, 'Priya Nair').videos, 'Video 01')).toMatchObject({ step: 'Internal approval', state: 'in_review', folder: 'Spring campaign', client: { id: ids.brightside }, batch: { id: ids.bright }, scriptNumber: 1 });

    // documents, trashed videos and long-finished ones aren't kept
    const kept = (await db.query<{ id: string }>(`select id from timeliner_tasks order by id`)).map((x) => x.id);
    expect(kept).toEqual(['t_a3', 't_b1', 't_o1', 't_o3', 't_o4old', 't_o5', 't_o6', 't_o7', 't_o8', 't_o9']);
  });

  it('puts the managers’ board together: plates, what’s next, last finished, nobody yet, and who isn’t on the site', async () => {
    const b = await board();
    expect(b.totals).toEqual({ editingNow: 0, paused: 0, dueToday: 1, revisions: 1, waitingOnYou: 2, notAssigned: 2, notMatched: 0, toCheck: 0 });
    // due today first, then revisions; off hours last. Gus isn't on the site: his card sorts with the rest, flagged
    expect(b.editors.map((e) => [e.name, e.offHours])).toEqual([['Maya Reyes', false], ['Leo Martins', false], ['Gus Ghost', false], ['Priya Nair', true]]);
    expect(editor(b, 'Gus Ghost')).toMatchObject({
      key: 'mm_ghost', userId: null, memberId: 'm_ghost', site: false, focus: null, videos: [expect.objectContaining({ title: 'Organic 09' })],
      flag: { kind: 'not_on_site', text: 'Not on the site — add them in Settings → Team as an Editor with ghost@freelance.test' },
    });
    const leoRow = editor(b, 'Leo Martins');
    expect(leoRow.plate).toEqual({ toEdit: 2, rawToEdit: 0, revisions: 1, inReview: 1, withClient: 0, approvedWeek: 1 });
    expect(leoRow.nextUp?.title).toBe('Organic 03');
    expect(leoRow.lastFinished).toEqual({ title: 'Organic 01', at: '2026-10-07T17:15:00.000Z', onSite: false });
    expect(leoRow.scripts.map((s) => s.href)).toEqual(['https://docs.example/organic-oct6-edited']);
    expect(editor(b, 'Maya Reyes').dueToday).toBe(1);
    // still to be edited, their titles don't say which scripts they are: the shoot's document from the site
    expect(b.unassigned).toEqual([{
      folder: 'My Videos › Organic', clientName: 'Joshua Shalimar', count: 2, raw: false, batch: null, titles: 'Organic 07–08', due: '2026-10-09',
      videoTitles: ['Organic 07', 'Organic 08'], scripts: [expect.objectContaining({ href: 'https://docs.example/organic-oct6-edited', source: 'site', edited: true })],
      // Joshua Shalimar's editor: Leo has the most of its videos
      brand: 'Joshua Shalimar', suggested: { name: 'Leo Martins', userId: expect.any(Number), memberId: 'm_leo', key: expect.stringMatching(/^u\d+$/) },
    }]);
    expect(b.unknownAssignees).toEqual([{ name: 'Gus Ghost', email: 'ghost@freelance.test', count: 1 }]);
  });

  it('gives editors their own videos and nothing else', async () => {
    expect((await send('GET', '/api/editing', leo)).status).toBe(403);
    expect((await send('POST', '/api/editing/sync', leo, {})).status).toBe(403);
    const m = await mine(leo);
    expect(m.toEdit.map((v) => v.title)).toEqual(['Organic 05', 'Organic 06']);
    expect(m.revisions.map((v) => v.title)).toEqual(['Organic 03']);
    expect(m.waiting.map((v) => v.title)).toEqual(['Organic 01']);
    expect(m.approvedWeek.map((v) => v.title)).toEqual(['Organic 04']);
    expect(m.nextUp?.title).toBe('Organic 03');
    // someone with no videos in Timeliner gets an empty list, not an error
    expect(await mine(writer)).toMatchObject({ focus: null, nextUp: null, toEdit: [], revisions: [], waiting: [] });
  });
});

// ── what an editor is on ─────────────────────────────────────────────────

describe('I’m on this, Pause, Resume and Done', () => {
  it('starts only on their own video, still to edit or fix', async () => {
    const on = await focus(leo, 't_o5', 'start');
    expect(on.status).toBe(200);
    expect((on.body as MyEditing).focus).toMatchObject({ video: { id: 't_o5' }, state: 'on', since: clock.toISOString(), workedSeconds: 0, pausedAt: null });
    // next up never names the one they're on
    expect((on.body as MyEditing).nextUp?.title).toBe('Organic 03');
    expect((await focus(leo, 't_a3', 'start')).status).toBe(403);
    expect((await focus(writer, 't_o5', 'start')).status).toBe(403);
    expect((await focus(leo, 't_o1', 'start')).status).toBe(409);
    expect((await focus(leo, 't_o5', 'start')).status).toBe(409);
    expect((await focus(leo, 't_nope', 'start')).status).toBe(404);
    const b = await board();
    expect(b.totals.editingNow).toBe(1);
    expect(b.editors[0]).toMatchObject({ name: 'Leo Martins', focus: { state: 'on', video: { title: 'Organic 05' } } });
  });

  it('pauses and resumes only the video they’re on, counting the time on it', async () => {
    expect((await focus(leo, 't_o6', 'pause')).status).toBe(409);
    later(25);
    const paused = await focus(leo, 't_o5', 'pause');
    expect(paused.status).toBe(200);
    expect((paused.body as MyEditing).focus).toMatchObject({ state: 'paused', workedSeconds: 1500, pausedAt: clock.toISOString() });
    expect((await focus(leo, 't_o5', 'pause')).status).toBe(409);
    expect((await board()).totals).toMatchObject({ editingNow: 0, paused: 1 });
    later(5);
    expect((await focus(leo, 't_o6', 'resume')).status).toBe(409);
    const resumed = await focus(leo, 't_o5', 'resume');
    expect((resumed.body as MyEditing).focus).toMatchObject({ state: 'on', since: clock.toISOString(), workedSeconds: 1500, pausedAt: null });
    expect((await focus(leo, 't_o5', 'resume')).status).toBe(409);
  });

  it('marks a video done here, tells the managers, and leaves Timeliner alone', async () => {
    later(10);
    const done = await focus(leo, 't_o5', 'done');
    expect(done.status).toBe(200);
    const m = done.body as MyEditing;
    expect(m.focus).toBeNull();
    expect(m.toEdit.map((v) => v.title)).toEqual(['Organic 06']);
    // waiting until Timeliner has it in review
    expect(find(m.waiting, 'Organic 05')).toMatchObject({ state: 'to_edit', doneAt: clock.toISOString() });
    expect((await focus(leo, 't_o5', 'done')).status).toBe(409);
    const notes = (await send('GET', '/api/notifications', admin)).body.notifications;
    expect(notes[0]).toMatchObject({ type: 'review_request', title: 'Leo Martins finished Organic 05', link: '/editors' });
    expect(notes[0].body).toContain('after 35 min');
    const b = await board();
    expect(b.totals.waitingOnYou).toBe(3);
    expect(editor(b, 'Leo Martins').lastFinished).toEqual({ title: 'Organic 05', at: clock.toISOString(), onSite: true });
    // a video still to edit can be marked done without saying you're on it first
    expect((await focus(maya, 't_a3', 'done')).status).toBe(200);
    expect((await board()).totals.dueToday).toBe(0);
  });
});

// ── Timeliner telling the site ───────────────────────────────────────────

describe('Timeliner’s messages', () => {
  it('moves a video on the moment Timeliner says so, ending the focus on it', async () => {
    expect((await send('POST', '/api/timeliner/connect', admin, {})).status).toBe(200);
    expect(calls).toEqual(['create version.uploaded,file.uploaded,task.created,task.updated,task.status_changed,task.trashed,project.trashed']);
    expect((await focus(leo, 't_o6', 'start')).status).toBe(200);

    const sent = later(5);
    tasks = tasks.map((t) => (t.id === 't_o6' ? { ...t, statusGroup: 'supervisorApproval', updatedAt: sent } : t));
    moves.t_o6 = { at: sent, to: 'Needs review', byId: 'm_leo' };
    const r = await hook('task.status_changed', { taskId: 't_o6', projectId: 'p_mine', title: 'Organic 06', statusGroup: 'supervisorApproval', previousStatusGroup: 'toDo', changedAt: sent });
    expect([r.statusCode, JSON.parse(r.body).outcome]).toEqual([200, 'video']);
    const m = await mine(leo);
    expect(m.focus).toBeNull();
    expect(await db.one(`select 1 from editor_focus where task_id = 't_o6'`)).toBeUndefined();
    expect(find(m.waiting, 'Organic 06')).toMatchObject({ state: 'in_review', step: 'Needs review', movedAt: sent });
    expect(editor(await board(), 'Leo Martins').lastFinished).toEqual({ title: 'Organic 06', at: sent, onSite: false });
    // task messages aren't uploads: Settings → Timeliner doesn't list them
    expect((await send('GET', '/api/timeliner', admin)).body.events).toEqual([]);
  });

  it('drops a video trashed in Timeliner', async () => {
    tasks = tasks.filter((t) => t.id !== 't_o7');
    const r = await hook('task.trashed', { taskId: 't_o7', projectId: 'p_mine', title: 'Organic 07' });
    expect(r.statusCode).toBe(200);
    expect((await board()).unassigned).toMatchObject([{ count: 1, titles: 'Organic 08' }]);
  });

  it('answers a video message even when Timeliner won’t give the video back', async () => {
    // a key without Tasks (read): a failed delivery would be retried for hours and then switch the webhook off, uploads too
    taskRefused = true;
    try {
      const r = await hook('task.updated', { taskId: 't_o8', projectId: 'p_mine', title: 'Organic 08' });
      expect([r.statusCode, JSON.parse(r.body).outcome]).toEqual([200, 'video']);
      const ev = await db.one<{ outcome: string; detail: string }>(`select outcome, detail from timeliner_events where id = $1`, [`evt_${n}`]);
      expect(ev).toEqual({ outcome: 'ignored', detail: 'Couldn’t read the video from Timeliner, so the next timed read picks it up: The Timeliner key isn’t allowed to read tasks.' });
      // the copy stays as it was
      expect((await board()).unassigned).toMatchObject([{ titles: 'Organic 08' }]);
    } finally {
      taskRefused = false;
    }
  });

  it('gives an older webhook the video messages on start-up, and shrugs when a read-only key can’t', async () => {
    hooks = [{ id: 'wh_1', url: 'https://scripts.example.com/hooks/timeliner', events: ['version.uploaded', 'file.uploaded'], active: true }];
    const log: string[] = [];
    await connectOnStart(ctx, (m) => log.push(m));
    expect(calls.at(-1)).toBe('update wh_1 version.uploaded,file.uploaded,task.created,task.updated,task.status_changed,task.trashed,project.trashed');
    readOnly = true;
    await connectOnStart(ctx, (m) => log.push(m));
    expect(log.at(-1)).toMatch(/^timeliner: couldn't update the webhook/);
    readOnly = false;
  });

  it('leaves a webhook switched off in Timeliner as it is at start-up, and says so', async () => {
    // paused in Timeliner (by someone, or by Timeliner after failed deliveries): only Connect in Settings switches it back on
    hooks = [{ id: 'wh_1', url: 'https://scripts.example.com/hooks/timeliner', events: [...TIMELINER_EVENTS], active: false }];
    const log: string[] = [];
    const before = calls.length;
    await connectOnStart(ctx, (m) => log.push(m));
    expect(calls.length).toBe(before);
    expect(log).toEqual([expect.stringMatching(/^timeliner: the webhook is switched off in Timeliner \(left as it is/)]);
    // missing messages are still added, without switching it on
    hooks = [{ ...hooks[0], events: ['version.uploaded', 'file.uploaded'] }];
    await connectOnStart(ctx, (m) => log.push(m));
    expect(calls.slice(before)).toEqual([`update wh_1 ${TIMELINER_EVENTS.join(',')}`]);
    // on and complete: left alone
    hooks = [{ ...hooks[0], events: [...TIMELINER_EVENTS], active: true }];
    await connectOnStart(ctx, (m) => log.push(m));
    expect(calls.length).toBe(before + 1);
  });
});

describe('reading Timeliner again', () => {
  it('removes videos gone from Timeliner, and lets Timeliner’s move outrank a done mark', async () => {
    const moved = later(5);
    tasks = tasks.filter((t) => t.id !== 't_o9').map((t) => (t.id === 't_o5' ? { ...t, statusGroup: 'supervisorApproval', updatedAt: moved } : t));
    moves.t_o5 = { at: moved, to: 'Needs review', byId: 'm_leo' };
    const b = (await send('POST', '/api/editing/sync', admin, {})).body as EditingBoard;
    expect(b.unknownAssignees).toEqual([]);
    expect(await db.one(`select 1 from timeliner_tasks where id = 't_o9'`)).toBeUndefined();
    expect(find(editor(b, 'Leo Martins').videos, 'Organic 05')).toMatchObject({ state: 'in_review', doneAt: null });
  });

  it('keeps the last copy when Timeliner can’t be reached, and says why', async () => {
    down = true;
    const r = await send('POST', '/api/editing/sync', admin, {});
    down = false;
    expect(r.status).toBe(200);
    const b = r.body as EditingBoard;
    expect(b.sync.error).toBe('Couldn’t reach Timeliner. Try again in a minute.');
    expect(b.sync.syncedAt).not.toBeNull();
    expect(editor(b, 'Leo Martins').videos.length).toBeGreaterThan(0);
    // the next good read clears it
    expect(((await send('POST', '/api/editing/sync', admin, {})).body as EditingBoard).sync.error).toBeNull();
  });

  it('asks for the key when there isn’t one', async () => {
    ctx.timeliner = null;
    try {
      const r = await send('POST', '/api/editing/sync', admin, {});
      expect(r.status).toBe(400);
      expect(r.body.error.message).toMatch(/TIMELINER_API_KEY/);
      expect((await board()).sync.keySet).toBe(false);
    } finally {
      ctx.timeliner = fake;
    }
  });
});

// ── Done, once ───────────────────────────────────────────────────────────

describe('Done, once each time', () => {
  it('tells the managers once per video, however often it’s marked done again', async () => {
    for (const action of ['start', 'done', 'start', 'done']) {
      later(1);
      expect([action, (await focus(leo, 't_o3', action)).status]).toEqual([action, 200]);
    }
    const notes = await db.query(`select 1 from notifications n join users u on u.id = n.user_id where u.email = 'ada@scale.test' and n.title = 'Leo Martins finished Organic 03'`);
    expect(notes).toHaveLength(1);
  });

  it('takes two Dones of the same video one at a time', async () => {
    tasks = [...tasks, video('t_o12', 'Organic 12', 'toDo', { assigneeIds: ['m_leo'] })];
    expect((await hook('task.created', { taskId: 't_o12', projectId: 'p_mine', title: 'Organic 12' })).statusCode).toBe(200);
    later(1);
    // two tabs (or a retried request) on a video they never said they were on: no focus row to lock
    const both = await Promise.all([focus(leo, 't_o12', 'done'), focus(leo, 't_o12', 'done')]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await db.query(`select 1 from activity where action = 'video.done' and detail->>'taskId' = 't_o12'`)).toHaveLength(1);
  });

  it('counts a done mark only until Timeliner moves the video, so one sent back for revisions is on the plate again', async () => {
    // Organic 03 was marked done above; then it's reviewed and sent back for another round
    const reviewed = later(30);
    tasks = tasks.map((t) => (t.id === 't_o3' ? { ...t, statusGroup: 'supervisorApproval', updatedAt: reviewed } : t));
    moves.t_o3 = { at: reviewed, to: 'Needs review', byId: 'm_leo' };
    expect((await hook('task.status_changed', { taskId: 't_o3', projectId: 'p_mine' })).statusCode).toBe(200);
    const back = later(60);
    tasks = tasks.map((t) => (t.id === 't_o3' ? { ...t, statusGroup: 'inRevision', internalRevisions: 2, updatedAt: back } : t));
    moves.t_o3 = { at: back, to: 'Revisions requested', byId: 'm_ada' };
    expect((await hook('task.status_changed', { taskId: 't_o3', projectId: 'p_mine' })).statusCode).toBe(200);
    expect(find((await mine(leo)).revisions, 'Organic 03')).toMatchObject({ state: 'revisions', doneAt: null, revisionRound: 2 });
    later(5);
    expect((await focus(leo, 't_o3', 'done')).status).toBe(200);
  });
});

// ── which script an editor gets ──────────────────────────────────────────

/** a batch of `count` scripts, all Wes's, due Oct 2 */
async function newBatch(clientId: number, title: string, count: number) {
  const r = await send('POST', '/api/batches', admin, { clientId, title, targetCount: count, split: [{ writerId, count }], finalDue: '2026-10-02' });
  expect([r.status, r.body?.error]).toEqual([200, undefined]);
  const scripts = ((await send('GET', `/api/batches/${r.body.batchId}`, admin)).body as BatchDetail).scripts;
  return { id: r.body.batchId as number, all: scripts.map((s) => s.id), of: (...nums: number[]) => scripts.filter((s) => nums.includes(s.number)).map((s) => s.id) };
}
const review = async (batchId: number, body: Record<string, unknown>) => {
  expect((await send('POST', `/api/batches/${batchId}/review`, admin, body)).status).toBe(200);
  await approvedNow(batchId);
};
const openAsEditor = async (href: string) => (await app.inject({ method: 'GET', url: href, headers: { cookie: leo } })).statusCode;

describe('which script document an editor gets', () => {
  let sunny = 0;

  it('doesn’t let a long-lived project’s link to one batch claim every later shoot’s videos', async () => {
    // the Sep 28 scripts are uploaded to My Videos, which links that batch to the project
    const r = await hook('version.uploaded', { projectId: 'p_mine', taskId: 't_doc', brandId: 'b_js', fileName: 'Organic Sep 28.pdf', mimeType: 'application/pdf', uploadedBy: 'm_ada', taskTitle: 'Organic scripts' });
    expect([r.statusCode, JSON.parse(r.body).outcome]).toEqual([200, 'delivered']);
    expect(await db.one(`select timeliner_project_id as p from batches where id = $1`, [ids.sep28])).toEqual({ p: 'p_mine' });

    const b = (await send('POST', '/api/editing/sync', admin, {})).body as EditingBoard;
    const leoRow = editor(b, 'Leo Martins');
    // made after the Oct 6 shoot: that shoot's batch, its folder's word deciding Organic or Ads
    expect(find(leoRow.videos, 'Organic 05')).toMatchObject({ batch: { id: ids.oct6 } });
    expect(find(editor(b, 'Maya Reyes').videos, 'Ad 03')).toMatchObject({ batch: { id: ids.ads } });
    // made before it: the Sep 28 shoot, whose scripts PDF from Timeliner comes first and the site's document second
    expect(find(leoRow.videos, 'Organic 04')).toMatchObject({
      batch: { id: ids.sep28 }, scriptNumber: 4,
      script: { source: 'timeliner', href: `/api/editing/script-pdf/${ids.sep28}`, name: 'Organic Sep 28.pdf', version: 1, alt: { source: 'site', href: 'https://docs.example/organic-sep28' } },
    });
    // the PDF isn't a video
    expect(await db.one(`select 1 from timeliner_tasks where id = 't_doc'`)).toBeUndefined();
  });

  it('gives each script the edited version it was approved with, when a batch is approved in rounds', async () => {
    sunny = (await send('POST', '/api/clients', admin, { name: 'Sunny Days' })).body.clientId;
    const summer = await newBatch(sunny, 'Summer scripts', 8);
    expect((await send('POST', `/api/batches/${summer.id}/submissions`, writer, { scriptIds: summer.all, url: 'https://docs.example/summer-writer' })).status).toBe(200);
    await review(summer.id, { action: 'approve', scriptIds: summer.of(1, 2, 3, 4), url: 'https://docs.example/summer-edited-1to4' });
    await review(summer.id, { action: 'approve', scriptIds: summer.of(5, 6, 7, 8), url: 'https://docs.example/summer-edited-5to8' });
    await db.query(`update batches set timeliner_project_id = 'p_summer' where id = $1`, [summer.id]);
    // sent back for revisions: their titles' numbers are their scripts
    const where = { assigneeIds: ['m_priya'], projectId: 'p_summer', brandId: 'b_sun', subFolderId: null };
    tasks = [...tasks, video('t_s3', 'Summer 03', 'inRevision', where), video('t_s6', 'Summer 06', 'inRevision', where)];

    const priya = editor((await send('POST', '/api/editing/sync', admin, {})).body as EditingBoard, 'Priya Nair');
    expect(find(priya.videos, 'Summer 03')).toMatchObject({ batch: { id: summer.id }, scriptNumber: 3, script: { href: 'https://docs.example/summer-edited-1to4', edited: true, ranges: '1–4' } });
    expect(find(priya.videos, 'Summer 06')).toMatchObject({ batch: { id: summer.id }, scriptNumber: 6, script: { href: 'https://docs.example/summer-edited-5to8', edited: true, ranges: '5–8' } });
    expect(priya.scripts.map((s) => s.href)).toEqual(['https://docs.example/summer-edited-1to4', 'https://docs.example/summer-edited-5to8']);
  });

  it('links an uploaded document only once editors can open it', async () => {
    const autumn = await newBatch(sunny, 'Autumn scripts', 8);
    const boundary = '----edtest';
    const payload = [
      `--${boundary}\r\nContent-Disposition: form-data; name="scriptIds"\r\n\r\n${JSON.stringify(autumn.all)}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="autumn.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4 autumn`,
      `--${boundary}--\r\n`,
    ].join('\r\n');
    const up = await app.inject({ method: 'POST', url: `/api/batches/${autumn.id}/submissions`, headers: { 'x-scale-media': '1', cookie: writer, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
    expect(up.statusCode).toBe(200);
    const file = await db.one<{ file_id: number }>(`select file_id from submissions where id = $1`, [JSON.parse(up.body).submissionId]);
    const href = `/api/files/${file!.file_id}`;
    // 1–7 approved; 8 sent back and resent as a link, so the upload still holds a script that isn't finished
    await review(autumn.id, { action: 'approve', scriptIds: autumn.of(1, 2, 3, 4, 5, 6, 7) });
    await review(autumn.id, { action: 'revisions', scriptIds: autumn.of(8), note: 'Tighten the hook' });
    expect((await send('POST', `/api/batches/${autumn.id}/submissions`, writer, { scriptIds: autumn.of(8), url: 'https://docs.example/autumn-8' })).status).toBe(200);
    await db.query(`update batches set timeliner_project_id = 'p_autumn' where id = $1`, [autumn.id]);
    tasks = [...tasks, video('t_au3', 'Autumn 03', 'inRevision', { assigneeIds: ['m_priya'], projectId: 'p_autumn', brandId: 'b_sun', subFolderId: null })];

    const priya = editor((await send('POST', '/api/editing/sync', admin, {})).body as EditingBoard, 'Priya Nair');
    expect(find(priya.videos, 'Autumn 03')).toMatchObject({ batch: { id: autumn.id }, scriptNumber: 3, script: null });
    expect(await openAsEditor(href)).toBe(404);

    // once script 8 is approved too, the upload opens for editors and the video links to it
    await review(autumn.id, { action: 'approve', scriptIds: autumn.of(8) });
    expect(find(editor(await board(), 'Priya Nair').videos, 'Autumn 03')).toMatchObject({ script: { href, edited: false } });
    expect(await openAsEditor(href)).toBe(200);
  });
});

// ── reading while Timeliner changes ──────────────────────────────────────

describe('reading Timeliner while it changes', () => {
  it('keeps what Timeliner said while a read was under way', async () => {
    tasks = [video('t_x1', 'Organic 21', 'toDo', { assigneeIds: ['m_leo'] }), video('t_x2', 'Organic 22', 'toDo', { assigneeIds: ['m_leo'] }), ...tasks];
    later(1);
    await send('POST', '/api/editing/sync', admin, {});
    expect((await mine(leo)).toEdit.map((v) => v.title)).toEqual(expect.arrayContaining(['Organic 21', 'Organic 22']));

    // after the read has both as Leo's: Organic 21 is trashed and Organic 22 goes to Maya
    duringRead = async () => {
      const at = later(1);
      tasks = tasks.map((t) => (t.id === 't_x1' ? { ...t, status: 'trashed' } : t.id === 't_x2' ? { ...t, assigneeIds: ['m_maya'], updatedAt: at } : t));
      expect((await hook('task.trashed', { taskId: 't_x1', projectId: 'p_mine' })).statusCode).toBe(200);
      expect((await hook('task.updated', { taskId: 't_x2', projectId: 'p_mine' })).statusCode).toBe(200);
    };
    later(1);
    expect((await send('POST', '/api/editing/sync', admin, {})).status).toBe(200);
    expect(duringRead).toBeNull();
    expect(await db.one(`select 1 from timeliner_tasks where id = 't_x1'`)).toBeUndefined();
    expect(await db.one(`select assignee_ids from timeliner_tasks where id = 't_x2'`)).toEqual({ assignee_ids: ['m_maya'] });
    expect((await mine(leo)).toEdit.map((v) => v.title)).not.toEqual(expect.arrayContaining(['Organic 21']));
  });

  it('after a read that stops early, removes only what vanished from the stretch it read', async () => {
    const leos = { assigneeIds: ['m_leo'] };
    tasks = [
      ...tasks,
      video('t_new', 'Organic 31', 'toDo', { ...leos, createdAt: '2026-10-08T12:00:00Z', updatedAt: '2026-10-08T12:00:00Z' }),
      video('t_old', 'Organic 32', 'toDo', { ...leos, createdAt: '2026-09-01T12:00:00Z', updatedAt: '2026-09-01T12:00:00Z' }),
    ];
    later(1);
    await send('POST', '/api/editing/sync', admin, {});
    expect((await db.query(`select id from timeliner_tasks where id in ('t_new', 't_old') order by id`)).length).toBe(2);

    // both vanish; the next read stops at its page cap, having read back only to videos made on Oct 7
    tasks = tasks.filter((t) => t.id !== 't_new' && t.id !== 't_old');
    endless = true;
    try {
      later(1);
      expect((await send('POST', '/api/editing/sync', admin, {})).status).toBe(200);
    } finally {
      endless = false;
    }
    expect(await db.one(`select 1 from timeliner_tasks where id = 't_new'`)).toBeUndefined();
    // older than anything that read reached: it can't tell, so it stays
    expect(await db.one(`select 1 from timeliner_tasks where id = 't_old'`)).toBeDefined();
    expect(await db.one(`select 1 from timeliner_tasks where id = 't_o1'`)).toBeDefined();
  });

  it('drops the videos of a project trashed in Timeliner', async () => {
    expect(find(editor(await board(), 'Priya Nair').videos, 'Video 01')).toBeDefined();
    tasks = tasks.filter((t) => t.projectId !== 'p_bright');
    const r = await hook('project.trashed', { projectId: 'p_bright', brandId: 'b_bright', name: 'Spring campaign' });
    expect([r.statusCode, JSON.parse(r.body).outcome]).toEqual([200, 'video']);
    expect(editor(await board(), 'Priya Nair').videos.map((v) => v.title)).not.toContain('Video 01');
  });
});

// ── what ends a focus ────────────────────────────────────────────────────

describe('what ends what an editor is on', () => {
  const leoFocus = () => db.query<{ task_id: string }>(`select f.task_id from editor_focus f join users u on u.id = f.user_id where u.email = 'leo@scale.test'`);

  it('switches to another video, ending the one they were on', async () => {
    const leos = { assigneeIds: ['m_leo'], internalDeadline: '2026-10-12' };
    tasks = [...tasks, video('t_f1', 'Organic 41', 'toDo', leos), video('t_f2', 'Organic 42', 'toDo', leos), video('t_f3', 'Organic 43', 'toDo', leos)];
    for (const id of ['t_f1', 't_f2', 't_f3']) expect((await hook('task.created', { taskId: id, projectId: 'p_mine' })).statusCode).toBe(200);
    later(1);
    expect((await focus(leo, 't_f1', 'start')).status).toBe(200);
    later(10);
    const r = await focus(leo, 't_f2', 'start');
    expect(r.status).toBe(200);
    // a fresh start on the new one; the old one just ends (not paused, not done)
    expect((r.body as MyEditing).focus).toMatchObject({ video: { id: 't_f2' }, state: 'on', since: clock.toISOString(), workedSeconds: 0, pausedAt: null });
    expect(await leoFocus()).toEqual([{ task_id: 't_f2' }]);
    expect(find((r.body as MyEditing).toEdit, 'Organic 41')).toMatchObject({ doneAt: null });
  });

  it('ends it when Timeliner gives the video to someone else', async () => {
    const at = later(5);
    tasks = tasks.map((t) => (t.id === 't_f2' ? { ...t, assigneeIds: ['m_maya'], updatedAt: at } : t));
    expect((await hook('task.updated', { taskId: 't_f2', projectId: 'p_mine' })).statusCode).toBe(200);
    // still to be edited, but not Leo's any more
    expect(await leoFocus()).toEqual([]);
    expect((await mine(leo)).focus).toBeNull();
    expect((await mine(maya)).focus).toBeNull();
  });

  it('ends it when the video is trashed in Timeliner', async () => {
    later(1);
    expect((await focus(leo, 't_f1', 'start')).status).toBe(200);
    tasks = tasks.map((t) => (t.id === 't_f1' ? { ...t, status: 'trashed' } : t));
    expect((await hook('task.trashed', { taskId: 't_f1', projectId: 'p_mine' })).statusCode).toBe(200);
    expect(await leoFocus()).toEqual([]);
  });

  it('takes a done mark back when they start the video again', async () => {
    later(1);
    expect((await focus(leo, 't_f3', 'done')).status).toBe(200);
    expect(find((await mine(leo)).waiting, 'Organic 43')).toMatchObject({ doneAt: clock.toISOString() });
    later(1);
    const r = await focus(leo, 't_f3', 'start');
    expect(r.status).toBe(200);
    const m = r.body as MyEditing;
    expect(find(m.toEdit, 'Organic 43')).toMatchObject({ doneAt: null });
    expect(m.waiting.map((v) => v.title)).not.toContain('Organic 43');
    expect(await db.one(`select 1 from editing_done where task_id = 't_f3'`)).toBeUndefined();
  });

  it('doesn’t count one left running as editing now, or put it first', async () => {
    // both work around the clock, so only the time on it decides
    await db.query(`update users set work_start = 0, work_end = 24 where email in ('leo@scale.test', 'maya@scale.test')`);
    let b = await board();
    expect(b.totals.editingNow).toBe(1);
    expect(b.editors[0].name).toBe('Leo Martins');

    // ten hours later, Leo is still on Organic 43, and Maya starts the video she was given
    later(10 * 60);
    expect((await focus(maya, 't_f2', 'start')).status).toBe(200);
    b = await board();
    expect(b.totals.editingNow).toBe(1);
    expect(b.editors.map((e) => [e.name, e.focus?.state ?? null]).slice(0, 2)).toEqual([['Maya Reyes', 'on'], ['Leo Martins', 'on']]);

    // a fresh stretch outside their working hours (9 to 6 in Lisbon; the middle of the night there) is still marked, not editing now
    await db.query(`update users set work_start = 9, work_end = 18 where email = 'leo@scale.test'`);
    expect((await focus(leo, 't_f3', 'pause')).status).toBe(200);
    expect((await focus(leo, 't_f3', 'resume')).status).toBe(200);
    b = await board();
    expect(b.totals.editingNow).toBe(1);
    expect(editor(b, 'Leo Martins')).toMatchObject({ offHours: true, focus: { state: 'on' } });
  });
});
