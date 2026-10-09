// Which shoot each video in Timeliner is from, and the script its editor gets. Joshua Shalimar's shoots: Sep 28
// (delivered by its PDF), Sep 14 Ads (delivered by hand), Oct 14 (delivered by its PDF, now at version 2) and
// Oct 28 (its PDF arrived before anything was approved). Raw camera clips are another client's (Raw Co), so their
// shoots don't move Joshua's videos. Timeliner is a stand-in.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EditingBoard, EditingVideo, MyEditing } from '../shared/types';
import { makeWorld, pdfTask, versionUploaded, video, type World } from './timeliner-world';

let w: World;
let js = 0;
const ids = { A: 0, B: 0, C: 0, L: 0 };
let B: Awaited<ReturnType<World['batch']>>;
let C: Awaited<ReturnType<World['batch']>>;
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const row = (id: string) => w.db.one<{ batch_id: number | null; script_number: number | null; match_how: string | null; match_check: boolean; match_kept: boolean }>(
  `select batch_id::int as batch_id, script_number, match_how, match_check, match_kept from timeliner_tasks where id = $1`, [id],
);
const all = (b: EditingBoard) => b.editors.flatMap((e) => e.videos);
const find = (list: EditingVideo[], title: string) => list.find((v) => v.title === title) as EditingVideo;
const leoVideos = async () => { const m = await w.mine(w.leo); return [...m.revisions, ...m.toEdit, ...m.waiting, ...m.approvedWeek]; };
const add = (...t: Parameters<typeof video>[]) => { for (const x of t) w.tl.tasks.push(video(...x)); };

beforeAll(async () => {
  w = await makeWorld();
  js = await w.client('Joshua Shalimar');
  w.at('2026-09-24T16:00:00Z');
  ids.A = (await w.batch(js, 'JS · Sep 28', 30, { shoot: '2026-09-28' })).id;
  w.tl.tasks.push(pdfTask('t_pdfA', '2026-09-24T15:00:00Z', { id: 'f_A1', name: 'JS scripts Sep.pdf' }));
  expect((await w.hook('version.uploaded', versionUploaded({ taskId: 't_pdfA', fileName: 'JS scripts Sep.pdf', version: 1, uploadedAt: w.now(), fileId: 'f_A1' }))).outcome).toBe('delivered');
  await w.stamp(ids.A, { approvedAt: '2026-09-23T15:00:00Z', deliveredAt: '2026-09-24T15:00:00Z' });
  const ads = await w.batch(js, 'Ads · Sep 14', 15, { shoot: '2026-09-14' });
  ids.L = ads.id;
  expect((await w.send('POST', `/api/batches/${ids.L}/scripts/action`, w.admin, { action: 'deliver', scriptIds: ads.ids(...range(1, 15)) })).status).toBe(200);
  await w.stamp(ids.L, { approvedAt: '2026-09-11T15:00:00Z', deliveredAt: '2026-09-12T15:00:00Z' });
  B = await w.batch(js, 'JS · Oct 14', 30, { shoot: '2026-10-14' });
  ids.B = B.id;
  await w.stamp(ids.B, { approvedAt: '2026-10-09T15:00:00Z' });
  w.at('2026-10-10T16:00:00Z');
  w.tl.tasks.push(pdfTask('t_pdfB', '2026-10-10T15:00:00Z', { id: 'f_B1', name: 'JS scripts.pdf', url: 'https://s3.example/v1?sig' }));
  expect((await w.hook('version.uploaded', versionUploaded({ taskId: 't_pdfB', fileName: 'JS scripts.pdf', version: 1, uploadedAt: w.now(), fileId: 'f_B1' }))).outcome).toBe('delivered');
  await w.stamp(ids.B, { deliveredAt: '2026-10-10T15:00:00Z' });
  // version 2 of the Oct 14 PDF
  w.at('2026-10-26T16:00:00Z');
  const t = w.tl.tasks.find((x) => x.id === 't_pdfB')!;
  t.media = { ...t.media!, fileId: 'f_B2', name: 'JS scripts FINAL.pdf', downloadUrl: 'https://s3.example/v2?sig' };
  t.updatedAt = '2026-10-26T15:00:00Z';
  expect((await w.hook('version.uploaded', versionUploaded({ taskId: 't_pdfB', fileName: 'JS scripts FINAL.pdf', version: 2, uploadedAt: '2026-10-26T15:00:00Z', fileId: 'f_B2' }))).outcome).toBe('new_version');
  // Oct 28: its PDF came before anything was approved
  C = await w.batch(js, 'JS · Oct 28', 40, { shoot: '2026-10-28', approve: 'none' });
  ids.C = C.id;
  w.tl.tasks.push(pdfTask('t_pdfC', '2026-10-27T15:00:00Z', { id: 'f_C1', name: 'JS scripts – Oct 28.pdf' }));
  expect((await w.hook('version.uploaded', versionUploaded({ taskId: 't_pdfC', fileName: 'JS scripts – Oct 28.pdf', version: 1, uploadedAt: w.now(), fileId: 'f_C1' }))).outcome).toBe('nothing_approved');
  w.at('2026-10-30T16:00:00Z');
});

afterAll(async () => {
  await w.close();
});

describe('which shoot a video is from', () => {
  it('goes by the date it was made, not by its folder’s word across shoots (flaw b), and checks a number against the batch', async () => {
    add(['t_ad3', 'Ad 03', 'toDo', { subFolderId: 'sf_ads', createdAt: '2026-10-16T15:00:00Z' }],
      ['t_o41', 'Organic 41', 'supervisorApproval', { assigneeIds: ['m_ada'], createdAt: '2026-10-16T15:00:00Z' }]);
    await w.sync();
    expect(await row('t_ad3')).toMatchObject({ batch_id: ids.B, match_how: 'date', script_number: null });
    // the Oct 14 batch has 30 scripts: no number, and the batch stands
    expect(await row('t_o41')).toMatchObject({ batch_id: ids.B, script_number: null });
  });

  it('flags two videos with the same title in one folder on the same batch', async () => {
    // Leo's: a card's videos are what's counted (the site's Admin is nobody's editor, so not on a card)
    add(['t_c1', 'Organic 15', 'supervisorApproval', { assigneeIds: ['m_leo'], createdAt: '2026-10-15T15:00:00Z' }],
      ['t_c2', 'Organic 15', 'supervisorApproval', { assigneeIds: ['m_leo'], createdAt: '2026-10-16T15:00:00Z' }]);
    const b = await w.sync();
    expect([await row('t_c1'), await row('t_c2')]).toMatchObject([{ batch_id: ids.B, match_check: true }, { batch_id: ids.B, match_check: true }]);
    expect(b.totals.toCheck).toBe(2);
    expect(find(all(b), 'Organic 15').match).toMatchObject({ how: 'date', sure: false, check: true });
  });

  it('puts a video made ahead with the next shoot when the shoot before has one of that title, and keeps it there', async () => {
    add(['t_m1', 'Organic 12', 'supervisorApproval', { assigneeIds: ['m_ada'], createdAt: '2026-09-30T15:00:00Z', updatedAt: '2026-10-29T15:00:00Z' }],
      ['t_m2', 'Organic 12', 'toDo', { createdAt: '2026-10-10T15:00:00Z' }],
      ['t_m3', 'Organic 12', 'toDo', { subFolderId: 'sf_ads', createdAt: '2026-10-10T15:00:00Z' }]);
    await w.sync();
    expect([await row('t_m1'), await row('t_m2'), await row('t_m3')]).toMatchObject([
      { batch_id: ids.A, match_how: 'date' }, { batch_id: ids.B, match_how: 'next' }, { batch_id: ids.A, match_how: 'date' },
    ]);
    // the earlier one drops out of the copy; the one made ahead stays with the Oct 14 shoot
    w.tl.tasks = w.tl.tasks.filter((x) => x.id !== 't_m1');
    await w.sync();
    expect(await row('t_m1')).toBeUndefined();
    expect(await row('t_m2')).toMatchObject({ batch_id: ids.B, match_how: 'next', match_kept: true });
  });

  it('never gives a shoot’s videos a scripts PDF that delivered nothing', async () => {
    add(['t_rawC', 'C0100', 'toDo', { assigneeIds: ['m_leo'], createdAt: '2026-10-29T15:00:00Z' }],
      ['t_o3C', 'Organic 03', 'inRevision', { assigneeIds: ['m_leo'], createdAt: '2026-10-29T15:00:00Z' }]);
    await w.sync();
    const v = await leoVideos();
    expect(find(v, 'C0100')).toMatchObject({ raw: true, batch: { id: ids.C }, scriptNumber: null, script: null, scriptIssue: 'no_document' });
    expect(find(v, 'Organic 03')).toMatchObject({ batch: { id: ids.C }, scriptNumber: 3, script: null, scriptIssue: 'not_approved' });
  });

  it('puts a video whose number is past the shoot before’s scripts with the next shoot, unless it’s due before that shoot', async () => {
    await w.approve(ids.C, C.ids(...range(1, 40)));
    add(['t_35', 'Organic 35', 'supervisorApproval', { assigneeIds: ['m_ada'], createdAt: '2026-10-24T15:00:00Z' }],
      ['t_35due', 'Organic 35', 'supervisorApproval', { assigneeIds: ['m_ada'], subFolderId: 'sf_ads', createdAt: '2026-10-24T15:00:00Z', internalDeadline: '2026-10-27' }]);
    await w.sync();
    expect(await row('t_35')).toMatchObject({ batch_id: ids.C, match_how: 'next', script_number: 35 });
    expect(await row('t_35due')).toMatchObject({ batch_id: ids.B, match_how: 'date', script_number: null });
  });

  it('leaves a video made long after any shoot not matched, until a manager pins it', async () => {
    add(['t_late', 'Organic 05', 'inRevision', { assigneeIds: ['m_leo'], createdAt: '2027-03-01T15:00:00Z' }]);
    // nobody here has this one yet: it isn't counted until it's on someone's card, where it can be pinned
    add(['t_late_na', 'Teaser 09', 'toDo', { createdAt: '2027-03-01T15:00:00Z' }]);
    let b = await w.sync();
    expect(find((await w.mine(w.leo)).revisions, 'Organic 05')).toMatchObject({
      batch: null, script: null, scriptIssue: 'not_matched', match: { how: null, sure: false, note: null },
    });
    // why is the managers' to read, never sent to the editor
    expect(find(all(b), 'Organic 05').match.note).toBe('Made Mar 1: no shoot in the 90 days before or 7 after.');
    expect(JSON.stringify(await w.mine(w.leo))).not.toContain('"note":"');
    expect(b.totals.notMatched).toBe(new Set(all(b).filter((v) => v.state !== 'approved' && !v.batch && v.match.how !== 'pinned').map((v) => v.id)).size);
    expect(b.totals.notMatched).toBeGreaterThanOrEqual(1);
    const notMatched = b.totals.notMatched;

    expect((await w.send('POST', '/api/editing/videos/t_late/pin', w.leo, { batchId: ids.C })).status).toBe(403);
    expect((await w.send('POST', '/api/editing/videos/t_late/pin', w.writer, { batchId: ids.C })).status).toBe(403);
    expect((await w.send('POST', '/api/editing/videos/t_late/pin', w.admin, { batchId: ids.C, scriptNumber: 99 })).status).toBe(400);
    expect((await w.send('POST', '/api/editing/videos/t_nope/pin', w.admin, { batchId: ids.C })).status).toBe(404);
    // a batch of the video's own client only
    const other = await w.client('Elsewhere Co');
    const otherBatch = await w.batch(other, 'Elsewhere · Oct 1', 3, { shoot: '2026-10-01' });
    const wrong = await w.send('POST', '/api/editing/videos/t_ad3/pin', w.admin, { batchId: otherBatch.id });
    expect([wrong.status, wrong.body.error.fields]).toEqual([400, { batchId: 'Pick a batch of Joshua Shalimar' }]);
    const pinned = await w.send('POST', '/api/editing/videos/t_late/pin', w.admin, { batchId: ids.C });
    expect(pinned.status).toBe(200);
    b = pinned.body as EditingBoard;
    expect(find(all(b), 'Organic 05')).toMatchObject({ batch: { id: ids.C }, scriptNumber: 5, match: { how: 'pinned', sure: true, note: 'Pinned to JS · Oct 28 by Ada Admin' } });
    expect(b.totals.notMatched).toBe(notMatched - 1);
    // a read doesn't undo it
    await w.sync();
    expect(await row('t_late')).toMatchObject({ batch_id: ids.C, match_how: 'pinned' });
    // pinned as from no batch: an answer, not a gap
    b = (await w.send('POST', '/api/editing/videos/t_late/pin', w.admin, { batchId: null })).body as EditingBoard;
    expect(find(all(b), 'Organic 05')).toMatchObject({ batch: null, match: { how: 'pinned' } });
    expect(b.totals.notMatched).toBe(notMatched - 1);

    expect((await w.send('DELETE', '/api/editing/videos/t_late/pin', w.leo)).status).toBe(403);
    const off = await w.send('DELETE', '/api/editing/videos/t_late/pin', w.admin);
    expect(off.status).toBe(200);
    expect(find(all(off.body as EditingBoard), 'Organic 05')).toMatchObject({ batch: null, match: { how: null } });
    expect(await w.db.query(`select 1 from activity where action in ('video.pinned', 'video.unpinned')`)).toHaveLength(3);
  });

  it('puts a video in a folder made for one shoot’s scripts with that shoot', async () => {
    const acme = await w.client('Acme Outdoor');
    w.tl.brands.b_acme = 'Acme Outdoor';
    w.tl.projects.p_fall = { id: 'p_fall', name: 'Acme Fall', nodeId: 'b_acme', createdAt: '2026-11-01T15:00:00Z', subFolders: [] };
    const nov = await w.batch(acme, 'Acme · Nov 3', 10, { shoot: '2026-11-03' });
    await w.batch(acme, 'Acme · Dec 1', 10, { shoot: '2026-12-01' });
    w.at('2026-11-05T16:00:00Z');
    w.tl.tasks.push(pdfTask('t_acme', '2026-11-05T15:00:00Z', { id: 'f_X1', name: 'Acme scripts.pdf' }, { projectId: 'p_fall', brandId: 'b_acme' }));
    expect((await w.hook('version.uploaded', versionUploaded({ taskId: 't_acme', fileName: 'Acme scripts.pdf', version: 1, uploadedAt: w.now(), projectId: 'p_fall', brandId: 'b_acme' }))).outcome).toBe('delivered');
    w.at('2026-12-04T16:00:00Z');
    add(['t_fall', 'Fall 04', 'supervisorApproval', { projectId: 'p_fall', brandId: 'b_acme', subFolderId: null, assigneeIds: ['m_ada'], createdAt: '2026-12-03T15:00:00Z' }],
      ['t_root', 'Teaser 01', 'supervisorApproval', { subFolderId: null, assigneeIds: ['m_ada'], createdAt: '2026-12-03T15:00:00Z' }]);
    await w.sync();
    expect(await row('t_fall')).toMatchObject({ batch_id: nov.id, match_how: 'place', script_number: 4 });
    // My Videos holds every shoot's PDFs and was made long ago: the date decides there
    expect(await row('t_root')).toMatchObject({ batch_id: ids.C, match_how: 'date' });
    w.at('2026-10-30T16:00:00Z');
  });

  it('keeps a scripts PDF’s task off the videos, follows its step, and gives a variant its parent’s batch and number', async () => {
    w.tl.tasks.push(pdfTask('t_misc', '2026-10-20T15:00:00Z', { id: 'f_M1', name: 'Call sheet.pdf' }, { statusGroup: 'toDo' }));
    add(['t_o9', 'Organic 09', 'inRevision', { assigneeIds: ['m_leo'], createdAt: '2026-10-16T15:00:00Z' }],
      ['t_o9v', 'Organic 09 – vertical', 'inRevision', { assigneeIds: ['m_leo'], kind: 'variant', parentTaskId: 't_o9', createdAt: '2026-10-20T15:00:00Z' }]);
    const b = await w.sync();
    expect(await w.db.query(`select id from timeliner_tasks where id in ('t_pdfA', 't_pdfB', 't_pdfC', 't_misc')`)).toEqual([]);
    expect(all(b).map((v) => v.title)).not.toContain('Scripts');
    expect(await row('t_o9v')).toMatchObject({ batch_id: ids.B, script_number: 9, match_how: 'parent' });
    expect(find(await leoVideos(), 'Organic 09 – vertical').match).toMatchObject({ how: 'parent', sure: false });

    // the Oct 14 PDF goes back into review in Timeliner
    w.tl.tasks.find((x) => x.id === 't_pdfB')!.statusGroup = 'supervisorApproval';
    await w.sync();
    expect(await w.db.one(`select step from timeliner_pdfs where key = 't_pdfB'`)).toEqual({ step: 'supervisorApproval' });
    expect(find(await leoVideos(), 'Organic 09').script).toMatchObject({ source: 'timeliner', inReview: true });
    w.tl.tasks.find((x) => x.id === 't_pdfB')!.statusGroup = 'approved';
    await w.sync();
    expect(find(await leoVideos(), 'Organic 09').script).toMatchObject({ inReview: false });
  });

  it('gives an Ad no number when a non-Ad video of the same batch uses it, and still the shoot’s PDF', async () => {
    // Leo's, so they're on a card (the site's Admin is nobody's editor)
    for (const n of range(1, 5)) add([`t_org${n}`, `Organic 0${n}`, 'supervisorApproval', { assigneeIds: ['m_leo'], createdAt: '2026-10-16T15:00:00Z' }]);
    add(['t_adA', 'Ad 01', 'supervisorApproval', { subFolderId: 'sf_ads', assigneeIds: ['m_leo'], createdAt: '2026-10-16T15:00:00Z' }],
      ['t_adB', 'Ad 02', 'supervisorApproval', { subFolderId: 'sf_ads', assigneeIds: ['m_leo'], createdAt: '2026-10-16T15:00:00Z' }]);
    const b = await w.sync();
    expect([await row('t_org1'), await row('t_adA'), await row('t_adB')]).toMatchObject([
      { batch_id: ids.B, script_number: 1 }, { batch_id: ids.B, script_number: null }, { batch_id: ids.B, script_number: null },
    ]);
    expect(find(all(b), 'Ad 01').script).toMatchObject({ source: 'timeliner', href: `/api/editing/script-pdf/${ids.B}` });
  });
});

describe('the script an editor opens', () => {
  it('opens the newest version of the shoot’s scripts PDF through the server, only for whoever has a video from it', async () => {
    const o9 = find(await leoVideos(), 'Organic 09');
    expect(o9.script).toMatchObject({ source: 'timeliner', href: `/api/editing/script-pdf/${ids.B}`, version: 2, name: 'JS scripts FINAL.pdf', updatedAt: '2026-10-26T15:00:00.000Z', ranges: '1–30' });
    expect(o9.script?.alt).toMatchObject({ source: 'site', href: 'https://docs.example/JS%20%C2%B7%20Oct%2014' });
    const url = `/api/editing/script-pdf/${ids.B}`;

    // Timeliner can't be reached: a plain message, nothing cached
    w.tl.taskFails = true;
    const failed = await w.send('GET', url, w.admin);
    expect([failed.status, failed.body.error.message]).toEqual([502, 'Timeliner didn’t give the scripts PDF back: Couldn’t reach Timeliner. Try again in a minute.']);
    // opened in a browser tab: a page that says so and leads back, not the API's JSON
    const tab = await w.app.inject({ method: 'GET', url, headers: { cookie: w.leo, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } });
    expect([tab.statusCode, String(tab.headers['content-type'])]).toEqual([502, 'text/html; charset=utf-8']);
    expect(tab.body).toContain('Timeliner didn’t give the scripts PDF back: Couldn’t reach Timeliner. Try again in a minute.');
    expect(tab.body).toContain('<a href="/">Back to your videos</a>');
    w.tl.taskFails = false;

    const asLeo = await w.send('GET', url, w.leo);
    expect([asLeo.status, asLeo.headers.location, asLeo.headers['cache-control']]).toEqual([302, 'https://s3.example/v2?sig', 'no-store']);
    const calls = w.tl.taskCalls.length;
    const asAdmin = await w.send('GET', url, w.admin);
    expect([asAdmin.status, asAdmin.headers.location]).toEqual([302, 'https://s3.example/v2?sig']);
    // the link is kept in memory until shortly before it expires
    expect(w.tl.taskCalls.length).toBe(calls);

    expect((await w.send('GET', url, w.maya)).status).toBe(403);
    expect((await w.send('GET', url, w.writer)).status).toBe(403);
    expect((await w.send('GET', url, '')).status).toBe(401);
    // no PDF, or one that delivered nothing
    expect((await w.send('GET', `/api/editing/script-pdf/${ids.L}`, w.admin)).status).toBe(404);
    expect((await w.send('GET', `/api/editing/script-pdf/${ids.C}`, w.admin)).status).toBe(404);

    // never stored, never sent in a payload
    const stored = JSON.stringify([
      ...await w.db.query(`select * from timeliner_pdfs`), ...await w.db.query(`select * from timeliner_tasks`), ...await w.db.query(`select * from timeliner_events`),
    ]);
    expect(stored).not.toContain('s3.example');
    expect(JSON.stringify(await w.mine(w.leo))).not.toContain('s3.example');
    expect(JSON.stringify(await w.board())).not.toContain('s3.example');
    // the card's list of documents is the batch's: no one video's second link
    const card = (await w.board()).editors.find((e) => e.name === 'Leo Martins')!;
    expect(card.scripts.find((d) => d.source === 'timeliner' && d.batchId === ids.B)).toMatchObject({ alt: null });
    expect((await w.mine(w.leo)).scripts.every((d) => d.alt === null)).toBe(true);
  });

  it('puts the site’s document first when a script was approved there after the PDF’s newest version, and gives none for one not approved', async () => {
    add(['t_o25', 'Organic 25', 'inRevision', { assigneeIds: ['m_leo'], createdAt: '2026-10-16T15:00:00Z' }],
      ['t_o26', 'Organic 26', 'inRevision', { assigneeIds: ['m_leo'], createdAt: '2026-10-16T15:00:00Z' }]);
    await w.sync();
    // script 25: delivery undone, sent back, rewritten and approved with an edited version after v2
    const [s25, s26] = [B.ids(25), B.ids(26)];
    expect((await w.send('POST', `/api/batches/${ids.B}/scripts/action`, w.admin, { action: 'undo_delivery', scriptIds: s25 })).status).toBe(200);
    expect((await w.send('POST', `/api/batches/${ids.B}/review`, w.admin, { action: 'revisions', scriptIds: s25, note: 'Sharper hook' })).status).toBe(200);
    expect((await w.send('POST', `/api/batches/${ids.B}/submissions`, w.writer, { scriptIds: s25, url: 'https://docs.example/b25-take2' })).status).toBe(200);
    expect((await w.send('POST', `/api/batches/${ids.B}/review`, w.admin, { action: 'approve', scriptIds: s25, url: 'https://docs.example/b25-edited' })).status).toBe(200);
    await w.db.query(`update scripts set approved_at = '2026-10-27T15:00:00Z' where id = $1`, s25);
    let v = await leoVideos();
    expect(find(v, 'Organic 25').script).toMatchObject({ source: 'site', href: 'https://docs.example/b25-edited', edited: true, alt: { source: 'timeliner', version: 2 } });
    expect(find(v, 'Organic 26').script).toMatchObject({ source: 'timeliner', alt: { source: 'site' } });

    // script 26 sent back for revisions: no link at all
    expect((await w.send('POST', `/api/batches/${ids.B}/scripts/action`, w.admin, { action: 'undo_delivery', scriptIds: s26 })).status).toBe(200);
    expect((await w.send('POST', `/api/batches/${ids.B}/review`, w.admin, { action: 'revisions', scriptIds: s26, note: 'Too long' })).status).toBe(200);
    v = await leoVideos();
    expect(find(v, 'Organic 26')).toMatchObject({ scriptNumber: 26, script: null, scriptIssue: 'not_approved' });
  });
});

describe('a video that has been in review keeps its shoot', () => {
  it('stays put when a shoot is added before it; one never reviewed moves', async () => {
    add(['t_o17', 'Organic 17', 'toDo', { assigneeIds: ['m_leo'], createdAt: '2026-10-16T15:00:00Z' }],
      ['t_o18', 'Organic 18', 'toDo', { assigneeIds: ['m_leo'], createdAt: '2026-10-16T15:00:00Z' }]);
    await w.sync();
    expect(await row('t_o17')).toMatchObject({ batch_id: ids.B, match_kept: false });
    const t = w.tl.tasks.find((x) => x.id === 't_o17')!;
    t.statusGroup = 'supervisorApproval';
    await w.sync();
    t.statusGroup = 'inRevision';
    t.updatedAt = '2026-11-02T15:00:00Z';
    await w.sync();
    // its new cut is a video, not a document: ignored
    expect((await w.hook('version.uploaded', versionUploaded({ taskId: 't_o17', fileName: 'Organic 17 v2.mp4', version: 2, uploadedAt: w.now() }))).outcome).toBe('ignored');

    const oct15 = await w.batch(js, 'JS · Oct 15', 30, { shoot: '2026-10-15' });
    await w.sync();
    expect(await row('t_o17')).toMatchObject({ batch_id: ids.B, match_how: 'date', match_kept: true, script_number: 17 });
    expect(find(await leoVideos(), 'Organic 17').match).toMatchObject({ how: 'date', kept: true });
    expect(await row('t_o18')).toMatchObject({ batch_id: oct15.id, match_kept: false });
  });
});

// ── raw clips ────────────────────────────────────────────────────────────

describe('raw camera clips and the titled videos made from them', () => {
  const raw = { RB: 0, R20: 0 };
  const clip = (id: string, title: string, more: Parameters<typeof video>[3] = {}) =>
    video(id, title, 'toDo', { projectId: 'p_raw', brandId: 'b_raw', subFolderId: null, createdAt: '2026-10-15T14:00:00Z', updatedAt: '2026-10-15T14:00:00Z', ...more });

  beforeAll(async () => {
    const rc = await w.client('Raw Co');
    w.tl.brands.b_raw = 'Raw Co';
    w.tl.projects.p_raw = { id: 'p_raw', name: 'Raw Co videos', nodeId: 'b_raw', createdAt: '2025-01-10T15:00:00Z', subFolders: [] };
    raw.RB = (await w.batch(rc, 'Raw · Oct 14', 30, { shoot: '2026-10-14' })).id;
    w.at('2026-10-10T16:00:00Z');
    w.tl.tasks.push(pdfTask('t_rawpdf', '2026-10-10T15:00:00Z', { id: 'f_RP', name: 'Raw Co scripts.pdf' }, { projectId: 'p_raw', brandId: 'b_raw' }));
    expect((await w.hook('version.uploaded', versionUploaded({ taskId: 't_rawpdf', fileName: 'Raw Co scripts.pdf', version: 1, uploadedAt: w.now(), projectId: 'p_raw', brandId: 'b_raw' }))).outcome).toBe('delivered');
    raw.R20 = (await w.batch(rc, 'Raw · Oct 20', 30, { shoot: '2026-10-20' })).id;
    // the footage, uploaded the day after the Oct 14 shoot and given to Leo
    for (const n of range(1, 10)) w.tl.tasks.push(clip(`t_clip${n}`, `C${String(n).padStart(4, '0')}`, { assigneeIds: ['m_leo'] }));
    w.tl.tasks.push(clip('t_c45', 'C0045', { assigneeIds: ['m_leo'] }));
    w.at('2026-10-16T10:00:00Z');
  });

  it('puts a raw clip with the shoot that had just happened, with no script number, and gives it the shoot’s whole scripts PDF', async () => {
    const b = await w.sync();
    const v = await leoVideos();
    expect(find(v, 'C0045')).toMatchObject({
      raw: true, batch: { id: raw.RB }, scriptNumber: null, scriptIssue: null,
      script: { source: 'timeliner', href: `/api/editing/script-pdf/${raw.RB}`, name: 'Raw Co scripts.pdf' }, match: { how: 'date', sure: true },
    });
    // camera numbers say nothing about scripts
    expect(find(v, 'C0005')).toMatchObject({ batch: { id: raw.RB }, scriptNumber: null });
    expect(b.editors.find((e) => e.name === 'Leo Martins')?.plate).toMatchObject({ rawToEdit: 12 });
    // remembered: Leo is cutting the Oct 14 shoot (the raw clips are trashed once the titled videos are in)
    expect(await w.db.query(`select distinct member_id, batch_id::int as batch_id from timeliner_editor_clips where batch_id = $1`, [raw.RB])).toEqual([{ member_id: 'm_leo', batch_id: raw.RB }]);
  });

  it('numbers a raw clip renamed and sent to review, and keeps its shoot', async () => {
    w.at('2026-10-16T12:00:00Z');
    const t = w.tl.tasks.find((x) => x.id === 't_c45')!;
    t.title = '07 – Coffee run';
    t.statusGroup = 'supervisorApproval';
    await w.sync();
    expect(find(await leoVideos(), '07 – Coffee run')).toMatchObject({ raw: false, batch: { id: raw.RB }, scriptNumber: 7, match: { how: 'date', kept: true } });
  });

  it('puts a new titled video with the shoot whose raw clips its editor has been cutting, as its raw clip is trashed', async () => {
    w.at('2026-10-22T09:30:00Z');
    expect((await w.send('POST', '/api/editing/focus', w.leo, { videoId: 't_clip3', action: 'start' })).status).toBe(200);
    // Leo uploads the finished video as a new task straight into review, and C0003 is trashed, between two reads
    w.tl.tasks.push(video('t_new05', '05 – Morning routine', 'supervisorApproval', { projectId: 'p_raw', brandId: 'b_raw', subFolderId: null, assigneeIds: ['m_leo'], createdAt: '2026-10-22T10:00:00Z', updatedAt: '2026-10-22T10:00:00Z' }));
    w.tl.tasks = w.tl.tasks.filter((x) => x.id !== 't_clip3');
    w.at('2026-10-22T10:20:00Z');
    const b = await w.sync();
    const leo = b.editors.find((e) => e.name === 'Leo Martins')!;
    expect(find(leo.videos, '05 – Morning routine')).toMatchObject({
      batch: { id: raw.RB }, scriptNumber: 5, match: { how: 'editor', sure: true, note: 'Leo Martins has been cutting raw clips from the Oct 14 shoot' },
    });
    expect(leo.lastFinished).toEqual({ title: '05 – Morning routine', at: '2026-10-22T10:00:00.000Z', onSite: false });
    // the clip they were on is gone, so that's over
    expect(leo.focus).toBeNull();
    expect(await row('t_clip3')).toBeUndefined();
    // a raw clip marked done minutes later still leaves the titled video as their last finished
    w.at('2026-10-22T10:25:00Z');
    expect((await w.send('POST', '/api/editing/focus', w.leo, { videoId: 't_clip4', action: 'done' })).status).toBe(200);
    expect((await w.board()).editors.find((e) => e.name === 'Leo Martins')?.lastFinished?.title).toBe('05 – Morning routine');
  });

  it('keeps the titled videos when the leftover raw clips are deleted, and still knows which shoot Leo was cutting', async () => {
    w.at('2026-10-27T10:00:00Z');
    for (const x of w.tl.tasks) if (x.projectId === 'p_raw' && /^C\d{4}$/.test(x.title)) x.status = 'trashed';
    await w.sync();
    const left = (await leoVideos()).filter((v) => v.client?.name === 'Raw Co').map((v) => v.title).sort();
    expect(left).toEqual(['05 – Morning routine', '07 – Coffee run']);
    // twelve days after the clips, with the Oct 20 shoot in between: still the shoot Leo was cutting
    w.tl.tasks.push(video('t_new08', '08 – Lunch', 'supervisorApproval', { projectId: 'p_raw', brandId: 'b_raw', subFolderId: null, assigneeIds: ['m_leo'], createdAt: '2026-10-27T09:00:00Z' }));
    // Maya has no raw clips: her titled video goes by date
    w.tl.tasks.push(video('t_maya', '06 – Gym', 'supervisorApproval', { projectId: 'p_raw', brandId: 'b_raw', subFolderId: null, assigneeIds: ['m_maya'], createdAt: '2026-10-22T11:00:00Z' }));
    await w.sync();
    expect(await row('t_new08')).toMatchObject({ batch_id: raw.RB, match_how: 'editor', script_number: 8 });
    expect(await row('t_maya')).toMatchObject({ batch_id: raw.R20, match_how: 'date', script_number: 6 });
    expect(await row('t_new05')).toMatchObject({ batch_id: raw.RB, match_kept: true });
  });

  it('groups raw clips nobody has been given by the shoot they’re from', async () => {
    for (const n of range(200, 208)) w.tl.tasks.push(clip(`t_u${n}`, `C0${n}`, { createdAt: '2026-10-21T14:00:00Z' }));
    const b = await w.sync();
    expect(b.unassigned.find((g) => g.raw)).toMatchObject({
      raw: true, batch: { id: raw.R20, title: 'Raw · Oct 20', shootDate: '2026-10-20' }, count: 9, clientName: 'Raw Co', titles: 'C0200–0208',
    });
    // none of Raw Co's raw clips is on Leo's plate any more
    const mine: MyEditing = await w.mine(w.leo);
    expect(mine.toEdit.filter((v) => v.raw && v.client?.name === 'Raw Co')).toEqual([]);
  });

  it('matches a titled video made straight into review before anyone had it again once it’s given to its editor', async () => {
    w.at('2026-10-27T11:00:00Z');
    const t = video('t_walk', '09 – Walk', 'supervisorApproval', { projectId: 'p_raw', brandId: 'b_raw', subFolderId: null, assigneeIds: [], createdAt: '2026-10-27T11:00:00Z', updatedAt: '2026-10-27T11:00:00Z' });
    w.tl.tasks.push(t);
    expect((await w.hook('task.created', { taskId: 't_walk', projectId: 'p_raw' })).outcome).toBe('video');
    // nobody has it yet: the latest shoot before it was made
    expect(await row('t_walk')).toMatchObject({ batch_id: raw.R20, match_how: 'date' });
    // half a minute later it's Leo's, whose raw clips were from the Oct 14 shoot
    w.at('2026-10-27T11:00:30Z');
    t.assigneeIds = ['m_leo'];
    t.updatedAt = w.now();
    expect((await w.hook('task.updated', { taskId: 't_walk', projectId: 'p_raw' })).outcome).toBe('video');
    expect(await row('t_walk')).toMatchObject({ batch_id: raw.RB, match_how: 'editor', script_number: 9 });
    await w.sync();
    expect(await row('t_walk')).toMatchObject({ batch_id: raw.RB, match_how: 'editor', match_kept: true });
  });
});

describe('a shoot date fixed after the raw clips came in', () => {
  it('moves the raw clips, and what their editor is remembered cutting, to the right shoot', async () => {
    const fc = await w.client('Fixco');
    w.tl.brands.b_fix = 'Fixco';
    w.tl.projects.p_fix = { id: 'p_fix', name: 'Fixco videos', nodeId: 'b_fix', createdAt: '2025-01-10T15:00:00Z', subFolders: [] };
    const oct10 = await w.batch(fc, 'Fixco · Oct 10', 10, { shoot: '2026-10-10' });
    // the Oct 14 shoot, entered as Oct 24 by mistake
    const oct14 = await w.batch(fc, 'Fixco · Oct 14', 10, { shoot: '2026-10-24' });
    const clips = range(1, 4).map((n) => video(`t_fix${n}`, `C10${n}0`, 'toDo', { projectId: 'p_fix', brandId: 'b_fix', subFolderId: null, assigneeIds: ['m_leo'], createdAt: '2026-10-15T14:00:00Z' }));
    w.tl.tasks.push(...clips);
    w.at('2026-10-16T10:00:00Z');
    await w.sync();
    expect(await row('t_fix1')).toMatchObject({ batch_id: oct10.id });
    // the date is fixed: the clips move, and so does the memory of them
    await w.db.query(`update shoots set start_date = '2026-10-14' where id = (select shoot_id from batches where id = $1)`, [oct14.id]);
    w.at('2026-10-17T10:00:00Z');
    await w.sync();
    expect(await row('t_fix1')).toMatchObject({ batch_id: oct14.id });
    expect(await w.db.query(`select distinct batch_id::int as batch_id from timeliner_editor_clips where task_id like 't_fix%'`)).toEqual([{ batch_id: oct14.id }]);
    // the clips are trashed; Leo's titled video goes to the shoot he was really cutting
    for (const c of clips) c.status = 'trashed';
    w.tl.tasks.push(video('t_fix05', '05 – Morning routine', 'supervisorApproval', { projectId: 'p_fix', brandId: 'b_fix', subFolderId: null, assigneeIds: ['m_leo'], createdAt: '2026-10-22T10:00:00Z' }));
    w.at('2026-10-22T10:20:00Z');
    await w.sync();
    expect(await row('t_fix05')).toMatchObject({ batch_id: oct14.id, match_how: 'editor', script_number: 5 });
  });
});

describe('a scripts PDF that delivered nothing', () => {
  it('isn’t offered when some of the shoot’s scripts aren’t approved, even when others were delivered by hand', async () => {
    const hc = await w.client('Halfco');
    w.tl.brands.b_half = 'Halfco';
    w.tl.projects.p_half = { id: 'p_half', name: 'Halfco videos', nodeId: 'b_half', createdAt: '2025-01-10T15:00:00Z', subFolders: [] };
    const b = await w.batch(hc, 'Halfco · Oct 14', 10, { shoot: '2026-10-14', approve: [1, 2] });
    expect((await w.send('POST', `/api/batches/${b.id}/scripts/action`, w.admin, { action: 'deliver', scriptIds: b.ids(1, 2) })).status).toBe(200);
    w.at('2026-10-10T16:00:00Z');
    w.tl.tasks.push(pdfTask('t_half', '2026-10-10T15:00:00Z', { id: 'f_HF', name: 'Halfco scripts Oct 14.pdf' }, { projectId: 'p_half', brandId: 'b_half' }));
    expect((await w.hook('version.uploaded', versionUploaded({ taskId: 't_half', fileName: 'Halfco scripts Oct 14.pdf', version: 1, uploadedAt: w.now(), projectId: 'p_half', brandId: 'b_half' }))).outcome).toBe('nothing_approved');
    w.tl.tasks.push(video('t_half_c', 'C0045', 'toDo', { projectId: 'p_half', brandId: 'b_half', subFolderId: null, assigneeIds: ['m_leo'], createdAt: '2026-10-15T14:00:00Z' }));
    w.at('2026-10-16T10:00:00Z');
    await w.sync();
    // the PDF isn't offered; the raw clip gets the shoot's document from the site instead
    expect(find(await leoVideos(), 'C0045')).toMatchObject({ batch: { id: b.id }, script: { source: 'site', batchId: b.id, alt: null }, scriptIssue: null });
    expect((await w.send('GET', `/api/editing/script-pdf/${b.id}`, w.leo)).status).toBe(404);
  });
});
