// Each client has its dedicated editor, and in Timeliner that's who is on the client's brand: most videos aren't
// assigned one by one. So a video nobody is on belongs to its brand's editors (an editor there, assigned rather
// than a workspace admin's automatic access), and an explicit assignee on the video wins. The board, an editor's
// Home, I'm on this, the scripts PDF link, the shoot an editor's raw clips are from and the last video they
// finished all go by that. Timeliner is a stand-in.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EditingBoard, EditingVideo, EditorRow } from '../shared/types';
import { TimelinerError, timelinerClient, type TimelinerApi, type TimelinerBrandMember } from '../server/timeliner';
import { syncTimeliner } from '../server/editing';
import { makeWorld, video, type World } from './timeliner-world';

let w: World;
let b: EditingBoard;
let sam = '';
const ids = { js: 0, oct6: 0 };
const card = (name: string) => b.editors.find((e) => e.name === name) as EditorRow;
const titles = (e: EditorRow | undefined) => (e?.videos ?? []).map((v) => v.title).sort();
const find = (list: EditingVideo[], title: string) => list.find((v) => v.title === title) as EditingVideo;
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

describe('a video nobody is on belongs to its client’s editor in Timeliner', () => {
  it('puts it on the client editor’s card, quietly “via client”', () => {
    expect(titles(card('Leo Martins'))).toEqual(['Bright 01', 'C0101', 'C0102', 'Organic 01', 'Organic 03']);
    expect(find(card('Leo Martins').videos, 'Organic 01')).toMatchObject({ assignedBy: 'client', client: { id: ids.js }, batch: { id: ids.oct6 } });
    expect(card('Leo Martins')).toMatchObject({
      // next by deadline: Brightside's, due today
      flag: null, nextUp: { title: 'Bright 01' }, plate: { toEdit: 4, rawToEdit: 2, inReview: 1 },
      // a titled video he put straight into review: his last finished, though nobody was on it
      lastFinished: { title: 'Organic 03' },
      clients: [
        { name: 'Joshua Shalimar', clientId: ids.js, count: 4, split: 'Joshua Shalimar: 4 with Leo, 1 with Sam — one editor per client', viaClient: true },
        { name: 'Brightside', count: 1, split: 'Brightside has 2 editors in Timeliner — one editor per client', viaClient: true },
      ],
    });
  });

  it('gives it to them on their Home, and lets them say they’re on it; nobody else can', async () => {
    const mine = await w.mine(w.leo);
    expect(mine.toEdit.map((v) => v.title).sort()).toEqual(['Bright 01', 'C0101', 'C0102', 'Organic 01']);
    expect(find(mine.toEdit, 'Organic 01').assignedBy).toBe('client');
    expect((await w.send('POST', '/api/editing/focus', w.leo, { videoId: 't_o1', action: 'start' })).status).toBe(200);
    const other = await w.send('POST', '/api/editing/focus', sam, { videoId: 't_o1', action: 'start' });
    expect([other.status, other.body.error.message]).toEqual([403, 'That video isn’t assigned to you in Timeliner.']);
    // the next read doesn't take it for someone else's and end it
    b = await w.sync();
    expect(card('Leo Martins').focus).toMatchObject({ state: 'on', video: { title: 'Organic 01' } });
  });

  it('opens the shoot’s scripts PDF to them (there isn’t one yet), never to an editor with no video from it', async () => {
    // past the ownership check: the shoot has no scripts PDF linked
    expect((await w.send('GET', `/api/editing/script-pdf/${ids.oct6}`, w.leo)).status).toBe(404);
    expect((await w.send('GET', `/api/editing/script-pdf/${ids.oct6}`, w.maya)).status).toBe(403);
  });

  it('remembers the shoot of the raw clips they cut', async () => {
    expect(await w.db.query(`select distinct member_id, batch_id::int as batch_id from timeliner_editor_clips order by member_id`)).toEqual([{ member_id: 'm_leo', batch_id: ids.oct6 }]);
  });

  it('lets an assignee on the video win over the client’s editor', () => {
    expect(titles(card('Sam Lee'))).toEqual(['Glow 02', 'Glow 03', 'Organic 02']);
    expect(find(card('Sam Lee').videos, 'Organic 02').assignedBy).toBe('video');
    expect(card('Sam Lee').clients).toEqual([
      { name: 'Glow Skincare', clientId: null, count: 2, split: 'Glow Skincare: 2 with Sam, 1 with Maya — one editor per client', viaClient: false },
      { name: 'Joshua Shalimar', clientId: ids.js, count: 1, split: 'Joshua Shalimar: 4 with Leo, 1 with Sam — one editor per client', viaClient: false },
    ]);
  });

  it('names the editor on the client in Timeliner as its editor, whoever has more of its videos', () => {
    expect(b.clients.find((c) => c.name === 'Glow Skincare')).toMatchObject({
      editor: { name: 'Maya Reyes', memberId: 'm_maya' }, editorFrom: 'client', editors: [expect.objectContaining({ name: 'Maya Reyes' })],
      open: 3, split: [expect.objectContaining({ name: 'Sam Lee', count: 2 }), expect.objectContaining({ name: 'Maya Reyes', count: 1 })],
      flags: ['Glow Skincare: 2 with Sam, 1 with Maya — one editor per client'],
    });
  });
});

describe('who isn’t a client’s editor', () => {
  it('ignores automatic access (a workspace admin’s) and a supervisor on the brand', () => {
    // Ada (the site's admin) has no card of her own; Sue isn't on the site and isn't anyone's editor
    expect(b.editors.map((e) => e.name).sort()).toEqual(['Leo Martins', 'Maya Reyes', 'Sam Lee']);
    const js = b.clients.find((c) => c.name === 'Joshua Shalimar')!;
    expect(js).toMatchObject({ editor: { name: 'Leo Martins', memberId: 'm_leo' }, editorFrom: 'client', editors: [expect.objectContaining({ memberId: 'm_leo' })], notAssigned: 0 });
  });

  it('leaves a video not assigned only when nobody is on it or on its client', () => {
    expect(b.unassigned).toEqual([expect.objectContaining({ titles: 'Zen 01', count: 1, brand: 'Zen Yoga', suggested: null })]);
    expect(b.clients.find((c) => c.name === 'Zen Yoga')).toMatchObject({ editor: null, editorFrom: null, editors: [], notAssigned: 1, flags: ['Zen Yoga · 1 video not assigned'] });
    expect(b.totals.notAssigned).toBe(1);
  });
});

describe('a client with two editors in Timeliner', () => {
  it('gives the video to both, counts it once, and flags the client', () => {
    expect(titles(card('Maya Reyes'))).toEqual(['Bright 01', 'Glow 01']);
    expect(card('Leo Martins').videos.some((v) => v.title === 'Bright 01')).toBe(true);
    // due today: Bright 01, once
    expect(b.totals).toMatchObject({ dueToday: 1, notAssigned: 1, waitingOnYou: 1 });
    expect(b.clients.find((c) => c.name === 'Brightside')).toMatchObject({
      editorFrom: 'client', editors: [expect.objectContaining({ name: 'Leo Martins' }), expect.objectContaining({ name: 'Maya Reyes' })],
      open: 1, flags: ['Brightside has 2 editors in Timeliner — one editor per client'],
    });
    expect(card('Maya Reyes').clients).toEqual([
      { name: 'Brightside', clientId: expect.any(Number), count: 1, split: 'Brightside has 2 editors in Timeliner — one editor per client', viaClient: true },
      { name: 'Glow Skincare', clientId: null, count: 1, split: 'Glow Skincare: 2 with Sam, 1 with Maya — one editor per client', viaClient: true },
    ]);
    // people with videos: Leo, Maya and Sam
    expect(b.sync.counts).toEqual({ videos: 10, people: 3, clients: 4, skipped: 0 });
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
    // Brightside as last read: still both editors'
    expect(titles(card('Maya Reyes'))).toEqual(['Bright 01', 'Glow 01']);
    // Zen Yoga is now Sam's: nothing left unassigned
    expect(titles(card('Sam Lee'))).toEqual(['Glow 02', 'Glow 03', 'Organic 02', 'Zen 01']);
    expect(b.unassigned).toEqual([]);
    expect(b.clients.find((c) => c.name === 'Zen Yoga')).toMatchObject({ editor: { name: 'Sam Lee' }, editorFrom: 'client', notAssigned: 0, flags: [] });
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
