// Videos put away in Timeliner leave the editors' lists: one in a project that was archived (the video itself
// still says active), and one archived since that's too old for a read to reach any more (Timeliner's list leaves
// archived tasks out), looked up by itself. Timeliner is a stand-in here, no network.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../server/db';
import type { Ctx } from '../server/core';
import { applyTaskMessage, syncTimeliner } from '../server/editing';
import type { TimelinerApi, TimelinerTask } from '../server/timeliner';
import { freshDb } from './db';

const START = new Date('2026-10-29T15:00:00Z');
let clock = START;
const hoursLater = (h: number) => { clock = new Date(START.getTime() + h * 3600_000); return clock; };

const video = (id: string, title: string, createdAt: string, more: Partial<TimelinerTask> = {}): TimelinerTask => ({
  id, title, statusGroup: 'toDo', status: 'active', type: 'media', projectId: 'p_organic', brandId: 'b_scale', subFolderId: null,
  assigneeIds: ['m_aftab'], internalDeadline: null, externalDeadline: null, internalRevisions: 0, clientRevisions: 0,
  createdAt, updatedAt: createdAt, approvedAt: null, ...more,
});
let tasks: TimelinerTask[] = [
  video('t_new', 'Organic 9', '2026-10-28T15:00:00Z'),
  video('t_recording', 'Organic 4 Recording', '2026-10-27T15:00:00Z', { projectId: 'p_recordings' }),
  // made long ago: newer tasks push them past what a read reaches
  video('t_old2', 'Organic 2', '2026-08-01T15:00:00Z'),
  video('t_old3', 'Organic 3', '2026-08-02T15:00:00Z'),
];
const projectStatus: Record<string, string> = { p_organic: 'active', p_recordings: 'active' };
/** the list goes on past the read's page cap, as a big workspace's does (else every task fits in one page) */
let long = false;
const listed = () => tasks.filter((t) => t.status === 'active').sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));

const fake: TimelinerApi = {
  project: async (id) => (id in projectStatus ? { id, name: id === 'p_organic' ? 'Organic' : 'Recordings', nodeId: 'b_scale', createdAt: '2026-01-01T00:00:00Z', status: projectStatus[id], subFolders: [] } : null),
  brand: async (id) => ({ id, name: 'SCALE Media Personal Brand' }),
  task: async (id) => tasks.find((t) => t.id === id) ?? null,
  tasks: async (before) => {
    if (!long) return { data: before ? [] : listed(), nextBefore: null };
    // the newest page only, then pages that never end before the cap
    return before ? { data: [], nextBefore: `${before}+` } : { data: listed().filter((t) => (t.createdAt ?? '') > '2026-10-01'), nextBefore: 'more' };
  },
  brands: async () => ({ data: [{ id: 'b_scale', name: 'SCALE Media Personal Brand' }], nextBefore: null }),
  members: async () => [{ id: 'm_aftab', email: 'aftab@scale.test', firstName: 'Aftab', lastName: null, role: 'editor' }],
  brandMembers: async () => [],
  lastMove: async () => null,
  webhooks: async () => [],
  createWebhook: async () => ({ id: 'wh_1', secret: 'whsec_x' }),
  updateWebhook: async () => {},
  rotateSecret: async () => ({ secret: 'whsec_x' }),
  testWebhook: async () => ({ ok: true, statusCode: 200, error: null }),
};

let db: Db;
const kept = async () => (await db.query<{ id: string }>(`select id from timeliner_tasks order by id`)).map((r) => r.id);
const read = async (at: Date) => {
  const r = await syncTimeliner(db, fake, at);
  expect(r.ok).toBe(true);
  return r;
};

beforeAll(async () => {
  db = await freshDb();
});

afterAll(async () => {
  await db.close();
});

describe('videos archived in Timeliner', () => {
  it('starts with every video', async () => {
    await read(clock);
    expect(await kept()).toEqual(['t_new', 't_old2', 't_old3', 't_recording']);
  });

  it('drops the videos of a project archived in Timeliner, and keeps them out until it’s restored', async () => {
    long = true;
    projectStatus.p_recordings = 'archived';
    // the project is read again after an hour: then its video leaves, though the video itself still says active
    await read(hoursLater(2));
    expect(await kept()).not.toContain('t_recording');
    // a read within the hour keeps it out from what it last read of the project
    await read(hoursLater(2.5));
    expect(await kept()).not.toContain('t_recording');
    // nor does a read that finds no such project bring it back
    delete projectStatus.p_recordings;
    await read(hoursLater(3.5));
    expect(await kept()).not.toContain('t_recording');
    projectStatus.p_recordings = 'active';
    await read(hoursLater(4));
    expect(await kept()).toContain('t_recording');
  });

  it('looks up the old videos a read no longer reaches, and drops one archived since', async () => {
    tasks = tasks.map((t) => (t.id === 't_old2' ? { ...t, status: 'archived' } : t));
    // Timeliner's list leaves archived tasks out, and this one is older than anything the read reaches
    const r = await read(hoursLater(5));
    expect(r.complete).toBe(false);
    expect(await kept()).toEqual(['t_new', 't_old3', 't_recording']);
    // one deleted outright is gone the same way; one still active stays
    tasks = tasks.filter((t) => t.id !== 't_old3');
    await read(hoursLater(6));
    expect(await kept()).toEqual(['t_new', 't_recording']);
  });

  it('drops a video straight away when a message comes for it and its project is archived', async () => {
    projectStatus.p_organic = 'archived';
    const ctx: Ctx = { db, now: () => hoursLater(8), secureCookies: false, allowSetup: false, uploadLimitBytes: 0 };
    expect(await applyTaskMessage(ctx, fake, { type: 'task.updated', taskId: 't_new' })).toBe('Video removed: its project was archived in Timeliner');
    expect(await kept()).toEqual(['t_recording']);
  });
});
