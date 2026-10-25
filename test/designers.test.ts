// Thumbnail designers: an Editor sign-in whose one job is thumbnails (users.editor_kind). The kind lives only on an
// editor (the database says so too), never blocks re-adding someone, can't change while they have open briefs, and
// keeps every editor rule (never given scripts). Designers aren't video editors: no card on the Editors tab, never
// a Timeliner video's owner, no "Scripts final" notices. And option images open only for whoever may see them:
// designers their own work and clients' winners, managers sent rounds, writers and video editors never.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { editorIds } from '../server/core';
import { bufferFile, storeFile } from '../server/files';
import { homePath } from '../shared/workflow';
import type { Bootstrap, Me, SessionMode, UserSummary } from '../shared/types';
import { makeWorld, video, type World } from './timeliner-world';

let w: World;
let adminId = 0;
let acme = 0;
let globex = 0;
const ids = { dee: 0, dan: 0, leo: 0, maya: 0 };
const cookies = { dee: '', dan: '' };

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.from([0, 0, 5, 0, 0, 0, 2, 0xd0, 8, 2, 0, 0, 0])]);

const login = async (email: string, password = 'team-password-1') => String((await w.app.inject({
  method: 'POST', url: '/api/auth/login', headers: { 'x-scale-media': '1', 'content-type': 'application/json' }, payload: JSON.stringify({ email, password }),
})).headers['set-cookie']).split(';')[0];
const idOf = (users: UserSummary[], email: string) => users.find((u) => u.email === email)!.id;
const addPerson = (name: string, email: string, role: string, editorKind?: string | null) =>
  w.send('POST', '/api/users', w.admin, { name, email, role, password: 'team-password-1', ...(editorKind !== undefined ? { editorKind } : {}) });
const stored = async (id: number) => (await w.db.one<{ role: string; editor_kind: string | null }>(`select role, editor_kind from users where id = $1`, [id]))!;
const fileStatus = async (fileId: number, cookie: string) => (await w.app.inject({ method: 'GET', url: `/api/files/${fileId}`, headers: { cookie } })).statusCode;

// thumbnail rows written straight to the database (the routes that write them are tested in test/thumbnails.test.ts)
const brief = async (designerId: number | null, clientId = acme, o: { cancelled?: boolean } = {}) =>
  (await w.db.one<{ id: number }>(
    `insert into thumbnail_briefs (client_id, title, designer_id, created_by, cancelled_at) values ($1, 'Morning routine', $2, $3, ${o.cancelled ? 'now()' : 'null'}) returning id`,
    [clientId, designerId, adminId],
  ))!.id;
const round = async (briefId: number, number: number, by: number, sent: boolean) =>
  (await w.db.one<{ id: number }>(
    `insert into thumbnail_rounds (brief_id, number, created_by, sent_at) values ($1, $2, $3, ${sent ? 'now()' : 'null'}) returning id`, [briefId, number, by],
  ))!.id;
const option = async (roundId: number, letter: string, by: number) => {
  const me: Me = { id: by, name: 'Designer', email: '', role: 'editor', capacityPerDay: null, editorKind: 'thumbnail' };
  const fileId = await w.db.tx((t) => storeFile(t, me, bufferFile(`${letter}.png`, 'image/png', PNG)));
  const v = await w.db.one<{ id: number }>(
    `insert into thumbnail_variants (round_id, letter, file_id, mime, width, height, uploaded_by) values ($1, $2, $3, 'image/png', 1280, 720, $4) returning id`, [roundId, letter, fileId, by],
  );
  return { id: v!.id, fileId };
};
const decide = (roundId: number, action: 'pick' | 'changes', variantId: number | null = null) =>
  w.db.query(`insert into thumbnail_decisions (round_id, action, variant_id, note, decided_by) values ($1, $2, $3, $4, $5)`,
    [roundId, action, variantId, action === 'changes' ? 'Bigger face, fewer words' : null, adminId]);

beforeAll(async () => {
  w = await makeWorld();
  const users = (await w.send('GET', '/api/users', w.admin)).body.users as UserSummary[];
  adminId = idOf(users, 'ada@scale.test');
  ids.leo = idOf(users, 'leo@scale.test');
  ids.maya = idOf(users, 'maya@scale.test');
  for (const [key, name] of [['dee', 'Dee Designer'], ['dan', 'Dan Drawer']] as const) {
    const r = await addPerson(name, `${key}@scale.test`, 'editor', 'thumbnail');
    expect([r.status, r.body?.error]).toEqual([200, undefined]);
    ids[key] = idOf(r.body.users, `${key}@scale.test`);
    cookies[key] = await login(`${key}@scale.test`);
  }
  acme = await w.client('Acme');
  globex = await w.client('Globex');
});

afterAll(async () => {
  await w.close();
});

describe('a kind, only on an editor', () => {
  it('is cleared with the role, and refused on anyone but an editor', async () => {
    const r = await addPerson('Kit Kind', 'kit@scale.test', 'editor', 'thumbnail');
    const kit = idOf(r.body.users, 'kit@scale.test');
    expect(r.body.users.find((u: UserSummary) => u.id === kit).editorKind).toBe('thumbnail');
    // a writer has no kind to give
    const writer = await addPerson('Wil Wrong', 'wil@scale.test', 'writer', 'thumbnail');
    expect([writer.status, Object.keys(writer.body.error.fields ?? {})]).toEqual([400, ['editorKind']]);
    // the form sends every field: a writer's null kind is fine
    expect((await addPerson('Wyn Writer', 'wyn@scale.test', 'writer', null)).status).toBe(200);

    // leaving the Editor role takes the kind with it, in the same change
    expect((await w.send('PATCH', `/api/users/${kit}`, w.admin, { role: 'writer' })).status).toBe(200);
    expect(await stored(kit)).toEqual({ role: 'writer', editor_kind: null });
    const log = await w.db.one<{ summary: string }>(`select summary from activity where entity_type = 'user' and entity_id = $1 order by id desc limit 1`, [kit]);
    expect(log!.summary).toMatch(/Thumbnail designer → Writer/);
    const wrong = await w.send('PATCH', `/api/users/${kit}`, w.admin, { role: 'writer', editorKind: 'thumbnail' });
    expect([wrong.status, Object.keys(wrong.body.error.fields ?? {})]).toEqual([400, ['editorKind']]);
    // and back again
    expect((await w.send('PATCH', `/api/users/${kit}`, w.admin, { role: 'editor', editorKind: 'thumbnail' })).status).toBe(200);
    expect(await stored(kit)).toEqual({ role: 'editor', editor_kind: 'thumbnail' });
    // a video editor saved as one isn't a change (no kind already means video editor)
    expect((await w.send('PATCH', `/api/users/${ids.leo}`, w.admin, { role: 'editor', editorKind: 'short_form' })).status).toBe(200);
    expect(await stored(ids.leo)).toEqual({ role: 'editor', editor_kind: null });
  });

  it('lets a removed designer come back as anything', async () => {
    const r = await addPerson('Rae Return', 'rae@scale.test', 'editor', 'thumbnail');
    const rae = idOf(r.body.users, 'rae@scale.test');
    expect((await w.send('POST', `/api/users/${rae}/remove`, w.admin, {})).status).toBe(200);
    const back = await addPerson('Rae Return', 'rae@scale.test', 'writer');
    expect([back.status, back.body?.error]).toEqual([200, undefined]);
    expect(await stored(rae)).toEqual({ role: 'writer', editor_kind: null });
    expect((await w.send('POST', `/api/users/${rae}/remove`, w.admin, {})).status).toBe(200);
    expect((await addPerson('Rae Return', 'rae@scale.test', 'editor', 'thumbnail')).status).toBe(200);
    expect(await stored(rae)).toEqual({ role: 'editor', editor_kind: 'thumbnail' });
  });

  it('is enforced by the database, so every change of role must clear it (as the admin reset does)', async () => {
    const r = await addPerson('Sal Sql', 'sal@scale.test', 'editor', 'thumbnail');
    const sal = idOf(r.body.users, 'sal@scale.test');
    await expect(w.db.query(`update users set role = 'owner' where id = $1`, [sal])).rejects.toThrow(/users_editor_kind_check/);
    await expect(w.db.query(`update users set editor_kind = 'video' where id = $1`, [sal])).rejects.toThrow(/users_editor_kind_check/);
    // server/index.ts's MANAGER_RESET_PASSWORD reset
    await w.db.query(`update users set role = 'owner', editor_kind = null where id = $1`, [sal]);
    expect(await stored(sal)).toEqual({ role: 'owner', editor_kind: null });
  });

  it('can’t change while they have open briefs: those are reassigned first', async () => {
    const r = await addPerson('Pia Picks', 'pia@scale.test', 'editor', 'thumbnail');
    const pia = idOf(r.body.users, 'pia@scale.test');
    const b = await brief(pia);
    await brief(pia, acme, { cancelled: true });
    const kind = await w.send('PATCH', `/api/users/${pia}`, w.admin, { role: 'editor', editorKind: 'short_form' });
    expect([kind.status, Object.keys(kind.body.error.fields ?? {})]).toEqual([400, ['editorKind']]);
    expect(kind.body.error.message).toMatch(/1 open thumbnail brief/);
    const role = await w.send('PATCH', `/api/users/${pia}`, w.admin, { role: 'writer' });
    expect([role.status, Object.keys(role.body.error.fields ?? {})]).toEqual([400, ['role']]);
    expect(await stored(pia)).toEqual({ role: 'editor', editor_kind: 'thumbnail' });
    // picked: done with. A manager deciding again (changes) opens it back up
    const r1 = await round(b, 1, pia, true);
    const a = await option(r1, 'A', pia);
    await decide(r1, 'pick', a.id);
    await decide(r1, 'changes');
    expect((await w.send('PATCH', `/api/users/${pia}`, w.admin, { editorKind: 'short_form' })).status).toBe(400);
    await decide(r1, 'pick', a.id);
    expect((await w.send('PATCH', `/api/users/${pia}`, w.admin, { editorKind: 'short_form' })).status).toBe(200);
    expect(await stored(pia)).toEqual({ role: 'editor', editor_kind: 'short_form' });
  });
});

describe('a designer is still an editor', () => {
  it('is never given, split onto or handed scripts', async () => {
    const split = await w.send('POST', '/api/batches', w.admin, { clientId: acme, title: 'No designers', targetCount: 2, split: [{ writerId: ids.dee, count: 2 }] });
    expect(split.status).toBe(400);
    const b = await w.send('POST', '/api/batches', w.admin, { clientId: acme, title: 'Assign to a designer', targetCount: 1, split: [{ writerId: w.writerId, count: 1 }] });
    const sid = (await w.detail(b.body.batchId)).scripts[0].id;
    expect((await w.send('POST', `/api/batches/${b.body.batchId}/scripts/assign`, w.admin, { scriptIds: [sid], assigneeId: ids.dee })).status).toBe(400);
    // nor can a designer take over a writer's unfinished scripts
    expect((await w.send('PATCH', `/api/users/${w.writerId}`, w.admin, { active: false, reassignTo: ids.dee })).status).toBe(400);
    expect((await w.db.one<{ active: boolean }>(`select active from users where id = $1`, [w.writerId]))!.active).toBe(true);
  });

  it('signs in to their Studio, and View as shows them as a thumbnail designer', async () => {
    const boot = (await w.send('GET', '/api/bootstrap', cookies.dee)).body as Bootstrap;
    expect([boot.me.role, boot.me.editorKind, homePath(boot.me)]).toEqual(['editor', 'thumbnail', '/studio']);
    expect(boot.users.find((u) => u.id === ids.dan)?.editorKind).toBe('thumbnail');
    expect(boot.counts).toMatchObject({ thumbnailsToReview: 0, myThumbnails: expect.any(Number) });
    // a video editor's Home isn't theirs
    expect((await w.send('GET', '/api/editing/me', cookies.dee)).status).toBe(403);

    const as = await w.send('POST', '/api/admin/view-as', w.admin, { userId: ids.dee });
    expect((as.body as SessionMode).viewingAs).toMatchObject({ id: ids.dee, role: 'editor', roleLabel: 'Thumbnail designer' });
    const seen = (await w.send('GET', '/api/bootstrap', w.admin)).body as Bootstrap;
    expect([seen.me.id, seen.me.editorKind]).toEqual([ids.dee, 'thumbnail']);
    // exactly what they get: the designer's routes, not a video editor's
    expect((await w.send('GET', '/api/editing/me', w.admin)).status).toBe(403);
    const leo = await w.send('POST', '/api/admin/view-as', w.admin, { userId: ids.leo });
    expect((leo.body as SessionMode).viewingAs?.roleLabel).toBe('Video editor');
    expect((await w.send('POST', '/api/admin/view-as/stop', w.admin, {})).status).toBe(200);
  });
});

describe('designers aren’t video editors', () => {
  it('get no “Scripts final” or “Shoot moved” notices', async () => {
    const list = await editorIds(w.db);
    expect(list).toEqual(expect.arrayContaining([ids.leo, ids.maya]));
    expect(list).not.toContain(ids.dee);
    expect(list).not.toContain(ids.dan);
  });

  it('own no Timeliner video and get no card on the Editors tab', async () => {
    const base = await w.api.members();
    w.api.members = async () => [
      ...base,
      { id: 'm_dee', email: 'dee@scale.test', firstName: 'Dee', lastName: 'Designer', role: 'editor' },
      // in Timeliner under another email, with Dan's name
      { id: 'm_dan', email: 'dan.drawer@gmail.test', firstName: 'Dan', lastName: 'Drawer', role: 'editor' },
    ];
    w.tl.tasks.push(
      video('t_dee', 'Organic 41', 'toDo', { assigneeIds: ['m_dee'] }),
      video('t_leo', 'Organic 42', 'toDo', { assigneeIds: ['m_leo'] }),
      video('t_dan', 'Organic 43', 'toDo', { assigneeIds: ['m_dan'] }),
    );
    const b = await w.sync();
    // Leo's video is his; the one only a designer is on is nobody's, and she isn't flagged as having nothing
    expect(b.editors.find((e) => e.name === 'Leo Martins')?.videos.map((v) => v.title)).toContain('Organic 42');
    expect(b.editors.filter((e) => e.userId === ids.dee || e.userId === ids.dan)).toEqual([]);
    expect(b.editors.find((e) => e.name === 'Dee Designer')).toBeUndefined();
    expect(b.unassigned.flatMap((g) => g.videoTitles)).toContain('Organic 41');
    // someone in Timeliner who only shares a designer's name isn't taken for them
    expect(b.editors.find((e) => e.name === 'Dan Drawer')).toMatchObject({ userId: null, flag: { kind: 'not_on_site' } });
    // video editors with nothing in Timeliner still are
    expect(b.editors.find((e) => e.name === 'Maya Reyes')?.flag?.kind).toBe('nothing_assigned');
  });
});

describe('option images', () => {
  it('open for their designer, managers once sent, and other designers only as a client’s winner', async () => {
    // Dee: round 1 sent, round 2 in her tray
    const mine = await brief(ids.dee);
    const r1 = await round(mine, 1, ids.dee, true);
    const sent = await option(r1, 'A', ids.dee);
    const r2 = await round(mine, 2, ids.dee, false);
    const draft = await option(r2, 'A', ids.dee);
    // Dan, for the same client: B picked over A; for another client: A picked; and a cancelled brief's pick
    const dans = await brief(ids.dan);
    const d1 = await round(dans, 1, ids.dan, true);
    const lost = await option(d1, 'A', ids.dan);
    const won = await option(d1, 'B', ids.dan);
    await decide(d1, 'pick', won.id);
    const elsewhere = await round(await brief(ids.dan, globex), 1, ids.dan, true);
    const other = await option(elsewhere, 'A', ids.dan);
    await decide(elsewhere, 'pick', other.id);
    const gone = await round(await brief(ids.dan, acme, { cancelled: true }), 1, ids.dan, true);
    const cancelled = await option(gone, 'A', ids.dan);
    await decide(gone, 'pick', cancelled.id);

    const files = { sent: sent.fileId, draft: draft.fileId, lost: lost.fileId, won: won.fileId, other: other.fileId, cancelled: cancelled.fileId };
    const who = async (cookie: string) => Object.fromEntries(await Promise.all(Object.entries(files).map(async ([k, id]) => [k, await fileStatus(id, cookie)])));
    expect(await who(cookies.dee)).toEqual({ sent: 200, draft: 200, lost: 404, won: 200, other: 404, cancelled: 404 });
    expect(await who(cookies.dan)).toEqual({ sent: 404, draft: 404, lost: 200, won: 200, other: 200, cancelled: 200 });
    // managers: sent rounds, never a tray
    expect(await who(w.admin)).toEqual({ sent: 200, draft: 404, lost: 200, won: 200, other: 200, cancelled: 200 });
    // writers and video editors: never
    for (const cookie of [w.writer, w.leo]) expect(Object.values(await who(cookie))).toEqual([404, 404, 404, 404, 404, 404]);
    const img = await w.app.inject({ method: 'GET', url: `/api/files/${sent.fileId}`, headers: { cookie: cookies.dee } });
    expect([img.headers['content-type'], String(img.headers['content-disposition']).split(';')[0]]).toEqual(['image/png', 'inline']);

    // the brief moves to Dan: Dee keeps the round she sent and her tray is taken away; the brief is Dan's now, but
    // Dee's unpicked options stay hers (owner's rule: only a winner is shared between designers)
    await w.db.query(`update thumbnail_briefs set designer_id = $2 where id = $1`, [mine, ids.dan]);
    await w.db.query(`update thumbnail_variants set removed_at = now() where round_id = $1`, [r2]);
    expect([await fileStatus(sent.fileId, cookies.dee), await fileStatus(draft.fileId, cookies.dee)]).toEqual([200, 404]);
    expect([await fileStatus(sent.fileId, cookies.dan), await fileStatus(draft.fileId, cookies.dan)]).toEqual([404, 404]);
    // the tray stays with the brief: what Dan puts in it is his
    const his = await option(r2, 'A', ids.dan);
    expect([await fileStatus(his.fileId, cookies.dan), await fileStatus(his.fileId, cookies.dee), await fileStatus(his.fileId, w.admin)]).toEqual([200, 404, 404]);
    // a manager deciding again takes the winner back from everyone but its designer
    await decide(d1, 'changes');
    expect([await fileStatus(won.fileId, cookies.dee), await fileStatus(won.fileId, cookies.dan)]).toEqual([404, 200]);
  });
});

describe('through the Thumbnails page', () => {
  it('counts a designer’s briefs on their plate, and frees their kind once those are reassigned', async () => {
    const r = await addPerson('Tia Thumb', 'tia@scale.test', 'editor', 'thumbnail');
    const tia = idOf(r.body.users, 'tia@scale.test');
    const tiaCookie = await login('tia@scale.test');
    const made = await w.send('POST', '/api/thumbnails', w.admin, { clientId: acme, title: 'Garden makeover', designerId: tia });
    expect([made.status, made.body.designerName]).toEqual([200, 'Tia Thumb']);
    expect(((await w.send('GET', '/api/bootstrap', tiaCookie)).body as Bootstrap).counts.myThumbnails).toBe(1);
    const kind = await w.send('PATCH', `/api/users/${tia}`, w.admin, { editorKind: 'short_form' });
    expect([kind.status, Object.keys(kind.body.error.fields ?? {})]).toEqual([400, ['editorKind']]);
    // given to Dee on the Thumbnails page: it's off Tia's plate, so she can change job
    expect((await w.send('PATCH', `/api/thumbnails/${made.body.id}`, w.admin, { designerId: ids.dee })).status).toBe(200);
    expect(((await w.send('GET', '/api/bootstrap', tiaCookie)).body as Bootstrap).counts.myThumbnails).toBe(0);
    expect((await w.send('PATCH', `/api/users/${tia}`, w.admin, { editorKind: 'short_form' })).status).toBe(200);
    // a video editor now: never given a thumbnail, and no Studio
    const given = await w.send('POST', '/api/thumbnails', w.admin, { clientId: acme, title: 'Not for editors', designerId: tia });
    expect([given.status, Object.keys(given.body.error.fields ?? {})]).toEqual([400, ['designerId']]);
    expect((await w.send('GET', `/api/studio?userId=${tia}`, w.admin)).status).toBe(404);
  });
});
