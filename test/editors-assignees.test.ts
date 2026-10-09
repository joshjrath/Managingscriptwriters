// The Editors tab matches Timeliner's assignee filter exactly: a video is its assignees' and nobody else's. A client
// whose brand still has editors from before the one-editor rule (Dentist Mike has five) doesn't hand its unassigned
// videos to all of them: those are nobody's, under "Not assigned", with the client's editor as whom to give them.
// And the team's Needs review is Timeliner's inProgress step group: in review, off the editor's plate. This is the
// owner's report (Victor and Asher on Dentist Mike) as a test. Timeliner is a stand-in.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EditingBoard, EditorRow, MyEditing } from '../shared/types';
import type { TimelinerApi, TimelinerBrandMember } from '../server/timeliner';
import { MIGRATIONS } from '../server/schema';
import { makeWorld, video, type World } from './timeliner-world';

let w: World;
let b: EditingBoard;
let victor = '';
let asher = '';
type Members = Awaited<ReturnType<TimelinerApi['members']>>;
const person = (id: string, email: string, firstName: string, lastName: string) => ({ id, email, firstName, lastName, role: 'editor', deactivated: false });
const members: Members = [
  { id: 'm_ada', email: 'ada@scale.test', firstName: 'Ada', lastName: 'Admin', role: 'admin', deactivated: false },
  person('m_victor', 'victor@scale.test', 'Victor', 'Vance'),
  person('m_asher', 'asher@scale.test', 'Asher', 'Ames'),
  // left on Dentist Mike's brand from before the one-editor rule
  person('m_leo', 'leo@scale.test', 'Leo', 'Martins'),
  person('m_maya', 'maya@scale.test', 'Maya', 'Reyes'),
  person('m_gus', 'gus@freelance.test', 'Gus', 'Ghost'),
];
const card = (name: string) => b.editors.find((e) => e.name === name) as EditorRow | undefined;
const titles = (e: EditorRow | undefined) => (e?.videos ?? []).map((v) => v.title).sort();
const add = (...t: Parameters<typeof video>[]) => { for (const x of t) w.tl.tasks.push(video(...x)); };
const mine = (cookie: string): Promise<MyEditing> => w.mine(cookie);

beforeAll(async () => {
  w = await makeWorld();
  await w.oneEditorSince('2026-01-01');
  w.api.members = async () => members;
  for (const [name, email] of [['Victor Vance', 'victor@scale.test'], ['Asher Ames', 'asher@scale.test']]) {
    expect((await w.send('POST', '/api/users', w.admin, { name, email, role: 'editor', password: 'team-password-1' })).status).toBe(200);
  }
  const login = async (email: string) => String((await w.app.inject({
    method: 'POST', url: '/api/auth/login', headers: { 'x-scale-media': '1', 'content-type': 'application/json' }, payload: JSON.stringify({ email, password: 'team-password-1' }),
  })).headers['set-cookie']).split(';')[0];
  [victor, asher] = [await login('victor@scale.test'), await login('asher@scale.test')];

  await w.client('Dentist Mike');
  w.tl.brands.b_dm = 'Dentist Mike';
  w.tl.projects.p_dm = { id: 'p_dm', name: '3rd Batch', nodeId: 'b_dm', createdAt: '2026-09-01T15:00:00Z', subFolders: [] };
  const dm = { projectId: 'p_dm', brandId: 'b_dm', subFolderId: null };
  // five editors on the client's brand in Timeliner
  w.tl.onBrand.b_dm = members.slice(1).map((member): TimelinerBrandMember => ({ role: 'editor', automatic: false, member }));
  add(
    // nobody is assigned to these in Timeliner
    ['t_u1', 'Dentist Mike 01', 'toDo', dm], ['t_u2', 'Dentist Mike 02', 'toDo', dm],
    // Victor: six in Needs review (the inProgress step group), nothing to edit
    ...[1, 2, 3, 4, 5, 6].map((n): Parameters<typeof video> => [`t_v${n}`, `Smile ${n}`, 'inProgress', { ...dm, assigneeIds: ['m_victor'] }]),
    // Asher: two sent back, one waiting for review, two approved
    ['t_a1', 'Implant 01', 'inRevision', { ...dm, assigneeIds: ['m_asher'], internalRevisions: 1 }],
    ['t_a2', 'Implant 02', 'inRevision', { ...dm, assigneeIds: ['m_asher'], internalRevisions: 1 }],
    ['t_a3', 'Implant 03', 'inProgress', { ...dm, assigneeIds: ['m_asher'] }],
    ['t_a4', 'Implant 04', 'approved', { ...dm, assigneeIds: ['m_asher'], approvedAt: '2026-10-07T18:00:00Z', updatedAt: '2026-10-07T18:00:00Z' }],
    ['t_a5', 'Implant 05', 'approved', { ...dm, assigneeIds: ['m_asher'], approvedAt: '2026-10-07T18:00:00Z', updatedAt: '2026-10-07T18:00:00Z' }],
  );
  b = await w.sync();
});

afterAll(async () => {
  await w.close();
});

describe('a video is its assignees’ in Timeliner, and nobody else’s', () => {
  it('shows a video assigned to Victor only on Victor’s card', () => {
    expect(titles(card('Victor Vance'))).toEqual(['Smile 1', 'Smile 2', 'Smile 3', 'Smile 4', 'Smile 5', 'Smile 6']);
    expect(titles(card('Asher Ames'))).toEqual(['Implant 01', 'Implant 02', 'Implant 03', 'Implant 04', 'Implant 05']);
    for (const name of ['Leo Martins', 'Maya Reyes']) expect(titles(card(name))).toEqual([]);
    // being on the client's brand alone gives someone not on the site no card to fix
    expect(card('Gus Ghost')).toBeUndefined();
    expect(b.sync.counts).toMatchObject({ people: 2 });
  });

  it('puts a video nobody is assigned to on nobody’s card, and under Not assigned with the client’s editor', () => {
    const onCards = b.editors.flatMap((e) => e.videos).map((v) => v.title);
    expect(onCards.filter((t) => t.startsWith('Dentist Mike'))).toEqual([]);
    expect(b.unassigned).toEqual([expect.objectContaining({
      folder: '3rd Batch', clientName: 'Dentist Mike', count: 2, titles: 'Dentist Mike 01–02',
      // the client's editor: on its brand in Timeliner, with the most of its videos
      suggested: expect.objectContaining({ name: 'Victor Vance', memberId: 'm_victor' }),
    })]);
    expect(b.totals.notAssigned).toBe(2);
    // the five editors on its brand still flag the client, and still name its editor
    expect(b.clients.find((c) => c.name === 'Dentist Mike')).toMatchObject({
      editor: { name: 'Victor Vance' }, editorFrom: 'client', notAssigned: 2,
      flags: ['Dentist Mike has 5 editors in Timeliner — one editor per client', 'Dentist Mike · 2 videos not assigned (usually Victor)'],
    });
  });

  it('keeps it off every editor’s Home, and nobody can say they’re on it', async () => {
    for (const cookie of [victor, asher, w.leo, w.maya]) {
      const m = await mine(cookie);
      expect([...m.toEdit, ...m.revisions, ...m.waiting].map((v) => v.title).filter((t) => t.startsWith('Dentist Mike'))).toEqual([]);
      const r = await w.send('POST', '/api/editing/focus', cookie, { videoId: 't_u1', action: 'start' });
      expect([r.status, r.body.error.message]).toEqual([403, 'That video isn’t assigned to you in Timeliner.']);
    }
  });
});

describe('Needs review is Timeliner’s inProgress step group', () => {
  it('counts Victor’s six as in review, waiting on the managers, with nothing to edit', async () => {
    expect(card('Victor Vance')).toMatchObject({ nextUp: null, plate: { toEdit: 0, revisions: 0, inReview: 6, withClient: 0 } });
    expect(card('Victor Vance')!.videos.every((v) => v.state === 'in_review' && v.step === 'Needs review')).toBe(true);
    const m = await mine(victor);
    expect(m.toEdit).toEqual([]);
    expect(m.waiting.map((v) => v.title).sort()).toEqual(['Smile 1', 'Smile 2', 'Smile 3', 'Smile 4', 'Smile 5', 'Smile 6']);
    // nothing to start: it's already in review
    expect((await w.send('POST', '/api/editing/focus', victor, { videoId: 't_v1', action: 'start' })).status).toBe(409);
    expect(card('Asher Ames')).toMatchObject({ plate: { toEdit: 0, revisions: 2, inReview: 1, approvedWeek: 2 } });
    // Victor's six and Asher's one
    expect(b.totals.waitingOnYou).toBe(7);
  });

  it('ends what an editor is on when the video moves to Needs review', async () => {
    expect((await w.send('POST', '/api/editing/focus', asher, { videoId: 't_a1', action: 'start' })).status).toBe(200);
    const sent = '2026-10-08T14:30:00.000Z';
    w.at(sent);
    w.tl.tasks = w.tl.tasks.map((t) => (t.id === 't_a1' ? { ...t, statusGroup: 'inProgress', updatedAt: sent } : t));
    expect((await w.hook('task.status_changed', { taskId: 't_a1', projectId: 'p_dm', title: 'Implant 01', statusGroup: 'inProgress', previousStatusGroup: 'inRevision', changedAt: sent })).outcome).toBe('video');
    const m = await mine(asher);
    expect(m.focus).toBeNull();
    expect(m.revisions.map((v) => v.title)).toEqual(['Implant 02']);
    expect(m.waiting.find((v) => v.title === 'Implant 01')).toMatchObject({ state: 'in_review', step: 'Needs review' });
    b = await w.board();
    expect(card('Asher Ames')!.lastFinished).toMatchObject({ title: 'Implant 01', onSite: false });
  });
});

describe('videos already in Needs review when this changed', () => {
  it('read their exact step and when they moved there on the next read', async () => {
    const smile = () => card('Victor Vance')!.videos.find((v) => v.id === 't_v1');
    const real = w.api.lastMove;
    w.api.lastMove = async (id) => (id === 't_v1' ? { at: '2026-10-07T16:00:00Z', to: 'Needs review', byId: 'm_victor' } : null);
    try {
      // as the copy kept them before: nothing changed in Timeliner, so their history isn't asked for again
      b = await w.sync();
      expect(smile()).toMatchObject({ step: 'Needs review', movedAt: null });
      // migration 36 asks again for every video in the inProgress step group
      await w.db.tx(async (t) => {
        const m = MIGRATIONS[35];
        if (typeof m === 'string') await t.query(m); else await m(t);
      });
      b = await w.sync();
      expect(smile()).toMatchObject({ state: 'in_review', step: 'Needs review', movedAt: '2026-10-07T16:00:00.000Z' });
    } finally {
      w.api.lastMove = real;
    }
  });
});
