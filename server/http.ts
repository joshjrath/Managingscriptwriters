// Errors, validation and request helpers shared by every route and hook.

import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isISODate } from '../shared/dates';

/**
 * The request's path, decoded and without its query string: what the router
 * matched. Hooks use this rather than the raw URL so an encoded path such as
 * `/%61pi/…` can't reach an API route while skipping the API's checks.
 */
export function requestPath(req: FastifyRequest): string {
  const raw = req.url.split('?')[0];
  try { return decodeURIComponent(raw); } catch { return raw; }
}

export const isApiRequest = (req: FastifyRequest) => requestPath(req).startsWith('/api/');

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public fields?: Record<string, string>,
    public code?: string,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Record') => new HttpError(404, `${what} not found`);
export const forbidden = (msg = 'You don’t have permission to do this') => new HttpError(403, msg);
export const conflict = (msg: string, code = 'conflict') => new HttpError(409, msg, undefined, code);

/** Parse with zod; turn issues into per-field messages the form can show. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const res = schema.safeParse(data ?? {});
  if (res.success) return res.data;
  const fields: Record<string, string> = {};
  for (const issue of res.error.issues) {
    const key = issue.path.join('.') || '_';
    if (!fields[key]) fields[key] = issue.message;
  }
  const first = Object.values(fields)[0] ?? 'Invalid input';
  throw new HttpError(400, Object.keys(fields).length > 1 ? 'Please fix the highlighted fields' : first, fields, 'validation');
}

// ── reusable field schemas ───────────────────────────────────────────────

const trimmed = (max: number) => z.string().trim().max(max, `Keep this under ${max} characters`);
const email = z.string().trim().toLowerCase().email('Enter a valid email').max(200);

export const zs = {
  id: z.coerce.number().int().positive(),
  name: (label = 'Name', max = 160) => trimmed(max).min(1, `${label} is required`),
  /** an email, trimmed and in lower case (as sign-in and Timeliner emails are kept) */
  email,
  /** an email that can be cleared: empty or null clears it */
  emailOrNone: z.preprocess((v) => (typeof v === 'string' && !v.trim() ? null : v), email.nullable()),
  text: (max = 20000) => trimmed(max).transform((v) => v || null).nullable().optional(),
  // a real calendar date (shared rule) in a sane range: a year typed as "26" arrives as 0026, which date maths reads as 1926
  date: z.string().refine((v) => isISODate(v) && v >= '1900-01-01' && v <= '2999-12-31', 'Use a valid date'),
  url: z
    .string()
    .trim()
    .max(2000)
    .transform((v) => v || null)
    .refine((v) => v === null || /^https?:\/\/\S+$/i.test(v), 'Use a full link starting with https://')
    .nullable()
    .optional(),
};

export const optionalDate = zs.date.nullable().optional();
