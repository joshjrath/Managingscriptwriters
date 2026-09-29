// Quick entry: turns a sentence like
//   "Acme has a shoot October 12–13, 2026, needs 45 scripts, and Sarah is writing them."
// into a structured preview. It is a deterministic, pattern-based parser that
// runs locally — no AI provider. It never guesses: a missing year, an
// ambiguous name or an unknown client becomes a question for the person, and
// nothing is saved until they confirm the structured form.

import { isISODate, makeDate, type ISODate } from './dates';

export interface ParseContext {
  clients: { id: number; name: string; status: 'prospect' | 'active' | 'archived' }[];
  users: { id: number; name: string; active: boolean }[];
  today: ISODate;
}

export type ClientMatch =
  | { kind: 'matched'; id: number; name: string; archived: boolean }
  | { kind: 'ambiguous'; text: string; options: { id: number; name: string }[] }
  | { kind: 'new'; name: string }
  | { kind: 'missing' };

export type DateMatch =
  | { kind: 'ok'; start: ISODate; end: ISODate | null; text: string }
  | { kind: 'needs_year'; text: string; options: { year: number; start: ISODate; end: ISODate | null }[] }
  | { kind: 'ambiguous'; text: string; options: { label: string; start: ISODate; end: ISODate | null }[] }
  | { kind: 'invalid'; text: string; reason: string }
  | { kind: 'missing' };

export type WriterMatch =
  | { kind: 'matched'; text: string; id: number; name: string }
  | { kind: 'ambiguous'; text: string; options: { id: number; name: string }[] }
  | { kind: 'unknown'; text: string };

export interface ParsedEntry {
  client: ClientMatch;
  dates: DateMatch;
  count: number | null;
  writers: WriterMatch[];
  questions: string[];
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const DASH = '\\s*(?:–|—|-|to|through|thru|until|and|&)\\s*';
const ORD = '(?:st|nd|rd|th)?';
const monthNum = (m: string) => MONTHS.indexOf(m.slice(0, 3).toLowerCase()) + 1;

function build(y: number, m: number, d: number, em: number | null, ed: number | null): { start: ISODate; end: ISODate | null } | null {
  const start = makeDate(y, m, d);
  if (!isISODate(start) || Number(start.slice(8)) !== d) return null;
  if (ed == null) return { start, end: null };
  const endMonth = em ?? m;
  const endYear = endMonth < m ? y + 1 : y;
  const end = makeDate(endYear, endMonth, ed);
  if (Number(end.slice(8)) !== ed || end < start) return null;
  return { start, end: end === start ? null : end };
}

export function parseDates(text: string, today: ISODate): DateMatch {
  // 2026-10-12 (– 2026-10-13)
  let m = new RegExp(`(\\d{4}-\\d{2}-\\d{2})(?:${DASH}(\\d{4}-\\d{2}-\\d{2}))?`, 'i').exec(text);
  if (m) {
    const [, a, b] = m;
    if (!isISODate(a) || (b && (!isISODate(b) || b < a))) return { kind: 'invalid', text: m[0], reason: 'That date doesn’t exist or ends before it starts' };
    return { kind: 'ok', start: a, end: b && b !== a ? b : null, text: m[0] };
  }
  // October 12–13, 2026 · Oct 30 – Nov 2 2026 · October 13
  m = new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})${ORD}(?:${DASH}(?:${MONTH_RE}\\s+)?(\\d{1,2})${ORD})?(?:,?\\s+(\\d{4}))?\\b`, 'i').exec(text);
  let parts: { month: number; day: number; endMonth: number | null; endDay: number | null; year: number | null; raw: string } | null = null;
  if (m) {
    parts = { month: monthNum(m[1]), day: Number(m[2]), endMonth: m[3] ? monthNum(m[3]) : null, endDay: m[4] ? Number(m[4]) : null, year: m[5] ? Number(m[5]) : null, raw: m[0] };
  } else {
    // 12–13 October 2026 · 13th of October
    m = new RegExp(`\\b(\\d{1,2})${ORD}(?:${DASH}(\\d{1,2})${ORD})?\\s+(?:of\\s+)?${MONTH_RE}(?:,?\\s+(\\d{4}))?\\b`, 'i').exec(text);
    if (m) parts = { month: monthNum(m[3]), day: Number(m[1]), endMonth: null, endDay: m[2] ? Number(m[2]) : null, year: m[4] ? Number(m[4]) : null, raw: m[0] };
  }
  if (parts) {
    if (parts.year) {
      const r = build(parts.year, parts.month, parts.day, parts.endMonth, parts.endDay);
      return r ? { kind: 'ok', ...r, text: parts.raw.trim() } : { kind: 'invalid', text: parts.raw.trim(), reason: 'That date doesn’t exist or ends before it starts' };
    }
    const y = Number(today.slice(0, 4));
    const options = [y, y + 1]
      .map((year) => ({ year, r: build(year, parts!.month, parts!.day, parts!.endMonth, parts!.endDay) }))
      .filter((o) => o.r)
      .map((o) => ({ year: o.year, ...o.r! }));
    if (!options.length) return { kind: 'invalid', text: parts.raw.trim(), reason: 'That date doesn’t exist' };
    return { kind: 'needs_year', text: parts.raw.trim(), options };
  }
  // 10/12/2026 — ask when both readings are possible
  m = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(text);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : null;
    if (!year) {
      return { kind: 'invalid', text: m[0], reason: 'Add the year, or write the month as a word (e.g. “October 12, 2026”)' };
    }
    const us = build(year, a, b, null, null);
    const eu = build(year, b, a, null, null);
    const opts = [us && { label: 'month/day', ...us }, eu && { label: 'day/month', ...eu }].filter(Boolean) as { label: string; start: ISODate; end: null }[];
    if (!opts.length) return { kind: 'invalid', text: m[0], reason: 'That date doesn’t exist' };
    if (opts.length === 1 || a === b) return { kind: 'ok', start: opts[0].start, end: null, text: m[0] };
    return { kind: 'ambiguous', text: m[0], options: opts };
  }
  return { kind: 'missing' };
}

export function parseCount(text: string): number | null {
  const m = /\b(\d{1,3})\s*(?:new\s+)?(?:scripts?|videos?|ads?|pieces|shorts|reels|spots)\b/i.exec(text);
  return m ? Number(m[1]) : null;
}

const norm = (s: string) =>
  s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(the|co|inc|llc|ltd|company|corp|group)\b/g, ' ').replace(/\s+/g, ' ').trim();

const wordIn = (hay: string, needle: string) => needle.length > 0 && new RegExp(`(^|\\s)${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(hay);

export function matchClient(text: string, clients: ParseContext['clients']): ClientMatch {
  const t = norm(text);
  const full = clients.filter((c) => wordIn(t, norm(c.name)));
  const pickBest = (list: typeof clients) => {
    const active = list.filter((c) => c.status !== 'archived');
    return active.length ? active : list;
  };
  let hits = pickBest(full);
  if (!hits.length) {
    // "Acme" for "Acme Outdoor Co." — the first distinctive word of the name
    hits = pickBest(clients.filter((c) => {
      const first = norm(c.name).split(' ').find((w) => w.length >= 3);
      return first ? wordIn(t, first) : false;
    }));
  }
  if (hits.length === 1) return { kind: 'matched', id: hits[0].id, name: hits[0].name, archived: hits[0].status === 'archived' };
  if (hits.length > 1) return { kind: 'ambiguous', text: hits.map((h) => h.name).join(' / '), options: hits.map((h) => ({ id: h.id, name: h.name })) };
  const lead = /^\s*([A-Z][\w&'’.-]*(?:\s+(?:[A-Z][\w&'’.-]*|&|and|of))*)/.exec(text);
  const name = lead?.[1]?.replace(/\s+(and|of|&)$/i, '').trim();
  if (name && !/^(new|a|an|we|i|our|next|the)$/i.test(name)) return { kind: 'new', name };
  return { kind: 'missing' };
}

export function matchWriters(text: string, users: ParseContext['users'], exclude: string[] = []): WriterMatch[] {
  let t = text;
  for (const e of exclude) t = t.replace(new RegExp(e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
  const active = users.filter((u) => u.active);
  const lower = ` ${t.toLowerCase().replace(/[^a-z' ]+/g, ' ')} `;
  const found: WriterMatch[] = [];
  const used = new Set<number>();
  // full names first, then first names
  for (const u of active) {
    if (lower.includes(` ${u.name.toLowerCase()} `)) { found.push({ kind: 'matched', text: u.name, id: u.id, name: u.name }); used.add(u.id); }
  }
  const byFirst = new Map<string, typeof active>();
  for (const u of active) {
    const f = u.name.split(/\s+/)[0].toLowerCase();
    byFirst.set(f, [...(byFirst.get(f) ?? []), u]);
  }
  for (const [first, list] of byFirst) {
    if (!lower.includes(` ${first} `) && !lower.includes(` ${first}'s `)) continue;
    const remaining = list.filter((u) => !used.has(u.id));
    if (!remaining.length || list.some((u) => used.has(u.id))) continue;
    const label = first[0].toUpperCase() + first.slice(1);
    if (remaining.length === 1) { found.push({ kind: 'matched', text: label, id: remaining[0].id, name: remaining[0].name }); used.add(remaining[0].id); }
    else found.push({ kind: 'ambiguous', text: label, options: remaining.map((u) => ({ id: u.id, name: u.name })) });
  }
  // names in writer phrases that match nobody on the team
  const phrase = /\b([A-Z][a-z]+)\s+(?:is|will be|are)\s+writing\b|\b(?:written by|assigned to|writer:?)\s+([A-Z][a-z]+)/g;
  for (const m of t.matchAll(phrase)) {
    const n = (m[1] ?? m[2])!;
    const known = active.some((u) => u.name.toLowerCase().split(/\s+/).includes(n.toLowerCase()));
    if (!known && !found.some((f) => f.text.toLowerCase() === n.toLowerCase())) found.push({ kind: 'unknown', text: n });
  }
  const pos = (w: WriterMatch) => { const i = lower.indexOf(` ${w.text.toLowerCase()}`); return i < 0 ? Infinity : i; };
  return found.sort((a, b) => pos(a) - pos(b));
}

export function parseEntry(text: string, ctx: ParseContext): ParsedEntry {
  const client = matchClient(text, ctx.clients);
  const dates = parseDates(text, ctx.today);
  const count = parseCount(text);
  const exclude = client.kind === 'matched' ? [client.name, client.name.split(' ')[0]] : client.kind === 'new' ? [client.name] : [];
  const writers = matchWriters(text, ctx.users, exclude);
  const questions: string[] = [];
  if (client.kind === 'missing') questions.push('Which client is this for?');
  if (client.kind === 'ambiguous') questions.push(`Which client did you mean: ${client.options.map((o) => o.name).join(' or ')}?`);
  if (client.kind === 'new') questions.push(`There’s no client called “${client.name}”. Create it as a new client, or pick an existing one?`);
  if (client.kind === 'matched' && client.archived) questions.push(`${client.name} is archived. Restore it on the Clients page first, or pick another client.`);
  if (dates.kind === 'missing') questions.push('When does the shoot start?');
  if (dates.kind === 'needs_year') questions.push(`Which year is “${dates.text}”?`);
  if (dates.kind === 'ambiguous') questions.push(`Is “${dates.text}” month/day or day/month?`);
  if (dates.kind === 'invalid') questions.push(`“${dates.text}”: ${dates.reason}.`);
  if (count == null) questions.push('How many scripts are needed?');
  for (const w of writers) {
    if (w.kind === 'ambiguous') questions.push(`Which ${w.text}: ${w.options.map((o) => o.name).join(' or ')}?`);
    if (w.kind === 'unknown') questions.push(`There’s no team member called “${w.text}”.`);
  }
  return { client, dates, count, writers, questions };
}
