// Clients, briefing/ideation-call records, resources and secure file access.

import {
  DESIGNER_FILES, EDITOR_FILES, FILE_CACHE, fileStream, isBlockedFile, SENT_OPTION_FILES, spool, storedFileName, storeFile, THUMB_FILE_CACHE, THUMB_PICTURE,
  type UploadedFile,
} from '../files';
import type { FastifyInstance } from 'fastify';
import {
  BRAND_LIMITS, brandChanges, EMPTY_BRAND, isEditor, isHttpsUrl, isManager, isThumbnailDesigner, type BrandColour, type BrandFont, type BrandKitFields,
  type Role,
} from '../../shared/workflow';
import { HEX, normalizeHex } from '../../shared/palettes';
import { z } from 'zod';
import { clockFor, isAssignedTo, loadBatches, loadSettings, logActivity, type Ctx } from '../core';
import { requireManager, requireUser } from '../auth';
import { forbidden, HttpError, notFound, optionalDate, parse, zs } from '../http';
import { brandLists, loadActivity, loadBriefings, loadClientBrand, loadResources, loadShoots } from '../records';
import { loadWins, RECENT_WINNERS } from '../thumbnails';
import { batchFields, insertBatch } from './batches';
import type { ClientBrand, ClientDetail, ClientSummary, Me, ResourceCategory, ThumbnailWin } from '../../shared/types';
import { RESOURCE_CATEGORIES } from '../../shared/types';
import { fmtDate } from '../../shared/format';
import type { Db } from '../db';

const briefingSchema = z.object({
  title: zs.name('Title', 200),
  callDate: optionalDate,
  recordingUrl: zs.url,
  documentUrl: zs.url,
  summary: zs.text(),
  instructions: zs.text(),
  batchIds: z.array(zs.id).max(50).optional(),
});

const clientCreate = z.object({
  name: zs.name('Client name', 160),
  /** a potential client: tracked, but no shoots or batches until they sign */
  prospect: z.boolean().default(false),
  ownerId: zs.id.nullable().optional(),
  description: zs.text(),
  brandVoice: zs.text(),
  guidance: zs.text(),
  briefing: briefingSchema.omit({ batchIds: true }).optional(),
  links: z.array(z.object({ title: zs.name('Title', 200), url: zs.url.refine((v) => !!v, 'Add the link'), category: z.enum(RESOURCE_CATEGORIES as [ResourceCategory, ...ResourceCategory[]]).default('other') })).max(20).default([]),
  initialBatch: z.object({
    title: batchFields.title,
    targetCount: batchFields.targetCount,
    draftDue: batchFields.draftDue,
    finalDue: batchFields.finalDue,
    split: batchFields.split,
    priority: batchFields.priority,
  }).optional(),
});

const clientPatch = z.object({
  name: zs.name('Client name', 160).optional(),
  ownerId: zs.id.nullable().optional(),
  description: zs.text(),
  brandVoice: zs.text(),
  guidance: zs.text(),
  /** false: the team films this client without scripts (no script reminders; a next shoot with no scripts due) */
  scriptsRequired: z.boolean().optional(),
});

const resourceCreate = z.object({
  clientId: zs.id,
  briefingId: zs.id.nullable().optional(),
  batchId: zs.id.nullable().optional(),
  category: z.enum(RESOURCE_CATEGORIES as [ResourceCategory, ...ResourceCategory[]]).default('other'),
  title: zs.name('Title', 200),
  url: zs.url.refine((v) => !!v, 'Add the link'),
  notes: zs.text(2000),
});

// ── a client's brand kit (PATCH /api/clients/:id/brand) ─────────────────
// Problems with the colours or the fonts are reported on the list itself (fields.colours, fields.fonts), not on one
// entry of it, so the form shows them beside the swatches or the fonts.

/** A list in a brand kit: every entry checked by `item`, the first problem reported on the list. */
const brandList = <T>(what: string, max: number, item: z.ZodType<T>) =>
  z.array(z.unknown(), `Send the ${what} as a list`)
    .max(max, `A brand kit holds up to ${max} ${what}`)
    .transform((list, ctx) => {
      const out: T[] = [];
      for (const v of list) {
        const r = item.safeParse(v);
        if (!r.success) {
          ctx.addIssue({ code: 'custom', message: r.error.issues[0]?.message ?? `Check the ${what}` });
          return z.NEVER;
        }
        out.push(r.data);
      }
      return out;
    });

/** A colour's or a font's name: on one line, 1 to BRAND_LIMITS.name characters. */
const brandName = (what: string) =>
  z.string(`Give each ${what} a name`)
    .transform((v) => v.replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(1, `Give each ${what} a name`).max(BRAND_LIMITS.name, `Keep each ${what}’s name to ${BRAND_LIMITS.name} characters`));

const brandColour: z.ZodType<BrandColour> = z.object({
  name: brandName('colour'),
  // HEX (shared/palettes.ts), kept in capitals; '#abc' reads as '#AABBCC'
  hex: z.string('Give each colour a code like #1E88E5').transform((v, ctx) => {
    const hex = normalizeHex(v);
    if (hex && HEX.test(hex)) return hex;
    ctx.addIssue({ code: 'custom', message: `“${v.trim().slice(0, 20)}” isn’t a colour code. Use one like #1E88E5` });
    return z.NEVER;
  }),
});

const brandFont: z.ZodType<BrandFont> = z.object({
  name: brandName('font'),
  url: z.string('Use a link starting with https://').nullable().optional().transform((v, ctx) => {
    const url = v?.trim() ?? '';
    if (!url) return null;
    if (url.length <= 2000 && isHttpsUrl(url)) return url;
    ctx.addIssue({ code: 'custom', message: 'Use a secure link for each font, starting with https://' });
    return z.NEVER;
  }),
  resourceId: z.number('Choose a font file from this client’s resources').int().positive().nullable().optional().transform((v) => v ?? null),
});

const brandPatch = z.object({
  colours: brandList('colours', BRAND_LIMITS.colours, brandColour).optional(),
  fonts: brandList('fonts', BRAND_LIMITS.fonts, brandFont).optional(),
  dos: zs.text(BRAND_LIMITS.notes),
  donts: zs.text(BRAND_LIMITS.notes),
});

const BRAND_FIELD_WORDS: Record<keyof BrandKitFields, string> = { colours: 'colours', fonts: 'fonts', dos: 'do’s', donts: 'don’ts' };

async function duplicateName(db: Db, name: string, exceptId?: number) {
  const r = await db.one<{ id: number; status: string }>(`select id, status from clients where lower(name) = lower($1) and ($2::bigint is null or id <> $2)`, [name, exceptId ?? null]);
  if (r) {
    throw new HttpError(409, `A client named “${name}” already exists${r.status === 'archived' ? ' (archived)' : ''}`, { name: 'This client already exists' }, 'duplicate');
  }
}

async function clientSummaries(ctx: Ctx, status: 'prospect' | 'active' | 'archived' | 'all' | 'current'): Promise<ClientSummary[]> {
  const where = status === 'all' ? '' : status === 'current' ? `where c.status in ('active', 'prospect')` : `where c.status = '${status}'`;
  const rows = await ctx.db.query<{ id: number; name: string; status: 'prospect' | 'active' | 'archived'; owner_id: number | null; owner_name: string | null; description: string | null; created_at: string; became_client_at: string | null }>(
    `select c.id, c.name, c.status, c.owner_id, u.name as owner_name, c.description, c.created_at, c.became_client_at from clients c left join users u on u.id = c.owner_id
      ${where} order by lower(c.name)`,
  );
  const clock = await clockFor(ctx);
  const { summaries } = await loadBatches(ctx, {}, clock);
  const shoots = await loadShoots(ctx.db, { from: clock.today });
  return rows.map((c) => {
    const mine = summaries.filter((b) => b.clientId === c.id);
    const active = mine.filter((b) => b.stage !== 'delivered');
    return {
      id: c.id, name: c.name, status: c.status, ownerId: c.owner_id, ownerName: c.owner_name, description: c.description,
      activeBatches: active.length,
      scriptsTotal: active.reduce((n, b) => n + b.progress.total, 0),
      scriptsDelivered: active.reduce((n, b) => n + b.progress.delivered, 0),
      nextShoot: shoots.find((s) => s.clientId === c.id && !s.cancelledAt)?.startDate ?? null,
      overdueBatches: active.filter((b) => b.draft.overdue || b.final.overdue).length,
      createdAt: c.created_at, becameClientAt: c.became_client_at,
    };
  });
}

export async function insertBriefing(t: Db, me: Me, clientId: number, input: z.infer<typeof briefingSchema>) {
  const row = await t.one<{ id: number }>(
    `insert into briefings (client_id, title, call_date, recording_url, document_url, summary, instructions, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [clientId, input.title, input.callDate ?? null, input.recordingUrl ?? null, input.documentUrl ?? null, input.summary ?? null, input.instructions ?? null, me.id],
  );
  const id = row!.id;
  for (const bid of new Set(input.batchIds ?? [])) {
    const b = await t.one(`select 1 from batches where id = $1 and client_id = $2`, [bid, clientId]);
    if (!b) throw new HttpError(400, 'Choose batches for this client', { batchIds: 'Choose batches for this client' });
    await t.query(`insert into batch_briefings (batch_id, briefing_id) values ($1, $2) on conflict do nothing`, [bid, id]);
  }
  await logActivity(t, {
    actor: me, action: 'briefing.created', entityType: 'briefing', entityId: id, clientId,
    summary: `Added briefing “${input.title}”${input.callDate ? ` (call ${fmtDate(input.callDate)})` : ''}${input.recordingUrl ? ' with recording' : ''}`,
  });
  return id;
}

/**
 * The client's current winners for its page (newest first, at most RECENT_WINNERS): all of them for managers; for a
 * thumbnail designer only those they may open (DESIGNER_FILES: so only when they have or had a brief for this client),
 * with Standout only on their own, as beside a brief. Left out (undefined) for writers and video editors.
 */
async function clientWinners(db: Db, me: Me, clientId: number): Promise<ThumbnailWin[] | undefined> {
  if (isManager(me.role)) return loadWins(db, { clientId, limit: RECENT_WINNERS });
  if (!isThumbnailDesigner(me)) return undefined;
  const wins = await loadWins(db, { clientId, limit: RECENT_WINNERS });
  if (!wins.length) return [];
  const open = new Set((await db.query<{ id: number }>(
    `select f.id from files f where f.id = any($1::bigint[]) and ${DESIGNER_FILES('$2')}`, [wins.map((w) => w.option.fileId), me.id],
  )).map((f) => Number(f.id)));
  return wins.filter((w) => open.has(w.option.fileId)).map((w) => (w.standout && w.option.uploadedById !== me.id ? { ...w, standout: false } : w));
}

/** Writers may add resources to batches they work on; managers anywhere. */
async function checkResourceAccess(db: Db, me: Me, clientId: number, batchId: number | null | undefined, briefingId: number | null | undefined) {
  const client = await db.one(`select 1 from clients where id = $1`, [clientId]);
  if (!client) throw new HttpError(400, 'Choose a client', { clientId: 'Choose a client' });
  if (batchId) {
    const b = await db.one(`select 1 from batches where id = $1 and client_id = $2`, [batchId, clientId]);
    if (!b) throw new HttpError(400, 'That batch belongs to another client');
  }
  if (briefingId) {
    const b = await db.one(`select 1 from briefings where id = $1 and client_id = $2`, [briefingId, clientId]);
    if (!b) throw new HttpError(400, 'That briefing belongs to another client');
  }
  if (isManager(me.role)) return;
  if (!batchId || briefingId) throw forbidden('Writers can add resources to batches they’re working on');
  if (!(await isAssignedTo(db, batchId, me.id))) throw forbidden('You can only add resources to batches you’re working on');
}

const SAFE_INLINE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain']);

export function registerClientRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  app.get('/api/clients', async (req) => {
    const me = requireUser(req);
    const { status } = parse(z.object({ status: z.enum(['prospect', 'active', 'archived', 'all', 'current']).default('active') }), req.query);
    const list = await clientSummaries(ctx, status);
    // notes about potential clients are sales talk, for managers only
    return { clients: isManager(me.role) ? list : list.map((c) => (c.status === 'prospect' ? { ...c, description: null } : c)) };
  });

  app.get('/api/clients/:id', async (req): Promise<ClientDetail> => {
    const me = requireUser(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const [summary] = (await clientSummaries(ctx, 'all')).filter((c) => c.id === id);
    if (!summary) throw notFound('Client');
    const c = await db.one<{ brand_voice: string | null; guidance: string | null; scripts_required: boolean }>(`select brand_voice, guidance, scripts_required from clients where id = $1`, [id]);
    const clock = await clockFor(ctx);
    const [briefings, resources, shoots, batches, activity, brand, recentWinners] = await Promise.all([
      loadBriefings(db, { clientId: id }),
      loadResources(db, { clientId: id }),
      loadShoots(db, { clientId: id }),
      loadBatches(ctx, { clientId: id, includeArchived: true }, clock),
      loadActivity(db, { clientId: id, limit: 80 }),
      loadClientBrand(db, id),
      clientWinners(db, me, id),
    ]);
    return {
      ...summary, description: summary.status === 'prospect' && !isManager(me.role) ? null : summary.description,
      brandVoice: c?.brand_voice ?? null, guidance: c?.guidance ?? null, scriptsRequired: c?.scripts_required !== false,
      briefings, resources: resources.filter((r) => !r.briefingId), shoots,
      // editors get the brand material, not the batches; the team's internal history is for managers
      batches: isEditor(me.role) ? [] : batches.summaries, activity: isManager(me.role) ? activity : [],
      // the brand kit is for everyone who may see the client; its winners only for managers and thumbnail designers
      brand, ...(recentWinners ? { recentWinners } : {}),
    };
  });

  // Edits a client's brand kit: only the fields sent, and of those only what differs from the kit as kept (brandChanges,
  // which the form uses too). A font's file must be a stored file among this client's live resources (one the kit
  // already names may stay after it's removed: it shows without its file). The client row is locked first.
  app.patch('/api/clients/:id/brand', async (req): Promise<ClientBrand> => {
    const me = requireManager(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const input = parse(brandPatch, req.body);
    await db.tx(async (t) => {
      const client = await t.one<{ name: string; status: string }>(`select name, status from clients where id = $1 for update`, [id]);
      if (!client) throw notFound('Client');
      if (client.status === 'archived') throw new HttpError(409, `${client.name} is archived. Restore them first.`, undefined, 'archived');
      const kept = await t.one<{ colours: unknown; fonts: unknown; dos: string | null; donts: string | null }>(
        `select colours, fonts, dos, donts from client_brand where client_id = $1`, [id],
      );
      const before: BrandKitFields | null = kept ? { ...brandLists(kept.colours, kept.fonts), dos: kept.dos, donts: kept.donts } : null;
      const changed = brandChanges(before, input);
      const fields = (Object.keys(changed) as (keyof BrandKitFields)[]).filter((k) => changed[k] !== undefined);
      if (!fields.length) return;
      if (changed.fonts) {
        const already = new Set((before?.fonts ?? []).map((f) => f.resourceId).filter((r) => r != null));
        const asked = [...new Set(changed.fonts.map((f) => f.resourceId).filter((r): r is number => r != null && !already.has(r)))];
        const live = asked.length
          ? new Set((await t.query<{ id: number }>(
            `select id from resources where id = any($1::bigint[]) and client_id = $2 and removed_at is null and file_id is not null`, [asked, id],
          )).map((r) => Number(r.id)))
          : new Set<number>();
        if (asked.some((r) => !live.has(r))) {
          throw new HttpError(400, 'Choose a font file from this client’s resources', { fonts: 'Choose a font file from this client’s resources' });
        }
      }
      const next = { ...(before ?? EMPTY_BRAND), ...changed };
      await t.query(
        `insert into client_brand (client_id, colours, fonts, dos, donts, updated_by, updated_at) values ($1, $2::jsonb, $3::jsonb, $4, $5, $6, now())
         on conflict (client_id) do update set colours = excluded.colours, fonts = excluded.fonts, dos = excluded.dos, donts = excluded.donts,
                                               updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        [id, JSON.stringify(next.colours), JSON.stringify(next.fonts), next.dos, next.donts, me.id],
      );
      await logActivity(t, {
        actor: me, action: 'client.brand', entityType: 'client', entityId: id, clientId: id,
        summary: `Updated ${client.name}’s brand kit: ${fields.map((k) => BRAND_FIELD_WORDS[k]).join(', ')}`,
      });
    });
    return (await loadClientBrand(db, id)) ?? { clientId: id, ...EMPTY_BRAND, fonts: [], updatedByName: null, updatedAt: ctx.now().toISOString() };
  });

  /** A client's internal owner must be an active team member (one who has since left can stay on). */
  async function checkOwner(ownerId: number | null | undefined, current: number | null = null) {
    if (ownerId == null || ownerId === current) return;
    if (!(await db.one(`select 1 from users where id = $1 and active and removed_at is null`, [ownerId]))) {
      throw new HttpError(400, 'Choose an active team member', { ownerId: 'Choose an active team member' });
    }
  }

  app.post('/api/clients', async (req) => {
    const me = requireManager(req);
    const input = parse(clientCreate, req.body);
    await duplicateName(db, input.name);
    await checkOwner(input.ownerId);
    const settings = await loadSettings(db);
    const clock = await clockFor(ctx, settings);
    const out = await db.tx(async (t) => {
      const row = await t.one<{ id: number }>(
        `insert into clients (name, status, owner_id, description, brand_voice, guidance, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [input.name, input.prospect ? 'prospect' : 'active', input.ownerId ?? me.id, input.description ?? null, input.brandVoice ?? null, input.guidance ?? null, me.id],
      );
      const clientId = row!.id;
      await logActivity(t, { actor: me, action: 'client.created', entityType: 'client', entityId: clientId, clientId, summary: input.prospect ? `Added ${input.name} as a potential client` : `Created client ${input.name}` });
      let briefingId: number | null = null;
      if (input.briefing && input.briefing.title) briefingId = await insertBriefing(t, me, clientId, input.briefing);
      for (const l of input.links) {
        await t.query(`insert into resources (client_id, kind, category, title, url, created_by) values ($1, 'link', $2, $3, $4, $5)`, [clientId, l.category, l.title, l.url, me.id]);
      }
      let batch: { batchId: number; warnings: string[] } | null = null;
      if (input.initialBatch) {
        batch = await insertBatch(t, me, { ...input.initialBatch, clientId, shootId: null, briefingIds: briefingId ? [briefingId] : [], brief: null, nextAction: null, plannedStart: null }, settings, clock);
      }
      return { clientId, briefingId, batch };
    });
    return out;
  });

  app.patch('/api/clients/:id', async (req) => {
    const me = requireManager(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const input = parse(clientPatch, req.body);
    if (input.name) await duplicateName(db, input.name, id);
    if (input.ownerId !== undefined) await checkOwner(input.ownerId, (await db.one<{ owner_id: number | null }>(`select owner_id from clients where id = $1`, [id]))?.owner_id);
    const set: Record<string, unknown> = {};
    if (input.name !== undefined) set.name = input.name;
    if (input.ownerId !== undefined) set.owner_id = input.ownerId;
    if (input.description !== undefined) set.description = input.description;
    if (input.brandVoice !== undefined) set.brand_voice = input.brandVoice;
    if (input.guidance !== undefined) set.guidance = input.guidance;
    if (input.scriptsRequired !== undefined) set.scripts_required = input.scriptsRequired;
    const keys = Object.keys(set);
    if (!keys.length) return { ok: true };
    const r = await db.one(`update clients set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1 returning id`, [id, ...keys.map((k) => set[k])]);
    if (!r) throw notFound('Client');
    await logActivity(db, { actor: me, action: 'client.updated', entityType: 'client', entityId: id, clientId: id, summary: input.scriptsRequired !== undefined && keys.length === 1 ? (input.scriptsRequired ? 'Scripts needed again for this client' : 'Marked as no scripts needed: shoots only') : `Updated client ${keys.map((k) => k.replace('_', ' ').replace(' id', '')).join(', ')}` });
    return { ok: true };
  });

  /**
   * Potential client ⇄ client (dragged between the two, or "Mark as client").
   * It's only a label: shoots, batches, deadlines and the calendar don't change.
   */
  app.post('/api/clients/:id/stage', async (req) => {
    const me = requireManager(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const { stage } = parse(z.object({ stage: z.enum(['client', 'prospect']) }), req.body);
    return db.tx(async (t) => {
      const c = await t.one<{ name: string; status: string }>(`select name, status from clients where id = $1 for update`, [id]);
      if (!c) throw notFound('Client');
      if (c.status === 'archived') throw new HttpError(409, `${c.name} is archived. Restore them first.`);
      if (stage === 'client') {
        if (c.status === 'active') return { ok: true, changed: false };
        await t.query(`update clients set status = 'active', became_client_at = now(), updated_at = now() where id = $1`, [id]);
        await logActivity(t, { actor: me, action: 'client.converted', entityType: 'client', entityId: id, clientId: id, summary: `${c.name} became a client (moved from Potential clients)` });
      } else {
        if (c.status === 'prospect') return { ok: true, changed: false };
        await t.query(`update clients set status = 'prospect', became_client_at = null, updated_at = now() where id = $1`, [id]);
        await logActivity(t, { actor: me, action: 'client.to_prospect', entityType: 'client', entityId: id, clientId: id, summary: `Moved ${c.name} to Potential clients` });
      }
      return { ok: true, changed: true };
    });
  });

  app.post('/api/clients/:id/archive', async (req) => {
    const me = requireManager(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const { archived } = parse(z.object({ archived: z.boolean() }), req.body);
    const r = await db.one<{ name: string }>(
      `update clients set status = $2, archived_at = ${archived ? 'now()' : 'null'}, updated_at = now() where id = $1 returning name`,
      [id, archived ? 'archived' : 'active'],
    );
    if (!r) throw notFound('Client');
    await logActivity(db, { actor: me, action: archived ? 'client.archived' : 'client.restored', entityType: 'client', entityId: id, clientId: id, summary: archived ? `Archived ${r.name}` : `Restored ${r.name}` });
    return { ok: true };
  });

  // ── briefings ──────────────────────────────────────────────────────────

  app.post('/api/clients/:id/briefings', async (req) => {
    const me = requireManager(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const input = parse(briefingSchema, req.body);
    const c = await db.one(`select 1 from clients where id = $1`, [id]);
    if (!c) throw notFound('Client');
    const briefingId = await db.tx((t) => insertBriefing(t, me, id, input));
    return { briefing: (await loadBriefings(db, { ids: [briefingId] }))[0] };
  });

  app.patch('/api/briefings/:id', async (req) => {
    const me = requireManager(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const input = parse(briefingSchema.partial(), req.body);
    await db.tx(async (t) => {
      const b = await t.one<{ client_id: number; title: string }>(`select client_id, title from briefings where id = $1`, [id]);
      if (!b) throw notFound('Briefing');
      const map: Record<string, string> = { title: 'title', callDate: 'call_date', recordingUrl: 'recording_url', documentUrl: 'document_url', summary: 'summary', instructions: 'instructions' };
      const keys = Object.keys(map).filter((k) => (input as Record<string, unknown>)[k] !== undefined);
      if (keys.length) {
        await t.query(`update briefings set ${keys.map((k, i) => `${map[k]} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1`, [id, ...keys.map((k) => (input as Record<string, unknown>)[k])]);
      }
      if (input.batchIds) {
        await t.query(`delete from batch_briefings where briefing_id = $1`, [id]);
        for (const bid of new Set(input.batchIds)) {
          const ok = await t.one(`select 1 from batches where id = $1 and client_id = $2`, [bid, b.client_id]);
          if (!ok) throw new HttpError(400, 'Choose batches for this client');
          await t.query(`insert into batch_briefings (batch_id, briefing_id) values ($1, $2)`, [bid, id]);
        }
      }
      await logActivity(t, { actor: me, action: 'briefing.updated', entityType: 'briefing', entityId: id, clientId: b.client_id, summary: `Updated briefing “${input.title ?? b.title}”` });
    });
    return { briefing: (await loadBriefings(db, { ids: [id] }))[0] };
  });

  // ── resources ──────────────────────────────────────────────────────────

  app.get('/api/resources', async (req) => {
    requireUser(req);
    const q = parse(z.object({ q: z.string().trim().max(200).optional(), clientId: zs.id.optional(), category: z.enum(RESOURCE_CATEGORIES as [ResourceCategory, ...ResourceCategory[]]).optional() }), req.query);
    const resources = await loadResources(db, { q: q.q || undefined, clientId: q.clientId, category: q.category });
    // recordings and documents on briefing records are resources too
    const briefings = await loadBriefings(db, { clientId: q.clientId });
    const clients = new Map((await db.query<{ id: number; name: string; status: string }>(`select id, name, status from clients`)).map((c) => [c.id, c]));
    const needle = q.q?.toLowerCase();
    const briefingLinks = briefings
      .filter((b) => (clients.get(b.clientId) && clients.get(b.clientId)!.status !== 'archived') || q.clientId)
      .flatMap((b) => [
        b.recordingUrl ? { briefingId: b.id, briefingTitle: b.title, clientId: b.clientId, clientName: clients.get(b.clientId)?.name ?? '', kind: 'recording' as const, url: b.recordingUrl, callDate: b.callDate } : null,
        b.documentUrl ? { briefingId: b.id, briefingTitle: b.title, clientId: b.clientId, clientName: clients.get(b.clientId)?.name ?? '', kind: 'document' as const, url: b.documentUrl, callDate: b.callDate } : null,
      ])
      .filter((x): x is NonNullable<typeof x> => !!x)
      .filter((x) => !q.category || x.kind === q.category)
      .filter((x) => !needle || [x.briefingTitle, x.clientName, x.url].some((s) => s.toLowerCase().includes(needle)));
    return { resources, briefingLinks };
  });

  app.post('/api/resources', async (req) => {
    const me = requireUser(req);
    const input = parse(resourceCreate, req.body);
    await checkResourceAccess(db, me, input.clientId, input.batchId, input.briefingId);
    const r = await db.one<{ id: number }>(
      `insert into resources (client_id, briefing_id, batch_id, kind, category, title, url, notes, created_by) values ($1,$2,$3,'link',$4,$5,$6,$7,$8) returning id`,
      [input.clientId, input.briefingId ?? null, input.batchId ?? null, input.category, input.title, input.url, input.notes ?? null, me.id],
    );
    await logActivity(db, { actor: me, action: 'resource.added', entityType: 'resource', entityId: r!.id, clientId: input.clientId, batchId: input.batchId ?? null, summary: `Added link “${input.title}”` });
    return { resource: (await loadResources(db, { id: r!.id }))[0] };
  });

  app.post('/api/resources/upload', async (req) => {
    const me = requireUser(req);
    if (!req.isMultipart()) throw new HttpError(400, 'Send the file as a form upload');
    const fields: Record<string, string> = {};
    let file: UploadedFile | null = null;
    // the file is streamed to a temporary file as it arrives, never held in memory
    for await (const part of req.parts({ limits: { fileSize: ctx.uploadLimitBytes, files: 1 } })) {
      if (part.type === 'file') file = await spool(req, part, ctx.uploadLimitBytes);
      else fields[part.fieldname] = String(part.value ?? '');
    }
    if (!file) throw new HttpError(400, 'Choose a file to upload', { file: 'Choose a file to upload' });
    if (isBlockedFile(file.filename)) throw new HttpError(400, 'That file type can’t be uploaded', { file: 'That file type can’t be uploaded' });
    const input = parse(resourceCreate.omit({ url: true }).extend({ title: zs.text(200) }), {
      clientId: fields.clientId, briefingId: fields.briefingId || null, batchId: fields.batchId || null,
      category: fields.category || 'document', title: fields.title || storedFileName(file.filename), notes: fields.notes,
    });
    await checkResourceAccess(db, me, input.clientId, input.batchId, input.briefingId);
    const safeName = storedFileName(file.filename);
    const id = await db.tx(async (t) => {
      const fileId = await storeFile(t, me, file!);
      const r = await t.one<{ id: number }>(
        `insert into resources (client_id, briefing_id, batch_id, kind, category, title, file_id, notes, created_by) values ($1,$2,$3,'file',$4,$5,$6,$7,$8) returning id`,
        [input.clientId, input.briefingId ?? null, input.batchId ?? null, input.category, input.title || safeName, fileId, input.notes ?? null, me.id],
      );
      await logActivity(t, { actor: me, action: 'resource.uploaded', entityType: 'resource', entityId: r!.id, clientId: input.clientId, batchId: input.batchId ?? null, summary: `Uploaded “${safeName}”` });
      return r!.id;
    });
    return { resource: (await loadResources(db, { id }))[0] };
  });

  app.delete('/api/resources/:id', async (req) => {
    const me = requireUser(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const r = await db.one<{ created_by: number; client_id: number; batch_id: number | null; title: string }>(`select created_by, client_id, batch_id, title from resources where id = $1 and removed_at is null`, [id]);
    if (!r) throw notFound('Resource');
    if (!isManager(me.role) && r.created_by !== me.id) throw forbidden('You can only remove resources you added');
    await db.query(`update resources set removed_at = now() where id = $1`, [id]);
    await logActivity(db, { actor: me, action: 'resource.removed', entityType: 'resource', entityId: id, clientId: r.client_id, batchId: r.batch_id, summary: `Removed “${r.title}”` });
    return { ok: true };
  });

  // Files are only served to signed-in users, and only while a live resource references them.
  app.get('/api/files/:id', async (req, reply) => {
    const me = requireUser(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    // one rule per person. Writers: any file something live still refers to. Video editors: only EDITOR_FILES
    // (finished work). Thumbnail designers: that, plus their own options and clients' winners (DESIGNER_FILES, for
    // the session person). Managers: anyLive plus options in sent rounds, never a designer's unsent tray.
    const anyLive = `(exists (select 1 from resources r where r.file_id = f.id and r.removed_at is null) or exists (select 1 from submissions s where s.file_id = f.id) or exists (select 1 from reviews v where v.file_id = f.id) or exists (select 1 from past_documents p where p.file_id = f.id and p.removed_at is null))`;
    const rule = isManager(me.role) ? { sql: `(${anyLive} or ${SENT_OPTION_FILES})`, params: [] }
      : isThumbnailDesigner(me) ? { sql: `(${EDITOR_FILES} or ${DESIGNER_FILES('$2')})`, params: [me.id] }
        : isEditor(me.role) ? { sql: EDITOR_FILES, params: [] }
          : { sql: anyLive, params: [] };
    const f = await db.one<{ filename: string; mime: string; size: number; stored: number; thumb: boolean }>(
      `select f.filename, f.mime, f.size, octet_length(f.data) as stored, ${THUMB_PICTURE} as thumb from files f where f.id = $1 and ${rule.sql}`, [id, ...rule.params],
    );
    if (!f) throw notFound('File');
    const inline = SAFE_INLINE.has(f.mime) && (req.query as Record<string, string>).download !== '1';
    const encoded = encodeURIComponent(f.filename);
    reply
      .header('Content-Type', SAFE_INLINE.has(f.mime) ? f.mime : 'application/octet-stream')
      .header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${encoded}"; filename*=UTF-8''${encoded}`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox")
      // an option's or a reference board's picture never changes under its id: kept a day (a wall of them loads once)
      .header('Cache-Control', f.thumb ? THUMB_FILE_CACHE : FILE_CACHE);
    // Streamed in pieces rather than loaded whole. In Recording mode, files copied
    // from the real workspace keep their contents there (the copy holds none).
    const here = ctx.dbNow?.() ?? db;
    const from = f.stored === 0 && f.size > 0 && ctx.realDb ? ctx.realDb : here;
    reply.header('Content-Length', String(f.stored === 0 && f.size > 0 ? f.size : f.stored));
    return reply.send(fileStream(from, id, f.stored || f.size));
  });

  app.get('/api/search', async (req) => {
    const me = requireUser(req);
    const { q } = parse(z.object({ q: z.string().trim().min(1).max(100) }), req.query);
    const like = `%${q.toLowerCase()}%`;
    const num = /^(?:#|script\s*#?\s*)(\d{1,4})$/i.exec(q)?.[1] ?? (/^\d{1,4}$/.test(q) ? q : null);
    const [people, shoots, scripts, briefings] = await Promise.all([
      db.query<{ id: number; name: string; role: Role }>(`select id, name, role from users where active and (lower(name) like $1 or lower(email) like $1) order by lower(name) limit 5`, [like]),
      db.query<{ id: number; title: string | null; client_id: number; client_name: string; start_date: string; batch_id: number | null }>(
        `select s.id, s.title, s.client_id, c.name as client_name, s.start_date::text as start_date,
                (select min(b.id) from batches b where b.shoot_id = s.id and b.archived_at is null) as batch_id
           from shoots s join clients c on c.id = s.client_id
          where s.cancelled_at is null and (lower(coalesce(s.title, '')) like $1 or lower(c.name) like $1) and s.start_date >= current_date - 60
          order by s.start_date limit 6`, [like]),
      num ? db.query<{ batch_id: number; batch_title: string; client_name: string; number: number }>(
        `select s.batch_id, b.title as batch_title, c.name as client_name, s.number from scripts s join batches b on b.id = s.batch_id join clients c on c.id = b.client_id
          where s.removed_at is null and b.archived_at is null and s.number = $1 ${me.role === 'writer' ? 'and s.assignee_id = $2' : ''} order by b.final_due nulls last limit 8`,
        me.role === 'writer' ? [Number(num), me.id] : [Number(num)]) : Promise.resolve([]),
      db.query<{ id: number; title: string; client_id: number; client_name: string; call_date: string | null }>(
        `select br.id, br.title, br.client_id, c.name as client_name, br.call_date::text as call_date from briefings br join clients c on c.id = br.client_id
          where lower(br.title) like $1 or lower(coalesce(br.instructions, '')) like $1 or lower(coalesce(br.summary, '')) like $1 or ($2 and br.recording_url is not null)
          order by br.call_date desc nulls last limit 5`, [like, /^(call )?recordings?$/i.test(q)]),
    ]);
    const extra = {
      people: isEditor(me.role) ? [] : people,
      shoots: shoots.map((s) => ({ id: s.id, title: s.title ?? 'Shoot', clientId: s.client_id, clientName: s.client_name, startDate: s.start_date, batchId: isEditor(me.role) ? null : s.batch_id })),
      scripts: isEditor(me.role) ? [] : scripts.map((s) => ({ batchId: s.batch_id, batchTitle: s.batch_title, clientName: s.client_name, number: s.number })),
      briefings: briefings.map((b) => ({ id: b.id, title: b.title, clientId: b.client_id, clientName: b.client_name, callDate: b.call_date })),
    };
    const [clients, batches, resources] = await Promise.all([
      db.query<{ id: number; name: string; status: 'prospect' | 'active' | 'archived' }>(`select id, name, status from clients where lower(name) like $1 order by status, lower(name) limit 6`, [like]),
      db.query<{ id: number; title: string; client_name: string }>(
        `select b.id, b.title, c.name as client_name from batches b join clients c on c.id = b.client_id
          where b.archived_at is null and (lower(b.title) like $1 or lower(c.name) like $1) order by b.final_due nulls last limit 8`, [like]),
      db.query<{ id: number; title: string; client_name: string; url: string | null; file_id: number | null }>(
        `select r.id, r.title, c.name as client_name, r.url, r.file_id from resources r join clients c on c.id = r.client_id
          where r.removed_at is null and (lower(r.title) like $1 or lower(coalesce(r.notes, '')) like $1 or ($2 and r.category = 'recording'))
          order by r.created_at desc limit 6`, [like, /^(call )?recordings?$/i.test(q)]),
    ]);
    return {
      clients,
      batches: isEditor(me.role) ? [] : batches.map((b) => ({ id: b.id, title: b.title, clientName: b.client_name })),
      resources: resources.map((r) => ({ id: r.id, title: r.title, clientName: r.client_name, url: r.url, fileId: r.file_id })),
      ...extra,
    };
  });

}
