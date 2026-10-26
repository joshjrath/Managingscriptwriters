// AI brief ideas: in New thumbnail, once a client and the video's title are in, a manager can ask Claude for three
// distinct directions for this one video: what it should show, the words on the image and why it works. Claude reads
// the client's look (name, brand voice and guidance, the brand kit's do's and don'ts), the shoot when one is chosen,
// and what was picked for the client before (its last 10 picked briefs). Nothing is saved: an idea only fills the form.
//
// Only when the server has an ANTHROPIC_API_KEY (ctx.briefHelper; tests pass a stand-in). It mirrors Paste notes
// (server/notes-import.ts): the SDK loaded on first use, structured output with no lengths in the schema (the SDK
// checks its answer against it after the call; tidyThumbIdeas in shared/workflow.ts trims and cuts instead), the same
// error mapping, and one ask at a time per person and 30 an hour.

import type { FastifyInstance } from 'fastify';
// The Claude SDK is loaded the first time ideas are asked for, not at startup, so it takes no memory on a server that
// never uses them.
import type Anthropic from '@anthropic-ai/sdk';
import * as z4 from 'zod/v4';
import { z } from 'zod';
import type { BriefHelper, BriefIdeasInput, Ctx } from './core';
import { requireManager } from './auth';
import { HttpError, parse, zs } from './http';
import { loadClientBrand } from './records';
import { loadWins } from './thumbnails';
import { THUMB_IDEA_COUNT, THUMB_IDEA_LIMITS, tidyThumbIdeas } from '../shared/workflow';
import type { ISODate } from '../shared/dates';
import type { ThumbnailSuggestions } from '../shared/types';

// ── asking Claude ────────────────────────────────────────────────────────

const L = THUMB_IDEA_LIMITS;
const IdeasSchema = z4.object({
  ideas: z4.array(z4.object({
    show: z4.string().describe(`What the thumbnail should show, concretely and visually, in at most ${L.show} characters`),
    words: z4.string().describe(`The words on the image: at most ${L.wordCount} words and ${L.words} characters, never the video's title; empty when it needs none`),
    why: z4.string().describe(`Why this direction works for this video and this client, in at most ${L.why} characters`),
  })).describe(`Exactly ${THUMB_IDEA_COUNT} ideas, each a clearly different direction`),
});

const SYSTEM = `You are a senior YouTube thumbnail strategist. A manager at a video agency is writing the brief for one thumbnail, for one long-form video (16:9) of one client, and asks you for ${THUMB_IDEA_COUNT} distinct directions the designer could take.

For each direction give:
- show: what the thumbnail should show. Concrete and visual: the subject, the expression or action, the setting, what's in the foreground, what's cut. Something a designer can make from the shoot.
- words: the words on the image, at most ${L.wordCount} words. They add to the title and never repeat it. Leave it empty when the picture says enough.
- why: one short reason it earns the click for this video and this client.

How to choose them:
- Make the three really different (a face and an emotion, an object or a result, a before and after, a contrast), not three versions of one idea.
- Fit the client's look: their brand voice, guidance, do's and don'ts, and what was picked for them before.
- No clichés: no red arrows, no circles around things, no shocked faces for their own sake, no "YOU WON'T BELIEVE".
- Never name or suggest real people who aren't in the brief, and never invent facts about the people in the video.
- Plain words, written for the team. Never mention being an AI.`;

function contextText(input: BriefIdeasInput): string {
  const given = (v: string | null) => v?.trim() || 'not given';
  const picked = input.picked.length
    ? input.picked.map((p, i) => `${i + 1}. “${p.title}”. Showed: ${given(p.brief)}. Words on the image: ${given(p.onImage)}`)
    : ['Nothing has been picked for this client yet.'];
  return [
    `The video's working title: ${input.title}`,
    input.shoot ? `From the shoot: ${input.shoot.title?.trim() || 'untitled'} on ${input.shoot.date}` : 'No shoot chosen.',
    '',
    `The client: ${input.client.name}`,
    `- Brand voice: ${given(input.client.brandVoice)}`,
    `- Guidance: ${given(input.client.guidance)}`,
    `- Do: ${given(input.client.dos)}`,
    `- Don’t: ${given(input.client.donts)}`,
    '',
    'Thumbnails picked for this client before, newest first:',
    ...picked,
  ].join('\n');
}

/** The real helper: Claude answers with structured output, so the answer always matches the schema. */
export function claudeBriefHelper(given?: Anthropic): BriefHelper {
  let client = given;
  return {
    async suggest(input) {
      const { default: SDK } = await import('@anthropic-ai/sdk');
      const { betaZodOutputFormat } = await import('@anthropic-ai/sdk/helpers/beta/zod');
      client ??= new SDK();
      let response;
      try {
        response = await client.beta.messages.parse({
          model: 'claude-opus-5-5',
          max_tokens: 4000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default', // if a request is declined, the API retries it on a fallback model
          system: SYSTEM,
          output_config: { effort: 'low', format: betaZodOutputFormat(IdeasSchema) },
          messages: [{ role: 'user', content: [{ type: 'text', text: contextText(input) }] }],
        });
      } catch (err) {
        // the manager sees a plain message; the log keeps the cause and the request id to look it up
        if (err instanceof SDK.APIError) console.warn(`brief ideas: Claude API error ${err.status ?? ''} (request ${err.requestID ?? 'n/a'}): ${err.message}`);
        if (err instanceof SDK.AuthenticationError) throw new HttpError(503, 'The AI key on the server isn’t valid. Check ANTHROPIC_API_KEY in your hosting settings.');
        if (err instanceof SDK.NotFoundError || err instanceof SDK.PermissionDeniedError) throw new HttpError(503, 'Brief ideas aren’t set up correctly on the server (the model or a feature it needs isn’t available to this key). The server log has the details.');
        if (err instanceof SDK.RateLimitError) throw new HttpError(429, 'Too many ideas are being asked for right now. Try again in a minute.');
        if (err instanceof SDK.BadRequestError) throw new HttpError(400, `Couldn’t suggest ideas for this brief: ${err.message}`);
        if (err instanceof SDK.APIError) throw new HttpError(502, 'The AI service didn’t answer. Try again in a moment, or write the brief yourself.');
        throw err;
      }
      if (response.stop_reason === 'refusal') throw new HttpError(422, 'No ideas could be suggested for this title. Try rewording it, or write the brief yourself.');
      if (response.stop_reason === 'max_tokens' || !response.parsed_output) throw new HttpError(422, 'The ideas ran too long and came back unfinished. Try again.');
      return response.parsed_output;
    },
  };
}

// ── the route ────────────────────────────────────────────────────────────

/** each ask costs money: one at a time per person, and at most this many an hour */
const ASKS_PER_HOUR = 30;
/** how many of the client's picked briefs Claude reads */
const PICKED = 10;

const suggestInput = z.object({
  clientId: zs.id,
  shootId: zs.id.nullable().optional(),
  title: zs.name('Title', 200),
});

export function registerBriefIdeaRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;
  const asking = new Set<number>();
  const asksAt = new Map<number, number[]>();

  /** Counts an ask that's about to be sent to the AI (only those cost anything). */
  function allowAsk(userId: number) {
    const hourAgo = Date.now() - 3_600_000;
    const recent = (asksAt.get(userId) ?? []).filter((t) => t > hourAgo);
    if (recent.length >= ASKS_PER_HOUR) throw new HttpError(429, 'That’s a lot of ideas asked for in an hour. Try again a little later.');
    asksAt.set(userId, [...recent, Date.now()]);
  }

  // Three directions for a new brief, for "Suggest ideas" in New thumbnail. Nothing is saved. Off while an Admin views
  // the site as a manager, even in Recording mode: a real read would use that manager's limits.
  app.post('/api/thumbnails/suggest', async (req): Promise<ThumbnailSuggestions> => {
    const me = requireManager(req);
    if (req.viewingAs) throw new HttpError(403, `Brief ideas are off while you’re viewing as ${me.name}.`, undefined, 'viewing_as');
    const input = parse(suggestInput, req.body);
    const client = await db.one<{ name: string; status: string; brand_voice: string | null; guidance: string | null }>(
      `select name, status, brand_voice, guidance from clients where id = $1`, [input.clientId],
    );
    if (!client) throw new HttpError(400, 'Choose a client', { clientId: 'Choose a client' });
    if (client.status === 'archived') throw new HttpError(400, 'This client is archived', { clientId: 'This client is archived' });
    let shoot: BriefIdeasInput['shoot'] = null;
    if (input.shootId) {
      const s = await db.one<{ client_id: number; title: string | null; start_date: ISODate }>(`select client_id, title, start_date from shoots where id = $1`, [input.shootId]);
      if (!s || s.client_id !== input.clientId) throw new HttpError(400, 'Choose a shoot for this client', { shootId: 'Choose a shoot for this client' });
      shoot = { title: s.title, date: s.start_date };
    }
    const helper = ctx.briefHelper;
    if (!helper) throw new HttpError(503, 'Brief ideas aren’t set up yet. Add ANTHROPIC_API_KEY to the server’s environment settings.', undefined, 'not_configured');
    if (asking.has(me.id)) throw new HttpError(429, 'Your last ideas are still coming. Wait for those to finish.');
    asking.add(me.id);
    try {
      const [brand, wins] = await Promise.all([loadClientBrand(db, input.clientId), loadWins(db, { clientId: input.clientId, limit: PICKED })]);
      // the picked briefs, newest pick first: their titles, what they asked to show and the words on the image
      const briefs = wins.length
        ? new Map((await db.query<{ id: number; brief: string | null; on_image: string | null }>(
          `select id, brief, on_image from thumbnail_briefs where id = any($1::bigint[])`, [wins.map((w) => w.briefId)],
        )).map((b) => [Number(b.id), b]))
        : new Map<number, { brief: string | null; on_image: string | null }>();
      allowAsk(me.id);
      const raw = await helper.suggest({
        title: input.title,
        client: { name: client.name, brandVoice: client.brand_voice, guidance: client.guidance, dos: brand?.dos ?? null, donts: brand?.donts ?? null },
        shoot,
        picked: wins.map((w) => ({ title: w.title, brief: briefs.get(w.briefId)?.brief ?? null, onImage: briefs.get(w.briefId)?.on_image ?? null })),
      });
      const ideas = tidyThumbIdeas(raw, input.title);
      if (!ideas) throw new HttpError(422, 'The ideas came back in a form that couldn’t be used. Try again in a moment, or write the brief yourself.');
      return { ideas };
    } finally {
      asking.delete(me.id);
    }
  });
}
