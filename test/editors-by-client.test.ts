// A video belongs to its assignees in Timeliner and nobody else, as Timeliner's assignee filter shows it. Who is
// on a client's brand there (an editor, assigned rather than a workspace admin's automatic access) only names the
// client's editor: in Editors by client, as whom to give its unassigned videos ("usually Leo"), and in the flag for
// a client with two editors. A video nobody is assigned to is nobody's: not on a card, not on anyone's Home, not
// theirs to say they're on, and no reason to open its shoot's scripts PDF. Timeliner is a stand-in.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EditingBoard, EditorRow } from '../shared/types';
import { TimelinerError, timelinerClient, type TimelinerApi, type TimelinerBrandMember } from '../server/timeliner';
import { syncTimeliner } from '../server/editing';
import { makeWorld, pdfTask, versionUploaded, video, type World } from './timeliner-world';

let w: World;
let b: EditingBoard;
let sam = '';
const ids = { js: 0, oct6: 0 };
const card = (name: string) => b.editors.find((e) => e.name === name) as EditorRow;
const titles = (e: EditorRow | undefined) => (e?.videos ?? []).map((v) => v.title).sort();
const add = (...t: Parameters<typeof video>[]) => { for (const x of t) w.tl.tasks.push(video(...x)); };
type Members = Awaited<ReturnType<TimelinerApi['members']>>;
const person = (id: string, email: string, firstName: string, lastName: string, role: string) => ({ id, email, firstName, lastName, role, deactivated: false });
const members: Members = [
  person('m_ada', 'ada@scale.test', 'Ada', 'Admin', 'admin'),
  person('m_leo', 'leo@scale.test', 'Leo', 'Martins', 'editor'),
  person('m_maya', 'maya@scale.test', 'Maya', 'Reyes', 'editor'),
  person('m_sam', 'sam@scale.test', 'Sam', 'Lee', 'editor'),
  person('m_sup', 'sue@scale.test', 'Sue', 'Supervisor', 'supervisor'),
];
const on = (member: (typeof members)[number], role: string, automatic = false): TimelinerBrandMember => ({ role, automatic, member });

beforeAll(async () => {
  w = await makeWorld();
  // the one-editor rule was on long before these videos were made (test/one-editor-rule.test.ts covers its start)
  await w.oneEditorSince('2026-01-01');
  w.api.members = async () => members;
  expect((await w.send('POST', '/api/users', w.admin, { name: 'Sam Lee', email: 'sam@scale.test', role: 'editor', password: 'team-password-1' })).status).toBe(200);
  const login = await w.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-scale-media': '1', 'content-type': 'application/json' }, payload: JSON.stringify({ email: 'sam@scale.test', password: 'team-password-1' }) });
  sam = String(login.headers['set-cookie']).split(';')[0];

  ids.js = await w.client('Joshua Shalimar');
  ids.oct6 = (await w.batch(ids.js, 'JS · Oct 6', 10, { shoot: '2026-10-06' })).id;
  await w.client('Brightside');
  w.tl.brands.b_bright = 'Brightside';
  w.tl.brands.b_zen = 'Zen Yoga';
  w.tl.brands.b_glow = 'Glow Skincare';
  w.tl.projects.p_bright = { id: 'p_bright', name: 'Brightside 2026', nodeId: 'b_bright', createdAt: '2026-01-05T15:00:00Z', subFolders: [] };
  w.tl.projects.p_zen = { id: 'p_zen', name: 'Zen Yoga Reels', nodeId: 'b_zen', createdAt: '2026-01-05T15:00:00Z', subFolders: [] };
  w.tl.projects.p_glow = { id: 'p_glow', name: 'Glow Reels', nodeId: 'b_glow', createdAt: '2026-01-05T15:00:00Z', subFolders: [] };
  const [ada, leo, maya, , sue] = members;
  w.tl.onBrand = {
    // Joshua Shalimar's editor is Leo. Ada is on every brand as a workspace admin (automatic), even listed as an editor
    b_js: [on(ada, 'admin', true), on(leo, 'editor'), { role: 'editor', automatic: true, member: { ...ada } }],
    // two editors on one client
    b_bright: [on(maya, 'editor'), on(leo, 'editor')],
    // nobody edits Zen Yoga: a supervisor reviews, and Ada's access (and, oddly, Maya's) is automatic
    b_zen: [on(sue, 'supervisor'), on(ada, 'admin', true), on(maya, 'editor', true)],
    // Glow Skincare's editor is Maya, though Sam has been given more of its videos one by one
    b_glow: [on(maya, 'editor')],
  };
  const bright = { projectId: 'p_bright', brandId: 'b_bright', subFolderId: null };
  const zen = { projectId: 'p_zen', brandId: 'b_zen', subFolderId: null };
  const glow = { projectId: 'p_glow', brandId: 'b_glow', subFolderId: null };
  add(
    // nobody on these videos: they're the client's, so Leo's
    ['t_c1', 'C0101', 'toDo', {}], ['t_c2', 'C0102', 'toDo', {}],
    ['t_o1', 'Organic 01', 'toDo', { internalDeadline: '2026-10-09' }],
    ['t_o3', 'Organic 03', 'supervisorApproval', { createdAt: '2026-10-07T18:00:00Z', updatedAt: '2026-10-07T18:00:00Z' }],
    // given to Sam on the video: Sam's, not the client editor's
    ['t_o2', 'Organic 02', 'toDo', { assigneeIds: ['m_sam'] }],
    // Brightside's two editors both have it; it's due today
    ['t_b1', 'Bright 01', 'toDo', { ...bright, internalDeadline: '2026-10-08' }],
    // nobody on the video, nobody editing the client: not assigned
    ['t_z1', 'Zen 01', 'toDo', zen],
    ['t_g1', 'Glow 01', 'toDo', glow], ['t_g2', 'Glow 02', 'toDo', { ...glow, assigneeIds: ['m_sam'] }], ['t_g3', 'Glow 03', 'toDo', { ...glow, assigneeIds: ['m_sam'] }],
  );
  b = await w.sync();
});

afterAll(async () => {
  await w.close();
});

describe('a video nobody is assigned to in Timeliner', () => {
  it('is on nobody’s card, not even its client’s editor’s', () => {
    expect(titles(card('Leo Martins'))).toEqual([]);
    expect(titles(card('Maya Reyes'))).toEqual([]);
    expect(card('Leo Martins')).toMatchObject({ flag: null, nextUp: null, lastFinished: null, clients: [], plate: { toEdit: 0, rawToEdit: 0, inReview: 0 } });
    expect(b.editors.flatMap((e) => e.videos).map((v) => v.title).sort()).toEqual(['Glow 02', 'Glow 03', 'Organic 02']);
  });

  it('is on nobody’s Home, and nobody can say they’re on it', async () => {
    const mine = await w.mine(w.leo);
    expect([...mine.toEdit, ...mine.revisions, ...mine.waiting]).toEqual([]);
    // what the read found across the workspace (its people, its clients) is the managers'
    expect(mine.sync).toMatchObject({ error: null, counts: null });
    expect(b.sync.counts).not.toBeNull();
    for (const cookie of [w.leo, sam]) {
      const r = await w.send('POST', '/api/editing/focus', cookie, { videoId: 't_o1', action: 'start' });
      expect([r.status, r.body.error.message]).toEqual([403, 'That video isn’t assigned to you in Timeliner.']);
    }
  });

  it('opens the shoot’s scripts PDF only to an editor with a video assigned from it', async () => {
    // Sam has Organic 02 from the Oct 6 shoot: past the ownership check, there's no scripts PDF linked yet
    expect((await w.send('GET', `/api/editing/script-pdf/${ids.oct6}`, sam)).status).toBe(404);
    // Leo is the client's editor, but nobody gave him a video from it
    expect((await w.send('GET', `/api/editing/script-pdf/${ids.oct6}`, w.leo)).status).toBe(403);
    expect((await w.send('GET', `/api/editing/script-pdf/${ids.oct6}`, w.maya)).status).toBe(403);
  });

  it('remembers no editor’s shoot for raw clips nobody is assigned to', async () => {
    expect(await w.db.query(`select distinct member_id, batch_id::int as batch_id from timeliner_editor_clips order by member_id`)).toEqual([]);
  });

  it('is listed under Not assigned, with its client’s editor in Timeliner as whom to give it', () => {
    const leo = expect.objectContaining({ name: 'Leo Martins', memberId: 'm_leo' });
    expect([...b.unassigned].sort((x, y) => x.titles.localeCompare(y.titles))).toEqual([
      expect.objectContaining({ titles: 'Bright 01', brand: 'Brightside', suggested: leo }),
      expect.objectContaining({ titles: 'C0101–0102', raw: true, batch: expect.objectContaining({ id: ids.oct6 }), suggested: leo }),
      expect.objectContaining({ titles: 'Glow 01', brand: 'Glow Skincare', suggested: expect.objectContaining({ name: 'Maya Reyes', memberId: 'm_maya' }) }),
      expect.objectContaining({ titles: 'Organic 01', brand: 'Joshua Shalimar', suggested: leo }),
      // nobody edits Zen Yoga in Timeliner
      expect.objectContaining({ titles: 'Zen 01', brand: 'Zen Yoga', suggested: null }),
    ]);
    // Organic 03 is in review: not waiting to be given to anyone
    expect(b.totals).toMatchObject({ notAssigned: 6, waitingOnYou: 1, dueToday: 0 });
    expect(b.clients.find((c) => c.name === 'Joshua Shalimar')).toMatchObject({
      editor: { name: 'Leo Martins', memberId: 'm_leo' }, editorFrom: 'client', open: 5, notAssigned: 3, split: [],
      flags: ['Joshua Shalimar · 3 videos not assigned (usually Leo)'],
    });
  });
});

describe('a video assigned in Timeliner', () => {
  it('is its assignee’s alone, whoever is on its client’s brand', () => {
    expect(titles(card('Sam Lee'))).toEqual(['Glow 02', 'Glow 03', 'Organic 02']);
    expect(card('Sam Lee').clients).toEqual([
      { name: 'Glow Skincare', clientId: null, count: 2, split: null },
      { name: 'Joshua Shalimar', clientId: ids.js, count: 1, split: null },
    ]);
    // people with videos: Sam alone
    expect(b.sync.counts).toEqual({ videos: 10, people: 1, clients: 4, skipped: 0 });
  });

  it('leaves the editor on the client in Timeliner named as its editor, whoever has more of its videos', () => {
    expect(b.clients.find((c) => c.name === 'Glow Skincare')).toMatchObject({
      editor: { name: 'Maya Reyes', memberId: 'm_maya' }, editorFrom: 'client', editors: [expect.objectContaining({ name: 'Maya Reyes' })],
      open: 3, notAssigned: 1, split: [], flags: ['Glow Skincare · 1 video not assigned (usually Maya)'],
    });
  });
});

describe('who isn’t a client’s editor', () => {
  it('ignores automatic access (a workspace admin’s) and a supervisor on the brand', () => {
    // Ada (the site's admin) has no card of her own; Sue isn't on the site and isn't anyone's editor
    expect(b.editors.map((e) => e.name).sort()).toEqual(['Leo Martins', 'Maya Reyes', 'Sam Lee']);
    expect(b.clients.find((c) => c.name === 'Joshua Shalimar')).toMatchObject({ editors: [expect.objectContaining({ memberId: 'm_leo' })] });
    expect(b.clients.find((c) => c.name === 'Zen Yoga')).toMatchObject({ editor: null, editorFrom: null, editors: [], notAssigned: 1, flags: ['Zen Yoga · 1 video not assigned'] });
  });
});

describe('a client with two editors in Timeliner', () => {
  it('is flagged, and its video nobody is assigned to is neither’s', () => {
    expect(b.clients.find((c) => c.name === 'Brightside')).toMatchObject({
      editor: { name: 'Leo Martins' }, editorFrom: 'client', editors: [expect.objectContaining({ name: 'Leo Martins' }), expect.objectContaining({ name: 'Maya Reyes' })],
      open: 1, notAssigned: 1,
      flags: ['Brightside has 2 editors in Timeliner — one editor per client', 'Brightside · 1 video not assigned (usually Leo)'],
    });
    expect(b.editors.some((e) => e.videos.some((v) => v.title === 'Bright 01'))).toBe(false);
  });
});

describe('reading who is on each brand', () => {
  it('keeps the last list of a brand Timeliner can’t answer for, and reads the rest', async () => {
    const real = w.api.brandMembers;
    // Brightside's list fails; Zen Yoga gets an editor (read leniently: a bare member id, odd fields)
    w.api.brandMembers = async (id) => {
      if (id === 'b_bright') throw new TimelinerError('Timeliner answered 500: Internal server error.', 500);
      if (id === 'b_zen') return [{ role: 'EDITOR', automatic: 'false', memberId: 'm_sam', member: null }, { role: 'editor' }, null] as unknown as TimelinerBrandMember[];
      return real(id);
    };
    const logged: string[] = [];
    try {
      const r = await syncTimeliner(w.db, w.api, new Date(w.now()), (m) => logged.push(m));
      // the failed list and two odd entries
      expect(r).toMatchObject({ ok: true, error: null, skipped: 3 });
    } finally {
      w.api.brandMembers = real;
    }
    expect(logged).toContain('timeliner: couldn\'t read who is on a brand: Timeliner answered 500: Internal server error.');
    b = await w.board();
    expect(b.sync).toMatchObject({ error: null, counts: { videos: 10, skipped: 3 } });
    // Brightside as last read: still both editors
    expect(b.clients.find((c) => c.name === 'Brightside')).toMatchObject({ editors: [expect.objectContaining({ name: 'Leo Martins' }), expect.objectContaining({ name: 'Maya Reyes' })] });
    // Sam is Zen Yoga's editor now: whom to give its video, which still isn't his
    expect(b.clients.find((c) => c.name === 'Zen Yoga')).toMatchObject({ editor: { name: 'Sam Lee' }, editorFrom: 'client', notAssigned: 1, flags: ['Zen Yoga · 1 video not assigned (usually Sam)'] });
    expect(b.unassigned.find((g) => g.brand === 'Zen Yoga')).toMatchObject({ titles: 'Zen 01', suggested: expect.objectContaining({ name: 'Sam Lee' }) });
    expect(titles(card('Sam Lee'))).toEqual(['Glow 02', 'Glow 03', 'Organic 02']);
  });

  it('never takes anyone off a brand when an entry in its list can’t be read, and adds whoever it could read', async () => {
    const [ada, , maya, sam] = members;
    // Zen Yoga's editor is Sam in Timeliner now too
    w.tl.onBrand.b_zen = [...w.tl.onBrand.b_zen, on(sam, 'editor')];
    const real = w.api.brandMembers;
    const unreadable = { role: 'editor', automatic: false, member: null } as TimelinerBrandMember;
    w.api.brandMembers = async (id) => {
      // Leo's entry comes back with no member: he is still Joshua Shalimar's editor
      if (id === 'b_js') return [on(ada, 'admin', true), unreadable];
      // Leo's entry again (a member without an id), next to Maya's
      if (id === 'b_bright') return [on(maya, 'editor'), { role: 'editor', automatic: false, member: { firstName: 'Leo' } } as unknown as TimelinerBrandMember];
      // nothing in it can be read but Sam, who is new there
      if (id === 'b_glow') return [unreadable, on(sam, 'editor')];
      return real(id);
    };
    try {
      expect(await syncTimeliner(w.db, w.api, new Date(w.now()))).toMatchObject({ ok: true, error: null, skipped: 3 });
    } finally {
      w.api.brandMembers = real;
    }
    b = await w.board();
    // Leo is still Joshua Shalimar's and Brightside's editor
    expect(b.clients.find((c) => c.name === 'Joshua Shalimar')).toMatchObject({ editor: { name: 'Leo Martins' }, editors: [expect.objectContaining({ name: 'Leo Martins' })] });
    expect(b.clients.find((c) => c.name === 'Brightside')).toMatchObject({ editors: [expect.objectContaining({ name: 'Leo Martins' }), expect.objectContaining({ name: 'Maya Reyes' })] });
    // Glow Skincare keeps Maya and gains Sam (who has the most of its videos), and is flagged; its videos stay where they were
    expect(b.clients.find((c) => c.name === 'Glow Skincare')).toMatchObject({
      editors: [expect.objectContaining({ name: 'Sam Lee' }), expect.objectContaining({ name: 'Maya Reyes' })],
      flags: ['Glow Skincare has 2 editors in Timeliner — one editor per client', 'Glow Skincare · 1 video not assigned (usually Sam)'],
    });
    expect(titles(card('Sam Lee'))).toEqual(['Glow 02', 'Glow 03', 'Organic 02']);

    // a list that reads cleanly replaces what was kept: Glow Skincare is Maya's alone again
    b = await w.sync();
    expect(b.clients.find((c) => c.name === 'Glow Skincare')).toMatchObject({ editors: [expect.objectContaining({ name: 'Maya Reyes' })] });
    expect(b.sync.counts).toMatchObject({ skipped: 0 });
  });

  it('counts a brand Timeliner says it doesn’t have as skipped, and keeps who was on it', async () => {
    const real = w.api.brandMembers;
    w.api.brandMembers = async (id) => (id === 'b_bright' ? null : real(id));
    try {
      expect(await syncTimeliner(w.db, w.api, new Date(w.now()))).toMatchObject({ ok: true, skipped: 1 });
    } finally {
      w.api.brandMembers = real;
    }
    b = await w.board();
    expect(b.clients.find((c) => c.name === 'Brightside')).toMatchObject({ editors: [expect.objectContaining({ name: 'Leo Martins' }), expect.objectContaining({ name: 'Maya Reyes' })] });
  });

  it('asks Timeliner for each brand’s members', async () => {
    const asked: string[] = [];
    const answer = (status: number, body: unknown) => (async (url: string | URL | Request) => {
      asked.push(String(url).replace('https://timeliner.test/api/v1', ''));
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    }) as typeof fetch;
    const tl = (f: typeof fetch) => timelinerClient('tlsk_test', 'https://timeliner.test', f);
    expect(await tl(answer(200, { data: [{ role: 'editor', automatic: false, member: { id: 'm1' } }] })).brandMembers('b 1')).toEqual([{ role: 'editor', automatic: false, member: { id: 'm1' } }]);
    expect(asked).toEqual(['/brands/b%201/members']);
    // no such brand, and an answer that isn't a list (never taken for "nobody")
    expect(await tl(answer(404, {})).brandMembers('b1')).toBeNull();
    await expect(tl(answer(200, { data: {} })).brandMembers('b1')).rejects.toThrow('Timeliner’s answer for /brands/b1/members wasn’t a list, so the last copy is kept.');
  });
});

describe('a Timeliner admin or supervisor on a video', () => {
  it('is reviewing it: never one of its client’s editors, and never flagged to be added as an editor', async () => {
    add(
      // at Internal approval with only Sue on it (a supervisor in Timeliner, not on the site)
      ['t_o4', 'Organic 04', 'supervisorApproval', { assigneeIds: ['m_sup'] }],
      // Leo's, with Sue on it too to review it
      ['t_o5', 'Organic 05', 'toDo', { assigneeIds: ['m_leo', 'm_sup'] }],
    );
    try {
      b = await w.sync();
      // Sue isn't one of Joshua Shalimar's editors: its open videos are Leo's one and Sam's one
      expect(b.clients.find((c) => c.name === 'Joshua Shalimar')).toMatchObject({
        editor: { name: 'Leo Martins' }, split: [expect.objectContaining({ name: 'Leo Martins', count: 1 }), expect.objectContaining({ name: 'Sam Lee', count: 1 })],
        flags: ['Joshua Shalimar: 1 with Leo, 1 with Sam — one editor per client', 'Joshua Shalimar · 3 videos not assigned (usually Leo)'],
      });
      // her card holds only the video nobody else is on, and asks nobody to make her an editor
      expect(card('Sue Supervisor')).toMatchObject({ site: false, flag: null });
      expect(titles(card('Sue Supervisor'))).toEqual(['Organic 04']);
      expect(b.editors.filter((e) => e.flag && e.flag.kind !== 'nothing_assigned')).toEqual([]);
      expect(titles(card('Leo Martins'))).toEqual(['Organic 05']);
    } finally {
      w.tl.tasks = w.tl.tasks.filter((t) => t.id !== 't_o4' && t.id !== 't_o5');
    }
  });
});

describe('a new version of a shoot’s scripts PDF', () => {
  it('is told to the editors assigned to that shoot’s videos, not to the client’s editor on its brand', async () => {
    const told = async (cookie: string) => ((await w.send('GET', '/api/notifications', cookie)).body.notifications as { title: string; body: string }[])
      .filter((n) => n.title.startsWith('New scripts PDF'));
    // Sam has the shoot's one assigned video; the rest are nobody's
    b = await w.sync();
    expect(b.editors.flatMap((e) => e.videos).filter((v) => v.batch?.id === ids.oct6).map((v) => v.title)).toEqual(['Organic 02']);
    w.tl.tasks.push(pdfTask('t_pdf6', '2026-10-05T15:00:00Z', { id: 'f_61', name: 'JS scripts Oct 6.pdf' }));
    expect((await w.hook('version.uploaded', versionUploaded({ taskId: 't_pdf6', fileName: 'JS scripts Oct 6.pdf', version: 1, uploadedAt: '2026-10-05T15:00:00Z', fileId: 'f_61' }))).outcome).toBe('delivered');
    const t = w.tl.tasks.find((x) => x.id === 't_pdf6')!;
    t.media = { ...t.media!, fileId: 'f_62', downloadUrl: 'https://s3.example/f_62?sig' };
    expect((await w.hook('version.uploaded', versionUploaded({ taskId: 't_pdf6', fileName: 'JS scripts Oct 6.pdf', version: 2, uploadedAt: '2026-10-08T12:00:00Z', fileId: 'f_62' }))).outcome).toBe('new_version');
    expect(await told(sam)).toEqual([expect.objectContaining({ title: 'New scripts PDF · Joshua Shalimar', body: 'The scripts PDF for the Oct 6 shoot has a new version (v2).' })]);
    // Leo is on the client's brand, with nothing from that shoot assigned to him; Maya has none either
    expect(await told(w.leo)).toEqual([]);
    expect(await told(w.maya)).toEqual([]);
  });
});

describe('brands that aren’t clients on the site', () => {
  const [, , maya] = members;
  const place = (id: string, name: string) => {
    w.tl.projects[`p_${id}`] = { id: `p_${id}`, name, nodeId: `b_${id}`, createdAt: '2026-01-05T15:00:00Z', subFolders: [] };
    return { projectId: `p_${id}`, brandId: `b_${id}`, subFolderId: null };
  };

  it('keeps each brand’s videos nobody is on apart (their folders named alike), each with its own usual editor', async () => {
    w.tl.brands.b_alpha = 'Alpha Gym';
    w.tl.brands.b_beta = 'Beta Cafe';
    const alpha = place('alpha', 'Content');
    const beta = place('beta', 'Content');
    add(
      // Maya made Alpha Gym's last video
      ['t_a0', 'Alpha 00', 'approved', { ...alpha, assigneeIds: ['m_maya'], createdAt: '2026-10-01T15:00:00Z', updatedAt: '2026-10-05T15:00:00Z', approvedAt: '2026-10-05T15:00:00Z' }],
      ['t_a1', 'Alpha 01', 'toDo', alpha], ['t_be1', 'Beta 01', 'toDo', beta],
    );
    b = await w.sync();
    expect(b.unassigned.filter((g) => g.folder === 'Content').sort((x, y) => x.titles.localeCompare(y.titles))).toEqual([
      expect.objectContaining({ folder: 'Content', titles: 'Alpha 01', count: 1, brand: 'Alpha Gym', suggested: expect.objectContaining({ name: 'Maya Reyes' }) }),
      expect.objectContaining({ folder: 'Content', titles: 'Beta 01', count: 1, brand: 'Beta Cafe', suggested: null }),
    ]);
    expect(b.clients.find((c) => c.name === 'Beta Cafe')).toMatchObject({ editor: null, flags: ['Beta Cafe · 1 video not assigned'] });
  });

  it('lists the clients to look at first, however few their videos', async () => {
    w.tl.brands.b_delta = 'Delta Dance';
    w.tl.onBrand.b_delta = [on(maya, 'editor')];
    const delta = place('delta', 'Delta Reels');
    // all three given to Maya, its editor: nothing to look at
    const maya3 = { ...delta, assigneeIds: ['m_maya'] };
    add(['t_dl1', 'Delta 01', 'toDo', maya3], ['t_dl2', 'Delta 02', 'toDo', maya3], ['t_dl3', 'Delta 03', 'toDo', maya3]);
    b = await w.sync();
    expect(b.clients.find((c) => c.name === 'Delta Dance')).toMatchObject({ editor: { name: 'Maya Reyes' }, open: 3, flags: [] });
    // flagged (most open videos first), then the rest
    expect(b.clients.map((c) => c.name)).toEqual(['Joshua Shalimar', 'Glow Skincare', 'Alpha Gym', 'Beta Cafe', 'Brightside', 'Zen Yoga', 'Delta Dance']);
  });

  it('never names someone who has left Timeliner as a client’s editor', async () => {
    w.api.members = async () => [...members, { id: 'm_olga', email: 'olga@freelance.test', firstName: 'Olga', lastName: 'Old', role: 'editor', deactivated: true }];
    w.tl.brands.b_gamma = 'Gamma';
    const gamma = place('gamma', 'Gamma Reels');
    add(
      // Olga, who has since left, made Gamma's last video (approved Oct 1); nobody is on its brand
      ['t_gm0', 'Gamma 00', 'approved', { ...gamma, assigneeIds: ['m_olga'], createdAt: '2026-09-25T15:00:00Z', updatedAt: '2026-10-01T15:00:00Z', approvedAt: '2026-10-01T15:00:00Z' }],
      ['t_gm1', 'Gamma 01', 'toDo', gamma],
    );
    b = await w.sync();
    expect(b.editors.some((e) => e.memberId === 'm_olga')).toBe(false);
    expect(b.clients.find((c) => c.name === 'Gamma')).toMatchObject({ editor: null, editorFrom: null, notAssigned: 1, flags: ['Gamma · 1 video not assigned'] });
    expect(b.unassigned.find((g) => g.brand === 'Gamma')).toMatchObject({ titles: 'Gamma 01', suggested: null });
  });
});
