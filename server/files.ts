// Stored files, kept out of memory. An upload is streamed to a temporary file
// as it arrives (hashing along the way), then written to the database in 4 MB
// pieces; a download is read back in 512 KB pieces and streamed out. However
// big the file, the server holds only a piece or two of it at a time.

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';
import type { Db } from './db';
import { HttpError } from './http';
import type { Me } from '../shared/types';

const READ_PIECE = 512 * 1024;
const WRITE_PIECE = 4 * 1024 * 1024;
const BLOCKED_EXT = /\.(exe|bat|cmd|com|msi|scr|js|mjs|vbs|ps1|sh|jar|app|dll)$/i;

/** An upload waiting on disk until it's stored (or, for small generated files, already in memory). */
export interface UploadedFile { filename: string; mime: string; size: number; sha256: string; path?: string; data?: Buffer }

/** A small file made by the server itself (like the demo's sample PDFs). */
export function bufferFile(filename: string, mime: string, data: Buffer): UploadedFile {
  return { filename, mime, data, size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
}

const spooled = new WeakMap<FastifyRequest, string[]>();

/** Deletes a request's temporary upload files when it finishes, whether or not it succeeded. */
export function registerUploadCleanup(app: FastifyInstance) {
  const clean = async (req: FastifyRequest) => {
    const paths = spooled.get(req);
    if (!paths) return;
    spooled.delete(req);
    await Promise.all(paths.map((p) => unlink(p).catch(() => {})));
  };
  app.addHook('onResponse', clean);
  app.addHook('onRequestAbort', clean);
}

/** Streams one multipart file part to a temporary file. Empty files come back as null. */
export async function spool(req: FastifyRequest, part: MultipartFile, limitBytes: number): Promise<UploadedFile | null> {
  const tmp = path.join(tmpdir(), `sm-upload-${randomBytes(8).toString('hex')}`);
  const list = spooled.get(req) ?? [];
  list.push(tmp);
  spooled.set(req, list);
  const hash = createHash('sha256');
  let size = 0;
  const tap = new Transform({ transform(chunk: Buffer, _enc, done) { hash.update(chunk); size += chunk.length; done(null, chunk); } });
  await pipeline(part.file, tap, createWriteStream(tmp));
  if (part.file.truncated) throw new HttpError(413, `Files can be up to ${Math.round(limitBytes / 1024 / 1024)} MB`);
  if (!size) return null;
  return { filename: part.filename, mime: part.mimetype || 'application/octet-stream', path: tmp, size, sha256: hash.digest('hex') };
}

/** Saves an upload into the files table, piece by piece. Run it inside the caller's transaction. */
export async function storeFile(t: Db, me: Me, file: UploadedFile): Promise<number> {
  if (BLOCKED_EXT.test(file.filename)) throw new HttpError(400, 'That file type can’t be uploaded', { file: 'That file type can’t be uploaded' });
  const safeName = file.filename.replace(/[\r\n"\\/]/g, '_').slice(0, 200) || 'file';
  const row = await t.one<{ id: number }>(
    `insert into files (filename, mime, size, sha256, data, uploaded_by) values ($1, $2, $3, $4, ''::bytea, $5) returning id`,
    [safeName, file.mime, file.size, file.sha256, me.id],
  );
  const id = row!.id;
  const pieces: AsyncIterable<Buffer> | Buffer[] = file.path
    ? createReadStream(file.path, { highWaterMark: WRITE_PIECE })
    : [file.data ?? Buffer.alloc(0)];
  for await (const piece of pieces) {
    await t.query(`update files set data = data || $2 where id = $1`, [id, piece]);
  }
  return id;
}

export const isBlockedFile = (name: string) => BLOCKED_EXT.test(name);

/** A stored file's contents as a stream, read from the database in small pieces. */
export function fileStream(db: Db, id: number, size: number): Readable {
  let pos = 0;
  /** the next piece, or null at the end */
  const next = async (): Promise<Buffer | null> => {
    if (pos >= size) return null;
    const row = await db.one<{ c: Uint8Array | null }>(`select substring(data from $2 for $3) as c from files where id = $1`, [id, pos + 1, READ_PIECE]);
    const c = row?.c;
    if (!c || !c.length) return null;
    pos += c.length;
    return Buffer.isBuffer(c) ? c : Buffer.from(c.buffer, c.byteOffset, c.byteLength);
  };
  return new Readable({
    highWaterMark: READ_PIECE,
    read() {
      next().then((piece) => { this.push(piece); }, (err: Error) => { this.destroy(err); });
    },
  });
}
