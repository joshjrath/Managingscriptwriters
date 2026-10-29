// Content roadmaps (the Content tab). A manager uploads a month's long-form roadmap as a PDF; Claude reads it into
// videos, each with its deliverables (what, which day and time, and which role owns it), the roles and the playbook
// (weekly workflow, checklists, what to do if something slips). It's tidied (tidyRoadmap in shared/roadmap.ts), each
// role is given to someone on the site (autoAssign), and it's saved at once. Everyone signed in can read it, and its
// deliverables show on the Calendar. The person on a role, or a manager, marks a deliverable done; managers change
// who is on a role and remove a roadmap.
//
// Reading needs ANTHROPIC_API_KEY (ctx.roadmapReader; tests pass a stand-in). It mirrors Paste notes
// (server/notes-import.ts): the SDK loaded on first use, structured output, the same error mapping, and one read at
// a time per person and 20 an hour. The PDF itself isn't kept, only what was read from it and its file name.

import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type Anthropic from '@anthropic-ai/sdk';
import * as z4 from 'zod/v4';
import { z } from 'zod';
import type { Db } from './db';
import { loadSettings, loadUsers, logActivity, notify, type Ctx } from './core';
import { requireManager, requireUser } from './auth';
import { forbidden, HttpError, notFound, parse, zs } from './http';
import { spool, storedFileName, type UploadedFile } from './files';
import { addDays, diffDays, nowInZone, type ISODate } from '../shared/dates';
import { fmtDate, plural } from '../shared/format';
import { isManager } from '../shared/workflow';
import {
  autoAssign, clockTime, cut, describeOp, ROADMAP_LIMITS, ROADMAP_ROLE_LABEL, ROADMAP_ROLES, ROADMAP_STEP_LABEL, ROADMAP_STEPS, taskState, tidyRoadmap,
  type AssignCandidate, type RoadmapDraft, type RoadmapExtras, type RoadmapOp, type RoadmapRole, type RoadmapStep,
} from '../shared/roadmap';
import type { CalendarEvent, Me, RoadmapDetail, RoadmapListItem, RoadmapTask } from '../shared/types';

// ── reading the PDF ──────────────────────────────────────────────────────

export interface RoadmapReadInput { name: string; pdf: Buffer; today: ISODate; timezone: string }
/** Reads a roadmap PDF: Claude's, when ANTHROPIC_API_KEY is set; tests pass a stand-in. Its answer goes through tidyRoadmap. */
export interface RoadmapReader {
  read(input: RoadmapReadInput): Promise<unknown>;
}

/** Bigger than this isn't read (Claude takes PDFs up to 32 MB a request). */
export const ROADMAP_MAX_BYTES = 30 * 1024 * 1024;

// No field is nullable: an absent value is an empty string (tidyRoadmap reads "" as none). The API compiles the schema
// into a grammar, and nullable fields (a union type each) nested in lists make it too complex to compile (a 400).
const Task = z4.object({
  step: z4.enum(ROADMAP_STEPS).describe('What the deliverable is'),
  title: z4.string().describe('Short name as the team would say it, e.g. "Script draft", "Approve script", "Thumbnail draft", "48-hour check"'),
  date: z4.string().describe('The day it is due, YYYY-MM-DD, with the right year'),
  time: z4.string().describe('The time it is due on a 24-hour clock (HH:MM), or "" when the document gives the default time'),
  role: z4.enum(ROADMAP_ROLES).describe('Who owns it'),
});
export const ROADMAP_SCHEMA = z4.object({
  title: z4.string().describe('The roadmap’s title'),
  month: z4.string().describe('The month its videos are published, YYYY-MM'),
  brand: z4.string().describe('The brand or channel it is for, or ""'),
  summary: z4.string().describe('One or two sentences: who the uploads are for and the month’s goal'),
  timezone: z4.string().describe('The IANA time zone its times are in, e.g. America/New_York for Eastern'),
  defaultTime: z4.string().describe('The time deadlines are due when none is shown (HH:MM, 24-hour), e.g. 17:00'),
  standardTimes: z4.string().describe('The standard times paragraph, as written, or ""'),
  roles: z4.array(z4.object({
    key: z4.enum(ROADMAP_ROLES),
    label: z4.string().describe('The role as the document names it, e.g. "Josh", "Writer", "Host"'),
    person: z4.string().describe('A person’s name when the document names one for this role (e.g. "Josh"), else ""'),
    responsibility: z4.string().describe('What they are responsible for, as written, or ""'),
  })),
  videos: z4.array(z4.object({
    title: z4.string().describe('The video’s title as in the lineup'),
    publishDate: z4.string().describe('YYYY-MM-DD'),
    publishTime: z4.string().describe('HH:MM, 24-hour, or ""'),
    tag: z4.string().describe('Who it is for in one or two words, e.g. "Lawyers", "Dentists", or ""'),
    format: z4.string().describe('What kind of video it is, e.g. "A real choice experiment", or ""'),
    runtime: z4.string().describe('e.g. "10–14 min", or ""'),
    idea: z4.string().describe('The idea, or ""'),
    why: z4.string().describe('Why viewers would watch, or ""'),
    beats: z4.array(z4.object({ title: z4.string(), body: z4.string() })).describe('What happens in the video, in order'),
    thumbnailText: z4.string().describe('The words on the thumbnail, or ""'),
    thumbnailConcept: z4.string().describe('What the thumbnail shows, or ""'),
    prep: z4.string().describe('What to do before filming, and other notes for this video, or ""'),
    tasks: z4.array(Task).describe('Every deliverable for this video, from the brief to the performance reviews'),
  })),
  workflow: z4.array(z4.object({ when: z4.string(), what: z4.string() })).describe('The weekly workflow, step by step'),
  checklist: z4.array(z4.string()).describe('Checks before scheduling an upload'),
  contingency: z4.array(z4.string()).describe('What to do if something is delayed'),
  notes: z4.array(z4.string()).describe('Other notes worth keeping (references, holiday changes, what to measure)'),
});

const SYSTEM = `You read a video team's monthly long-form YouTube roadmap (a PDF) into a production schedule.

Read every page. Use the exact days, times and titles in the document; never invent dates. Write every date as YYYY-MM-DD with the right year (the document usually says which year), and times on a 24-hour clock.

For each video, list every deliverable with its due day, time and owner:
- the brief and title concept locked (step "brief"), from the production calendar when it is only there;
- script draft ("script"), script approved ("approval"), thumbnail draft ("thumbnail_draft"), filming and handing off footage ("film"), any extra writing after filming such as adding real results ("results"), rough edit ("rough_edit"), final thumbnail ("final_thumbnail"), final edit approved ("final_edit"), upload checked and scheduled ("schedule"), publish ("publish");
- performance checks after it goes live ("review"), each as its own deliverable (e.g. "48-hour check" and "7-day review"), attached to the video they review;
- anything else ("other").
Split a deliverable that two roles share into one per role (e.g. "Approved script and thumbnail draft" is an approval by the approver and a thumbnail draft by the thumbnail designer).

Roles: "approver" is whoever approves briefs, scripts and releases (often a named person); "writer" researches and writes the scripts; "host" films and appears on camera; "thumbnail" designs thumbnails; "editor" edits the videos; "other" is anyone else. Give each deliverable the role that owns it, using the document's own "who owns each stage" table. Performance reviews, publishing and scheduling belong to the approver unless the document says otherwise. When a deliverable has the document's default time, give "" for its time. Give "" for anything else the document doesn't say.

Keep the wording plain and close to the document. Never mention being an AI.`;

export function claudeRoadmapReader(given?: Anthropic): RoadmapReader {
  let client = given;
  return {
    async read(input) {
      const { default: SDK } = await import('@anthropic-ai/sdk');
      const { betaZodOutputFormat } = await import('@anthropic-ai/sdk/helpers/beta/zod');
      client ??= new SDK();
      let response;
      try {
        response = await client.beta.messages.parse({
          model: 'claude-opus-5-5',
          max_tokens: 16000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default', // if a request is declined, the API retries it on a fallback model
          system: SYSTEM,
          output_config: { effort: 'medium', format: betaZodOutputFormat(ROADMAP_SCHEMA) },
          messages: [{
            role: 'user',
            content: [
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: input.pdf.toString('base64') }, title: input.name },
              { type: 'text', text: `Today is ${input.today}. The team works in ${input.timezone} unless the document says otherwise. Read this roadmap.` },
            ],
          }],
        });
      } catch (err) {
        // the manager sees a plain message; the log keeps the cause and the request id to look it up
        if (err instanceof SDK.APIError) console.warn(`roadmap: Claude API error ${err.status ?? ''} (request ${err.requestID ?? 'n/a'}): ${err.message}`);
        if (err instanceof SDK.AuthenticationError) throw new HttpError(503, 'The AI key on the server isn’t valid. Check ANTHROPIC_API_KEY in your hosting settings.');
        if (err instanceof SDK.NotFoundError || err instanceof SDK.PermissionDeniedError) throw new HttpError(503, 'Reading roadmaps isn’t set up correctly on the server (the model or a feature it needs isn’t available to this key). The server log has the details.');
        if (err instanceof SDK.RateLimitError) throw new HttpError(429, 'Too many documents are being read right now. Try again in a minute.');
        if (err instanceof SDK.BadRequestError) throw new HttpError(400, `Couldn’t read this PDF: ${err.message}`, { file: `Couldn’t read this PDF (${err.message})` });
        if (err instanceof SDK.APIError) throw new HttpError(502, 'The AI service didn’t answer. Try again in a moment — nothing was saved.');
        throw err;
      }
      if (response.stop_reason === 'refusal') throw new HttpError(422, 'This PDF couldn’t be read as a roadmap. Nothing was saved.');
      if (response.stop_reason === 'max_tokens' || !response.parsed_output) throw new HttpError(422, 'The roadmap was too long to read in one go. Try a shorter PDF — nothing was saved.');
      return response.parsed_output;
    },
  };
}

// ── saving ───────────────────────────────────────────────────────────────

/** Each active person's open work, so a role goes to the least busy: their unfinished scripts and roadmap deliverables. */
async function candidates(db: Db): Promise<AssignCandidate[]> {
  const users = await loadUsers(db);
  const load = new Map<number, number>();
  for (const r of await db.query<{ uid: number; n: number }>(
    `select assignee_id as uid, count(*)::int as n from scripts where removed_at is null and assignee_id is not null and status not in ('approved', 'delivered') group by assignee_id
     union all
     select coalesce(t.assignee_id, r.user_id) as uid, count(*)::int as n from roadmap_tasks t join roadmaps m on m.id = t.roadmap_id and m.removed_at is null
       left join roadmap_roles r on r.roadmap_id = t.roadmap_id and r.key = t.role
      where t.done_at is null and coalesce(t.assignee_id, r.user_id) is not null group by coalesce(t.assignee_id, r.user_id)`,
  )) load.set(Number(r.uid), (load.get(Number(r.uid)) ?? 0) + Number(r.n));
  return users.map((u) => ({ id: u.id, name: u.name, role: u.role, editorKind: u.editorKind, active: u.active, removed: u.removed, load: load.get(u.id) ?? 0 }));
}

/**
 * Saves a tidied roadmap with each role given to someone (autoAssign), and tells each person what they own. With
 * `doneBefore`, deliverables due before that day are marked done by `me` (a roadmap uploaded part-way through).
 */
export async function saveRoadmap(db: Db, draft: RoadmapDraft, opts: { me: Me | null; sourceName: string | null; doneBefore?: ISODate | null }): Promise<number> {
  const people = await candidates(db);
  const id = await db.tx(async (t) => {
    const extras: RoadmapExtras = { standardTimes: draft.standardTimes, workflow: draft.workflow, checklist: draft.checklist, contingency: draft.contingency, notes: draft.notes };
    const row = await t.one<{ id: number }>(
      `insert into roadmaps (title, month, brand, summary, timezone, default_time, extras, source_name, created_by) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) returning id`,
      [draft.title, draft.month, draft.brand, draft.summary, draft.timezone, draft.defaultTime, JSON.stringify(extras), opts.sourceName, opts.me?.id ?? null],
    );
    const rid = Number(row!.id);
    for (const r of draft.roles) {
      await t.query(`insert into roadmap_roles (roadmap_id, key, label, person, responsibility, user_id) values ($1,$2,$3,$4,$5,$6)`,
        [rid, r.key, r.label, r.person, r.responsibility, autoAssign(r, people)]);
    }
    let position = 0;
    for (const v of draft.videos) {
      const vid = await t.one<{ id: number }>(
        `insert into roadmap_videos (roadmap_id, position, title, publish_date, publish_time, tag, format, runtime, idea, why, beats, thumbnail_text, thumbnail_concept, prep)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14) returning id`,
        [rid, ++position, v.title, v.publishDate, v.publishTime, v.tag, v.format, v.runtime, v.idea, v.why, JSON.stringify(v.beats), v.thumbnailText, v.thumbnailConcept, v.prep],
      );
      for (const k of v.tasks) {
        const done = !!opts.doneBefore && k.date < opts.doneBefore;
        await t.query(
          `insert into roadmap_tasks (roadmap_id, video_id, step, title, due_date, due_time, role, done_at, done_by)
           values ($1,$2,$3,$4,$5,$6,$7, case when $8 then now() end, $9)`,
          [rid, vid!.id, k.step, k.title, k.date, k.time, k.role, done, done ? opts.me?.id ?? null : null],
        );
      }
    }
    await logActivity(t, { actor: opts.me, action: 'roadmap.imported', entityType: 'roadmap', entityId: rid, summary: `Added the content roadmap “${draft.title}”` });
    return rid;
  });
  await tellAssigned(db, id, opts.me?.id);
  return id;
}

/** Tells each person on the roadmap what they own (one notification per person per roadmap, refreshed on a change). */
async function tellAssigned(db: Db, roadmapId: number, exceptUserId?: number, only?: number) {
  const rows = await db.query<{ user_id: number; title: string; n: number; first: string | null }>(
    `select x.user_id, m.title, count(*)::int as n, min(x.due_date) filter (where x.done_at is null)::text as first
       from (select coalesce(t.assignee_id, r.user_id) as user_id, t.due_date, t.done_at from roadmap_tasks t
               left join roadmap_roles r on r.roadmap_id = t.roadmap_id and r.key = t.role where t.roadmap_id = $1) x
       join roadmaps m on m.id = $1
      where x.user_id is not null ${only ? 'and x.user_id = $2' : ''}
      group by x.user_id, m.title`, only ? [roadmapId, only] : [roadmapId],
  );
  for (const r of rows) {
    await notify(db, [Number(r.user_id)], {
      type: 'assignment', title: `Content roadmap: ${r.title}`,
      body: `You own ${plural(Number(r.n), 'deliverable')}${r.first ? ` · next due ${fmtDate(r.first)}` : ''}.`,
      link: `/content/${roadmapId}`, dedupeKey: `roadmap:${roadmapId}`, refresh: true,
    }, exceptUserId);
  }
}

// ── loading ──────────────────────────────────────────────────────────────

interface RoadmapRow {
  id: number; title: string; month: string; brand: string | null; summary: string | null; timezone: string; default_time: string;
  extras: RoadmapExtras | string; source_name: string | null; created_at: string; created_by_name: string | null;
}

const asJson = <T>(v: T | string): T => (typeof v === 'string' ? JSON.parse(v) as T : v);

export async function loadRoadmap(db: Db, id: number, now: Date): Promise<RoadmapDetail | null> {
  const r = await db.one<RoadmapRow>(
    `select m.id, m.title, m.month, m.brand, m.summary, m.timezone, m.default_time, m.extras, m.source_name, m.created_at, u.name as created_by_name
       from roadmaps m left join users u on u.id = m.created_by where m.id = $1 and m.removed_at is null`, [id],
  );
  if (!r) return null;
  const roles = await db.query<{ key: RoadmapRole; label: string; person: string | null; responsibility: string | null; user_id: number | null }>(
    `select key, label, person, responsibility, user_id from roadmap_roles where roadmap_id = $1`, [id],
  );
  const videos = await db.query<{
    id: number; position: number; title: string; publish_date: string; publish_time: string | null; tag: string | null; format: string | null; runtime: string | null;
    idea: string | null; why: string | null; beats: unknown; thumbnail_text: string | null; thumbnail_concept: string | null; prep: string | null;
  }>(`select id, position, title, publish_date::text as publish_date, publish_time, tag, format, runtime, idea, why, beats, thumbnail_text, thumbnail_concept, prep
        from roadmap_videos where roadmap_id = $1 order by position, id`, [id]);
  const tasks = await db.query<{ id: number; video_id: number | null; step: RoadmapStep; title: string; due_date: string; due_time: string | null; role: RoadmapRole; assignee_id: number | null; done_at: string | null; done_by_name: string | null }>(
    `select t.id, t.video_id, t.step, t.title, t.due_date::text as due_date, t.due_time, t.role, t.assignee_id, t.done_at, u.name as done_by_name
       from roadmap_tasks t left join users u on u.id = t.done_by where t.roadmap_id = $1 order by t.due_date, coalesce(t.due_time, '17:00'), t.id`, [id],
  );
  const byRole = new Map(roles.map((x) => [x.key, x.user_id == null ? null : Number(x.user_id)]));
  const extras = asJson<RoadmapExtras>(r.extras);
  return {
    id: Number(r.id), title: r.title, month: r.month, brand: r.brand, summary: r.summary, timezone: r.timezone, defaultTime: r.default_time,
    extras: { standardTimes: extras.standardTimes ?? null, workflow: extras.workflow ?? [], checklist: extras.checklist ?? [], contingency: extras.contingency ?? [], notes: extras.notes ?? [] },
    sourceName: r.source_name, createdAt: new Date(r.created_at).toISOString(), createdByName: r.created_by_name,
    now: nowInZone(r.timezone, now),
    roles: roles.sort((a, b) => ROADMAP_ROLES.indexOf(a.key) - ROADMAP_ROLES.indexOf(b.key))
      .map((x) => ({ key: x.key, label: x.label, person: x.person, responsibility: x.responsibility, userId: x.user_id == null ? null : Number(x.user_id) })),
    videos: videos.map((v) => ({
      id: Number(v.id), position: Number(v.position), title: v.title, publishDate: v.publish_date, publishTime: v.publish_time, tag: v.tag, format: v.format,
      runtime: v.runtime, idea: v.idea, why: v.why, beats: asJson(v.beats as RoadmapDetail['videos'][number]['beats'] | string), thumbnailText: v.thumbnail_text,
      thumbnailConcept: v.thumbnail_concept, prep: v.prep,
    })),
    tasks: tasks.map((t): RoadmapTask => ({
      id: Number(t.id), videoId: t.video_id == null ? null : Number(t.video_id), step: t.step, title: t.title, date: t.due_date, time: t.due_time, role: t.role,
      assigneeId: t.assignee_id != null ? Number(t.assignee_id) : byRole.get(t.role) ?? null, ownAssignee: t.assignee_id != null, doneAt: t.done_at ? new Date(t.done_at).toISOString() : null, doneByName: t.done_by_name,
    })),
  };
}

/**
 * Roadmap deliverables for the Calendar, between two days. With `assigneeId`, only that person's (and every video's
 * publish day, which is the whole team's); none when the Calendar is filtered to a client.
 */
export async function roadmapEvents(db: Db, from: ISODate, to: ISODate, now: Date, opts: { assigneeId?: number; clientId?: number } = {}): Promise<CalendarEvent[]> {
  if (opts.clientId) return [];
  const rows = await db.query<{
    id: number; roadmap_id: number; step: RoadmapStep; title: string; due_date: string; due_time: string | null; done_at: string | null;
    video_title: string | null; brand: string | null; timezone: string; default_time: string; user_id: number | null; user_name: string | null;
  }>(
    `select t.id, t.roadmap_id, t.step, t.title, t.due_date::text as due_date, t.due_time, t.done_at, v.title as video_title, m.brand, m.timezone, m.default_time,
            coalesce(t.assignee_id, r.user_id) as user_id, u.name as user_name
       from roadmap_tasks t join roadmaps m on m.id = t.roadmap_id and m.removed_at is null
       left join roadmap_videos v on v.id = t.video_id
       left join roadmap_roles r on r.roadmap_id = t.roadmap_id and r.key = t.role
       left join users u on u.id = coalesce(t.assignee_id, r.user_id)
      where t.due_date between $1 and $2 order by t.due_date, coalesce(t.due_time, m.default_time), t.id`, [from, to],
  );
  return rows
    .filter((t) => !opts.assigneeId || t.step === 'publish' || Number(t.user_id) === opts.assigneeId)
    .map((t) => {
      const state = taskState({ date: t.due_date, time: t.due_time, done: !!t.done_at }, nowInZone(t.timezone, now), t.default_time);
      return {
        id: `c${t.id}`, type: 'content' as const, start: t.due_date, end: t.due_date,
        title: t.step === 'publish' ? `Publish · ${t.video_title ?? t.title}` : `${t.title}${t.video_title ? ` · ${t.video_title}` : ''}`,
        clientName: t.brand ?? 'Content', batchId: null, shootId: null, overdue: state === 'overdue', complete: state === 'done',
        content: { roadmapId: Number(t.roadmap_id), taskId: Number(t.id), step: t.step, time: t.due_time ?? (t.step === 'publish' ? null : t.default_time), assigneeName: t.user_name },
      };
    });
}

// ── changes (by hand, or the assistant's once a manager applies them) ────

const opId = z.number().int().positive();
const hhmm = z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'Use a time like 17:00');
const longText = z.string().max(6000).nullable();
const list = z.array(z.string().max(1000)).max(20);
const brief = {
  publishTime: hhmm.nullable().optional(), tag: z.string().max(200).nullable().optional(), format: z.string().max(300).nullable().optional(),
  runtime: z.string().max(100).nullable().optional(), idea: longText.optional(), why: longText.optional(),
  beats: z.array(z.object({ title: z.string().max(300), body: z.string().max(2000) })).max(12).optional(),
  thumbnailText: z.string().max(200).nullable().optional(), thumbnailConcept: longText.optional(), prep: longText.optional(),
};

/** Each change's fields (without `op`): the changes route takes them, and the assistant's tools are made from them. */
export const ROADMAP_OP_SHAPES = {
  update_roadmap: z.object({
    title: z.string().trim().min(1).max(300).optional(), summary: longText.optional(), standardTimes: longText.optional(), defaultTime: hhmm.optional(),
    workflow: z.array(z.object({ when: z.string().max(200), what: z.string().max(2000) })).max(20).optional(),
    checklist: list.optional(), contingency: list.optional(), notes: list.optional(),
  }),
  add_video: z.object({ title: z.string().trim().min(1).max(300), publishDate: zs.date, ...brief, copyScheduleFrom: opId.optional() }),
  update_video: z.object({ videoId: opId, title: z.string().trim().min(1).max(300).optional(), publishDate: zs.date.optional(), ...brief, moveDeliverables: z.boolean().optional() }),
  remove_video: z.object({ videoId: opId }),
  add_task: z.object({ videoId: opId.nullable(), step: z.enum(ROADMAP_STEPS), title: z.string().max(300).optional(), date: zs.date, time: hhmm.nullable().optional(), role: z.enum(ROADMAP_ROLES), assigneeId: opId.nullable().optional() }),
  update_task: z.object({ taskId: opId, step: z.enum(ROADMAP_STEPS).optional(), title: z.string().trim().min(1).max(300).optional(), date: zs.date.optional(), time: hhmm.nullable().optional(), role: z.enum(ROADMAP_ROLES).optional(), assigneeId: opId.nullable().optional() }),
  remove_task: z.object({ taskId: opId }),
  assign_role: z.object({ role: z.enum(ROADMAP_ROLES), userId: opId.nullable() }),
  assign_video: z.object({ videoId: opId, role: z.enum(ROADMAP_ROLES), userId: opId.nullable() }),
} as const;
export type RoadmapOpName = keyof typeof ROADMAP_OP_SHAPES;

export const ROADMAP_OP = z.discriminatedUnion('op', [
  ROADMAP_OP_SHAPES.update_roadmap.extend({ op: z.literal('update_roadmap') }),
  ROADMAP_OP_SHAPES.add_video.extend({ op: z.literal('add_video') }),
  ROADMAP_OP_SHAPES.update_video.extend({ op: z.literal('update_video') }),
  ROADMAP_OP_SHAPES.remove_video.extend({ op: z.literal('remove_video') }),
  ROADMAP_OP_SHAPES.add_task.extend({ op: z.literal('add_task') }),
  ROADMAP_OP_SHAPES.update_task.extend({ op: z.literal('update_task') }),
  ROADMAP_OP_SHAPES.remove_task.extend({ op: z.literal('remove_task') }),
  ROADMAP_OP_SHAPES.assign_role.extend({ op: z.literal('assign_role') }),
  ROADMAP_OP_SHAPES.assign_video.extend({ op: z.literal('assign_video') }),
]);

const L = ROADMAP_LIMITS;
/** a text change: undefined keeps it, anything else is tidied (empty is null) */
const tidied = (v: string | null | undefined, max: number) => (v === undefined ? undefined : cut(v, max));

/**
 * Applies changes to a roadmap in order, in the caller's transaction: the roadmap row is locked first. A change naming
 * a video or deliverable that isn't on this roadmap, or someone who isn't on the team, is 400 and nothing is kept.
 * Returns each change in plain words and who was given work (to tell them).
 */
export async function applyRoadmapOps(t: Db, me: Me, roadmapId: number, ops: RoadmapOp[], now: Date): Promise<{ lines: string[]; given: number[] }> {
  const m = await t.one<{ title: string; extras: RoadmapExtras | string }>(`select title, extras from roadmaps where id = $1 and removed_at is null for update`, [roadmapId]);
  if (!m) throw notFound('Roadmap');
  const users = await loadUsers(t);
  const nameOf = (id: number) => users.find((u) => u.id === id)?.name ?? 'someone';
  const lines: string[] = [];
  const given = new Set<number>();
  const bad = (i: number, msg: string): never => { throw new HttpError(400, ops.length > 1 ? `Change ${i + 1}: ${msg}` : msg); };
  const person = (i: number, id: number | null | undefined) => {
    if (id == null) return;
    if (!users.some((u) => u.id === id && u.active)) bad(i, 'that person isn’t on the team');
    given.add(id);
  };
  const ensureRole = (key: RoadmapRole) => t.query(`insert into roadmap_roles (roadmap_id, key, label) values ($1, $2, $3) on conflict do nothing`, [roadmapId, key, ROADMAP_ROLE_LABEL[key]]);
  const video = async (i: number, id: number) => {
    const v = await t.one<{ id: number; publish_date: string; publish_time: string | null; title: string }>(
      `select id, publish_date::text as publish_date, publish_time, title from roadmap_videos where id = $1 and roadmap_id = $2`, [id, roadmapId]);
    return v ?? bad(i, 'that video isn’t on this roadmap');
  };
  const task = async (i: number, id: number) => {
    const k = await t.one<{ id: number; video_id: number | null }>(`select id, video_id from roadmap_tasks where id = $1 and roadmap_id = $2`, [id, roadmapId]);
    return k ?? bad(i, 'that deliverable isn’t on this roadmap');
  };
  const set = async (table: string, id: number, fields: Record<string, unknown>) => {
    const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
    if (keys.length) await t.query(`update ${table} set ${keys.map((k, n) => `${k} = $${n + 2}`).join(', ')} where id = $1`, [id, ...keys.map((k) => fields[k])]);
  };
  const briefCols = (op: Partial<Record<keyof typeof brief, unknown>> & { publishTime?: string | null }) => ({
    tag: tidied(op.tag as string | null | undefined, 40), format: tidied(op.format as string | null | undefined, L.short), runtime: tidied(op.runtime as string | null | undefined, 60),
    idea: tidied(op.idea as string | null | undefined, L.text), why: tidied(op.why as string | null | undefined, L.text),
    beats: op.beats === undefined ? undefined : JSON.stringify((op.beats as { title: string; body: string }[]).map((b) => ({ title: cut(b.title, L.short) ?? '', body: cut(b.body, L.item) ?? '' })).filter((b) => b.title || b.body).slice(0, L.beats)),
    thumbnail_text: tidied(op.thumbnailText as string | null | undefined, 80), thumbnail_concept: tidied(op.thumbnailConcept as string | null | undefined, L.text),
    prep: tidied(op.prep as string | null | undefined, L.text),
  });

  for (const [i, op] of ops.entries()) {
    const before = await loadRoadmap(t, roadmapId, now);
    lines.push(describeOp(op, before!, nameOf));
    switch (op.op) {
      case 'update_roadmap': {
        const extras = asJson<RoadmapExtras>(m.extras);
        const items = (v: string[] | undefined) => v?.map((x) => cut(x, L.item)).filter((x): x is string => !!x).slice(0, L.list);
        const next: RoadmapExtras = {
          standardTimes: op.standardTimes === undefined ? extras.standardTimes ?? null : cut(op.standardTimes, L.text),
          workflow: op.workflow ? op.workflow.map((w) => ({ when: cut(w.when, 80) ?? '', what: cut(w.what, L.item) ?? '' })).filter((w) => w.what).slice(0, L.list) : extras.workflow ?? [],
          checklist: items(op.checklist) ?? extras.checklist ?? [], contingency: items(op.contingency) ?? extras.contingency ?? [], notes: items(op.notes) ?? extras.notes ?? [],
        };
        m.extras = next;
        await set('roadmaps', roadmapId, { title: op.title === undefined ? undefined : cut(op.title, L.title), summary: tidied(op.summary, L.text), default_time: op.defaultTime ? clockTime(op.defaultTime) : undefined });
        await t.query(`update roadmaps set extras = $2::jsonb where id = $1`, [roadmapId, JSON.stringify(next)]);
        break;
      }
      case 'add_video': {
        const publishTime = op.publishTime ? clockTime(op.publishTime) : null;
        const row = await t.one<{ id: number }>(
          `insert into roadmap_videos (roadmap_id, position, title, publish_date, publish_time) values ($1, 0, $2, $3, $4) returning id`,
          [roadmapId, cut(op.title, L.title), op.publishDate, publishTime],
        );
        const vid = Number(row!.id);
        await set('roadmap_videos', vid, briefCols(op));
        // its schedule: another video's deliverables, each the same days from its publish day
        const src = op.copyScheduleFrom
          ? await video(i, op.copyScheduleFrom)
          : await t.one<{ id: number; publish_date: string; publish_time: string | null; title: string }>(
            `select id, publish_date::text as publish_date, publish_time, title from roadmap_videos where roadmap_id = $1 and id <> $2
              order by (publish_date > $3::date), abs(publish_date - $3::date), id desc limit 1`, [roadmapId, vid, op.publishDate]);
        const pattern = src ? await t.query<{ step: RoadmapStep; title: string; due_date: string; due_time: string | null; role: RoadmapRole }>(
          `select step, title, due_date::text as due_date, due_time, role from roadmap_tasks where video_id = $1 order by due_date, id`, [src.id]) : [];
        if (!pattern.some((p) => p.step === 'publish')) pattern.push({ step: 'publish', title: 'Publish', due_date: src?.publish_date ?? op.publishDate, due_time: publishTime, role: 'approver' });
        for (const p of pattern) {
          await ensureRole(p.role);
          const date = src ? addDays(op.publishDate, diffDays(p.due_date, src.publish_date)) : op.publishDate;
          await t.query(`insert into roadmap_tasks (roadmap_id, video_id, step, title, due_date, due_time, role) values ($1,$2,$3,$4,$5,$6,$7)`,
            [roadmapId, vid, p.step, p.title, p.step === 'publish' ? op.publishDate : date, p.step === 'publish' ? publishTime ?? p.due_time : p.due_time, p.role]);
        }
        break;
      }
      case 'update_video': {
        const v = await video(i, op.videoId);
        await set('roadmap_videos', v.id, {
          title: op.title === undefined ? undefined : cut(op.title, L.title), publish_date: op.publishDate,
          publish_time: op.publishTime === undefined ? undefined : op.publishTime ? clockTime(op.publishTime) : null, ...briefCols(op),
        });
        if (op.publishDate && op.publishDate !== v.publish_date) {
          if (op.moveDeliverables !== false) {
            await t.query(`update roadmap_tasks set due_date = due_date + $2::int where video_id = $1 and step <> 'publish'`, [v.id, diffDays(op.publishDate, v.publish_date)]);
          }
          await t.query(`update roadmap_tasks set due_date = $2 where video_id = $1 and step = 'publish'`, [v.id, op.publishDate]);
        }
        if (op.publishTime !== undefined) await t.query(`update roadmap_tasks set due_time = $2 where video_id = $1 and step = 'publish'`, [v.id, op.publishTime ? clockTime(op.publishTime) : null]);
        break;
      }
      case 'remove_video': {
        const v = await video(i, op.videoId);
        await t.query(`delete from roadmap_tasks where video_id = $1`, [v.id]);
        await t.query(`delete from roadmap_videos where id = $1`, [v.id]);
        break;
      }
      case 'add_task': {
        if (op.videoId != null) await video(i, op.videoId);
        person(i, op.assigneeId);
        await ensureRole(op.role);
        await t.query(`insert into roadmap_tasks (roadmap_id, video_id, step, title, due_date, due_time, role, assignee_id) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [roadmapId, op.videoId, op.step, cut(op.title, L.short) ?? ROADMAP_STEP_LABEL[op.step], op.date, op.time ? clockTime(op.time) : null, op.role, op.assigneeId ?? null]);
        break;
      }
      case 'update_task': {
        const k = await task(i, op.taskId);
        person(i, op.assigneeId);
        if (op.role) await ensureRole(op.role);
        await set('roadmap_tasks', k.id, {
          step: op.step, title: op.title === undefined ? undefined : cut(op.title, L.short), due_date: op.date,
          due_time: op.time === undefined ? undefined : op.time ? clockTime(op.time) : null, role: op.role, assignee_id: op.assigneeId,
        });
        break;
      }
      case 'remove_task': {
        const k = await task(i, op.taskId);
        await t.query(`delete from roadmap_tasks where id = $1`, [k.id]);
        break;
      }
      case 'assign_role': {
        person(i, op.userId);
        await ensureRole(op.role);
        await t.query(`update roadmap_roles set user_id = $3 where roadmap_id = $1 and key = $2`, [roadmapId, op.role, op.userId]);
        break;
      }
      case 'assign_video': {
        const v = await video(i, op.videoId);
        person(i, op.userId);
        const n = await t.query(`update roadmap_tasks set assignee_id = $3 where video_id = $1 and role = $2 returning id`, [v.id, op.role, op.userId]);
        if (!n.length) bad(i, `“${v.title}” has no ${ROADMAP_ROLE_LABEL[op.role].toLowerCase()} deliverables`);
        break;
      }
    }
  }
  // weeks follow the publish days
  await t.query(
    `update roadmap_videos v set position = x.rn from (select id, row_number() over (order by publish_date, id) as rn from roadmap_videos where roadmap_id = $1) x where v.id = x.id`,
    [roadmapId],
  );
  await logActivity(t, { actor: me, action: 'roadmap.changed', entityType: 'roadmap', entityId: roadmapId, summary: `Changed the content roadmap “${m.title}”: ${lines.join('; ')}`.slice(0, 2000) });
  return { lines, given: [...given].filter((id) => id !== me.id) };
}

// ── routes ───────────────────────────────────────────────────────────────

/** each read costs money: one at a time per person, and at most this many an hour */
const READS_PER_HOUR = 20;

export function registerRoadmapRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;
  const reading = new Set<number>();
  const readsAt = new Map<number, number[]>();

  const live = async (id: number) => {
    const r = await db.one<{ id: number; title: string }>(`select id, title from roadmaps where id = $1 and removed_at is null`, [id]);
    if (!r) throw notFound('Roadmap');
    return r;
  };
  const detail = async (id: number) => {
    const roadmap = await loadRoadmap(db, id, ctx.now());
    if (!roadmap) throw notFound('Roadmap');
    return { roadmap };
  };

  // every roadmap, newest month first, with its counts
  app.get('/api/roadmaps', async (req): Promise<{ roadmaps: RoadmapListItem[] }> => {
    requireUser(req);
    const rows = await db.query<{ id: number; title: string; month: string; brand: string | null; created_at: string; videos: number; tasks: number; done: number }>(
      `select m.id, m.title, m.month, m.brand, m.created_at,
              (select count(*)::int from roadmap_videos v where v.roadmap_id = m.id) as videos,
              (select count(*)::int from roadmap_tasks t where t.roadmap_id = m.id) as tasks,
              (select count(*)::int from roadmap_tasks t where t.roadmap_id = m.id and t.done_at is not null) as done
         from roadmaps m where m.removed_at is null order by m.month desc, m.created_at desc`,
    );
    return { roadmaps: rows.map((r) => ({ id: Number(r.id), title: r.title, month: r.month, brand: r.brand, videos: Number(r.videos), tasks: Number(r.tasks), done: Number(r.done), createdAt: new Date(r.created_at).toISOString() })) };
  });

  app.get('/api/roadmaps/:id', async (req) => {
    requireUser(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    return detail(id);
  });

  // Upload a roadmap PDF: Claude reads it, and it's saved with each role given to someone. Off while an Admin views as
  // someone, even in Recording mode: a real read would use that manager's limits.
  app.post('/api/roadmaps/import', async (req) => {
    const me = requireManager(req);
    if (req.viewingAs) throw new HttpError(403, `Reading a roadmap is off while you’re viewing as ${me.name}.`, undefined, 'viewing_as');
    const reader = ctx.roadmapReader;
    if (!reader) throw new HttpError(503, 'Reading roadmaps isn’t set up yet. Add ANTHROPIC_API_KEY to the server’s environment settings.', undefined, 'not_configured');
    if (!req.isMultipart()) throw new HttpError(400, 'Send the PDF as a form upload', { file: 'Choose a PDF' });
    const limit = Math.min(ctx.uploadLimitBytes, ROADMAP_MAX_BYTES);
    const fields: Record<string, string> = {};
    let file: UploadedFile | null = null;
    for await (const part of req.parts({ limits: { fileSize: limit, files: 1 } })) {
      if (part.type === 'file') file = await spool(req, part, limit);
      else fields[part.fieldname] = String(part.value ?? '');
    }
    if (!file) throw new HttpError(400, 'Choose a PDF to upload', { file: 'Choose a PDF to upload' });
    const pdf = file.data ?? await readFile(file.path!);
    if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new HttpError(400, 'That file isn’t a PDF', { file: 'That file isn’t a PDF' });
    if (reading.has(me.id)) throw new HttpError(429, 'Your last roadmap is still being read. Wait for that one to finish.');
    const hourAgo = Date.now() - 3_600_000;
    const recent = (readsAt.get(me.id) ?? []).filter((t) => t > hourAgo);
    if (recent.length >= READS_PER_HOUR) throw new HttpError(429, 'That’s a lot of roadmaps read in an hour. Try again a little later.');
    readsAt.set(me.id, [...recent, Date.now()]);
    reading.add(me.id);
    try {
      const settings = await loadSettings(db);
      const today = nowInZone(settings.timezone, ctx.now()).date;
      const name = storedFileName(file.filename);
      const draft = tidyRoadmap(await reader.read({ name, pdf, today, timezone: settings.timezone }), settings.timezone);
      if (!draft) throw new HttpError(422, 'No videos with publish dates were found in this PDF. Check it’s the month’s roadmap — nothing was saved.');
      const doneBefore = fields.markPast === '1' ? nowInZone(draft.timezone, ctx.now()).date : null;
      const id = await saveRoadmap(db, draft, { me, sourceName: name, doneBefore });
      return detail(id);
    } finally {
      reading.delete(me.id);
    }
  });

  // who is on a role: every deliverable of that role is theirs
  app.patch('/api/roadmaps/:id/roles/:key', async (req) => {
    const me = requireManager(req);
    const { id, key } = parse(z.object({ id: zs.id, key: z.enum(ROADMAP_ROLES) }), req.params);
    const { userId } = parse(z.object({ userId: zs.id.nullable() }), req.body);
    const m = await live(id);
    const role = await db.one<{ user_id: number | null; label: string }>(`select user_id, label from roadmap_roles where roadmap_id = $1 and key = $2`, [id, key]);
    if (!role) throw notFound('Role');
    if (userId != null) {
      const u = await db.one(`select 1 from users where id = $1 and active and removed_at is null`, [userId]);
      if (!u) throw new HttpError(400, 'Choose someone on the team', { userId: 'Choose someone on the team' });
    }
    if ((role.user_id == null ? null : Number(role.user_id)) !== userId) {
      await db.query(`update roadmap_roles set user_id = $3 where roadmap_id = $1 and key = $2`, [id, key, userId]);
      await logActivity(db, { actor: me, action: 'roadmap.role', entityType: 'roadmap', entityId: id, summary: `${role.label} on “${m.title}” is now ${userId ? (await loadUsers(db)).find((u) => u.id === userId)?.name ?? 'someone' : 'nobody'}` });
      if (userId) await tellAssigned(db, id, me.id, userId);
    }
    return detail(id);
  });

  // a deliverable done (or not after all): by the person on its role, or a manager
  app.post('/api/roadmap-tasks/:id/done', async (req) => {
    const me = requireUser(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const { done } = parse(z.object({ done: z.boolean() }), req.body);
    const t = await db.one<{ roadmap_id: number; title: string; user_id: number | null }>(
      `select t.roadmap_id, t.title, coalesce(t.assignee_id, r.user_id) as user_id from roadmap_tasks t join roadmaps m on m.id = t.roadmap_id and m.removed_at is null
         left join roadmap_roles r on r.roadmap_id = t.roadmap_id and r.key = t.role where t.id = $1`, [id],
    );
    if (!t) throw notFound('Deliverable');
    if (!isManager(me.role) && Number(t.user_id) !== me.id) throw forbidden('Only the person on this deliverable, or a manager, can mark it done.');
    await db.query(
      `update roadmap_tasks set done_at = case when $2 then coalesce(done_at, now()) else null end, done_by = case when $2 then coalesce(done_by, $3) else null end where id = $1`,
      [id, done, me.id],
    );
    return detail(Number(t.roadmap_id));
  });

  // changes by hand, or the assistant's proposal a manager applied: all of them or none
  app.post('/api/roadmaps/:id/changes', async (req) => {
    const me = requireManager(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const { ops } = parse(z.object({ ops: z.array(ROADMAP_OP).min(1, 'Nothing to change').max(40) }), req.body);
    const out = await db.tx((t) => applyRoadmapOps(t, me, id, ops, ctx.now()));
    for (const uid of out.given) await tellAssigned(db, id, me.id, uid);
    return { ...(await detail(id)), lines: out.lines };
  });

  app.delete('/api/roadmaps/:id', async (req) => {
    const me = requireManager(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const m = await live(id);
    await db.query(`update roadmaps set removed_at = now() where id = $1`, [id]);
    await logActivity(db, { actor: me, action: 'roadmap.removed', entityType: 'roadmap', entityId: id, summary: `Removed the content roadmap “${m.title}”` });
    return { ok: true };
  });
}

