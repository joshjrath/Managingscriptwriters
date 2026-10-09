// Editors: people the admin keeps a list of, with their city, local time and
// working hours, who don't use the platform itself. They
// can't sign in and are never offered as writers, so they live in their own
// table rather than as team members. Each may have the email Timeliner knows
// them by: the Editors tab matches a Timeliner member to them by it first,
// then by name.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../core';
import type { Db } from '../db';
import { emailHolder, emailTakenWords, logActivity } from '../core';
import { requireAdmin } from '../auth';
import { HttpError, notFound, parse, zs } from '../http';
import { cityLabel, findCity, shiftOf, zoneFor } from '../../shared/cities';
import { isValidTimeZone } from '../../shared/dates';
import type { Editor } from '../../shared/types';

interface EditorRow {
  id: number; name: string; city: string; city_code: string; country: string; lat: number; lon: number;
  timezone: string; work_start: number; work_end: number; timeliner_email: string | null;
}

export async function loadEditorRows(db: Db): Promise<EditorRow[]> {
  return db.query<EditorRow>(
    `select id, name, city, city_code, country, lat, lon, timezone, work_start, work_end, timeliner_email from editors where removed_at is null order by name`,
  );
}

const toEditor = (r: EditorRow): Editor => ({
  id: r.id, name: r.name, city: cityLabel({ name: r.city, country: r.country }), timezone: r.timezone, workHours: [r.work_start, r.work_end], timelinerEmail: r.timeliner_email,
});

export function registerEditorRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;
  const input = z.object({
    name: zs.name('Name', 120),
    city: z.string().trim().min(1, 'Pick a city from the list').max(120),
    /** defaults to the city's */
    timezone: z.string().trim().refine(isValidTimeZone, 'Pick a time zone from the list').optional(),
    workStart: z.coerce.number().int().min(0).max(23).default(9),
    workEnd: z.coerce.number().int().min(0).max(47).default(18),
    /** the email Timeliner knows them by (empty or null: none) */
    timelinerEmail: zs.emailOrNone.optional(),
  });
  /** An edit: only what's sent changes (the Editors tab links someone by sending just their Timeliner email). */
  const changes = z.object({
    name: zs.name('Name', 120).optional(),
    city: z.string().trim().min(1, 'Pick a city from the list').max(120).optional(),
    timezone: z.string().trim().refine(isValidTimeZone, 'Pick a time zone from the list').optional(),
    workStart: z.coerce.number().int().min(0).max(23).optional(),
    workEnd: z.coerce.number().int().min(0).max(47).optional(),
    timelinerEmail: zs.emailOrNone.optional(),
  });
  /** Nobody on the team signs in with it or has it as their Timeliner email, and nobody else here has it (409, naming who does). */
  const timelinerEmailFree = async (value: string, exceptEditorId?: number) => {
    const who = await emailHolder(db, value, { exceptEditorId, editors: true });
    if (who) throw new HttpError(409, emailTakenWords(who), { timelinerEmail: who.how === 'sign-in' ? `${who.name} signs in with it` : `${who.name}’s Timeliner email` }, 'duplicate');
  };
  /** The city, time zone and hours as columns; the end of a shift that passes midnight is stored past 24. */
  const place = (v: z.infer<typeof input>, current?: EditorRow | null) => {
    const c = findCity(v.city);
    if (!c) throw new HttpError(400, 'Pick a city from the list', { city: 'Pick a city from the list' });
    const [, end] = shiftOf(v.workStart, v.workEnd);
    return [c.name, c.code, c.country, c.lat, c.lon, zoneFor(c, v.timezone, current), v.workStart, end] as const;
  };
  const list = async () => ({ editors: (await loadEditorRows(db)).map(toEditor) });

  app.get('/api/editors', async (req) => {
    requireAdmin(req, 'Only admins can manage editors');
    return list();
  });

  app.post('/api/editors', async (req) => {
    const me = requireAdmin(req, 'Only admins can manage editors');
    const v = parse(input, req.body);
    const tl = v.timelinerEmail ?? null;
    if (tl) await timelinerEmailFree(tl);
    const row = await db.one<{ id: number }>(
      `insert into editors (name, city, city_code, country, lat, lon, timezone, work_start, work_end, created_by, timeliner_email)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`, [v.name, ...place(v), me.id, tl],
    );
    await logActivity(db, { actor: me, action: 'editor.created', entityType: 'editor', entityId: row!.id, summary: `Added editor ${v.name} (${v.city.split(',')[0]})${tl ? `, Timeliner email ${tl}` : ''}` });
    return list();
  });

  app.patch('/api/editors/:id', async (req) => {
    const me = requireAdmin(req, 'Only admins can manage editors');
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const c = parse(changes, req.body);
    const current = await db.one<EditorRow>(`select * from editors where id = $1 and removed_at is null`, [id]);
    if (!current) throw notFound('Editor');
    // what isn't sent stays as it is (the time zone too, while the city stays the same)
    const city = c.city ?? cityLabel({ name: current.city, country: current.country });
    const v = {
      name: c.name ?? current.name, city, timezone: c.timezone ?? (c.city === undefined ? current.timezone : undefined),
      workStart: c.workStart ?? Number(current.work_start), workEnd: c.workEnd ?? Number(current.work_end),
    };
    const tl = c.timelinerEmail !== undefined ? c.timelinerEmail : current.timeliner_email;
    const tlChanged = (tl ?? null) !== (current.timeliner_email ?? null);
    if (tl && tlChanged) await timelinerEmailFree(tl, id);
    const rows = await db.query(
      `update editors set name = $2, city = $3, city_code = $4, country = $5, lat = $6, lon = $7, timezone = $8, work_start = $9, work_end = $10, timeliner_email = $11, updated_at = now()
        where id = $1 and removed_at is null returning id`, [id, v.name, ...place(v, current), tl],
    );
    if (!rows.length) throw notFound('Editor');
    await logActivity(db, {
      actor: me, action: 'editor.updated', entityType: 'editor', entityId: id,
      summary: `Updated editor ${v.name}${tlChanged ? (tl ? `: Timeliner email → ${tl}` : ': Timeliner email cleared') : ''}`,
    });
    return list();
  });

  app.delete('/api/editors/:id', async (req) => {
    const me = requireAdmin(req, 'Only admins can manage editors');
    const { id } = parse(z.object({ id: zs.id }), req.params);
    // ?reason=access: they were given a sign-in, so they're on the team now rather than removed
    const access = (req.query as { reason?: string } | undefined)?.reason === 'access';
    const r = await db.one<{ name: string }>(`update editors set removed_at = now() where id = $1 and removed_at is null returning name`, [id]);
    if (!r) throw notFound('Editor');
    await logActivity(db, { actor: me, action: access ? 'editor.access' : 'editor.removed', entityType: 'editor', entityId: id, summary: access ? `Gave ${r.name} site access (now on the team as an editor)` : `Removed editor ${r.name}` });
    return list();
  });
}
