import { describe, expect, it } from 'vitest';
import {
  allowedFrom, canSendDocument, checkAction, compressRanges, deriveStage, documentState, evenSplit, isAdmin, isManager, isNewWork, isNotMatched, milestone, newlyAdded, parseRanges, progressLabel,
  splitAssignments, summarize, TIMELINER_APP, timelinerVideoUrl, writerHistory, type ScriptStatus,
} from '../shared/workflow';
import { makeClock } from '../shared/dates';
import { parseEntry } from '../shared/parse';

const scripts = (spec: [ScriptStatus, number][], assignee: number | null = 1) =>
  spec.flatMap(([status, n]) => Array.from({ length: n }, () => ({ status, assigneeId: assignee })));

describe('progress', () => {
  it('shows 20 of 45 draft-ready as “20 / 45 drafts sent · 44%”', () => {
    const p = summarize(scripts([['ready_for_review', 12], ['approved', 8], ['not_started', 25]]));
    expect(p.draftReady).toBe(20);
    expect(p.pctDraft).toBe(44);
    expect(progressLabel(p.draftReady, p.total)).toBe('20 / 45 drafts sent · 44%');
  });

  it('counts approved and delivered cumulatively and separately', () => {
    const p = summarize(scripts([['approved', 5], ['delivered', 3], ['ready_for_review', 2], ['revisions_needed', 2], ['in_progress', 3]]));
    expect(p).toMatchObject({ draftReady: 10, approved: 8, delivered: 3, awaitingDelivery: 5, revisions: 2, total: 15 });
  });

  it('never treats revisions as draft-ready', () => {
    const p = summarize(scripts([['revisions_needed', 4], ['ready_for_review', 6]]));
    expect(p.draftReady).toBe(6);
    expect(deriveStage(p)).toBe('writing');
  });

  it('only rounds to 100% when every script is there', () => {
    expect(summarize(scripts([['delivered', 44], ['approved', 1]])).pctDelivered).toBe(97);
  });

  it('keeps a partially delivered batch visibly incomplete', () => {
    const p = summarize(scripts([['delivered', 40], ['approved', 5]]));
    expect(deriveStage(p)).toBe('approved');
    const clock = makeClock('America/New_York', '23:59', new Date('2026-10-01T12:00:00Z'));
    const m = milestone('final', '2026-10-09', p, clock);
    expect(m.complete).toBe(false);
    expect(m.remaining).toBe(5);
  });

  it('reaching the draft target does not mean approved or delivered', () => {
    const p = summarize(scripts([['ready_for_review', 45]]));
    expect(p.draftReady).toBe(45);
    expect(p.approved).toBe(0);
    expect(p.delivered).toBe(0);
    expect(deriveStage(p)).toBe('in_review');
  });
});

describe('workflow permissions', () => {
  const writer = { id: 7, role: 'writer' as const };
  const manager = { id: 1, role: 'manager' as const };
  it('writers update only their own scripts', () => {
    expect(checkAction('submit', { status: 'in_progress', assigneeId: 7 }, writer)).toBeNull();
    expect(checkAction('submit', { status: 'in_progress', assigneeId: 8 }, writer)).toMatch(/assigned to you/);
    expect(checkAction('submit', { status: 'in_progress', assigneeId: null }, writer)).toMatch(/assigned to you/);
  });
  it('only managers approve or request revisions', () => {
    expect(checkAction('approve', { status: 'ready_for_review', assigneeId: 7 }, writer)).toMatch(/Only managers/);
    expect(checkAction('approve', { status: 'ready_for_review', assigneeId: 7 }, manager)).toBeNull();
    expect(checkAction('request_revisions', { status: 'ready_for_review', assigneeId: 7 }, writer)).toMatch(/Only managers/);
  });
  it('delivery requires approval — review can’t be skipped', () => {
    expect(checkAction('deliver', { status: 'ready_for_review', assigneeId: 7 }, writer)).toMatch(/Not possible/);
    expect(checkAction('deliver', { status: 'in_progress', assigneeId: 7 }, manager)).toMatch(/Not possible/);
    expect(checkAction('deliver', { status: 'approved', assigneeId: 7 }, writer)).toBeNull();
  });
  it('one rule for what can be sent, sent back, and where a document stands', () => {
    expect(['not_started', 'in_progress', 'ready_for_review', 'revisions_needed', 'approved', 'delivered'].map((s) => canSendDocument(s as ScriptStatus))).toEqual([true, true, true, true, false, false]);
    expect(allowedFrom('request_revisions', 'approved')).toBe(true);
    expect(allowedFrom('request_revisions', 'delivered')).toBe(false);
    expect(documentState(['ready_for_review', 'revisions_needed'])).toBe('revisions'); // the writer has something to do
    expect(documentState(['ready_for_review', 'approved'])).toBe('in_review');
    expect(documentState(['approved', 'delivered'])).toBe('approved');
    expect(documentState(['delivered', 'delivered'])).toBe('delivered');
    expect(documentState(['in_progress', 'approved'])).toBe('in_progress');
    expect(documentState([])).toBe('in_progress');
  });
  it('admins (stored as owner) can do everything managers can; only they get admin-only features', () => {
    expect([isManager('owner'), isManager('manager'), isManager('writer')]).toEqual([true, true, false]);
    expect([isAdmin('owner'), isAdmin('manager'), isAdmin('writer')]).toEqual([true, false, false]);
  });
});

describe('assignments', () => {
  it('splits 45 scripts as 1–20 and 21–45 with one owner each', () => {
    const owners = splitAssignments(45, [{ writerId: 1, count: 20 }, { writerId: 2, count: 25 }]);
    expect(owners).toHaveLength(45);
    expect(compressRanges(owners.flatMap((o, i) => (o === 1 ? [i + 1] : [])))).toBe('1–20');
    expect(compressRanges(owners.flatMap((o, i) => (o === 2 ? [i + 1] : [])))).toBe('21–45');
  });
  it('leaves the rest unassigned and refuses to over-assign', () => {
    expect(splitAssignments(5, [{ writerId: 1, count: 3 }])).toEqual([1, 1, 1, null, null]);
    expect(() => splitAssignments(5, [{ writerId: 1, count: 6 }])).toThrow();
  });
  it('splits evenly and parses ranges', () => {
    expect(evenSplit(45, 2)).toEqual([23, 22]);
    expect(parseRanges('1-3, 5, 8–10', 45)).toEqual([1, 2, 3, 5, 8, 9, 10]);
    expect(parseRanges('40-50', 45)).toBeNull();
    expect(parseRanges('1 - 3, 5', 45)).toEqual([1, 2, 3, 5]);
    expect(parseRanges('1 – 3', 45)).toEqual([1, 2, 3]);
    expect(compressRanges([1, 2, 3, 5, 7, 8])).toBe('1–3, 5, 7–8');
  });
});

describe('quick entry parser', () => {
  const ctx = {
    today: '2026-09-28',
    clients: [{ id: 1, name: 'Acme Outdoor Co.', status: 'active' as const }, { id: 2, name: 'Northwind Coffee', status: 'active' as const }],
    users: [{ id: 1, name: 'Josh Rath', active: true }, { id: 2, name: 'Sarah Chen', active: true }, { id: 3, name: 'Marcus Webb', active: true }],
  };
  it('turns the example sentence into a structured preview', () => {
    const r = parseEntry('Acme has a shoot October 12–13, 2026, needs 45 scripts, and Sarah is writing them.', ctx);
    expect(r.client).toMatchObject({ kind: 'matched', id: 1 });
    expect(r.dates).toMatchObject({ kind: 'ok', start: '2026-10-12', end: '2026-10-13' });
    expect(r.count).toBe(45);
    expect(r.writers).toEqual([{ kind: 'matched', text: 'Sarah', id: 2, name: 'Sarah Chen' }]);
    expect(r.questions).toEqual([]);
  });
  it('asks for the year instead of guessing', () => {
    const r = parseEntry('Acme shoot Oct 13, 10 scripts', ctx);
    expect(r.dates.kind).toBe('needs_year');
    expect(r.questions.join(' ')).toMatch(/Which year/);
  });
  it('never silently creates a client, and asks about ambiguous names', () => {
    const r = parseEntry('Globex has a shoot 2026-10-20 with 8 scripts', ctx);
    expect(r.client).toEqual({ kind: 'new', name: 'Globex' });
    expect(r.questions[0]).toMatch(/no client called “Globex”/);
    const two = parseEntry('Sarah writes 5 scripts for Acme on October 20, 2026', { ...ctx, users: [...ctx.users, { id: 9, name: 'Sarah Diaz', active: true }] });
    expect(two.writers[0].kind).toBe('ambiguous');
  });
  it('asks when a numeric date could be read two ways, and only then', () => {
    expect(parseEntry('Acme 10/12/2026 5 scripts', ctx).dates.kind).toBe('ambiguous');
    // there's no 25th month, so this can only be Dec 25
    expect(parseEntry('Acme 25/12/2026 5 scripts', ctx).dates).toMatchObject({ kind: 'ok', start: '2026-12-25' });
    expect(parseEntry('Acme 12/31/2026 5 scripts', ctx).dates).toMatchObject({ kind: 'ok', start: '2026-12-31' });
    expect(parseEntry('Acme 31/31/2026 5 scripts', ctx).dates.kind).toBe('invalid');
  });
  it('matches names with accents and hyphens, written either way', () => {
    const team = { ...ctx, users: [...ctx.users, { id: 4, name: 'José Álvarez', active: true }, { id: 5, name: 'Anne-Marie Roy', active: true }, { id: 6, name: 'Zoe Park', active: true }] };
    expect(parseEntry('Acme 2026-10-20, 10 scripts, and José is writing them.', team).writers).toEqual([{ kind: 'matched', text: 'José', id: 4, name: 'José Álvarez' }]);
    expect(parseEntry('Acme 2026-10-20, 10 scripts, written by Jose Alvarez.', team).writers).toEqual([{ kind: 'matched', text: 'José Álvarez', id: 4, name: 'José Álvarez' }]);
    expect(parseEntry('Acme 2026-10-20, 10 scripts, Anne-Marie is writing.', team).writers).toEqual([{ kind: 'matched', text: 'Anne-Marie', id: 5, name: 'Anne-Marie Roy' }]);
    const both = parseEntry('Acme 2026-10-20, 10 scripts, Zoë and Sarah are writing.', team);
    expect(both.writers.map((w) => w.kind === 'matched' && w.id)).toEqual([6, 2]);
    expect(both.questions).toEqual([]);
    // someone not on the team is still reported, accents and all
    expect(parseEntry('Acme 2026-10-20, 10 scripts, Élodie is writing.', team).questions).toEqual(['There’s no team member called “Élodie”.']);
  });
  it('reports missing information', () => {
    const r = parseEntry('shoot next week', ctx);
    expect(r.questions).toEqual(expect.arrayContaining(['When does the shoot start?', 'How many scripts are needed?']));
  });
});

describe('What’s new', () => {
  it('lists every change newest first, with unique ids that never repeat', async () => {
    const { CHANGELOG, LATEST_CHANGE } = await import('../shared/changelog');
    expect(CHANGELOG.length).toBeGreaterThan(5);
    expect(new Set(CHANGELOG.map((e) => e.id)).size).toBe(CHANGELOG.length);
    expect(LATEST_CHANGE).toBe(CHANGELOG[0].id);
    const dates = CHANGELOG.map((e) => e.date);
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(CHANGELOG.at(-1)!.title).toMatch(/launches/);
    for (const e of CHANGELOG) expect(e.changes.length).toBeGreaterThan(0);
    // who-it's-for tags only name real entries
    const { ONLY_FOR, TECHNICAL } = await import('../shared/changelog');
    const ids = new Set(CHANGELOG.map((e) => e.id));
    for (const id of [...Object.keys(ONLY_FOR), ...TECHNICAL]) expect(ids.has(id)).toBe(true);
  });
});

describe('new work', () => {
  const now = new Date('2026-10-07T12:00:00Z');
  const day = 86400_000;
  const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * day).toISOString();
  it('is work given in the last week that nothing has happened to yet', () => {
    expect(isNewWork([{ status: 'not_started', assignedAt: at(2) }], 0, now)).toBe(true);
    expect(isNewWork([{ status: 'not_started', assignedAt: at(8) }], 0, now)).toBe(false);
    expect(isNewWork([{ status: 'not_started', assignedAt: at(1) }], 1, now)).toBe(false);
    expect(isNewWork([{ status: 'not_started', assignedAt: at(1) }, { status: 'ready_for_review', assignedAt: at(1) }], 0, now)).toBe(false);
    expect(isNewWork([{ status: 'not_started', assignedAt: null }], 0, now)).toBe(false);
    expect(isNewWork([], 0, now)).toBe(false);
  });
});

describe('new work, seen', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  const s = (assignedAt: string, status: 'not_started' | 'in_progress' | 'approved' = 'not_started') => ({ status, assignedAt });
  it('stops being new once the writer has seen it, and counts later additions', () => {
    expect(isNewWork([s('2026-10-07T10:00:00Z')], 0, now, null)).toBe(true);
    expect(isNewWork([s('2026-10-07T10:00:00Z')], 0, now, '2026-10-07T11:00:00Z')).toBe(false);
    expect(isNewWork([s('2026-10-07T10:00:00Z'), s('2026-10-08T09:00:00Z')], 0, now, '2026-10-07T11:00:00Z')).toBe(true);
    const added = newlyAdded([s('2026-10-01T10:00:00Z', 'in_progress'), s('2026-10-08T09:00:00Z'), s('2026-10-08T09:00:00Z', 'approved')], now, '2026-10-05T00:00:00Z');
    expect(added).toHaveLength(1);
  });
});

describe('script numbers people type', () => {
  it('reads spaces, “to”, “and”, semicolons and the word scripts', () => {
    expect(parseRanges('1 - 3, 5', 10)).toEqual([1, 2, 3, 5]);
    expect(parseRanges('1 to 3 and 6', 10)).toEqual([1, 2, 3, 6]);
    expect(parseRanges('scripts 2–4; 7', 10)).toEqual([2, 3, 4, 7]);
    expect(parseRanges('#4', 10)).toEqual([4]);
    expect(parseRanges('1-30', 10)).toBeNull();
    expect(parseRanges('one', 10)).toBeNull();
  });
});

describe('a video not matched to a shoot', () => {
  it('is a gap only when its client has scripts here: not pinned to none, not a client without scripts, not a brand that isn’t a client', () => {
    const v = (how: string | null, o: { batch?: unknown; state?: 'to_edit' | 'approved' } = {}) => ({ state: o.state ?? 'to_edit', batch: o.batch ?? null, match: { how, check: false } });
    expect(isNotMatched(v(null))).toBe(true);
    expect(isNotMatched(v('pinned'))).toBe(false);
    expect(isNotMatched(v('no_scripts'))).toBe(false);
    expect(isNotMatched(v('no_client'))).toBe(false);
    expect(isNotMatched(v(null, { state: 'approved' }))).toBe(false);
    expect(isNotMatched(v('date', { batch: { id: 1 } }))).toBe(false);
  });
});

describe('links into Timeliner', () => {
  it('opens one video by its task id, as Timeliner’s address bar shows it', () => {
    expect(timelinerVideoUrl('3e032f54-73bc-4ece-a4f4-01876d698050')).toBe('https://timeliner.io/app?task=3e032f54-73bc-4ece-a4f4-01876d698050');
  });
  it('keeps an odd id inside the task parameter', () => {
    expect(timelinerVideoUrl('a&b=c')).toBe('https://timeliner.io/app?task=a%26b%3Dc');
  });
  it('opens the app, not the home page, when it isn’t about one video', () => {
    expect(TIMELINER_APP).toBe('https://timeliner.io/app');
  });
});

describe('kinds of editor', () => {
  it('reads an editor with no kind as a video editor, and nobody else as an editor of any kind', async () => {
    const { editorKindOf, isThumbnailDesigner, isVideoEditor } = await import('../shared/workflow');
    expect(editorKindOf({ role: 'editor', editorKind: null })).toBe('short_form');
    expect(editorKindOf({ role: 'editor' })).toBe('short_form');
    expect(editorKindOf({ role: 'editor', editorKind: 'thumbnail' })).toBe('thumbnail');
    // a stray kind on anyone else means nothing
    expect(editorKindOf({ role: 'writer', editorKind: 'thumbnail' })).toBeNull();
    expect(editorKindOf({ role: 'owner', editorKind: null })).toBeNull();
    expect([isVideoEditor({ role: 'editor' }), isThumbnailDesigner({ role: 'editor' })]).toEqual([true, false]);
    expect([isVideoEditor({ role: 'editor', editorKind: 'thumbnail' }), isThumbnailDesigner({ role: 'editor', editorKind: 'thumbnail' })]).toEqual([false, true]);
    expect([isVideoEditor({ role: 'manager' }), isThumbnailDesigner({ role: 'writer', editorKind: 'thumbnail' })]).toEqual([false, false]);
  });

  it('sends each person home, and names what they do', async () => {
    const { homePath, personLabel } = await import('../shared/workflow');
    const { audienceOf } = await import('../shared/changelog');
    const people = [
      { role: 'owner', editorKind: null }, { role: 'manager', editorKind: null }, { role: 'writer', editorKind: null },
      { role: 'editor', editorKind: null }, { role: 'editor', editorKind: 'short_form' }, { role: 'editor', editorKind: 'thumbnail' },
    ] as const;
    expect(people.map(homePath)).toEqual(['/overview', '/overview', '/my-work', '/editor', '/editor', '/studio']);
    expect(people.map(personLabel)).toEqual(['Admin', 'Manager', 'Writer', 'Video editor', 'Video editor', 'Thumbnail designer']);
    expect(people.map(audienceOf)).toEqual(['managers', 'managers', 'writers', 'editors', 'editors', 'designers']);
  });

  it('writes the kinds into SQL from the shared lists only', async () => {
    const { kindsSql, NON_VIDEO_EDITOR_KINDS, VIDEO_EDITOR_KINDS, EDITOR_KINDS } = await import('../shared/workflow');
    expect(kindsSql(NON_VIDEO_EDITOR_KINDS)).toBe(`'thumbnail'`);
    expect(kindsSql(VIDEO_EDITOR_KINDS)).toBe(`'short_form'`);
    expect([...VIDEO_EDITOR_KINDS, ...NON_VIDEO_EDITOR_KINDS].sort()).toEqual([...EDITOR_KINDS].sort());
    // nothing matches an empty list, and nothing but a kind gets in
    expect(kindsSql([])).toBe('null');
    expect(() => kindsSql(["x') or true --" as never])).toThrow();
  });
});

describe('where a thumbnail brief stands', () => {
  it('follows a brief from the tray through rounds, changes, a pick and deciding again', async () => {
    const { thumbnailState } = await import('../shared/workflow');
    const open = { cancelledAt: null, draftOptions: 0 };
    expect(thumbnailState(open, null, null)).toBe('to_design');
    expect(thumbnailState({ ...open, draftOptions: 2 }, null, null)).toBe('drafting');
    // round 1 sent: waiting on a manager
    expect(thumbnailState(open, { id: 1 }, null)).toBe('in_review');
    expect(thumbnailState(open, { id: 1 }, { roundId: 1, action: 'changes' })).toBe('changes');
    // still changes while round 2 is being drafted
    expect(thumbnailState({ ...open, draftOptions: 3 }, { id: 1 }, { roundId: 1, action: 'changes' })).toBe('changes');
    // round 2 sent: the decision on round 1 no longer counts
    expect(thumbnailState(open, { id: 2 }, { roundId: 1, action: 'changes' })).toBe('in_review');
    expect(thumbnailState(open, { id: 2 }, { roundId: 2, action: 'pick' })).toBe('picked');
    // deciding again on the same round: the newest decision counts
    expect(thumbnailState(open, { id: 2 }, { roundId: 2, action: 'changes' })).toBe('changes');
    // cancelled, whatever happened
    expect(thumbnailState({ ...open, cancelledAt: '2026-10-16T10:00:00Z' }, { id: 2 }, { roundId: 2, action: 'pick' })).toBe('cancelled');
  });

  it('puts changes asked first, then the soonest due, and never offers one in review, picked or cancelled', async () => {
    const { nextBrief, briefOrder } = await import('../shared/workflow');
    const b = (id: number, state: 'to_design' | 'drafting' | 'in_review' | 'changes' | 'picked' | 'cancelled', dueOn: string | null) => ({ id, state, dueOn });
    const list = [b(1, 'to_design', null), b(2, 'drafting', '2026-10-20'), b(3, 'to_design', '2026-10-18'), b(4, 'changes', '2026-10-30'), b(5, 'in_review', '2026-10-17')];
    expect(nextBrief(list)?.id).toBe(4);
    expect(nextBrief(list.filter((x) => x.id !== 4))?.id).toBe(3);
    expect(nextBrief([b(6, 'in_review', '2026-10-17'), b(7, 'picked', null), b(8, 'cancelled', null)])).toBeNull();
    expect([...list].sort(briefOrder).map((x) => x.id)).toEqual([4, 3, 2, 1, 5]);
  });

  it('letters options A to F, six at most', async () => {
    const { nextLetter, MAX_OPTIONS, OPTION_LETTERS, DEFAULT_OPTIONS } = await import('../shared/workflow');
    expect(OPTION_LETTERS).toHaveLength(MAX_OPTIONS);
    expect([MAX_OPTIONS, DEFAULT_OPTIONS]).toEqual([6, 3]);
    expect(nextLetter([])).toBe('A');
    expect(nextLetter(['A', 'C'])).toBe('B');
    expect(nextLetter([...OPTION_LETTERS])).toBeNull();
  });

  it('checks an image against YouTube’s guidance, only ever as warnings', async () => {
    const { thumbSpecIssues, thumbSpecChecks, THUMB_SPEC } = await import('../shared/workflow');
    const keys = (img: { width: number; height: number; size: number; mime: string }) => thumbSpecIssues(img).map((c) => c.key);
    const mb = 1024 * 1024;
    expect(keys({ width: 1280, height: 720, size: 1.4 * mb, mime: 'image/png' })).toEqual([]);
    expect(keys({ width: 1920, height: 1080, size: 1.9 * mb, mime: 'image/jpeg' })).toEqual([]);
    expect(keys({ width: 1000, height: 563, size: mb, mime: 'image/jpeg' })).toEqual(['size']);
    expect(thumbSpecIssues({ width: 600, height: 338, size: mb, mime: 'image/jpeg' })[0].detail).toMatch(/640/);
    expect(keys({ width: 1280, height: 1280, size: mb, mime: 'image/png' })).toEqual(['shape']);
    expect(keys({ width: 1280, height: 720, size: 2.5 * mb, mime: 'image/png' })).toEqual(['bytes']);
    expect(keys({ width: 1280, height: 720, size: mb, mime: 'image/webp' })).toEqual(['format']);
    // the 2 MB is YouTube's limit, not the site's upload limit
    expect(THUMB_SPEC.maxBytesLabel).toMatch(/YouTube/);
    expect(thumbSpecChecks({ width: 1280, height: 720, size: 2.5 * mb, mime: 'image/png' }).find((c) => c.key === 'bytes')?.detail).toMatch(/YouTube’s 2 MB/);
    expect(thumbSpecChecks({ width: 1280, height: 720, size: mb, mime: 'image/png' }).map((c) => c.label)).toEqual(['1280×720', '16:9', '1.0 MB, under 2 MB', 'PNG']);
    // a small export reads as what it weighs, never "0.0 MB"
    const bytes = (size: number) => thumbSpecChecks({ width: 1280, height: 720, size, mime: 'image/jpeg' }).find((c) => c.key === 'bytes')?.label;
    expect([bytes(21 * 1024), bytes(900), bytes(2.4 * mb)]).toEqual(['21 KB, under 2 MB', '900 B, under 2 MB', '2.4 MB']);
  });
});

describe('who has written a client’s scripts before', () => {
  const b = (id: number, writers: [number | null, string, number][]) => ({ id, title: `Batch ${id}`, draftDue: null, finalDue: `2026-10-${10 + id}`, writers: writers.map(([userId, name, count]) => ({ userId, name, count })) });
  it('gives the newest batch’s split and everyone, most scripts first, leaving out who can’t write now', () => {
    const h = writerHistory([
      b(1, [[1, 'Sarah', 20], [2, 'Marcus', 11]]),
      b(3, [[2, 'Marcus', 10], [9, 'Gone', 5], [null, 'Unassigned', 3]]),
      b(2, [[1, 'Sarah', 25], [3, 'Lee', 4]]),
    ], (id) => id !== 9);
    expect(h.last).toEqual({ batchId: 3, title: 'Batch 3', date: '2026-10-13', writers: [{ userId: 2, name: 'Marcus', count: 10 }] });
    expect(h.everyone).toEqual([
      { userId: 1, name: 'Sarah', scripts: 45, batches: 2 },
      { userId: 2, name: 'Marcus', scripts: 21, batches: 2 },
      { userId: 3, name: 'Lee', scripts: 4, batches: 1 },
    ]);
  });
  it('skips batches nobody still on the team wrote, and is empty for a new client', () => {
    expect(writerHistory([b(1, [[1, 'Sarah', 5]]), b(2, [[9, 'Gone', 5]])], (id) => id !== 9).last?.batchId).toBe(1);
    expect(writerHistory([], () => true)).toEqual({ last: null, everyone: [] });
  });
});

describe('pins on a thumbnail option', () => {
  it('keeps the tags and the moments the database checks in step with the shared lists', async () => {
    const { THUMB_PIN_TAGS, THUMB_PIN_TAG_LABEL, THUMB_MOMENT_KINDS } = await import('../shared/workflow');
    const { MIGRATIONS } = await import('../server/schema');
    const sql = MIGRATIONS[39];
    expect(typeof sql).toBe('string');
    const tagCheck = /tag text check \(tag in \(([^)]*)\)\)/.exec(sql as string)?.[1];
    expect(tagCheck?.split(',').map((t) => t.trim().replace(/'/g, ''))).toEqual([...THUMB_PIN_TAGS]);
    expect(Object.keys(THUMB_PIN_TAG_LABEL)).toEqual([...THUMB_PIN_TAGS]);
    const kinds = /moments_kind_check check \(kind in \(([^)]*)\)\)/.exec(sql as string)?.[1].split(',').map((k) => k.trim().replace(/'/g, ''));
    // the six kinds from before, plus a pick and a standout; asking for changes is never a celebration
    expect(kinds).toEqual(['approved', 'revisions', 'drafts_done', 'batch_done', 'team_drafts_done', 'team_batch_done', ...THUMB_MOMENT_KINDS]);
    expect(kinds).not.toContain('thumb_changes');
  });

  it('finds the picture inside its frame, letterboxed or not', async () => {
    const { fitContain } = await import('../shared/workflow');
    expect(fitContain({ width: 640, height: 360 }, { width: 1280, height: 720 })).toEqual({ left: 0, top: 0, width: 640, height: 360 });
    // a square image in a 16:9 frame: bars left and right
    expect(fitContain({ width: 640, height: 360 }, { width: 1000, height: 1000 })).toEqual({ left: 140, top: 0, width: 360, height: 360 });
    // wider than 16:9: bars top and bottom
    expect(fitContain({ width: 640, height: 360 }, { width: 2000, height: 500 })).toEqual({ left: 0, top: 100, width: 640, height: 160 });
    // size not known yet, or nothing to fit in: the whole frame
    expect(fitContain({ width: 640, height: 360 }, { width: 0, height: 0 })).toEqual({ left: 0, top: 0, width: 640, height: 360 });
    expect(fitContain({ width: 0, height: 0 }, { width: 1280, height: 720 })).toEqual({ left: 0, top: 0, width: 0, height: 0 });
  });

  it('turns a click into a spot on the picture from 0 to 1, kept on it and rounded', async () => {
    const { pinAt } = await import('../shared/workflow');
    const box = { left: 100, top: 50, width: 640, height: 360 };
    expect(pinAt({ x: 420, y: 230 }, box)).toEqual({ x: 0.5, y: 0.5 });
    expect(pinAt({ x: 100, y: 50 }, box)).toEqual({ x: 0, y: 0 });
    // a click on a bar or past the edge stays on the picture
    expect(pinAt({ x: 40, y: 900 }, box)).toEqual({ x: 0, y: 1 });
    expect(pinAt({ x: 100 + 640 / 3, y: 50 + 360 * 0.123456 }, box)).toEqual({ x: 0.3333, y: 0.1235 });
    expect(pinAt({ x: 10, y: 10 }, { left: 0, top: 0, width: 0, height: 360 })).toBeNull();
    expect(pinAt({ x: Number.NaN, y: 10 }, box)).toBeNull();
  });

  it('shows the newest decision’s pins on a round; earlier ones stay with their decision', async () => {
    const { currentPins, MAX_PINS, PIN_NOTE_MAX } = await import('../shared/workflow');
    expect([MAX_PINS, PIN_NOTE_MAX]).toEqual([20, 500]);
    const round = { decisions: [{ pins: [{ n: 1 }] }, { pins: [{ n: 1 }, { n: 2 }] }] };
    expect(currentPins(round)).toEqual([{ n: 1 }]);
    expect(currentPins({ decisions: [{}, { pins: [{ n: 1 }] }] })).toEqual([]);
    expect(currentPins({ decisions: [] })).toEqual([]);
  });
});

describe('celebrating a thumbnail pick', () => {
  it('records a pick or a standout, keyed by the person and the decision', async () => {
    const { thumbMomentKind, thumbMomentKey } = await import('../shared/workflow');
    expect([thumbMomentKind(false), thumbMomentKind(true)]).toEqual(['thumb_picked', 'thumb_standout']);
    expect(thumbMomentKey('thumb_picked', 7, 42)).toBe('thumb_picked:7:42');
    // dedupe keys are unique across the whole table: two people, or two decisions, never share one
    const keys = [thumbMomentKey('thumb_picked', 7, 42), thumbMomentKey('thumb_picked', 8, 42), thumbMomentKey('thumb_picked', 7, 43), thumbMomentKey('thumb_standout', 7, 42)];
    expect(new Set(keys).size).toBe(keys.length);
    expect(thumbMomentKey('thumb_picked', 1, 23)).not.toBe(thumbMomentKey('thumb_picked', 12, 3));
  });

  it('celebrates a first-round pick bigger, and rings a standout', async () => {
    const { pickCelebration } = await import('../shared/workflow');
    expect(pickCelebration({ firstRound: true, standout: false })).toEqual({ size: 'big', ring: false });
    expect(pickCelebration({ firstRound: false, standout: false })).toEqual({ size: 'small', ring: false });
    expect(pickCelebration({ firstRound: false, standout: true })).toEqual({ size: 'small', ring: true });
  });
});

describe('a thumbnail’s AI second look', () => {
  const checks = (over: Record<string, unknown> = {}) => ['reads_small', 'focal_point', 'words', 'contrast', 'brief_fit', 'brand_fit']
    .map((key) => ({ key, status: 'ok', note: `${key} note`, ...(over[key] as object | undefined) }));

  it('takes options up to 7 MB, and says why it won’t take a bigger one', async () => {
    const { secondLookRefusal, SECOND_LOOK_MAX_BYTES } = await import('../shared/workflow');
    expect(SECOND_LOOK_MAX_BYTES).toBe(7 * 1024 * 1024);
    expect(secondLookRefusal({ size: SECOND_LOOK_MAX_BYTES })).toBeNull();
    expect(secondLookRefusal({ size: 1.4 * 1024 * 1024 })).toBeNull();
    expect(secondLookRefusal({ size: SECOND_LOOK_MAX_BYTES + 1 })).toMatch(/up to 7 MB/);
    expect(secondLookRefusal({ size: 8.4 * 1024 * 1024 })).toMatch(/^This image is 8\.4 MB/);
  });

  it('colours each status as the chips do: strong mint, ok neutral, watch yellow', async () => {
    const { SECOND_LOOK_STATUS_COLOR, SECOND_LOOK_CHECKS, SECOND_LOOK_CHECK_LABEL } = await import('../shared/workflow');
    expect(SECOND_LOOK_STATUS_COLOR).toEqual({ strong: 'mint', ok: 'neutral', watch: 'yellow' });
    expect(Object.keys(SECOND_LOOK_CHECK_LABEL)).toEqual([...SECOND_LOOK_CHECKS]);
  });

  it('keeps an answer tidy: trimmed, the six checks in order, three suggestions at most', async () => {
    const { tidySecondLook } = await import('../shared/workflow');
    const out = tidySecondLook({
      oneLiner: '  Strong   face,\n but the words fight it.  ',
      // out of order, with an extra key and a repeat (the first counts)
      checks: [...checks({ words: { status: 'watch', note: '  Five words:  cut to two.  ' } }).reverse(), { key: 'colour', status: 'ok', note: 'x' }, { key: 'words', status: 'strong', note: 'later' }],
      suggestions: ['  Cut the words to “TOO LATE”. ', '', '   ', 'Lift the face 10%.', 'Darken the left third.', 'A fourth one.'],
    });
    expect(out?.oneLiner).toBe('Strong face, but the words fight it.');
    expect(out?.checks.map((c) => c.key)).toEqual(['reads_small', 'focal_point', 'words', 'contrast', 'brief_fit', 'brand_fit']);
    expect(out?.checks[2]).toEqual({ key: 'words', status: 'watch', note: 'Five words: cut to two.' });
    expect(out?.suggestions).toEqual(['Cut the words to “TOO LATE”.', 'Lift the face 10%.', 'Darken the left third.']);
    expect(tidySecondLook({ oneLiner: 'Fine.', checks: checks(), suggestions: undefined })?.suggestions).toEqual([]);
  });

  it('cuts text over its limit at a word break, never mid-emoji', async () => {
    const { tidySecondLook, SECOND_LOOK_LIMITS } = await import('../shared/workflow');
    const long = 'The face reads well at feed size but the headline is doing too much work for a phone, '.repeat(3);
    const out = tidySecondLook({ oneLiner: long, checks: checks({ contrast: { note: long } }), suggestions: [long] })!;
    expect(out.oneLiner.length).toBeLessThanOrEqual(SECOND_LOOK_LIMITS.oneLiner);
    expect(out.oneLiner).toMatch(/\w…$/);
    expect(long.startsWith(out.oneLiner.slice(0, -1))).toBe(true);
    expect(out.checks[3].note.length).toBeLessThanOrEqual(SECOND_LOOK_LIMITS.note);
    expect(out.suggestions[0].length).toBeLessThanOrEqual(SECOND_LOOK_LIMITS.suggestion);
    // no word break to cut at, ending on an emoji: the emoji goes whole
    const emoji = tidySecondLook({ oneLiner: `${'x'.repeat(138)}😀😀`, checks: checks(), suggestions: [] })!.oneLiner;
    expect(emoji).toBe(`${'x'.repeat(138)}…`);
  });

  it('refuses an answer it can’t use: no headline, a check missing, or an odd status', async () => {
    const { tidySecondLook } = await import('../shared/workflow');
    expect(tidySecondLook({ oneLiner: '   ', checks: checks(), suggestions: [] })).toBeNull();
    expect(tidySecondLook({ oneLiner: 'Good', checks: checks().filter((c) => c.key !== 'brand_fit'), suggestions: [] })).toBeNull();
    expect(tidySecondLook({ oneLiner: 'Good', checks: checks({ focal_point: { status: 'great' } }), suggestions: [] })).toBeNull();
    expect(tidySecondLook({ oneLiner: 'Good', checks: 'all fine', suggestions: [] })).toBeNull();
    expect(tidySecondLook(null)).toBeNull();
    expect(tidySecondLook('Good')).toBeNull();
  });
});

describe('a client’s brand kit', () => {
  it('reads a colour the way the hex input takes it, and nothing that isn’t one', async () => {
    const { normalizeHex, HEX } = await import('../shared/palettes');
    expect(normalizeHex('#abc')).toBe('#AABBCC');
    expect(normalizeHex(' a1b2c3 ')).toBe('#A1B2C3');
    expect(normalizeHex('#A1b2C3')).toBe('#A1B2C3');
    expect(HEX.test(normalizeHex('fff')!)).toBe(true);
    for (const v of ['red', '#abcd', '#12345', '#1234567', '', '   ', null, undefined, '##abc']) expect(normalizeHex(v)).toBeNull();
  });

  it('measures contrast as WCAG does, either way round', async () => {
    const { contrastRatio, relativeLuminance } = await import('../shared/palettes');
    expect(relativeLuminance('#FFFFFF')).toBe(1);
    expect(relativeLuminance('#000')).toBe(0);
    expect(relativeLuminance('nope')).toBeNaN();
    expect(contrastRatio('#000000', '#FFFFFF')).toBe(21);
    expect(contrastRatio('#FFFFFF', '#000000')).toBe(21);
    expect(contrastRatio('#E53935', '#E53935')).toBe(1);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
  });

  it('pairs the darkest and lightest colours, and never rounds a ratio up', async () => {
    const { brandContrast } = await import('../shared/workflow');
    const kit = brandContrast([{ hex: '#E53935' }, { hex: '#f4ed70' }, { hex: '#0A1A3A' }]);
    expect(kit).toMatchObject({ dark: '#0A1A3A', light: '#F4ED70', readable: true });
    expect(kit!.ratio).toBeGreaterThan(14);
    expect(kit!.label).toMatch(/^\d+\.\d:1$/);
    // 4.48:1 reads as 4.4:1, under the 4.5 text needs
    expect(brandContrast([{ hex: '#FFFFFF' }, { hex: '#777777' }])).toMatchObject({ dark: '#777777', light: '#FFFFFF', label: '4.4:1', readable: false });
    expect(brandContrast([{ hex: '#000000' }, { hex: '#FFFFFF' }])?.label).toBe('21.0:1');
    // fewer than two different colours: nothing to compare
    expect(brandContrast([{ hex: '#fff' }, { hex: '#FFFFFF' }])).toBeNull();
    expect(brandContrast([{ hex: '#E53935' }, { hex: 'not a colour' }])).toBeNull();
    expect(brandContrast([])).toBeNull();
  });

  it('takes only secure links for fonts', async () => {
    const { isHttpsUrl } = await import('../shared/workflow');
    for (const ok of ['https://fonts.google.com/specimen/Inter', 'HTTPS://example.com', 'https://example.com?family=Inter#x']) expect(isHttpsUrl(ok)).toBe(true);
    for (const bad of ['http://fonts.google.com', 'https://', 'https:// example.com', 'javascript:alert(1)', 'fonts.google.com', 'https://user@evil.example', 'ftp://x.com']) expect(isHttpsUrl(bad)).toBe(false);
  });

  it('names every problem on a kit editor row at once, field by field', async () => {
    const { brandColourProblems, brandFontProblems } = await import('../shared/workflow');
    // a nameless colour with a half-typed code: both, so one save shows everything to fix
    expect(brandColourProblems({ name: ' ', hex: '#12' })).toEqual({ name: 'Give it a name', hex: 'Use a colour code like #1F6FEB' });
    expect(brandColourProblems({ name: 'Ink', hex: '#12' })).toEqual({ hex: 'Use a colour code like #1F6FEB' });
    expect(brandColourProblems({ name: '', hex: '0a1a3a' })).toEqual({ name: 'Give it a name' });
    expect(brandColourProblems({ name: 'Ink', hex: '#0a1a3a' })).toEqual({});
    expect(brandFontProblems({ name: '', url: 'http://fonts.example' })).toEqual({ name: 'Give it a name', url: 'Use a secure link that starts with https://' });
    expect(brandFontProblems({ name: 'Inter', url: '  ' })).toEqual({});
    expect(brandFontProblems({ name: 'Inter', url: ' https://fonts.google.com/specimen/Inter ' })).toEqual({});
  });

  it('sends and saves only what changed, compared tidied', async () => {
    const { brandChanges, EMPTY_BRAND } = await import('../shared/workflow');
    const kept = {
      colours: [{ name: 'Ink', hex: '#0A1A3A' }, { name: 'Lemon', hex: '#F4ED70' }],
      fonts: [{ name: 'Inter', url: 'https://fonts.google.com/specimen/Inter', resourceId: null, file: null }],
      dos: 'Faces big', donts: null,
    };
    // the same kit, typed differently: no change
    expect(brandChanges(kept, { colours: [{ name: '  Ink ', hex: '#0a1a3a' }, { name: 'Lemon', hex: 'f4ed70' }], dos: ' Faces big\n', donts: '  ' })).toEqual({});
    expect(brandChanges(kept, { fonts: [{ name: 'Inter', url: 'https://fonts.google.com/specimen/Inter ', resourceId: null }] })).toEqual({});
    // moving a swatch is a change, and the tidied list is what's kept
    expect(brandChanges(kept, { colours: [{ name: 'Lemon', hex: '#f4ed70' }, { name: 'Ink', hex: '#0A1A3A' }] })).toEqual({
      colours: [{ name: 'Lemon', hex: '#F4ED70' }, { name: 'Ink', hex: '#0A1A3A' }],
    });
    expect(brandChanges(kept, { dos: '', donts: ' No clichés ' })).toEqual({ dos: null, donts: 'No clichés' });
    expect(brandChanges(kept, { fonts: [{ name: 'Inter', url: '', resourceId: 12 }] })).toEqual({ fonts: [{ name: 'Inter', url: null, resourceId: 12 }] });
    // a client with no kit yet reads as an empty one
    expect(brandChanges(null, { colours: [], fonts: [], dos: null })).toEqual({});
    expect(brandChanges(null, { colours: [{ name: 'Red', hex: '#e53935' }] })).toEqual({ colours: [{ name: 'Red', hex: '#E53935' }] });
    expect(EMPTY_BRAND).toEqual({ colours: [], fonts: [], dos: null, donts: null });
  });

  it('keeps the categories, limits and kinds the migration checks in step with the shared lists', async () => {
    const { BRAND_LIMITS, EDITOR_KINDS } = await import('../shared/workflow');
    const { BRAND_CATEGORIES, RESOURCE_CATEGORIES, RESOURCE_LABEL } = await import('../shared/types');
    const { MIGRATIONS } = await import('../server/schema');
    const sql = MIGRATIONS[40];
    expect(typeof sql).toBe('string');
    const list = (re: RegExp) => re.exec(sql as string)?.[1].split(',').map((k) => k.trim().replace(/'/g, ''));
    expect(list(/resources_category_check check \(category in \(([^)]*)\)\)/)).toEqual([...RESOURCE_CATEGORIES]);
    // the categories from migration 1 stay, in their order
    expect(RESOURCE_CATEGORIES.slice(0, 6)).toEqual(['folder', 'example', 'asset', 'recording', 'document', 'other']);
    expect(Object.keys(RESOURCE_LABEL)).toEqual([...RESOURCE_CATEGORIES]);
    expect(BRAND_CATEGORIES.every((c) => RESOURCE_CATEGORIES.includes(c))).toBe(true);
    expect(list(/editors_editor_kind_check check \(editor_kind is null or editor_kind in \(([^)]*)\)\)/)).toEqual([...EDITOR_KINDS]);
    expect(sql).toContain(`jsonb_array_length(colours) <= ${BRAND_LIMITS.colours}`);
    expect(sql).toContain(`jsonb_array_length(fonts) <= ${BRAND_LIMITS.fonts}`);
    expect(BRAND_LIMITS).toEqual({ colours: 12, fonts: 6, name: 40, notes: 1000 });
  });

  it('reads an entry in Settings → Editors with no kind as a video editor', async () => {
    const { isVideoEditorKind } = await import('../shared/workflow');
    expect([null, undefined, 'short_form', 'thumbnail'].map((k) => isVideoEditorKind(k as 'short_form' | null | undefined))).toEqual([true, true, true, false]);
  });
});

describe('picking colours from a logo', () => {
  const px = (hex: string, n: number, alpha = 255) =>
    Array.from({ length: n }, () => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), alpha]).flat();

  it('gives the main colours, most common first, skipping the background, the outline and transparency', async () => {
    const { dominantColours } = await import('../shared/palettes');
    const logo = [...px('#FFFFFF', 300), ...px('#1E88E5', 50), ...px('#000000', 30), ...px('#E53935', 100), ...px('#FAFAFA', 30), ...px('#0B0B0D', 20), ...px('#F4ED70', 60, 40)];
    expect(dominantColours(logo)).toEqual(['#E53935', '#1E88E5']);
    expect(dominantColours(new Uint8ClampedArray(logo))).toEqual(['#E53935', '#1E88E5']);
    expect(dominantColours(px('#FFFFFF', 50))).toEqual([]);
    expect(dominantColours([])).toEqual([]);
  });

  it('counts close shades as one colour, its average', async () => {
    const { dominantColours } = await import('../shared/palettes');
    // the same group of shades: one colour, their average
    expect(dominantColours([...px('#E53935', 1), ...px('#E33B37', 1)])).toEqual(['#E43A36']);
    // shades either side of a group's edge are still one colour
    expect(dominantColours([...px('#EF3F3F', 60), ...px('#F04040', 40), ...px('#1E88E5', 30)])).toEqual(['#EF3F3F', '#1E88E5']);
  });

  it('gives six at most, and leaves out specks', async () => {
    const { dominantColours, LOGO_COLOURS_MAX } = await import('../shared/palettes');
    const eight = ['#E53935', '#1E88E5', '#43A047', '#FDD835', '#8E24AA', '#FB8C00', '#00ACC1', '#6D4C41'];
    const many = eight.flatMap((h, i) => px(h, 80 - i * 5));
    expect(LOGO_COLOURS_MAX).toBe(6);
    expect(dominantColours(many)).toEqual(eight.slice(0, 6));
    expect(dominantColours(many, 3)).toEqual(eight.slice(0, 3));
    // under 1% of what's counted: a speck of anti-aliasing, not a brand colour
    expect(dominantColours([...px('#E53935', 199), ...px('#1E88E5', 1)])).toEqual(['#E53935']);
  });
});

describe('a designer’s reference boards', () => {
  it('is exactly one of an upload, a winner or a resource, as the database checks', async () => {
    const { refSource, MAX_REFS, REF_CAPTION_MAX, THUMB_REF_SOURCES } = await import('../shared/workflow');
    const { MIGRATIONS } = await import('../server/schema');
    expect(refSource({ fileId: 4, variantId: null, resourceId: null })).toBe('upload');
    expect(refSource({ fileId: null, variantId: 9, resourceId: null })).toBe('winner');
    expect(refSource({ fileId: null, variantId: null, resourceId: 2 })).toBe('resource');
    expect(refSource({ fileId: null, variantId: null, resourceId: null })).toBeNull();
    expect(refSource({ fileId: 4, variantId: 9, resourceId: null })).toBeNull();
    expect(THUMB_REF_SOURCES).toEqual(['upload', 'winner', 'resource']);
    expect([MAX_REFS, REF_CAPTION_MAX]).toEqual([300, 200]);
    expect(MIGRATIONS[40]).toContain('check (num_nonnulls(file_id, variant_id, resource_id) = 1)');
  });
});

describe('AI brief ideas', () => {
  const idea = (show: string, words = 'TOO LATE', why = 'A face and one problem read at feed size.') => ({ show, words, why });

  it('keeps three ideas, tidied', async () => {
    const { tidyThumbIdeas } = await import('../shared/workflow');
    const out = tidyThumbIdeas({
      ideas: [
        idea('  Him   holding the\n burnt pan,  shocked. ', '  “ONE PAN”  ', ' Shock reads small.  '),
        idea('The empty fridge, door open, cold light.', ''),
        idea('Split screen: day 1 vs day 30.', '$1 A WEEK'),
      ],
    }, 'I lived on $1 a week');
    expect(out).toEqual([
      { show: 'Him holding the burnt pan, shocked.', words: 'ONE PAN', why: 'Shock reads small.' },
      { show: 'The empty fridge, door open, cold light.', words: '', why: 'A face and one problem read at feed size.' },
      { show: 'Split screen: day 1 vs day 30.', words: '$1 A WEEK', why: 'A face and one problem read at feed size.' },
    ]);
  });

  it('drops words that don’t fit or just repeat the title, rather than cutting them', async () => {
    const { tidyThumbIdeas, THUMB_IDEA_LIMITS } = await import('../shared/workflow');
    expect(THUMB_IDEA_LIMITS).toEqual({ show: 200, words: 32, wordCount: 4, why: 120 });
    const out = tidyThumbIdeas({
      ideas: [
        idea('A', 'THIS IS FAR TOO MANY'),
        idea('B', 'X'.repeat(33)),
        idea('C', 'I Lived on $1 a Week!'),
      ],
    }, 'I lived on $1 a week')!;
    expect(out.map((i) => i.words)).toEqual(['', '', '']);
    const fits = tidyThumbIdeas({ ideas: [idea('A', 'FOUR WORDS FIT HERE'), idea('B', 'X'.repeat(32)), idea('C', 'A WEEK')] }, 'I lived on $1 a week')!;
    expect(fits.map((i) => i.words)).toEqual(['FOUR WORDS FIT HERE', 'X'.repeat(32), 'A WEEK']);
  });

  it('cuts a long idea at a word break, and skips empty or repeated ones', async () => {
    const { tidyThumbIdeas, THUMB_IDEA_LIMITS } = await import('../shared/workflow');
    const long = 'Close on his face lit by the open fridge, the empty shelves behind him, one sad lemon in the door, '.repeat(3);
    const out = tidyThumbIdeas({
      ideas: [idea(long, 'ONE LEMON', long), idea('   '), { words: 'NO SHOW' }, 'nonsense', idea('Close on his FACE, lit by the open fridge!'), idea('close on his face lit by the open fridge'), idea('The receipt for $1, crumpled.'), idea('Day 30: thin, smiling.'), idea('A fourth.')],
    }, 'Living on $1')!;
    expect(out).toHaveLength(3);
    expect(out[0].show.length).toBeLessThanOrEqual(THUMB_IDEA_LIMITS.show);
    expect(out[0].show).toMatch(/\w…$/);
    expect(out[0].why.length).toBeLessThanOrEqual(THUMB_IDEA_LIMITS.why);
    // the same direction worded the same way, whatever the case and punctuation, counts once
    expect(out.slice(1).map((i) => i.show)).toEqual(['Close on his FACE, lit by the open fridge!', 'The receipt for $1, crumpled.']);
  });

  it('refuses an answer without three usable ideas', async () => {
    const { tidyThumbIdeas } = await import('../shared/workflow');
    expect(tidyThumbIdeas({ ideas: [idea('A'), idea('B')] }, 'T')).toBeNull();
    expect(tidyThumbIdeas({ ideas: [idea('A'), idea('a!'), idea('B')] }, 'T')).toBeNull();
    expect(tidyThumbIdeas({ ideas: 'three good ones' }, 'T')).toBeNull();
    expect(tidyThumbIdeas({}, 'T')).toBeNull();
    expect(tidyThumbIdeas(null, 'T')).toBeNull();
    expect(tidyThumbIdeas([idea('A'), idea('B'), idea('C')], 'T')).toBeNull();
  });
});

describe('a thumbnail that went live', () => {
  it('takes an https link, a day and a short note, and clearing is every field empty', async () => {
    const { liveProblems, clearsLive, tidyLive, LIVE_LIMITS } = await import('../shared/workflow');
    expect(LIVE_LIMITS).toEqual({ url: 500, note: 300 });
    expect(liveProblems({ url: 'https://youtu.be/abc123', publishedOn: '2026-10-26', testWinnerOptionId: 4, testNote: 'B won the test' })).toEqual({});
    // the link is optional; the day isn't
    expect(liveProblems({ publishedOn: '2026-10-26' })).toEqual({});
    expect(liveProblems({ url: 'https://youtu.be/abc123', publishedOn: null }).publishedOn).toMatch(/day it went live/);
    expect(liveProblems({ publishedOn: null, testWinnerOptionId: 4 }).publishedOn).toBeTruthy();
    expect(liveProblems({ publishedOn: null, testNote: 'B won' }).publishedOn).toBeTruthy();
    expect(liveProblems({ publishedOn: '2026-02-30' }).publishedOn).toMatch(/valid date/);
    // https only, with a host, and not too long
    for (const url of ['http://youtu.be/abc123', 'youtu.be/abc123', 'javascript:alert(1)', 'https://', 'ftp://x.test/v']) {
      expect(liveProblems({ url, publishedOn: '2026-10-26' }).url, url).toMatch(/https:\/\//);
    }
    expect(liveProblems({ url: `https://youtu.be/${'a'.repeat(LIVE_LIMITS.url)}`, publishedOn: '2026-10-26' }).url).toMatch(/500/);
    expect(liveProblems({ url: `https://youtu.be/${'a'.repeat(LIVE_LIMITS.url - 17)}`, publishedOn: '2026-10-26' }).url).toBeUndefined();
    expect(liveProblems({ publishedOn: '2026-10-26', testNote: 'x'.repeat(301) }).testNote).toMatch(/300/);
    expect(liveProblems({ publishedOn: '2026-10-26', testNote: 'x'.repeat(300) })).toEqual({});
    // clearing: all empty (spaces are empty), and that's no problem at all
    expect(clearsLive({ url: null, publishedOn: null, testWinnerOptionId: null, testNote: null })).toBe(true);
    expect(clearsLive({ url: '  ', publishedOn: null, testNote: '' })).toBe(true);
    expect(liveProblems({ url: '', publishedOn: null, testWinnerOptionId: null, testNote: ' ' })).toEqual({});
    expect(clearsLive({ publishedOn: null, testWinnerOptionId: 4 })).toBe(false);
    expect(tidyLive({ url: '  https://youtu.be/abc  ', publishedOn: '2026-10-26', testNote: '  ' })).toEqual({ url: 'https://youtu.be/abc', publishedOn: '2026-10-26', testWinnerOptionId: null, testNote: null });
  });

  it('changes only the fields sent, so an edit never undoes another manager’s', async () => {
    const { mergeLive, liveChanges, clearsLive } = await import('../shared/workflow');
    const kept = { url: 'https://youtu.be/u2', publishedOn: '2026-10-20', testWinnerOptionId: 4, testNote: 'B won' };
    // a key left out keeps what's kept; one sent replaces it (tidied: spaces are empty)
    expect(mergeLive(kept, { publishedOn: '2026-10-21' })).toEqual({ ...kept, publishedOn: '2026-10-21' });
    expect(mergeLive(kept, { testNote: '  A won after all ' })).toEqual({ ...kept, testNote: 'A won after all' });
    expect(mergeLive(kept, { url: null, testWinnerOptionId: null })).toEqual({ url: null, publishedOn: '2026-10-20', testWinnerOptionId: null, testNote: 'B won' });
    expect(mergeLive(kept, {})).toEqual(kept);
    // nothing kept yet: only what's sent
    expect(mergeLive(null, { publishedOn: '2026-10-26' })).toEqual({ url: null, publishedOn: '2026-10-26', testWinnerOptionId: null, testNote: null });
    // every key sent empty leaves nothing: taken back
    expect(clearsLive(mergeLive(kept, { url: null, publishedOn: null, testWinnerOptionId: null, testNote: '' }))).toBe(true);
    expect(clearsLive(mergeLive(kept, { publishedOn: null }))).toBe(false);
    // the dialog sends what differs from the mark it opened on, and a new mark everything filled in
    expect(liveChanges(kept, { ...kept, testNote: 'B won ' })).toEqual({});
    expect(liveChanges(kept, { ...kept, url: '', testNote: 'C won' })).toEqual({ url: null, testNote: 'C won' });
    expect(liveChanges(null, { url: '', publishedOn: '2026-10-26', testWinnerOptionId: null, testNote: null })).toEqual({ publishedOn: '2026-10-26' });
  });

  it('tells the maker once per pick, on their portfolio card', async () => {
    const { thumbLiveKey, portfolioPath } = await import('../shared/workflow');
    expect(thumbLiveKey(42, 7)).toBe('thumbnail_live:42:7');
    // another brief, or another option of the same brief picked later, is news of its own
    expect(thumbLiveKey(4, 27)).not.toBe(thumbLiveKey(42, 7));
    expect(thumbLiveKey(42, 8)).not.toBe(thumbLiveKey(42, 7));
    expect(portfolioPath()).toBe('/studio/portfolio');
    expect(portfolioPath({ card: 17 })).toBe('/studio/portfolio?card=17');
    expect(portfolioPath({ userId: 5 })).toBe('/studio/portfolio?userId=5');
    expect(portfolioPath({ userId: 5, card: 17 })).toBe('/studio/portfolio?userId=5&card=17');
    expect(portfolioPath({ userId: null, card: null })).toBe('/studio/portfolio');
  });

  it('offers a client’s titled videos that are open or were posted in the last 90 days', async () => {
    const { offersTimelinerVideo, TIMELINER_VIDEO_DAYS } = await import('../shared/workflow');
    const now = new Date('2026-10-26T15:00:00Z');
    const v = (title: string, statusGroup: string, movedAt: string | null = null, updatedAt: string | null = null) => ({ title, statusGroup, movedAt, updatedAt });
    expect(TIMELINER_VIDEO_DAYS).toBe(90);
    expect(offersTimelinerVideo(v('Organic 05', 'toDo'), now)).toBe(true);
    expect(offersTimelinerVideo(v('Organic 05', 'clientApproval'), now)).toBe(true);
    // approved but not posted yet is still open: it's about to go out
    expect(offersTimelinerVideo(v('Organic 05', 'approved', '2026-01-02T00:00:00Z'), now)).toBe(true);
    expect(offersTimelinerVideo(v('Organic 05', 'posted', '2026-08-01T00:00:00Z'), now)).toBe(true);
    expect(offersTimelinerVideo(v('Organic 05', 'posted', '2026-07-01T00:00:00Z'), now)).toBe(false);
    // when it moved there, else when the task last changed; neither known: not offered
    expect(offersTimelinerVideo(v('Organic 05', 'posted', null, '2026-10-20T00:00:00Z'), now)).toBe(true);
    expect(offersTimelinerVideo(v('Organic 05', 'posted', '2026-07-01T00:00:00Z', '2026-10-20T00:00:00Z'), now)).toBe(false);
    expect(offersTimelinerVideo(v('Organic 05', 'posted'), now)).toBe(false);
    // a raw camera clip is never what a thumbnail is for
    expect(offersTimelinerVideo(v('C0045.MP4', 'toDo'), now)).toBe(false);
    expect(offersTimelinerVideo(v('IMG_1234', 'posted', '2026-10-20T00:00:00Z'), now)).toBe(false);
  });

  it('asks to mark a picked brief live once its video is Posted in Timeliner, and never after', async () => {
    const { asksToMarkLive, isPostedVideo } = await import('../shared/workflow');
    const posted = { statusGroup: 'posted' };
    expect(isPostedVideo('posted')).toBe(true);
    expect([isPostedVideo('approved'), isPostedVideo(null), isPostedVideo(undefined)]).toEqual([false, false, false]);
    expect(asksToMarkLive({ state: 'picked', live: null }, posted)).toBe(true);
    expect(asksToMarkLive({ state: 'picked' }, posted)).toBe(true);
    expect(asksToMarkLive({ state: 'picked', live: { publishedOn: '2026-10-26' } }, posted)).toBe(false);
    expect(asksToMarkLive({ state: 'picked', live: null }, { statusGroup: 'approved' })).toBe(false);
    expect(asksToMarkLive({ state: 'picked', live: null }, { statusGroup: null })).toBe(false);
    expect(asksToMarkLive({ state: 'picked', live: null }, null)).toBe(false);
    for (const state of ['to_design', 'drafting', 'in_review', 'changes', 'cancelled'] as const) expect(asksToMarkLive({ state, live: null }, posted)).toBe(false);
  });

  it('keeps the title a Timeliner video filled in with the video picked, and never one typed', async () => {
    const { titleForVideo } = await import('../shared/workflow');
    const rain = { title: 'Rain shell field test' };
    const boots = { title: 'Boots that last ten winters' };
    // an empty title takes the video's
    expect(titleForVideo('', null, rain)).toBe('Rain shell field test');
    expect(titleForVideo('  ', null, rain)).toBe('Rain shell field test');
    // the wrong video picked first: the title it filled follows the new pick, or goes with the link
    expect(titleForVideo('Rain shell field test', 'Rain shell field test', boots)).toBe('Boots that last ten winters');
    expect(titleForVideo('Rain shell field test', 'Rain shell field test', null)).toBe('');
    // a title typed (or typed over) stays whatever is picked
    expect(titleForVideo('Rain shell, day 3', 'Rain shell field test', boots)).toBe('Rain shell, day 3');
    expect(titleForVideo('My own title', null, boots)).toBe('My own title');
    expect(titleForVideo('My own title', null, null)).toBe('My own title');
  });
});

describe('a designer’s portfolio and private growth', () => {
  type Tag = 'text' | 'faces' | 'contrast' | 'composition' | 'brand' | 'crop' | 'other' | null;
  const D = 7;
  const E = 8;
  let ids = 100;
  const decision = (action: 'pick' | 'changes', createdAt: string, o: { optionId?: number; note?: string; standout?: boolean; tags?: Tag[]; id?: number } = {}) => ({
    id: o.id ?? ++ids, action, optionId: o.optionId ?? null, note: o.note ?? (action === 'changes' ? 'Make the face bigger' : null), createdAt,
    standout: !!o.standout, pins: (o.tags ?? []).map((tag) => ({ tag })),
  });
  type Dec = ReturnType<typeof decision>;
  const round = (id: number, number: number, by: number, decisions: Dec[], o: { sent?: boolean; options?: number[] } = {}) => ({
    id, number, sentAt: o.sent === false ? null : '2026-01-01T00:00:00Z', createdById: by,
    options: (o.options ?? [id * 10 + 1, id * 10 + 2]).map((oid) => ({ id: oid, uploadedById: by })), decisions,
  });
  type Round = ReturnType<typeof round>;
  const brief = (rounds: Round[], cancelledAt: string | null = null) => ({ cancelledAt, rounds });
  const clock = { today: '2026-10-26', timezone: 'America/New_York' };

  it('finds a brief’s winner as the database does: the newest decision on the newest sent round', async () => {
    const { briefWin, roundDecision } = await import('../shared/workflow');
    const pick = decision('pick', '2026-10-05T15:00:00Z', { optionId: 11 });
    const again = decision('changes', '2026-10-06T15:00:00Z');
    // whatever order the decisions come in; on the same moment, the later id
    expect(roundDecision([again, pick])?.id).toBe(again.id);
    expect(roundDecision([pick, again])?.id).toBe(again.id);
    const tie = [decision('changes', '2026-10-05T15:00:00Z', { id: 900 }), decision('pick', '2026-10-05T15:00:00Z', { id: 901, optionId: 11 })];
    expect(roundDecision(tie)?.id).toBe(901);
    expect(roundDecision([])).toBeNull();
    expect(briefWin(brief([round(1, 1, D, [pick])]))).toMatchObject({ option: { id: 11, uploadedById: D }, firstRound: true });
    // deciding again with changes takes the win away
    expect(briefWin(brief([round(1, 1, D, [pick, again])]))).toBeNull();
    // a pick on a round a newer one superseded doesn't count, and neither does an unsent tray
    expect(briefWin(brief([round(1, 1, D, [pick]), round(2, 2, D, [])]))).toBeNull();
    expect(briefWin(brief([round(1, 1, D, [pick]), round(2, 2, D, [], { sent: false })]))?.option.id).toBe(11);
    // a cancelled brief has no winner; nor does a pick of an option no longer in the round
    expect(briefWin(brief([round(1, 1, D, [pick])], '2026-10-07T00:00:00Z'))).toBeNull();
    expect(briefWin(brief([round(1, 1, D, [decision('pick', '2026-10-05T15:00:00Z', { optionId: 99 })])]))).toBeNull();
  });

  it('tells the round story: rounds, changes asked and whether the first round won', async () => {
    const { roundStory } = await import('../shared/workflow');
    const b = brief([
      round(1, 1, E, [decision('changes', '2026-09-01T15:00:00Z', { note: 'Not this direction' })], { options: [11, 12, 13] }),
      round(2, 2, D, [decision('changes', '2026-09-03T15:00:00Z', { note: 'Brighter' }), decision('pick', '2026-09-02T15:00:00Z', { optionId: 21 })]),
      round(3, 3, D, []),
      round(4, 4, D, [decision('pick', '2026-09-10T15:00:00Z', { optionId: 41, note: 'The face reads small' })]),
    ]);
    expect(roundStory(b, D)).toEqual({
      rounds: [
        // someone else's round: its options counted, its note left with it
        { number: 1, mine: false, options: 3, outcome: 'changes', note: null },
        // decided again: its newest decision counts
        { number: 2, mine: true, options: 2, outcome: 'changes', note: 'Brighter' },
        // a newer round went before anyone decided
        { number: 3, mine: true, options: 2, outcome: 'none', note: null },
        { number: 4, mine: true, options: 2, outcome: 'picked', note: 'The face reads small' },
      ],
      changesAsked: 2,
      firstRound: false,
    });
    expect(roundStory(brief([round(1, 1, D, [decision('pick', '2026-09-10T15:00:00Z', { optionId: 11 })])]), D)?.firstRound).toBe(true);
    expect(roundStory(brief([round(1, 1, D, [decision('changes', '2026-09-10T15:00:00Z')])]), D)).toBeNull();
  });

  it('counts picks per month, the first-round rate, standouts and note themes, from rows', async () => {
    const { portfolioGrowth, GROWTH_MONTHS } = await import('../shared/workflow');
    expect(GROWTH_MONTHS).toBe(6);
    const october = round(1, 1, D, [decision('pick', '2026-10-05T15:00:00Z', { optionId: 11, standout: true, tags: ['text', 'text', 'faces'] })]);
    const briefs = [
      // picked from the first round, a standout, with three notes
      brief([october]),
      // changes with two notes (one untagged), then picked from round 2
      brief([
        round(2, 1, D, [decision('changes', '2026-09-10T15:00:00Z', { tags: ['contrast', null] })]),
        round(3, 2, D, [decision('pick', '2026-09-20T15:00:00Z', { optionId: 31 })]),
      ]),
      // picked before the window: 11pm on Apr 30 in New York (May 1 in UTC)
      brief([round(4, 1, D, [decision('pick', '2026-05-01T03:00:00Z', { optionId: 41, standout: true, tags: ['brand'] })])]),
      // another designer's win and notes: not theirs
      brief([round(5, 1, E, [decision('pick', '2026-10-01T15:00:00Z', { optionId: 51, standout: true, tags: ['crop'] })])]),
      // their tray, unsent: nothing
      brief([round(6, 1, D, [], { sent: false })]),
    ];
    const g = portfolioGrowth(briefs, D, clock);
    expect(g.months).toEqual([
      { month: '2026-05', picks: 0 }, { month: '2026-06', picks: 0 }, { month: '2026-07', picks: 0 },
      { month: '2026-08', picks: 0 }, { month: '2026-09', picks: 1 }, { month: '2026-10', picks: 1 },
    ]);
    expect(g).toMatchObject({ picks: 2, firstRoundPicks: 1, firstRoundRate: 50, standouts: 1, notes: 5 });
    // most first, then in the tags' own order
    expect(g.themes).toEqual([{ tag: 'text', count: 2 }, { tag: 'faces', count: 1 }, { tag: 'contrast', count: 1 }]);
  });

  it('recomputes after a superseding decision and a cancel', async () => {
    const { portfolioGrowth } = await import('../shared/workflow');
    const pick = decision('pick', '2026-10-05T15:00:00Z', { optionId: 11, standout: true, tags: ['text', 'text', 'faces'] });
    const other = brief([round(2, 1, D, [decision('pick', '2026-09-20T15:00:00Z', { optionId: 21, tags: ['contrast'] })])]);
    const before = portfolioGrowth([brief([round(1, 1, D, [pick])]), other], D, clock);
    expect(before).toMatchObject({ picks: 2, firstRoundPicks: 2, firstRoundRate: 100, standouts: 1, notes: 4 });
    // the manager decides again on that round: changes, with one note. The pick, its standout and its notes go
    const again = decision('changes', '2026-10-06T15:00:00Z', { tags: ['crop'] });
    const superseded = portfolioGrowth([brief([round(1, 1, D, [pick, again])]), other], D, clock);
    expect(superseded).toMatchObject({ picks: 1, firstRoundPicks: 1, firstRoundRate: 100, standouts: 0, notes: 2 });
    expect(superseded.months.find((m) => m.month === '2026-10')?.picks).toBe(0);
    expect(superseded.themes).toEqual([{ tag: 'contrast', count: 1 }, { tag: 'crop', count: 1 }]);
    // then the brief is cancelled: it counts for nothing, its notes included
    const cancelled = portfolioGrowth([brief([round(1, 1, D, [pick, again])], '2026-10-07T12:00:00Z'), other], D, clock);
    expect(cancelled).toMatchObject({ picks: 1, standouts: 0, notes: 1, themes: [{ tag: 'contrast', count: 1 }] });
    // nothing left: no rate rather than 0%
    expect(portfolioGrowth([], D, clock)).toMatchObject({ picks: 0, firstRoundPicks: 0, firstRoundRate: null, standouts: 0, themes: [], notes: 0 });
    expect(portfolioGrowth([], D, clock).months).toHaveLength(6);
  });

  it('filters the wall by client with buttons only while every name fits one', async () => {
    const { clientFilterControl } = await import('../shared/workflow');
    const c = (...names: string[]) => names.map((name) => ({ name }));
    expect(clientFilterControl(c())).toBeNull();
    expect(clientFilterControl(c('Acme'))).toBeNull();
    expect(clientFilterControl(c('Acme', 'Brightline Dental Group'))).toBe('buttons');
    expect(clientFilterControl(c('Acme', 'Brightline', 'Globex'))).toBe('buttons');
    // a fourth client, or one long name (it would run off a phone's panel): the list
    expect(clientFilterControl(c('Acme', 'Brightline', 'Globex', 'Initech'))).toBe('list');
    expect(clientFilterControl(c('Acme', 'The Greater Riverside Community Credit Union & Financial Services Cooperative'))).toBe('list');
    expect(clientFilterControl(c('Acme', 'x'.repeat(24)))).toBe('buttons');
    expect(clientFilterControl(c('Acme', 'x'.repeat(25)))).toBe('list');
  });

  it('shows a growth bar’s month on the wall for every client, since the bars count them all', async () => {
    const { barFilter } = await import('../shared/workflow');
    // filtered to one client: the bar's month shows every client's picks of that month
    expect(barFilter({ month: '' }, '2026-09')).toEqual({ month: '2026-09', clientId: '' });
    expect(barFilter({ month: '2026-10' }, '2026-09')).toEqual({ month: '2026-09', clientId: '' });
    // the month shown pressed again: every win, the client filter as it is
    expect(barFilter({ month: '2026-09' }, '2026-09')).toEqual({ month: '' });
  });
});
