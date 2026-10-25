// A thumbnail designer's AI second look: Claude gives one of their own options a quick, private critique, judged at
// the sizes viewers meet it, against the brief and the client's look (with up to three of the client's picked
// thumbnails as references). It's advice: it never stops a round being sent. One is kept per option, since an
// option's image never changes, so asking again returns the kept one without asking Claude; only its maker ever sees
// it (it rides on that option in the brief's payload for them: present() in server/thumbnails.ts).
//
// Only when the server has an ANTHROPIC_API_KEY (ctx.thumbCritic; tests pass a stand-in). Each person can ask for one
// at a time and 30 an hour, as with Paste notes. An Admin viewing the site as a designer neither sees nor asks for one.

import type { FastifyInstance } from 'fastify';
// The Claude SDK is loaded the first time a second look is asked for, not at startup, so it takes no memory on a
// server that never uses it.
import type Anthropic from '@anthropic-ai/sdk';
import * as z4 from 'zod/v4';
import { z } from 'zod';
import type { CritiqueImage, Ctx, ThumbCritic, ThumbCritiqueInput } from './core';
import { requireUser } from './auth';
import { conflict, HttpError, notFound, parse, zs } from './http';
import { DESIGNER_FILES } from './files';
import { loadWins, requireDesigner, secondLookOf } from './thumbnails';
import {
  SECOND_LOOK_CHECKS, SECOND_LOOK_LIMITS, SECOND_LOOK_MAX_BYTES, SECOND_LOOK_STATUSES, secondLookRefusal, tidySecondLook,
  type OptionLetter, type ThumbMime,
} from '../shared/workflow';
import type { ThumbnailSecondLook } from '../shared/types';

// ── asking Claude ────────────────────────────────────────────────────────

const L = SECOND_LOOK_LIMITS;
// No lengths or counts in the schema itself: the SDK checks its answer against it after the call and would throw
// something that isn't an API error. They're asked for in words, and tidySecondLook (shared/workflow.ts) cuts.
const CritiqueSchema = z4.object({
  oneLiner: z4.string().describe(`The headline: one plain sentence, at most ${L.oneLiner} characters`),
  checks: z4.array(z4.object({
    key: z4.enum(SECOND_LOOK_CHECKS),
    status: z4.enum(SECOND_LOOK_STATUSES).describe('strong: it works well · ok: fine as it is · watch: worth fixing before it goes out'),
    note: z4.string().describe(`Why, specifically, in at most ${L.note} characters`),
  })).describe(`Exactly six checks, one for each key, in this order: ${SECOND_LOOK_CHECKS.join(', ')}`),
  suggestions: z4.array(z4.string().describe(`One concrete change to make in the design file, at most ${L.suggestion} characters`))
    .describe(`0 to ${L.suggestions} suggestions, the most useful first; none when it's ready to go`),
});

const SYSTEM = `You are a senior YouTube thumbnail art director giving a colleague a quick second look at a thumbnail they made for a client's long-form video (16:9), before or just after they send it to the client's manager for review.

Judge it the way viewers meet it: small, in a phone feed, about 120 to 360 pixels wide, beside other videos. Check, in this order:
- reads_small: at feed size, can you tell at a glance what it is?
- focal_point: one clear thing the eye goes to first.
- words: the words on the image. Fewer is better; they must stay legible small and shouldn't repeat the video's title.
- contrast: contrast and separation between the subject, the words and the background.
- brief_fit: does it show what the brief asks for?
- brand_fit: does it fit the client's look (their brand voice and guidance) and the references, which are thumbnails picked for this client before? With no references or guidance, judge it on the brief alone.

For each check give a status (strong, ok or watch) and a short note. Then up to three suggestions: concrete changes the designer can make in the design file (move, enlarge, cut, recolour, crop, relight), the most useful first; none when it's ready.

How to write:
- Specific and kind, in plain words, like a note to a colleague. Say where things are in words (the left third, top right, behind the face).
- No generic tips, no praise padding, no repeating the brief back.
- Never guess or invent facts about the people in the image, and never name anyone.
- Never mention being an AI.
- Under 120 words in all.`;

function contextText(input: ThumbCritiqueInput): string {
  const given = (v: string | null) => v?.trim() || 'not given';
  const refs = input.references.length;
  return [
    'The brief:',
    `- Video title: ${input.brief.title}`,
    `- What it should show: ${given(input.brief.brief)}`,
    `- Words on the image: ${given(input.brief.onImage)}`,
    '',
    `The client: ${input.client.name}`,
    `- Brand voice: ${given(input.client.brandVoice)}`,
    `- Guidance: ${given(input.client.guidance)}`,
    '',
    refs ? `The references: ${refs === 1 ? 'one thumbnail' : `${refs} thumbnails`} picked for this client before, newest first.` : 'No references: nothing has been picked for this client yet.',
  ].join('\n');
}

/** The real critic: Claude answers with structured output, so the answer always matches the schema. */
export function claudeThumbCritic(given?: Anthropic): ThumbCritic {
  let client = given;
  return {
    async critique(input) {
      const { default: SDK } = await import('@anthropic-ai/sdk');
      const { betaZodOutputFormat } = await import('@anthropic-ai/sdk/helpers/beta/zod');
      client ??= new SDK();
      const image = (img: CritiqueImage): Anthropic.Beta.BetaContentBlockParam => ({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.base64 } });
      // the images first (each after its label), then the brief and the client as text
      const content: Anthropic.Beta.BetaContentBlockParam[] = [{ type: 'text', text: 'The option:' }, image(input.option)];
      for (const [i, ref] of input.references.entries()) content.push({ type: 'text', text: `Reference ${i + 1}:` }, image(ref));
      content.push({ type: 'text', text: contextText(input) });
      let response;
      try {
        response = await client.beta.messages.parse({
          model: 'claude-opus-5-5',
          max_tokens: 8000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default', // if a request is declined, the API retries it on a fallback model
          system: SYSTEM,
          output_config: { effort: 'medium', format: betaZodOutputFormat(CritiqueSchema) },
          messages: [{ role: 'user', content }],
        });
      } catch (err) {
        // the designer sees a plain message; the log keeps the cause and the request id to look it up
        if (err instanceof SDK.APIError) console.warn(`second look: Claude API error ${err.status ?? ''} (request ${err.requestID ?? 'n/a'}): ${err.message}`);
        if (err instanceof SDK.AuthenticationError) throw new HttpError(503, 'The AI key on the server isn’t valid. Check ANTHROPIC_API_KEY in your hosting settings.');
        if (err instanceof SDK.NotFoundError || err instanceof SDK.PermissionDeniedError) throw new HttpError(503, 'The second look isn’t set up correctly on the server (the model or a feature it needs isn’t available to this key). The server log has the details.');
        if (err instanceof SDK.RateLimitError) throw new HttpError(429, 'Too many second looks are being asked for right now. Try again in a minute.');
        if (err instanceof SDK.BadRequestError) throw new HttpError(400, `Couldn’t give this image a second look: ${err.message}`);
        if (err instanceof SDK.APIError) throw new HttpError(502, 'The AI service didn’t answer. Try again in a moment. Nothing was kept, and you can still send the round.');
        throw err;
      }
      if (response.stop_reason === 'refusal') throw new HttpError(422, 'This image couldn’t be given a second look. Nothing was kept, and you can still send the round.');
      if (response.stop_reason === 'max_tokens' || !response.parsed_output) throw new HttpError(422, 'The second look ran too long and came back unfinished, so nothing was kept. Try again.');
      return response.parsed_output;
    },
  };
}

// ── the route ────────────────────────────────────────────────────────────

/** each look costs money: one at a time per person, and at most this many an hour */
const LOOKS_PER_HOUR = 30;
/** the request's images together, once base64-encoded: the option, then the references that fit (the API takes 32 MB a request) */
const REQUEST_BUDGET = 24 * 1024 * 1024;
/** the most of the client's picked thumbnails sent beside the option, and how many of the newest are tried */
const REFERENCES = 3;
const REFERENCE_CANDIDATES = 8;
const base64Size = (bytes: number) => Math.ceil(bytes / 3) * 4;

/**
 * A stored file's contents in base64, or null when it has none or is over SECOND_LOOK_MAX_BYTES. In Recording mode the
 * practice copy keeps no file contents: they stay on the real workspace, which is read for them (as GET /api/files/:id
 * does); nothing is ever written there.
 */
async function fileBase64(ctx: Ctx, fileId: number): Promise<string | null> {
  const sql = `select size, octet_length(data) as stored, case when size <= $2 then data end as data from files where id = $1`;
  type Row = { size: number; stored: number; data: Uint8Array | null };
  const here = await ctx.db.one<Row>(sql, [fileId, SECOND_LOOK_MAX_BYTES]);
  if (!here) return null;
  const row = here.stored === 0 && here.size > 0 && ctx.realDb ? await ctx.realDb.one<Row>(sql, [fileId, SECOND_LOOK_MAX_BYTES]) : here;
  const data = row?.data;
  if (!data?.length) return null;
  return (Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength)).toString('base64');
}

const keptLook = async (ctx: Ctx, optionId: number): Promise<ThumbnailSecondLook | null> => {
  const row = await ctx.db.one<{ result: unknown; created_at: string }>(`select result, created_at from thumbnail_second_looks where variant_id = $1`, [optionId]);
  return row ? secondLookOf(optionId, row.result, row.created_at) : null;
};

export function registerSecondLookRoutes(app: FastifyInstance, ctx: Ctx) {
  const looking = new Set<number>();
  const looksAt = new Map<number, number[]>();

  /** Counts a look that's about to be sent to the AI (only those cost anything). */
  function allowLook(userId: number) {
    const hourAgo = Date.now() - 3_600_000;
    const recent = (looksAt.get(userId) ?? []).filter((t) => t > hourAgo);
    if (recent.length >= LOOKS_PER_HOUR) throw new HttpError(429, 'That’s a lot of second looks in an hour. Try again a little later.');
    looksAt.set(userId, [...recent, Date.now()]);
  }

  // A second look on one of the session designer's own live options: in their tray, or in a round they sent (404 for
  // anyone else's, so it doesn't leak). No body. Answers with the look, which is kept. Never for an Admin viewing as
  // the designer (even in Recording mode): it's private to them, and a real read would use their limits.
  app.post('/api/thumbnail-options/:id/second-look', async (req): Promise<ThumbnailSecondLook> => {
    const me = requireUser(req);
    requireDesigner(me);
    if (req.viewingAs) throw new HttpError(403, `A second look is private to ${me.name}, so it’s off while you’re viewing as them.`, undefined, 'viewing_as');
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const o = await ctx.db.one<{
      letter: OptionLetter; mime: ThumbMime; file_id: number; size: number; brief_id: number; title: string; brief: string | null; on_image: string | null;
      client_id: number; client_name: string; brand_voice: string | null; guidance: string | null;
    }>(
      `select v.letter, v.mime, v.file_id, f.size, b.id as brief_id, b.title, b.brief, b.on_image, b.client_id, c.name as client_name, c.brand_voice, c.guidance
         from thumbnail_variants v join thumbnail_rounds r on r.id = v.round_id join thumbnail_briefs b on b.id = r.brief_id
         join clients c on c.id = b.client_id join files f on f.id = v.file_id
        where v.id = $1 and v.removed_at is null and v.uploaded_by = $2
          and ((r.sent_at is null and b.designer_id = $2) or (r.sent_at is not null and r.created_by = $2))`, [id, me.id],
    );
    if (!o) throw notFound('Option');
    // an option's image never changes, so the one kept is the answer (no new read, and it doesn't count towards the hour)
    const kept = await keptLook(ctx, id);
    if (kept) return kept;
    const critic = ctx.thumbCritic;
    if (!critic) throw new HttpError(503, 'The second look isn’t set up yet. Add ANTHROPIC_API_KEY to the server’s environment settings.', undefined, 'not_configured');
    const refusal = secondLookRefusal({ size: o.size });
    if (refusal) throw new HttpError(413, refusal, undefined, 'too_big');
    if (looking.has(me.id)) throw new HttpError(429, 'Your last second look is still being read. Wait for that to finish.');
    looking.add(me.id);
    try {
      const option = await fileBase64(ctx, o.file_id);
      if (!option) throw notFound('Option');
      // up to three of the client's picked thumbnails, newest first: only ones this designer may open, and only while
      // the request stays inside its size budget
      const wins = await loadWins(ctx.db, { clientId: o.client_id, exceptBriefId: o.brief_id, limit: REFERENCE_CANDIDATES });
      const visible = wins.length
        ? new Set((await ctx.db.query<{ id: number }>(`select f.id from files f where f.id = any($1::bigint[]) and ${DESIGNER_FILES('$2')}`, [wins.map((w) => w.option.fileId), me.id])).map((f) => Number(f.id)))
        : new Set<number>();
      let budget = REQUEST_BUDGET - base64Size(o.size);
      const references: CritiqueImage[] = [];
      for (const w of wins) {
        if (references.length >= REFERENCES) break;
        const need = base64Size(w.option.size);
        if (!visible.has(w.option.fileId) || w.option.size > SECOND_LOOK_MAX_BYTES || need > budget) continue;
        const data = await fileBase64(ctx, w.option.fileId);
        if (!data) continue;
        references.push({ mime: w.option.mime, base64: data });
        budget -= need;
      }
      allowLook(me.id);
      const raw = await critic.critique({
        option: { mime: o.mime, base64: option }, references,
        brief: { title: o.title, brief: o.brief, onImage: o.on_image },
        client: { name: o.client_name, brandVoice: o.brand_voice, guidance: o.guidance },
      });
      const result = tidySecondLook(raw);
      if (!result) throw new HttpError(502, 'The second look came back in a form that couldn’t be used, so nothing was kept. Try again in a moment.');
      // kept only while the option is still live (it may have been taken out of the tray while Claude looked)
      await ctx.db.query(
        `insert into thumbnail_second_looks (variant_id, requested_by, result)
         select $1::bigint, $2::bigint, $3::jsonb where exists (select 1 from thumbnail_variants where id = $1::bigint and removed_at is null)
         on conflict (variant_id) do nothing`,
        [id, me.id, JSON.stringify(result)],
      );
      const look = await keptLook(ctx, id);
      if (!look) throw conflict(`Option ${o.letter} was taken out of your tray while it was being looked at, so its second look wasn’t kept. The page has been refreshed.`, 'removed');
      return look;
    } finally {
      looking.delete(me.id);
    }
  });
}
