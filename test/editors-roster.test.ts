// The Editors tab mirrors everything in Timeliner: everyone with videos there gets a card (people not on the site,
// or on it under another email, flagged to fix), clients without scripts on the site still show their videos, the
// totals count everyone's work, each client's editor is worked out from Timeliner (one editor per client), and a
// read that meets odd data skips just that item and says how much it read. Timeliner is a stand-in.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EditingBoard, EditingVideo, EditorRow } from '../shared/types';
import { timelinerClient, type TimelinerApi, type TimelinerTask } from '../server/timeliner';
import { syncTimeliner } from '../server/editing';
import { isNotMatched } from '../shared/workflow';
import { makeWorld, video, type World } from './timeliner-world';

let w: World;
const ids = { js: 0, bright: 0, oct6: 0, sam: 0, leo: 0 };
let b: EditingBoard;
const card = (name: string) => b.editors.find((e) => e.name === name) as EditorRow;
const all = (x: EditingBoard) => [...new Map(x.editors.flatMap((e) => e.videos).map((v) => [v.id, v])).values()];
const find = (list: EditingVideo[], title: string) => list.find((v) => v.title === title) as EditingVideo;
const add = (...t: Parameters<typeof video>[]) => { for (const x of t) w.tl.tasks.push(video(...x)); };
type Members = Awaited<ReturnType<TimelinerApi['members']>>;
const members: Members = [
  { id: 'm_ada', email: 'ada@scale.test', firstName: 'Ada', lastName: 'Admin', role: 'admin' },
  { id: 'm_leo', email: 'leo@scale.test', firstName: 'Leo', lastName: 'Martins', role: 'editor' },
  { id: 'm_maya', email: 'maya@scale.test', firstName: 'Maya', lastName: 'Reyes', role: 'editor' },
  // not on the site at all
  { id: 'm_gus', email: 'gus@freelance.test', firstName: 'Gus', lastName: 'Ghost', role: 'editor' },
  // not on the site, but in Settings → Editors (as "dana  diaz")
  { id: 'm_dana', email: 'dana@studio.test', firstName: 'Dana', lastName: 'Diaz', role: 'editor' },
  // on the site as Sam Lee, sam@scale.test: their emails differ (and Timeliner sends their name whole)
  { id: 'm_sam', email: 'sam.lee@gmail.test', firstName: null, lastName: null, name: 'sam  LEE', role: 'editor' } as Members[number],
];

beforeAll(async () => {
  w = await makeWorld();
  // the one-editor rule was on long before these videos were made (test/one-editor-rule.test.ts covers its start)
  await w.oneEditorSince('2026-01-01');
  w.api.members = async () => members;
  for (const [name, email] of [['Sam Lee', 'sam@scale.test'], ['Nia North', 'nia@scale.test']]) {
    const r = await w.send('POST', '/api/users', w.admin, { name, email, role: 'editor', password: 'team-password-1' });
    expect(r.status).toBe(200);
    if (email === 'sam@scale.test') ids.sam = r.body.users.find((u: { email: string }) => u.email === email).id;
    ids.leo = r.body.users.find((u: { email: string }) => u.email === 'leo@scale.test').id;
  }
  expect((await w.send('POST', '/api/editors', w.admin, { name: 'dana  diaz', city: 'Manila, Philippines', workStart: 9, workEnd: 18 })).status).toBe(200);

  ids.js = await w.client('Joshua Shalimar');
  ids.oct6 = (await w.batch(ids.js, 'JS · Oct 6', 10, { shoot: '2026-10-06' })).id;
  // a client the site has, without any scripts here
  ids.bright = await w.client('Brightside');
  w.tl.brands.b_bright = 'Brightside';
  w.tl.brands.b_zen = 'Zen Yoga';
  w.tl.projects.p_bright = { id: 'p_bright', name: 'Brightside 2026', nodeId: 'b_bright', createdAt: '2026-01-05T15:00:00Z', subFolders: [] };
  w.tl.projects.p_zen = { id: 'p_zen', name: 'Zen Yoga Reels', nodeId: 'b_zen', createdAt: '2026-01-05T15:00:00Z', subFolders: [] };
  const bright = { projectId: 'p_bright', brandId: 'b_bright', subFolderId: null };
  add(
    // Joshua Shalimar: Leo has the most made in the last 60 days; Maya has more open, mostly from July
    ['t_l1', 'Organic 01', 'toDo', { assigneeIds: ['m_leo'] }], ['t_l2', 'Organic 02', 'toDo', { assigneeIds: ['m_leo'] }],
    ['t_l3', 'Organic 03', 'toDo', { assigneeIds: ['m_leo'] }], ['t_l4', 'Organic 04', 'toDo', { assigneeIds: ['m_leo'] }],
    ['t_m1', 'Organic 05', 'toDo', { assigneeIds: ['m_maya'] }],
    ...[21, 22, 23, 24].map((n): Parameters<typeof video> => [`t_mold${n}`, `Organic ${n}`, 'supervisorApproval', { assigneeIds: ['m_maya'], createdAt: '2026-07-01T15:00:00Z', updatedAt: '2026-07-02T15:00:00Z' }]),
    ['t_s1', 'Organic 06', 'toDo', { assigneeIds: ['m_sam'] }],
    // the shoot's raw clips, nobody given them yet
    ['t_c1', 'C0101', 'toDo', {}], ['t_c2', 'C0102', 'toDo', {}],
    // Brightside: no scripts on the site. Dana has two open, made Sep 15; Gus had two made after, approved since
    ['t_d1', 'Bright 01', 'toDo', { ...bright, assigneeIds: ['m_dana'], createdAt: '2026-09-15T15:00:00Z', internalDeadline: '2026-10-08' }],
    ['t_d2', 'Bright 02', 'toDo', { ...bright, assigneeIds: ['m_dana'], createdAt: '2026-09-15T15:00:00Z', internalDeadline: '2026-10-08' }],
    ['t_g1', 'Bright 03', 'approved', { ...bright, assigneeIds: ['m_gus'], createdAt: '2026-09-20T15:00:00Z', updatedAt: '2026-09-29T15:00:00Z', approvedAt: '2026-09-29T15:00:00Z' }],
    ['t_g2', 'Bright 04', 'approved', { ...bright, assigneeIds: ['m_gus'], createdAt: '2026-09-20T15:00:00Z', updatedAt: '2026-09-29T15:00:00Z', approvedAt: '2026-09-29T15:00:00Z' }],
    // Zen Yoga: a Timeliner brand that isn't a client here
    ['t_z1', 'Zen 01', 'inRevision', { projectId: 'p_zen', brandId: 'b_zen', subFolderId: null, assigneeIds: ['m_gus'], createdAt: '2026-10-06T15:00:00Z', internalDeadline: '2026-10-07', internalRevisions: 1 }],
  );
  b = await w.sync();
});

afterAll(async () => {
  await w.close();
});

describe('everyone in Timeliner has a card', () => {
  it('gives someone who isn’t on the site a card with their videos, flagged to add them', () => {
    expect(card('Gus Ghost')).toMatchObject({
      key: 'mm_gus', userId: null, memberId: 'm_gus', site: false, focus: null,
      flag: { kind: 'not_on_site', text: 'Not on the site — add them in Settings → Team as an Editor with gus@freelance.test', timelinerEmail: 'gus@freelance.test', siteEmail: null },
      plate: { revisions: 1 }, dueToday: 1,
      // Right now from Timeliner: what's next
      nextUp: { title: 'Zen 01' },
    });
    expect(card('Gus Ghost').videos.map((v) => v.title)).toEqual(['Zen 01']);
  });

  it('uses Settings → Editors for someone listed there by name: their place and hours, and asks for site access', () => {
    expect(card('Dana Diaz')).toMatchObject({
      key: 'mm_dana', userId: null, site: false, city: 'Manila, Philippines', timezone: 'Asia/Manila', workHours: [9, 18],
      // 9:40 PM in Manila
      offHours: true,
      flag: { kind: 'no_site_access', text: 'Not on the site — give them site access in Settings → Editors with dana@studio.test' },
    });
  });

  it('flags someone on the site whose email differs from Timeliner’s, and still shows their Timeliner work', () => {
    expect(card('Sam Lee')).toMatchObject({
      key: `u${ids.sam}`, userId: ids.sam, memberId: 'm_sam', site: true, focus: null,
      flag: { kind: 'email_differs', text: 'Their email here (sam@scale.test) differs from Timeliner (sam.lee@gmail.test) — change one so they match' },
      videos: [expect.objectContaining({ title: 'Organic 06' })],
    });
    // one card for them, not a second one from Timeliner
    expect(b.editors.filter((e) => e.memberId === 'm_sam')).toHaveLength(1);
  });

  it('keeps a card for an editor on the site with nothing in Timeliner, with a quiet note', () => {
    expect(card('Nia North')).toMatchObject({
      site: true, videos: [], clients: [],
      flag: { kind: 'nothing_assigned', text: 'Nothing assigned in Timeliner (their Timeliner email must be nia@scale.test)' },
    });
    // people matched by email need nothing fixed
    expect(card('Leo Martins').flag).toBeNull();
  });

  it('sorts flagged cards with their peers, and leads each card with its clients', () => {
    // due today first (Gus's and Dana's are Timeliner-only; Dana's off hours, so after Gus), then the rest with
    // videos, and a card with nothing in Timeliner (Nia) last
    expect(b.editors.map((e) => e.name)).toEqual(['Gus Ghost', 'Dana Diaz', 'Leo Martins', 'Maya Reyes', 'Sam Lee', 'Nia North']);
    const split = 'Joshua Shalimar: 5 with Maya, 4 with Leo, 1 with Sam — one editor per client';
    // nobody is on these clients' brands in Timeliner here: every video was given on the video
    expect(card('Leo Martins').clients).toEqual([{ name: 'Joshua Shalimar', clientId: ids.js, count: 4, split, viaClient: false }]);
    expect(card('Maya Reyes').clients).toEqual([{ name: 'Joshua Shalimar', clientId: ids.js, count: 5, split, viaClient: false }]);
    expect(card('Dana Diaz').clients).toEqual([{ name: 'Brightside', clientId: ids.bright, count: 2, split: null, viaClient: false }]);
    // a Timeliner brand that's no site client, by its name there
    expect(card('Gus Ghost').clients).toEqual([{ name: 'Zen Yoga', clientId: null, count: 1, split: null, viaClient: false }]);
  });
});

describe('clients without scripts on the site', () => {
  it('shows a client’s videos when it has no scripts here, not as “not matched”', () => {
    const v = find(card('Dana Diaz').videos, 'Bright 01');
    expect(v).toMatchObject({ client: { id: ids.bright, name: 'Brightside' }, brand: 'Brightside', batch: null, script: null, scriptIssue: 'no_scripts', match: { how: 'no_scripts', note: 'Brightside has no scripts on the site.' } });
    expect(isNotMatched(v)).toBe(false);
  });

  it('shows a brand that isn’t a client here by its Timeliner name, not as “not matched”', () => {
    const v = find(card('Gus Ghost').videos, 'Zen 01');
    expect(v).toMatchObject({ client: null, brand: 'Zen Yoga', batch: null, scriptIssue: 'no_scripts', match: { how: 'no_client' } });
    expect(isNotMatched(v)).toBe(false);
  });

  it('counts only true not-matched videos: a client with scripts whose video couldn’t be placed', () => {
    // Maya's July videos: Joshua Shalimar has scripts, but no shoot fits them
    expect(all(b).filter(isNotMatched).map((v) => v.title).sort()).toEqual(['Organic 21', 'Organic 22', 'Organic 23', 'Organic 24']);
    expect(b.totals.notMatched).toBe(4);
  });
});

describe('totals over all of Timeliner’s work', () => {
  it('counts the videos of people who aren’t on the site', () => {
    // due today: Dana's two and Gus's Zen 01; revisions: Gus's
    expect(b.totals).toEqual({ editingNow: 0, paused: 0, dueToday: 3, revisions: 1, waitingOnYou: 4, notAssigned: 2, notMatched: 4, toCheck: 0 });
  });

  it('says how much the read found', () => {
    // 17 videos kept, given to 5 people, under 3 Timeliner brands
    expect(b.sync).toMatchObject({ error: null, counts: { videos: 17, people: 5, clients: 3, skipped: 0 } });
  });
});

describe('one editor per client', () => {
  it('works out each client’s editor from the videos made in the last 60 days, and flags a client split across editors', () => {
    const js = b.clients.find((c) => c.name === 'Joshua Shalimar')!;
    // Maya has more of its open videos, but most are from July: Leo has had the most since
    expect(js).toEqual({
      key: `c${ids.js}`, name: 'Joshua Shalimar', clientId: ids.js, brand: 'Joshua Shalimar',
      editor: { name: 'Leo Martins', userId: ids.leo, memberId: 'm_leo', key: `u${ids.leo}` }, editorFrom: 'videos', editors: [],
      open: 12, notAssigned: 2,
      split: [
        expect.objectContaining({ name: 'Maya Reyes', memberId: 'm_maya', count: 5 }),
        expect.objectContaining({ name: 'Leo Martins', memberId: 'm_leo', count: 4 }),
        expect.objectContaining({ name: 'Sam Lee', userId: ids.sam, memberId: 'm_sam', count: 1 }),
      ],
      flags: ['Joshua Shalimar: 5 with Maya, 4 with Leo, 1 with Sam — one editor per client', 'Joshua Shalimar · 2 clips not assigned (usually Leo)'],
      beforeRule: false,
    });
    // a tie (two each in 60 days): whoever had one most recently, Gus. His are approved, so it isn't split
    expect(b.clients.find((c) => c.name === 'Brightside')).toMatchObject({ editor: { name: 'Gus Ghost', userId: null, memberId: 'm_gus', key: 'mm_gus' }, open: 2, split: [], flags: [] });
    expect(b.clients.find((c) => c.name === 'Zen Yoga')).toMatchObject({ key: 'bb_zen', clientId: null, brand: 'Zen Yoga', editor: { name: 'Gus Ghost' }, open: 1, split: [] });
    // the most open videos first
    expect(b.clients.map((c) => c.name)).toEqual(['Joshua Shalimar', 'Brightside', 'Zen Yoga']);
  });

  it('suggests the client’s editor for a shoot’s raw clips nobody has been given', () => {
    expect(b.unassigned).toEqual([expect.objectContaining({
      raw: true, batch: expect.objectContaining({ id: ids.oct6 }), count: 2, brand: 'Joshua Shalimar',
      suggested: { name: 'Leo Martins', userId: ids.leo, memberId: 'm_leo', key: `u${ids.leo}` },
    })]);
  });

  it('never counts a reviewer on a video (a Timeliner admin) as its editor', async () => {
    // Ada (a Timeliner admin, the site's Admin) is on one of Dana's videos to review it: still Dana's alone, not a
    // split, and not on a card of Ada's
    w.tl.tasks.find((t) => t.id === 't_d1')!.assigneeIds = ['m_dana', 'm_ada'];
    try {
      const after = await w.sync();
      expect(after.clients.find((c) => c.name === 'Brightside')).toMatchObject({ editor: { name: 'Gus Ghost' }, split: [] });
      expect(after.editors.filter((e) => e.memberId === 'm_ada')).toEqual([]);
    } finally {
      w.tl.tasks.find((t) => t.id === 't_d1')!.assigneeIds = ['m_dana'];
    }
  });
});

describe('reading odd data from Timeliner', () => {
  it('skips what it can’t read, counts it, logs it once, and saves the rest', async () => {
    const real = w.api.tasks;
    const realBrands = w.api.brands;
    const odd: unknown[] = [
      null, 'not a task', { title: 'No id at all', statusGroup: 'toDo' },
      // readable: each odd field takes a safe default, and an odd assignee drops alone
      { id: 't_w1', title: 2024, statusGroup: null, status: 'ACTIVE', assigneeIds: ['m_leo', null, { id: 'm_maya' }, ''], projectId: 'p_mine', brandId: 'b_js', subFolderId: 'sf_org',
        createdAt: Date.parse('2026-10-07T16:00:00Z'), internalRevisions: '2', clientRevisions: null, media: 'nope', internalDeadline: 'soon' },
    ];
    w.api.tasks = async (before) => { const p = await real(before); return { ...p, data: [...p.data, ...(odd as TimelinerTask[])] }; };
    w.api.members = async () => [...members, null, { id: 'm_odd', email: 42, firstName: { first: 'x' } }] as Members;
    w.api.brands = async (before) => { const p = await realBrands(before); return { ...p, data: [...p.data, { id: 'b_noname' } as { id: string; name: string }] }; };
    const logged: string[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const r = await syncTimeliner(w.db, w.api, new Date(w.now()), (m) => logged.push(m));
        expect(r).toMatchObject({ ok: true, error: null, skipped: 5 });
      }
    } finally {
      w.api.tasks = real;
      w.api.brands = realBrands;
      w.api.members = async () => members;
    }
    // each once, by id (or that it had none), never its content
    expect(logged).toEqual([
      'timeliner: skipped a member the site couldn\'t read (no id); the rest of the read went on',
      'timeliner: skipped a brand the site couldn\'t read (id b_noname); the rest of the read went on',
      'timeliner: skipped a task the site couldn\'t read (no id); the rest of the read went on',
    ]);
    b = await w.board();
    // three tasks, a member and a brand skipped; everything else read as before, plus the odd but readable task
    expect(b.sync).toMatchObject({ error: null, counts: { videos: 18, people: 5, clients: 3, skipped: 5 } });
    expect(find(card('Leo Martins').videos, '2024')).toMatchObject({ state: 'to_edit', due: null, revisionRound: 2, batch: { id: ids.oct6 } });
    expect(find(card('Maya Reyes').videos, '2024')).toBeDefined();
    expect(await w.db.one(`select name, email from timeliner_members where id = 'm_odd'`)).toEqual({ name: null, email: null });
    expect(card('Gus Ghost').videos.map((v) => v.title)).toEqual(['Zen 01']);
  });

  it('never takes an answer that isn’t a list for an empty one, and keeps the copy', async () => {
    const real = w.api.tasks;
    w.api.tasks = (() => timelinerClient('tlsk_test', 'https://timeliner.test', (async () => new Response('{}')) as typeof fetch).tasks(null)) as TimelinerApi['tasks'];
    try {
      const r = await w.send('POST', '/api/editing/sync', w.admin, {});
      expect(r.body.sync.error).toBe('Timeliner’s answer for /tasks wasn’t a list, so the last copy is kept.');
      expect(r.body.sync.counts).toMatchObject({ videos: 18 });
      expect(card('Gus Ghost').videos).toHaveLength(1);
      expect((r.body as EditingBoard).editors.flatMap((e) => e.videos).length).toBeGreaterThan(10);
    } finally {
      w.api.tasks = real;
    }
  });
});

describe('someone who left Timeliner', () => {
  it('gets no card (and no flag) with only finished videos there, and one while they still have open ones', async () => {
    // deactivated in Timeliner, named like someone on the site: an old account, nothing to fix
    w.api.members = async () => [...members, { id: 'm_left', email: 'old@freelance.test', firstName: 'Sam', lastName: 'Lee', role: 'editor', deactivated: true }];
    add(['t_left1', 'Zen 02', 'approved', { projectId: 'p_zen', brandId: 'b_zen', subFolderId: null, assigneeIds: ['m_left'], createdAt: '2026-10-01T15:00:00Z', updatedAt: '2026-10-07T15:00:00Z', approvedAt: '2026-10-07T15:00:00Z' }]);
    try {
      b = await w.sync();
      expect(b.editors.filter((e) => e.memberId === 'm_left')).toEqual([]);
      // Sam's card is still flagged for their own account only
      expect(card('Sam Lee')).toMatchObject({ memberId: 'm_sam', flag: { kind: 'email_differs', timelinerEmail: 'sam.lee@gmail.test' } });
      // with an open video, they're shown (merged with Sam by name: their emails differ)
      w.tl.tasks.find((t) => t.id === 't_left1')!.statusGroup = 'toDo';
      b = await w.sync();
      expect(card('Sam Lee').videos.map((v) => v.title)).toContain('Zen 02');
    } finally {
      w.api.members = async () => members;
      w.tl.tasks = w.tl.tasks.filter((t) => t.id !== 't_left1');
    }
  });
});
