// The Editors tab offers to add the people in Timeliner who aren't on the site, prefilled, even before anyone gives
// them a video: a client's editor in Timeliner with nothing assigned has no card, so they're listed in `toAdd` (the
// "Fix these people" line) with their Timeliner email, their clients and, when their name is in Settings → Editors,
// that entry (for Give site access). A flagged card carries its Settings → Editors entry too. Reviewers, automatic
// access, people who left Timeliner, the site's writers and managers, and anyone whose Timeliner email is a deactivated
// account here are never offered. Timeliner is a stand-in.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EditingBoard, EditorRow, EditorToAdd } from '../shared/types';
import type { TimelinerApi, TimelinerBrandMember } from '../server/timeliner';
import { makeWorld, video, type World } from './timeliner-world';

let w: World;
let b: EditingBoard;
const rows = { dana: 0, kai: 0 };
type Members = Awaited<ReturnType<TimelinerApi['members']>>;
const person = (id: string, email: string, firstName: string, lastName: string, role = 'editor', deactivated = false) => ({ id, email, firstName, lastName, role, deactivated });
const ana = person('m_ana', 'ana@freelance.test', 'Ana', 'Lopez');
const dana = person('m_dana', 'dana@studio.test', 'Dana', 'Diaz');
const gus = person('m_gus', 'gus@freelance.test', 'Gus', 'Ghost');
const kai = person('m_kai', 'kai@studio.test', 'Kai', 'Kim');
const members: Members = [
  person('m_ada', 'ada@scale.test', 'Ada', 'Admin', 'admin'),
  person('m_leo', 'leo@scale.test', 'Leo', 'Martins'),
  ana, dana, gus, kai,
  // a second Timeliner account of Ana's, on another client, with nothing assigned either: one Ana to add
  person('m_ana2', 'ana.lopez@gmail.test', 'Ana', 'Lopez'),
  // a second Timeliner account of Gus's, with nothing assigned: his card covers him
  person('m_gus2', 'gus@other.test', 'Gus', 'Ghost'),
  // reviewers in Timeliner, listed as editors on the brand
  person('m_sue', 'sue@freelance.test', 'Sue', 'Supervisor', 'supervisor'),
  person('m_gil', 'gil@client.test', 'Gil', 'Guest', 'guest'),
  // a workspace admin not on the site, on every brand automatically; and an editor whose access is automatic
  person('m_tad', 'tad@freelance.test', 'Tad', 'Admin', 'admin'),
  person('m_otto', 'otto@freelance.test', 'Otto', 'Auto'),
  // has left Timeliner, with one finished video
  person('m_olga', 'olga@freelance.test', 'Olga', 'Old', 'editor', true),
  // video editors deactivated on the site, under their Timeliner emails: Pia with nothing assigned, Pat with a video
  person('m_pia', 'pia@freelance.test', 'Pia', 'Paused'),
  person('m_pat', 'pat@freelance.test', 'Pat', 'Paused'),
  // the site's writer and a manager, under their site emails
  person('m_wes', 'wes@scale.test', 'Wes', 'Writer'),
  person('m_mo', 'mo@scale.test', 'Mo', 'Manager'),
  // on the site as Nia North under another email
  person('m_nia', 'nia.north@gmail.test', 'Nia', 'North'),
];
const on = (member: (typeof members)[number], role = 'editor', automatic = false): TimelinerBrandMember => ({ role, automatic, member: { ...member, deactivated: false } });
const card = (name: string) => b.editors.find((e) => e.name === name) as EditorRow | undefined;
const toAdd = (name: string) => b.toAdd.find((p) => p.name === name) as EditorToAdd | undefined;

beforeAll(async () => {
  w = await makeWorld();
  await w.oneEditorSince('2026-01-01');
  w.api.members = async () => members;
  for (const [name, email, role] of [['Mo Manager', 'mo@scale.test', 'manager'], ['Nia North', 'nia@scale.test', 'editor']]) {
    expect((await w.send('POST', '/api/users', w.admin, { name, email, role, password: 'team-password-1' })).status).toBe(200);
  }
  for (const [name, email] of [['Pia Paused', 'pia@freelance.test'], ['Pat Paused', 'pat@freelance.test']]) {
    const r = await w.send('POST', '/api/users', w.admin, { name, email, role: 'editor', editorKind: 'short_form', password: 'team-password-1' });
    expect(r.status).toBe(200);
    const id = (r.body.users as { id: number; email: string }[]).find((u) => u.email === email)!.id;
    expect((await w.send('PATCH', `/api/users/${id}`, w.admin, { active: false })).status).toBe(200);
  }
  // Settings → Editors: Dana (nothing assigned in Timeliner) and Kai (with a video), who don't sign in
  for (const [name, city, k] of [['Dana Diaz', 'Manila, Philippines', 'dana'], ['Kai Kim', 'Lisbon, Portugal', 'kai']] as const) {
    const r = await w.send('POST', '/api/editors', w.admin, { name, city, workStart: 9, workEnd: 18 });
    expect(r.status).toBe(200);
    rows[k] = r.body.editors.find((e: { name: string }) => e.name === name).id;
  }
  await w.client('Acme');
  w.tl.brands.b_acme = 'Acme';
  w.tl.brands.b_zen = 'Zen Yoga';
  w.tl.projects.p_acme = { id: 'p_acme', name: 'Acme Reels', nodeId: 'b_acme', createdAt: '2026-01-05T15:00:00Z', subFolders: [] };
  w.tl.projects.p_zen = { id: 'p_zen', name: 'Zen Yoga Reels', nodeId: 'b_zen', createdAt: '2026-01-05T15:00:00Z', subFolders: [] };
  const acme = { projectId: 'p_acme', brandId: 'b_acme', subFolderId: null };
  const zen = { projectId: 'p_zen', brandId: 'b_zen', subFolderId: null };
  const byId = (id: string) => members.find((m) => m.id === id)!;
  w.tl.onBrand = {
    b_acme: [
      on(ana), on(dana), on(gus), on(kai), on(byId('m_gus2')), on(byId('m_sue')), on(byId('m_gil')),
      on(byId('m_tad'), 'admin', true), on(byId('m_otto'), 'editor', true), on(byId('m_olga')),
      on(byId('m_wes')), on(byId('m_mo')), on(byId('m_nia')), on(byId('m_pia')), on(byId('m_pat')),
    ],
    b_zen: [on(byId('m_ana2')), on(byId('m_tad'), 'admin', true)],
  };
  w.tl.tasks.push(
    video('t_g1', 'Acme 01', 'toDo', { ...acme, assigneeIds: ['m_gus'] }),
    video('t_k1', 'Acme 02', 'toDo', { ...acme, assigneeIds: ['m_kai'] }),
    video('t_u1', 'Acme 03', 'toDo', acme),
    video('t_z1', 'Zen 01', 'toDo', zen),
    video('t_o1', 'Acme 04', 'approved', { ...acme, assigneeIds: ['m_olga'] }),
    video('t_p1', 'Acme 05', 'toDo', { ...acme, assigneeIds: ['m_pat'] }),
  );
  b = await w.sync();
});

afterAll(async () => {
  await w.close();
});

describe('a client’s editor in Timeliner with nothing assigned, not on the site', () => {
  it('is ready to add, with their Timeliner email and clients, and still has no card', () => {
    expect(toAdd('Ana Lopez')).toEqual({
      key: 'mm_ana', memberId: 'm_ana', name: 'Ana Lopez', email: 'ana@freelance.test', clients: ['Acme', 'Zen Yoga'],
      flag: { kind: 'not_on_site', timelinerEmail: 'ana@freelance.test', siteEmail: null, text: 'Not on the site — add them as an Editor with ana@freelance.test' },
      city: null, timezone: null, workHours: null, editorId: null,
    });
    expect(card('Ana Lopez')).toBeUndefined();
  });

  it('asks for site access, with the Settings → Editors entry, its city, time zone and hours, when their name is there', () => {
    expect(toAdd('Dana Diaz')).toMatchObject({
      key: 'mm_dana', email: 'dana@studio.test', clients: ['Acme'], editorId: rows.dana,
      city: 'Manila, Philippines', timezone: 'Asia/Manila', workHours: [9, 18],
      flag: { kind: 'no_site_access', timelinerEmail: 'dana@studio.test', text: 'Not on the site (they’re in Settings → Editors) — give them site access with dana@studio.test' },
    });
    expect(card('Dana Diaz')).toBeUndefined();
  });

  it('never offers a reviewer, automatic access, someone who left, or the site’s writers and managers', () => {
    expect(b.toAdd.map((p) => p.name)).toEqual(['Ana Lopez', 'Dana Diaz']);
    // Olga left Timeliner with only a finished video: no card, and nothing to add
    for (const id of ['m_sue', 'm_gil', 'm_tad', 'm_otto', 'm_olga', 'm_wes', 'm_mo']) {
      expect(b.toAdd.some((p) => p.memberId === id)).toBe(false);
      expect(b.editors.some((e) => e.memberId === id)).toBe(false);
    }
  });

  it('lists each name once, with the clients of every Timeliner account under it', () => {
    expect(b.toAdd.filter((p) => p.name === 'Ana Lopez')).toHaveLength(1);
    expect(toAdd('Ana Lopez')).toMatchObject({ memberId: 'm_ana', email: 'ana@freelance.test', clients: ['Acme', 'Zen Yoga'] });
    expect(b.toAdd.some((p) => p.memberId === 'm_ana2')).toBe(false);
  });

  it('never offers someone whose Timeliner email is a deactivated account here (adding them again would clash)', async () => {
    expect(b.toAdd.some((p) => p.memberId === 'm_pia' || p.name === 'Pia Paused')).toBe(false);
    expect(card('Pia Paused')).toBeUndefined();
    // with a video they keep their card, flagged to be reactivated rather than added
    expect(card('Pat Paused')).toMatchObject({
      key: 'mm_pat', site: false,
      flag: { kind: 'deactivated', timelinerEmail: 'pat@freelance.test', siteEmail: 'pat@freelance.test', text: 'Deactivated on the site as pat@freelance.test — reactivate them in Settings → Team' },
    });
    expect(card('Pat Paused')).not.toHaveProperty('editorId');
    expect(b.toAdd.some((p) => p.memberId === 'm_pat')).toBe(false);
    // what Add would have sent: the team already has that email
    const r = await w.send('POST', '/api/users', w.admin, { name: 'Pia Paused', email: 'pia@freelance.test', role: 'editor', editorKind: 'short_form', password: 'team-password-1' });
    expect(r.status).toBe(409);
  });

  it('keeps someone with a video a flagged card, never also in toAdd (nor a second account of theirs)', () => {
    expect(card('Gus Ghost')).toMatchObject({ key: 'mm_gus', site: false, flag: { kind: 'not_on_site', timelinerEmail: 'gus@freelance.test' } });
    expect(card('Gus Ghost')).not.toHaveProperty('editorId');
    expect(b.toAdd.some((p) => p.memberId === 'm_gus' || p.memberId === 'm_gus2' || p.name === 'Gus Ghost')).toBe(false);
  });

  it('matches someone on the site by name (their emails differ): not offered to add', () => {
    expect(card('Nia North')).toMatchObject({ site: true, memberId: 'm_nia', flag: { kind: 'email_differs' } });
    expect(toAdd('Nia North')).toBeUndefined();
  });

  it('gives a flagged card in Settings → Editors that entry, for Give site access', () => {
    expect(card('Kai Kim')).toMatchObject({
      key: 'mm_kai', site: false, editorId: rows.kai, city: 'Lisbon, Portugal', timezone: 'Europe/Lisbon', workHours: [9, 18],
      flag: { kind: 'no_site_access', timelinerEmail: 'kai@studio.test' },
    });
  });
});

describe('the editors’ own Home', () => {
  it('carries none of it', async () => {
    // the managers' board has it
    expect(JSON.stringify(b)).toContain('ana@freelance.test');
    expect(b.toAdd.find((p) => p.name === 'Dana Diaz')?.editorId).toBe(rows.dana);
    for (const cookie of [w.leo, w.maya]) {
      const r = await w.send('GET', '/api/editing/me', cookie);
      expect(r.status).toBe(200);
      const text = JSON.stringify(r.body);
      for (const word of ['toAdd', 'editorId', 'ana@freelance.test', 'dana@studio.test', 'Ana Lopez', 'Settings → Editors']) expect(text).not.toContain(word);
    }
  });
});

describe('once they’re on the site', () => {
  it('takes someone added with their Timeliner email off the list: they get a card', async () => {
    expect(toAdd('Ana Lopez')).toBeDefined();
    const r = await w.send('POST', '/api/users', w.admin, { name: 'Ana Lopez', email: 'ana@freelance.test', role: 'editor', editorKind: 'short_form', password: 'team-password-1' });
    expect(r.status).toBe(200);
    b = await w.board();
    expect(toAdd('Ana Lopez')).toBeUndefined();
    expect(card('Ana Lopez')).toMatchObject({ site: true, memberId: 'm_ana', flag: null });
  });

  it('takes someone given site access off the list, and their Settings → Editors entry goes', async () => {
    expect(b.toAdd.map((p) => p.name)).toEqual(['Dana Diaz']);
    const r = await w.send('POST', '/api/users', w.admin, {
      name: 'Dana Diaz', email: 'dana@studio.test', role: 'editor', editorKind: 'short_form', password: 'team-password-1',
      city: 'Manila, Philippines', timezone: 'Asia/Manila', workStart: 9, workEnd: 18,
    });
    expect(r.status).toBe(200);
    expect((await w.send('DELETE', `/api/editors/${toAdd('Dana Diaz')!.editorId}?reason=access`, w.admin)).status).toBe(200);
    b = await w.board();
    expect(b.toAdd).toEqual([]);
    expect(card('Dana Diaz')).toMatchObject({ site: true, memberId: 'm_dana', flag: null, city: 'Manila, Philippines' });
    expect(card('Dana Diaz')).not.toHaveProperty('editorId');
    expect(((await w.send('GET', '/api/editors', w.admin)).body.editors as { name: string }[]).map((e) => e.name)).toEqual(['Kai Kim']);
  });
});
