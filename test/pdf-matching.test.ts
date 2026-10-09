// A shoot's scripts PDF in Timeliner: matched to its batch once, by its task, and every later version follows
// it. The shoots are Joshua Shalimar's: Sep 28 (delivered, with its PDF), Sep 14 Ads (delivered by hand Sep 12),
// Oct 14 (approved, waiting for its PDF) and Oct 28 (nothing approved yet). Timeliner is a stand-in.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { linkDeliveredPdfs } from '../server/backfill';
import type { TimelinerStatus } from '../shared/types';
import { makeWorld, pdfTask, versionUploaded, video, type World } from './timeliner-world';

let w: World;
let js = 0;
const A = { id: 0 };
const B = { id: 0 };
const L = { id: 0 };
let C: Awaited<ReturnType<World['batch']>>;
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const status = async () => (await w.send('GET', '/api/timeliner', w.admin)).body as TimelinerStatus;
const link = async (key: string) => (await status()).pdfs.find((p) => p.key === key);
const event = async (id: string) => (await status()).events.find((e) => e.id === id);
const notes = async (cookie: string) => (await w.send('GET', '/api/notifications', cookie)).body.notifications as { title: string; body: string }[];

beforeAll(async () => {
  w = await makeWorld();
  js = await w.client('Joshua Shalimar');
  // Sep 28: its PDF, made Sep 24, delivered it
  w.at('2026-09-24T16:00:00Z');
  A.id = (await w.batch(js, 'JS · Sep 28', 30, { shoot: '2026-09-28' })).id;
  w.tl.tasks.push(pdfTask('t_pdfA', '2026-09-24T15:00:00Z', { id: 'f_A1', name: 'JS scripts Sep.pdf' }));
  expect((await w.hook('version.uploaded', versionUploaded({ taskId: 't_pdfA', fileName: 'JS scripts Sep.pdf', version: 1, uploadedAt: '2026-09-24T15:00:00Z', fileId: 'f_A1' }))).outcome).toBe('delivered');
  await w.stamp(A.id, { approvedAt: '2026-09-23T15:00:00Z', deliveredAt: '2026-09-24T15:00:00Z' });
  // the Sep 14 Ads, delivered by hand on Sep 12
  const ads = await w.batch(js, 'Ads · Sep 14', 15, { shoot: '2026-09-14' });
  L.id = ads.id;
  expect((await w.send('POST', `/api/batches/${L.id}/scripts/action`, w.admin, { action: 'deliver', scriptIds: ads.ids(...range(1, 15)) })).status).toBe(200);
  await w.stamp(L.id, { approvedAt: '2026-09-11T15:00:00Z', deliveredAt: '2026-09-12T15:00:00Z' });
  // Oct 14: approved, waiting for its PDF; Oct 28: nothing approved yet
  B.id = (await w.batch(js, 'JS · Oct 14', 30, { shoot: '2026-10-14' })).id;
  await w.stamp(B.id, { approvedAt: '2026-10-09T15:00:00Z' });
  C = await w.batch(js, 'JS · Oct 28', 40, { shoot: '2026-10-28', approve: 'none' });
});

afterAll(async () => {
  await w.close();
});

describe('a scripts PDF finds its shoot once, and its versions follow it', () => {
  it('goes to the shoot waiting for its scripts, not the one delivered before (flaw a)', async () => {
    w.at('2026-10-10T16:00:00Z');
    w.tl.tasks.push(pdfTask('t_pdfB', '2026-10-10T15:00:00Z', { id: 'f_B1', name: 'JS scripts.pdf' }));
    const r = await w.hook('version.uploaded', versionUploaded({ taskId: 't_pdfB', fileName: 'JS scripts.pdf', version: 1, uploadedAt: '2026-10-10T15:00:00Z', fileId: 'f_B1' }));
    expect(r.outcome).toBe('delivered');
    const b = await w.detail(B.id);
    expect(b.progress.delivered).toBe(30);
    expect(b.deliveries).toHaveLength(1);
    expect(b.deliveries[0]).toMatchObject({ verification: 'timeliner', scriptNumbers: range(1, 30) });
    // the shoot before keeps the one delivery its own PDF made
    expect((await w.detail(A.id)).deliveries).toHaveLength(1);
    expect(await link('t_pdfB')).toMatchObject({ kind: 'task', batch: { id: B.id }, how: 'date', sure: true, version: 1, fileName: 'JS scripts.pdf', gone: false, firstAt: '2026-10-10T15:00:00.000Z' });
    await w.stamp(B.id, { deliveredAt: '2026-10-10T15:00:00Z' });
  });

  it('goes by a date in its name before dates', async () => {
    await w.approve(C.id, C.ids(1, 2, 3, 4, 5));
    w.tl.tasks.push(pdfTask('t_pdfC', '2026-10-02T15:00:00Z', { id: 'f_C1', name: 'JS scripts – Oct 28.pdf' }));
    const r = await w.hook('version.uploaded', versionUploaded({ taskId: 't_pdfC', fileName: 'JS scripts – Oct 28.pdf', version: 1, uploadedAt: '2026-10-10T15:00:00Z', fileId: 'f_C1' }));
    expect(r.outcome).toBe('delivered');
    expect((await w.detail(C.id)).progress.delivered).toBe(5);
    expect(await link('t_pdfC')).toMatchObject({ batch: { id: C.id }, how: 'name', sure: true });
  });

  it('takes a new version to its own batch, delivers nothing new, and tells the editors cutting that shoot once', async () => {
    // Leo is fixing a video from the Oct 14 shoot; Maya has nothing from it
    w.tl.tasks.push(video('t_o7', 'Organic 07', 'inRevision', {
      assigneeIds: ['m_leo'], createdAt: '2026-10-16T15:00:00Z', updatedAt: '2026-10-20T15:00:00Z',
      media: { fileId: 'f_o7', name: 'Organic 07.mp4', mimeType: 'video/mp4', downloadUrl: null, expiresAt: null, purgedAt: null },
    }));
    w.at('2026-10-20T16:00:00Z');
    await w.sync();
    expect((await w.mine(w.leo)).revisions[0]).toMatchObject({ title: 'Organic 07', batch: { id: B.id }, scriptNumber: 7, script: { source: 'timeliner', version: 1 } });
    // the Oct 28 shoot now has ten approved, waiting
    await w.approve(C.id, C.ids(...range(6, 15)));
    const before = { b: (await w.detail(B.id)).deliveries.length, c: (await w.detail(C.id)).progress };

    w.at('2026-10-26T16:00:00Z');
    const t = w.tl.tasks.find((x) => x.id === 't_pdfB')!;
    t.media = { ...t.media!, fileId: 'f_B2', name: 'JS scripts FINAL.pdf', downloadUrl: 'https://s3.example/v2?sig' };
    const v2 = versionUploaded({ taskId: 't_pdfB', fileName: 'JS scripts FINAL.pdf', version: 2, uploadedAt: '2026-10-26T15:00:00Z', fileId: 'f_B2' });
    expect((await w.hook('version.uploaded', v2, 'evt_v2')).outcome).toBe('new_version');
    expect((await w.detail(B.id)).deliveries).toHaveLength(before.b);
    const c = (await w.detail(C.id)).progress;
    expect([c.delivered, c.awaitingDelivery]).toEqual([before.c.delivered, before.c.awaitingDelivery]);
    expect([c.delivered, c.awaitingDelivery]).toEqual([5, 10]);
    expect(await link('t_pdfB')).toMatchObject({ version: 2, fileName: 'JS scripts FINAL.pdf', latestAt: '2026-10-26T15:00:00.000Z' });
    // Settings → Timeliner: listed as a new version (and, for the screen as it is, as nothing to pick)
    expect(await event('evt_v2')).toMatchObject({ result: 'new_version', outcome: 'already_delivered', version: 2, batch: { id: B.id }, suggestedBatch: null });
    const told = (await notes(w.leo)).filter((n) => n.title.startsWith('New scripts PDF'));
    expect(told).toEqual([expect.objectContaining({ title: 'New scripts PDF · Joshua Shalimar', body: 'The scripts PDF for the Oct 14 shoot has a new version (v2).' })]);
    expect((await notes(w.maya)).filter((n) => n.title.startsWith('New scripts PDF'))).toEqual([]);
    // no notice for the managers: nothing for them to do
    expect((await notes(w.admin)).filter((n) => n.body?.includes('JS scripts FINAL.pdf'))).toEqual([]);
    // Timeliner sending the same message again changes nothing
    expect((await w.hook('version.uploaded', v2, 'evt_v2')).outcome).toBe('duplicate');
    expect((await notes(w.leo)).filter((n) => n.title.startsWith('New scripts PDF'))).toHaveLength(1);
  });

  it('asks when a new PDF’s name points at a shoot that already has its PDF', async () => {
    w.tl.tasks.push(pdfTask('t_dup', '2026-10-20T15:00:00Z', { id: 'f_D1', name: 'JS scripts Oct 14 v2.pdf' }));
    const r = await w.hook('version.uploaded', versionUploaded({ taskId: 't_dup', fileName: 'JS scripts Oct 14 v2.pdf', version: 1, uploadedAt: '2026-10-26T15:00:00Z', fileId: 'f_D1' }), 'evt_dup');
    expect(r.outcome).toBe('unmatched');
    const e = await event('evt_dup');
    expect(e).toMatchObject({ outcome: 'unmatched', result: 'unmatched', suggestedBatch: { id: B.id, title: 'JS · Oct 14', clientName: 'Joshua Shalimar' }, batch: null });
    expect(e?.detail).toMatch(/^JS · Oct 14 already has its scripts PDF “JS scripts FINAL\.pdf”/);
    expect(await link('t_dup')).toBeUndefined();
    expect((await w.detail(B.id)).deliveries).toHaveLength(1);
  });

  it('asks when a new PDF is named like the PDF of a shoot still ahead; a manager’s pick links it, and its versions follow', async () => {
    w.at('2026-10-12T16:00:00Z');
    w.tl.tasks.push(pdfTask('t_re', '2026-10-12T15:00:00Z', { id: 'f_R1', name: 'JS scripts.pdf' }));
    expect((await w.hook('version.uploaded', versionUploaded({ taskId: 't_re', fileName: 'JS scripts.pdf', version: 1, uploadedAt: '2026-10-12T15:00:00Z', fileId: 'f_R1' }), 'evt_re')).outcome).toBe('unmatched');
    const s = await status();
    expect(s.events.find((e) => e.id === 'evt_re')).toMatchObject({ suggestedBatch: { id: B.id } });
    // offered to pick even though nothing there is waiting
    expect(s.openBatches.map((b) => b.id)).toContain(B.id);

    expect((await w.send('POST', '/api/timeliner/events/evt_re/assign', w.writer, { batchId: B.id })).status).toBe(403);
    const picked = await w.send('POST', '/api/timeliner/events/evt_re/assign', w.admin, { batchId: B.id });
    expect(picked.status).toBe(200);
    const ps = picked.body as TimelinerStatus;
    expect(ps.events.find((e) => e.id === 'evt_re')).toMatchObject({ outcome: 'already_delivered', batch: { id: B.id } });
    expect(ps.pdfs.find((p) => p.key === 't_re')).toMatchObject({ batch: { id: B.id }, how: 'manager', sure: true, linkedBy: 'Ada Admin' });
    const v2 = await w.hook('version.uploaded', versionUploaded({ taskId: 't_re', fileName: 'JS scripts.pdf', version: 2, uploadedAt: '2026-10-13T15:00:00Z', fileId: 'f_R2' }));
    expect(v2.outcome).toBe('new_version');
    expect(await link('t_re')).toMatchObject({ batch: { id: B.id }, version: 2 });
  });

  it('links a PDF a manager picks even when nothing is approved there yet, and answers 200', async () => {
    const nw = await w.client('Quiet Co');
    const q = await w.batch(nw, 'Quiet · Nov 2', 3, { shoot: '2026-11-02', approve: 'none' });
    w.tl.brands.b_quiet = 'Somebody Else';
    w.tl.tasks.push(pdfTask('t_quiet', '2026-10-12T15:00:00Z', { id: 'f_Q1', name: 'Scripts.pdf' }, { brandId: 'b_quiet', projectId: 'p_quiet' }));
    expect((await w.hook('version.uploaded', versionUploaded({ taskId: 't_quiet', fileName: 'Scripts.pdf', version: 1, uploadedAt: '2026-10-12T15:00:00Z', projectId: 'p_quiet', brandId: 'b_quiet' }), 'evt_quiet')).outcome).toBe('unmatched');
    const r = await w.send('POST', '/api/timeliner/events/evt_quiet/assign', w.admin, { batchId: q.id });
    expect(r.status).toBe(200);
    expect((r.body as TimelinerStatus).events.find((e) => e.id === 'evt_quiet')).toMatchObject({ outcome: 'nothing_approved', batch: { id: q.id } });
    expect(await link('t_quiet')).toMatchObject({ batch: { id: q.id }, how: 'manager' });
    // once approved, the next version delivers by itself
    await w.approve(q.id, q.ids(1, 2, 3));
    expect((await w.hook('version.uploaded', versionUploaded({ taskId: 't_quiet', fileName: 'Scripts.pdf', version: 2, uploadedAt: '2026-10-14T15:00:00Z', projectId: 'p_quiet', brandId: 'b_quiet' }))).outcome).toBe('delivered');
    expect((await w.detail(q.id)).progress.delivered).toBe(3);
  });

  it('ignores a document on one of the editors’ videos', async () => {
    const r = await w.hook('version.uploaded', versionUploaded({ taskId: 't_o7', fileName: 'Shot list.pdf', version: 3, uploadedAt: '2026-10-13T15:00:00Z' }), 'evt_notes');
    expect(r.outcome).toBe('ignored');
    expect((await w.db.one<{ detail: string }>(`select detail from timeliner_events where id = 'evt_notes'`))?.detail).toBe('A document on a video’s task, not a scripts PDF');
    expect(await link('t_o7')).toBeUndefined();
  });

  it('takes a PDF uploaded to a task made empty first, and seen as a video meanwhile, for a scripts PDF', async () => {
    const ec = await w.client('Emptyco');
    w.tl.brands.b_empty = 'Emptyco';
    const b = await w.batch(ec, 'Emptyco · Oct 14', 10, { shoot: '2026-10-14' });
    w.at('2026-10-10T16:00:00Z');
    // the task is made with no file, and its message arrives before the PDF does
    const t = pdfTask('t_pdfE', '2026-10-10T15:00:00Z', { id: 'f_E1', name: 'Emptyco scripts.pdf' }, { projectId: 'p_empty', brandId: 'b_empty', title: 'Emptyco scripts', statusGroup: 'toDo' });
    w.tl.tasks.push({ ...t, media: null });
    expect((await w.hook('task.created', { taskId: 't_pdfE', projectId: 'p_empty' })).outcome).toBe('video');
    expect(await w.db.one(`select has_video from timeliner_tasks where id = 't_pdfE'`)).toEqual({ has_video: false });
    // then its PDF lands
    w.tl.tasks = w.tl.tasks.map((x) => (x.id === 't_pdfE' ? t : x));
    const r = await w.hook('version.uploaded', versionUploaded({ taskId: 't_pdfE', fileName: 'Emptyco scripts.pdf', version: 1, uploadedAt: '2026-10-10T15:30:00Z', fileId: 'f_E1', projectId: 'p_empty', brandId: 'b_empty' }), 'evt_empty');
    expect(r.outcome).toBe('delivered');
    expect((await w.detail(b.id)).progress.delivered).toBe(10);
    expect(await link('t_pdfE')).toMatchObject({ batch: { id: b.id }, how: 'date' });
    // and it's no longer one of the editors' videos
    expect(await w.db.one(`select 1 from timeliner_tasks where id = 't_pdfE'`)).toBeUndefined();
  });

  it('lets a trashed PDF go: the shoot’s videos fall back to the site’s document, and a new PDF can take its place', async () => {
    w.at('2026-10-13T16:00:00Z');
    for (const id of ['t_pdfB', 't_re']) {
      w.tl.tasks.find((x) => x.id === id)!.status = 'trashed';
      expect((await w.hook('task.trashed', { taskId: id, projectId: 'p_mine' })).outcome).toBe('video');
    }
    expect(await link('t_pdfB')).toMatchObject({ gone: true });
    expect((await w.mine(w.leo)).revisions[0]).toMatchObject({ title: 'Organic 07', script: { source: 'site', href: 'https://docs.example/JS%20%C2%B7%20Oct%2014', alt: null } });
    // a read keeps it gone
    await w.sync();
    expect(await link('t_pdfB')).toMatchObject({ gone: true });

    w.tl.tasks.push(pdfTask('t_new', '2026-10-13T15:00:00Z', { id: 'f_N1', name: 'JS shoot scripts.pdf' }));
    const r = await w.hook('version.uploaded', versionUploaded({ taskId: 't_new', fileName: 'JS shoot scripts.pdf', version: 1, uploadedAt: '2026-10-13T15:00:00Z', fileId: 'f_N1' }), 'evt_new');
    expect(r.outcome).toBe('already_delivered');
    expect(await link('t_new')).toMatchObject({ batch: { id: B.id }, how: 'date' });
    expect((await w.mine(w.leo)).revisions[0]).toMatchObject({ script: { source: 'timeliner', name: 'JS shoot scripts.pdf' } });
  });
});

describe('versions and the day a PDF was made', () => {
  it('delivers what was approved since the last version', async () => {
    const vc = await w.client('Versionco');
    w.tl.brands.b_vc = 'Versionco';
    const v = await w.batch(vc, 'Versionco · Oct 14', 30, { shoot: '2026-10-14', approve: range(1, 28) });
    w.at('2026-10-10T16:00:00Z');
    const up = (version: number) => versionUploaded({ taskId: 't_v', fileName: 'Versionco scripts.pdf', version, uploadedAt: w.now(), projectId: 'p_vc', brandId: 'b_vc' });
    w.tl.tasks.push(pdfTask('t_v', '2026-10-10T15:00:00Z', { id: 'f_V1', name: 'Versionco scripts.pdf' }, { projectId: 'p_vc', brandId: 'b_vc' }));
    expect((await w.hook('version.uploaded', up(1))).outcome).toBe('delivered');
    expect((await w.detail(v.id)).deliveries[0].scriptNumbers).toEqual(range(1, 28));
    await w.approve(v.id, v.ids(29, 30));
    w.at('2026-10-11T16:00:00Z');
    expect((await w.hook('version.uploaded', up(2))).outcome).toBe('delivered');
    const d = (await w.detail(v.id)).deliveries;
    expect(d).toHaveLength(2);
    expect(d.map((x) => x.scriptNumbers)).toContainEqual([29, 30]);
  });

  it('dates a PDF by when its task was made, even when the first message about it is version 3, weeks later', async () => {
    const old = await w.client('Oldco');
    w.tl.brands.b_old = 'Oldco';
    const b = await w.batch(old, 'Oldco · Oct 14', 3, { shoot: '2026-10-14' });
    const c = await w.batch(old, 'Oldco · Oct 28', 3, { shoot: '2026-10-28' });
    w.tl.tasks.push(pdfTask('t_old', '2026-10-09T15:00:00Z', { id: 'f_O3', name: 'Oldco scripts.pdf' }, { projectId: 'p_old', brandId: 'b_old' }));
    w.at('2026-10-30T16:00:00Z');
    const r = await w.hook('version.uploaded', versionUploaded({ taskId: 't_old', fileName: 'Oldco scripts.pdf', version: 3, uploadedAt: '2026-10-30T15:00:00Z', projectId: 'p_old', brandId: 'b_old' }), 'evt_old3');
    expect(r.outcome).toBe('delivered');
    expect(await link('t_old')).toMatchObject({ batch: { id: b.id }, version: 3, how: 'earliest', sure: false });
    expect((await w.detail(c.id)).progress.delivered).toBe(0);
    // a guess between two shoots: the managers hear which, and the other it could have been, and how to move it
    expect((await notes(w.admin))[0]).toMatchObject({ title: 'Scripts PDF matched by date · Oldco' });
    expect((await notes(w.admin))[0].body).toContain('It could also be for Oldco · Oct 28: if so, undo the delivery on Oldco · Oct 14’s page, then pick Oldco · Oct 28 for this upload in Settings → Timeliner.');

    // it was Oct 28's: Pick batch moves it once its delivery on Oct 14 is undone
    const moved = await w.send('POST', '/api/timeliner/events/evt_old3/assign', w.admin, { batchId: c.id });
    expect([moved.status, moved.body.error?.message]).toEqual([409, 'That scripts PDF is linked to Oldco · Oct 14, where it delivered scripts. Undo that delivery on Oldco · Oct 14’s page first, then pick again.']);
    const undo = (await w.detail(b.id)).scripts.map((s) => s.id);
    expect((await w.send('POST', `/api/batches/${b.id}/scripts/action`, w.admin, { action: 'undo_delivery', scriptIds: undo })).status).toBe(200);
    expect((await w.send('POST', '/api/timeliner/events/evt_old3/assign', w.writer, { batchId: c.id })).status).toBe(403);
    const picked = await w.send('POST', '/api/timeliner/events/evt_old3/assign', w.admin, { batchId: c.id });
    expect(picked.status).toBe(200);
    expect((picked.body as TimelinerStatus).events.find((e) => e.id === 'evt_old3')).toMatchObject({ result: 'delivered', batch: { id: c.id } });
    expect(await link('t_old')).toMatchObject({ batch: { id: c.id }, how: 'manager', version: 3, linkedBy: 'Ada Admin' });
    expect([(await w.detail(b.id)).progress.delivered, (await w.detail(c.id)).progress.delivered]).toEqual([0, 3]);
    // its next version follows it there, and the delivery undone on Oct 14 stays undone
    w.at('2026-10-31T16:00:00Z');
    expect((await w.hook('version.uploaded', versionUploaded({ taskId: 't_old', fileName: 'Oldco scripts.pdf', version: 4, uploadedAt: '2026-10-31T15:00:00Z', projectId: 'p_old', brandId: 'b_old' }))).outcome).toBe('new_version');
    expect([(await w.detail(b.id)).progress.delivered, (await w.detail(c.id)).progress.delivered]).toEqual([0, 3]);
    expect(await link('t_old')).toMatchObject({ batch: { id: c.id }, version: 4 });
  });

  it('asks about a shoot delivered by hand without a PDF rather than calling it delivered, and offers the next shoot to pick', async () => {
    const hc = await w.client('Handco');
    w.tl.brands.b_hand = 'Handco';
    const done = await w.batch(hc, 'Handco · Oct 14', 3, { shoot: '2026-10-14' });
    expect((await w.send('POST', `/api/batches/${done.id}/scripts/action`, w.admin, { action: 'deliver', scriptIds: done.ids(1, 2, 3) })).status).toBe(200);
    await w.stamp(done.id, { deliveredAt: '2026-10-12T15:00:00Z' });
    const next = await w.batch(hc, 'Handco · Oct 28', 3, { shoot: '2026-10-28', approve: 'none' });
    w.at('2026-10-15T16:00:00Z');
    w.tl.tasks.push(pdfTask('t_hand', '2026-10-15T15:00:00Z', { id: 'f_H1', name: 'Handco scripts.pdf' }, { projectId: 'p_hand', brandId: 'b_hand' }));
    const r = await w.hook('version.uploaded', versionUploaded({ taskId: 't_hand', fileName: 'Handco scripts.pdf', version: 1, uploadedAt: w.now(), projectId: 'p_hand', brandId: 'b_hand' }), 'evt_hand');
    expect(r.outcome).toBe('unmatched');
    const s = await status();
    expect(s.events.find((e) => e.id === 'evt_hand')).toMatchObject({ suggestedBatch: { id: done.id }, detail: expect.stringContaining('was delivered by hand, without a scripts PDF') });
    // the shoot it's really for has nothing approved yet, and can still be picked
    expect(s.openBatches.map((b) => b.id)).toContain(next.id);
    expect((await w.send('POST', '/api/timeliner/events/evt_hand/assign', w.admin, { batchId: next.id })).status).toBe(200);
    expect(await link('t_hand')).toMatchObject({ batch: { id: next.id }, how: 'manager' });
  });

  it('takes the client’s only undated batch waiting for its scripts, and asks when there are two', async () => {
    const bright = await w.client('Brightside');
    w.tl.brands.b_bright = 'Brightside';
    const spring = await w.batch(bright, 'Spring scripts', 3, {});
    const up = (taskId: string, fileName: string) => versionUploaded({ taskId, fileName, version: 1, uploadedAt: w.now(), projectId: 'p_bright', brandId: 'b_bright' });
    expect((await w.hook('version.uploaded', up('t_spring', 'Brightside one.pdf'))).outcome).toBe('delivered');
    expect(await link('t_spring')).toMatchObject({ batch: { id: spring.id }, how: 'only' });
    await w.batch(bright, 'Summer scripts', 3, {});
    await w.batch(bright, 'Autumn scripts', 3, {});
    expect((await w.hook('version.uploaded', up('t_two', 'Brightside two.pdf'), 'evt_two')).outcome).toBe('unmatched');
    expect((await event('evt_two'))?.detail).toBe('It could be Summer scripts or Autumn scripts.');
    // the first one's name again, for a batch without a date: likely that PDF uploaded again as a new task
    expect((await w.hook('version.uploaded', up('t_again', 'Brightside one.pdf'), 'evt_same')).outcome).toBe('unmatched');
    expect(await event('evt_same')).toMatchObject({ suggestedBatch: { id: spring.id } });
    expect((await event('evt_same'))?.detail).toBe('It has the same name as the scripts PDF of Spring scripts. If it’s a new version of that PDF, pick Spring scripts; if it’s another shoot’s, pick that one.');
  });
});

describe('files put straight into a project', () => {
  it('takes one for a scripts PDF only when it says so, and the same name again is a new version', async () => {
    const nw = await w.client('Northwind');
    w.tl.brands.b_nw = 'Northwind';
    w.tl.projects.p_nw = { id: 'p_nw', name: 'Northwind shoots', nodeId: 'b_nw', createdAt: '2025-01-10T15:00:00Z', subFolders: [] };
    const b = await w.batch(nw, 'Northwind · Oct 14', 3, { shoot: '2026-10-14' });
    w.at('2026-10-10T16:00:00Z');
    const file = (fileId: string, fileName: string) => ({ fileId, projectId: 'p_nw', brandId: 'b_nw', folderId: null, fileName, mimeType: 'application/pdf', size: 10, uploadedBy: 'm_ada', source: 'app', uploadedAt: w.now() });

    expect((await w.hook('file.uploaded', file('f_8', 'Contract.pdf'), 'evt_contract')).outcome).toBe('unmatched');
    expect((await event('evt_contract'))?.detail).toBe('A file in the project, not a scripts PDF?');
    expect((await w.detail(b.id)).progress.delivered).toBe(0);

    expect((await w.hook('file.uploaded', file('f_9', 'Northwind scripts.pdf'))).outcome).toBe('delivered');
    expect(await link('file:f_9')).toMatchObject({ kind: 'file', batch: { id: b.id }, version: 1 });
    expect((await w.detail(b.id)).progress.delivered).toBe(3);

    expect((await w.hook('file.uploaded', file('f_10', 'Northwind scripts (1).pdf'), 'evt_again')).outcome).toBe('new_version');
    expect(await link('file:f_9')).toMatchObject({ version: 2, fileName: 'Northwind scripts (1).pdf' });
    expect(await event('evt_again')).toMatchObject({ result: 'new_version', version: 2, batch: { id: b.id } });

    // two weeks on, the next shoot's file has the same name: once the Oct 14 shoot is past, it's matched afresh
    const c = await w.batch(nw, 'Northwind · Oct 28', 3, { shoot: '2026-10-28' });
    w.at('2026-10-24T16:00:00Z');
    expect((await w.hook('file.uploaded', file('f_20', 'Northwind scripts.pdf'), 'evt_next')).outcome).toBe('delivered');
    expect(await link('file:f_20')).toMatchObject({ batch: { id: c.id }, version: 1 });
    expect(await link('file:f_9')).toMatchObject({ batch: { id: b.id }, version: 2 });
    expect((await w.detail(c.id)).progress.delivered).toBe(3);
  });
});

describe('PDFs from before they were linked (migration 32)', () => {
  it('links a task that delivered its batch, unless it reached a second batch or its delivery was undone', async () => {
    const deliveryOf = async (batchId: number) => (await w.db.one<{ id: number }>(`select delivery_id as id from scripts where batch_id = $1 and delivery_id is not null limit 1`, [batchId]))!.id;
    const dA = await deliveryOf(A.id);
    const dL = await deliveryOf(L.id);
    // the Sep 14 Ads' delivery is undone
    const l = await w.detail(L.id);
    expect((await w.send('POST', `/api/batches/${L.id}/scripts/action`, w.admin, { action: 'undo_delivery', scriptIds: l.scripts.map((s) => s.id) })).status).toBe(200);
    const ev = (id: string, task: string, batchId: number, outcome: string, deliveryId: number | null, at: string) => w.db.query(
      `insert into timeliner_events (id, type, received_at, project_id, task_id, file_name, outcome, batch_id, delivery_id) values ($1, 'version.uploaded', $2, 'p_mine', $3, 'Old scripts.pdf', $4, $5, $6)`,
      [id, at, task, outcome, batchId, deliveryId],
    );
    await ev('old_1', 't_bf_old', A.id, 'delivered', dA, '2026-09-20T15:00:00Z');
    await ev('old_2', 't_bf_old', A.id, 'already_delivered', null, '2026-09-22T15:00:00Z');
    await ev('both_1', 't_bf_both', A.id, 'delivered', dA, '2026-09-20T15:00:00Z');
    await ev('both_2', 't_bf_both', B.id, 'already_delivered', null, '2026-10-10T15:00:00Z');
    await ev('undone_1', 't_bf_undone', L.id, 'delivered', dL, '2026-09-12T15:00:00Z');
    await ev('already_1', 't_bf_already', B.id, 'already_delivered', null, '2026-10-11T15:00:00Z');
    // a document once delivered from a video's task (notes on Organic 07): not a scripts PDF
    await ev('video_1', 't_o7', A.id, 'delivered', dA, '2026-09-21T15:00:00Z');
    await linkDeliveredPdfs(w.db);
    const rows = await w.db.query<{ key: string; batch_id: number; how: string; first_at: string; latest_at: string }>(
      `select key, batch_id, how, first_at, latest_at from timeliner_pdfs where key like 't_bf_%' or key = 't_o7' order by key`,
    );
    expect(rows.map((r) => [r.key, Number(r.batch_id), r.how, r.first_at, r.latest_at])).toEqual([
      ['t_bf_old', A.id, 'backfill', '2026-09-20T15:00:00.000Z', '2026-09-22T15:00:00.000Z'],
    ]);
  });
});
