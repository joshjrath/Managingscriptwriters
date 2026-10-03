import { describe, expect, it } from 'vitest';
import {
  allowedFrom, canSendDocument, checkAction, compressRanges, deriveStage, documentState, evenSplit, isAdmin, isManager, milestone, parseRanges, parseTitleLines, progressLabel, splitAssignments, summarize,
  type ScriptStatus,
} from '../shared/workflow';
import { makeClock } from '../shared/dates';
import { parseEntry } from '../shared/parse';

const scripts = (spec: [ScriptStatus, number][], assignee: number | null = 1) =>
  spec.flatMap(([status, n]) => Array.from({ length: n }, () => ({ status, assigneeId: assignee })));

describe('progress', () => {
  it('shows 20 of 45 draft-ready as “20 / 45 drafts ready · 44%”', () => {
    const p = summarize(scripts([['ready_for_review', 12], ['approved', 8], ['not_started', 25]]));
    expect(p.draftReady).toBe(20);
    expect(p.pctDraft).toBe(44);
    expect(progressLabel(p.draftReady, p.total)).toBe('20 / 45 drafts ready · 44%');
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

describe('script titles', () => {
  it('reads numbered lines and fills plain lines in order', () => {
    expect(parseTitleLines('1. Layer up\n2) Travel kit\n\n3 - Rain-proof', [1, 2, 3])).toEqual([
      { number: 1, title: 'Layer up' }, { number: 2, title: 'Travel kit' }, { number: 3, title: 'Rain-proof' },
    ]);
    expect(parseTitleLines('Why we built it\nThe long way round', [29, 30, 31])).toEqual([
      { number: 29, title: 'Why we built it' }, { number: 30, title: 'The long way round' },
    ]);
  });
  it('continues after a numbered line and clears empty numbered lines', () => {
    expect(parseTitleLines('5. Five\nSix\n7.', [5, 6, 7])).toEqual([
      { number: 5, title: 'Five' }, { number: 6, title: 'Six' }, { number: 7, title: null },
    ]);
  });
  it('ignores numbered lines for scripts outside the set', () => {
    expect(parseTitleLines('13. Not mine\n29. Mine', [29])).toEqual([{ number: 29, title: 'Mine' }]);
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
  });
});
