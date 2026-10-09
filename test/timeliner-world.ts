// A workspace and a stand-in Timeliner for the matching tests (test/pdf-matching.test.ts and
// test/video-matching.test.ts): a team, a client with shoots and batches, Timeliner's tasks, projects and
// members, and its webhook messages, signed the way Timeliner signs them.

import { createHmac } from 'node:crypto';
import { expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import type { Db } from '../server/db';
import type { Ctx } from '../server/core';
import { TimelinerError, type TimelinerApi, type TimelinerBrandMember, type TimelinerTask } from '../server/timeliner';
import type { BatchDetail, EditingBoard, MyEditing } from '../shared/types';
import { freshDb } from './db';

const SECRET = `whsec_${'ef'.repeat(32)}`;

type Project = NonNullable<Awaited<ReturnType<TimelinerApi['project']>>>;

export interface World {
  db: Db;
  app: FastifyInstance;
  ctx: Ctx;
  /** the time the site and Timeliner agree it is */
  at(iso: string): void;
  now(): string;
  admin: string; writer: string; leo: string; maya: string;
  writerId: number;
  /** Timeliner's side */
  tl: {
    tasks: TimelinerTask[];
    projects: Record<string, Project>;
    brands: Record<string, string>;
    /** who is on each brand (GET /brands/{id}/members): a client's editors are assigned there */
    onBrand: Record<string, TimelinerBrandMember[]>;
    /** GET /tasks/{id} fails */
    taskFails: boolean;
    /** GET /tasks/{id} calls, to see what was cached */
    taskCalls: string[];
  };
  api: TimelinerApi;
  send(method: string, url: string, cookie: string, body?: unknown): Promise<{ status: number; body: ReturnType<typeof JSON.parse>; headers: Record<string, unknown> }>;
  hook(type: string, data: Record<string, unknown>, id?: string): Promise<{ status: number; outcome: string }>;
  sync(): Promise<EditingBoard>;
  board(): Promise<EditingBoard>;
  mine(cookie: string): Promise<MyEditing>;
  client(name: string): Promise<number>;
  /** a batch of `count` scripts for a shoot, sent as one document; `approve` the numbers approved (all by default) */
  batch(clientId: number, title: string, count: number, o: { shoot?: string; approve?: number[] | 'all' | 'none' }): Promise<{ id: number; ids: (...n: number[]) => number[] }>;
  approve(batchId: number, ids: number[]): Promise<void>;
  /** the batch's approvals and deliveries took place at `at` (the database stamps its own clock otherwise) */
  stamp(batchId: number, o: { approvedAt?: string; deliveredAt?: string }): Promise<void>;
  detail(batchId: number): Promise<BatchDetail>;
  close(): Promise<void>;
}

export function video(id: string, title: string, statusGroup: string, more: Partial<TimelinerTask> = {}): TimelinerTask {
  return {
    id, title, statusGroup, status: 'active', type: 'media', kind: 'regular', projectId: 'p_mine', brandId: 'b_js', subFolderId: 'sf_org',
    assigneeIds: [], internalDeadline: null, externalDeadline: null, internalRevisions: 0, clientRevisions: 0,
    createdAt: '2026-10-07T15:00:00Z', updatedAt: '2026-10-07T15:00:00Z', approvedAt: null, media: null, ...more,
  };
}

/** a scripts PDF as a task: its current file is a PDF, with a download link that expires */
export function pdfTask(id: string, createdAt: string, file: { id: string; name: string; url?: string }, more: Partial<TimelinerTask> = {}): TimelinerTask {
  return video(id, 'Scripts', 'approved', {
    createdAt, updatedAt: createdAt, approvedAt: createdAt, subFolderId: null,
    media: { fileId: file.id, name: file.name, mimeType: 'application/pdf', downloadUrl: file.url ?? `https://s3.example/${file.id}?sig`, expiresAt: '2026-12-31T00:00:00.000Z', purgedAt: null },
    ...more,
  });
}

export async function makeWorld(): Promise<World> {
  let clock = new Date('2026-10-08T13:40:00Z');
  const tl: World['tl'] = {
    tasks: [],
    projects: {
      p_mine: { id: 'p_mine', name: 'My Videos', nodeId: 'b_js', createdAt: '2025-01-10T15:00:00Z', subFolders: [{ id: 'sf_org', name: 'Organic', createdAt: '2025-01-10T15:00:00Z' }, { id: 'sf_ads', name: 'Ads', createdAt: '2025-01-10T15:00:00Z' }] },
    },
    brands: { b_js: 'Joshua Shalimar' },
    onBrand: {},
    taskFails: false,
    taskCalls: [],
  };
  const api: TimelinerApi = {
    project: async (id) => tl.projects[id] ?? null,
    brand: async (id) => (tl.brands[id] ? { id, name: tl.brands[id] } : null),
    task: async (id) => {
      tl.taskCalls.push(id);
      if (tl.taskFails) throw new TimelinerError('Couldn’t reach Timeliner. Try again in a minute.', 0);
      return tl.tasks.find((t) => t.id === id) ?? null;
    },
    tasks: async () => ({ data: [...tl.tasks].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')), nextBefore: null }),
    brands: async () => ({ data: Object.entries(tl.brands).map(([id, name]) => ({ id, name })), nextBefore: null }),
    members: async () => [
      { id: 'm_ada', email: 'ada@scale.test', firstName: 'Ada', lastName: 'Admin', role: 'admin' },
      { id: 'm_leo', email: 'leo@scale.test', firstName: 'Leo', lastName: 'Martins', role: 'editor' },
      { id: 'm_maya', email: 'maya@scale.test', firstName: 'Maya', lastName: 'Reyes', role: 'editor' },
    ],
    brandMembers: async (id) => tl.onBrand[id] ?? [],
    lastMove: async () => null,
    webhooks: async () => [],
    createWebhook: async () => ({ id: 'wh_1', secret: SECRET }),
    updateWebhook: async () => {},
    rotateSecret: async () => ({ secret: SECRET }),
    testWebhook: async () => ({ ok: true, statusCode: 200, error: null }),
  };

  const db = await freshDb();
  const ctx: Ctx = { db, now: () => clock, secureCookies: false, allowSetup: true, uploadLimitBytes: 1024 * 1024, timeliner: api, publicUrl: 'https://scripts.example.com' };
  const app = await buildApp(ctx);
  const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0];
  const json = (url: string, body: unknown, cookie?: string) =>
    app.inject({ method: 'POST', url, headers: { 'x-scale-media': '1', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, payload: JSON.stringify(body) });
  const admin = cookieOf(await json('/api/auth/setup', { name: 'Ada Admin', email: 'ada@scale.test', password: 'admin-password-1' }));
  let writerId = 0;
  for (const [name, email, role] of [['Wes Writer', 'wes@scale.test', 'writer'], ['Leo Martins', 'leo@scale.test', 'editor'], ['Maya Reyes', 'maya@scale.test', 'editor']]) {
    const r = await json('/api/users', { name, email, role, password: 'team-password-1' }, admin);
    expect(r.statusCode).toBe(200);
    if (role === 'writer') writerId = JSON.parse(r.body).users.find((u: { email: string }) => u.email === email).id;
  }
  const login = async (email: string) => cookieOf(await json('/api/auth/login', { email, password: 'team-password-1' }));
  const [writer, leo, maya] = [await login('wes@scale.test'), await login('leo@scale.test'), await login('maya@scale.test')];
  expect((await json('/api/timeliner/connect', {}, admin)).statusCode).toBe(200);

  const send: World['send'] = async (method, url, cookie, body) => {
    const r = await app.inject({
      method: method as 'POST', url, headers: { 'x-scale-media': '1', cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let parsed: ReturnType<typeof JSON.parse> = null;
    try { parsed = r.body ? JSON.parse(r.body) : null; } catch { parsed = r.body; }
    return { status: r.statusCode, body: parsed, headers: r.headers as Record<string, unknown> };
  };
  let n = 0;
  const hook: World['hook'] = async (type, data, id) => {
    const raw = JSON.stringify({ id: id ?? `evt_${++n}`, type, apiVersion: '2026-06-02', createdAt: clock.toISOString(), workspaceId: 'ws_1', data });
    const t = Math.floor(clock.getTime() / 1000);
    const signature = `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex')}`;
    const r = await app.inject({ method: 'POST', url: '/hooks/timeliner', headers: { 'content-type': 'application/json', 'x-timeliner-signature': signature }, payload: raw });
    expect(r.statusCode).toBe(200);
    return { status: r.statusCode, outcome: JSON.parse(r.body).outcome };
  };
  const board = async () => (await send('GET', '/api/editing', admin)).body as EditingBoard;
  const sync = async () => {
    const r = await send('POST', '/api/editing/sync', admin, {});
    expect([r.status, (r.body as EditingBoard).sync.error]).toEqual([200, null]);
    return r.body as EditingBoard;
  };
  const approve: World['approve'] = async (batchId, ids) => {
    if (ids.length) expect((await send('POST', `/api/batches/${batchId}/review`, admin, { action: 'approve', scriptIds: ids })).status).toBe(200);
  };
  const detail = async (id: number) => (await send('GET', `/api/batches/${id}`, admin)).body as BatchDetail;

  return {
    db, app, ctx, admin, writer, leo, maya, writerId, tl, api, send, hook, sync, board, approve, detail,
    at: (iso) => { clock = new Date(iso); },
    now: () => clock.toISOString(),
    mine: async (cookie) => (await send('GET', '/api/editing/me', cookie)).body as MyEditing,
    client: async (name) => (await send('POST', '/api/clients', admin, { name })).body.clientId as number,
    batch: async (clientId, title, count, o) => {
      const r = o.shoot
        ? await send('POST', '/api/shoots', admin, { clientId, startDate: o.shoot, endDate: null, batch: { title, targetCount: count, split: [{ writerId, count }], briefingIds: [], priority: 'normal' } })
        : await send('POST', '/api/batches', admin, { clientId, title, targetCount: count, split: [{ writerId, count }] });
      expect([r.status, r.body?.error]).toEqual([200, undefined]);
      const id = r.body.batchId as number;
      const scripts = (await detail(id)).scripts;
      const ids = (...nums: number[]) => scripts.filter((s) => nums.includes(s.number)).map((s) => s.id);
      expect((await send('POST', `/api/batches/${id}/submissions`, writer, { scriptIds: scripts.map((s) => s.id), url: `https://docs.example/${encodeURIComponent(title)}` })).status).toBe(200);
      const which = o.approve ?? 'all';
      await approve(id, which === 'all' ? scripts.map((s) => s.id) : which === 'none' ? [] : ids(...which));
      return { id, ids };
    },
    stamp: async (batchId, o) => {
      if (o.approvedAt) await db.query(`update scripts set approved_at = $2 where batch_id = $1 and approved_at is not null`, [batchId, o.approvedAt]);
      if (o.deliveredAt) {
        await db.query(`update scripts set delivered_at = $2 where batch_id = $1 and delivered_at is not null`, [batchId, o.deliveredAt]);
        await db.query(`update deliveries set confirmed_at = $2 where batch_id = $1`, [batchId, o.deliveredAt]);
      }
    },
    close: async () => { await app.close(); await db.close(); },
  };
}

/** a version uploaded to a task in Timeliner (a scripts PDF, or anything else) */
export const versionUploaded = (o: { taskId: string; fileName: string; version: number; uploadedAt: string; fileId?: string; projectId?: string; brandId?: string; taskTitle?: string }) => ({
  taskId: o.taskId, projectId: o.projectId ?? 'p_mine', brandId: o.brandId ?? 'b_js', taskTitle: o.taskTitle ?? 'Scripts',
  fileId: o.fileId ?? `${o.taskId}_v${o.version}`, fileName: o.fileName, mimeType: o.fileName.endsWith('.pdf') ? 'application/pdf' : 'video/mp4',
  size: 1000, versionNumber: o.version, uploadedBy: 'm_ada', source: 'app', uploadedAt: o.uploadedAt,
});
