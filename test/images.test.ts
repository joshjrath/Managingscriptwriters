// Reading an image's type and size from its own bytes (server/images.ts), never trusting the browser and never
// decoding: PNG, JPEG (however much metadata sits before its frame header) and WebP in all three forms. Every
// fixture is built here, byte by byte.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asImageUpload, imageInfo, imageInfoOf, JPEG_SEGMENT_CAP, uploadedImageInfo } from '../server/images';
import { bufferFile } from '../server/files';

let dir = '';
beforeAll(async () => { dir = await mkdtemp(path.join(tmpdir(), 'sm-images-test-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

const u16be = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32be = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

function png(width: number, height: number): Buffer {
  const ihdr = Buffer.concat([u32be(width), u32be(height), Buffer.from([8, 2, 0, 0, 0])]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    u32be(ihdr.length), Buffer.from('IHDR'), ihdr, u32be(0),
    u32be(0), Buffer.from('IEND'), u32be(0),
  ]);
}

/** A JPEG segment: marker, then a length that counts itself */
const seg = (marker: number, payload: Buffer) => Buffer.concat([Buffer.from([0xff, marker]), u16be(payload.length + 2), payload]);

function jpeg(width: number, height: number, o: { progressive?: boolean; before?: Buffer[] } = {}): Buffer {
  const sof = Buffer.concat([Buffer.from([8]), u16be(height), u16be(width), Buffer.from([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    ...(o.before ?? []),
    seg(0xdb, Buffer.alloc(65)),
    seg(o.progressive ? 0xc2 : 0xc0, sof),
    seg(0xc4, Buffer.alloc(20)),
    seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
    Buffer.alloc(64, 0x55),
    Buffer.from([0xff, 0xd9]),
  ]);
}

const riff = (chunk: string, data: Buffer) => {
  const body = Buffer.concat([Buffer.from('WEBP'), Buffer.from(chunk), Buffer.alloc(4), data]);
  body.writeUInt32LE(data.length, 8);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from('RIFF'), size, body]);
};

function webpLossy(width: number, height: number): Buffer {
  const dims = Buffer.alloc(4);
  dims.writeUInt16LE(width, 0);
  dims.writeUInt16LE(height, 2);
  return riff('VP8 ', Buffer.concat([Buffer.from([0x50, 0x02, 0x00, 0x9d, 0x01, 0x2a]), dims, Buffer.alloc(32)]));
}

function webpLossless(width: number, height: number): Buffer {
  const bits = Buffer.alloc(4);
  bits.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0);
  return riff('VP8L', Buffer.concat([Buffer.from([0x2f]), bits, Buffer.alloc(32)]));
}

function webpExtended(width: number, height: number): Buffer {
  const data = Buffer.alloc(10);
  data[0] = 0x10;
  data.writeUIntLE(width - 1, 4, 3);
  data.writeUIntLE(height - 1, 7, 3);
  return Buffer.concat([riff('VP8X', data), Buffer.from('VP8L'), Buffer.alloc(16)]);
}

/** writes the bytes to a file, as an upload is spooled, and reads the image there */
const fromDisk = async (name: string, data: Buffer) => {
  const p = path.join(dir, name);
  await writeFile(p, data);
  return imageInfo(p);
};

describe('reading an image from its bytes', () => {
  it('reads a PNG’s type and size from its header', async () => {
    expect(await fromDisk('a.png', png(1280, 720))).toEqual({ mime: 'image/png', width: 1280, height: 720 });
    expect(await imageInfoOf(png(1920, 1080))).toEqual({ mime: 'image/png', width: 1920, height: 1080 });
  });

  it('reads baseline and progressive JPEGs', async () => {
    expect(await fromDisk('b.jpg', jpeg(1280, 720))).toEqual({ mime: 'image/jpeg', width: 1280, height: 720 });
    expect(await fromDisk('p.jpg', jpeg(1600, 900, { progressive: true }))).toEqual({ mime: 'image/jpeg', width: 1600, height: 900 });
  });

  it('finds a JPEG’s size behind a large EXIF and ICC block, well past the first 64 KB', async () => {
    const exif = seg(0xe1, Buffer.alloc(60_000, 0x41));
    const icc = seg(0xe2, Buffer.alloc(60_000, 0x42));
    const big = jpeg(1280, 720, { before: [exif, icc, seg(0xed, Buffer.alloc(8_000))] });
    expect(big.indexOf(Buffer.from([0xff, 0xc0]))).toBeGreaterThan(100_000);
    expect(await fromDisk('big.jpg', big)).toEqual({ mime: 'image/jpeg', width: 1280, height: 720 });
  });

  it('reads a marker padded with fill bytes', async () => {
    const plain = jpeg(800, 450);
    const padded = Buffer.concat([plain.subarray(0, 2), Buffer.from([0xff, 0xff, 0xff]), plain.subarray(2)]);
    expect(await imageInfoOf(padded)).toEqual({ mime: 'image/jpeg', width: 800, height: 450 });
  });

  it('reads lossy, lossless and extended WebP', async () => {
    expect(await fromDisk('l.webp', webpLossy(1280, 720))).toEqual({ mime: 'image/webp', width: 1280, height: 720 });
    expect(await fromDisk('ll.webp', webpLossless(1280, 720))).toEqual({ mime: 'image/webp', width: 1280, height: 720 });
    expect(await fromDisk('x.webp', webpExtended(3840, 2160))).toEqual({ mime: 'image/webp', width: 3840, height: 2160 });
  });

  it('refuses SVG, GIF, HTML, a PDF named .png and anything cut short', async () => {
    const no = [
      ['logo.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"></svg>')],
      ['anim.gif', Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x00, 0x05, 0xd0, 0x02]), Buffer.alloc(32)])],
      ['page.png', Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>')],
      ['doc.png', Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n')],
      ['short.png', png(1280, 720).subarray(0, 20)],
      ['short.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])],
      ['cut.jpg', jpeg(1280, 720).subarray(0, 40)],
      ['short.webp', webpLossy(1280, 720).subarray(0, 24)],
      ['empty.png', Buffer.alloc(0)],
    ] as const;
    for (const [name, data] of no) expect([name, await fromDisk(name, data)]).toEqual([name, null]);
    // a PNG claiming no size at all
    expect(await imageInfoOf(png(0, 720))).toBeNull();
  });

  it('stops walking a JPEG’s segments at its cap', async () => {
    const tiny = (n: number) => Array.from({ length: n }, () => seg(0xe5, Buffer.alloc(4)));
    // the start segment and the quantisation table count too
    expect(await imageInfoOf(jpeg(640, 360, { before: tiny(JPEG_SEGMENT_CAP - 3) }))).toEqual({ mime: 'image/jpeg', width: 640, height: 360 });
    expect(await imageInfoOf(jpeg(640, 360, { before: tiny(JPEG_SEGMENT_CAP - 2) }))).toBeNull();
  });
});

describe('storing an upload as the image it is', () => {
  it('takes the type from the bytes and gives the name the matching extension', async () => {
    const data = png(1280, 720);
    // the browser said HTML, and named it so
    const upload = bufferFile('Cover idea.html', 'text/html', data);
    const info = await uploadedImageInfo(upload);
    expect(info).toEqual({ mime: 'image/png', width: 1280, height: 720 });
    const stored = asImageUpload(upload, info!);
    expect([stored.mime, stored.filename, stored.size]).toEqual(['image/png', 'Cover idea.png', data.length]);
    expect(asImageUpload(bufferFile('Final.JPEG', 'image/png', data), { mime: 'image/jpeg', width: 1, height: 1 }).filename).toBe('Final.jpg');
    expect(asImageUpload(bufferFile('v2.final', 'image/png', data), { mime: 'image/webp', width: 1, height: 1 }).filename).toBe('v2.final.webp');
    expect(asImageUpload(bufferFile('.png', 'image/png', data), { mime: 'image/png', width: 1, height: 1 }).filename).toBe('thumbnail.png');
  });
});
