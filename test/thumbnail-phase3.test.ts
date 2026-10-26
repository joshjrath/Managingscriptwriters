// Thumbnail Studio, phase 3, through its routes: each client's brand kit (managers edit only what changed, checked
// field by field; everyone who may see the client reads it, beside the brief too, and the second look reads it), a
// designer's private reference boards (their own refs only, in every direction, by route and by file; an upload sniffed
// like an option; the 300 cap), AI brief ideas for managers (with a stand-in helper, so the Anthropic API is never
// called: unavailable, limited, tidied, refused) and the kind kept on Settings → Editors entries (and that the Editors
// tab only takes video editors from there).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Anthropic from '@anthropic-ai/sdk';
import { buildApp } from '../server/app';
import type { Db } from '../server/db';
import type { BriefHelper, BriefIdeasInput, Ctx, ThumbCritic, ThumbCritiqueInput } from '../server/core';
import { claudeBriefHelper } from '../server/brief-ideas';
import { claudeThumbCritic } from '../server/second-look';
import { HttpError } from '../server/http';
import type { TimelinerBrandMember } from '../server/timeliner';
import type {
  ClientBrand, ClientDetail, Editor, Resource, ThumbnailBriefDetail, ThumbnailRef, ThumbnailRefBoard, ThumbnailSuggestions, UserSummary,
} from '../shared/types';
import { MAX_REFS, SECOND_LOOK_CHECKS, THUMB_IDEA_COUNT, type SecondLookResult, type ThumbIdea } from '../shared/workflow';
import { freshDb } from './db';
import { makeWorld, video } from './timeliner-world';

let db: Db;
let app: FastifyInstance;
let ctx: Ctx;
let admin = '';
let acme = 0;
let globex = 0;
const people = {} as Record<'max' | 'wes' | 'vic' | 'dee' | 'dan', { id: number; cookie: string }>;

type Res = { status: number; body: ReturnType<typeof JSON.parse> };

const send = async (method: string, url: string, cookie: string, body?: unknown): Promise<Res> => {
  const r = await app.inject({
    method: method as 'POST', url, headers: { 'x-scale-media': '1', cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed: ReturnType<typeof JSON.parse> = null;
  try { parsed = r.body ? JSON.parse(r.body) : null; } catch { parsed = r.body; }
  return { status: r.statusCode, body: parsed };
};

async function person(name: string, role: string, editorKind?: string): Promise<{ id: number; cookie: string }> {
  const email = `${name.toLowerCase().replace(/\W+/g, '.')}@scale.test`;
  const r = await send('POST', '/api/users', admin, { name, email, role, password: 'team-password-1', ...(editorKind ? { editorKind } : {}) });
  expect([r.status, r.body?.error]).toEqual([200, undefined]);
  const login = await app.inject({
    method: 'POST', url: '/api/auth/login', headers: { 'x-scale-media': '1', 'content-type': 'application/json' }, payload: JSON.stringify({ email, password: 'team-password-1' }),
  });
  return { id: (r.body.users as UserSummary[]).find((u) => u.email === email)!.id, cookie: String(login.headers['set-cookie']).split(';')[0] };
}

/** A PNG's header, as wide and tall as asked. */
function png(width = 1280, height = 720): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[24] = 8;
  b[25] = 2;
  return b;
}
/** A baseline JPEG's start: the image marker, then its frame header. */
const jpeg = (width: number, height: number) =>
  Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);

type Upload = { name: string; type: string; data: Buffer };

/** A multipart form: text fields, then one file. */
async function form(url: string, cookie: string, fields: Record<string, string>, file: Upload | null): Promise<Res> {
  const boundary = '----phase-three';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.data, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const r = await app.inject({ method: 'POST', url, headers: { 'x-scale-media': '1', cookie, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(parts) });
  return { status: r.statusCode, body: JSON.parse(r.body) };
}

const option = (briefId: number, cookie: string, data: Buffer = png()) => form(`/api/thumbnails/${briefId}/options`, cookie, {}, { name: 'cover.png', type: 'image/png', data });
const addRef = (cookie: string, file: Upload, fields: Record<string, string> = {}) => form('/api/thumbnail-refs', cookie, fields, file);
/** A client resource uploaded by Max: a picture by default. */
async function resource(clientId: number, o: { category?: string; name?: string; type?: string; data?: Buffer } = {}): Promise<Resource> {
  const r = await form('/api/resources/upload', people.max.cookie, { clientId: String(clientId), category: o.category ?? 'logo' }, {
    name: o.name ?? 'logo.png', type: o.type ?? 'image/png', data: o.data ?? png(400, 400),
  });
  expect([r.status, r.body?.error]).toEqual([200, undefined]);
  return r.body.resource as Resource;
}

async function brief(designerId: number | null, o: { title?: string; clientId?: number; brief?: string; onImage?: string } = {}): Promise<ThumbnailBriefDetail> {
  const r = await send('POST', '/api/thumbnails', people.max.cookie, {
    clientId: o.clientId ?? acme, title: o.title ?? 'Morning routine', designerId, brief: o.brief ?? null, onImage: o.onImage ?? null,
  });
  expect([r.status, r.body?.error]).toEqual([200, undefined]);
  return r.body as ThumbnailBriefDetail;
}

/** A brief picked from round 1 (options A and B by its designer, A picked unless asked). */
async function picked(designer: { id: number; cookie: string }, o: { clientId?: number; title?: string; brief?: string; onImage?: string; standout?: boolean } = {}) {
  const b = await brief(designer.id, o);
  await option(b.id, designer.cookie);
  await option(b.id, designer.cookie, png(1281, 720));
  const d = (await send('POST', `/api/thumbnails/${b.id}/send`, designer.cookie, {})).body as ThumbnailBriefDetail;
  const round = d.rounds[0];
  const r = await send('POST', `/api/thumbnails/${b.id}/decision`, people.max.cookie, { roundId: round.id, action: 'pick', optionId: round.options[0].id, standout: !!o.standout });
  expect(r.status).toBe(200);
  return { id: b.id, round, a: round.options[0], b: round.options[1] };
}

const fileStatus = async (fileId: number, cookie: string) => (await app.inject({ method: 'GET', url: `/api/files/${fileId}`, headers: { cookie } })).statusCode;
const clientOf = async (id: number, cookie: string) => (await send('GET', `/api/clients/${id}`, cookie)).body as ClientDetail;
const patchBrand = (id: number, body: unknown, cookie = people.max.cookie) => send('PATCH', `/api/clients/${id}/brand`, cookie, body);
const board = async (cookie: string, q = '') => (await send('GET', `/api/thumbnail-refs${q}`, cookie)).body as ThumbnailRefBoard;
const brandLog = (clientId: number) => db.query<{ summary: string }>(`select summary from activity where action = 'client.brand' and client_id = $1 order by id`, [clientId]);

beforeAll(async () => {
  db = await freshDb();
  ctx = { db, now: () => new Date(), secureCookies: false, allowSetup: true, uploadLimitBytes: 4 * 1024 * 1024 };
  app = await buildApp(ctx);
  const setup = await app.inject({
    method: 'POST', url: '/api/auth/setup', headers: { 'x-scale-media': '1', 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'Ada Admin', email: 'ada@scale.test', password: 'admin-password-1' }),
  });
  admin = String(setup.headers['set-cookie']).split(';')[0];
  people.max = await person('Max Manager', 'manager');
  people.wes = await person('Wes Writer', 'writer');
  people.vic = await person('Vic Video', 'editor');
  people.dee = await person('Dee Designer', 'editor', 'thumbnail');
  people.dan = await person('Dan Drawer', 'editor', 'thumbnail');
  acme = (await send('POST', '/api/clients', admin, { name: 'Acme', brandVoice: 'Warm and plain', guidance: 'Logo top right' })).body.clientId;
  globex = (await send('POST', '/api/clients', admin, { name: 'Globex' })).body.clientId;
});

afterAll(async () => {
  await app.close();
  await db.close();
});

// ── the brand kit ────────────────────────────────────────────────────────

describe('a client’s brand kit', () => {
  it('is edited by managers only', async () => {
    const body = { dos: 'Faces big' };
    expect((await patchBrand(acme, body, people.wes.cookie)).status).toBe(403);
    for (const who of [people.vic, people.dee]) {
      const r = await patchBrand(acme, body, who.cookie);
      expect([r.status, r.body.error.code]).toEqual([403, 'editor']);
    }
    expect(await db.one(`select 1 from client_brand where client_id = $1`, [acme])).toBeUndefined();
    expect((await patchBrand(999999, body)).status).toBe(404);
    // an archived client is refused, as moving one between stages is
    const gone = (await send('POST', '/api/clients', admin, { name: 'Old Co' })).body.clientId as number;
    await send('POST', `/api/clients/${gone}/archive`, admin, { archived: true });
    const r = await patchBrand(gone, body);
    expect([r.status, r.body.error.message]).toEqual([409, 'Old Co is archived. Restore them first.']);
  });

  it('keeps colours as #RRGGBB in capitals, and checks every colour, font and note', async () => {
    const r = await patchBrand(acme, { colours: [{ name: ' Ink ', hex: '#0a1a3a' }, { name: 'Lemon', hex: 'fe4' }] });
    expect(r.status).toBe(200);
    expect((r.body as ClientBrand).colours).toEqual([{ name: 'Ink', hex: '#0A1A3A' }, { name: 'Lemon', hex: '#FFEE44' }]);
    const bad: [unknown, string, RegExp][] = [
      [{ colours: [{ name: 'Red', hex: 'red' }] }, 'colours', /isn’t a colour code/],
      [{ colours: [{ name: 'Red', hex: '#E5393' }] }, 'colours', /isn’t a colour code/],
      [{ colours: [{ name: '  ', hex: '#E53935' }] }, 'colours', /Give each colour a name/],
      [{ colours: [{ name: 'R'.repeat(41), hex: '#E53935' }] }, 'colours', /40 characters/],
      [{ colours: [{ hex: '#E53935' }] }, 'colours', /Give each colour a name/],
      [{ colours: Array.from({ length: 13 }, (_, i) => ({ name: `C${i}`, hex: '#E53935' })) }, 'colours', /up to 12 colours/],
      [{ colours: 'red' }, 'colours', /as a list/],
      [{ fonts: [{ name: 'Inter', url: 'http://fonts.example/inter' }] }, 'fonts', /https/],
      [{ fonts: [{ name: 'Inter', url: 'javascript:alert(1)' }] }, 'fonts', /https/],
      [{ fonts: [{ name: '', url: null }] }, 'fonts', /Give each font a name/],
      [{ fonts: Array.from({ length: 7 }, (_, i) => ({ name: `F${i}` })) }, 'fonts', /up to 6 fonts/],
      [{ fonts: [{ name: 'Inter', resourceId: 999999 }] }, 'fonts', /font file from this client/],
      [{ dos: 'x'.repeat(1001) }, 'dos', /1000/],
      [{ donts: 'x'.repeat(1001) }, 'donts', /1000/],
    ];
    for (const [body, field, words] of bad) {
      const res = await patchBrand(acme, body);
      expect([JSON.stringify(body).slice(0, 40), res.status, Object.keys(res.body.error.fields ?? {})]).toEqual([JSON.stringify(body).slice(0, 40), 400, [field]]);
      expect(res.body.error.fields[field]).toMatch(words);
    }
    // nothing above was kept
    expect(((await clientOf(acme, people.max.cookie)).brand as ClientBrand).colours.map((c) => c.hex)).toEqual(['#0A1A3A', '#FFEE44']);
  });

  it('saves only what changed, compared with the kit as kept, and logs only that', async () => {
    const c = (await send('POST', '/api/clients', admin, { name: 'Changes Co' })).body.clientId as number;
    const first = await patchBrand(c, { colours: [{ name: 'Ink', hex: '#0a1a3a' }], dos: 'Faces big' });
    expect(first.body).toMatchObject({ clientId: c, colours: [{ name: 'Ink', hex: '#0A1A3A' }], fonts: [], dos: 'Faces big', donts: null, updatedByName: 'Max Manager' });
    // the same colours typed differently, and a new don't: only the don'ts change
    const second = await patchBrand(c, { colours: [{ name: ' Ink', hex: '#0A1A3A' }], dos: ' Faces big ', donts: ' No clichés ' });
    expect(second.body).toMatchObject({ colours: [{ name: 'Ink', hex: '#0A1A3A' }], dos: 'Faces big', donts: 'No clichés' });
    // fields left out stay as they are
    const third = await patchBrand(c, { fonts: [{ name: 'Inter', url: 'https://fonts.google.com/specimen/Inter' }] });
    expect(third.body).toMatchObject({
      colours: [{ name: 'Ink', hex: '#0A1A3A' }], dos: 'Faces big', donts: 'No clichés',
      fonts: [{ name: 'Inter', url: 'https://fonts.google.com/specimen/Inter', resourceId: null, file: null }],
    });
    // nothing new at all: nothing written, nothing logged
    const before = (await db.one<{ updated_at: string }>(`select updated_at from client_brand where client_id = $1`, [c]))!.updated_at;
    expect((await patchBrand(c, { dos: 'Faces big', fonts: [{ name: 'Inter', url: 'https://fonts.google.com/specimen/Inter ', resourceId: null }] })).status).toBe(200);
    expect((await db.one<{ updated_at: string }>(`select updated_at from client_brand where client_id = $1`, [c]))!.updated_at).toBe(before);
    // empty clears a note
    expect((await patchBrand(c, { dos: '' })).body.dos).toBeNull();
    expect((await brandLog(c)).map((l) => l.summary)).toEqual([
      'Updated Changes Co’s brand kit: colours, do’s',
      'Updated Changes Co’s brand kit: don’ts',
      'Updated Changes Co’s brand kit: fonts',
      'Updated Changes Co’s brand kit: do’s',
    ]);
    // a client nobody has made a kit for reads as none, and an empty edit doesn't make one
    expect((await clientOf(globex, people.max.cookie)).brand).toBeNull();
    expect((await patchBrand(globex, { colours: [], dos: null })).body).toMatchObject({ clientId: globex, colours: [], fonts: [], dos: null, donts: null });
    expect(await db.one(`select 1 from client_brand where client_id = $1`, [globex])).toBeUndefined();
  });

  it('takes a font file only from this client’s stored resources, and shows it while it’s there', async () => {
    const c = (await send('POST', '/api/clients', admin, { name: 'Fonts Co' })).body.clientId as number;
    const font = await resource(c, { category: 'font', name: 'Inter.ttf', type: 'font/ttf', data: Buffer.from('not really a font') });
    const elsewhere = await resource(acme, { category: 'font', name: 'Other.ttf', type: 'font/ttf', data: Buffer.from('another') });
    const link = (await send('POST', '/api/resources', people.max.cookie, { clientId: c, category: 'font', title: 'Inter on Google', url: 'https://fonts.google.com/specimen/Inter' })).body.resource as Resource;
    for (const resourceId of [elsewhere.id, link.id]) {
      const r = await patchBrand(c, { fonts: [{ name: 'Inter', resourceId }] });
      expect([r.status, r.body.error.fields]).toEqual([400, { fonts: 'Choose a font file from this client’s resources' }]);
    }
    const ok = await patchBrand(c, { fonts: [{ name: 'Inter', url: null, resourceId: font.id }] });
    expect((ok.body as ClientBrand).fonts).toEqual([{ name: 'Inter', url: null, resourceId: font.id, file: { id: font.fileId, name: 'Inter.ttf', size: 17 } }]);
    // once the file is removed the font stays, without it; the kit can still be edited around it
    expect((await send('DELETE', `/api/resources/${font.id}`, people.max.cookie)).status).toBe(200);
    expect(((await clientOf(c, people.wes.cookie)).brand as ClientBrand).fonts[0]).toMatchObject({ resourceId: font.id, file: null });
    const more = await patchBrand(c, { fonts: [{ name: 'Inter', resourceId: font.id }, { name: 'Lora', url: 'https://fonts.google.com/specimen/Lora' }] });
    expect([more.status, (more.body as ClientBrand).fonts.map((f) => f.name)]).toEqual([200, ['Inter', 'Lora']]);
    // a removed file isn't one to add again
    const again = await patchBrand(c, { fonts: [{ name: 'Lora', resourceId: font.id }] });
    expect(again.status).toBe(200);
    const removed = await resource(c, { category: 'font', name: 'Gone.ttf', type: 'font/ttf', data: Buffer.from('gone') });
    await send('DELETE', `/api/resources/${removed.id}`, people.max.cookie);
    expect((await patchBrand(c, { fonts: [{ name: 'Gone', resourceId: removed.id }] })).status).toBe(400);
  });

  it('is read by everyone who may see the client, and beside the brief', async () => {
    const c = (await send('POST', '/api/clients', admin, { name: 'Seen Co' })).body.clientId as number;
    const kit = (await patchBrand(c, { colours: [{ name: 'Ink', hex: '#0A1A3A' }], dos: 'Faces big', donts: 'No arrows' })).body as ClientBrand;
    for (const who of [people.max, people.wes, people.vic, people.dee, people.dan]) {
      const r = await send('GET', `/api/clients/${c}`, who.cookie);
      expect([r.status, r.body.brand]).toEqual([200, kit]);
    }
    const b = await brief(people.dee.id, { clientId: c, title: 'Seen' });
    expect(b.look.brand).toEqual(kit);
    expect(((await send('GET', `/api/thumbnails/${b.id}`, people.dee.cookie)).body as ThumbnailBriefDetail).look.brand).toEqual(kit);
    expect(((await send('GET', `/api/thumbnails/${(await brief(people.dee.id, { clientId: globex })).id}`, people.dee.cookie)).body as ThumbnailBriefDetail).look.brand).toBeNull();
  });

  it('shows the client’s winners to managers, and to designers only for clients they have or had a brief for', async () => {
    const c = (await send('POST', '/api/clients', admin, { name: 'Winners Co' })).body.clientId as number;
    const first = await picked(people.dan, { clientId: c, title: 'First', standout: true });
    const second = await picked(people.dan, { clientId: c, title: 'Second' });
    const forMax = (await clientOf(c, people.max.cookie)).recentWinners!;
    expect(forMax.map((w) => [w.briefId, w.standout])).toEqual([[second.id, false], [first.id, true]]);
    // Dan sees his own standout; Dee, with no brief for this client, sees none (their pictures wouldn't open for her)
    expect((await clientOf(c, people.dan.cookie)).recentWinners!.map((w) => w.standout)).toEqual([false, true]);
    expect((await clientOf(c, people.dee.cookie)).recentWinners).toEqual([]);
    // once she has one, she sees them, without how Max rated Dan's pick
    await brief(people.dee.id, { clientId: c, title: 'Hers' });
    const forDee = (await clientOf(c, people.dee.cookie)).recentWinners!;
    expect(forDee.map((w) => [w.briefId, w.standout])).toEqual([[second.id, false], [first.id, false]]);
    expect(await fileStatus(forDee[1].option.fileId, people.dee.cookie)).toBe(200);
    // writers and video editors don't get them at all
    for (const who of [people.wes, people.vic]) expect(await clientOf(c, who.cookie)).not.toHaveProperty('recentWinners');
  });
});

// ── the second look reads the kit ────────────────────────────────────────

const GOOD: SecondLookResult = {
  oneLiner: 'Reads well small.',
  checks: SECOND_LOOK_CHECKS.map((key) => ({ key, status: 'strong', note: `Note on ${key}.` })),
  suggestions: [],
};

describe('the second look and the brand kit', () => {
  it('sends the client’s colours, do’s and don’ts with the brief', async () => {
    const asked: ThumbCritiqueInput[] = [];
    const critic: ThumbCritic = { async critique(input) { asked.push(input); return GOOD; } };
    ctx.thumbCritic = critic;
    try {
      const c = (await send('POST', '/api/clients', admin, { name: 'Looked Co', brandVoice: 'Bold' })).body.clientId as number;
      await patchBrand(c, { colours: [{ name: 'Ink', hex: '#0a1a3a' }, { name: 'Lemon', hex: '#F4ED70' }], dos: 'Faces big' });
      const b = await brief(people.dee.id, { clientId: c, title: 'Looked at' });
      const o = ((await option(b.id, people.dee.cookie)).body as ThumbnailBriefDetail).tray!.options[0];
      expect((await send('POST', `/api/thumbnail-options/${o.id}/second-look`, people.dee.cookie)).status).toBe(200);
      expect(asked[0].client).toEqual({
        name: 'Looked Co', brandVoice: 'Bold', guidance: null,
        brand: { colours: [{ name: 'Ink', hex: '#0A1A3A' }, { name: 'Lemon', hex: '#F4ED70' }], dos: 'Faces big', donts: null },
      });
    } finally {
      ctx.thumbCritic = null;
    }
  });

  it('puts the kit in the critic’s words: colours by name and code, do’s and don’ts', async () => {
    const sent: Record<string, unknown>[] = [];
    const client = { beta: { messages: { parse: async (body: Record<string, unknown>) => { sent.push(body); return { stop_reason: 'end_turn', parsed_output: GOOD }; } } } } as unknown as Anthropic;
    const input: ThumbCritiqueInput = {
      option: { mime: 'image/png', base64: 'b3B0aW9u' }, references: [], brief: { title: 'Pantry tour', brief: null, onImage: null },
      client: { name: 'Globex', brandVoice: null, guidance: null, brand: { colours: [{ name: 'Ink', hex: '#0A1A3A' }, { name: 'Lemon', hex: '#F4ED70' }], dos: 'Faces big', donts: null } },
    };
    await claudeThumbCritic(client).critique(input);
    const [message] = sent[0].messages as { content: { type: string; text?: string }[] }[];
    const context = message.content[message.content.length - 1].text!;
    for (const words of ['Brand colours: Ink #0A1A3A, Lemon #F4ED70', 'Do: Faces big', 'Don’t: not given']) expect(context).toContain(words);
    // without a kit, no brand lines at all
    await claudeThumbCritic(client).critique({ ...input, client: { name: 'Globex', brandVoice: null, guidance: null } });
    const [plain] = sent[1].messages as { content: { type: string; text?: string }[] }[];
    expect(plain.content[plain.content.length - 1].text).not.toContain('Brand colours');
  });
});

// ── reference boards ─────────────────────────────────────────────────────

describe('a designer’s reference boards', () => {
  it('are for thumbnail designers only: managers, writers and video editors are refused', async () => {
    for (const who of [people.max, people.wes]) {
      expect((await send('GET', '/api/thumbnail-refs', who.cookie)).status).toBe(403);
      expect((await addRef(who.cookie, { name: 'ref.png', type: 'image/png', data: png() })).status).toBe(403);
    }
    const r = await send('GET', '/api/thumbnail-refs', people.vic.cookie);
    expect([r.status, r.body.error.code]).toEqual([403, 'editor']);
    expect(await board(people.dee.cookie)).toEqual({ refs: [], total: 0, max: MAX_REFS });
  });

  it('keeps an uploaded image as what its own bytes say, and refuses anything that isn’t a PNG, JPEG or WebP', async () => {
    const r = await addRef(people.dee.cookie, { name: 'mood.png', type: 'image/png', data: jpeg(640, 360) }, { caption: ' Warm light ', clientId: String(acme) });
    expect([r.status, r.body?.error]).toEqual([200, undefined]);
    const ref = r.body as ThumbnailRef;
    expect(ref).toMatchObject({ source: 'upload', clientId: acme, clientName: 'Acme', mime: 'image/jpeg', caption: 'Warm light', winner: null, resource: null, width: null });
    expect(ref.url).toBe(`/api/files/${ref.fileId}`);
    expect(await db.one(`select filename, mime from files where id = $1`, [ref.fileId])).toEqual({ filename: 'mood.jpg', mime: 'image/jpeg' });
    for (const file of [
      { name: 'page.png', type: 'image/png', data: Buffer.from('<html><script>alert(1)</script></html>') },
      { name: 'anim.gif', type: 'image/gif', data: Buffer.from('GIF89a\x01\x00\x01\x00') },
      { name: 'logo.svg', type: 'image/svg+xml', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') },
    ]) {
      const bad = await addRef(people.dee.cookie, file);
      expect([file.name, bad.status, bad.body.error.fields]).toEqual([file.name, 400, { file: 'Use a PNG, JPG or WebP image' }]);
    }
    expect((await addRef(people.dee.cookie, { name: 'x.png', type: 'image/png', data: png() }, { caption: 'x'.repeat(201) })).status).toBe(400);
    expect((await addRef(people.dee.cookie, { name: 'x.png', type: 'image/png', data: png() }, { clientId: '999999' })).body.error.fields).toEqual({ clientId: 'Choose a client' });
    // empty or left out: the general board
    const general = (await addRef(people.dee.cookie, { name: 'gen.png', type: 'image/png', data: png() }, { clientId: '' })).body as ThumbnailRef;
    expect(general.clientId).toBeNull();
  });

  it('are private to their designer, by route and by file, in every direction', async () => {
    const ref = (await addRef(people.dee.cookie, { name: 'private.png', type: 'image/png', data: png(800, 450) }, { clientId: String(globex) })).body as ThumbnailRef;
    expect(await fileStatus(ref.fileId, people.dee.cookie)).toBe(200);
    for (const who of [people.dan, people.max, people.wes, people.vic]) expect(await fileStatus(ref.fileId, who.cookie)).toBe(404);
    expect(await fileStatus(ref.fileId, admin)).toBe(404);
    expect((await board(people.dan.cookie)).refs.some((r) => r.id === ref.id)).toBe(false);
    expect((await send('PATCH', `/api/thumbnail-refs/${ref.id}`, people.dan.cookie, { caption: 'mine now' })).status).toBe(404);
    expect((await send('DELETE', `/api/thumbnail-refs/${ref.id}`, people.dan.cookie)).status).toBe(404);
    expect((await board(people.dee.cookie, `?clientId=${globex}`)).refs.map((r) => r.id)).toContain(ref.id);
    // taken off her board, it no longer opens, even for her
    expect((await send('DELETE', `/api/thumbnail-refs/${ref.id}`, people.dee.cookie)).body).toEqual({ ok: true });
    expect(await fileStatus(ref.fileId, people.dee.cookie)).toBe(404);
    expect((await send('DELETE', `/api/thumbnail-refs/${ref.id}`, people.dee.cookie)).status).toBe(404);
    expect((await board(people.dee.cookie)).refs.some((r) => r.id === ref.id)).toBe(false);
    expect(await db.one(`select removed_at is not null as gone from thumbnail_refs where id = $1`, [ref.id])).toEqual({ gone: true });
  });

  it('takes a winner she may see, and drops it once it isn’t the winner any more', async () => {
    const shared = (await send('POST', '/api/clients', admin, { name: 'Shared Co' })).body.clientId as number;
    const other = (await send('POST', '/api/clients', admin, { name: 'Other Co' })).body.clientId as number;
    const win = await picked(people.dan, { clientId: shared, title: 'Dan’s pick' });
    const notHers = await picked(people.dan, { clientId: other, title: 'Elsewhere' });
    // no brief for Shared Co yet: Dan's winner isn't hers to see
    expect((await send('POST', '/api/thumbnail-refs', people.dee.cookie, { optionId: win.a.id })).status).toBe(404);
    await brief(people.dee.id, { clientId: shared, title: 'Her brief' });
    const r = await send('POST', '/api/thumbnail-refs', people.dee.cookie, { optionId: win.a.id, caption: 'The colour' });
    expect([r.status, r.body?.error]).toEqual([200, undefined]);
    const ref = r.body as ThumbnailRef;
    expect(ref).toMatchObject({
      source: 'winner', clientId: shared, clientName: 'Shared Co', fileId: win.a.fileId, mime: 'image/png', width: 1280, height: 720, caption: 'The colour',
      winner: { optionId: win.a.id, briefId: win.id, title: 'Dan’s pick', letter: 'A', madeByName: 'Dan Drawer', pickedAt: expect.any(String) }, resource: null,
    });
    // the same winner on the same board twice is refused; on another board it's fine
    expect((await send('POST', '/api/thumbnail-refs', people.dee.cookie, { optionId: win.a.id })).status).toBe(409);
    expect((await send('POST', '/api/thumbnail-refs', people.dee.cookie, { optionId: win.a.id, clientId: null })).body.clientId).toBeNull();
    // Dan's unpicked option, and a winner for a client she never had a brief for
    for (const optionId of [win.b.id, notHers.a.id, 999999]) expect((await send('POST', '/api/thumbnail-refs', people.dee.cookie, { optionId })).status).toBe(404);
    // a manager changes their mind on that round: it's no longer a winner, so it leaves her boards
    const before = await board(people.dee.cookie);
    expect(before.total).toBe(before.refs.length);
    expect((await send('POST', `/api/thumbnails/${win.id}/decision`, people.max.cookie, { roundId: win.round.id, action: 'changes', note: 'One more go' })).status).toBe(200);
    const after = await board(people.dee.cookie);
    expect(after.refs.some((x) => x.source === 'winner' && x.winner?.optionId === win.a.id)).toBe(false);
    expect((await send('PATCH', `/api/thumbnail-refs/${ref.id}`, people.dee.cookie, { caption: 'still?' })).status).toBe(404);
    // and its two copies (Shared Co's board and General) stop counting: she couldn't see them to take them off
    expect(after.total).toBe(before.total - 2);
    expect(after.total).toBe(after.refs.length);
  });

  it('takes a client’s picture resource, on that client’s board unless asked, and nothing that isn’t a picture', async () => {
    const logo = await resource(globex, { name: 'globex.png' });
    const r = await send('POST', '/api/thumbnail-refs', people.dan.cookie, { resourceId: logo.id });
    expect(r.body).toMatchObject({ source: 'resource', clientId: globex, fileId: logo.fileId, resource: { id: logo.id, title: 'globex.png', category: 'logo' }, winner: null });
    expect(await fileStatus(logo.fileId!, people.dan.cookie)).toBe(200);
    const pdf = await resource(globex, { category: 'document', name: 'brief.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4') });
    const notPicture = await send('POST', '/api/thumbnail-refs', people.dan.cookie, { resourceId: pdf.id });
    expect([notPicture.status, notPicture.body.error.fields]).toEqual([400, { resourceId: 'Only a picture can go on a board' }]);
    // exactly one of a winner and a resource
    for (const body of [{}, { optionId: 1, resourceId: logo.id }, { caption: 'nothing' }]) expect((await send('POST', '/api/thumbnail-refs', people.dan.cookie, body)).status).toBe(400);
    // removed from the client, it leaves the board too
    const gone = await resource(globex, { name: 'gone.png' });
    const ref = (await send('POST', '/api/thumbnail-refs', people.dan.cookie, { resourceId: gone.id, clientId: null })).body as ThumbnailRef;
    expect(ref.clientId).toBeNull();
    await send('DELETE', `/api/resources/${gone.id}`, people.max.cookie);
    expect((await board(people.dan.cookie)).refs.some((x) => x.id === ref.id)).toBe(false);
    expect((await send('POST', '/api/thumbnail-refs', people.dan.cookie, { resourceId: gone.id })).status).toBe(404);
  });

  it('lists her refs newest first, by board, and moves or recaptions one', async () => {
    const una = await person('Una Boards', 'editor', 'thumbnail');
    const a = (await addRef(una.cookie, { name: 'a.png', type: 'image/png', data: png() }, { clientId: String(acme) })).body as ThumbnailRef;
    const b = (await addRef(una.cookie, { name: 'b.png', type: 'image/png', data: png() })).body as ThumbnailRef;
    const c = (await addRef(una.cookie, { name: 'c.png', type: 'image/png', data: png() }, { clientId: String(acme) })).body as ThumbnailRef;
    expect((await board(una.cookie)).refs.map((r) => r.id)).toEqual([c.id, b.id, a.id]);
    expect((await board(una.cookie, `?clientId=${acme}`)).refs.map((r) => r.id)).toEqual([c.id, a.id]);
    expect((await board(una.cookie, '?clientId=general')).refs.map((r) => r.id)).toEqual([b.id]);
    expect((await send('GET', '/api/thumbnail-refs?clientId=everyone', una.cookie)).status).toBe(400);
    const moved = await send('PATCH', `/api/thumbnail-refs/${a.id}`, una.cookie, { clientId: null, caption: '  Light from the left ' });
    expect(moved.body).toMatchObject({ id: a.id, clientId: null, clientName: null, caption: 'Light from the left' });
    expect((await send('PATCH', `/api/thumbnail-refs/${a.id}`, una.cookie, { caption: '' })).body.caption).toBeNull();
    expect((await send('PATCH', `/api/thumbnail-refs/${a.id}`, una.cookie, { clientId: 999999 })).status).toBe(400);
    expect((await send('PATCH', `/api/thumbnail-refs/${a.id}`, una.cookie, { caption: 'x'.repeat(201) })).status).toBe(400);
    expect((await board(una.cookie, '?clientId=general')).refs.map((r) => r.id)).toEqual([b.id, a.id]);
  });

  it('holds 300 refs a designer at most', async () => {
    const ivy = await person('Ivy Full', 'editor', 'thumbnail');
    const pic = await resource(acme, { name: 'many.png' });
    await db.query(`insert into thumbnail_refs (user_id, resource_id) select $1, $2 from generate_series(1, $3::int)`, [ivy.id, pic.id, MAX_REFS - 1]);
    const last = await addRef(ivy.cookie, { name: 'last.png', type: 'image/png', data: png() });
    expect(last.status).toBe(200);
    const json = await send('POST', '/api/thumbnail-refs', ivy.cookie, { resourceId: pic.id, clientId: null });
    expect([json.status, json.body.error.code]).toEqual([409, 'full']);
    const upload = await addRef(ivy.cookie, { name: 'more.png', type: 'image/png', data: png() });
    expect([upload.status, upload.body.error.message]).toEqual([409, 'Your boards hold up to 300 references. Take some off to add more.']);
    expect(await board(ivy.cookie)).toMatchObject({ total: MAX_REFS, max: MAX_REFS });
    // taking one off makes room
    expect((await send('DELETE', `/api/thumbnail-refs/${(last.body as ThumbnailRef).id}`, ivy.cookie)).status).toBe(200);
    expect((await addRef(ivy.cookie, { name: 'again.png', type: 'image/png', data: png() })).status).toBe(200);
  });

  it('counts only the refs she can still open toward the 300', async () => {
    const zoe = await person('Zoe Full', 'editor', 'thumbnail');
    const pic = await resource(acme, { name: 'everywhere.png' });
    await db.query(`insert into thumbnail_refs (user_id, resource_id) select $1, $2 from generate_series(1, $3::int)`, [zoe.id, pic.id, MAX_REFS]);
    expect(await board(zoe.cookie)).toMatchObject({ total: MAX_REFS, max: MAX_REFS });
    expect((await addRef(zoe.cookie, { name: 'one.png', type: 'image/png', data: png() })).status).toBe(409);
    // the manager removes that picture from Acme: all 300 leave her boards, and with them the places they held
    expect((await send('DELETE', `/api/resources/${pic.id}`, people.max.cookie)).status).toBe(200);
    expect(await board(zoe.cookie)).toEqual({ refs: [], total: 0, max: MAX_REFS });
    const r = await addRef(zoe.cookie, { name: 'one.png', type: 'image/png', data: png() });
    expect([r.status, r.body?.error]).toEqual([200, undefined]);
    expect((await board(zoe.cookie)).total).toBe(1);
  });

  /** A second server on the same database that notes the SQL of each transaction, and can step in just before a ref is inserted. */
  async function watchingApp() {
    const txs: string[][] = [];
    const hook: { beforeInsert: ((t: Db) => Promise<unknown>) | null } = { beforeInsert: null };
    const watched = (inner: Db, log?: string[]): Db => ({
      kind: inner.kind,
      query: async (sql, params) => {
        log?.push(sql);
        if (log && hook.beforeInsert && /^\s*insert into thumbnail_refs\b/.test(sql)) await hook.beforeInsert(inner);
        return inner.query(sql, params);
      },
      one: async (sql, params) => {
        log?.push(sql);
        if (log && hook.beforeInsert && /^\s*insert into thumbnail_refs\b/.test(sql)) await hook.beforeInsert(inner);
        return inner.one(sql, params);
      },
      tx: (fn) => inner.tx((t) => { const mine: string[] = []; txs.push(mine); return fn(watched(t, mine)); }),
      close: () => inner.close(),
      withSchema: (schema) => inner.withSchema(schema),
    });
    const server = await buildApp({ ...ctx, db: watched(db), realDb: undefined, dbNow: undefined });
    const call = async (method: 'POST' | 'PATCH', url: string, body: unknown) => {
      const r = await server.inject({ method, url, headers: { 'x-scale-media': '1', cookie: people.dan.cookie, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
      return { status: r.statusCode, body: JSON.parse(r.body) as ReturnType<typeof JSON.parse> };
    };
    return { server, txs, hook, call };
  }

  it('locks her boards before the ref when moving one, as an add does, so a move and an add can’t both put a picture on one board', async () => {
    const locks = (sqls: string[]) => sqls.flatMap((q) => (/\bfrom users\b[\s\S]*\bfor no key update\b/.test(q) ? ['boards']
      : /\bfrom thumbnail_refs where\b[\s\S]*\bfor update\b/.test(q) ? ['ref'] : []));
    const w = await watchingApp();
    try {
      const pic = await resource(acme, { name: 'moving.png' });
      const ref = (await w.call('POST', '/api/thumbnail-refs', { resourceId: pic.id, clientId: null })).body as ThumbnailRef;
      expect(w.txs.map(locks).filter((l) => l.length)).toEqual([['boards']]);
      w.txs.length = 0;
      const moved = await w.call('PATCH', `/api/thumbnail-refs/${ref.id}`, { clientId: acme });
      expect([moved.status, moved.body.clientId]).toEqual([200, acme]);
      expect(w.txs.map(locks).filter((l) => l.length)).toEqual([['boards', 'ref']]);
    } finally {
      await w.server.close();
    }
  });

  it('adds nothing when the picture goes away between its check and the add', async () => {
    const w = await watchingApp();
    try {
      const pic = await resource(acme, { name: 'going.png' });
      // the manager removes it just as Dan adds it (here: in the add's own transaction, just before the insert)
      w.hook.beforeInsert = (t) => t.query(`update resources set removed_at = now() where id = $1`, [pic.id]);
      const r = await w.call('POST', '/api/thumbnail-refs', { resourceId: pic.id });
      expect([r.status, r.body.error.message]).toEqual([404, 'Resource not found']);
      expect(await db.one(`select count(*) as n from thumbnail_refs where resource_id = $1`, [pic.id])).toEqual({ n: 0 });
    } finally {
      await w.server.close();
    }
  });
});

// ── AI brief ideas ───────────────────────────────────────────────────────

const IDEAS: ThumbIdea[] = [
  { show: 'Him holding the burnt pan, shocked.', words: 'ONE PAN', why: 'One face, one problem.' },
  { show: 'The empty fridge, door open, cold light.', words: '', why: 'The result says it.' },
  { show: 'Split screen: day 1 and day 30.', words: 'DAY 30', why: 'A before and after reads small.' },
];

/** A stand-in helper: answers with `answer` (or runs it), and remembers what it was asked. */
function fakeHelper(answer: (input: BriefIdeasInput) => Promise<unknown> = async () => ({ ideas: IDEAS })) {
  const asked: BriefIdeasInput[] = [];
  const helper: BriefHelper = { async suggest(input) { asked.push(input); return (await answer(input)) as { ideas: ThumbIdea[] }; } };
  return { helper, asked };
}
const suggest = (body: unknown, cookie = people.max.cookie) => send('POST', '/api/thumbnails/suggest', cookie, body);

describe('AI brief ideas', () => {
  it('aren’t offered without an AI key, and say how to turn them on', async () => {
    ctx.briefHelper = null;
    expect((await send('GET', '/api/bootstrap', people.max.cookie)).body.briefIdeas).toBe(false);
    const r = await suggest({ clientId: acme, title: 'Ten-minute dinners' });
    expect([r.status, r.body.error.code]).toEqual([503, 'not_configured']);
    expect(r.body.error.message).toMatch(/ANTHROPIC_API_KEY/);
    ctx.briefHelper = fakeHelper().helper;
    expect((await send('GET', '/api/bootstrap', people.max.cookie)).body.briefIdeas).toBe(true);
  });

  it('are for managers only, and check the client, the shoot and the title first', async () => {
    const { helper, asked } = fakeHelper();
    ctx.briefHelper = helper;
    expect((await suggest({ clientId: acme, title: 'T' }, people.wes.cookie)).status).toBe(403);
    for (const who of [people.vic, people.dee]) {
      const r = await suggest({ clientId: acme, title: 'T' }, who.cookie);
      expect([r.status, r.body.error.code]).toEqual([403, 'editor']);
    }
    const archived = (await send('POST', '/api/clients', admin, { name: 'Archived Ideas' })).body.clientId as number;
    await send('POST', `/api/clients/${archived}/archive`, admin, { archived: true });
    const otherShoot = (await send('POST', '/api/shoots', people.max.cookie, { clientId: globex, startDate: '2999-03-01', endDate: null })).body.shootId as number;
    const bad: [unknown, string][] = [
      [{ clientId: acme, title: '  ' }, 'title'],
      [{ clientId: acme, title: 'x'.repeat(201) }, 'title'],
      [{ clientId: 999999, title: 'T' }, 'clientId'],
      [{ clientId: archived, title: 'T' }, 'clientId'],
      [{ clientId: acme, shootId: otherShoot, title: 'T' }, 'shootId'],
    ];
    for (const [body, field] of bad) {
      const r = await suggest(body);
      expect([r.status, Object.keys(r.body.error.fields ?? {})]).toEqual([400, [field]]);
    }
    expect(asked).toHaveLength(0);
  });

  it('asks with the client’s look, the shoot and its last 10 picked briefs, newest first, and saves nothing', async () => {
    const { helper, asked } = fakeHelper();
    ctx.briefHelper = helper;
    const c = (await send('POST', '/api/clients', admin, { name: 'Ideas Co', brandVoice: 'Calm', guidance: 'Never yellow' })).body.clientId as number;
    await patchBrand(c, { dos: 'Faces big', donts: 'No arrows', colours: [{ name: 'Ink', hex: '#0A1A3A' }] });
    for (let i = 1; i <= 11; i++) {
      const p = await picked(people.dan, { clientId: c, title: `Pick ${i}`, brief: `Shows ${i}`, onImage: i % 2 ? `WORDS ${i}` : undefined });
      await db.query(`update thumbnail_decisions set created_at = now() - make_interval(mins => $2::int) where round_id = $1`, [p.round.id, 100 - i]);
    }
    const shoot = (await send('POST', '/api/shoots', people.max.cookie, { clientId: c, title: 'Kitchen day', startDate: '2999-04-02', endDate: null })).body.shootId as number;
    const counts = async () => db.one<{ briefs: number; activity: number }>(`select (select count(*) from thumbnail_briefs) as briefs, (select count(*) from activity) as activity`);
    const before = await counts();
    const r = await suggest({ clientId: c, shootId: shoot, title: ' I lived on $1 a week ' });
    expect([r.status, r.body]).toEqual([200, { ideas: IDEAS } satisfies ThumbnailSuggestions]);
    expect(asked[0]).toEqual({
      title: 'I lived on $1 a week',
      client: { name: 'Ideas Co', brandVoice: 'Calm', guidance: 'Never yellow', dos: 'Faces big', donts: 'No arrows' },
      shoot: { title: 'Kitchen day', date: '2999-04-02' },
      picked: [11, 10, 9, 8, 7, 6, 5, 4, 3, 2].map((i) => ({ title: `Pick ${i}`, brief: `Shows ${i}`, onImage: i % 2 ? `WORDS ${i}` : null })),
    });
    expect(await counts()).toEqual(before);
    // a client with nothing picked yet and no shoot chosen
    await suggest({ clientId: globex, title: 'Fresh start' });
    expect(asked[1]).toMatchObject({ shoot: null, picked: [], client: { name: 'Globex', dos: null, donts: null } });
  });

  it('tidies every answer, and keeps nothing it can’t use', async () => {
    const replies: (() => Promise<unknown>)[] = [
      async () => ({
        ideas: [
          { show: `  Close on his face lit by the open fridge, ${'the empty shelves behind him, '.repeat(10)}`, words: '“I Lived on $1 a Week”', why: 'Shock reads small.' },
          { show: 'The receipt for $1, crumpled.', words: 'THIS IS FAR TOO MANY WORDS', why: 'A' },
          { show: 'Day 30: thin, smiling.', words: ' DAY 30 ', why: 'B' },
          { show: 'A fourth one.', words: '', why: 'C' },
        ],
      }),
      async () => ({ ideas: IDEAS.slice(0, 2) }),
      async () => ({ ideas: [IDEAS[0], { ...IDEAS[0], show: 'him holding the BURNT pan shocked' }, IDEAS[1]] }),
      async () => { throw new HttpError(422, 'No ideas could be suggested for this title.'); },
    ];
    const { helper, asked } = fakeHelper(() => replies[asked.length - 1]());
    ctx.briefHelper = helper;
    const ok = (await suggest({ clientId: acme, title: 'I lived on $1 a week' })).body as ThumbnailSuggestions;
    expect(ok.ideas).toHaveLength(3);
    expect(ok.ideas[0].show.length).toBeLessThanOrEqual(200);
    expect(ok.ideas[0].show).toMatch(/…$/);
    expect(ok.ideas.map((i) => i.words)).toEqual(['', '', 'DAY 30']);
    for (let i = 0; i < 3; i++) {
      const r = await suggest({ clientId: acme, title: 'I lived on $1 a week' });
      expect(r.status).toBe(422);
    }
    expect(asked).toHaveLength(4);
  });

  it('runs one at a time per manager, and at most 30 an hour', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const slow = fakeHelper(async () => { await gate; return { ideas: IDEAS }; });
    ctx.briefHelper = slow.helper;
    const mo = await person('Mo Manager', 'manager');
    const first = suggest({ clientId: acme, title: 'Slow one' }, mo.cookie);
    await vi.waitFor(() => expect(slow.asked).toHaveLength(1));
    expect((await suggest({ clientId: acme, title: 'Impatient' }, mo.cookie)).status).toBe(429);
    // someone else isn't held up
    ctx.briefHelper = fakeHelper().helper;
    expect((await suggest({ clientId: acme, title: 'Not waiting' })).status).toBe(200);
    ctx.briefHelper = slow.helper;
    release();
    expect((await first).status).toBe(200);
    // every ask sent to the AI counts, even one that came back unusable
    const junk = fakeHelper(async () => ({ ideas: [] }));
    ctx.briefHelper = junk.helper;
    for (let i = 0; i < 29; i++) expect((await suggest({ clientId: acme, title: `Ask ${i}` }, mo.cookie)).status).toBe(422);
    const limited = await suggest({ clientId: acme, title: 'One too many' }, mo.cookie);
    expect([limited.status, junk.asked.length]).toEqual([429, 29]);
    expect(limited.body.error.message).toMatch(/in an hour/);
  });

  it('is off while an Admin views the site as a manager, even in Recording mode', async () => {
    const { helper, asked } = fakeHelper();
    ctx.briefHelper = helper;
    expect((await send('POST', '/api/admin/view-as', admin, { userId: people.max.id })).status).toBe(200);
    try {
      expect((await send('GET', '/api/bootstrap', admin)).body.briefIdeas).toBe(false);
      expect((await send('POST', '/api/admin/recording/start', admin, {})).status).toBe(200);
      try {
        const r = await suggest({ clientId: acme, title: 'Practice' }, admin);
        expect([r.status, r.body.error.code]).toEqual([403, 'viewing_as']);
        expect(asked).toHaveLength(0);
      } finally {
        await send('POST', '/api/admin/recording/stop', admin, {});
      }
    } finally {
      await send('POST', '/api/admin/view-as/stop', admin, {});
    }
    expect((await send('GET', '/api/bootstrap', admin)).body.briefIdeas).toBe(true);
  });
});

describe('the Claude brief helper', () => {
  const input: BriefIdeasInput = {
    title: 'I lived on $1 a week',
    client: { name: 'Globex', brandVoice: 'Bright', guidance: null, dos: 'Faces big', donts: 'No arrows' },
    shoot: { title: 'Kitchen day', date: '2026-11-02' },
    picked: [{ title: 'Pantry tour', brief: 'Open pantry', onImage: 'WHAT WE EAT' }],
  };
  const clientThat = (parse: (body: Record<string, unknown>) => Promise<unknown>) => ({ beta: { messages: { parse } } }) as unknown as Anthropic;

  it('asks in text only, with the settings it must use, and answers with what it parsed', async () => {
    const sent: Record<string, unknown>[] = [];
    const helper = claudeBriefHelper(clientThat(async (body) => { sent.push(body); return { stop_reason: 'end_turn', parsed_output: { ideas: IDEAS } }; }));
    expect(await helper.suggest(input)).toEqual({ ideas: IDEAS });
    const body = sent[0];
    expect([body.model, body.max_tokens, body.betas, body.fallbacks]).toEqual(['claude-opus-5-5', 4000, ['server-side-fallback-2026-07-01'], 'default']);
    for (const banned of ['thinking', 'temperature', 'top_p', 'top_k']) expect(body).not.toHaveProperty(banned);
    expect((body.output_config as { effort: string; format: unknown }).effort).toBe('low');
    expect((body.output_config as { format: unknown }).format).toBeTruthy();
    const [message] = body.messages as { role: string; content: { type: string; text?: string }[] }[];
    expect(message.content.map((c) => c.type)).toEqual(['text']);
    for (const words of ['I lived on $1 a week', 'Kitchen day on 2026-11-02', 'The client: Globex', 'Brand voice: Bright', 'Guidance: not given', 'Do: Faces big', 'Don’t: No arrows', '“Pantry tour”', 'Open pantry', 'WHAT WE EAT']) {
      expect(message.content[0].text).toContain(words);
    }
    expect(String(body.system)).toContain(`${THUMB_IDEA_COUNT} distinct directions`);
    expect(String(body.system)).toMatch(/never repeat/i);
    expect(String(body.system)).toMatch(/real people/i);
  });

  it('says plainly when Claude declines or runs out of room', async () => {
    const answers: [Record<string, unknown>, RegExp][] = [
      [{ stop_reason: 'refusal', parsed_output: { ideas: IDEAS } }, /No ideas could be suggested/],
      [{ stop_reason: 'max_tokens', parsed_output: null }, /ran too long/],
      [{ stop_reason: 'end_turn', parsed_output: null }, /ran too long/],
    ];
    for (const [answer, words] of answers) {
      const err = await claudeBriefHelper(clientThat(async () => answer)).suggest(input).catch((e: unknown) => e);
      expect([answer.stop_reason, err instanceof HttpError && err.status]).toEqual([answer.stop_reason, 422]);
      expect((err as HttpError).message).toMatch(words);
    }
  });

  it('maps the API’s failures the way Paste notes does, never with the key', async () => {
    const SDK = (await import('@anthropic-ai/sdk')).default;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const h = new Headers({ 'request-id': 'req_456' });
      const cases: [Error, number, RegExp][] = [
        [new SDK.AuthenticationError(401, { message: 'invalid x-api-key sk-ant-secret' }, undefined, h), 503, /ANTHROPIC_API_KEY/],
        [new SDK.PermissionDeniedError(403, { message: 'no' }, undefined, h), 503, /aren’t set up correctly/],
        [new SDK.NotFoundError(404, { message: 'model not found' }, undefined, h), 503, /aren’t set up correctly/],
        [new SDK.RateLimitError(429, { message: 'slow down' }, undefined, h), 429, /Try again in a minute/],
        [new SDK.BadRequestError(400, { message: 'prompt too long' }, undefined, h), 400, /prompt too long/],
        [new SDK.InternalServerError(500, { message: 'boom' }, undefined, h), 502, /didn’t answer/],
        [new SDK.APIConnectionError({ message: 'offline' }), 502, /didn’t answer/],
      ];
      for (const [thrown, status, words] of cases) {
        const err = await claudeBriefHelper(clientThat(async () => { throw thrown; })).suggest(input).catch((e: unknown) => e);
        expect([thrown.constructor.name, err instanceof HttpError ? err.status : err]).toEqual([thrown.constructor.name, status]);
        expect((err as HttpError).message).toMatch(words);
        expect((err as HttpError).message).not.toContain('sk-ant');
      }
      expect(warn.mock.calls.some(([line]) => String(line).includes('req_456'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

// ── Settings → Editors: a kind ───────────────────────────────────────────

describe('Settings → Editors', () => {
  const entry = (list: Editor[], name: string) => list.find((e) => e.name === name);

  it('keeps what each entry does: set, kept when left out, cleared with null', async () => {
    const made = await send('POST', '/api/editors', admin, { name: 'Tia Thumb', city: 'Lisbon, Portugal', workStart: 9, workEnd: 18, editorKind: 'thumbnail' });
    expect([made.status, entry(made.body.editors, 'Tia Thumb')?.editorKind]).toEqual([200, 'thumbnail']);
    const plain = await send('POST', '/api/editors', admin, { name: 'Vin Video', city: 'Manila, Philippines', workStart: 9, workEnd: 18 });
    expect(entry(plain.body.editors, 'Vin Video')?.editorKind).toBeNull();
    const tia = entry(made.body.editors, 'Tia Thumb')!;
    expect(entry((await send('GET', '/api/editors', admin)).body.editors, 'Tia Thumb')).toMatchObject({ editorKind: 'thumbnail', city: 'Lisbon, Portugal' });
    // the form sends every field; an older one without the kind keeps it
    const kept = await send('PATCH', `/api/editors/${tia.id}`, admin, { name: 'Tia Thumb', city: 'Lisbon, Portugal', workStart: 10, workEnd: 18 });
    expect(entry(kept.body.editors, 'Tia Thumb')).toMatchObject({ editorKind: 'thumbnail', workHours: [10, 18] });
    const video = await send('PATCH', `/api/editors/${tia.id}`, admin, { name: 'Tia Thumb', city: 'Lisbon, Portugal', workStart: 10, workEnd: 18, editorKind: 'short_form' });
    expect(entry(video.body.editors, 'Tia Thumb')?.editorKind).toBe('short_form');
    const cleared = await send('PATCH', `/api/editors/${tia.id}`, admin, { name: 'Tia Thumb', city: 'Lisbon, Portugal', workStart: 10, workEnd: 18, editorKind: null });
    expect(entry(cleared.body.editors, 'Tia Thumb')?.editorKind).toBeNull();
    const bad = await send('POST', '/api/editors', admin, { name: 'Wrong', city: 'Paris, France', editorKind: 'writer' });
    expect([bad.status, Object.keys(bad.body.error.fields)]).toEqual([400, ['editorKind']]);
    const log = await db.query<{ summary: string }>(`select summary from activity where entity_type = 'editor' and entity_id = $1 order by id`, [tia.id]);
    expect(log.map((l) => l.summary)).toEqual([
      'Added editor Tia Thumb (Lisbon) as a thumbnail designer', 'Updated editor Tia Thumb', 'Updated editor Tia Thumb: now a video editor',
      'Updated editor Tia Thumb: what they do not set',
    ]);
    expect((await send('GET', '/api/editors', people.max.cookie)).status).toBe(403);
  });

  it('gives the Editors tab only video editors from that list to give site access', async () => {
    const w = await makeWorld();
    try {
      await w.oneEditorSince('2026-01-01');
      const member = (id: string, email: string, firstName: string, lastName: string) => ({ id, email, firstName, lastName, role: 'editor', deactivated: false });
      const dana = member('m_dana', 'dana@studio.test', 'Dana', 'Diaz');
      const tia = member('m_tia', 'tia@studio.test', 'Tia', 'Thumb');
      w.api.members = async () => [dana, tia];
      const on = (m: typeof dana): TimelinerBrandMember => ({ role: 'editor', automatic: false, member: m });
      const ids: Record<string, number> = {};
      for (const [name, city, editorKind] of [['Dana Diaz', 'Manila, Philippines', null], ['Tia Thumb', 'Lisbon, Portugal', 'thumbnail']] as const) {
        const r = await w.send('POST', '/api/editors', w.admin, { name, city, workStart: 9, workEnd: 18, editorKind });
        ids[name] = (r.body.editors as Editor[]).find((e) => e.name === name)!.id;
      }
      await w.client('Acme');
      w.tl.brands.b_acme = 'Acme';
      w.tl.projects.p_acme = { id: 'p_acme', name: 'Acme Reels', nodeId: 'b_acme', createdAt: '2026-01-05T15:00:00Z', subFolders: [] };
      w.tl.onBrand = { b_acme: [on(dana), on(tia)] };
      w.tl.tasks.push(video('t_a1', 'Acme 01', 'toDo', { projectId: 'p_acme', brandId: 'b_acme', subFolderId: null }));
      const b = await w.sync();
      const add = (name: string) => b.toAdd.find((p) => p.name === name);
      expect(add('Dana Diaz')).toMatchObject({ editorId: ids['Dana Diaz'], flag: { kind: 'no_site_access' } });
      // Tia's entry says she designs thumbnails: she's not that entry on the Editors tab, just someone to add
      expect(add('Tia Thumb')).toMatchObject({ editorId: null, city: null, flag: { kind: 'not_on_site' } });
      // marked as a video editor, she is
      await w.send('PATCH', `/api/editors/${ids['Tia Thumb']}`, w.admin, { name: 'Tia Thumb', city: 'Lisbon, Portugal', workStart: 9, workEnd: 18, editorKind: 'short_form' });
      expect((await w.board()).toAdd.find((p) => p.name === 'Tia Thumb')).toMatchObject({ editorId: ids['Tia Thumb'], flag: { kind: 'no_site_access' } });
    } finally {
      await w.close();
    }
  });
});
