// The one-editor-per-client rule began on a day (Settings → Timeliner, Oct 9, 2026 to start with): before it, a
// client's videos went to whoever was free. Only videos made in Timeliner since that day (HQ time) say whether a
// client is split, has two editors, or whom its videos usually go to; older ones still show on their editor's card
// and in every count. And only editors are editors: someone the site knows as a writer, manager or Admin (by
// email) is never anyone's editor in Timeliner, on a video or on its brand. Timeliner is a stand-in.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClientEditing, EditingBoard, EditorRow, Settings } from '../shared/types';
import type { TimelinerApi, TimelinerBrandMember } from '../server/timeliner';
import { onOrAfterDay } from '../shared/dates';
import { makeWorld, video, type World } from './timeliner-world';

let w: World;
let b: EditingBoard;
let manager = '';
type Members = Awaited<ReturnType<TimelinerApi['members']>>;
const person = (id: string, email: string, firstName: string, lastName: string, role = 'editor') => ({ id, email, firstName, lastName, role, deactivated: false });
const members: Members = [
  person('m_ada', 'ada@scale.test', 'Ada', 'Admin', 'admin'),
  person('m_leo', 'leo@scale.test', 'Leo', 'Martins'),
  person('m_maya', 'maya@scale.test', 'Maya', 'Reyes'),
  // the site's writer and a manager, both editors in Timeliner (to upload scripts PDFs, say)
  person('m_wes', 'wes@scale.test', 'Wes', 'Writer'),
  person('m_mo', 'mo@scale.test', 'Mo', 'Manager'),
  // not on the site at all
  person('m_gus', 'gus@freelance.test', 'Gus', 'Ghost'),
];
const [, leo, maya, wes, , gus] = members;
const on = (member: (typeof members)[number]): TimelinerBrandMember => ({ role: 'editor', automatic: false, member });
const client = (name: string) => b.clients.find((c) => c.name === name) as ClientEditing;
const card = (name: string) => b.editors.find((e) => e.name === name) as EditorRow | undefined;
const brand = (id: string, name: string) => {
  w.tl.brands[`b_${id}`] = name;
  w.tl.projects[`p_${id}`] = { id: `p_${id}`, name: `${name} Reels`, nodeId: `b_${id}`, createdAt: '2026-01-05T15:00:00Z', subFolders: [] };
  return { projectId: `p_${id}`, brandId: `b_${id}`, subFolderId: null };
};
const made = (at: string) => ({ createdAt: at, updatedAt: at });
const finished = (at: string) => ({ createdAt: at, updatedAt: at, approvedAt: at });
const add = (...t: Parameters<typeof video>[]) => { for (const x of t) w.tl.tasks.push(video(...x)); };
const drop = (...ids: string[]) => { w.tl.tasks = w.tl.tasks.filter((t) => !ids.includes(t.id)); };

beforeAll(async () => {
  w = await makeWorld();
  w.at('2026-10-12T15:00:00Z');
  w.api.members = async () => members;
  const r = await w.send('POST', '/api/users', w.admin, { name: 'Mo Manager', email: 'mo@scale.test', role: 'manager', password: 'team-password-1' });
  expect(r.status).toBe(200);
  const login = await w.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-scale-media': '1', 'content-type': 'application/json' }, payload: JSON.stringify({ email: 'mo@scale.test', password: 'team-password-1' }) });
  manager = String(login.headers['set-cookie']).split(';')[0];

  const alpha = brand('alpha', 'Alpha Gym');
  const beta = brand('beta', 'Beta Cafe');
  const cove = brand('cove', 'Cove Dental');
  const delta = brand('delta', 'Delta Dance');
  // Cove Dental has two editors in Timeliner; Delta Dance one; nobody is on Alpha Gym or Beta Cafe there
  w.tl.onBrand = { b_cove: [on(leo), on(maya)], b_delta: [on(maya)] };
  add(
    // Alpha Gym, before the rule: Leo has one, Maya the other (made on the evening of Oct 8 in New York, Oct 9 in UTC)
    ['t_a1', 'Alpha 01', 'toDo', { ...alpha, ...made('2026-10-05T15:00:00Z'), assigneeIds: ['m_leo'] }],
    ['t_a2', 'Alpha 02', 'toDo', { ...alpha, ...made('2026-10-09T03:30:00Z'), assigneeIds: ['m_maya'] }],
    // Beta Cafe: Maya made three before the rule, Leo one since, and one since is nobody's
    ['t_b1', 'Beta 01', 'approved', { ...beta, ...finished('2026-10-01T15:00:00Z'), assigneeIds: ['m_maya'] }],
    ['t_b2', 'Beta 02', 'approved', { ...beta, ...finished('2026-10-02T15:00:00Z'), assigneeIds: ['m_maya'] }],
    ['t_b3', 'Beta 03', 'approved', { ...beta, ...finished('2026-10-03T15:00:00Z'), assigneeIds: ['m_maya'] }],
    ['t_b4', 'Beta 04', 'approved', { ...beta, ...finished('2026-10-10T15:00:00Z'), assigneeIds: ['m_leo'] }],
    ['t_b5', 'Beta 05', 'toDo', { ...beta, ...made('2026-10-10T16:00:00Z') }],
    // Cove Dental's only video is from before the rule
    ['t_c1', 'Cove 01', 'toDo', { ...cove, ...made('2026-10-07T15:00:00Z') }],
    // Delta Dance's only video is from before the rule; Maya is its one editor in Timeliner
    ['t_d1', 'Delta 01', 'toDo', { ...delta, ...made('2026-10-06T15:00:00Z') }],
  );
  b = await w.sync();
});

afterAll(async () => {
  await w.close();
});

describe('the day the one-editor rule began', () => {
  it('starts on Oct 9, 2026, in Settings and on the board', async () => {
    const s = (await w.send('GET', '/api/settings', w.writer)).body.settings as Settings;
    expect(s).toMatchObject({ oneEditorSince: '2026-10-09', timezone: 'America/New_York' });
    expect((await w.send('GET', '/api/bootstrap', w.admin)).body.settings.oneEditorSince).toBe('2026-10-09');
    expect(b.oneEditorSince).toBe('2026-10-09');
  });

  it('is a day in the workspace’s time zone', () => {
    // 22:00 on Oct 8 in New York, 02:00 on Oct 9 in UTC
    expect(onOrAfterDay('2026-10-09T02:00:00Z', '2026-10-09', 'America/New_York')).toBe(false);
    expect(onOrAfterDay('2026-10-09T04:00:00Z', '2026-10-09', 'America/New_York')).toBe(true);
    expect(onOrAfterDay('2026-10-08T15:00:00Z', '2026-10-09', 'Pacific/Kiritimati')).toBe(true);
    expect(onOrAfterDay(null, '2026-10-09', 'America/New_York')).toBe(false);
  });

  it('can be changed by a manager, checked, and is kept in the history', async () => {
    expect((await w.send('PATCH', '/api/settings', w.writer, { oneEditorSince: '2026-10-01' })).status).toBe(403);
    expect((await w.send('PATCH', '/api/settings', w.leo, { oneEditorSince: '2026-10-01' })).status).toBe(403);
    const bad = await w.send('PATCH', '/api/settings', manager, { oneEditorSince: '2026-02-30' });
    expect([bad.status, bad.body.error.fields]).toEqual([400, { oneEditorSince: 'Use a valid date' }]);
    expect((await w.send('PATCH', '/api/settings', manager, { oneEditorSince: 'Oct 9' })).status).toBe(400);
    const ok = await w.send('PATCH', '/api/settings', manager, { oneEditorSince: '2026-10-08' });
    expect([ok.status, ok.body.settings.oneEditorSince, ok.body.changed]).toEqual([200, '2026-10-08', 1]);
    const log = await w.db.query<{ summary: string }>(`select summary from activity where action = 'settings.updated' order by id`);
    expect(log.map((r) => r.summary)).toEqual(['Settings: One editor per client since Oct 9, 2026 → Oct 8, 2026']);
    await w.oneEditorSince('2026-10-09');
  });
});

describe('only videos made since the rule began judge it', () => {
  it('doesn’t flag a split from before the rule', () => {
    expect(client('Alpha Gym')).toMatchObject({ open: 2, split: [], flags: [], editor: null, editorFrom: null, beforeRule: true });
    // the videos still show on their editors’ cards
    expect(card('Leo Martins')!.videos.map((v) => v.title)).toContain('Alpha 01');
    expect(card('Maya Reyes')!.videos.map((v) => v.title)).toContain('Alpha 02');
  });

  it('flags the same split made since', async () => {
    add(
      ['t_a3', 'Alpha 03', 'toDo', { ...brand('alpha', 'Alpha Gym'), ...made('2026-10-10T15:00:00Z'), assigneeIds: ['m_leo'] }],
      ['t_a4', 'Alpha 04', 'toDo', { ...brand('alpha', 'Alpha Gym'), ...made('2026-10-11T15:00:00Z'), assigneeIds: ['m_maya'] }],
    );
    try {
      b = await w.sync();
      // only the two made since count for the split; all four are open
      expect(client('Alpha Gym')).toMatchObject({
        open: 4, beforeRule: false,
        split: [expect.objectContaining({ name: 'Leo Martins', count: 1 }), expect.objectContaining({ name: 'Maya Reyes', count: 1 })],
        flags: ['Alpha Gym: 1 with Leo, 1 with Maya — one editor per client'],
      });
      expect(card('Leo Martins')!.clients.find((c) => c.name === 'Alpha Gym')?.split).toBe('Alpha Gym: 1 with Leo, 1 with Maya — one editor per client');
    } finally {
      drop('t_a3', 't_a4');
      b = await w.sync();
    }
  });

  it('works out a client’s editor only from videos made since', () => {
    // Maya made three before the rule, Leo one since
    expect(client('Beta Cafe')).toMatchObject({
      editor: expect.objectContaining({ name: 'Leo Martins' }), editorFrom: 'videos', beforeRule: false, notAssigned: 1,
      flags: ['Beta Cafe · 1 video not assigned (usually Leo)'],
    });
    expect(b.unassigned).toEqual([expect.objectContaining({ titles: 'Beta 05', brand: 'Beta Cafe', suggested: expect.objectContaining({ name: 'Leo Martins' }) })]);
  });

  it('flags two editors on a client in Timeliner only once it has videos made since', async () => {
    expect(client('Cove Dental')).toMatchObject({
      editor: null, editorFrom: null, beforeRule: true, flags: [],
      editors: [expect.objectContaining({ name: 'Leo Martins' }), expect.objectContaining({ name: 'Maya Reyes' })],
    });
    add(['t_c2', 'Cove 02', 'toDo', { ...brand('cove', 'Cove Dental'), ...made('2026-10-10T15:00:00Z') }]);
    try {
      b = await w.sync();
      expect(client('Cove Dental')).toMatchObject({
        editor: expect.objectContaining({ name: 'Leo Martins' }), editorFrom: 'client', beforeRule: false,
        flags: ['Cove Dental has 2 editors in Timeliner — one editor per client'],
      });
    } finally {
      drop('t_c2');
      b = await w.sync();
    }
  });

  it('reads a client with nothing made since as before the rule, naming only its one editor in Timeliner', () => {
    expect(client('Alpha Gym')).toMatchObject({ beforeRule: true, editor: null });
    expect(client('Delta Dance')).toMatchObject({ beforeRule: true, editor: expect.objectContaining({ name: 'Maya Reyes' }), editorFrom: 'client', flags: [] });
    // the clients on the rule first
    expect(b.clients.map((c) => c.name)).toEqual(['Beta Cafe', 'Alpha Gym', 'Cove Dental', 'Delta Dance']);
  });

  it('follows the day in Settings', async () => {
    await w.oneEditorSince('2026-10-01');
    try {
      b = await w.board();
      expect(b.oneEditorSince).toBe('2026-10-01');
      expect(client('Alpha Gym')).toMatchObject({ beforeRule: false, flags: ['Alpha Gym: 1 with Leo, 1 with Maya — one editor per client'] });
      expect(client('Beta Cafe')).toMatchObject({ editor: expect.objectContaining({ name: 'Maya Reyes' }) });
      expect(client('Cove Dental')).toMatchObject({ flags: ['Cove Dental has 2 editors in Timeliner — one editor per client'] });
    } finally {
      await w.oneEditorSince('2026-10-09');
      b = await w.board();
    }
    expect(client('Alpha Gym')).toMatchObject({ beforeRule: true, flags: [] });
  });
});

describe('only editors are editors', () => {
  it('never counts a writer on a client’s brand in Timeliner as its editor', async () => {
    const echo = brand('echo', 'Echo Dentist');
    w.tl.onBrand.b_echo = [on(wes), on(leo)];
    add(['t_e1', 'Echo 01', 'toDo', { ...echo, ...made('2026-10-10T15:00:00Z') }]);
    b = await w.sync();
    expect(card('Wes Writer')).toBeUndefined();
    expect(client('Echo Dentist')).toMatchObject({ editor: expect.objectContaining({ name: 'Leo Martins' }), editors: [expect.objectContaining({ name: 'Leo Martins' })], flags: [] });
    // the editor still has it, through the client
    expect(card('Leo Martins')!.videos.find((v) => v.title === 'Echo 01')).toMatchObject({ assignedBy: 'client' });
    // nor is it the writer's to say they're on it
    expect((await w.mine(w.writer)).toEdit).toEqual([]);
    expect((await w.send('POST', '/api/editing/focus', w.writer, { videoId: 't_e1', action: 'start' })).status).toBe(403);
  });

  it('never counts a manager given a video as its editor', async () => {
    add(['t_e2', 'Echo 02', 'toDo', { ...brand('echo', 'Echo Dentist'), ...made('2026-10-10T16:00:00Z'), assigneeIds: ['m_mo'] }]);
    b = await w.sync();
    expect(card('Mo Manager')).toBeUndefined();
    // as if nobody were on it: its client's editor's, and no split
    expect(card('Leo Martins')!.videos.find((v) => v.title === 'Echo 02')).toMatchObject({ assignedBy: 'client' });
    expect(client('Echo Dentist')).toMatchObject({ open: 2, split: [], flags: [] });
  });

  it('still counts someone in Timeliner the site doesn’t know', async () => {
    const fox = brand('fox', 'Fox Fitness');
    w.tl.onBrand.b_fox = [on(gus)];
    add(['t_f1', 'Fox 01', 'toDo', { ...fox, ...made('2026-10-10T15:00:00Z') }]);
    b = await w.sync();
    expect(card('Gus Ghost')).toMatchObject({ site: false, flag: expect.objectContaining({ kind: 'not_on_site' }) });
    expect(client('Fox Fitness')).toMatchObject({ editor: expect.objectContaining({ name: 'Gus Ghost' }), editorFrom: 'client' });
    // and one of two editors the site does know still makes two
    w.tl.onBrand.b_echo = [on(wes), on(leo), on(gus)];
    b = await w.sync();
    expect(client('Echo Dentist')).toMatchObject({ editors: [expect.anything(), expect.anything()], flags: ['Echo Dentist has 2 editors in Timeliner — one editor per client'] });
  });
});
