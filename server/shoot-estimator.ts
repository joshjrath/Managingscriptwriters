// Claude estimates each client's next shoot from everything the site knows about their past shoots (server/forecast.ts
// gathers it: shoots on the site and on synced calendars, scripts and the documents that held them, Timeliner's
// scripts PDFs and videos, and the client's own notes). One request covers the clients whose history changed; the
// answers are kept in `shoot_estimates` and only asked for again when a client's history changes.

import type Anthropic from '@anthropic-ai/sdk';
import * as z4 from 'zod/v4';
import { HttpError } from './http';
import { isISODate, type ISODate } from '../shared/dates';

export interface EstimateRequest {
  today: ISODate;
  /** "final scripts 3 calendar days before the shoot, drafts 5" */
  deadlineRule: string;
  /** every client the estimate could be about, as text: the ones to estimate and the rest, for the team's pattern */
  clients: { id: number; name: string; estimate: boolean; history: string }[];
}

export interface EstimateAnswer {
  clientId: number;
  shootDate: ISODate;
  scripts: number | null;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

export interface ShootEstimator {
  estimate(req: EstimateRequest): Promise<EstimateAnswer[]>;
}

const AnswerSchema = z4.object({
  estimates: z4.array(z4.object({
    clientId: z4.number().int().describe('The client’s id, from the history'),
    shootDate: z4.string().describe('The likely next shoot day, YYYY-MM-DD'),
    scripts: z4.number().int().nullable().describe('Scripts the next shoot will need; null when the client doesn’t need scripts'),
    confidence: z4.enum(['high', 'medium', 'low']),
    reasoning: z4.string().describe('One or two short plain sentences for the manager: what the date is based on'),
  })),
});

const SYSTEM = `You help a video production team plan its next shoots. For each client the team writes short-form video scripts, films them at a shoot, edits the footage into videos, and posts those videos over the following weeks. The next shoot has to happen before the last shoot's videos run out, and its scripts are due a few days before it.

You get each client's history: past shoots (from the team's site and from their synced Google Calendars, including the owner's calendar), how many scripts each shoot had (counted in its document when it could be read), when documents and scripts PDFs were sent, the videos made in Timeliner (the editing tool), whether the client needs scripts at all, and the client's own notes (which may say how often they post or film).

Estimate the next shoot for each client you are asked about:
- Go by the client's own rhythm first: the usual days between their shoots, and how many scripts each shoot had (more scripts means more videos, so a longer wait). Use the client's notes when they say how often they post or film.
- Shoots a day or two apart are one shoot. Calendar events that aren't shoots (calls, meetings) aren't shoots.
- With only one past shoot, go by the other clients' rhythm (days per script, or days between shoots) and give low confidence.
- The date is after the last shoot and on a weekday. It may be before today when the client is overdue for a shoot; say so.
- scripts: how many the next shoot will need, usually as many as last time (null when the client doesn't need scripts).
- reasoning: one or two short sentences a busy manager can read at a glance, naming what you based it on.

Return one estimate for every client marked "estimate this one", and none for the others.`;

export function claudeShootEstimator(given?: Anthropic): ShootEstimator {
  let client = given;
  return {
    async estimate(req) {
      const { default: SDK } = await import('@anthropic-ai/sdk');
      const { betaZodOutputFormat } = await import('@anthropic-ai/sdk/helpers/beta/zod');
      client ??= new SDK();
      const text = [
        `Today is ${req.today}. Scripts are due ${req.deadlineRule}.`,
        ...req.clients.map((c) => `<client id="${c.id}" name="${c.name.replace(/"/g, '\'')}"${c.estimate ? ' estimate="estimate this one"' : ''}>\n${c.history}\n</client>`),
      ].join('\n\n');
      let response;
      try {
        response = await client.beta.messages.parse({
          model: 'claude-opus-5-5',
          max_tokens: 16000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default', // if a request is declined, the API retries it on a fallback model
          system: SYSTEM,
          output_config: { effort: 'medium', format: betaZodOutputFormat(AnswerSchema) },
          messages: [{ role: 'user', content: text }],
        });
      } catch (err) {
        if (err instanceof SDK.APIError) console.warn(`shoot estimate: Claude API error ${err.status ?? ''} (request ${err.requestID ?? 'n/a'}): ${err.message}`);
        if (err instanceof SDK.AuthenticationError) throw new HttpError(503, 'The AI key on the server isn’t valid. Check ANTHROPIC_API_KEY in your hosting settings.');
        if (err instanceof SDK.RateLimitError) throw new HttpError(429, 'The AI is busy right now. The estimates will be made next time.');
        if (err instanceof SDK.APIError) throw new HttpError(502, 'The AI service didn’t answer. The estimates will be made next time.');
        throw err;
      }
      if (response.stop_reason === 'refusal' || !response.parsed_output) throw new HttpError(422, 'The AI couldn’t estimate these shoots. The site’s own estimate is shown instead.');
      const asked = new Set(req.clients.filter((c) => c.estimate).map((c) => c.id));
      // keep only well-formed answers about the clients asked about
      return response.parsed_output.estimates
        .filter((e) => asked.has(e.clientId) && isISODate(e.shootDate))
        .map((e) => ({ ...e, scripts: e.scripts != null && e.scripts > 0 && e.scripts <= 500 ? e.scripts : null, reasoning: e.reasoning.slice(0, 600) }));
    },
  };
}
