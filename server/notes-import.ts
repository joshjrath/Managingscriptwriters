// Paste notes: someone pastes (or uploads) free-form notes about clients —
// "Elon Layliev, 45 scripts, myth vs fact…" — and Claude reads them into a
// plan of clients, briefings, shoots and batches. The plan is shown as an
// editable preview; nothing is saved until it's confirmed, and then it's all
// saved in one go (or not at all).

import type { FastifyInstance, FastifyRequest } from 'fastify';
// The Claude SDK is loaded the first time notes are read, not at startup, so it
// takes no memory on a server that never uses Paste notes.
import type Anthropic from '@anthropic-ai/sdk';
import * as z4 from 'zod/v4';
import { z } from 'zod';
import type { Db } from './db';
import { clockFor, loadSettings, loadUsers, logActivity, rulesOf, type Ctx } from './core';
import { requireManager } from './auth';
import { HttpError, parse, zs } from './http';
import { insertBatch } from './routes/batches';
import { insertShoot } from './routes/shoots';
import { insertBriefing } from './routes/clients';
import { isISODate, type ISODate } from '../shared/dates';
import { canWrite, evenSplit } from '../shared/workflow';
import { fmtRange, plural } from '../shared/format';
import type { ImportClient, ImportPlan, ImportResult, Me } from '../shared/types';

// ── reading notes (Claude) ───────────────────────────────────────────────

export interface NotesInput {
  text: string;
  files: { name: string; mime: string; data: Buffer }[];
  /** answers to the questions from the last read */
  answers: string | null;
}

export interface NotesContext {
  today: ISODate;
  weekday: string;
  timezone: string;
  draftOffsetDays: number;
  finalOffsetDays: number;
  dayMode: 'calendar' | 'business';
  clients: { name: string; status: string }[];
  team: { name: string; role: string }[];
}

/** PDFs go to Claude as documents; anything else is read as text. */
const isPdf = (f: { name: string; mime: string }) => f.mime === 'application/pdf' || /\.pdf$/i.test(f.name);

export interface NotesReader {
  read(input: NotesInput, context: NotesContext): Promise<Omit<ImportPlan, 'clients'> & { clients: Omit<ImportClient, 'existingClientId'>[] }>;
}

const nullableDate = z4.string().nullable().describe('YYYY-MM-DD, or null when the notes don’t say');
const PlanSchema = z4.object({
  summary: z4.string().describe('One or two plain sentences: what these notes add'),
  clients: z4.array(z4.object({
    name: z4.string().describe('Client name as the team calls them; reuse an existing client’s exact name when it is clearly the same client'),
    status: z4.enum(['active', 'prospect']).describe('prospect only if the notes say they have not signed yet'),
    description: z4.string().nullable().describe('Who they are / the situation (e.g. brand-new account)'),
    brandVoice: z4.string().nullable().describe('Tone and style of their videos'),
    guidance: z4.string().nullable().describe('Standing instructions for writers and the team: formats, posting/scheduling instructions, collaborations, timing preferences. Put suggested new formats here, clearly labelled as suggestions.'),
    briefings: z4.array(z4.object({
      title: z4.string(),
      summary: z4.string().nullable(),
      instructions: z4.string().nullable(),
    })).describe('Topics or content plans, e.g. a day-in-the-life theme'),
    shoots: z4.array(z4.object({
      key: z4.string().describe('Short id like "s1" that batches use to point at this shoot'),
      title: z4.string().nullable(),
      startDate: z4.string().describe('YYYY-MM-DD'),
      endDate: nullableDate,
    })).describe('Only filming dates the notes actually give'),
    batches: z4.array(z4.object({
      title: z4.string(),
      targetCount: z4.number().int().nullable().describe('Number of scripts; null when not stated (never guess)'),
      shootKey: z4.string().nullable(),
      plannedStart: nullableDate.describe('When writing starts, if stated'),
      draftDue: nullableDate.describe('Only if the notes give it, or the normal rule is impossible (see instructions)'),
      finalDue: nullableDate.describe('Same as draftDue'),
      brief: z4.string().nullable(),
      writerNames: z4.array(z4.string()).describe('Team members named as writers; empty if none'),
      nextAction: z4.string().nullable(),
    })).describe('Scripts to write. No batch when the notes say there are no scripts.'),
    notes: z4.array(z4.string()).describe('Anything you assumed or that the team should double-check, for this client'),
  })),
  questions: z4.array(z4.object({
    clientName: z4.string().nullable(),
    question: z4.string().describe('A short question the team can answer'),
    assumed: z4.string().describe('What you assumed for now'),
  })).describe('Only real ambiguities, e.g. which date "next Wednesday" means'),
});

const SYSTEM = `You help a short-form video agency (Scale Media) turn a manager's rough notes into records in their script production app.

The app has:
- Clients (status active, or prospect = potential client not signed yet), each with a description, brand voice and guidance (standing instructions).
- Briefings on a client: a topic or plan with a summary and instructions.
- Shoots: filming dates for a client.
- Batches: a number of scripts to write for a client, optionally tied to a shoot, with an optional writing start date, writers, a brief and a next action. Deadlines are calculated automatically from the shoot (see the rules in the message); only set draftDue/finalDue when the notes state them, or when the automatic dates would fall before writing even starts — then propose sensible dates before the shoot and say so in notes.

How to read the notes:
- Record only what the notes say. Never invent script counts, dates or writers. If a count is unknown, leave targetCount null; if there are no scripts at all, create no batch.
- Resolve relative dates ("next Wednesday", "Friday two days after that") against today's date given in the message. When a date could mean two days, pick the most likely one, use it, and add a question with your assumption.
- Posting and distribution instructions (which account, collaborations, scheduling) belong in guidance. Style and formats belong in brandVoice/guidance. Plans and topics belong in a briefing.
- When the notes ask you to come up with ideas (for example "think of some new formats"), add a few concrete suggestions to guidance, labelled as suggestions.
- Match clients to the existing client list when it is clearly the same client, using the existing spelling.
- Keep wording plain and short, written for the team. Use the client's own words where helpful.`;

function contextText(c: NotesContext) {
  return [
    `Today is ${c.weekday}, ${c.today} (${c.timezone}).`,
    `Deadline rules: drafts are due ${c.draftOffsetDays} ${c.dayMode === 'business' ? 'working' : 'calendar'} days before the first shoot day; final delivery ${c.finalOffsetDays} days before.`,
    `Existing clients: ${c.clients.length ? c.clients.map((x) => `${x.name}${x.status === 'prospect' ? ' (potential)' : x.status === 'archived' ? ' (archived)' : ''}`).join('; ') : 'none yet'}.`,
    `Team: ${c.team.map((t) => `${t.name} (${t.role === 'owner' ? 'admin' : t.role})`).join('; ')}.`,
  ].join('\n');
}

/** The real reader: Claude reads the notes with structured output, so the plan always matches the schema. */
export function claudeNotesReader(given?: Anthropic): NotesReader {
  let client = given;
  return {
    async read(input, context) {
      const { default: SDK } = await import('@anthropic-ai/sdk');
      const { betaZodOutputFormat } = await import('@anthropic-ai/sdk/helpers/beta/zod');
      client ??= new SDK();
      const content: Anthropic.Beta.BetaContentBlockParam[] = [];
      for (const f of input.files) {
        if (isPdf(f)) {
          content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data.toString('base64') }, title: f.name });
        } else {
          content.push({ type: 'text', text: `File "${f.name}":\n${f.data.toString('utf8')}` });
        }
      }
      content.push({ type: 'text', text: `${contextText(context)}\n\nThe notes:\n<notes>\n${input.text}\n</notes>${input.answers ? `\n\nAnswers to your earlier questions:\n<answers>\n${input.answers}\n</answers>` : ''}` });
      let response;
      try {
        response = await client.beta.messages.parse({
          model: 'claude-opus-5-5',
          max_tokens: 16000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default', // if a request is declined, the API retries it on a fallback model
          system: SYSTEM,
          output_config: { effort: 'medium', format: betaZodOutputFormat(PlanSchema) },
          messages: [{ role: 'user', content }],
        });
      } catch (err) {
        // the person sees a plain message; the log keeps the cause and the request id to look it up
        if (err instanceof SDK.APIError) console.warn(`paste notes: Claude API error ${err.status ?? ''} (request ${err.requestID ?? 'n/a'}): ${err.message}`);
        if (err instanceof SDK.AuthenticationError) throw new HttpError(503, 'The AI key on the server isn’t valid. Check ANTHROPIC_API_KEY in your hosting settings.');
        if (err instanceof SDK.NotFoundError || err instanceof SDK.PermissionDeniedError) throw new HttpError(503, 'Reading notes with AI isn’t set up correctly on the server (the model or a feature it needs isn’t available to this key). The server log has the details.');
        if (err instanceof SDK.RateLimitError) throw new HttpError(429, 'Too many notes are being read right now. Try again in a minute.');
        if (err instanceof SDK.BadRequestError) throw new HttpError(400, `Couldn’t read those notes: ${err.message}`);
        if (err instanceof SDK.APIError) throw new HttpError(502, 'The AI service didn’t answer. Try again in a moment — nothing was saved.');
        throw err;
      }
      if (response.stop_reason === 'refusal') throw new HttpError(422, 'Those notes couldn’t be read. Try rewording them or add the information by hand.');
      if (response.stop_reason === 'max_tokens' || !response.parsed_output) throw new HttpError(422, 'Those notes were too long to read in one go. Try pasting fewer clients at a time.');
      return response.parsed_output;
    },
  };
}

// ── checking a plan ──────────────────────────────────────────────────────

const date = z.string().refine((v) => isISODate(v), 'Use a real date');
const dateOrNull = date.nullable();
const planSchema = z.object({
  summary: z.string().max(2000).default(''),
  questions: z.array(z.object({ clientName: z.string().nullable(), question: z.string(), assumed: z.string() })).max(50).default([]),
  clients: z.array(z.object({
    name: zs.name('Client name', 160),
    existingClientId: z.number().int().positive().nullable().default(null),
    status: z.enum(['active', 'prospect']),
    description: z.string().max(4000).nullable(),
    brandVoice: z.string().max(4000).nullable(),
    guidance: z.string().max(8000).nullable(),
    briefings: z.array(z.object({ title: zs.name('Briefing title', 200), summary: z.string().max(4000).nullable(), instructions: z.string().max(8000).nullable() })).max(20),
    shoots: z.array(z.object({ key: z.string().min(1).max(40), title: z.string().max(200).nullable(), startDate: date, endDate: dateOrNull })).max(20),
    batches: z.array(z.object({
      title: zs.name('Batch name', 200), targetCount: z.number().int().min(1).max(500).nullable(), shootKey: z.string().max(40).nullable(),
      plannedStart: dateOrNull, draftDue: dateOrNull, finalDue: dateOrNull, brief: z.string().max(8000).nullable(),
      writerNames: z.array(z.string().max(120)).max(20), nextAction: z.string().max(500).nullable(),
    })).max(20),
    notes: z.array(z.string().max(1000)).max(30).default([]),
  })).min(1, 'Nothing to save').max(40),
});

const clean = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

/** Matches clients to existing ones by name and tidies what the reader returned. */
async function finishPlan(db: Db, raw: Awaited<ReturnType<NotesReader['read']>>): Promise<ImportPlan> {
  const existing = await db.query<{ id: number; name: string }>(`select id, name from clients`);
  const byName = new Map(existing.map((c) => [c.name.trim().toLowerCase(), c]));
  return {
    summary: raw.summary,
    questions: raw.questions,
    clients: raw.clients.map((c) => {
      const match = byName.get(c.name.trim().toLowerCase());
      return {
        ...c,
        name: match?.name ?? c.name.trim(),
        existingClientId: match?.id ?? null,
        description: clean(c.description), brandVoice: clean(c.brandVoice), guidance: clean(c.guidance),
        shoots: c.shoots.filter((s) => isISODate(s.startDate)).map((s) => ({ ...s, endDate: s.endDate && isISODate(s.endDate) ? s.endDate : null })),
        batches: c.batches.map((b) => ({
          ...b,
          plannedStart: b.plannedStart && isISODate(b.plannedStart) ? b.plannedStart : null,
          draftDue: b.draftDue && isISODate(b.draftDue) ? b.draftDue : null,
          finalDue: b.finalDue && isISODate(b.finalDue) ? b.finalDue : null,
          targetCount: b.targetCount && b.targetCount > 0 ? Math.min(500, Math.round(b.targetCount)) : null,
        })),
      };
    }),
  };
}

// ── saving a plan ────────────────────────────────────────────────────────

export async function applyPlan(ctx: Ctx, me: Me, plan: z.infer<typeof planSchema>): Promise<ImportResult> {
  const settings = await loadSettings(ctx.db);
  // editors don't write, so a name in the notes never gives them scripts
  const users = (await loadUsers(ctx.db)).filter((u) => u.active && !u.removed && canWrite(u.role));
  // a full name, or a first name only one person on the team has; otherwise nobody is guessed
  // (the same rule as quick entry), and those scripts stay unassigned with a warning
  const findUser = (name: string) => {
    const n = name.trim().toLowerCase();
    const full = users.find((u) => u.name.toLowerCase() === n);
    if (full) return { u: full, same: [] };
    const same = users.filter((u) => u.name.toLowerCase().split(/\s+/)[0] === n);
    return same.length === 1 ? { u: same[0], same } : { u: undefined, same };
  };
  const warnings: string[] = [];
  const result: ImportResult['clients'] = [];
  await ctx.db.tx(async (t) => {
    const c: Ctx = { ...ctx, db: t };
    const clock = await clockFor(c, settings);
    for (const p of plan.clients) {
      const hasWork = p.shoots.length > 0 || p.batches.some((b) => b.targetCount);
      const lines: string[] = [];
      let row = p.existingClientId
        ? await t.one<{ id: number; name: string; description: string | null; brand_voice: string | null; guidance: string | null; status: string }>(`select id, name, description, brand_voice, guidance, status from clients where id = $1`, [p.existingClientId])
        : await t.one<{ id: number; name: string; description: string | null; brand_voice: string | null; guidance: string | null; status: string }>(`select id, name, description, brand_voice, guidance, status from clients where lower(name) = lower($1) order by id limit 1`, [p.name]);
      const created = !row;
      if (!row) {
        row = await t.one(`insert into clients (name, status, owner_id, description, brand_voice, guidance, created_by) values ($1,$2,$3,$4,$5,$6,$3) returning id, name, description, brand_voice, guidance, status`,
          [p.name, p.status, me.id, p.description, p.brandVoice, p.guidance]);
        await logActivity(t, { actor: me, action: 'client.created', entityType: 'client', entityId: row!.id, clientId: row!.id, summary: `${p.status === 'prospect' ? `Added ${p.name} as a potential client` : `Created client ${p.name}`} (from pasted notes)` });
        lines.push(p.status === 'prospect' ? 'Added as a potential client' : 'New client');
      } else {
        // keep what's there; add the new notes underneath
        const add = (cur: string | null, next: string | null) => (!next || cur?.includes(next) ? cur : cur ? `${cur}\n\n${next}` : next);
        const becomesClient = row.status === 'prospect' && p.status === 'active';
        if (row.status === 'archived' && hasWork) throw new HttpError(409, `${row.name} is archived. Restore them first, or remove their shoots and scripts from the import.`);
        await t.query(
          `update clients set description = $2, brand_voice = $3, guidance = $4, status = case when $5 then 'active' else status end,
                  became_client_at = case when $5 then now() else became_client_at end, updated_at = now() where id = $1`,
          [row.id, add(row.description, p.description), add(row.brand_voice, p.brandVoice), add(row.guidance, p.guidance), becomesClient],
        );
        if (p.description || p.brandVoice || p.guidance) lines.push('Notes added to their guidance');
        if (becomesClient) lines.push('Moved from Potential clients to Clients');
        await logActivity(t, { actor: me, action: 'client.updated', entityType: 'client', entityId: row.id, clientId: row.id, summary: `Added notes for ${row.name} (from pasted notes)` });
      }
      const clientId = row!.id;
      const briefingIds: number[] = [];
      for (const b of p.briefings) {
        const exists = await t.one<{ id: number }>(`select id from briefings where client_id = $1 and lower(title) = lower($2)`, [clientId, b.title]);
        if (exists) { briefingIds.push(exists.id); continue; }
        briefingIds.push(await insertBriefing(t, me, clientId, { title: b.title, callDate: null, recordingUrl: null, documentUrl: null, summary: b.summary, instructions: b.instructions }));
        lines.push(`Briefing: ${b.title}`);
      }
      const shootIds = new Map<string, number>();
      const withShoot = new Set<number>(); // batches already created together with their shoot
      const batchFor = (b: (typeof p.batches)[number]) => {
        const writers = b.writerNames.map((n) => ({ n, ...findUser(n) }));
        for (const w of writers) {
          if (w.u) continue;
          warnings.push(w.same.length
            ? `${p.name}: “${w.n}” could be ${w.same.map((u) => u.name).join(' or ')}, so those scripts are unassigned.`
            : `${p.name}: “${w.n}” isn’t on the team, so those scripts are unassigned.`);
        }
        const ids = [...new Set(writers.map((w) => w.u?.id).filter((x): x is number => !!x))];
        const counts = evenSplit(b.targetCount ?? 0, ids.length);
        return {
          title: b.title, targetCount: b.targetCount!, priority: 'normal' as const, plannedStart: b.plannedStart, draftDue: b.draftDue, finalDue: b.finalDue,
          brief: b.brief, nextAction: b.nextAction, briefingIds, split: ids.map((writerId, i) => ({ writerId, count: counts[i] })),
        };
      };
      for (const s of p.shoots) {
        const same = await t.one<{ id: number }>(`select id from shoots where client_id = $1 and start_date = $2 and cancelled_at is null`, [clientId, s.startDate]);
        const firstIndex = p.batches.findIndex((b) => b.shootKey === s.key && b.targetCount);
        const first = firstIndex >= 0 ? p.batches[firstIndex] : undefined;
        if (same) {
          shootIds.set(s.key, same.id);
          lines.push(`Shoot ${fmtRange(s.startDate, s.endDate)} was already scheduled`);
          continue;
        }
        const out = await insertShoot(t, me, { clientId, title: s.title, startDate: s.startDate, endDate: s.endDate, location: null, notes: null, batch: first ? batchFor(first) : undefined }, settings, clock);
        shootIds.set(s.key, out.shootId);
        lines.push(`Shoot ${fmtRange(s.startDate, s.endDate)}${first ? ` with ${plural(first.targetCount!, 'script')}` : ' (scripts to plan later)'}`);
        if (first) withShoot.add(firstIndex);
        warnings.push(...(out.warnings ?? []).map((w) => `${p.name}: ${w}`));
      }
      for (const [i, b] of p.batches.entries()) {
        if (withShoot.has(i)) continue;
        if (!b.targetCount) { lines.push(`“${b.title}”: no script count yet, so no batch was made`); continue; }
        if (await t.one(`select 1 from batches where client_id = $1 and lower(title) = lower($2) and archived_at is null`, [clientId, b.title])) { lines.push(`Batch “${b.title}” already exists`); continue; }
        const shootId = b.shootKey ? shootIds.get(b.shootKey) ?? null : null;
        const out = await insertBatch(t, me, { ...batchFor(b), clientId, shootId }, settings, clock);
        lines.push(`${plural(b.targetCount, 'script')}: ${b.title}`);
        warnings.push(...out.warnings.map((w) => `${p.name}: ${w}`));
      }
      result.push({ clientId, name: row!.name, created, lines });
    }
  });
  return { clients: result, warnings: [...new Set(warnings)] };
}

// ── routes ───────────────────────────────────────────────────────────────

const FILE_LIMIT = 10 * 1024 * 1024;
// files are held in memory while Claude reads them, so cap the total too
const TOTAL_LIMIT = 20 * 1024 * 1024;
/** pasted text and text files together (PDFs are read as documents); each read is billed by its length */
const TEXT_LIMIT = 60_000;
const ANSWERS_LIMIT = 10_000;
/** each read costs money: one at a time per person, and at most this many an hour */
const READS_PER_HOUR = 30;

export function registerNotesImportRoutes(app: FastifyInstance, ctx: Ctx) {
  const reading = new Set<number>();
  const readsAt = new Map<number, number[]>();

  app.post('/api/import/read', async (req) => {
    const me = requireManager(req);
    if (!ctx.notesReader) throw new HttpError(503, 'Reading notes with AI isn’t set up yet. Add ANTHROPIC_API_KEY to the server’s environment settings.', undefined, 'not_configured');
    if (reading.has(me.id)) throw new HttpError(429, 'Your notes are still being read. Wait for that to finish.');
    reading.add(me.id);
    try {
      return await readNotes(req, ctx.notesReader, me.id);
    } finally {
      reading.delete(me.id);
    }
  });

  /** Counts a read that's about to be sent to the AI (only those cost anything). */
  function allowRead(userId: number) {
    const hourAgo = Date.now() - 3_600_000;
    const recent = (readsAt.get(userId) ?? []).filter((t) => t > hourAgo);
    if (recent.length >= READS_PER_HOUR) throw new HttpError(429, 'That’s a lot of notes read in an hour. Try again a little later.');
    readsAt.set(userId, [...recent, Date.now()]);
  }

  async function readNotes(req: FastifyRequest, reader: NotesReader, userId: number) {
    const input: NotesInput = { text: '', files: [], answers: null };
    if (req.isMultipart()) {
      // A file over the limit comes back cut short (rather than as an error) so it gets its own message
      // below. @fastify/multipart honours throwFileSizeLimit in parts() but its types only list it for files().
      const options = { limits: { fileSize: FILE_LIMIT, files: 5 }, throwFileSizeLimit: false };
      for await (const part of req.parts(options)) {
        if (part.type === 'file') {
          const data = await part.toBuffer();
          if (part.file.truncated) throw new HttpError(413, `“${part.filename}” is over 10 MB`);
          if (input.files.reduce((n, f) => n + f.data.length, data.length) > TOTAL_LIMIT) throw new HttpError(413, 'Those files add up to more than 20 MB. Send fewer at a time.');
          if (!/pdf|text|markdown|csv|json/i.test(part.mimetype) && !/\.(pdf|txt|md|csv)$/i.test(part.filename)) throw new HttpError(400, `“${part.filename}” can’t be read. Use a PDF or a text file, or paste the text.`);
          input.files.push({ name: part.filename, mime: part.mimetype, data });
        } else if (part.fieldname === 'text') input.text = String(part.value ?? '');
        else if (part.fieldname === 'answers') input.answers = String(part.value ?? '') || null;
      }
    } else {
      const body = parse(z.object({ text: z.string().max(TEXT_LIMIT).default(''), answers: z.string().max(ANSWERS_LIMIT).nullable().default(null) }), req.body);
      input.text = body.text;
      input.answers = body.answers;
    }
    input.text = input.text.trim();
    if (!input.text && !input.files.length) throw new HttpError(400, 'Paste your notes or add a file', { text: 'Paste your notes or add a file' });
    const textFiles = input.files.filter((f) => !isPdf(f)).reduce((n, f) => n + f.data.toString('utf8').length, 0);
    if (input.text.length + textFiles > TEXT_LIMIT) throw new HttpError(400, 'That’s a lot of notes — paste up to about 60,000 characters at a time.');
    if ((input.answers?.length ?? 0) > ANSWERS_LIMIT) throw new HttpError(400, 'Keep your answers under 10,000 characters.');
    const settings = await loadSettings(ctx.db);
    const clock = await clockFor(ctx, settings);
    const rules = rulesOf(settings);
    const clients = await ctx.db.query<{ name: string; status: string }>(`select name, status from clients order by lower(name)`);
    // editors don't write, so they're never suggested as writers
    const team = (await loadUsers(ctx.db)).filter((u) => u.active && !u.removed && canWrite(u.role)).map((u) => ({ name: u.name, role: u.role }));
    allowRead(userId);
    const raw = await reader.read(input, {
      today: clock.today, weekday: new Date(`${clock.today}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }), timezone: settings.timezone,
      draftOffsetDays: rules.draftOffsetDays, finalOffsetDays: rules.finalOffsetDays, dayMode: rules.dayMode, clients, team,
    });
    return { plan: await finishPlan(ctx.db, raw) };
  }

  app.post('/api/import/apply', async (req) => {
    const me = requireManager(req);
    const { plan } = parse(z.object({ plan: planSchema }), req.body);
    return applyPlan(ctx, me, plan);
  });
}
