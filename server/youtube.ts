// Past thumbnails from YouTube. On the managers' board, "Add past thumbnails" takes pasted YouTube links: Look up
// (POST /api/thumbnails/youtube/lookup) reads each video's title, channel, publish date and a small preview of its
// thumbnail, storing nothing; Add (POST /api/thumbnails/youtube/import) reads YouTube again and makes each video a
// brief that's already picked and live on one designer's wall: one round (sent and picked at noon on the day it went
// live, importedRoundAt), one option (YouTube's biggest thumbnail, stored as the designer's upload) and the pick. Rules
// and wording are in shared/workflow.ts (the past-thumbnails section).
//
// The server never fetches a pasted link. It reads the video's id from it (youtubeVideoId) and builds its own
// addresses from that, on YouTube's fixed hosts only: oEmbed on www.youtube.com for the title and channel, i.ytimg.com
// for the thumbnail, and either the YouTube Data API on www.googleapis.com (with YOUTUBE_API_KEY) or, best effort, the
// video's own page for the publish date. Every request has a 10-second timeout and a size cap, follows no redirect to
// another host, and every failure becomes a plain message for that row, so one video YouTube can't read never fails
// the others. A picture's type and size come from its own bytes (server/images.ts), never YouTube's Content-Type. The
// API key never reaches an answer, a log or an error. The reader is ctx.youtube (created in server/index.ts), so tests
// pass a stand-in and never touch the network.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from './db';
import { clockFor, logActivity, notify, type Ctx, type YoutubePicture, type YoutubeProblem, type YoutubeReader, type YoutubeVideo } from './core';
import { requireManager } from './auth';
import { HttpError, parse, zs } from './http';
import { bufferFile, storeFile, type UploadedFile } from './files';
import { asImageUpload, imageInfoOf, type ImageInfo } from './images';
import { activeDesigner, chooseDesigner, isYoutubeKeyClash, liveYoutubeBriefs } from './thumbnails';
import { dayOf, type ISODate } from '../shared/dates';
import { plural } from '../shared/format';
import {
  importDayProblem, importedRoundAt, isYoutubeVideoId, portfolioPath, suggestImportClient, thumbImportKey, YOUTUBE_IMPORT_LIMITS, YOUTUBE_PROBLEMS,
  youtubeAlreadyOnSite, youtubeChannelUrl, youtubeLookupRows, youtubeWatchUrl,
} from '../shared/workflow';
import {
  THUMBNAIL_IMPORTED_NOTIFICATION,
  type Me, type YoutubeImportResult, type YoutubeLookupFound, type YoutubeLookupResult, type YoutubeLookupRow,
} from '../shared/types';

const L = YOUTUBE_IMPORT_LIMITS;

// ── reading YouTube ──────────────────────────────────────────────────────

/** The only hosts the reader ever asks; every address is built here from a video id. */
const HOSTS: ReadonlySet<string> = new Set(['www.youtube.com', 'i.ytimg.com', 'www.googleapis.com']);
/** How long one read may take, its redirects and body included. */
export const YOUTUBE_TIMEOUT_MS = 10_000;
/** The most an oEmbed or Data API answer may weigh. */
const JSON_BYTES = 256 * 1024;
/** The most of a video's own page read for its publish date (when the Data API didn't give it). */
const PAGE_BYTES = 4 * 1024 * 1024;
/** Redirects followed, and only on the same host. */
const MAX_REDIRECTS = 3;
/** The longest title and channel name kept (a brief's title takes 200 characters). */
const TITLE_MAX = 200;
/** YouTube's pictures of a video, biggest first: the import takes the first that answers with a picture. */
const PICTURES = ['maxresdefault', 'sddefault', 'hqdefault'] as const;

type Got =
  | { ok: true; status: number; body: Buffer; contentType: string | null }
  | { ok: false; why: 'unreachable' | 'tooBig' };

const problem = (what: string): YoutubeProblem => ({ ok: false, problem: what });

/** Reads a body, giving up (null) as soon as it's over `max` bytes rather than cutting it short. */
async function readCapped(res: Response, max: number): Promise<Buffer | null> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      // not waited for: a body that's shared (a clone's) only finishes cancelling once every copy has
      void reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks, size);
}

/** Lets an answer's body go unread (not waited for, as above). */
const drop = (res: Response) => { void res.body?.cancel().catch(() => {}); };

/**
 * GETs one of the reader's own addresses: https on HOSTS only, a redirect followed only on the same host, the whole
 * request within YOUTUBE_TIMEOUT_MS, and a body over `maxBytes` refused. Only a 2xx answer's body is read.
 */
async function get(fetchImpl: typeof fetch, url: string, maxBytes: number, accept: string): Promise<Got> {
  let at: URL;
  try { at = new URL(url); } catch { return { ok: false, why: 'unreachable' }; }
  const signal = AbortSignal.timeout(YOUTUBE_TIMEOUT_MS);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (at.protocol !== 'https:' || !HOSTS.has(at.hostname) || at.username || at.password || at.port) return { ok: false, why: 'unreachable' };
    try {
      const res = await fetchImpl(at.toString(), { redirect: 'manual', signal, headers: { accept, 'accept-language': 'en' } });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        drop(res);
        let next: URL | null = null;
        try { next = location ? new URL(location, at) : null; } catch { next = null; }
        // never to another host (a consent page, a look-alike): that read just didn't work
        if (!next || next.hostname !== at.hostname) return { ok: false, why: 'unreachable' };
        at = next;
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        drop(res);
        return { ok: true, status: res.status, body: Buffer.alloc(0), contentType: res.headers.get('content-type') };
      }
      const length = Number(res.headers.get('content-length') ?? NaN);
      if (Number.isFinite(length) && length > maxBytes) {
        drop(res);
        return { ok: false, why: 'tooBig' };
      }
      const body = await readCapped(res, maxBytes);
      if (!body) return { ok: false, why: 'tooBig' };
      return { ok: true, status: res.status, body, contentType: res.headers.get('content-type') };
    } catch {
      // no connection, a timeout, a reset: never the error's own words, which could carry the address
      return { ok: false, why: 'unreachable' };
    }
  }
  return { ok: false, why: 'unreachable' };
}

const json = (body: Buffer): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(body.toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
/** A name as kept: one line, trimmed, at most TITLE_MAX characters; null when there's none. */
const words = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX).trim();
  return t || null;
};
/** A publish date as YouTube wrote it: a day or a timestamp (dayOf reads it), nothing longer. */
const stamp = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}[0-9T:.+\-Z]{0,30}$/i.test(v.trim()) ? v.trim() : null);

type Embed = { ok: true; title: string; channel: string | null; channelUrl: string | null } | YoutubeProblem;

/** oEmbed: the video's title and channel. 404 or 400 is not found; 401 or 403 is private or can't be embedded. */
async function readEmbed(fetchImpl: typeof fetch, videoId: string): Promise<Embed> {
  const got = await get(fetchImpl, `https://www.youtube.com/oembed?url=${encodeURIComponent(youtubeWatchUrl(videoId))}&format=json`, JSON_BYTES, 'application/json');
  if (!got.ok) return problem(YOUTUBE_PROBLEMS.unreachable);
  if (got.status === 404 || got.status === 400) return problem(YOUTUBE_PROBLEMS.notFound);
  if (got.status === 401 || got.status === 403) return problem(YOUTUBE_PROBLEMS.private);
  if (got.status !== 200) return problem(YOUTUBE_PROBLEMS.unreachable);
  const body = json(got.body);
  if (!body) return problem(YOUTUBE_PROBLEMS.unreachable);
  const title = words(body.title);
  if (!title) return problem(YOUTUBE_PROBLEMS.notFound);
  return { ok: true, title, channel: words(body.author_name), channelUrl: youtubeChannelUrl(typeof body.author_url === 'string' ? body.author_url : null) };
}

type FromApi =
  | { ok: true; title: string | null; channel: string | null; channelId: string | null; publishedAt: string | null }
  | { ok: 'missing' }
  | { ok: false };

/**
 * The YouTube Data API v3 (with YOUTUBE_API_KEY): the video's title, channel and publish date. `missing` when it has
 * no public video by that id; `ok: false` when it couldn't be asked (a bad key, the quota, no connection), so the
 * video's own page is read instead. Its address carries the key, so neither it nor YouTube's words are ever logged.
 */
async function readApi(fetchImpl: typeof fetch, key: string, videoId: string): Promise<FromApi> {
  const got = await get(fetchImpl, `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(key)}`, JSON_BYTES, 'application/json');
  if (!got.ok || got.status !== 200) {
    console.warn(`youtube: the Data API ${got.ok ? `answered ${got.status}` : 'didn’t answer'}; reading the video’s own page for its date instead`);
    return { ok: false };
  }
  const body = json(got.body);
  const items = body && Array.isArray(body.items) ? (body.items as unknown[]) : null;
  if (!items) return { ok: false };
  const item = items[0] as { id?: unknown; snippet?: Record<string, unknown> } | undefined;
  if (!item || typeof item !== 'object') return { ok: 'missing' };
  const sn = item.snippet && typeof item.snippet === 'object' ? item.snippet : {};
  const channelId = typeof sn.channelId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(sn.channelId) ? sn.channelId : null;
  return { ok: true, title: words(sn.title), channel: words(sn.channelTitle), channelId, publishedAt: stamp(sn.publishedAt) };
}

/** The meta tag and the player's data a video's own page carries its publish date in, in the order they're tried. */
const PAGE_DATES = [
  /<meta\s+itemprop=["']datePublished["']\s+content=["']([^"']{8,40})["']/i,
  /<meta\s+content=["']([^"']{8,40})["']\s+itemprop=["']datePublished["']/i,
  /"publishDate"\s*:\s*"([^"]{8,40})"/,
  /"uploadDate"\s*:\s*"([^"]{8,40})"/,
];

/** Best effort, without an API key: the publish date on the video's own page, or null (the manager types it). */
async function readPageDate(fetchImpl: typeof fetch, videoId: string): Promise<string | null> {
  const got = await get(fetchImpl, youtubeWatchUrl(videoId), PAGE_BYTES, 'text/html');
  if (!got.ok || got.status !== 200) return null;
  const page = got.body.toString('utf8');
  for (const re of PAGE_DATES) {
    const at = stamp(re.exec(page)?.[1]);
    if (at) return at;
  }
  return null;
}

/**
 * The real reader (ctx.youtube), with or without the Data API key. The title and channel come from oEmbed either way
 * (the API's title when it has one), so a channel's page, which matches a video to an earlier import's client, is the
 * same whether or not the key is set; the publish date comes from the API, else the video's page.
 */
export function youtubeReader(opts: { apiKey?: string | null; fetch?: typeof fetch } = {}): YoutubeReader {
  const fetchImpl = opts.fetch ?? fetch;
  const key = opts.apiKey?.trim() || null;
  return {
    async video(videoId): Promise<YoutubeVideo | YoutubeProblem> {
      if (!isYoutubeVideoId(videoId)) return problem(YOUTUBE_PROBLEMS.notLink);
      const [embed, api] = await Promise.all([readEmbed(fetchImpl, videoId), key ? readApi(fetchImpl, key, videoId) : Promise.resolve(null)]);
      if (api?.ok === true) {
        const title = api.title ?? (embed.ok ? embed.title : null);
        if (!title) return embed.ok ? problem(YOUTUBE_PROBLEMS.notFound) : embed;
        return {
          ok: true, videoId, title, channel: api.channel ?? (embed.ok ? embed.channel : null),
          channelUrl: (embed.ok ? embed.channelUrl : null) ?? (api.channelId ? youtubeChannelUrl(`https://www.youtube.com/channel/${api.channelId}`) : null),
          publishedAt: api.publishedAt,
        };
      }
      if (!embed.ok) return embed;
      // the API says it has no such public video, yet oEmbed shows it: go by the page, as without a key
      return { ok: true, videoId, title: embed.title, channel: embed.channel, channelUrl: embed.channelUrl, publishedAt: await readPageDate(fetchImpl, videoId) };
    },

    async picture(videoId, size): Promise<YoutubePicture | YoutubeProblem> {
      if (!isYoutubeVideoId(videoId)) return problem(YOUTUBE_PROBLEMS.notLink);
      const names = size === 'preview' ? (['hqdefault'] as const) : PICTURES;
      const cap = size === 'preview' ? L.previewBytes : L.pictureBytes;
      // the first answer that isn't a picture, for the route to refuse in its own words (it sniffs every picture again)
      let notPicture: YoutubePicture | null = null;
      let tooBig = false;
      let unreachable = false;
      for (const name of names) {
        const got = await get(fetchImpl, `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/${name}.jpg`, cap, 'image/*');
        if (!got.ok) {
          if (got.why === 'tooBig') tooBig = true;
          else unreachable = true;
          continue;
        }
        // a 404 is YouTube's grey placeholder: that size doesn't exist for this video
        if (got.status !== 200) continue;
        const picture: YoutubePicture = { ok: true, data: got.body, contentType: got.contentType, name };
        if (await imageInfoOf(got.body)) return picture;
        notPicture ??= picture;
      }
      if (notPicture) return notPicture;
      if (tooBig) return problem(YOUTUBE_PROBLEMS.tooBig);
      if (unreachable) return problem(YOUTUBE_PROBLEMS.unreachable);
      return problem(YOUTUBE_PROBLEMS.noPicture);
    },
  };
}

// ── the routes ───────────────────────────────────────────────────────────

/** How many videos are read from YouTube at once. */
const AT_ONCE = 4;

/** Runs `fn` over `items`, at most `limit` at a time, keeping their order. */
async function eachLimited<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * A read through ctx.youtube, which answers every failure as a YoutubeProblem; should it throw all the same, that video
 * just couldn't be read (never the error's words: they could carry an address with the key).
 */
async function safely<T>(read: () => Promise<T | YoutubeProblem>): Promise<T | YoutubeProblem> {
  try {
    return await read();
  } catch {
    console.warn('youtube: a read failed unexpectedly; that video is left out');
    return problem(YOUTUBE_PROBLEMS.unreachable);
  }
}

const PASTE = 'Paste at least one YouTube link';
const CHOOSE_DESIGNER = 'Choose a thumbnail designer';
const CHOOSE_CLIENT = 'Choose a client';
const lookupSchema = z.object({
  urls: z.array(z.unknown(), PASTE).min(1, PASTE).max(L.links, `Look up to ${L.links} links at a time`).transform((v, c) => {
    const out: string[] = [];
    for (const u of v) {
      if (typeof u !== 'string') { c.addIssue({ code: 'custom', message: PASTE }); return z.NEVER; }
      if (u.length > L.url) { c.addIssue({ code: 'custom', message: `A link can be up to ${L.url} characters` }); return z.NEVER; }
      out.push(u);
    }
    return out;
  }),
});

const importSchema = z.object({
  designerId: z.coerce.number(CHOOSE_DESIGNER).int(CHOOSE_DESIGNER).positive(CHOOSE_DESIGNER),
  items: z.array(z.object({
    // checked in the route (fields.items), with a repeat
    videoId: z.string(YOUTUBE_PROBLEMS.notLink),
    clientId: z.coerce.number(CHOOSE_CLIENT).int(CHOOSE_CLIENT).positive(CHOOSE_CLIENT),
    // the day it went live: importDayProblem, the dialog's words (fields["items.<i>.publishedOn"])
    publishedOn: z.string('Add the day it went live'),
    title: zs.name('Title', 200).optional(),
  }), 'Add at least one video').min(1, 'Add at least one video').max(L.links, `Add up to ${L.links} at a time`),
});

/** A preview the page can show (its CSP allows only its own images and data: URLs): sniffed, and small; else null. */
async function previewOf(p: YoutubePicture | YoutubeProblem): Promise<string | null> {
  if (!p.ok || p.data.length > L.previewBytes) return null;
  const info = await imageInfoOf(p.data);
  return info ? `data:${info.mime};base64,${p.data.toString('base64')}` : null;
}

/** Earlier imports, as suggestImportClient reads them: the channel each came from and the client it went to. */
async function earlierImports(db: Db) {
  return (await db.query<{ id: number; youtube_channel_url: string | null; client_id: number; imported_at: string }>(
    `select id, youtube_channel_url, client_id, imported_at from thumbnail_briefs
      where imported_from is not null and cancelled_at is null and youtube_channel_url is not null`,
  )).map((r) => ({ briefId: Number(r.id), channelUrl: r.youtube_channel_url, clientId: Number(r.client_id), importedAt: r.imported_at }));
}

/** A past thumbnail to add: the video, the brief's client and title, the day it went live, and its picture, sniffed. */
export interface PastThumbnail {
  videoId: string;
  clientId: number;
  title: string;
  publishedOn: ISODate;
  channel: string | null;
  channelUrl: string | null;
  upload: UploadedFile;
  info: ImageInfo;
}

/**
 * Adds one past thumbnail, inside the caller's transaction: its picture stored as the designer's upload (so it's on
 * their wall and in their portfolio), then a brief already live on YouTube (published_url its page, published_by the
 * manager), with one round sent by the designer, option A and the manager's pick, all at noon on the day it went live
 * in the workspace's time zone (importedRoundAt). No celebration and no went-live message: the caller tells the
 * designer once. A video already on a brief that isn't cancelled fails on thumbnail_briefs_youtube_key
 * (isYoutubeKeyClash). Its brief's id.
 */
export async function addPastThumbnail(t: Db, manager: Me, designer: { id: number; name: string }, p: PastThumbnail, timezone: string): Promise<number> {
  const maker: Me = { id: designer.id, name: designer.name, email: '', role: 'editor', capacityPerDay: null, editorKind: 'thumbnail' };
  // the picture first, as an option upload stores its file before anything else
  const fileId = await storeFile(t, maker, p.upload);
  const client = await t.one<{ name: string; status: string }>(`select name, status from clients where id = $1`, [p.clientId]);
  if (!client || client.status === 'archived') throw new HttpError(400, 'This client is archived now', { clientId: 'This client is archived' });
  const at = importedRoundAt(p.publishedOn, timezone);
  const brief = Number((await t.one<{ id: number }>(
    `insert into thumbnail_briefs (client_id, title, options_wanted, designer_id, created_by, published_url, published_on, published_by, published_at,
                                   imported_from, imported_at, imported_by, youtube_video_id, youtube_channel, youtube_channel_url)
     values ($1, $2, 1, $3, $4, $5, $6, $4, now(), 'youtube', now(), $4, $7, $8, $9) returning id`,
    [p.clientId, p.title, designer.id, manager.id, youtubeWatchUrl(p.videoId), p.publishedOn, p.videoId, words(p.channel), youtubeChannelUrl(p.channelUrl)],
  ))!.id);
  // one round, sent and picked at noon on the day it went live, so it's a pick of that day and month
  const round = (await t.one<{ id: number }>(
    `insert into thumbnail_rounds (brief_id, number, created_by, created_at, sent_at) values ($1, 1, $2, $3, $3) returning id`, [brief, designer.id, at],
  ))!.id;
  const option = (await t.one<{ id: number }>(
    `insert into thumbnail_variants (round_id, letter, file_id, mime, width, height, uploaded_by, created_at) values ($1, 'A', $2, $3, $4, $5, $6, $7) returning id`,
    [round, fileId, p.info.mime, p.info.width, p.info.height, designer.id, at],
  ))!.id;
  await t.query(
    `insert into thumbnail_decisions (round_id, action, variant_id, decided_by, created_at, standout) values ($1, 'pick', $2, $3, $4, false)`,
    [round, option, manager.id, at],
  );
  await logActivity(t, {
    actor: manager, action: 'thumbnail.imported', entityType: 'thumbnail', entityId: brief, clientId: p.clientId,
    summary: `Added the past thumbnail for “${p.title}” (${client.name}) to ${designer.name}’s wall, from YouTube`,
    detail: { videoId: p.videoId },
  });
  return brief;
}

/** The notification an import sends its designer, once (thumbImportKey): which past thumbnails went on their wall. */
export async function tellImported(db: Db, manager: Me, designerId: number, added: readonly { briefId: number; title: string }[]): Promise<void> {
  if (!added.length) return;
  await notify(db, [designerId], {
    type: THUMBNAIL_IMPORTED_NOTIFICATION, title: `${manager.name} added ${plural(added.length, 'past thumbnail')} to your wall`,
    body: `From YouTube: ${added.map((a) => `“${a.title}”`).join(', ')}.`,
    link: portfolioPath(), dedupeKey: thumbImportKey(added.map((a) => a.briefId)),
  }, manager.id);
}

/** One video ready to add: YouTube's description of it and its picture, sniffed. */
type Ready = Omit<PastThumbnail, 'channel' | 'channelUrl'> & { video: YoutubeVideo };

export function registerYoutubeRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;
  const readerOf = (): YoutubeReader => {
    if (!ctx.youtube) throw new HttpError(503, 'Adding past thumbnails from YouTube isn’t set up on this server.', undefined, 'not_configured');
    return ctx.youtube;
  };

  // Reads pasted YouTube links: one row per video, in the order pasted, each either ready to add (YouTube's title,
  // channel and publish date, a preview of its thumbnail, a suggested client) or why it can't be. Nothing is stored.
  app.post('/api/thumbnails/youtube/lookup', async (req): Promise<YoutubeLookupResult> => {
    requireManager(req);
    const { urls } = parse(lookupSchema, req.body);
    const rows = youtubeLookupRows(urls);
    if (!rows.length) throw new HttpError(400, PASTE, { urls: PASTE }, 'validation');
    const reader = readerOf();
    const clock = await clockFor(ctx);
    const onSite = await liveYoutubeBriefs(db, rows.flatMap((r) => (r.videoId ? [r.videoId] : [])));
    const [earlier, clients] = await Promise.all([
      earlierImports(db),
      db.query<{ id: number; name: string }>(`select id, name from clients where status <> 'archived'`),
    ]);
    const offered = clients.map((c) => ({ id: Number(c.id), name: c.name }));
    const out = await eachLimited(rows, AT_ONCE, async ({ input, videoId }): Promise<YoutubeLookupRow> => {
      if (!videoId) return { input, ok: false, problem: YOUTUBE_PROBLEMS.notLink };
      const base = { input, videoId, url: youtubeWatchUrl(videoId) };
      const existing = onSite.get(videoId);
      if (existing) return { ...base, ok: false, problem: youtubeAlreadyOnSite(existing.title), existing };
      const [video, preview] = await Promise.all([safely(() => reader.video(videoId)), safely(() => reader.picture(videoId, 'preview'))]);
      if (!video.ok) return { ...base, ok: false, problem: video.problem };
      const title = words(video.title);
      if (!title) return { ...base, ok: false, problem: YOUTUBE_PROBLEMS.notFound };
      const channelUrl = youtubeChannelUrl(video.channelUrl);
      // a day YouTube gave that can't be the day it went live (one still to come, a premiere) is left for the manager
      const day = dayOf(video.publishedAt, clock.timezone);
      const found: YoutubeLookupFound = {
        ...base, ok: true, title, channel: words(video.channel), channelUrl,
        publishedOn: day && !importDayProblem(day, clock.today) ? day : null,
        picture: await previewOf(preview),
        suggestedClientId: suggestImportClient({ channel: words(video.channel), channelUrl }, earlier, offered),
      };
      return found;
    });
    return { rows: out };
  });

  // Adds past thumbnails to one designer's wall, each a brief already picked and live, in a transaction of its own.
  // YouTube is read again (never a picture from the browser); a video already on a brief that isn't cancelled, or one
  // YouTube can't give now, is skipped and named. The designer is told once, quietly: no celebration, no went-live note.
  app.post('/api/thumbnails/youtube/import', async (req): Promise<YoutubeImportResult> => {
    const me = requireManager(req);
    const input = parse(importSchema, req.body);
    const clock = await clockFor(ctx);
    const fields: Record<string, string> = {};
    const designer = await activeDesigner(db, input.designerId);
    if (!designer) Object.assign(fields, chooseDesigner().fields);
    const seen = new Set<string>();
    for (const item of input.items) {
      if (!isYoutubeVideoId(item.videoId)) fields.items ??= YOUTUBE_PROBLEMS.notLink;
      else if (seen.has(item.videoId)) fields.items ??= YOUTUBE_PROBLEMS.twice;
      seen.add(item.videoId);
    }
    const clients = new Map((await db.query<{ id: number; name: string; status: string }>(
      `select id, name, status from clients where id = any($1::bigint[])`, [input.items.map((i) => i.clientId)],
    )).map((c) => [Number(c.id), c]));
    for (const [i, item] of input.items.entries()) {
      const c = clients.get(item.clientId);
      if (!c) fields[`items.${i}.clientId`] = CHOOSE_CLIENT;
      else if (c.status === 'archived') fields[`items.${i}.clientId`] = 'This client is archived';
      const day = importDayProblem(item.publishedOn, clock.today);
      if (day) fields[`items.${i}.publishedOn`] = day;
    }
    const said = Object.values(fields);
    if (said.length || !designer) throw new HttpError(400, said.length > 1 ? 'Please fix the highlighted fields' : said[0] ?? CHOOSE_DESIGNER, fields, 'validation');
    const reader = readerOf();

    const added: YoutubeImportResult['added'] = [];
    const skipped: YoutubeImportResult['skipped'] = [];
    const onSite = await liveYoutubeBriefs(db, input.items.map((i) => i.videoId));
    // read YouTube for each (a few at a time), then add them one by one in the order sent
    const read = await eachLimited(input.items, AT_ONCE, async (item): Promise<Ready | { videoId: string; problem: string; existing?: { briefId: number; title: string } }> => {
      const { videoId } = item;
      const existing = onSite.get(videoId);
      if (existing) return { videoId, problem: youtubeAlreadyOnSite(existing.title), existing };
      const [video, picture] = await Promise.all([safely(() => reader.video(videoId)), safely(() => reader.picture(videoId, 'best'))]);
      if (!video.ok) return { videoId, problem: video.problem };
      if (!picture.ok) return { videoId, problem: picture.problem };
      // YouTube's word for its type is never taken: only its own bytes say what it is
      if (picture.data.length > L.pictureBytes) return { videoId, problem: YOUTUBE_PROBLEMS.tooBig };
      const info = await imageInfoOf(picture.data);
      if (!info) return { videoId, problem: YOUTUBE_PROBLEMS.notPicture };
      const title = item.title ?? words(video.title);
      if (!title) return { videoId, problem: YOUTUBE_PROBLEMS.notFound };
      const upload = asImageUpload(bufferFile(title, 'application/octet-stream', picture.data), info);
      return { videoId, clientId: item.clientId, publishedOn: item.publishedOn, title, video, upload, info };
    });

    for (const r of read) {
      if (!('upload' in r)) { skipped.push(r); continue; }
      try {
        const briefId = await db.tx((t) => addPastThumbnail(t, me, designer, { ...r, channel: r.video.channel, channelUrl: r.video.channelUrl }, clock.timezone));
        added.push({ briefId, videoId: r.videoId, title: r.title });
      } catch (err) {
        if (isYoutubeKeyClash(err)) {
          // added a moment ago by someone else (or another tab): the unique index decided
          const existing = (await liveYoutubeBriefs(db, [r.videoId])).get(r.videoId);
          skipped.push({ videoId: r.videoId, problem: existing ? youtubeAlreadyOnSite(existing.title) : 'This video was just added to the site', ...(existing ? { existing } : {}) });
        } else if (err instanceof HttpError) {
          skipped.push({ videoId: r.videoId, problem: err.message });
        } else {
          // one video that can't be added never fails the others (nothing of it was kept)
          console.error(`youtube import: couldn't add ${r.videoId}`, err);
          skipped.push({ videoId: r.videoId, problem: 'Something went wrong adding this one, so it was left out. Try it again.' });
        }
      }
    }

    await tellImported(db, me, designer.id, added);
    return { added, skipped };
  });
}
