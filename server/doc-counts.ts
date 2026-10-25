// How many scripts a shoot's document holds, read by Claude, for estimating the next shoot (server/forecast.ts).
// A batch's document is its scripts PDF from Timeliner, else the documents its writers sent (each script's newest:
// an uploaded PDF or text file, or a Google Doc or Drive link shared with anyone who has the link). Each document
// is read once and the count kept in `document_counts`, keyed by the document itself, so a new version is read
// again. A document that can't be opened (a private Google Doc, a Word file) keeps why, and its batch counts its
// scripts on the site instead. Script rows stay the truth for progress: this count only paces shoots.

import type Anthropic from '@anthropic-ai/sdk';
import * as z4 from 'zod/v4';
import type { Db } from './db';
import type { Ctx } from './core';
import { HttpError } from './http';

/** One document to count. */
export interface DocRef {
  /** `pdf:<Timeliner task>:<file>` or `sent:<submission id>` */
  key: string;
  batchId: number;
  source: { kind: 'timeliner'; taskId: string } | { kind: 'file'; fileId: number } | { kind: 'url'; url: string };
}

/** What a document's contents are, ready for Claude. */
export type DocContent = { name: string; pdf: Buffer } | { name: string; text: string };

export interface ScriptCounter {
  count(doc: DocContent): Promise<{ scripts: number | null; note: string }>;
}

/** Bigger than this isn't read (Claude takes PDFs up to 32 MB a request). */
const MAX_BYTES = 30 * 1024 * 1024;
/** Text longer than this is sent back as too long rather than cut short. */
const MAX_TEXT = 1_500_000;
/** Documents read in one go, and at once. */
export const READS_PER_RUN = 6;
const AT_ONCE = 3;

const CountSchema = z4.object({
  scripts: z4.number().int().nullable().describe('How many separate scripts the document holds; null when it isn’t scripts or you can’t tell'),
  note: z4.string().describe('One short plain sentence: how the scripts are marked (e.g. "Numbered Script 1 to Script 45"), or why there is no count'),
});

const SYSTEM = `You count the scripts in one document a video production team made for a shoot: short-form video scripts (Reels, TikToks, Shorts, ads), written to be filmed on the shoot day.

A script is one video's script. Scripts are usually numbered or titled ("Script 12", "#12", "12.", "Video 12: …"), each with a hook and lines, sometimes in an Audio | Visual table.

Count each script once. Don't count a cover page, a table of contents or index, notes, a brief, or alternative hooks and captions for the same video. If a script appears twice (a revised version under the original), count it once. When the numbering skips or repeats, count the scripts actually there, not the highest number, and say so in the note.

If the document isn't a set of scripts, or you can't tell how many there are, give null and say why.`;

export function claudeScriptCounter(given?: Anthropic): ScriptCounter {
  let client = given;
  return {
    async count(doc) {
      const { default: SDK } = await import('@anthropic-ai/sdk');
      const { betaZodOutputFormat } = await import('@anthropic-ai/sdk/helpers/beta/zod');
      client ??= new SDK();
      const content: Anthropic.Beta.BetaContentBlockParam[] = 'pdf' in doc
        ? [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: doc.pdf.toString('base64') }, title: doc.name }]
        : [{ type: 'text', text: `Document "${doc.name}":\n<document>\n${doc.text}\n</document>` }];
      content.push({ type: 'text', text: 'How many scripts are in this document?' });
      let response;
      try {
        response = await client.beta.messages.parse({
          model: 'claude-opus-5-5',
          max_tokens: 16000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default', // if a request is declined, the API retries it on a fallback model
          system: SYSTEM,
          output_config: { effort: 'medium', format: betaZodOutputFormat(CountSchema) },
          messages: [{ role: 'user', content }],
        });
      } catch (err) {
        // kept with the document as why it has no count; the log keeps the request id to look it up
        if (err instanceof SDK.APIError) console.warn(`script count: Claude API error ${err.status ?? ''} (request ${err.requestID ?? 'n/a'}): ${err.message}`);
        if (err instanceof SDK.AuthenticationError) throw new HttpError(503, 'The AI key on the server isn’t valid. Check ANTHROPIC_API_KEY in your hosting settings.');
        if (err instanceof SDK.RateLimitError) throw new HttpError(429, 'Too many documents are being read right now. Try again in a minute.');
        if (err instanceof SDK.BadRequestError) return { scripts: null, note: `Claude couldn’t read it: ${err.message}` };
        if (err instanceof SDK.APIError) throw new HttpError(502, 'The AI service didn’t answer. The documents will be read next time.');
        throw err;
      }
      if (response.stop_reason === 'refusal') return { scripts: null, note: 'Claude declined to read this document.' };
      if (!response.parsed_output) return { scripts: null, note: 'Claude’s answer couldn’t be read.' };
      const { scripts, note } = response.parsed_output;
      return { scripts: scripts != null && scripts > 0 && scripts <= 1000 ? scripts : null, note: note.slice(0, 500) };
    },
  };
}

// ── finding a batch's documents ──────────────────────────────────────────

export interface BatchDocs {
  /** the scripts the documents hold, once every one needed is read; null otherwise (count the site's scripts) */
  scripts: number | null;
  /** documents not read yet */
  unread: DocRef[];
}

const inList = (ids: number[], params: unknown[]) => ids.map((id) => { params.push(id); return `$${params.length}`; }).join(',');

/**
 * Each batch's documents and what's known of them. The scripts PDF from Timeliner wins (it's the whole shoot);
 * without one, the documents the writers sent, but only when every script on the site was sent in one (the counts
 * of all of them are added up).
 */
export async function batchDocuments(db: Db, batchIds: number[]): Promise<Map<number, BatchDocs>> {
  const out = new Map<number, BatchDocs>();
  if (!batchIds.length) return out;
  const p1: unknown[] = [];
  const pdfs = await db.query<{ key: string; batch_id: number; file_id: string | null }>(
    `select key, batch_id, file_id from timeliner_pdfs where kind = 'task' and gone_at is null and file_id is not null and batch_id in (${inList(batchIds, p1)})
      order by latest_at desc, key`, p1,
  );
  const p2: unknown[] = [];
  // each script's newest document, and the scripts sent in none
  const sent = await db.query<{ batch_id: number; script_id: number; sub_id: number | null; url: string | null; file_id: number | null }>(
    `select distinct on (sc.id) sc.batch_id, sc.id as script_id, s.id as sub_id, s.url, s.file_id
       from scripts sc left join submission_scripts ss on ss.script_id = sc.id left join submissions s on s.id = ss.submission_id
      where sc.removed_at is null and sc.batch_id in (${inList(batchIds, p2)})
      order by sc.id, s.created_at desc nulls last, s.id desc`, p2,
  );
  const p3: unknown[] = [];
  const counts = new Map((await db.query<{ key: string; scripts: number | null }>(
    `select key, scripts from document_counts where batch_id in (${inList(batchIds, p3)})`, p3,
  )).map((r) => [r.key, r.scripts]));

  for (const id of batchIds) {
    const pdf = pdfs.find((x) => Number(x.batch_id) === id);
    let refs: DocRef[];
    if (pdf) refs = [{ key: `pdf:${pdf.key}:${pdf.file_id}`, batchId: id, source: { kind: 'timeliner', taskId: pdf.key } }];
    else {
      const rows = sent.filter((x) => Number(x.batch_id) === id);
      // a script never sent in a document: the documents don't hold the whole batch
      if (!rows.length || rows.some((x) => x.sub_id == null)) { out.set(id, { scripts: null, unread: [] }); continue; }
      const subs = new Map(rows.map((x) => [Number(x.sub_id), x]));
      refs = [...subs].map(([subId, x]) => ({
        key: `sent:${subId}`, batchId: id,
        source: x.file_id != null ? { kind: 'file' as const, fileId: Number(x.file_id) } : { kind: 'url' as const, url: x.url ?? '' },
      }));
    }
    const unread = refs.filter((r) => !counts.has(r.key));
    const known = refs.map((r) => counts.get(r.key));
    out.set(id, { scripts: !unread.length && known.every((n) => n != null) ? known.reduce<number>((n, c) => n + (c ?? 0), 0) : null, unread });
  }
  return out;
}

// ── opening a document ───────────────────────────────────────────────────

/** Why a document has no count, kept with it. */
class Unreadable extends Error {}

/** The address to download a Google Doc or Drive file from, built from its id (nothing else is fetched). */
export function googleDownload(url: string): { url: string; doc: boolean } | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const id = /\/d\/([A-Za-z0-9_-]{10,})/.exec(u.pathname)?.[1] ?? (/^[A-Za-z0-9_-]{10,}$/.test(u.searchParams.get('id') ?? '') ? u.searchParams.get('id')! : null);
  if (!id) return null;
  if (u.hostname === 'docs.google.com' && u.pathname.startsWith('/document/')) return { url: `https://docs.google.com/document/d/${id}/export?format=txt`, doc: true };
  if (u.hostname === 'drive.google.com') return { url: `https://drive.google.com/uc?export=download&id=${id}`, doc: false };
  return null;
}

const isPdf = (name: string, mime: string) => /application\/pdf/i.test(mime) || /\.pdf$/i.test(name);
const isText = (name: string, mime: string) => /^text\/(plain|markdown|csv)/i.test(mime) || /\.(txt|md|csv)$/i.test(name);

function contentOf(name: string, mime: string, data: Buffer): DocContent {
  if (data.length > MAX_BYTES) throw new Unreadable('It’s too big to read (over 30 MB).');
  if (isPdf(name, mime) || data.subarray(0, 5).toString('latin1') === '%PDF-') return { name, pdf: data };
  if (isText(name, mime)) {
    const text = data.toString('utf8');
    if (text.length > MAX_TEXT) throw new Unreadable('It’s too long to read in one go.');
    return { name, text };
  }
  throw new Unreadable('Only PDFs, Google Docs and text files can be read. Send the scripts as a PDF or a Google Doc.');
}

async function download(ctx: Ctx, url: string, name: string): Promise<DocContent> {
  const res = await (ctx.fetchDoc ?? fetch)(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  const mime = res.headers.get('content-type') ?? '';
  // a private Google Doc answers with its sign-in page
  if (!res.ok || /text\/html/i.test(mime)) throw new Unreadable('It couldn’t be opened. For a Google Doc, set sharing to “Anyone with the link can view”.');
  if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) throw new Unreadable('It’s too big to read (over 30 MB).');
  return contentOf(name, mime, Buffer.from(await res.arrayBuffer()));
}

async function open(ctx: Ctx, ref: DocRef): Promise<DocContent> {
  const s = ref.source;
  if (s.kind === 'file') {
    const f = await ctx.db.one<{ filename: string; mime: string; size: number; data: Uint8Array }>(
      `select filename, mime, size, case when size <= $2 then data end as data from files where id = $1`, [s.fileId, MAX_BYTES]);
    if (!f) throw new Unreadable('The file is gone.');
    if (!f.data) throw new Unreadable('It’s too big to read (over 30 MB).');
    return contentOf(f.filename, f.mime, Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data.buffer, f.data.byteOffset, f.data.byteLength));
  }
  if (s.kind === 'url') {
    const g = googleDownload(s.url);
    if (!g) throw new Unreadable('Only Google Docs and Google Drive links can be read.');
    return download(ctx, g.url, g.doc ? 'Google Doc' : 'Google Drive file');
  }
  if (!ctx.timeliner) throw new Unreadable('Timeliner isn’t connected here.');
  const media = (await ctx.timeliner.task(s.taskId))?.media;
  const url = media && !media.purgedAt && typeof media.downloadUrl === 'string' && /^https:\/\//i.test(media.downloadUrl) ? media.downloadUrl : null;
  if (!url) throw new Unreadable('Timeliner has no file to download on that task.');
  return download(ctx, url, typeof media?.name === 'string' ? media.name : 'Scripts PDF');
}

// ── reading them ─────────────────────────────────────────────────────────

const running = new WeakMap<Db, boolean>();

/**
 * Reads up to `READS_PER_RUN` of these documents with Claude and keeps each count (or why there's none). One run at
 * a time; a run that's already going answers `busy`. A failure of the AI service, the network or Timeliner keeps
 * nothing for the document, so it's read next time (the AI service's own failure stops the run).
 */
export async function readDocuments(ctx: Ctx, refs: DocRef[]): Promise<{ read: number; busy: boolean }> {
  const counter = ctx.scriptCounter;
  if (!counter) throw new HttpError(503, 'Reading documents needs an AI key on the server (ANTHROPIC_API_KEY).');
  if (running.get(ctx.db)) return { read: 0, busy: true };
  running.set(ctx.db, true);
  try {
    const todo = refs.slice(0, READS_PER_RUN);
    let read = 0;
    for (let i = 0; i < todo.length; i += AT_ONCE) {
      await Promise.all(todo.slice(i, i + AT_ONCE).map(async (ref) => {
        let result: { scripts: number | null; note: string };
        try {
          result = await counter.count(await open(ctx, ref));
        } catch (err) {
          if (err instanceof Unreadable) result = { scripts: null, note: err.message };
          else if (err instanceof HttpError) throw err;
          else {
            // no connection, a timeout, Timeliner not answering: nothing is kept, so it's read next time
            console.warn(`script count: couldn't open ${ref.key}: ${err instanceof Error ? err.message : String(err)}`);
            return;
          }
        }
        await ctx.db.query(
          `insert into document_counts (key, batch_id, scripts, note) values ($1, $2, $3, $4)
           on conflict (key) do update set scripts = excluded.scripts, note = excluded.note, read_at = now()`,
          [ref.key, ref.batchId, result.scripts, result.note],
        );
        read++;
      }));
    }
    return { read, busy: false };
  } finally {
    running.delete(ctx.db);
  }
}
