// Counting the scripts in a shoot's document with Claude (server/doc-counts.ts), and the next-shoot estimate that
// goes by the count: Claude and Google are stand-ins here, so nothing leaves the test.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import type { Db } from '../server/db';
import type { Ctx } from '../server/core';
import { googleDownload, type DocContent } from '../server/doc-counts';
import { scaleSplit } from '../shared/workflow';
import type { BatchDetail, ShootForecasts } from '../shared/types';
import { freshDb } from './db';

describe('reading documents', () => {
  it('downloads only Google Docs and Drive files, by their id', () => {
    expect(googleDownload('https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit?usp=sharing')).toEqual({ url: 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/export?format=txt', doc: true });
    expect(googleDownload('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view')).toEqual({ url: 'https://drive.google.com/uc?export=download&id=1AbCdEfGhIjKlMnOp', doc: false });
    expect(googleDownload('https://drive.google.com/open?id=1AbCdEfGhIjKlMnOp')?.url).toBe('https://drive.google.com/uc?export=download&id=1AbCdEfGhIjKlMnOp');
    expect(googleDownload('https://example.com/document/d/1AbCdEfGhIjKlMnOp')).toBeNull();
    expect(googleDownload('http://docs.google.com/document/d/1AbCdEfGhIjKlMnOp')).toBeNull();
    expect(googleDownload('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp')).toBeNull();
  });
  it('keeps each writer’s share when the document holds more scripts than the site', () => {
    expect(scaleSplit([20, 11], 45)).toEqual([29, 16]);
    expect(scaleSplit([1, 1, 1], 4)).toEqual([2, 1, 1]);
    expect(scaleSplit([2, 0], 45)).toEqual([45, 0]);
    expect(scaleSplit([0, 0], 5)).toEqual([0, 0]);
  });
});

describe('the next shoot goes by what its document holds', () => {
  const NOW = new Date('2026-10-25T16:00:00Z');
  const DOC = 'https://docs.google.com/document/d/1ScriptsForOctober/edit';
  const PRIVATE = 'https://docs.google.com/document/d/1PrivateScriptsDoc/edit';
  let db: Db;
  let app: FastifyInstance;
  let admin = '';
  let writer = '';
  let writerId = 0;
  const read: string[] = [];
  const fetched: string[] = [];
  const send = async (method: string, url: string, cookie: string, body?: unknown) => {
    const r = await app.inject({
      method: method as 'POST', url, headers: { 'x-scale-media': '1', cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };

  beforeAll(async () => {
    db = await freshDb();
    const ctx: Ctx = {
      db, now: () => NOW, secureCookies: false, allowSetup: true, uploadLimitBytes: 1024 * 1024,
      // Claude: counts the "Script N" headings
      scriptCounter: {
        count: async (doc: DocContent) => {
          const text = 'text' in doc ? doc.text : '';
          read.push(text.slice(0, 20));
          const n = (text.match(/^Script \d+/gm) ?? []).length;
          return { scripts: n || null, note: n ? `Numbered Script 1 to Script ${n}` : 'No scripts found' };
        },
      },
      // Google: the shared doc as text, the private one as its sign-in page
      fetchDoc: (async (url: string) => {
        fetched.push(url);
        if (url.includes('1ScriptsForOctober')) return new Response(Array.from({ length: 45 }, (_, i) => `Script ${i + 1}\nHook…\n`).join('\n'), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
        return new Response('<html>Sign in</html>', { headers: { 'content-type': 'text/html' } });
      }) as typeof fetch,
    };
    app = await buildApp(ctx);
    const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0];
    const json = (url: string, body: unknown, cookie?: string) =>
      app.inject({ method: 'POST', url, headers: { 'x-scale-media': '1', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, payload: JSON.stringify(body) });
    admin = cookieOf(await json('/api/auth/setup', { name: 'Ada Admin', email: 'ada@scale.test', password: 'admin-password-1' }));
    const added = JSON.parse((await json('/api/users', { name: 'Wes Writer', email: 'wes@scale.test', role: 'writer', password: 'team-password-1' }, admin)).body);
    writerId = added.users.find((u: { email: string }) => u.email === 'wes@scale.test').id;
    writer = cookieOf(await json('/api/auth/login', { email: 'wes@scale.test', password: 'team-password-1' }));
  });
  afterAll(async () => {
    await app.close();
    await db.close();
  });

  const shoot = async (clientId: number, startDate: string, count: number) => {
    const r = await send('POST', '/api/shoots', admin, { clientId, startDate, endDate: null, batch: { targetCount: count, split: [{ writerId, count }], briefingIds: [], priority: 'normal' } });
    expect(r.status).toBe(200);
    return r.body.batchId as number;
  };
  const sendDoc = async (batchId: number, url: string) => {
    const b = (await send('GET', `/api/batches/${batchId}`, writer)).body as BatchDetail;
    expect((await send('POST', `/api/batches/${batchId}/submissions`, writer, { scriptIds: b.scripts.map((s) => s.id), url })).status).toBe(200);
  };
  const forecast = async () => (await send('GET', '/api/shoot-forecast', admin)).body as ShootForecasts;

  it('reads each document once with Claude and paces the next shoot by it', async () => {
    const acme = (await send('POST', '/api/clients', admin, { name: 'Acme', status: 'active' })).body.clientId as number;
    await shoot(acme, '2026-09-01', 31);
    // on the site the October shoot has 2 scripts, but the document the writer sent holds 45
    await sendDoc(await shoot(acme, '2026-10-02', 2), DOC);

    let f = await forecast();
    expect(f.documents).toEqual({ unread: 1, canRead: true });
    expect(f.forecasts[0].lastShoot).toMatchObject({ scripts: 2, fromDocument: false });

    const r = await send('POST', '/api/shoot-forecast/read-documents', admin);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ read: 1, busy: false, documents: { unread: 0 } });
    expect(fetched).toEqual(['https://docs.google.com/document/d/1ScriptsForOctober/export?format=txt']);
    f = r.body as ShootForecasts;
    expect(f.forecasts[0].lastShoot).toMatchObject({ scripts: 45, siteScripts: 2, fromDocument: true });
    // 31 scripts lasted 31 days, so 45 scripts after Oct 2 → Mon Nov 16, all 45 with the writer who had the 2
    expect(f.forecasts[0].estimate).toMatchObject({ shootDate: '2026-11-16', scripts: 45, writers: [{ writerId, count: 45 }], unassigned: 0 });

    // read once: asking again reads nothing
    expect((await send('POST', '/api/shoot-forecast/read-documents', admin)).body).toMatchObject({ read: 0 });
    expect(read).toHaveLength(1);
    // writers can't ask
    expect((await send('POST', '/api/shoot-forecast/read-documents', writer)).status).toBe(403);
  });

  it('keeps why a document couldn’t be opened, and counts the site’s scripts instead', async () => {
    const beta = (await send('POST', '/api/clients', admin, { name: 'Beta', status: 'active' })).body.clientId as number;
    await sendDoc(await shoot(beta, '2026-10-12', 10), PRIVATE);
    expect((await forecast()).documents.unread).toBe(1);
    expect((await send('POST', '/api/shoot-forecast/read-documents', admin)).body).toMatchObject({ read: 1, documents: { unread: 0 } });
    const f = (await forecast()).forecasts.find((x) => x.clientId === beta)!;
    expect(f.lastShoot).toMatchObject({ scripts: 10, fromDocument: false });
    const kept = await db.one<{ scripts: number | null; note: string }>(`select scripts, note from document_counts where key like 'sent:%' and scripts is null`);
    expect(kept?.note).toMatch(/Anyone with the link/);
    // Claude never saw it
    expect(read).toHaveLength(1);
  });
});
