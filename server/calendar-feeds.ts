// Synced calendars: a Google Calendar (or any calendar with an iCal link) shown
// on the site's Calendar. Managers paste the calendar's "secret address in iCal
// format"; the server reads it when added, every 15 minutes, and on "Sync now".
// It's read-only: changes made in Google show up here; nothing is written back.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from './db';
import { loadSettings, logActivity, type Ctx } from './core';
import { requireManager } from './auth';
import { HttpError, notFound, parse, zs } from './http';
import { parseIcs } from './ical';
import { notifyNewCalendarShoots } from './calendar-shoots';
import type { CalendarFeed } from '../shared/types';

const MAX_BYTES = 10 * 1024 * 1024;
const PAST_DAYS = 60;
const FUTURE_DAYS = 400;

interface FeedRow { id: number; name: string; url: string; color: string; visibility: 'managers' | 'editors' | 'everyone'; last_synced_at: string | null; last_error: string | null; event_count: number }

/** Shows where the link points without giving the secret away. */
function urlHint(url: string): string {
  try {
    const u = new URL(url);
    const id = u.pathname.split('/').map((p) => { try { return decodeURIComponent(p); } catch { return p; } }).find((p) => p.includes('@')) ?? '';
    return id ? `${u.host} · ${id}` : u.host;
  } catch { return 'calendar link'; }
}
const toFeed = (r: FeedRow): CalendarFeed => ({
  id: Number(r.id), name: r.name, urlHint: urlHint(r.url), color: r.color, visibility: r.visibility,
  lastSyncedAt: r.last_synced_at, lastError: r.last_error, eventCount: Number(r.event_count),
});

const PUBLIC_ICS = (id: string) => `https://calendar.google.com/calendar/ical/${encodeURIComponent(id)}/public/basic.ics`;
const CAL_ID = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/**
 * A Google Calendar that was shared another way: its embed code (<iframe …>),
 * embed link (…/calendar/embed?src=…), share link (…?cid=…) or just its
 * address (name@gmail.com). These give the calendar's public iCal address,
 * which only works once the calendar is made public in Google.
 */
function googleCalendarId(raw: string): string | null {
  const v = raw.trim();
  const iframe = /src\s*=\s*["']([^"']+)["']/i.exec(v);
  const text = (iframe ? iframe[1] : v).replace(/&amp;/g, '&');
  if (CAL_ID.test(text)) return text;
  let u: URL;
  try { u = new URL(text); } catch { return null; }
  if (!/(^|\.)calendar\.google\.com$/i.test(u.hostname)) return null;
  const src = u.searchParams.get('src');
  if (src && CAL_ID.test(src)) return src;
  const cid = u.searchParams.get('cid');
  if (cid) {
    if (CAL_ID.test(cid)) return cid;
    try { const id = Buffer.from(cid.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); if (CAL_ID.test(id)) return id; } catch { /* not base64 */ }
  }
  return null;
}

/** webcal:// is the same link over https. Only public web addresses are allowed. */
export function normaliseFeedUrl(raw: string): string {
  const fromGoogle = /\/ical\//i.test(raw) ? null : googleCalendarId(raw);
  if (fromGoogle) return PUBLIC_ICS(fromGoogle);
  const v = raw.trim().replace(/^webcals?:\/\//i, 'https://');
  let u: URL;
  try { u = new URL(v); } catch { throw new HttpError(400, 'Paste the calendar’s iCal address, its embed code, or its email address', { url: 'Paste the calendar’s iCal address, its embed code, or its email address' }); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpError(400, 'Use an https:// link', { url: 'Use an https:// link' });
  const host = u.hostname.toLowerCase();
  const local = host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host) || host === '[::1]' || host.startsWith('[fc') || host.startsWith('[fd');
  if (local && process.env.CALENDAR_ALLOW_PRIVATE !== '1') throw new HttpError(400, 'That link points to a private address', { url: 'Use the calendar’s public iCal link' });
  if (/calendar\.google\.com\/calendar\/(u\/\d+\/)?r(\/|$|\?)/i.test(u.href)) {
    throw new HttpError(400, 'That’s the Google Calendar page. In the calendar’s settings, copy the “Secret address in iCal format” instead.', { url: 'Use the “Secret address in iCal format” (ends in .ics)' });
  }
  return u.href;
}

export type FetchText = (url: string) => Promise<string>;

/** Reads a feed with a time limit and a size cap, so a wrong link can't hang or flood the server. */
export const fetchFeed: FetchText = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { accept: 'text/calendar, */*;q=0.5' }, redirect: 'follow' });
  if ((res.status === 404 || res.status === 401 || res.status === 403) && /\/public\/basic\.ics$/i.test(url)) {
    throw new Error('That calendar isn’t public, so Google won’t share it this way. Paste its “Secret address in iCal format” instead (recommended), or make the calendar public in its Google settings.');
  }
  if (res.status === 404 || res.status === 401 || res.status === 403) throw new Error('Google refused the link. It may have been reset: copy the secret address again.');
  if (!res.ok) throw new Error(`The calendar didn’t load (error ${res.status}). It will try again in 15 minutes.`);
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) { await reader.cancel(); throw new Error('That calendar is too large to read (over 10 MB).'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
};

/** Reads one feed and replaces its events. On failure the old events stay and the error is shown in Settings. */
export async function syncFeed(db: Db, feedId: number, fetchText: FetchText = fetchFeed, at: Date = new Date()): Promise<{ ok: boolean; count: number; error: string | null }> {
  const feed = await db.one<FeedRow>(`select * from calendar_feeds where id = $1`, [feedId]);
  if (!feed) return { ok: false, count: 0, error: 'Calendar not found' };
  try {
    const settings = await loadSettings(db);
    const text = await fetchText(feed.url);
    const now = at.getTime();
    const events = parseIcs(text, new Date(now - PAST_DAYS * 86400000), new Date(now + FUTURE_DAYS * 86400000), settings.timezone);
    await db.tx(async (t) => {
      await t.query(`delete from calendar_events where feed_id = $1`, [feedId]);
      for (let i = 0; i < events.length; i += 200) {
        const chunk = events.slice(i, i + 200);
        const params: unknown[] = [];
        const rows = chunk.map((e) => {
          params.push(feedId, e.uid.slice(0, 500), e.title.slice(0, 500), e.location?.slice(0, 500) ?? null, e.description, e.allDay, e.start.toISOString(), e.end.toISOString(), e.startDate, e.endDate);
          const b = params.length - 10;
          return `(${Array.from({ length: 10 }, (_, k) => `$${b + k + 1}`).join(',')})`;
        });
        await t.query(`insert into calendar_events (feed_id, uid, title, location, description, all_day, start_at, end_at, start_date, end_date) values ${rows.join(',')}`, params);
      }
      await t.query(`update calendar_feeds set last_synced_at = now(), last_error = null, event_count = $2 where id = $1`, [feedId, events.length]);
    });
    return { ok: true, count: events.length, error: null };
  } catch (err) {
    // say it in words people can act on, not "fetch failed"
    const raw = err instanceof Error ? err.message : '';
    const msg = err instanceof Error && err.name === 'TimeoutError' ? 'The calendar took too long to answer. It will try again in 15 minutes.'
      : /fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|getaddrinfo|network/i.test(raw) ? 'Couldn’t reach that address. Check the link is the “Secret address in iCal format” from Google Calendar’s settings, and that it’s still valid.'
        : raw || 'Could not read the calendar';
    await db.query(`update calendar_feeds set last_error = $2 where id = $1`, [feedId, msg.slice(0, 300)]);
    return { ok: false, count: Number(feed.event_count), error: msg };
  }
}

export async function syncAllFeeds(db: Db, fetchText: FetchText = fetchFeed, at: Date = new Date()): Promise<number> {
  const feeds = await db.query<{ id: number }>(`select id from calendar_feeds order by id`);
  for (const f of feeds) await syncFeed(db, Number(f.id), fetchText, at);
  return feeds.length;
}

export function startCalendarSync(ctx: Ctx, minutes: number, log: (m: string) => void): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      if (await syncAllFeeds(ctx.realDb ?? ctx.db, ctx.fetchCalendar ?? fetchFeed, ctx.now())) await notifyNewCalendarShoots({ ...ctx, db: ctx.realDb ?? ctx.db });
    } catch (err) { log(`calendar sync failed: ${(err as Error).message}`); } finally { running = false; }
  };
  const first = setTimeout(tick, 20_000);
  const every = setInterval(tick, minutes * 60_000);
  return () => { clearTimeout(first); clearInterval(every); };
}

export function registerCalendarFeedRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;
  const fetchText: FetchText = (u) => (ctx.fetchCalendar ?? fetchFeed)(u);
  const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Pick a colour');
  const visibility = z.enum(['managers', 'editors', 'everyone']);

  app.get('/api/calendar-feeds', async (req) => {
    requireManager(req);
    return { feeds: (await db.query<FeedRow>(`select * from calendar_feeds order by id`)).map(toFeed) };
  });

  app.post('/api/calendar-feeds', async (req) => {
    const me = requireManager(req);
    const input = parse(z.object({ name: zs.name('Name', 80), url: z.string().trim().min(1, 'Paste the calendar’s secret iCal address').max(4000), color: color.default('#9CC7F7'), visibility: visibility.default('managers') }), req.body);
    const url = normaliseFeedUrl(input.url);
    // check the link before saving it, so a wrong one is caught straight away
    let text: string;
    try { text = await fetchText(url); parseIcs(text, new Date(), new Date()); } catch (err) {
      throw new HttpError(400, (err as Error).message || 'Could not read that calendar', { url: (err as Error).message || 'Could not read that calendar' });
    }
    const row = await db.one<{ id: number }>(`insert into calendar_feeds (name, url, color, visibility, created_by) values ($1, $2, $3, $4, $5) returning id`, [input.name, url, input.color, input.visibility, me.id]);
    const id = Number(row!.id);
    const result = await syncFeed(db, id, async () => text, ctx.now());
    await notifyNewCalendarShoots(ctx);
    await logActivity(db, { actor: me, action: 'calendar.added', entityType: 'calendar_feed', entityId: id, summary: `Synced the calendar “${input.name}” (${result.count} events)` });
    return { feed: toFeed((await db.one<FeedRow>(`select * from calendar_feeds where id = $1`, [id]))!), result };
  });

  app.patch('/api/calendar-feeds/:id', async (req) => {
    requireManager(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const input = parse(z.object({ name: zs.name('Name', 80).optional(), color: color.optional(), visibility: visibility.optional(), url: z.string().trim().min(1).max(4000).optional() }), req.body);
    const f = await db.one<FeedRow>(`select * from calendar_feeds where id = $1`, [id]);
    if (!f) throw notFound('Calendar');
    const set: Record<string, unknown> = {};
    if (input.name) set.name = input.name;
    if (input.color) set.color = input.color;
    if (input.visibility) set.visibility = input.visibility;
    if (input.url) set.url = normaliseFeedUrl(input.url);
    const keys = Object.keys(set);
    if (keys.length) await db.query(`update calendar_feeds set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} where id = $1`, [id, ...keys.map((k) => set[k])]);
    if (input.url) await syncFeed(db, id, fetchText, ctx.now());
    return { feed: toFeed((await db.one<FeedRow>(`select * from calendar_feeds where id = $1`, [id]))!) };
  });

  app.post('/api/calendar-feeds/:id/sync', async (req) => {
    requireManager(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    if (!(await db.one(`select 1 from calendar_feeds where id = $1`, [id]))) throw notFound('Calendar');
    const result = await syncFeed(db, id, fetchText, ctx.now());
    if (result.ok) await notifyNewCalendarShoots(ctx);
    return { feed: toFeed((await db.one<FeedRow>(`select * from calendar_feeds where id = $1`, [id]))!), result };
  });

  app.delete('/api/calendar-feeds/:id', async (req) => {
    const me = requireManager(req);
    const { id } = parse(z.object({ id: zs.id }), req.params);
    const f = await db.one<FeedRow>(`select * from calendar_feeds where id = $1`, [id]);
    if (!f) throw notFound('Calendar');
    await db.query(`delete from calendar_feeds where id = $1`, [id]); // its events go with it, and the secret link is gone
    await logActivity(db, { actor: me, action: 'calendar.removed', entityType: 'calendar_feed', entityId: id, summary: `Stopped syncing the calendar “${f.name}”` });
    return { ok: true };
  });
}
