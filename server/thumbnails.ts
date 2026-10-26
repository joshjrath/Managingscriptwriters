// Thumbnail Studio. A manager hands out a thumbnail brief (the video's title, typed, and what it should show) to a
// thumbnail designer; the designer lines up options (A–F) in a private tray and sends them as a round; a manager
// picks one or asks for changes, and may decide again until the designer sends another round. Where a brief stands
// is never stored: it's worked out from its rounds and decisions (thumbnailState in shared/workflow.ts), here and in
// SQL (THUMB_LATEST_SENT and THUMB_WINNER in server/files.ts) alike.
//
// Who sees what: a designer gets their own Studio and briefs from the session, plus the rounds they sent on a brief
// since given to someone else (read-only); only a brief's current designer ever gets its unsent tray. Managers see
// every brief but sent rounds only (a designer's draft count, never the images), and may open a designer's Studio
// with ?userId=. Option images are kept only when their own bytes say PNG, JPEG or WebP (server/images.ts), and are
// stored under that type, never the browser's.
//
// A decision can carry pins (numbered notes on spots of the round's options) and a pick can be marked Standout; a
// pick is celebrated for whoever made the option (recordThumbMoment in server/moments.ts). Pins are on options, so a
// designer reads them only on rounds they sent. A designer's AI second look on an option (server/second-look.ts)
// rides on that option for its maker only.
//
// Phase 4: a manager marks a picked thumbnail live (POST /api/thumbnails/:id/published: the video's link, the day,
// YouTube Test & Compare's winner among the sent options and a note), and its maker is told once; a new decision that
// changes the pick takes the mark back. A brief can name the Timeliner video it's for (from the site's copy of
// Timeliner: GET /api/thumbnails/timeliner-videos, managers only), and the managers' board asks to mark it live once
// that video is Posted. A designer's portfolio (GET /api/studio/portfolio) is every current winner they made, each
// with its round story, and private growth figures worked out from the rows (portfolioGrowth in shared/workflow.ts).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from './db';
import { clockFor, loadUsers, logActivity, managerIds, notify, type Ctx } from './core';
import { requireManager, requireUser } from './auth';
import { conflict, forbidden, HttpError, notFound, optionalDate, parse, zs } from './http';
import { loadClientBrand, loadResources } from './records';
import { storeFile, THUMB_LATEST_SENT, THUMB_WINNER } from './files';
import { asImageUpload, uploadedImageInfo } from './images';
import { recordThumbMoment } from './moments';
import { readForm } from './submissions';
import { addDays, isYearMonth, monthOf, nowInZone, startOfMonth, startOfWeek, type Clock, type ISODate, type YearMonth } from '../shared/dates';
import { fmtDate, plural } from '../shared/format';
import {
  asksToMarkLive, briefOrder, clearsLive, DEFAULT_OPTIONS, isDesignerTurn, isManager, isOpenThumb, isPictureMime, isPostedVideo, isThumbnailDesigner,
  JUST_PICKED_MS, liveProblems, MAX_OPTIONS, MAX_PINS, mergeLive, nextBrief, nextLetter, offersTimelinerVideo, PIN_NOTE_MAX, portfolioGrowth, portfolioPath, roundStory,
  THUMB_ACTIONS, THUMB_PIN_TAGS, thumbBriefPath, thumbLiveKey, thumbnailState, tidySecondLook, TIMELINER_STATUS_GROUPS, TIMELINER_STEP_LABEL,
  timelinerVideoUrl,
  type EditorKind, type OptionLetter, type Role, type StoryBrief, type ThumbAction, type ThumbMime, type ThumbPinTag, type TimelinerStatusGroup,
} from '../shared/workflow';
import {
  fileUrl, THUMBNAIL_LIVE_NOTIFICATION,
  type Counts, type Me, type PortfolioCard, type PortfolioPayload, type StudioHero, type StudioPayload, type ThumbnailBoard, type ThumbnailBrief,
  type ThumbnailBriefDetail, type ThumbnailDecision, type ThumbnailDesignerLoad, type ThumbnailLive, type ThumbnailOption, type ThumbnailPin,
  type ThumbnailRound, type ThumbnailSecondLook, type ThumbnailVideoLink, type ThumbnailWin, type TimelinerVideoChoice, type TimelinerVideoChoices,
} from '../shared/types';

/** How long a picked or cancelled brief stays on the managers' board. */
const BOARD_RECENT_DAYS = 14;
/** The most picked options on a Studio's Wall of wins, and beside a brief. */
const WALL_SIZE = 60;
/** The most of a client's winners shown beside a brief and on the client's page (its Brand kit). */
export const RECENT_WINNERS = 8;

// ── SQL ──────────────────────────────────────────────────────────────────

/** SQL: when brief `b`'s newest sent round was last decided (its pick time, when it's picked). Inner alias: pd. */
const DECIDED_AT = (b: string) =>
  `(select pd.created_at from thumbnail_decisions pd where pd.round_id = ${THUMB_LATEST_SENT(b)} order by pd.created_at desc, pd.id desc limit 1)`;
/** SQL: the action of the newest decision on brief `b`'s newest sent round, or null. Inner alias: pa. */
const DECIDED_ACTION = (b: string) =>
  `(select pa.action from thumbnail_decisions pa where pa.round_id = ${THUMB_LATEST_SENT(b)} order by pa.created_at desc, pa.id desc limit 1)`;
/** SQL: the id of the newest decision on brief `b`'s newest sent round (the pick's, when it's picked), or null. Inner alias: pi. */
const DECIDED_ID = (b: string) =>
  `(select pi.id from thumbnail_decisions pi where pi.round_id = ${THUMB_LATEST_SENT(b)} order by pi.created_at desc, pi.id desc limit 1)`;
/** SQL: brief `b` is open (not cancelled, nothing picked): isOpenThumb. */
const OPEN = (b: string) => `(${b}.cancelled_at is null and ${THUMB_WINNER(b)} is null)`;
/** SQL: task `tt` of the site's copy of Timeliner is a scripts PDF linked to its batch, not a video. */
const SCRIPTS_PDF = (tt: string) => `exists (select 1 from timeliner_pdfs sp where sp.kind = 'task' and sp.key = ${tt}.id)`;

const BRIEF_SELECT = `
  select b.id, b.client_id, c.name as client_name, b.shoot_id, s.start_date as shoot_date, b.title, b.brief, b.on_image, b.options_wanted,
         b.due_on, b.designer_id, d.name as designer_name, d.role as designer_role, d.editor_kind as designer_kind, d.active as designer_active,
         d.removed_at as designer_removed_at, b.created_by, cu.name as created_by_name, b.created_at, b.updated_at, b.cancelled_at,
         b.published_url, b.published_on, b.published_by, pu.name as published_by_name, b.published_at, b.test_winner_variant_id, b.test_note,
         b.timeliner_task_id, tt.title as video_title, tt.status_group as video_status_group, tt.step_label as video_step_label
    from thumbnail_briefs b
    join clients c on c.id = b.client_id
    join users cu on cu.id = b.created_by
    left join shoots s on s.id = b.shoot_id
    left join users d on d.id = b.designer_id
    left join users pu on pu.id = b.published_by
    left join timeliner_tasks tt on tt.id = b.timeliner_task_id`;

const OPTION_COLUMNS = `v.id, v.round_id, r.brief_id, r.number as round_number, v.letter, v.file_id, f.filename as file_name, v.mime, v.width, v.height,
         f.size, v.note, v.uploaded_by, u.name as uploaded_by_name, v.created_at`;
const OPTION_JOINS = `thumbnail_variants v join thumbnail_rounds r on r.id = v.round_id join files f on f.id = v.file_id join users u on u.id = v.uploaded_by`;

interface BriefRow {
  id: number; client_id: number; client_name: string; shoot_id: number | null; shoot_date: ISODate | null; title: string; brief: string | null;
  on_image: string | null; options_wanted: number; due_on: ISODate | null; designer_id: number | null; designer_name: string | null;
  designer_role: Role | null; designer_kind: EditorKind | null; designer_active: boolean | null; designer_removed_at: string | null;
  created_by: number; created_by_name: string; created_at: string; updated_at: string; cancelled_at: string | null;
  /** the went-live mark (thumbnail_briefs_published_check: anything set has published_on) */
  published_url: string | null; published_on: ISODate | null; published_by: number | null; published_by_name: string | null; published_at: string | null;
  test_winner_variant_id: number | null; test_note: string | null;
  /** the Timeliner video it's for, and that video in the copy now (null when the copy has lost it) */
  timeliner_task_id: string | null; video_title: string | null; video_status_group: string | null; video_step_label: string | null;
}

interface OptionRow {
  id: number; round_id: number; brief_id: number; round_number: number; letter: OptionLetter; file_id: number; file_name: string; mime: ThumbMime;
  width: number; height: number; size: number; note: string | null; uploaded_by: number; uploaded_by_name: string; created_at: string;
}

/**
 * A kept second look (thumbnail_second_looks.result, as either engine returns jsonb) as an option carries it: tidied
 * again on the way out, so a row that's somehow odd is left out rather than shown half-formed.
 */
export function secondLookOf(optionId: number, stored: unknown, createdAt: string): ThumbnailSecondLook | null {
  const result = tidySecondLook(typeof stored === 'string' ? JSON.parse(stored) : stored);
  return result ? { ...result, optionId, createdAt } : null;
}

const toOption = (r: OptionRow, picked: boolean): ThumbnailOption => ({
  id: r.id, briefId: r.brief_id, roundId: r.round_id, roundNumber: r.round_number, letter: r.letter, fileId: r.file_id, url: fileUrl(r.file_id),
  fileName: r.file_name, mime: r.mime, width: r.width, height: r.height, size: r.size, note: r.note, uploadedById: r.uploaded_by,
  uploadedByName: r.uploaded_by_name, createdAt: r.created_at, picked,
});

// ── loading briefs ───────────────────────────────────────────────────────

/** One brief with everything on it: every round (its tray included) with live options and decisions, and where it stands. */
interface Loaded {
  row: BriefRow;
  /** oldest first; the tray (unsent) is the last when there is one */
  rounds: ThumbnailRound[];
  latest: ThumbnailRound | null;
  tray: ThumbnailRound | null;
  decision: ThumbnailDecision | null;
  state: ThumbnailBrief['state'];
  winner: ThumbnailOption | null;
  /** the second looks kept on its options, by option id: present() gives each only to the option's maker */
  looks: Map<number, ThumbnailSecondLook>;
}

interface BriefWhere {
  ids?: number[];
  designerId?: number;
  /** only open briefs (not picked or cancelled) */
  open?: boolean;
  /** the board: open briefs, and those picked or cancelled since this time */
  since?: string;
}

async function loadBriefs(db: Db, where: BriefWhere): Promise<Loaded[]> {
  const cond: string[] = [];
  const params: unknown[] = [];
  if (where.ids) {
    if (!where.ids.length) return [];
    params.push(where.ids);
    cond.push(`b.id = any($${params.length}::bigint[])`);
  }
  if (where.designerId) { params.push(where.designerId); cond.push(`b.designer_id = $${params.length}`); }
  if (where.open) cond.push(OPEN('b'));
  if (where.since) {
    params.push(where.since);
    const p = `$${params.length}::timestamptz`;
    cond.push(`((b.cancelled_at is null and (${THUMB_WINNER('b')} is null or ${DECIDED_AT('b')} >= ${p})) or b.cancelled_at >= ${p})`);
  }
  const rows = await db.query<BriefRow>(`${BRIEF_SELECT} ${cond.length ? `where ${cond.join(' and ')}` : ''} order by b.id`, params);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [rounds, options, decisions, pins, looks] = await Promise.all([
    db.query<{ id: number; brief_id: number; number: number; note: string | null; created_by: number; created_by_name: string; created_at: string; sent_at: string | null }>(
      `select r.id, r.brief_id, r.number, r.note, r.created_by, u.name as created_by_name, r.created_at, r.sent_at
         from thumbnail_rounds r join users u on u.id = r.created_by where r.brief_id = any($1::bigint[]) order by r.brief_id, r.number`, [ids],
    ),
    db.query<OptionRow>(`select ${OPTION_COLUMNS} from ${OPTION_JOINS} where r.brief_id = any($1::bigint[]) and v.removed_at is null order by v.round_id, v.letter`, [ids]),
    db.query<{
      id: number; round_id: number; round_number: number; action: ThumbAction; variant_id: number | null; letter: OptionLetter | null; note: string | null;
      decided_by: number; decided_by_name: string; created_at: string; standout: boolean;
    }>(
      `select d.id, d.round_id, r.number as round_number, d.action, d.variant_id, v.letter, d.note, d.decided_by, u.name as decided_by_name, d.created_at, d.standout
         from thumbnail_decisions d join thumbnail_rounds r on r.id = d.round_id join users u on u.id = d.decided_by
         left join thumbnail_variants v on v.id = d.variant_id
        where r.brief_id = any($1::bigint[]) order by d.created_at desc, d.id desc`, [ids],
    ),
    db.query<{ id: number; decision_id: number; variant_id: number; letter: OptionLetter; x: number; y: number; n: number; body: string; tag: ThumbPinTag | null }>(
      `select p.id, p.decision_id, p.variant_id, v.letter, p.x, p.y, p.n, p.body, p.tag
         from thumbnail_pins p join thumbnail_decisions d on d.id = p.decision_id join thumbnail_rounds r on r.id = d.round_id
         join thumbnail_variants v on v.id = p.variant_id
        where r.brief_id = any($1::bigint[]) order by p.decision_id, p.n`, [ids],
    ),
    db.query<{ variant_id: number; result: unknown; created_at: string }>(
      `select s.variant_id, s.result, s.created_at from thumbnail_second_looks s join thumbnail_variants v on v.id = s.variant_id
         join thumbnail_rounds r on r.id = v.round_id where r.brief_id = any($1::bigint[])`, [ids],
    ),
  ]);
  const optionsOf = new Map<number, OptionRow[]>();
  for (const o of options) optionsOf.set(o.round_id, [...(optionsOf.get(o.round_id) ?? []), o]);
  const pinsOf = new Map<number, ThumbnailPin[]>();
  for (const p of pins) {
    pinsOf.set(p.decision_id, [...(pinsOf.get(p.decision_id) ?? []), {
      id: p.id, decisionId: p.decision_id, optionId: p.variant_id, optionLetter: p.letter, x: p.x, y: p.y, n: p.n, body: p.body, tag: p.tag,
    }]);
  }
  const decisionsOf = new Map<number, ThumbnailDecision[]>();
  for (const d of decisions) {
    const list = decisionsOf.get(d.round_id) ?? [];
    list.push({
      id: d.id, roundId: d.round_id, roundNumber: d.round_number, action: d.action, optionId: d.variant_id, optionLetter: d.letter, note: d.note,
      decidedById: d.decided_by, decidedByName: d.decided_by_name, createdAt: d.created_at, superseded: list.length > 0,
      standout: !!d.standout, pins: pinsOf.get(d.id) ?? [],
    });
    decisionsOf.set(d.round_id, list);
  }
  const looksOf = new Map<number, ThumbnailSecondLook>();
  for (const k of looks) {
    const look = secondLookOf(Number(k.variant_id), k.result, k.created_at);
    if (look) looksOf.set(look.optionId, look);
  }
  const roundsOf = new Map<number, typeof rounds>();
  for (const r of rounds) roundsOf.set(r.brief_id, [...(roundsOf.get(r.brief_id) ?? []), r]);

  return rows.map((row) => {
    const mine = roundsOf.get(row.id) ?? [];
    const sent = mine.filter((r) => r.sent_at);
    const latestRow = sent[sent.length - 1] ?? null;
    const trayRow = mine.find((r) => !r.sent_at) ?? null;
    const decision = latestRow ? decisionsOf.get(latestRow.id)?.[0] ?? null : null;
    const draftOptions = trayRow ? (optionsOf.get(trayRow.id) ?? []).length : 0;
    const state = thumbnailState({ cancelledAt: row.cancelled_at, draftOptions }, latestRow, decision);
    const winnerId = state === 'picked' ? decision?.optionId ?? null : null;
    const list: ThumbnailRound[] = mine.map((r) => ({
      id: r.id, briefId: row.id, number: r.number, sentAt: r.sent_at, note: r.note, createdById: r.created_by, createdByName: r.created_by_name,
      createdAt: r.created_at, options: (optionsOf.get(r.id) ?? []).map((o) => toOption(o, o.id === winnerId)), decisions: decisionsOf.get(r.id) ?? [],
      superseded: !!r.sent_at && !!latestRow && r.number < latestRow.number,
    }));
    const latest = latestRow ? list.find((r) => r.id === latestRow.id) ?? null : null;
    const tray = trayRow ? list.find((r) => r.id === trayRow.id) ?? null : null;
    return { row, rounds: list, latest, tray, decision, state, winner: latest?.options.find((o) => o.picked) ?? null, looks: looksOf };
  });
}

/**
 * Who a brief is being shown to. Managers see every sent round. A designer sees their own work and, from anyone
 * else, only the winner (owner's rule: unsent drafts and unpicked options stay private to whoever made them).
 */
interface View {
  /** the brief's tray is shown only when this is its current designer */
  trayFor: number | null;
  /** a designer the brief was taken from: only the rounds they sent, and nothing of the brief's since then */
  sentBy?: number;
  /**
   * a designer whose brief it is now: rounds sent on it by someone else keep their notes and decisions (what was
   * asked, for context) but lose their options, apart from the winner
   */
  designer?: number;
  /** an Admin viewing the site as the designer: second looks stay private to their maker, so none are shown */
  viewingAs?: boolean;
}

/**
 * Where and when a brief went live, while it's picked and marked (else null). `maker`: the designer it's shown to (null
 * for managers), who sees the Test & Compare winner's picture only when it's their own option or the pick: another
 * designer's unpicked option stays private, so only its letter shows.
 */
function liveOf(l: Loaded, maker: number | null): ThumbnailLive | null {
  const r = l.row;
  if (l.state !== 'picked' || !r.published_on) return null;
  const testId = r.test_winner_variant_id == null ? null : Number(r.test_winner_variant_id);
  const test = testId == null ? null : l.rounds.filter((x) => x.sentAt).flatMap((x) => x.options).find((o) => o.id === testId) ?? null;
  const isPick = !!test && test.id === l.winner?.id;
  return {
    url: r.published_url, publishedOn: r.published_on,
    publishedById: r.published_by == null ? null : Number(r.published_by), publishedByName: r.published_by_name, publishedAt: r.published_at,
    testWinner: test ? {
      optionId: test.id, letter: test.letter, roundNumber: test.roundNumber, isPick,
      url: maker == null || isPick || test.uploadedById === maker ? test.url : null,
    } : null,
    testNote: r.test_note,
  };
}

const STATUS_GROUPS: ReadonlySet<string> = new Set(TIMELINER_STATUS_GROUPS);
const isStatusGroup = (g: string | null | undefined): g is TimelinerStatusGroup => g != null && STATUS_GROUPS.has(g);

/** A Timeliner video's step in the team's words: its exact step name when known, else TIMELINER_STEP_LABEL. */
const videoStep = (stepLabel: string | null, group: string): string =>
  stepLabel ?? TIMELINER_STEP_LABEL[isStatusGroup(group) ? group : 'toDo'];

/** The Timeliner video a brief is for, as the copy has it now (managers only); null when it names none. */
function videoOf(r: BriefRow): ThumbnailVideoLink | null {
  if (!r.timeliner_task_id) return null;
  const group = r.video_status_group;
  return {
    taskId: r.timeliner_task_id, title: r.video_title, step: group == null ? null : videoStep(r.video_step_label, group),
    statusGroup: isStatusGroup(group) ? group : null, posted: isPostedVideo(group), url: timelinerVideoUrl(r.timeliner_task_id),
  };
}

function present(l: Loaded, view: View): { brief: ThumbnailBrief; rounds: ThumbnailRound[]; tray: ThumbnailRound | null } {
  const r = l.row;
  const past = view.sentBy != null;
  const showTray = view.trayFor != null && r.designer_id === view.trayFor;
  // the designer looking (current or past); null for managers
  const maker = view.designer ?? view.sentBy ?? null;
  // a second look is private to the option's maker: theirs carry it (null when they haven't asked), nobody else's do,
  // and not even theirs while an Admin is viewing as them
  const withLook = (o: ThumbnailOption): ThumbnailOption =>
    (maker != null && !view.viewingAs && o.uploadedById === maker ? { ...o, secondLook: l.looks.get(o.id) ?? null } : o);
  // pins sit on a round's options, so a designer reads them only on rounds they sent (never on another designer's options)
  const pinsFor = (round: { createdById: number } | null | undefined) => maker == null || round?.createdById === maker;
  const noPins = (d: ThumbnailDecision): ThumbnailDecision => ({ ...d, pins: [] });
  const rounds = l.rounds
    .filter((x) => x.sentAt && (!past || x.createdById === view.sentBy))
    .map((x) => ({
      ...x,
      options: (view.designer == null || x.createdById === view.designer ? x.options : x.options.filter((o) => o.picked)).map(withLook),
      decisions: pinsFor(x) ? x.decisions : x.decisions.map(noPins),
    }));
  const tray = showTray && l.tray?.options.length ? { ...l.tray, options: l.tray.options.map(withLook) } : null;
  const designerOk = r.designer_id != null && !!r.designer_active && !r.designer_removed_at && !!r.designer_role
    && isThumbnailDesigner({ role: r.designer_role, editorKind: r.designer_kind });
  // a designer it was taken from: where their own newest round stands, never what came after it (someone else's
  // round, its decision, their tray); once someone else has sent a newer round, the brief is just still open
  const last = past ? rounds[rounds.length - 1] ?? null : l.latest;
  const theirsIsNewest = !!last && last.id === l.latest?.id;
  const state = past && isOpenThumb(l.state) && !theirsIsNewest ? 'to_design' : l.state;
  const shownDecision = past && !theirsIsNewest ? null : l.decision;
  // the newest decision is on the newest sent round: its pins only when that round is the viewer's own
  const decision = shownDecision && !pinsFor(l.latest) ? noPins(shownDecision) : shownDecision;
  const brief: ThumbnailBrief = {
    id: r.id, clientId: r.client_id, clientName: r.client_name, shootId: r.shoot_id, shootDate: r.shoot_date, title: r.title, brief: r.brief,
    onImage: r.on_image, optionsWanted: r.options_wanted, dueOn: r.due_on, designerId: r.designer_id, designerName: r.designer_name,
    needsDesigner: !designerOk, createdById: r.created_by, createdByName: r.created_by_name, createdAt: r.created_at, updatedAt: r.updated_at,
    cancelledAt: r.cancelled_at, state, draftOptions: past ? 0 : l.tray?.options.length ?? 0, roundsSent: last?.number ?? 0,
    nextRound: l.tray?.number ?? Math.max(0, ...l.rounds.map((x) => x.number)) + 1, sentAt: last?.sentAt ?? null, decision,
    winner: l.winner, cover: l.winner ?? [...rounds].reverse().find((x) => x.options.length)?.options[0] ?? tray?.options[0] ?? null,
    // a designer it was taken from reads nothing of the brief since their round, the mark included
    live: past && !theirsIsNewest ? null : liveOf(l, maker),
    // the Timeliner video it's for is the managers' (designers never get the keys)
    ...(maker == null ? { timelinerTaskId: r.timeliner_task_id, video: videoOf(r) } : {}),
  };
  return { brief, rounds, tray };
}

/** The current winners of briefs that aren't cancelled (any designer's), newest pick first. */
export async function loadWins(db: Db, where: { madeBy?: number; clientId?: number; exceptBriefId?: number; limit?: number }): Promise<ThumbnailWin[]> {
  const cond = ['b.cancelled_at is null'];
  const params: unknown[] = [];
  if (where.clientId) { params.push(where.clientId); cond.push(`b.client_id = $${params.length}`); }
  if (where.exceptBriefId) { params.push(where.exceptBriefId); cond.push(`b.id <> $${params.length}`); }
  let by = '';
  if (where.madeBy) { params.push(where.madeBy); by = `and v.uploaded_by = $${params.length}`; }
  const rows = await db.query<OptionRow & {
    title: string; client_id: number; client_name: string; picked_at: string; picked_by_name: string; reason: string | null; standout: boolean;
    published_url: string | null; published_on: ISODate | null;
  }>(
    `with w as (select b.id as brief_id, ${THUMB_WINNER('b')} as variant_id from thumbnail_briefs b where ${cond.join(' and ')})
     select ${OPTION_COLUMNS}, tb.title, tb.client_id, c.name as client_name, pk.created_at as picked_at, pk.picked_by_name, pk.note as reason, pk.standout,
            tb.published_url, tb.published_on
       from w
       join thumbnail_variants v on v.id = w.variant_id
       join thumbnail_rounds r on r.id = v.round_id
       join files f on f.id = v.file_id
       join users u on u.id = v.uploaded_by
       join thumbnail_briefs tb on tb.id = w.brief_id
       join clients c on c.id = tb.client_id
       join lateral (select x.created_at, x.note, x.standout, xu.name as picked_by_name from thumbnail_decisions x join users xu on xu.id = x.decided_by
                      where x.round_id = v.round_id order by x.created_at desc, x.id desc limit 1) pk on true
      where v.removed_at is null ${by}
      order by pk.created_at desc, v.id desc ${where.limit ? `limit ${Math.max(1, Math.floor(where.limit))}` : ''}`,
    params,
  );
  return rows.map((r) => ({
    option: toOption(r, true), briefId: r.brief_id, title: r.title, clientId: r.client_id, clientName: r.client_name,
    pickedAt: r.picked_at, pickedByName: r.picked_by_name, reason: r.reason, standout: !!r.standout,
    // a winner is picked, so its brief's mark is current (the Studio's Live badge)
    live: r.published_on ? { url: r.published_url, publishedOn: r.published_on } : null,
  }));
}

/**
 * One brief as `me` may see it (404 when they may not, so its existence doesn't leak). `viewingAs`: an Admin is
 * viewing the site as `me`, so second looks are left out (they're private to their maker).
 */
export async function loadThumbnailDetail(db: Db, me: Me, id: number, opts: { viewingAs?: boolean } = {}): Promise<ThumbnailBriefDetail> {
  const [l] = await loadBriefs(db, { ids: [id] });
  if (!l) throw notFound('Thumbnail brief');
  let viewer: ThumbnailBriefDetail['viewer'];
  let view: View;
  if (isManager(me.role)) {
    viewer = 'manager';
    view = { trayFor: null };
  } else if (isThumbnailDesigner(me) && l.row.designer_id === me.id) {
    viewer = 'designer';
    view = { trayFor: me.id, designer: me.id, viewingAs: opts.viewingAs };
  } else if (isThumbnailDesigner(me) && l.rounds.some((r) => r.sentAt && r.createdById === me.id)) {
    // a brief since given to someone else: the rounds they sent, read-only
    viewer = 'past_designer';
    view = { trayFor: null, sentBy: me.id, viewingAs: opts.viewingAs };
  } else {
    throw notFound('Thumbnail brief');
  }
  const { brief, rounds, tray } = present(l, view);
  const client = await db.one<{ brand_voice: string | null; guidance: string | null }>(`select brand_voice, guidance from clients where id = $1`, [brief.clientId]);
  const [resources, brand] = await Promise.all([loadResources(db, { clientId: brief.clientId, clientOnly: true }), loadClientBrand(db, brief.clientId)]);
  const pictures = (r: (typeof resources)[number]) => r.fileId != null && isPictureMime(r.fileMime);
  const open = isOpenThumb(brief.state);
  const inTray = tray?.options.length ?? 0;
  // the client's picks beside the brief, anyone's (owner's rule); how a manager rated another designer's pick is
  // private to that designer, so a designer sees Standout only on their own
  const winners = await loadWins(db, { clientId: brief.clientId, exceptBriefId: brief.id, limit: RECENT_WINNERS });
  const recentWinners = viewer === 'manager' ? winners : winners.map((w) => (w.standout && w.option.uploadedById !== me.id ? { ...w, standout: false } : w));
  return {
    ...brief, rounds, tray, viewer,
    can: {
      upload: viewer === 'designer' && open && inTray < MAX_OPTIONS,
      send: viewer === 'designer' && open && inTray > 0,
      decide: viewer === 'manager' && !brief.cancelledAt && brief.roundsSent > 0,
      edit: viewer === 'manager',
      markLive: viewer === 'manager' && brief.state === 'picked',
    },
    look: {
      clientId: brief.clientId, clientName: brief.clientName, brandVoice: client?.brand_voice ?? null, guidance: client?.guidance ?? null, brand,
      images: resources.filter(pictures), resources: resources.filter((r) => !pictures(r)),
    },
    recentWinners,
  };
}

// ── counts (the menu badges) ─────────────────────────────────────────────

/**
 * Counted from rows: managers' rounds waiting for a decision and their open briefs (so the Thumbnails item shows
 * even while no one is a thumbnail designer), and a designer's briefs on their plate (isDesignerTurn).
 */
export async function thumbnailCounts(db: Db, me: Me): Promise<Pick<Counts, 'thumbnailsToReview' | 'thumbnailsOpen' | 'myThumbnails'>> {
  if (isManager(me.role)) {
    const r = await db.one<{ review: number; open: number }>(
      `select count(*) filter (where ${THUMB_LATEST_SENT('b')} is not null
                 and not exists (select 1 from thumbnail_decisions x where x.round_id = ${THUMB_LATEST_SENT('b')})) as review,
              count(*) filter (where ${THUMB_WINNER('b')} is null) as open
         from thumbnail_briefs b where b.cancelled_at is null`,
    );
    return { thumbnailsToReview: r?.review ?? 0, thumbnailsOpen: r?.open ?? 0, myThumbnails: 0 };
  }
  if (isThumbnailDesigner(me)) {
    const r = await db.one<{ n: number }>(
      `select count(*) as n from thumbnail_briefs b where b.designer_id = $1 and b.cancelled_at is null
          and (${THUMB_LATEST_SENT('b')} is null or ${DECIDED_ACTION('b')} = 'changes')`, [me.id],
    );
    return { thumbnailsToReview: 0, thumbnailsOpen: 0, myThumbnails: r?.n ?? 0 };
  }
  return { thumbnailsToReview: 0, thumbnailsOpen: 0, myThumbnails: 0 };
}

// ── helpers for the routes ───────────────────────────────────────────────

const endOfWeek = (clock: Clock) => addDays(startOfWeek(clock.today), 6);
const dayOf = (clock: Clock, at: string) => nowInZone(clock.timezone, new Date(at)).date;
const dueThisWeek = (b: ThumbnailBrief, clock: Clock) => isOpenThumb(b.state) && !!b.dueOn && b.dueOn <= endOfWeek(clock);

/** An active thumbnail designer, or null. */
async function activeDesigner(db: Db, id: number): Promise<{ id: number; name: string } | null> {
  const u = await db.one<{ id: number; name: string; role: Role; editor_kind: EditorKind | null; active: boolean; removed_at: string | null }>(
    `select id, name, role, editor_kind, active, removed_at from users where id = $1`, [id],
  );
  return u && u.active && !u.removed_at && isThumbnailDesigner({ role: u.role, editorKind: u.editor_kind }) ? { id: u.id, name: u.name } : null;
}

const chooseDesigner = () => new HttpError(400, 'Choose a thumbnail designer', { designerId: 'Choose a thumbnail designer' });

/** Only a thumbnail designer may work on options (managers decide; nobody else has a Studio). */
export function requireDesigner(me: Me): void {
  if (!isThumbnailDesigner(me)) throw forbidden('Only thumbnail designers can do this');
}

interface LockedBrief { id: number; client_id: number; title: string; designer_id: number | null; cancelled_at: string | null }

/** Locks the brief row: every change to a brief, its rounds, options and decisions takes it first. */
const lockBrief = (t: Db, id: number) =>
  t.one<LockedBrief>(`select id, client_id, title, designer_id, cancelled_at from thumbnail_briefs where id = $1 for update`, [id]);

/** Refuses work on a brief that's done with: cancelled, or an option already picked. */
async function refuseClosed(t: Db, b: LockedBrief): Promise<void> {
  if (b.cancelled_at) throw conflict('This brief was cancelled, so it can’t take options any more.', 'cancelled');
  const w = await t.one<{ winner: number | null }>(`select ${THUMB_WINNER('b')} as winner from thumbnail_briefs b where b.id = $1`, [b.id]);
  if (w?.winner) throw conflict('An option has already been picked for this brief. If a manager asks for changes, you can start the next round.', 'picked');
}

const emptyToNull = (v: unknown) => (v === '' || v === undefined ? null : v);
const idParams = z.object({ id: zs.id });
const designerLink = (briefId: number) => thumbBriefPath({ role: 'editor', editorKind: 'thumbnail' }, briefId);
const managerLink = (briefId: number) => thumbBriefPath({ role: 'manager' }, briefId);

const CHOOSE_VIDEO = 'Choose a video of this client from Timeliner';

const briefFields = {
  title: zs.name('Title', 200),
  brief: zs.text(4000),
  onImage: zs.text(300),
  optionsWanted: z.number().int().min(1, 'Ask for at least 1 option').max(MAX_OPTIONS, `A round holds up to ${MAX_OPTIONS} options`),
  dueOn: optionalDate,
  designerId: zs.id.nullable().optional(),
  // a task id from GET /api/thumbnails/timeliner-videos (empty is none); checked against the brief's client in the route
  timelinerTaskId: z.string(CHOOSE_VIDEO).trim().max(200, CHOOSE_VIDEO).transform((v) => v || null).nullable().optional(),
};

/**
 * The video a brief is for: a task in the site's copy of Timeliner matched to this client, never a scripts PDF
 * (400 fields.timelinerTaskId otherwise). Its title, for the activity line.
 */
async function videoFor(t: Db, taskId: string, clientId: number): Promise<{ title: string }> {
  const v = await t.one<{ title: string }>(`select tt.title from timeliner_tasks tt where tt.id = $1 and tt.client_id = $2 and not ${SCRIPTS_PDF('tt')}`, [taskId, clientId]);
  if (!v) throw new HttpError(400, CHOOSE_VIDEO, { timelinerTaskId: CHOOSE_VIDEO });
  return v;
}

/**
 * POST /api/thumbnails/:id/published (ThumbnailLiveInput): any key may be left out, keeping what's kept (mergeLive);
 * liveProblems checks the mark that leaves.
 */
const liveSchema = z.object({
  url: z.string('Use the video’s link, starting with https://').nullable().optional(),
  // a real day in zs.date's sane range ("26" typed for the year arrives as 0026); empty is none, for liveProblems to judge
  publishedOn: z.string('Add the day it went live').nullable().optional().refine((v) => !v?.trim() || zs.date.safeParse(v.trim()).success, 'Use a valid date'),
  testWinnerOptionId: zs.id.nullable().optional(),
  testNote: z.string('Write the note as text').nullable().optional(),
});

/** GET /api/studio/portfolio (PortfolioQuery). */
const portfolioQuery = z.object({
  userId: zs.id.optional(),
  clientId: zs.id.optional(),
  month: z.string().optional().refine((v) => v === undefined || isYearMonth(v), 'Choose a month like 2026-10'),
});

/** Every brief a designer made an option for or sent a round on, cancelled ones included (what their growth is read from). */
async function briefIdsOf(db: Db, designerId: number): Promise<number[]> {
  return (await db.query<{ id: number }>(
    `select r.brief_id as id from thumbnail_rounds r where r.created_by = $1 and r.sent_at is not null
     union
     select r.brief_id as id from thumbnail_variants v join thumbnail_rounds r on r.id = v.round_id where v.uploaded_by = $1`, [designerId],
  )).map((r) => Number(r.id));
}

/** A brief's rows as the portfolio's rules read them (roundStory, portfolioGrowth): every round, never one viewer's share. */
const storyOf = (l: Loaded): StoryBrief => ({ cancelledAt: l.row.cancelled_at, rounds: l.rounds });

/**
 * Takes a brief's went-live mark back: every field null, and what the maker of `optionId` (the pick it was marked on:
 * a mark is always the current pick's) was told about it, while unread.
 */
async function takeBackLive(t: Db, briefId: number, optionId: number): Promise<void> {
  await t.query(
    `update thumbnail_briefs set published_url = null, published_on = null, published_by = null, published_at = null, test_winner_variant_id = null, test_note = null
      where id = $1`, [briefId],
  );
  await t.query(`delete from notifications where dedupe_key = $1 and read_at is null`, [thumbLiveKey(briefId, optionId)]);
}
const createSchema = z.object({ clientId: zs.id, shootId: zs.id.nullable().optional(), ...briefFields, optionsWanted: briefFields.optionsWanted.optional() });
const ON_THE_IMAGE = 'Put the note on the image';
/** A note on one spot of an option, sent with a decision (x and y from 0 to 1 across and down the picture: pinAt). */
const pinSchema = z.object({
  optionId: zs.id,
  x: z.number().min(0, ON_THE_IMAGE).max(1, ON_THE_IMAGE),
  y: z.number().min(0, ON_THE_IMAGE).max(1, ON_THE_IMAGE),
  body: zs.name('The note', PIN_NOTE_MAX),
  tag: z.enum(THUMB_PIN_TAGS).nullable().optional(),
});
const decisionSchema = z.object({
  roundId: zs.id,
  action: z.enum(THUMB_ACTIONS),
  optionId: zs.id.nullable().optional(),
  note: zs.text(1000),
  pins: z.array(pinSchema).max(MAX_PINS, `A decision holds up to ${MAX_PINS} notes on the image`).optional(),
  standout: z.boolean().optional(),
});
const patchSchema = z.object({ ...briefFields, title: briefFields.title.optional(), optionsWanted: briefFields.optionsWanted.optional(), cancelled: z.boolean().optional() });

// ── routes ───────────────────────────────────────────────────────────────

export function registerThumbnailRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;
  // a brief as the session sees it; while an Admin views the site as someone, that person's second looks stay out
  const detail = (req: FastifyRequest, me: Me, id: number) => loadThumbnailDetail(db, me, id, { viewingAs: req.viewingAs != null });

  // A designer's Studio: always their own, from the session. A manager names an active designer with ?userId= and
  // gets it read-only, without the unsent tray (only how many options are in it).
  app.get('/api/studio', async (req): Promise<StudioPayload> => {
    const me = requireUser(req);
    if (!isThumbnailDesigner(me) && !isManager(me.role)) throw forbidden('Only thumbnail designers have a Studio');
    const q = parse(z.object({ userId: zs.id.optional() }), req.query);
    const readOnly = isManager(me.role);
    const designer = readOnly ? (q.userId ? await activeDesigner(db, q.userId) : null) : { id: me.id, name: me.name };
    if (!designer) throw notFound('Thumbnail designer');
    // the designer's own view: someone else's rounds on their briefs show without their options (but the winner)
    const view: View = readOnly ? { trayFor: null } : { trayFor: designer.id, designer: designer.id, viewingAs: req.viewingAs != null };
    const clock = await clockFor(ctx);

    const shown = (await loadBriefs(db, { designerId: designer.id, open: true })).map((l) => present(l, view));
    const board = shown.map((s) => s.brief).sort(briefOrder);
    const allWins = await loadWins(db, { madeBy: designer.id });
    const wins = allWins.slice(0, WALL_SIZE);
    // the newest pick of the last 12 hours, whatever the hero is: the Studio shows it on top (as EditorHome's Done card)
    const justPicked = wins[0] && ctx.now().getTime() - new Date(wins[0].pickedAt).getTime() < JUST_PICKED_MS ? wins[0] : null;

    let hero: StudioHero = { kind: 'clear' };
    const changes = board.find((b) => b.state === 'changes');
    const next = nextBrief(board);
    if (changes) {
      const s = shown.find((x) => x.brief.id === changes.id)!;
      const round = s.rounds[s.rounds.length - 1];
      if (changes.decision && round) hero = { kind: 'changes', brief: changes, decision: changes.decision, round };
    }
    if (hero.kind === 'clear' && next) hero = { kind: 'next', brief: next };
    if (hero.kind === 'clear' && justPicked) {
      const [l] = await loadBriefs(db, { ids: [justPicked.briefId] });
      if (l) hero = { kind: 'picked', brief: present(l, view).brief, win: justPicked };
    }

    const month = startOfMonth(clock.today);
    const thisMonth = allWins.filter((w) => dayOf(clock, w.pickedAt) >= month);
    return {
      designer, readOnly, hero, justPicked, board, wins,
      // "Your best this month": the standouts among this month's picks, newest first
      best: thisMonth.filter((w) => w.standout),
      counts: {
        pickedThisMonth: thisMonth.length,
        waitingOnReview: board.filter((b) => b.state === 'in_review').length,
        dueThisWeek: board.filter((b) => dueThisWeek(b, clock)).length,
        onPlate: board.filter((b) => isDesignerTurn(b.state)).length,
      },
    };
  });

  // A designer's portfolio: every current winner they made, newest pick first, each with its round story and where it
  // went live, and their private growth figures. Always their own, from the session (?userId= is ignored); a manager
  // names an active designer with ?userId=, as for the Studio. The filters narrow only the wall: the client and month
  // lists, the total and the growth figures are always all of theirs.
  app.get('/api/studio/portfolio', async (req): Promise<PortfolioPayload> => {
    const me = requireUser(req);
    if (!isThumbnailDesigner(me) && !isManager(me.role)) throw forbidden('Only thumbnail designers have a portfolio');
    const q = parse(portfolioQuery, req.query);
    const readOnly = isManager(me.role);
    const designer = readOnly ? (q.userId ? await activeDesigner(db, q.userId) : null) : { id: me.id, name: me.name };
    if (!designer) throw notFound('Thumbnail designer');
    const clock = await clockFor(ctx);
    // read from every round as the rows have it (roundStory and portfolioGrowth), never from one viewer's share of a brief
    const loaded = await loadBriefs(db, { ids: await briefIdsOf(db, designer.id) });
    const byId = new Map(loaded.map((l) => [l.row.id, l]));
    const all: PortfolioCard[] = (await loadWins(db, { madeBy: designer.id })).flatMap((w) => {
      const l = byId.get(w.briefId);
      const story = l ? roundStory(storyOf(l), designer.id) : null;
      // the managers see every option; the designer sees a Test & Compare winner's picture only when it's theirs or the pick
      return l && story ? [{ ...w, coverUrl: w.option.url, story, live: liveOf(l, readOnly ? null : designer.id) }] : [];
    });
    const monthOfCard = (c: PortfolioCard) => monthOf(c.pickedAt, clock.timezone);
    const clients = new Map<number, { id: number; name: string; wins: number }>();
    const months = new Map<YearMonth, number>();
    for (const c of all) {
      const k = clients.get(c.clientId) ?? { id: c.clientId, name: c.clientName, wins: 0 };
      k.wins++;
      clients.set(c.clientId, k);
      const m = monthOfCard(c);
      if (m) months.set(m, (months.get(m) ?? 0) + 1);
    }
    return {
      designer, readOnly,
      filter: { clientId: q.clientId ?? null, month: q.month ?? null },
      clients: [...clients.values()].sort((a, b) => b.wins - a.wins || a.name.localeCompare(b.name) || a.id - b.id),
      months: [...months.entries()].map(([month, wins]) => ({ month, wins })).sort((a, b) => b.month.localeCompare(a.month)),
      cards: all.filter((c) => (!q.clientId || c.clientId === q.clientId) && (!q.month || monthOfCard(c) === q.month)),
      total: all.length,
      growth: portfolioGrowth(loaded.map(storyOf), designer.id, clock),
    };
  });

  // The managers' board and review queue (all workspace-wide; ?clientId= and ?designerId= narrow the briefs).
  app.get('/api/thumbnails', async (req): Promise<ThumbnailBoard> => {
    requireManager(req);
    const q = parse(z.object({ clientId: zs.id.optional(), designerId: zs.id.optional() }), req.query);
    const clock = await clockFor(ctx);
    const since = new Date(ctx.now().getTime() - BOARD_RECENT_DAYS * 86400_000).toISOString();
    const all = (await loadBriefs(db, { since })).map((l) => present(l, { trayFor: null }));
    const designers: ThumbnailDesignerLoad[] = (await loadUsers(db)).filter((u) => u.active && isThumbnailDesigner(u)).map((u) => {
      const theirs = all.map((s) => s.brief).filter((b) => b.designerId === u.id && isOpenThumb(b.state));
      return { id: u.id, name: u.name, open: theirs.length, dueThisWeek: theirs.filter((b) => dueThisWeek(b, clock)).length, inReview: theirs.filter((b) => b.state === 'in_review').length };
    });
    const shown = all.filter((s) => (!q.clientId || s.brief.clientId === q.clientId) && (!q.designerId || s.brief.designerId === q.designerId));
    const briefs = shown.map((s) => s.brief).sort(briefOrder);
    const toReview = shown
      .filter((s) => s.brief.state === 'in_review' && s.rounds.length)
      .map((s) => ({ brief: s.brief, round: s.rounds[s.rounds.length - 1] }))
      .sort((a, b) => (a.round.sentAt ?? '').localeCompare(b.round.sentAt ?? '') || a.brief.id - b.brief.id);
    const week = startOfWeek(clock.today);
    // "Posted in Timeliner — mark it live?": picked briefs (whenever picked) not marked live whose video the copy of
    // Timeliner says is Posted (asksToMarkLive), worked out on every load; nothing is stored
    const linked = await db.query<{ id: number; status_group: string }>(
      `select b.id, tt.status_group from thumbnail_briefs b join timeliner_tasks tt on tt.id = b.timeliner_task_id
        where b.cancelled_at is null and b.published_on is null and ${THUMB_WINNER('b')} is not null`,
    );
    const toMarkLive = (await loadBriefs(db, { ids: linked.filter((x) => isPostedVideo(x.status_group)).map((x) => Number(x.id)) }))
      .map((l) => present(l, { trayFor: null }).brief)
      .filter((b) => (!q.clientId || b.clientId === q.clientId) && (!q.designerId || b.designerId === q.designerId) && asksToMarkLive(b, b.video))
      .sort((a, b) => (b.decision?.createdAt ?? '').localeCompare(a.decision?.createdAt ?? '') || b.id - a.id);
    return {
      toReview, briefs, designers, toMarkLive,
      counts: {
        toReview: toReview.length,
        changes: briefs.filter((b) => b.state === 'changes').length,
        withDesigners: briefs.filter((b) => isDesignerTurn(b.state) && !b.needsDesigner).length,
        pickedThisWeek: briefs.filter((b) => b.state === 'picked' && b.decision && dayOf(clock, b.decision.createdAt) >= week).length,
        needsDesigner: briefs.filter((b) => isOpenThumb(b.state) && b.needsDesigner).length,
        toMarkLive: toMarkLive.length,
      },
    };
  });

  // New thumbnail's and Edit's "Timeliner video" picker: the client's videos in the site's copy of Timeliner (matched to
  // that client, open or Posted lately: offersTimelinerVideo), newest made first, titles only. Never a scripts PDF.
  // Managers only; registered before /api/thumbnails/:id, though the router prefers this static path anyway.
  app.get('/api/thumbnails/timeliner-videos', async (req): Promise<TimelinerVideoChoices> => {
    requireManager(req);
    const q = parse(z.object({ clientId: zs.id }), req.query);
    if (!(await db.one(`select 1 from clients where id = $1`, [q.clientId]))) throw notFound('Client');
    const rows = await db.query<{
      id: string; title: string; status_group: string; step_label: string | null; created_at: string | null; updated_at: string | null; moved_at: string | null;
      brief_id: number | null;
    }>(
      `select tt.id, tt.title, tt.status_group, tt.step_label, tt.created_at, tt.updated_at, tt.moved_at,
              (select b.id from thumbnail_briefs b where b.timeliner_task_id = tt.id and b.cancelled_at is null order by b.id desc limit 1) as brief_id
         from timeliner_tasks tt
        where tt.client_id = $1 and not ${SCRIPTS_PDF('tt')}
        order by tt.created_at desc nulls last, tt.id desc`, [q.clientId],
    );
    const now = ctx.now();
    const videos = rows
      .filter((r) => offersTimelinerVideo({ title: r.title, statusGroup: r.status_group, movedAt: r.moved_at, updatedAt: r.updated_at }, now))
      .map((r): TimelinerVideoChoice => ({
        taskId: r.id, title: r.title, step: videoStep(r.step_label, r.status_group), statusGroup: isStatusGroup(r.status_group) ? r.status_group : 'toDo',
        posted: isPostedVideo(r.status_group), createdAt: r.created_at, briefId: r.brief_id == null ? null : Number(r.brief_id),
      }));
    const s = await db.one<{ synced_at: string | null }>(`select timeliner_synced_at as synced_at from settings where id = 1`);
    return { videos, syncedAt: s?.synced_at ?? null };
  });

  app.get('/api/thumbnails/:id', async (req): Promise<ThumbnailBriefDetail> => {
    const me = requireUser(req);
    if (!isThumbnailDesigner(me) && !isManager(me.role)) throw forbidden('Only thumbnail designers and managers can open thumbnail briefs');
    const { id } = parse(idParams, req.params);
    return detail(req, me, id);
  });

  // Hands out a brief. The designer is told straight away.
  app.post('/api/thumbnails', async (req): Promise<ThumbnailBriefDetail> => {
    const me = requireManager(req);
    const input = parse(createSchema, req.body);
    const id = await db.tx(async (t) => {
      const client = await t.one<{ id: number; name: string; status: string }>(`select id, name, status from clients where id = $1`, [input.clientId]);
      if (!client) throw new HttpError(400, 'Choose a client', { clientId: 'Choose a client' });
      if (client.status === 'archived') throw new HttpError(400, 'This client is archived', { clientId: 'This client is archived' });
      if (input.shootId) {
        const s = await t.one<{ client_id: number }>(`select client_id from shoots where id = $1`, [input.shootId]);
        if (!s || s.client_id !== input.clientId) throw new HttpError(400, 'Choose a shoot for this client', { shootId: 'Choose a shoot for this client' });
      }
      const designer = input.designerId ? await activeDesigner(t, input.designerId) : null;
      if (input.designerId && !designer) throw chooseDesigner();
      if (input.timelinerTaskId) await videoFor(t, input.timelinerTaskId, client.id);
      const row = await t.one<{ id: number }>(
        `insert into thumbnail_briefs (client_id, shoot_id, title, brief, on_image, options_wanted, due_on, designer_id, created_by, timeliner_task_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
        [
          client.id, input.shootId ?? null, input.title, input.brief ?? null, input.onImage ?? null, input.optionsWanted ?? DEFAULT_OPTIONS, input.dueOn ?? null,
          designer?.id ?? null, me.id, input.timelinerTaskId ?? null,
        ],
      );
      const briefId = row!.id;
      await logActivity(t, {
        actor: me, action: 'thumbnail.created', entityType: 'thumbnail', entityId: briefId, clientId: client.id,
        summary: `Gave out the thumbnail for “${input.title}”${designer ? ` to ${designer.name}` : ' (needs a designer)'}`,
      });
      if (designer) {
        await notify(t, [designer.id], {
          type: 'thumbnail_new', title: `New thumbnail · ${input.title}`,
          body: `${me.name} gave you the thumbnail for “${input.title}” (${client.name})${input.dueOn ? `, due ${fmtDate(input.dueOn)}` : ''}.`,
          link: designerLink(briefId),
        }, me.id);
      }
      return briefId;
    });
    return detail(req, me, id);
  });

  // Edits, reassigns, cancels or reopens a brief: only the fields sent, and only those that differ from what's stored.
  // Reassigning keeps earlier rounds with whoever sent them and takes the old designer's unsent tray away.
  app.patch('/api/thumbnails/:id', async (req): Promise<ThumbnailBriefDetail> => {
    const me = requireManager(req);
    const { id } = parse(idParams, req.params);
    const input = parse(patchSchema, req.body);
    await db.tx(async (t) => {
      const b = await t.one<LockedBrief & {
        brief: string | null; on_image: string | null; options_wanted: number; due_on: ISODate | null; client_name: string; timeliner_task_id: string | null;
      }>(
        `select b.id, b.client_id, b.title, b.brief, b.on_image, b.options_wanted, b.due_on, b.designer_id, b.cancelled_at, c.name as client_name, b.timeliner_task_id
           from thumbnail_briefs b join clients c on c.id = b.client_id where b.id = $1 for update of b`, [id],
      );
      if (!b) throw notFound('Thumbnail brief');
      const set: [string, unknown][] = [];
      const changes: string[] = [];
      if (input.title !== undefined && input.title !== b.title) { set.push(['title', input.title]); changes.push(`title → “${input.title}”`); }
      if (input.brief !== undefined && (input.brief ?? null) !== b.brief) { set.push(['brief', input.brief ?? null]); changes.push('what it should show'); }
      if (input.onImage !== undefined && (input.onImage ?? null) !== b.on_image) { set.push(['on_image', input.onImage ?? null]); changes.push('words on the image'); }
      if (input.optionsWanted !== undefined && input.optionsWanted !== b.options_wanted) {
        set.push(['options_wanted', input.optionsWanted]);
        changes.push(`${plural(input.optionsWanted, 'option')} wanted`);
      }
      if (input.dueOn !== undefined && (input.dueOn ?? null) !== b.due_on) {
        set.push(['due_on', input.dueOn ?? null]);
        changes.push(input.dueOn ? `due ${fmtDate(input.dueOn)}` : 'no due date');
      }
      // only a change is checked, so a link kept from before stays after the copy of Timeliner loses that video
      if (input.timelinerTaskId !== undefined && (input.timelinerTaskId ?? null) !== b.timeliner_task_id) {
        const video = input.timelinerTaskId ? await videoFor(t, input.timelinerTaskId, b.client_id) : null;
        set.push(['timeliner_task_id', input.timelinerTaskId ?? null]);
        changes.push(video ? `Timeliner video “${video.title}”` : 'no Timeliner video');
      }
      let given: { id: number; name: string } | null = null;
      const reassigned = input.designerId !== undefined && (input.designerId ?? null) !== b.designer_id;
      if (reassigned) {
        given = input.designerId ? await activeDesigner(t, input.designerId) : null;
        if (input.designerId && !given) throw chooseDesigner();
        set.push(['designer_id', given?.id ?? null]);
        changes.push(given ? `given to ${given.name}` : 'no designer');
        // the tray was the old designer's private work: it goes with them (the unsent round itself stays, for the next designer)
        await t.query(
          `update thumbnail_variants set removed_at = now() where removed_at is null and round_id in (select id from thumbnail_rounds where brief_id = $1 and sent_at is null)`, [id],
        );
        // an old designer who sent nothing on it can't open it any more: what they haven't read about it would only lead to "not found"
        if (b.designer_id) {
          await t.query(
            `delete from notifications where user_id = $1 and read_at is null and link = $2
                and not exists (select 1 from thumbnail_rounds r where r.brief_id = $3 and r.created_by = $1 and r.sent_at is not null)`,
            [b.designer_id, designerLink(id), id],
          );
        }
      }
      const cancel = input.cancelled !== undefined && input.cancelled !== !!b.cancelled_at ? input.cancelled : undefined;
      if (cancel === true) {
        // a pick is the brief's outcome (and a win on its designer's wall), as the board says: only an open brief can be cancelled
        const w = await t.one<{ winner: number | null }>(`select ${THUMB_WINNER('b')} as winner from thumbnail_briefs b where b.id = $1`, [id]);
        if (w?.winner) throw conflict('An option has already been picked for this brief, so it can’t be cancelled. Ask for changes first if it needs another round.', 'picked');
      }
      if (cancel !== undefined) changes.push(cancel ? 'cancelled' : 'reopened');
      if (!changes.length) return;
      const params: unknown[] = [id];
      const assign = set.map(([col, v]) => { params.push(v); return `${col} = $${params.length}`; });
      if (cancel !== undefined) assign.push(`cancelled_at = ${cancel ? 'now()' : 'null'}`);
      await t.query(`update thumbnail_briefs set ${[...assign, 'updated_at = now()'].join(', ')} where id = $1`, params);
      const title = input.title ?? b.title;
      await logActivity(t, {
        actor: me, entityType: 'thumbnail', entityId: id, clientId: b.client_id,
        action: cancel === true ? 'thumbnail.cancelled' : cancel === false ? 'thumbnail.reopened' : reassigned ? 'thumbnail.reassigned' : 'thumbnail.updated',
        summary: `Thumbnail for “${title}”: ${changes.join(', ')}`,
      });
      if (given) {
        await notify(t, [given.id], {
          type: 'thumbnail_new', title: `New thumbnail · ${title}`,
          body: `${me.name} gave you the thumbnail for “${title}” (${b.client_name}).`, link: designerLink(id),
        }, me.id);
      }
    });
    return detail(req, me, id);
  });

  // Adds one option (one image per request) to the designer's private tray, starting the tray when there's none.
  app.post('/api/thumbnails/:id/options', async (req): Promise<ThumbnailBriefDetail> => {
    const me = requireUser(req);
    requireDesigner(me);
    const { id } = parse(idParams, req.params);
    // someone else's brief is refused before their upload is read (and again, locked, below)
    const owner = await db.one<{ designer_id: number | null }>(`select designer_id from thumbnail_briefs where id = $1`, [id]);
    if (!owner || owner.designer_id !== me.id) throw notFound('Thumbnail brief');
    const { fields, file } = await readForm(req, ctx.uploadLimitBytes);
    const { note } = parse(z.object({ note: zs.text(500) }), { note: emptyToNull(fields.note) });
    if (!file) throw new HttpError(400, 'Choose an image to add', { file: 'Choose an image to add' });
    // what the file really is, from its own bytes: the browser's type is never stored or served
    const info = await uploadedImageInfo(file);
    if (!info) throw new HttpError(400, 'That isn’t a PNG, JPG or WebP image. Export it as one of those and try again.', { file: 'Use a PNG, JPG or WebP image' });
    const upload = asImageUpload(file, info);
    await db.tx(async (t) => {
      // the file first, before anything is locked (as sendDocument does); a check that fails rolls it back with the rest
      const fileId = await storeFile(t, me, upload);
      const b = await lockBrief(t, id);
      if (!b || b.designer_id !== me.id) throw notFound('Thumbnail brief');
      await refuseClosed(t, b);
      let tray = await t.one<{ id: number; created_by: number }>(`select id, created_by from thumbnail_rounds where brief_id = $1 and sent_at is null for update`, [id]);
      if (!tray) {
        tray = await t.one<{ id: number; created_by: number }>(
          `insert into thumbnail_rounds (brief_id, number, created_by) values ($1, (select coalesce(max(number), 0) + 1 from thumbnail_rounds where brief_id = $1), $2)
           returning id, created_by`, [id, me.id],
        );
      } else if (tray.created_by !== me.id) {
        // a tray left by the brief's last designer (emptied when it moved): it's this designer's round now
        await t.query(`update thumbnail_rounds set created_by = $2 where id = $1`, [tray.id, me.id]);
      }
      const used = await t.query<{ letter: string }>(`select letter from thumbnail_variants where round_id = $1 and removed_at is null`, [tray!.id]);
      const letter = nextLetter(used.map((u) => u.letter));
      if (!letter) throw conflict(`A round holds up to ${MAX_OPTIONS} options. Remove one to add another.`, 'full');
      await t.query(
        `insert into thumbnail_variants (round_id, letter, file_id, mime, width, height, note, uploaded_by) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [tray!.id, letter, fileId, info.mime, info.width, info.height, note ?? null, me.id],
      );
    });
    return detail(req, me, id);
  });

  // Takes an option out of the tray before it's sent (the row and its file are kept).
  app.delete('/api/thumbnail-options/:id', async (req): Promise<ThumbnailBriefDetail> => {
    const me = requireUser(req);
    requireDesigner(me);
    const { id } = parse(idParams, req.params);
    const briefId = await db.tx(async (t) => {
      const v = await t.one<{ brief_id: number }>(`select r.brief_id from thumbnail_variants v join thumbnail_rounds r on r.id = v.round_id where v.id = $1`, [id]);
      if (!v) throw notFound('Option');
      const b = await lockBrief(t, v.brief_id);
      const o = await t.one<{ letter: string; number: number; sent_at: string | null; removed_at: string | null; uploaded_by: number }>(
        `select v.letter, r.number, r.sent_at, v.removed_at, v.uploaded_by from thumbnail_variants v join thumbnail_rounds r on r.id = v.round_id where v.id = $1`, [id],
      );
      if (!b || b.designer_id !== me.id || !o || o.uploaded_by !== me.id) throw notFound('Option');
      // a page from before it was sent (another tab, a double tap): say so, and it refreshes (useSave does on a 409)
      if (o.sent_at) throw conflict(`Option ${o.letter} was already sent with round ${o.number}, so it stays. The page has been refreshed.`, 'sent');
      if (o.removed_at) throw conflict(`Option ${o.letter} is already out of your tray. The page has been refreshed.`, 'removed');
      await t.query(`update thumbnail_variants set removed_at = now() where id = $1`, [id]);
      return v.brief_id;
    });
    return detail(req, me, briefId);
  });

  // Sends the tray as the next round. A round still waiting for a decision is superseded by it.
  app.post('/api/thumbnails/:id/send', async (req): Promise<ThumbnailBriefDetail> => {
    const me = requireUser(req);
    requireDesigner(me);
    const { id } = parse(idParams, req.params);
    const input = parse(z.object({ note: zs.text(1000) }), req.body);
    await db.tx(async (t) => {
      const b = await lockBrief(t, id);
      if (!b || b.designer_id !== me.id) throw notFound('Thumbnail brief');
      await refuseClosed(t, b);
      const tray = await t.one<{ id: number; number: number }>(`select id, number from thumbnail_rounds where brief_id = $1 and sent_at is null for update`, [id]);
      if (!tray) {
        // nothing unsent at all, after a round went: this tray was just sent (a double tap, or another tab), so the page refreshes
        const sent = await t.one<{ number: number }>(`select number from thumbnail_rounds where brief_id = $1 and sent_at is not null order by number desc limit 1`, [id]);
        if (sent) throw conflict(`Round ${sent.number} was already sent. The page has been refreshed.`, 'sent');
      }
      const live = tray ? await t.one<{ n: number }>(`select count(*) as n from thumbnail_variants where round_id = $1 and removed_at is null`, [tray.id]) : null;
      const n = live?.n ?? 0;
      if (!tray || !n) throw new HttpError(400, 'Add at least one option before sending the round', { options: 'Add at least one option' });
      // whoever sends a round is its sender for good (they keep reading it after the brief moves on)
      await t.query(`update thumbnail_rounds set sent_at = now(), note = $2, created_by = $3 where id = $1`, [tray.id, input.note ?? null, me.id]);
      await logActivity(t, {
        actor: me, action: 'thumbnail.sent', entityType: 'thumbnail', entityId: id, clientId: b.client_id,
        summary: `Sent round ${tray.number} of the thumbnail for “${b.title}”: ${plural(n, 'option')}`,
      });
      await notify(t, await managerIds(t), {
        type: 'thumbnail_sent', title: `Round ${tray.number} to review · ${b.title}`,
        body: `${me.name} sent round ${tray.number} of “${b.title}”: ${plural(n, 'option')}.${input.note ? ` “${input.note}”` : ''}`,
        link: managerLink(id),
      }, me.id);
    });
    return detail(req, me, id);
  });

  // Picks an option of the newest sent round, or asks for changes on it, either with notes pinned on spots of the
  // round's options; a pick may be marked Standout. Deciding again on the same round replaces the last decision (its
  // pins are the round's from then on, and its unread notification and unseen celebration are taken back); a round
  // superseded by a newer one is 409 stale. A pick is celebrated for whoever made the option (recordThumbMoment).
  app.post('/api/thumbnails/:id/decision', async (req): Promise<ThumbnailBriefDetail> => {
    const me = requireManager(req);
    const { id } = parse(idParams, req.params);
    const input = parse(decisionSchema, req.body);
    if (input.action === 'changes' && !input.note) throw new HttpError(400, 'Add a note so the designer knows what to change', { note: 'Add a note so the designer knows what to change' });
    if (input.action === 'pick' && !input.optionId) throw new HttpError(400, 'Choose the option you’re picking', { optionId: 'Choose an option' });
    // the database refuses a standout that isn't a pick too; say it in words instead
    if (input.standout && input.action !== 'pick') throw new HttpError(400, 'Only a pick can be marked Standout', { standout: 'Only a pick can be marked Standout' });
    const pins = input.pins ?? [];
    const standout = input.action === 'pick' && !!input.standout;
    await db.tx(async (t) => {
      const b = await lockBrief(t, id);
      if (!b) throw notFound('Thumbnail brief');
      if (b.cancelled_at) throw conflict('This brief was cancelled. Reopen it before deciding.', 'cancelled');
      // the brief, then the round
      const round = await t.one<{ id: number; brief_id: number; number: number; sent_at: string | null; created_by: number; created_by_name: string }>(
        `select r.id, r.brief_id, r.number, r.sent_at, r.created_by, u.name as created_by_name
           from thumbnail_rounds r join users u on u.id = r.created_by where r.id = $1 for update of r`, [input.roundId],
      );
      // a round of another brief, or a designer's unsent tray: not something a manager can see
      if (!round || round.brief_id !== id || !round.sent_at) throw notFound('Round');
      const newest = await t.one<{ id: number; number: number; name: string }>(
        `select r.id, r.number, u.name from thumbnail_rounds r join users u on u.id = r.created_by where r.brief_id = $1 and r.sent_at is not null order by r.number desc limit 1`, [id],
      );
      if (newest && newest.id !== round.id) {
        throw conflict(`${newest.name} sent a newer round (round ${newest.number}) a moment ago. The page has been refreshed: look at the new round before deciding.`, 'stale');
      }
      // the round's live options: what a pick and every pin must be on
      const live = new Map((await t.query<{ id: number; letter: string }>(
        `select id, letter from thumbnail_variants where round_id = $1 and removed_at is null`, [round.id],
      )).map((o) => [Number(o.id), o.letter]));
      let letter: string | null = null;
      if (input.action === 'pick') {
        letter = live.get(input.optionId!) ?? null;
        if (!letter) throw new HttpError(400, 'Choose an option from this round', { optionId: 'Choose an option from this round' });
      }
      if (pins.some((p) => !live.has(p.optionId))) {
        throw new HttpError(400, 'Each note has to be on an option of this round', { pins: 'Each note has to be on an option of this round' });
      }
      // the pick this decision replaces, and whether it was marked live
      const before = await t.one<{ winner: number | null; marked: boolean }>(
        `select ${THUMB_WINNER('b')} as winner, (b.published_on is not null) as marked from thumbnail_briefs b where b.id = $1`, [id],
      );
      const d = await t.one<{ id: number }>(
        `insert into thumbnail_decisions (round_id, action, variant_id, note, decided_by, standout) values ($1,$2,$3,$4,$5,$6) returning id`,
        [round.id, input.action, input.action === 'pick' ? input.optionId : null, input.note ?? null, me.id, standout],
      );
      const decisionId = d!.id;
      // numbered 1, 2, 3… in the order they were placed (the database refuses a number twice on one decision)
      for (const [i, p] of pins.entries()) {
        await t.query(
          `insert into thumbnail_pins (decision_id, variant_id, x, y, n, body, tag) values ($1,$2,$3,$4,$5,$6,$7)`,
          [decisionId, p.optionId, p.x, p.y, i + 1, p.body, p.tag ?? null],
        );
      }
      // a went-live mark is the pick's: one that changes the pick (another option, or changes asked) takes it back, so a
      // later pick never shows an old mark; the same option picked again keeps it, and what its maker was told about it
      if (before?.marked && before.winner != null) {
        const pickNow = input.action === 'pick' ? input.optionId! : null;
        if (Number(before.winner) === pickNow) {
          await t.query(`update notifications set thumbnail_decision_id = $2 where dedupe_key = $1`, [thumbLiveKey(id, pickNow), decisionId]);
        } else {
          await takeBackLive(t, id, Number(before.winner));
          await logActivity(t, {
            actor: me, action: 'thumbnail.unlive', entityType: 'thumbnail', entityId: id, clientId: b.client_id,
            summary: `Took back the went-live mark on the thumbnail for “${b.title}”: the pick changed`, detail: { decisionId },
          });
        }
      }
      // what the designer was told about the decision this one replaces, and its celebration, if not read or seen yet
      await t.query(
        `delete from notifications where read_at is null and thumbnail_decision_id in (select id from thumbnail_decisions where round_id = $1 and id <> $2)`,
        [round.id, decisionId],
      );
      await t.query(
        `delete from moments where seen_at is null and thumbnail_decision_id in (select id from thumbnail_decisions where round_id = $1 and id <> $2)`,
        [round.id, decisionId],
      );
      const picked = input.action === 'pick';
      const onIt = pins.length ? `, with ${plural(pins.length, 'note')} on the image` : '';
      await logActivity(t, {
        actor: me, action: picked ? 'thumbnail.picked' : 'thumbnail.changes', entityType: 'thumbnail', entityId: id, clientId: b.client_id,
        summary: picked
          ? `Picked option ${letter} of round ${round.number} for “${b.title}”${standout ? ' as a standout' : ''}${onIt}`
          : `Asked for changes on round ${round.number} of “${b.title}”${onIt}`,
        detail: { decisionId, roundId: round.id },
      });
      if (picked) {
        // celebrated for whoever made the option (their next visit opens with it)
        await recordThumbMoment(t, decisionId, me);
        // the win is the round's sender's (it goes on their wall), even when the brief has moved to someone else since
        const maker = await activeDesigner(t, round.created_by);
        const reason = input.note ? `: “${input.note}”` : '.';
        if (maker) {
          await notify(t, [maker.id], {
            type: 'thumbnail_picked', title: `Option ${letter} picked · ${b.title}`,
            body: `${me.name} picked option ${letter} of round ${round.number}${standout ? ' and marked it Standout' : ''}${reason}`,
            link: designerLink(id), thumbnailDecisionId: decisionId,
          }, me.id);
        }
        // and the brief's designer, when that's someone else: it's done, so it leaves their board
        if (b.designer_id && b.designer_id !== round.created_by) {
          await notify(t, [b.designer_id], {
            type: 'thumbnail_picked', title: `Picked · ${b.title}`,
            body: `${me.name} picked ${round.created_by_name}’s option ${letter} from round ${round.number}, so this brief is done${reason}`,
            link: designerLink(id), thumbnailDecisionId: decisionId,
          }, me.id);
        }
      } else if (b.designer_id) {
        // changes: whoever has the brief now makes the next round
        await notify(t, [b.designer_id], {
          type: 'thumbnail_changes', title: `Changes asked · ${b.title}`,
          // the pins are on the round's options, which only its sender reads
          body: `${me.name} on round ${round.number}: “${input.note}”${pins.length && b.designer_id === round.created_by ? ` (${plural(pins.length, 'note')} on the image)` : ''}`,
          link: designerLink(id), thumbnailDecisionId: decisionId,
        }, me.id);
      }
    });
    return detail(req, me, id);
  });

  // Marks a picked thumbnail live, changes the mark, or takes it back (every field left empty). Only the keys sent
  // change (mergeLive), so two managers changing different fields never undo each other. The picked option's maker is
  // told once per pick (de-duplicated by thumbLiveKey; taking the mark back takes that back while it's unread, and so
  // does a later decision on the round, through the pick's decision id). Logged only when something changed.
  app.post('/api/thumbnails/:id/published', async (req): Promise<ThumbnailBriefDetail> => {
    const me = requireManager(req);
    const { id } = parse(idParams, req.params);
    const input = parse(liveSchema, req.body);
    await db.tx(async (t) => {
      const b = await lockBrief(t, id);
      if (!b) throw notFound('Thumbnail brief');
      const cur = await t.one<{
        winner: number | null; decision_id: number | null; published_url: string | null; published_on: ISODate | null; test_winner_variant_id: number | null; test_note: string | null;
      }>(
        `select ${THUMB_WINNER('b')} as winner, ${DECIDED_ID('b')} as decision_id, b.published_url, b.published_on, b.test_winner_variant_id, b.test_note
           from thumbnail_briefs b where b.id = $1`, [id],
      );
      if (b.cancelled_at || cur?.winner == null) {
        throw conflict('Only a picked thumbnail can be marked live. The page has been refreshed.', 'not_picked');
      }
      const winner = Number(cur.winner);
      const testBefore = cur.test_winner_variant_id == null ? null : Number(cur.test_winner_variant_id);
      const mark = mergeLive({ url: cur.published_url, publishedOn: cur.published_on, testWinnerOptionId: testBefore, testNote: cur.test_note }, input);
      // the dialog's rules and the route's are the same (and the database checks the day: thumbnail_briefs_published_check)
      const problems = Object.fromEntries(Object.entries(liveProblems(mark)).filter((e): e is [string, string] => typeof e[1] === 'string'));
      const said = Object.values(problems);
      if (said.length) throw new HttpError(400, said.length > 1 ? 'Please fix the highlighted fields' : said[0], problems, 'validation');
      const marked = cur.published_on != null;
      if (clearsLive(mark)) {
        if (!marked) return;
        await takeBackLive(t, id, winner);
        await logActivity(t, {
          actor: me, action: 'thumbnail.unlive', entityType: 'thumbnail', entityId: id, clientId: b.client_id,
          summary: `Took back the went-live mark on the thumbnail for “${b.title}”`,
        });
        return;
      }
      // Test & Compare ran between options viewers saw: one of this brief's sent rounds' (never a tray's, nor another
      // brief's); only a new one is checked
      if (mark.testWinnerOptionId != null && mark.testWinnerOptionId !== testBefore) {
        const sent = await t.one(
          `select 1 from thumbnail_variants v join thumbnail_rounds r on r.id = v.round_id where v.id = $1 and r.brief_id = $2 and r.sent_at is not null and v.removed_at is null`,
          [mark.testWinnerOptionId, id],
        );
        if (!sent) throw new HttpError(400, 'Choose one of the options sent on this brief', { testWinnerOptionId: 'Choose one of the options sent on this brief' });
      }
      const changed = [
        cur.published_on !== mark.publishedOn && `live on ${fmtDate(mark.publishedOn!)}`,
        cur.published_url !== mark.url && (mark.url ? 'the video’s link' : 'no link'),
        testBefore !== mark.testWinnerOptionId && (mark.testWinnerOptionId ? 'the Test & Compare winner' : 'no Test & Compare winner'),
        cur.test_note !== mark.testNote && (mark.testNote ? 'the note' : 'no note'),
      ].filter((x): x is string => !!x);
      if (!changed.length) return;
      await t.query(
        `update thumbnail_briefs set published_url = $2, published_on = $3, published_by = $4, published_at = now(), test_winner_variant_id = $5, test_note = $6
          where id = $1`,
        [id, mark.url, mark.publishedOn, me.id, mark.testWinnerOptionId, mark.testNote],
      );
      await logActivity(t, {
        actor: me, action: 'thumbnail.live', entityType: 'thumbnail', entityId: id, clientId: b.client_id,
        summary: marked ? `Went-live mark on the thumbnail for “${b.title}”: ${changed.join(', ')}` : `Marked the thumbnail for “${b.title}” live on ${fmtDate(mark.publishedOn!)}`,
        detail: { decisionId: cur.decision_id },
      });
      // whoever made the picked option, while they're an active thumbnail designer: once per pick
      const made = await t.one<{ uploaded_by: number }>(`select uploaded_by from thumbnail_variants where id = $1`, [winner]);
      const maker = made ? await activeDesigner(t, made.uploaded_by) : null;
      if (maker) {
        await notify(t, [maker.id], {
          type: THUMBNAIL_LIVE_NOTIFICATION, title: `Your thumbnail for “${b.title}” went live`,
          body: `${me.name} marked it live on ${fmtDate(mark.publishedOn!)}.`,
          link: portfolioPath({ card: winner }), dedupeKey: thumbLiveKey(id, winner), thumbnailDecisionId: cur.decision_id,
        }, me.id);
      }
    });
    return detail(req, me, id);
  });
}
