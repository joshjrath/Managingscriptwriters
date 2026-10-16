// What an uploaded image really is, read from its own header: PNG, JPEG or WebP, and its size in pixels.
// The browser's word for a file's type is never trusted (it's stored and served as the Content-Type), so a
// thumbnail option is kept only when its bytes say it's one of these, under the type they say. Nothing is ever
// decoded or read whole: a few small reads at known places (a JPEG's segments are walked by their lengths, a
// bounded number of times, so a big EXIF, ICC or Photoshop block before the frame header can't hide the size),
// which keeps any file, however large, inside the server's small heap. SVG, GIF, HTML and anything else: null.

import { open } from 'node:fs/promises';
import { storedFileName, type UploadedFile } from './files';
import type { ThumbMime } from '../shared/workflow';

export interface ImageInfo {
  mime: ThumbMime;
  width: number;
  height: number;
}

/** The most JPEG segments read looking for the frame header; a file with more before it is refused (null). */
export const JPEG_SEGMENT_CAP = 64;

/** Up to `len` bytes from `pos` (fewer at the end of the file). */
type Read = (pos: number, len: number) => Promise<Buffer>;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** JPEG frame headers (start of frame), whatever the coding: not C4 (Huffman tables), C8 (reserved) or CC (arithmetic conditioning). */
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

const found = (mime: ThumbMime, width: number, height: number): ImageInfo | null =>
  Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 0x7fffffff && height <= 0x7fffffff ? { mime, width, height } : null;

async function sniff(read: Read): Promise<ImageInfo | null> {
  const head = await read(0, 32);
  // PNG: the signature, then the IHDR chunk with the width and height
  if (head.length >= 24 && head.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return head.toString('latin1', 12, 16) === 'IHDR' ? found('image/png', head.readUInt32BE(16), head.readUInt32BE(20)) : null;
  }
  // WebP: a RIFF container of type WEBP whose first chunk is lossy (VP8), lossless (VP8L) or extended (VP8X)
  if (head.length >= 16 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = head.toString('latin1', 12, 16);
    if (chunk === 'VP8 ' && head.length >= 30) {
      // a key frame's start code, then 14-bit width and height
      if (head[23] !== 0x9d || head[24] !== 0x01 || head[25] !== 0x2a) return null;
      return found('image/webp', head.readUInt16LE(26) & 0x3fff, head.readUInt16LE(28) & 0x3fff);
    }
    if (chunk === 'VP8L' && head.length >= 25) {
      // the signature byte, then width - 1 and height - 1 in 14 bits each
      if (head[20] !== 0x2f) return null;
      const bits = head.readUInt32LE(21);
      return found('image/webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (chunk === 'VP8X' && head.length >= 30) {
      // flags and reserved bytes, then the canvas's width - 1 and height - 1 in 24 bits each
      return found('image/webp', head.readUIntLE(24, 3) + 1, head.readUIntLE(27, 3) + 1);
    }
    return null;
  }
  // JPEG: the start-of-image marker, then segments up to the frame header
  if (head.length >= 4 && head[0] === 0xff && head[1] === 0xd8) return jpegSize(read);
  return null;
}

/** Walks a JPEG's segments by their lengths, from just after its start-of-image marker, to the frame header. */
async function jpegSize(read: Read): Promise<ImageInfo | null> {
  let pos = 2;
  for (let n = 0; n < JPEG_SEGMENT_CAP; n++) {
    const b = await read(pos, 16);
    if (b.length < 2 || b[0] !== 0xff) return null;
    // a marker may be padded with any number of 0xFF fill bytes
    let i = 1;
    while (i < b.length - 1 && b[i] === 0xff) i++;
    const marker = b[i];
    if (marker === 0xff) return null;
    pos += i + 1;
    // markers that stand alone, with no length after them
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    // the image ends, or its scan starts, before any frame header; 0x00 is never a marker
    if (marker === 0xd8 || marker === 0xd9 || marker === 0xda || marker === 0x00) return null;
    const seg = await read(pos, 7);
    if (seg.length < 2) return null;
    const len = seg.readUInt16BE(0);
    if (len < 2) return null;
    if (JPEG_SOF.has(marker)) {
      // length, sample precision, then height and width
      if (len < 7 || seg.length < 7) return null;
      return found('image/jpeg', seg.readUInt16BE(5), seg.readUInt16BE(3));
    }
    pos += len;
  }
  return null;
}

/** The type and size of the image file at `path`, or null when it isn't a PNG, JPEG or WebP. */
export async function imageInfo(path: string): Promise<ImageInfo | null> {
  const fh = await open(path, 'r');
  try {
    return await sniff(async (pos, len) => {
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      return buf.subarray(0, bytesRead);
    });
  } finally {
    await fh.close();
  }
}

/** The same, for an image already in memory. */
export function imageInfoOf(data: Buffer): Promise<ImageInfo | null> {
  return sniff(async (pos, len) => data.subarray(pos, pos + len));
}

/** The same, for an upload (spooled to disk, or a small one in memory). */
export function uploadedImageInfo(file: UploadedFile): Promise<ImageInfo | null> {
  if (file.path) return imageInfo(file.path);
  return imageInfoOf(file.data ?? Buffer.alloc(0));
}

const IMAGE_EXT: Record<ThumbMime, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
/** extensions a picture (or something pretending to be one) might carry, replaced by the real one */
const PICTURE_EXT = /\.(png|jpe?g|jfif|pjpeg|webp|gif|svgz?|html?|xhtml|bmp|tiff?|heic|heif|avif|ico)$/i;

/**
 * An upload as it should be stored once its bytes are known: the type they say (the browser's is thrown away) and a
 * file name ending in that type's extension ("Cover.PNG" → "Cover.png", "cover.html" → "cover.png").
 */
export function asImageUpload(file: UploadedFile, info: ImageInfo): UploadedFile {
  const base = storedFileName(file.filename).replace(PICTURE_EXT, '') || 'thumbnail';
  return { ...file, mime: info.mime, filename: storedFileName(`${base}${IMAGE_EXT[info.mime]}`) };
}
