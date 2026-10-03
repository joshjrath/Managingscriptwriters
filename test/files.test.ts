// Stored files (server/files.ts): an upload is written into the database from
// 4 MB pieces and streamed back out in 512 KB pieces, byte for byte.

import { createHash, randomBytes } from 'node:crypto';
import { writeFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../server/db';
import { bufferFile, fileStream, storeFile, type UploadedFile } from '../server/files';
import type { Me } from '../shared/types';
import { freshDb } from './db';

let db: Db;
let dir = '';
let me: Me;

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const readBack = async (id: number, size: number) => {
  const chunks: Buffer[] = [];
  for await (const c of fileStream(db, id, size)) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
};
/** an upload as it arrives: spooled to a temporary file */
const spooled = async (name: string, data: Buffer): Promise<UploadedFile> => {
  const p = path.join(dir, name);
  await writeFile(p, data);
  return { filename: name, mime: 'application/pdf', path: p, size: data.length, sha256: sha(data) };
};

beforeAll(async () => {
  db = await freshDb();
  dir = await mkdtemp(path.join(tmpdir(), 'sm-files-test-'));
  const u = await db.one<{ id: number }>(`insert into users (name, email, role, password_hash) values ('Ada', 'ada@x.test', 'owner', 'x') returning id`);
  me = { id: u!.id, name: 'Ada', email: 'ada@x.test', role: 'owner' } as Me;
});

afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('stored files', () => {
  it('stores a file of several pieces and reads back the same bytes', async () => {
    const data = randomBytes(9 * 1024 * 1024 + 12_345); // three 4 MB pieces, the last one partial
    const file = await spooled('big.pdf', data);
    const id = await db.tx((t) => storeFile(t, me, file));
    const stored = await db.one<{ n: number }>(`select octet_length(data) as n from files where id = $1`, [id]);
    expect(Number(stored!.n)).toBe(data.length);
    expect(sha(await readBack(id, data.length))).toBe(sha(data));
  });

  it('keeps each file separate when one change stores several', async () => {
    const a = randomBytes(5 * 1024 * 1024);
    const b = Buffer.from('%PDF-1.4 small');
    const [ida, idb] = await db.tx(async (t) => [await storeFile(t, me, await spooled('a.pdf', a)), await storeFile(t, me, bufferFile('b.pdf', 'application/pdf', b))]);
    expect(sha(await readBack(ida, a.length))).toBe(sha(a));
    expect((await readBack(idb, b.length)).toString()).toBe('%PDF-1.4 small');
  });

  it('stores nothing when the change fails', async () => {
    const before = await db.one<{ n: number }>(`select count(*) as n from files`);
    await expect(db.tx(async (t) => { await storeFile(t, me, bufferFile('c.pdf', 'application/pdf', Buffer.from('x'))); throw new Error('later check failed'); })).rejects.toThrow();
    expect((await db.one<{ n: number }>(`select count(*) as n from files`))!.n).toEqual(before!.n);
  });
});
