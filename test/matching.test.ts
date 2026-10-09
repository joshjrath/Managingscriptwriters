// The rules that match what arrives from Timeliner to shoots (server/matching.ts), on their own: raw camera
// clips, script numbers, names, a scripts PDF's batch, and a video's batch. The same rules running against a
// database and a stand-in Timeliner are in test/pdf-matching.test.ts and test/video-matching.test.ts.

import { describe, expect, it } from 'vitest';
import { isRawTitle } from '../shared/workflow';
import {
  explicitNumber, isSureMatch, matchVideos, nameKey, placePdf, scriptNumber, standaloneNumber, titleKey,
  type PdfBatch, type VideoBatch, type VideoIn, type World,
} from '../server/matching';
import { pdfInReview } from '../server/timeliner';

describe('raw camera clips', () => {
  it('tells a raw clip from a titled video', () => {
    const raw = ['C0045', 'IMG_1234.MOV', 'DSC_0102', '20261006_143022', '1234', 'GX010234.mp4', 'MVI_0042', 'PXL_20261006_143022123', 'DJI_0012.MOV', 'CLIP0001', 'A001.braw', 'VID_20261006_143022.mts',
      // cinema cameras' reel and clip names (Blackmagic, RED, ARRI), a drone's with its lens letter, and a copy
      'A001_08241432_C001.braw', 'A001_C002_0101AB.R3D', 'A001C003_221010_R2VK.mxf', 'DJI_20261006143022_0001_D.MP4', 'IMG_1234 (1).MOV'];
    const titled = ['Organic 05', '05 – Morning routine', 'Ad 3', 'Ad3', 'Hook test #12', 'Organic05', '05', 'Morning routine.mp4', '9-5', 'Untitled video', '', 'C0045 take two',
      'Ad003', 'EP101', 'A100_final', 'Organic 05 (1)'];
    expect(raw.filter((t) => !isRawTitle(t))).toEqual([]);
    expect(titled.filter((t) => isRawTitle(t))).toEqual([]);
  });
});

describe('script numbers', () => {
  it('takes the number a title says outright, else the one standing alone (N3, N4)', () => {
    const n = (t: string) => scriptNumber(t, { toEdit: false });
    expect(n('Oct 6 – Organic 07 v2')).toBe(7);
    expect(n('Hook test #12')).toBe(12);
    expect(n('Script 12: the hook')).toBe(12);
    expect(n('No. 4 – Morning routine')).toBe(4);
    expect(n('05 – Morning routine')).toBe(5);
    expect(n('Why I quit my 9-5')).toBeNull();
    expect(n('3x faster mornings')).toBeNull();
    expect(n('10k steps')).toBeNull();
    expect(n('14 Oct shoot')).toBeNull();
    expect(n('Organic (1)')).toBeNull();
    expect(n('Organic version 3')).toBeNull();
    // whether the batch has that script is checked when it's matched (N5)
    expect(n('Organic 41')).toBe(41);
    expect([explicitNumber('Organic 05'), standaloneNumber('Organic 05')]).toEqual([null, 5]);
  });

  it('never takes one from a raw clip, and from a video still to be edited only when said outright', () => {
    expect(scriptNumber('C0005', { toEdit: false })).toBeNull();
    expect(scriptNumber('1234', { toEdit: false })).toBeNull();
    expect(scriptNumber('C0005', { toEdit: true })).toBeNull();
    expect(scriptNumber('Organic 05', { toEdit: true })).toBeNull();
    expect(scriptNumber('Organic #5', { toEdit: true })).toBe(5);
    expect(scriptNumber('Script 5 – hook', { toEdit: true })).toBe(5);
  });
});

describe('names', () => {
  it('knows a re-upload of the same document by its name', () => {
    expect(['JS scripts.pdf', 'JS scripts FINAL.pdf', 'JS scripts (1).pdf', 'JS scripts v2.pdf', 'js  scripts - copy.pdf'].map(nameKey)).toEqual(Array(5).fill('js scripts'));
    expect(nameKey('JS scripts – Oct 28.pdf')).toBe('js scripts oct 28');
  });
  it('compares titles without caring about leading zeros or spaces', () => {
    expect(titleKey('Organic 05')).toBe(titleKey('organic  5'));
    expect(titleKey('Organic 05')).not.toBe(titleKey('Organic 06'));
  });
});

// ── a scripts PDF's batch ────────────────────────────────────────────────

const pb = (id: number, title: string, shoot: string | null, o: Partial<PdfBatch> = {}): PdfBatch => ({
  id, title, clientName: 'Joshua Shalimar', shootStart: shoot, shootEnd: null, finalDue: null, draftDue: null, archived: false,
  finished: 0, waiting: 0, allDelivered: false, fromTimeliner: false, lastDelivered: null, pdfs: [], ...o,
});
const approved = { finished: 30, waiting: 30 };
const A = pb(1, 'JS · Sep 28', '2026-09-28', { finished: 30, allDelivered: true, fromTimeliner: true, lastDelivered: '2026-09-27', pdfs: [{ fileName: 'JS scripts Sep.pdf', nameKey: 'js scripts sep' }] });
const B = pb(2, 'JS · Oct 14', '2026-10-14', approved);
const C = pb(3, 'JS · Oct 28', '2026-10-28');
const L = pb(4, 'Ads · Sep 14', '2026-09-14', { finished: 15, allDelivered: true, lastDelivered: '2026-09-12' });
const place = (u: string, batches: PdfBatch[], fileName = 'JS scripts.pdf') => placePdf({ u, text: `Scripts ${fileName} My Videos`, nameKey: nameKey(fileName), batches });

describe('which batch a scripts PDF is for, the first time', () => {
  it('goes to the shoot waiting for its scripts, not the one delivered before (flaw a)', () => {
    expect(place('2026-10-10', [A, B, C, L])).toMatchObject({ batchId: 2, how: 'date', sure: true });
  });

  it('dates a PDF by when it was made: made Oct 9 it’s for Oct 14, even when its version arrives on Oct 30', () => {
    const C2 = { ...C, ...approved };
    expect(place('2026-10-09', [A, B, C2, L])).toMatchObject({ batchId: 2, how: 'earliest', sure: false, runnerUp: { id: 3 } });
    expect(place('2026-10-30', [A, B, C2, L])).toMatchObject({ batchId: 3 });
  });

  it('goes by a date in its name before anything else', () => {
    expect(place('2026-10-02', [A, B, { ...C, finished: 5, waiting: 5 }, L], 'JS scripts – Oct 28.pdf')).toMatchObject({ batchId: 3, how: 'name', sure: true });
  });

  it('asks when its name points at a batch that already has its PDF, or matches the PDF of a shoot still ahead', () => {
    const Bpdf = { ...B, waiting: 0, allDelivered: true, lastDelivered: '2026-10-10', pdfs: [{ fileName: 'JS scripts.pdf', nameKey: 'js scripts' }] };
    const named = place('2026-10-12', [A, Bpdf, C, L], 'JS scripts Oct 14 v2.pdf');
    expect(named).toMatchObject({ batchId: null, suggested: 2 });
    expect(named.why).toMatch(/already has its scripts PDF “JS scripts.pdf”/);
    expect(place('2026-10-12', [A, Bpdf, { ...C, ...approved }, L])).toMatchObject({ batchId: null, suggested: 2 });
  });

  it('asks when two waiting shoots are within three days, and guesses the first (and says so) when they’re further apart', () => {
    const C2 = pb(5, 'JS · Oct 16', '2026-10-16', approved);
    const both = place('2026-10-08', [A, B, C2, L]);
    expect(both).toMatchObject({ batchId: null, suggested: 2 });
    expect(both.why).toMatch(/JS · Oct 14 \(Oct 14\) or JS · Oct 16 \(Oct 16\)/);
    expect(place('2026-10-08', [A, B, { ...C, ...approved }, L])).toMatchObject({ batchId: 2, how: 'earliest', sure: false, runnerUp: { id: 3 } });
  });

  it('takes a late upload for a shoot that just happened and is still waiting, but not one delivered by hand', () => {
    expect(place('2026-10-18', [A, B, C, L])).toMatchObject({ batchId: 2, how: 'late', sure: false });
    const byHand = { ...B, waiting: 0, allDelivered: true, lastDelivered: '2026-10-13' };
    expect(place('2026-10-18', [A, byHand, C, L])).toMatchObject({ batchId: null });
  });

  it('takes the client’s only undated batch waiting for its scripts, and asks when there are two', () => {
    const one = pb(7, 'Spring scripts', null, approved);
    expect(place('2026-10-08', [one])).toMatchObject({ batchId: 7, how: 'only', sure: true });
    const two = place('2026-10-08', [one, pb(8, 'Summer scripts', null, approved)]);
    expect(two).toMatchObject({ batchId: null });
    expect(two.why).toBe('It could be Spring scripts or Summer scripts.');
  });

  it('never takes a shoot delivered by hand, without a PDF, for a new PDF by date: the next shoot, else a manager is asked', () => {
    // Oct 14 delivered by hand on Oct 12, before its shoot; the PDF made Oct 15 is the Oct 28 shoot's
    const hand = { ...B, waiting: 0, allDelivered: true, lastDelivered: '2026-10-12' };
    const waiting = place('2026-10-15', [A, hand, { ...C, finished: 2, waiting: 2 }, L]);
    expect(waiting).toMatchObject({ batchId: 3, how: 'date', sure: true });
    // nothing approved for Oct 28 yet: not matched, rather than "already delivered" on Oct 14
    const asked = place('2026-10-15', [A, hand, C, L]);
    expect(asked).toMatchObject({ batchId: null, suggested: 2 });
    expect(asked.why).toBe('JS · Oct 14 (Oct 14) was delivered by hand, without a scripts PDF. If this is its PDF, pick JS · Oct 14; if it’s another shoot’s, pick that one.');
    // delivered by its own scripts PDF (trashed since): a new PDF for it is that one again
    expect(place('2026-10-13', [A, { ...hand, fromTimeliner: true }, C, L])).toMatchObject({ batchId: 2, how: 'date' });
  });

  it('never goes to an archived batch or one delivered in full long ago', () => {
    expect(place('2026-10-10', [{ ...B, archived: true }])).toMatchObject({ batchId: null });
    expect(place('2026-10-10', [pb(9, 'JS · Oct 9', '2026-10-09', { finished: 30, allDelivered: true, lastDelivered: '2026-09-20' })])).toMatchObject({ batchId: null });
  });
});

// ── a video's batch ──────────────────────────────────────────────────────

const range = (n: number) => new Set(Array.from({ length: n }, (_, i) => i + 1));
const vb = (id: number, title: string, d: string | null, size: number, o: Partial<VideoBatch> = {}): VideoBatch => ({
  id, title, clientId: 1, clientName: 'Joshua Shalimar', d, e: d, dFrom: d ? 'shoot' : null, numbers: range(size), finished: size, legacyProject: null, ...o,
});
const vA = vb(1, 'JS · Sep 28', '2026-09-28', 30);
const vB = vb(2, 'JS · Oct 14', '2026-10-14', 30);
const vC = vb(3, 'JS · Oct 28', '2026-10-28', 40);
const vL = vb(4, 'Ads · Sep 14', '2026-09-14', 15);
const world = (batches: VideoBatch[], o: Partial<World> = {}): World => ({
  tz: 'America/New_York',
  clients: [{ id: 1, name: 'Joshua Shalimar' }],
  batches: new Map(batches.map((b) => [b.id, b])),
  pdfs: [],
  names: new Map([
    ['b_js', { name: 'Joshua Shalimar', createdAt: null }],
    ['p_mine', { name: 'My Videos', createdAt: '2025-01-10T15:00:00Z' }],
    ['sf_org', { name: 'Organic', createdAt: '2025-01-10T15:00:00Z' }],
    ['sf_ads', { name: 'Ads', createdAt: '2025-01-10T15:00:00Z' }],
  ]),
  pins: new Map(),
  editorClips: [],
  memberNames: new Map([['m_leo', 'Leo Martins']]),
  ...o,
});
const vid = (id: string, title: string, created: string, o: Partial<VideoIn> = {}): VideoIn => ({
  id, title, state: 'in_review', toDo: o.state === 'to_edit', createdAt: `${created}T15:00:00.000Z`, projectId: 'p_mine', subFolderId: 'sf_org', brandId: 'b_js',
  deadline: null, assignees: ['m_leo'], parentId: null, leftPlate: false, prev: { how: null, batchId: null, note: null }, ...o,
});
const match = (videos: VideoIn[], w: World) => matchVideos(videos, w);

describe('which batch a video is from', () => {
  it('takes a brand that’s no site client, and a client with no scripts here, for normal work, not a gap', () => {
    const names = world([]).names;
    names.set('b_zen', { name: 'Zen Yoga', createdAt: null });
    names.set('b_bright', { name: 'Brightside', createdAt: null });
    // Brightside has a batch, but no scripts in it yet
    const empty = vb(9, 'Brightside · Nov 2', '2026-11-02', 0, { clientId: 2, clientName: 'Brightside', finished: 0 });
    const w = world([vA, vB, empty], { clients: [{ id: 1, name: 'Joshua Shalimar' }, { id: 2, name: 'Brightside' }], names });
    const out = match([
      vid('zen', 'Zen 01', '2026-10-16', { brandId: 'b_zen', projectId: null, subFolderId: null }),
      vid('bright', 'Bright 01', '2026-10-16', { brandId: 'b_bright', projectId: null, subFolderId: null }),
      // Joshua Shalimar has scripts: a video no shoot fits is still not matched
      vid('late', 'Organic 05', '2027-03-01'),
    ], w);
    expect(out.get('zen')).toMatchObject({ clientId: null, batchId: null, how: 'no_client', note: 'No client on the site is named like “Zen Yoga”.' });
    expect(out.get('bright')).toMatchObject({ clientId: 2, batchId: null, how: 'no_scripts', note: 'Brightside has no scripts on the site.' });
    expect(out.get('late')).toMatchObject({ clientId: 1, batchId: null, how: null });
    // two clients that fit equally: that's not "no client", it waits for a manager
    const tie = world([vA], { clients: [{ id: 1, name: 'Joshua Shalimar' }, { id: 3, name: 'Joshua Shalimar' }] });
    expect(match([vid('t', 'Organic 05', '2026-10-16')], tie).get('t')).toMatchObject({ clientId: null, how: null });
  });

  it('goes by the date it was made, never by its folder’s word across shoots (flaw b)', () => {
    const m = match([vid('t_ad3', 'Ad 03', '2026-10-16', { subFolderId: 'sf_ads' })], world([vA, vB, vC, vL])).get('t_ad3')!;
    expect(m).toMatchObject({ batchId: 2, how: 'date', number: 3, note: 'Made Oct 16, 2 days after the Oct 14 shoot' });
  });

  it('lets the folder’s word decide only between batches of the same shoot, and asks when nothing does', () => {
    const org = vb(5, 'Organic · Oct 6', '2026-10-06', 8);
    const ads = vb(6, 'Ads · Oct 6', '2026-10-06', 4);
    const w = world([org, ads]);
    const out = match([vid('o', 'Organic 05', '2026-10-07'), vid('a', 'Ad 03', '2026-10-07', { subFolderId: 'sf_ads' }), vid('x', 'Teaser', '2026-10-07', { subFolderId: null })], w);
    expect([out.get('o')!.batchId, out.get('a')!.batchId, out.get('x')!.batchId]).toEqual([5, 6, null]);
    expect(out.get('x')!.note).toBe('Organic · Oct 6 and Ads · Oct 6 are from the same shoot, and nothing in its folder tells them apart.');
  });

  it('puts a video made ahead with the next shoot when the shoot before already has one of that title, and keeps it there', () => {
    const w = world([vA, vB, vC, vL]);
    const t1 = vid('t1', 'Organic 05', '2026-09-30');
    const t2 = vid('t2', 'Organic 05', '2026-10-10');
    const ads = vid('t3', 'Organic 05', '2026-10-10', { subFolderId: 'sf_ads' });
    const out = match([t2, t1, ads], w);
    expect([out.get('t1')!.batchId, out.get('t2')!.batchId, out.get('t2')!.how, out.get('t3')!.batchId]).toEqual([1, 2, 'next', 1]);
    // the earlier one drops out of the copy: the one made ahead stays where it was matched
    const later = match([{ ...t2, prev: { how: 'next', batchId: 2, note: out.get('t2')!.note } }], w).get('t2')!;
    expect(later).toMatchObject({ batchId: 2, how: 'next', kept: true });
  });

  it('puts a video whose number is past the shoot before’s scripts with the next shoot, unless it’s due before that shoot', () => {
    const w = world([vA, vB, vC, vL]);
    expect(match([vid('t35', 'Organic 35', '2026-10-24')], w).get('t35')).toMatchObject({ batchId: 3, how: 'next', number: 35 });
    expect(match([vid('t35', 'Organic 35', '2026-10-24', { deadline: '2026-10-27' })], w).get('t35')).toMatchObject({ batchId: 2, how: 'date', number: null });
  });

  it('doesn’t match a video made long after any shoot, and a pin beats every rule', () => {
    const v = vid('late', 'Organic 05', '2027-03-01');
    expect(match([v], world([vA, vB, vC, vL])).get('late')).toMatchObject({ batchId: null, how: null, note: 'Made Mar 1: no shoot in the 90 days before or 7 after.' });
    const pinned = world([vA, vB, vC, vL], { pins: new Map([['late', { batchId: 3, number: null, byName: 'Ada Admin' }]]) });
    expect(match([v], pinned).get('late')).toMatchObject({ batchId: 3, how: 'pinned', number: 5, note: 'Pinned to JS · Oct 28 by Ada Admin' });
    const nowhere = world([vA, vB], { pins: new Map([['t', { batchId: null, number: null, byName: null }]]) });
    expect(match([vid('t', 'Organic 05', '2026-10-16')], nowhere).get('t')).toMatchObject({ batchId: null, how: 'pinned', clientId: 1 });
  });

  it('keeps the batch of a video that has been in review, whatever changes on the site', () => {
    const v = vid('t7', 'Organic 07', '2026-10-16', { leftPlate: true, prev: { how: 'date', batchId: 2, note: 'Made Oct 16, 2 days after the Oct 14 shoot' } });
    const oct15 = vb(8, 'JS · Oct 15', '2026-10-15', 30);
    const out = match([v, vid('t8', 'Organic 08', '2026-10-16')], world([vA, vB, vC, oct15]));
    expect(out.get('t7')).toMatchObject({ batchId: 2, how: 'date', kept: true, number: 7 });
    expect(out.get('t8')).toMatchObject({ batchId: 8, kept: false });
  });

  it('puts a video in a folder made for one shoot’s scripts with that shoot, and never My Videos', () => {
    const nov = vb(10, 'Acme · Nov 3', '2026-11-03', 10, { clientId: 2, clientName: 'Acme Outdoor' });
    const dec = vb(11, 'Acme · Dec 1', '2026-12-01', 10, { clientId: 2, clientName: 'Acme Outdoor' });
    const names = world([]).names;
    names.set('p_fall', { name: 'Acme Fall', createdAt: '2026-11-01T15:00:00Z' });
    names.set('b_acme', { name: 'Acme Outdoor', createdAt: null });
    const w = world([vA, vB, nov, dec], {
      clients: [{ id: 1, name: 'Joshua Shalimar' }, { id: 2, name: 'Acme Outdoor' }], names,
      pdfs: [{ batchId: 10, projectId: 'p_fall', subFolderId: null, firstAt: '2026-11-05T15:00:00Z' }, { batchId: 2, projectId: 'p_mine', subFolderId: 'sf_org', firstAt: '2026-10-10T15:00:00Z' }],
    });
    const out = match([
      vid('acme', 'Fall 04', '2026-12-03', { projectId: 'p_fall', subFolderId: null, brandId: 'b_acme' }),
      vid('mine', 'Organic 04', '2026-12-03'),
    ], w);
    expect(out.get('acme')).toMatchObject({ batchId: 10, how: 'place', note: 'Its folder “Acme Fall” was made for the scripts of the Nov 3 shoot' });
    // a project made long ago, holding many shoots' PDFs: the date decides
    expect(out.get('mine')).toMatchObject({ batchId: 2, how: 'date' });
  });

  it('flags two videos with the same title in one folder on the same batch', () => {
    const out = match([vid('a', 'Organic 05', '2026-10-15'), vid('b', 'Organic 05', '2026-10-16')], world([vA, vB, vC]));
    expect([out.get('a')!.batchId, out.get('a')!.check, out.get('b')!.batchId, out.get('b')!.check]).toEqual([2, true, 2, true]);
  });

  it('gives an Ad no number when a non-Ad video of the same batch uses it', () => {
    const titles = ['Organic 01', 'Organic 02', 'Organic 03', 'Organic 04', 'Organic 05'];
    const out = match([
      ...titles.map((t, i) => vid(`o${i}`, t, '2026-10-16')),
      vid('ad1', 'Ad 01', '2026-10-16', { subFolderId: 'sf_ads' }), vid('ad2', 'Ad 02', '2026-10-16', { subFolderId: 'sf_ads' }),
    ], world([vA, vB, vC]));
    expect([out.get('o0')!.number, out.get('ad1')!.number, out.get('ad1')!.batchId, out.get('ad2')!.number]).toEqual([1, null, 2, null]);
  });

  it('gives a variant its parent’s batch and number', () => {
    const out = match([vid('kid', 'Organic 07 – 9:16', '2026-10-20', { parentId: 'mom' }), vid('mom', 'Organic 07', '2026-10-16')], world([vA, vB, vC]));
    expect(out.get('kid')).toMatchObject({ batchId: 2, number: 7, how: 'parent', note: 'A version of “Organic 07”' });
  });

  it('takes the client’s only undated batch when none has a date', () => {
    const spring = vb(12, 'Spring scripts', null, 3);
    expect(match([vid('s', 'Video 01', '2026-10-07')], world([spring])).get('s')).toMatchObject({ batchId: 12, how: 'undated', number: 1 });
  });
});

describe('raw clips and the titled videos made from them', () => {
  it('puts a raw clip with the shoot that had just happened, with no number, never the next one', () => {
    const out = match([
      vid('c45', 'C0045', '2026-10-15', { state: 'to_edit' }),
      vid('c05', 'C0005', '2026-10-15', { state: 'to_edit' }),
      // made 4 days before the Oct 14 shoot: a titled video could be made ahead, a raw clip can't
      vid('c09', 'IMG_0009.MOV', '2026-10-10', { state: 'to_edit' }),
    ], world([vA, vB, vC]));
    expect(out.get('c45')).toMatchObject({ batchId: 2, how: 'date', number: null });
    expect(out.get('c05')).toMatchObject({ batchId: 2, number: null });
    expect(out.get('c09')).toMatchObject({ batchId: 1, how: 'date' });
  });

  it('puts a new titled video with the shoot whose raw clips its editor has been cutting, even after the clips are trashed', () => {
    const oct20 = vb(13, 'JS · Oct 20', '2026-10-20', 30);
    const titled = vid('t05', '05 – Morning routine', '2026-10-26');
    // the clips are still in the copy
    const clips = Array.from({ length: 3 }, (_, i) => vid(`c${i}`, `C000${i + 1}`, '2026-10-15', { state: 'to_edit' }));
    const out = match([...clips, titled], world([vA, vB, oct20, vC]));
    expect(out.get('t05')).toMatchObject({ batchId: 2, how: 'editor', number: 5, note: 'Leo Martins has been cutting raw clips from the Oct 14 shoot' });
    // trashed, but remembered
    const remembered = world([vA, vB, oct20, vC], { editorClips: [{ taskId: 'c9', member: 'm_leo', batchId: 2, at: '2026-10-15T15:00:00.000Z' }] });
    expect(match([titled], remembered).get('t05')).toMatchObject({ batchId: 2, how: 'editor' });
    // someone else's raw clips don't count: the date decides
    expect(match([{ ...titled, assignees: ['m_maya'] }], remembered).get('t05')).toMatchObject({ batchId: 13, how: 'date' });
  });

  it('when an editor’s raw clips span two shoots, prefers the one the number fits, then the older one still being cut', () => {
    const small = vb(14, 'JS · Oct 20', '2026-10-20', 4);
    const w = world([vA, vB, small, vC], {
      editorClips: [{ taskId: 'x1', member: 'm_leo', batchId: 2, at: '2026-10-15T15:00:00.000Z' }, { taskId: 'x2', member: 'm_leo', batchId: 14, at: '2026-10-21T15:00:00.000Z' }],
    });
    // 12 is past Oct 20's four scripts
    expect(match([vid('t12', '12 – Coffee', '2026-10-26')], w).get('t12')).toMatchObject({ batchId: 2, how: 'editor' });
    // 3 fits both: the older shoot whose raw clips are still on Leo's plate
    const clip = vid('c1', 'C0101', '2026-10-15', { state: 'to_edit' });
    expect(match([clip, vid('t3', '03 – Tea', '2026-10-26')], w).get('t3')).toMatchObject({ batchId: 2, how: 'editor' });
    // and with none left to cut, the one cut most recently
    expect(match([vid('t3', '03 – Tea', '2026-10-26')], w).get('t3')).toMatchObject({ batchId: 14, how: 'editor' });
  });

  it('forgets the shoot a raw clip was matched to before when it’s matched to another now (a shoot date fixed, a pin)', () => {
    const oct10 = vb(15, 'JS · Oct 10', '2026-10-10', 30);
    // remembered on Oct 10 (the Oct 14 shoot had been entered as Oct 24); the clip, still here, now matches Oct 14
    const w = world([vA, oct10, vB, vC], { editorClips: [{ taskId: 'c1', member: 'm_leo', batchId: 15, at: '2026-10-15T15:00:00.000Z' }] });
    const out = match([vid('c1', 'C0001', '2026-10-15', { state: 'to_edit' }), vid('t05', '05 – Morning routine', '2026-10-22')], w);
    expect(out.get('c1')).toMatchObject({ batchId: 2 });
    expect(out.get('t05')).toMatchObject({ batchId: 2, how: 'editor' });
    // a clip pinned to no shoot isn't evidence any more
    const pinned = world([vA, oct10, vB, vC], { editorClips: [{ taskId: 'c1', member: 'm_leo', batchId: 15, at: '2026-10-15T15:00:00.000Z' }], pins: new Map([['c1', { batchId: null, number: null, byName: null }]]) });
    expect(match([vid('c1', 'C0001', '2026-10-15', { state: 'to_edit' }), vid('t05', '05 – Morning routine', '2026-10-22')], pinned).get('t05')).toMatchObject({ batchId: 2, how: 'date' });
  });

  it('lets the folder’s word decide between batches of the editor’s shoot', () => {
    const org = vb(5, 'Organic · Oct 6', '2026-10-06', 8);
    const ads = vb(6, 'Ads · Oct 6', '2026-10-06', 4);
    // Leo's raw clips sit in My Videos › Organic, so they went to the Organic batch
    const w = world([org, ads], { editorClips: [{ taskId: 'c1', member: 'm_leo', batchId: 5, at: '2026-10-07T15:00:00.000Z' }] });
    const out = match([vid('ad', 'Ad 03', '2026-10-09', { subFolderId: 'sf_ads' }), vid('o', 'Organic 04', '2026-10-09'), vid('x', 'Teaser', '2026-10-09', { subFolderId: null })], w);
    expect(out.get('ad')).toMatchObject({ batchId: 6, how: 'editor' });
    expect(out.get('o')).toMatchObject({ batchId: 5, how: 'editor' });
    // nothing tells them apart: the batch the raw clips went to
    expect(out.get('x')).toMatchObject({ batchId: 5, how: 'editor' });
  });

  it('numbers a titled video In progress, and one To be edited only when its title says it outright', () => {
    const w = world([vA, vB, vC]);
    expect(match([vid('p', 'Organic 05', '2026-10-16', { state: 'to_edit', toDo: false })], w).get('p')).toMatchObject({ batchId: 2, number: 5 });
    expect(match([vid('t', 'Organic 05', '2026-10-16', { state: 'to_edit' })], w).get('t')).toMatchObject({ batchId: 2, number: null });
  });

  it('is sure of a raw clip by its date and a titled video by its editor’s raw clips, not of a titled video by its date alone', () => {
    expect([isSureMatch('date', true), isSureMatch('editor', false), isSureMatch('pinned', false)]).toEqual([true, true, true]);
    expect([isSureMatch('date', false), isSureMatch('next', false), isSureMatch('undated', false), isSureMatch(null, true)]).toEqual([false, false, false, false]);
  });
});

describe('a scripts PDF being reviewed', () => {
  it('is in review at Needs review or Revisions requested, not at the step it was made at', () => {
    expect(['supervisorApproval', 'inRevision'].map(pdfInReview)).toEqual([true, true]);
    expect(['toDo', 'inProgress', 'approved', 'posted', 'clientApproval', null].map(pdfInReview)).toEqual([false, false, false, false, false, false]);
  });
});
