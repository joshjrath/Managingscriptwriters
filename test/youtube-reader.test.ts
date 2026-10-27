// The YouTube reader (server/youtube.ts, ctx.youtube) against a stand-in for fetch: it builds every address itself from
// a video id, on YouTube's fixed hosts only; reads oEmbed for the title and channel (404 and 400 not found, 401 and 403
// private), the video's page for its publish date without a key, the Data API with one (falling back to the page when
// the API can't be asked); takes the biggest thumbnail that answers with a picture; caps every answer's size; never
// follows a redirect to another host; and turns every failure into a plain problem, with the key in none of them.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { youtubeReader, YOUTUBE_TIMEOUT_MS } from '../server/youtube';
import type { YoutubePicture, YoutubeVideo } from '../server/core';
import { YOUTUBE_IMPORT_LIMITS, YOUTUBE_PROBLEMS, youtubeWatchUrl } from '../shared/workflow';

const ID = 'dQw4w9WgXcQ';
const OEMBED = `https://www.youtube.com/oembed?url=${encodeURIComponent(youtubeWatchUrl(ID))}&format=json`;
const KEY = 'AIzaSy-reader-test-key';

/** A JPEG's header with its frame segment. */
function jpeg(width = 1280, height = 720, pad = 0): Buffer {
  const b = Buffer.alloc(24 + pad);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xc0;
  b.writeUInt16BE(17, 4);
  b[6] = 8;
  b.writeUInt16BE(height, 7);
  b.writeUInt16BE(width, 9);
  b[11] = 3;
  return b;
}

type Answer = Response | (() => Response | Promise<Response>);
/** A fetch that answers from a table of addresses (anything else is a 404), and remembers what it was asked. */
function fakeFetch(table: Record<string, Answer>) {
  const asked: { url: string; init: RequestInit | undefined }[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    asked.push({ url, init });
    const a = table[url];
    if (!a) return new Response('', { status: 404 });
    return typeof a === 'function' ? a() : a.clone();
  };
  return { impl, asked, urls: () => asked.map((a) => a.url) };
}
const ok = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body), { status: 200, headers });
const embed = { title: '  Never   gonna  ', author_name: 'Rick Astley', author_url: 'https://www.youtube.com/@RickAstleyYT?feature=x' };

afterEach(() => { vi.restoreAllMocks(); });

describe('reading a video', () => {
  it('reads oEmbed and the video’s own page, only at addresses built from the id, without a key', async () => {
    const f = fakeFetch({
      [OEMBED]: ok(embed),
      [youtubeWatchUrl(ID)]: ok('<html><meta itemprop="datePublished" content="2009-10-24T23:57:33-07:00"></html>'),
    });
    const v = await youtubeReader({ fetch: f.impl }).video(ID);
    expect(v).toEqual({
      ok: true, videoId: ID, title: 'Never gonna', channel: 'Rick Astley', channelUrl: 'https://www.youtube.com/@RickAstleyYT', publishedAt: '2009-10-24T23:57:33-07:00',
    });
    expect(f.urls().sort()).toEqual([OEMBED, youtubeWatchUrl(ID)].sort());
    // each with a timeout and no redirect followed for it
    for (const a of f.asked) expect([a.init?.redirect, a.init?.signal instanceof AbortSignal]).toEqual(['manual', true]);
    expect(YOUTUBE_TIMEOUT_MS).toBe(10_000);
  });

  it('finds the publish date in the page’s data when the meta tag isn’t there, and leaves it for the manager otherwise', async () => {
    const page = (html: string) => youtubeReader({ fetch: fakeFetch({ [OEMBED]: ok(embed), [youtubeWatchUrl(ID)]: ok(html) }).impl }).video(ID);
    expect(((await page('{"microformat":{"publishDate":"2024-03-01T08:00:00-08:00","uploadDate":"2024-02-28"}}')) as YoutubeVideo).publishedAt).toBe('2024-03-01T08:00:00-08:00');
    expect(((await page('{"uploadDate":"2024-02-28"}')) as YoutubeVideo).publishedAt).toBe('2024-02-28');
    expect(((await page('<meta content="2023-05-05" itemprop="datePublished">')) as YoutubeVideo).publishedAt).toBe('2023-05-05');
    // nothing like a date, or a date that isn't one: none
    expect(((await page('<html>no date here</html>')) as YoutubeVideo).publishedAt).toBeNull();
    expect(((await page('"publishDate":"<script>alert(1)</script>"')) as YoutubeVideo).publishedAt).toBeNull();
    // the page not answering never fails the video
    const v = await youtubeReader({ fetch: fakeFetch({ [OEMBED]: ok(embed) }).impl }).video(ID);
    expect([v.ok, (v as YoutubeVideo).publishedAt]).toEqual([true, null]);
  });

  it('says not found, private or no answer in plain words, and never asks for an id that isn’t one', async () => {
    const as = async (res: Answer) => youtubeReader({ fetch: fakeFetch({ [OEMBED]: res }).impl }).video(ID);
    expect(await as(new Response('Not Found', { status: 404 }))).toEqual({ ok: false, problem: YOUTUBE_PROBLEMS.notFound });
    expect(await as(new Response('Bad Request', { status: 400 }))).toEqual({ ok: false, problem: YOUTUBE_PROBLEMS.notFound });
    expect(await as(new Response('Unauthorized', { status: 401 }))).toEqual({ ok: false, problem: YOUTUBE_PROBLEMS.private });
    expect(await as(new Response('Forbidden', { status: 403 }))).toEqual({ ok: false, problem: YOUTUBE_PROBLEMS.private });
    expect(await as(new Response('oops', { status: 500 }))).toEqual({ ok: false, problem: YOUTUBE_PROBLEMS.unreachable });
    expect(await as(ok('<html>not json</html>'))).toEqual({ ok: false, problem: YOUTUBE_PROBLEMS.unreachable });
    expect(await as(ok({ title: '   ' }))).toEqual({ ok: false, problem: YOUTUBE_PROBLEMS.notFound });
    // no connection, or a timeout (the request's own signal ran out)
    expect(await as(() => { throw new TypeError('fetch failed'); })).toEqual({ ok: false, problem: YOUTUBE_PROBLEMS.unreachable });
    expect(await as(() => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); })).toEqual({ ok: false, problem: YOUTUBE_PROBLEMS.unreachable });
    // an answer far bigger than oEmbed's is refused, not read
    expect(await as(ok({ title: 'x'.repeat(300 * 1024) }))).toEqual({ ok: false, problem: YOUTUBE_PROBLEMS.unreachable });
    const f = fakeFetch({});
    for (const id of ['https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXc', 'dQw4w9WgXc!', '../../etc/x']) {
      expect(await youtubeReader({ fetch: f.impl }).video(id)).toEqual({ ok: false, problem: YOUTUBE_PROBLEMS.notLink });
      expect(await youtubeReader({ fetch: f.impl }).picture(id, 'best')).toEqual({ ok: false, problem: YOUTUBE_PROBLEMS.notLink });
    }
    expect(f.asked).toEqual([]);
  });

  it('follows a redirect only on the same host', async () => {
    const f = fakeFetch({
      [OEMBED]: new Response(null, { status: 302, headers: { location: 'https://consent.youtube.com/m?continue=x' } }),
      [youtubeWatchUrl(ID)]: new Response(null, { status: 301, headers: { location: '/watch?v=dQw4w9WgXcQ&hl=en' } }),
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&hl=en': ok('"publishDate":"2009-10-25"'),
    });
    expect(await youtubeReader({ fetch: f.impl }).video(ID)).toEqual({ ok: false, problem: YOUTUBE_PROBLEMS.unreachable });
    expect(f.urls()).not.toContain('https://consent.youtube.com/m?continue=x');
    // oEmbed moved within www.youtube.com is followed, and so is the page
    const g = fakeFetch({
      [OEMBED]: new Response(null, { status: 302, headers: { location: `${OEMBED}&hl=en` } }),
      [`${OEMBED}&hl=en`]: ok(embed),
      [youtubeWatchUrl(ID)]: new Response(null, { status: 301, headers: { location: '/watch?v=dQw4w9WgXcQ&hl=en' } }),
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&hl=en': ok('"publishDate":"2009-10-25"'),
    });
    expect(await youtubeReader({ fetch: g.impl }).video(ID)).toMatchObject({ ok: true, title: 'Never gonna', publishedAt: '2009-10-25' });
    // and never to a look-alike, nor round and round
    const h = fakeFetch({ [OEMBED]: new Response(null, { status: 302, headers: { location: 'https://www.youtube.com.evil.test/oembed' } }) });
    expect(await youtubeReader({ fetch: h.impl }).video(ID)).toEqual({ ok: false, problem: YOUTUBE_PROBLEMS.unreachable });
    expect(h.urls()).toEqual([OEMBED]);
    const loop = fakeFetch({ [OEMBED]: new Response(null, { status: 302, headers: { location: OEMBED } }) });
    expect(await youtubeReader({ fetch: loop.impl }).video(ID)).toEqual({ ok: false, problem: YOUTUBE_PROBLEMS.unreachable });
    expect(loop.urls().length).toBe(4);
  });

  it('with a key, takes the title, channel and date from the Data API, the channel’s page from oEmbed, and falls back without it', async () => {
    const api = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${ID}&key=${KEY}`;
    const item = { items: [{ id: ID, snippet: { title: 'Never Gonna Give You Up', channelTitle: 'Rick Astley', channelId: 'UCuAXFkgsw1L7xaCfnd5JJOw', publishedAt: '2009-10-25T06:57:33Z' } }] };
    let f = fakeFetch({ [OEMBED]: ok(embed), [api]: ok(item) });
    expect(await youtubeReader({ apiKey: KEY, fetch: f.impl }).video(ID)).toEqual({
      ok: true, videoId: ID, title: 'Never Gonna Give You Up', channel: 'Rick Astley', channelUrl: 'https://www.youtube.com/@RickAstleyYT', publishedAt: '2009-10-25T06:57:33Z',
    });
    // the page isn't read when the API gave the date
    expect(f.urls().sort()).toEqual([OEMBED, api].sort());
    // oEmbed can't show it (embedding is off), the API can: its channel id makes the channel's page
    f = fakeFetch({ [OEMBED]: new Response('', { status: 401 }), [api]: ok(item) });
    expect(await youtubeReader({ apiKey: KEY, fetch: f.impl }).video(ID)).toMatchObject({ ok: true, channelUrl: 'https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw' });
    // no such public video: oEmbed's word for why
    f = fakeFetch({ [OEMBED]: new Response('', { status: 403 }), [api]: ok({ items: [] }) });
    expect(await youtubeReader({ apiKey: KEY, fetch: f.impl }).video(ID)).toEqual({ ok: false, problem: YOUTUBE_PROBLEMS.private });
    // the API turns the key down (or is over its quota): the page, as without a key, and the key in no log
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    f = fakeFetch({
      [OEMBED]: ok(embed), [api]: new Response(JSON.stringify({ error: { message: `API key not valid ${KEY}` } }), { status: 403 }),
      [youtubeWatchUrl(ID)]: ok('"uploadDate":"2009-10-24"'),
    });
    const v = await youtubeReader({ apiKey: KEY, fetch: f.impl }).video(ID);
    expect(v).toMatchObject({ ok: true, title: 'Never gonna', publishedAt: '2009-10-24' });
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify([v, warn.mock.calls])).not.toContain(KEY);
  });
});

describe('reading a thumbnail', () => {
  const pic = (name: string) => `https://i.ytimg.com/vi/${ID}/${name}.jpg`;

  it('takes the biggest that answers with a picture, whatever YouTube calls it', async () => {
    let f = fakeFetch({ [pic('maxresdefault')]: ok(jpeg(), { 'content-type': 'image/jpeg' }) });
    let p = await youtubeReader({ fetch: f.impl }).picture(ID, 'best');
    expect([p.ok, (p as YoutubePicture).name, (p as YoutubePicture).data.equals(jpeg())]).toEqual([true, 'maxresdefault', true]);
    expect(f.urls()).toEqual([pic('maxresdefault')]);
    // no maxres (YouTube's grey 404): the next size; a page where a picture should be is passed over too
    f = fakeFetch({ [pic('maxresdefault')]: new Response(new Uint8Array(jpeg(120, 90)), { status: 404 }), [pic('sddefault')]: ok('<html></html>', { 'content-type': 'image/jpeg' }), [pic('hqdefault')]: ok(jpeg(480, 360)) });
    p = await youtubeReader({ fetch: f.impl }).picture(ID, 'best');
    expect([p.ok, (p as YoutubePicture).name]).toEqual([true, 'hqdefault']);
    // only pages: the first is handed over, for the route to refuse in its own words
    f = fakeFetch({ [pic('sddefault')]: ok('<html></html>', { 'content-type': 'image/jpeg' }) });
    p = await youtubeReader({ fetch: f.impl }).picture(ID, 'best');
    expect([p.ok, (p as YoutubePicture).name, (p as YoutubePicture).contentType]).toEqual([true, 'sddefault', 'image/jpeg']);
    // none at all, or no answer
    expect(await youtubeReader({ fetch: fakeFetch({}).impl }).picture(ID, 'best')).toEqual({ ok: false, problem: YOUTUBE_PROBLEMS.noPicture });
    expect(await youtubeReader({ fetch: async () => { throw new TypeError('fetch failed'); } }).picture(ID, 'best')).toEqual({ ok: false, problem: YOUTUBE_PROBLEMS.unreachable });
  });

  it('refuses a picture over the cap rather than cutting it short, and the preview is the small one alone', async () => {
    const huge = jpeg(1280, 720, YOUTUBE_IMPORT_LIMITS.pictureBytes);
    // said up front, or found while reading
    let f = fakeFetch({ [pic('maxresdefault')]: ok(huge, { 'content-length': String(huge.length) }), [pic('sddefault')]: new Response('', { status: 404 }), [pic('hqdefault')]: new Response('', { status: 404 }) });
    expect(await youtubeReader({ fetch: f.impl }).picture(ID, 'best')).toEqual({ ok: false, problem: YOUTUBE_PROBLEMS.tooBig });
    const stream = () => new Response(new ReadableStream({
      pull(c) { c.enqueue(new Uint8Array(1024 * 1024)); },
    }), { status: 200 });
    f = fakeFetch({ [pic('maxresdefault')]: stream });
    expect(await youtubeReader({ fetch: f.impl }).picture(ID, 'best')).toEqual({ ok: false, problem: YOUTUBE_PROBLEMS.tooBig });
    // a big maxres gives way to a smaller one that fits
    f = fakeFetch({ [pic('maxresdefault')]: ok(huge), [pic('sddefault')]: ok(jpeg(640, 480)) });
    expect(await youtubeReader({ fetch: f.impl }).picture(ID, 'best')).toMatchObject({ ok: true, name: 'sddefault' });
    // the preview: hqdefault only, within the preview's cap
    f = fakeFetch({ [pic('hqdefault')]: ok(jpeg(480, 360)) });
    expect(await youtubeReader({ fetch: f.impl }).picture(ID, 'preview')).toMatchObject({ ok: true, name: 'hqdefault' });
    expect(f.urls()).toEqual([pic('hqdefault')]);
    f = fakeFetch({ [pic('hqdefault')]: ok(jpeg(480, 360, YOUTUBE_IMPORT_LIMITS.previewBytes)) });
    expect(await youtubeReader({ fetch: f.impl }).picture(ID, 'preview')).toEqual({ ok: false, problem: YOUTUBE_PROBLEMS.tooBig });
  });
});
