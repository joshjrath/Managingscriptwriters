// A thumbnail designer's reference boards: private pictures to work from, one board per client and a general one.
// A ref is exactly one of an image they uploaded (sniffed and stored like an option: server/images.ts), a picked
// option they may see (a current winner: DESIGNER_FILES), or one of a client's image resources; the database checks
// that it's one (thumbnail_refs_source_check). Only its owner ever gets a ref, through these routes or by its file
// (DESIGNER_FILES names their own live upload refs, and no other rule names any). Taken off a board with removed_at,
// never deleted; at most MAX_REFS on a designer's boards at once, counting only the ones they can still open (a winner
// un-picked or a resource removed drops off their boards, so it doesn't hold a place they couldn't free).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from './db';
import type { Ctx } from './core';
import { requireUser } from './auth';
import { conflict, forbidden, HttpError, notFound, parse, zs } from './http';
import { DESIGNER_FILES, storeFile, THUMB_WINNER } from './files';
import { asImageUpload, uploadedImageInfo } from './images';
import { readForm } from './submissions';
import {
  GENERAL_BOARD, isPictureMime, isThumbnailDesigner, MAX_REFS, PICTURE_MIMES, REF_CAPTION_MAX, refSource, type OptionLetter,
} from '../shared/workflow';
import { fileUrl, type Me, type ResourceCategory, type ThumbnailRef, type ThumbnailRefBoard } from '../shared/types';

interface RefRow {
  id: number; client_id: number | null; client_name: string | null; file_id: number | null; variant_id: number | null; resource_id: number | null;
  caption: string | null; created_at: string; shown_file_id: number; mime: string; width: number | null; height: number | null;
  letter: OptionLetter | null; brief_id: number | null; title: string | null; made_by_name: string | null; picked_at: string | null;
  resource_title: string | null; resource_category: ResourceCategory | null;
}

/**
 * SQL: the refs of the designer `$1` whose picture they can still open: their uploads, winners that are still a
 * brief's winner and open for them (DESIGNER_FILES on the option's file), and client resources still there whose file
 * is a picture. `$2` is PICTURE_MIMES.
 */
const REF_SELECT = `
  select tr.id, tr.client_id, c.name as client_name, tr.file_id, tr.variant_id, tr.resource_id, tr.caption, tr.created_at,
         f.id as shown_file_id, f.mime, v.width, v.height, v.letter, b.id as brief_id, b.title, vu.name as made_by_name, pk.created_at as picked_at,
         rs.title as resource_title, rs.category as resource_category
    from thumbnail_refs tr
    left join clients c on c.id = tr.client_id
    left join thumbnail_variants v on v.id = tr.variant_id
    left join thumbnail_rounds vr on vr.id = v.round_id
    left join thumbnail_briefs b on b.id = vr.brief_id
    left join users vu on vu.id = v.uploaded_by
    left join lateral (select x.created_at from thumbnail_decisions x where x.round_id = v.round_id order by x.created_at desc, x.id desc limit 1) pk on true
    left join resources rs on rs.id = tr.resource_id
    join files f on f.id = coalesce(tr.file_id, v.file_id, rs.file_id)
   where tr.user_id = $1 and tr.removed_at is null
     and (tr.file_id is not null
       or (tr.variant_id is not null and v.removed_at is null and b.cancelled_at is null and v.id = ${THUMB_WINNER('b')} and ${DESIGNER_FILES('$1')})
       or (tr.resource_id is not null and rs.removed_at is null and f.mime = any($2::text[])))`;

function toRef(r: RefRow): ThumbnailRef {
  const source = refSource({ fileId: r.file_id, variantId: r.variant_id, resourceId: r.resource_id }) ?? 'upload';
  const winner = source === 'winner';
  return {
    id: r.id, clientId: r.client_id, clientName: r.client_name, source, fileId: r.shown_file_id, url: fileUrl(r.shown_file_id), mime: r.mime,
    width: winner ? r.width : null, height: winner ? r.height : null, caption: r.caption,
    winner: winner && r.variant_id != null && r.brief_id != null
      ? { optionId: r.variant_id, briefId: r.brief_id, title: r.title ?? '', letter: r.letter!, madeByName: r.made_by_name ?? '', pickedAt: r.picked_at ?? r.created_at }
      : null,
    resource: source === 'resource' && r.resource_id != null ? { id: r.resource_id, title: r.resource_title ?? '', category: r.resource_category ?? 'other' } : null,
    createdAt: r.created_at,
  };
}

/** The designer's refs they can still open, newest first: every board, one client's (`clientId`), or the general one (null). */
async function loadRefs(db: Db, userId: number, where: { id?: number; clientId?: number | null } = {}): Promise<ThumbnailRef[]> {
  const params: unknown[] = [userId, [...PICTURE_MIMES]];
  const cond: string[] = [];
  if (where.id) { params.push(where.id); cond.push(`tr.id = $${params.length}`); }
  if (where.clientId === null) cond.push('tr.client_id is null');
  else if (where.clientId !== undefined) { params.push(where.clientId); cond.push(`tr.client_id = $${params.length}`); }
  const rows = await db.query<RefRow>(`${REF_SELECT} ${cond.map((c) => `and ${c}`).join(' ')} order by tr.created_at desc, tr.id desc`, params);
  return rows.map(toRef);
}

const loadRef = async (db: Db, userId: number, id: number) => (await loadRefs(db, userId, { id }))[0] ?? null;

/**
 * Their refs on every board that they can still open (REF_SELECT): what MAX_REFS counts and the boards' "N of 300"
 * shows. One whose winner was un-picked or whose resource was removed isn't listed, so it can't be taken off, and
 * doesn't hold a place either (should it come back, the boards hold one over until something is taken off).
 */
const liveRefs = async (db: Db, userId: number) =>
  (await db.one<{ n: number }>(`select count(*) as n from (${REF_SELECT}) x`, [userId, [...PICTURE_MIMES]]))?.n ?? 0;

/** Only thumbnail designers have reference boards (managers included in the refusal: a board is private to its designer). */
function requireBoards(me: Me): void {
  if (!isThumbnailDesigner(me)) throw forbidden('Only thumbnail designers have reference boards');
}

const full = () => conflict(`Your boards hold up to ${MAX_REFS} references. Take some off to add more.`, 'full');
const onBoard = () => conflict('That picture is already on this board. The page has been refreshed.', 'duplicate');
const chooseClient = () => new HttpError(400, 'Choose a client', { clientId: 'Choose a client' });

/** A board to put a ref on: a client that exists (any of them: a designer sees every client), or null for General. */
async function checkBoard(db: Db, clientId: number | null): Promise<void> {
  if (clientId != null && !(await db.one(`select 1 from clients where id = $1`, [clientId]))) throw chooseClient();
}

/** A live ref of the same winner or resource on that board already. */
const sameOnBoard = (t: Db, userId: number, col: 'variant_id' | 'resource_id', sourceId: number, clientId: number | null, exceptId = 0) =>
  t.one(
    `select 1 from thumbnail_refs where user_id = $1 and ${col} = $2 and client_id is not distinct from $3::bigint and removed_at is null and id <> $4`,
    [userId, sourceId, clientId, exceptId],
  );

/**
 * Every add or move on a designer's boards locks their user row first (then, for a move, the ref), so two adds can't
 * both take the last place, and an add and a move (or two moves) can't both put the same picture on one board.
 */
const lockBoards = (t: Db, userId: number) => t.one(`select id from users where id = $1 for no key update`, [userId]);

const emptyToNull = (v: unknown) => (v === '' || v === undefined ? null : v);
const caption = zs.text(REF_CAPTION_MAX);
const boardQuery = z.object({ clientId: z.union([z.literal(GENERAL_BOARD), zs.id]).optional() });
const refInput = z.object({ optionId: zs.id.optional(), resourceId: zs.id.optional(), clientId: zs.id.nullable().optional(), caption });
const uploadInput = z.object({ caption, clientId: zs.id.nullable() });
const refPatch = z.object({ caption, clientId: zs.id.nullable().optional() });
const idParams = z.object({ id: zs.id });

export function registerRefRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  // The session designer's refs, newest first: ?clientId=<id> for one client's board, ?clientId=general for the
  // general one, every board without it.
  app.get('/api/thumbnail-refs', async (req): Promise<ThumbnailRefBoard> => {
    const me = requireUser(req);
    requireBoards(me);
    const q = parse(boardQuery, req.query);
    const refs = await loadRefs(db, me.id, { clientId: q.clientId === GENERAL_BOARD ? null : q.clientId });
    return { refs, total: await liveRefs(db, me.id), max: MAX_REFS };
  });

  // Adds a ref. As JSON, a picture already on the site: { optionId } (a winner they may see) or { resourceId } (a
  // client's image resource), exactly one. As a form, one image of their own (PNG, JPEG or WebP by its own bytes,
  // stored under that type, like an option) with `caption` and `clientId` (empty: General).
  app.post('/api/thumbnail-refs', async (req): Promise<ThumbnailRef> => {
    const me = requireUser(req);
    requireBoards(me);
    // a full board is refused before an upload is read (and again, locked, below)
    if ((await liveRefs(db, me.id)) >= MAX_REFS) throw full();
    let id: number;
    if (req.isMultipart()) {
      const { fields, file } = await readForm(req, ctx.uploadLimitBytes);
      const input = parse(uploadInput, { caption: emptyToNull(fields.caption), clientId: emptyToNull(fields.clientId) });
      if (!file) throw new HttpError(400, 'Choose an image to add', { file: 'Choose an image to add' });
      // what the file really is, from its own bytes: the browser's type is never stored or served
      const info = await uploadedImageInfo(file);
      if (!info) throw new HttpError(400, 'That isn’t a PNG, JPG or WebP image. Export it as one of those and try again.', { file: 'Use a PNG, JPG or WebP image' });
      await checkBoard(db, input.clientId);
      const upload = asImageUpload(file, info);
      id = await db.tx(async (t) => {
        // the file first, as an option's is; a check that fails rolls it back with the rest
        const fileId = await storeFile(t, me, upload);
        await lockBoards(t, me.id);
        if ((await liveRefs(t, me.id)) >= MAX_REFS) throw full();
        const row = await t.one<{ id: number }>(
          `insert into thumbnail_refs (user_id, client_id, file_id, caption) values ($1, $2, $3, $4) returning id`, [me.id, input.clientId, fileId, input.caption ?? null],
        );
        return row!.id;
      });
    } else {
      const input = parse(refInput, req.body);
      if ((input.optionId == null) === (input.resourceId == null)) {
        throw new HttpError(400, 'Choose one picture to add: a winner or one of a client’s pictures', { optionId: 'Choose one picture to add' });
      }
      let source: { col: 'variant_id' | 'resource_id'; id: number; clientId: number };
      if (input.optionId != null) {
        // a current winner of a brief not cancelled, that this designer may open (their own picks among them)
        const w = await db.one<{ client_id: number }>(
          `select b.client_id from thumbnail_variants v join thumbnail_rounds r on r.id = v.round_id join thumbnail_briefs b on b.id = r.brief_id
             join files f on f.id = v.file_id
            where v.id = $1 and v.removed_at is null and b.cancelled_at is null and v.id = ${THUMB_WINNER('b')} and ${DESIGNER_FILES('$2')}`,
          [input.optionId, me.id],
        );
        if (!w) throw notFound('Winner');
        source = { col: 'variant_id', id: input.optionId, clientId: w.client_id };
      } else {
        const r = await db.one<{ client_id: number; mime: string | null }>(
          `select r.client_id, f.mime from resources r left join files f on f.id = r.file_id where r.id = $1 and r.removed_at is null`, [input.resourceId],
        );
        if (!r) throw notFound('Resource');
        if (!isPictureMime(r.mime)) {
          throw new HttpError(400, 'Only a picture (PNG, JPG, GIF or WebP) can go on a board', { resourceId: 'Only a picture can go on a board' });
        }
        source = { col: 'resource_id', id: input.resourceId!, clientId: r.client_id };
      }
      // left out: the winner's or the resource's client
      const clientId = input.clientId === undefined ? source.clientId : input.clientId;
      await checkBoard(db, clientId);
      id = await db.tx(async (t) => {
        await lockBoards(t, me.id);
        if ((await liveRefs(t, me.id)) >= MAX_REFS) throw full();
        if (await sameOnBoard(t, me.id, source.col, source.id, clientId)) throw onBoard();
        const row = await t.one<{ id: number }>(
          `insert into thumbnail_refs (user_id, client_id, ${source.col}, caption) values ($1, $2, $3, $4) returning id`, [me.id, clientId, source.id, input.caption ?? null],
        );
        // the winner un-picked, or the resource removed, since it was checked above: nothing is added
        if (!(await loadRef(t, me.id, row!.id))) throw notFound(source.col === 'variant_id' ? 'Winner' : 'Resource');
        return row!.id;
      });
    }
    const ref = await loadRef(db, me.id, id);
    if (!ref) throw notFound('Reference');
    return ref;
  });

  // Changes a ref's caption or moves it to another board (null: General): only what differs from what's kept.
  app.patch('/api/thumbnail-refs/:id', async (req): Promise<ThumbnailRef> => {
    const me = requireUser(req);
    requireBoards(me);
    const { id } = parse(idParams, req.params);
    const input = parse(refPatch, req.body);
    await db.tx(async (t) => {
      // her boards first, as an add locks them, then the ref: a move can't race an add (or another move) onto one board
      await lockBoards(t, me.id);
      const r = await t.one<{ client_id: number | null; caption: string | null; variant_id: number | null; resource_id: number | null }>(
        `select client_id, caption, variant_id, resource_id from thumbnail_refs where id = $1 and user_id = $2 and removed_at is null for update`, [id, me.id],
      );
      // another designer's, one taken off, or one whose picture they can't open any more: not theirs to change
      if (!r || !(await loadRef(t, me.id, id))) throw notFound('Reference');
      const set: [string, unknown][] = [];
      if (input.caption !== undefined && (input.caption ?? null) !== r.caption) set.push(['caption', input.caption ?? null]);
      if (input.clientId !== undefined && (input.clientId ?? null) !== r.client_id) {
        const to = input.clientId ?? null;
        await checkBoard(t, to);
        const src = r.variant_id != null ? { col: 'variant_id' as const, id: r.variant_id } : r.resource_id != null ? { col: 'resource_id' as const, id: r.resource_id } : null;
        if (src && (await sameOnBoard(t, me.id, src.col, src.id, to, id))) throw onBoard();
        set.push(['client_id', to]);
      }
      if (!set.length) return;
      await t.query(`update thumbnail_refs set ${set.map(([col], i) => `${col} = $${i + 2}`).join(', ')} where id = $1`, [id, ...set.map(([, v]) => v)]);
    });
    const ref = await loadRef(db, me.id, id);
    if (!ref) throw notFound('Reference');
    return ref;
  });

  // Takes a ref off its board (kept, with removed_at); an uploaded image no longer opens once it's off.
  app.delete('/api/thumbnail-refs/:id', async (req) => {
    const me = requireUser(req);
    requireBoards(me);
    const { id } = parse(idParams, req.params);
    const r = await db.one(`update thumbnail_refs set removed_at = now() where id = $1 and user_id = $2 and removed_at is null returning id`, [id, me.id]);
    if (!r) throw notFound('Reference');
    return { ok: true };
  });
}
