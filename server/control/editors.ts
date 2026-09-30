// Editors: people the admin wants to see in the Control Center, with their
// city, local time and working hours, who don't use the platform itself. They
// can't sign in and are never offered as writers, so they live in their own
// table rather than as team members.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../core';
import type { Db } from '../db';
import { logActivity } from '../core';
import { requireUser } from '../auth';
import { HttpError, notFound, parse, zs } from '../http';
import { findCity, cityLabel } from '../../shared/cities';
import type { Editor } from '../../shared/types';
import { isAdmin } from './access';

interface EditorRow {
  id: number; name: string; city: string; city_code: string; country: string; lat: number; lon: number;
  timezone: string; work_start: number; work_end: number;
}

export async function loadEditorRows(db: Db): Promise<EditorRow[]> {
  return db.query<EditorRow>(
    `select id, name, city, city_code, country, lat, lon, timezone, work_start, work_end from editors where removed_at is null order by name`,
  );
}

const toEditor = (r: EditorRow): Editor => ({ id: r.id, name: r.name, city: cityLabel({ name: r.city, country: r.country }), workHours: [r.work_start, r.work_end] });

export function registerEditorRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;
  const requireAdmin = (req: Parameters<typeof requireUser>[0]) => {
    const me = requireUser(req);
    if (!isAdmin(me.role)) throw new HttpError(403, 'Only admins can manage editors');
    return me;
  };
  const input = z.object({
    name: zs.name('Name', 120),
    city: z.string().trim().min(1, 'Pick a city from the list').max(120),
    workStart: z.coerce.number().int().min(0).max(23).default(9),
    workEnd: z.coerce.number().int().min(0).max(47).default(18),
  });
  /** The city and hours as columns; the end of a shift that passes midnight is stored past 24. */
  const place = (v: z.infer<typeof input>) => {
    const c = findCity(v.city);
    if (!c) throw new HttpError(400, 'Pick a city from the list', { city: 'Pick a city from the list' });
    const end = v.workEnd <= v.workStart ? v.workEnd + 24 : v.workEnd;
    if (end - v.workStart > 16) throw new HttpError(400, 'Use working hours up to 16 hours long', { workEnd: 'Up to 16 hours' });
    return [c.name, c.code, c.country, c.lat, c.lon, c.timezone, v.workStart, end] as const;
  };
  const list = async () => ({ editors: (await loadEditorRows(db)).map(toEditor) });

  app.get('/api/editors', async (req) => {
    requireAdmin(req);
    return list();
  });

  app.post('/api/editors', async (req) => {
    const me = requireAdmin(req);
    const v = parse(input, req.body);
    const row = await db.one<{ id: number }>(
      `insert into editors (name, city, city_code, country, lat, lon, timezone, work_start, work_end, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`, [v.name, ...place(v), me.id],
    );
    await logActivity(db, { actor: me, action: 'editor.created', entityType: 'editor', entityId: row!.id, summary: `Added editor ${v.name} (${v.city.split(',')[0]})` });
    return list();
  });

  app.patch('/api/editors/:id', async (req) => {
    const me = requireAdmin(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const v = parse(input, req.body);
    const rows = await db.query(
      `update editors set name = $2, city = $3, city_code = $4, country = $5, lat = $6, lon = $7, timezone = $8, work_start = $9, work_end = $10, updated_at = now()
        where id = $1 and removed_at is null returning id`, [id, v.name, ...place(v)],
    );
    if (!rows.length) throw notFound('Editor');
    await logActivity(db, { actor: me, action: 'editor.updated', entityType: 'editor', entityId: id, summary: `Updated editor ${v.name}` });
    return list();
  });

  app.delete('/api/editors/:id', async (req) => {
    const me = requireAdmin(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const r = await db.one<{ name: string }>(`update editors set removed_at = now() where id = $1 and removed_at is null returning name`, [id]);
    if (!r) throw notFound('Editor');
    await logActivity(db, { actor: me, action: 'editor.removed', entityType: 'editor', entityId: id, summary: `Removed editor ${r.name}` });
    return list();
  });
}
