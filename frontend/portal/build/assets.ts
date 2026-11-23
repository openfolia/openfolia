import { createHash } from 'node:crypto';
import sharp from 'sharp';

/**
 * Files a site serves are written so that none can run at the site's origin, whatever a static
 * host's headers are: the build cannot rely on the API's sandboxing headers once the files are
 * copied. Images keep their raster formats; an SVG (a document that can hold scripts) is drawn
 * to a PNG; an attached file keeps a plain type's extension only when its bytes are not markup,
 * else it is written as `.bin` (served as `application/octet-stream`, which browsers download).
 */
export class AssetError extends Error {}

/**
 * Bytes the API served under a hash they do not have: the content changed under the build, or
 * the store is corrupt. Not an `AssetError` (a file the site leaves out): it fails the build.
 */
export class HashMismatchError extends Error {}

export interface WrittenAsset {
  /** The file name under `assets/`. */
  readonly file: string;
  readonly bytes: Uint8Array;
}

const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

type Raster = 'png' | 'jpg' | 'gif' | 'webp';

function rasterType(bytes: Uint8Array): Raster | undefined {
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38)
    return 'gif';
  if (
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  )
    return 'webp';
  return undefined;
}

/** Bytes that a browser could take for a document: HTML, XML, SVG (after any BOM and whitespace). */
export function looksLikeMarkup(bytes: Uint8Array): boolean {
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, 1024))
    .replace(/^\uFEFF/, '')
    .split(String.fromCharCode(0))
    .join('')
    .trimStart();
  return head.startsWith('<');
}

/**
 * An SVG drawn to a PNG. The artwork may reach nothing outside itself: one with a DOCTYPE or
 * entity (XML's way to read files), or a reference that is not a fragment of its own
 * (`href="#…"`), is refused rather than drawn.
 */
export async function rasteriseSvg(bytes: Uint8Array): Promise<Uint8Array> {
  // UTF-8 only: in another encoding the checks below would not see what the XML parser reads.
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new AssetError('an SVG that is not UTF-8');
  }
  if (text.includes('\u0000')) throw new AssetError('an SVG that is not UTF-8');
  if (/<!DOCTYPE|<!ENTITY/i.test(text))
    throw new AssetError('an SVG with a DOCTYPE or an entity');
  if (
    /\b(?:xlink:)?href\s*=\s*["']?(?!#)/i.test(text) ||
    /url\(\s*["']?(?!#)/i.test(text)
  )
    throw new AssetError('an SVG referring to another file');
  try {
    return new Uint8Array(
      await sharp(Buffer.from(bytes), {
        density: 192,
        // Symbols and figures, not posters: a huge canvas is refused, not drawn.
        limitInputPixels: 4096 * 4096,
      })
        .png()
        .toBuffer(),
    );
  } catch {
    throw new AssetError(
      'an SVG that cannot be drawn (too large, or not an image)',
    );
  }
}

/** An image block's file, checked against its hash. */
export async function imageAsset(
  hash: string,
  bytes: Uint8Array,
): Promise<WrittenAsset> {
  if (sha256(bytes) !== hash)
    throw new HashMismatchError(
      `image ${hash}: the bytes do not match the hash`,
    );
  const raster = rasterType(bytes);
  if (raster !== undefined) return { file: `${hash}.${raster}`, bytes };
  if (looksLikeMarkup(bytes))
    return { file: `${hash}.png`, bytes: await rasteriseSvg(bytes) };
  throw new AssetError(`image ${hash}: not a PNG, JPEG, GIF, WebP or SVG`);
}

/** A safety symbol's artwork, always a raster image, named by its own hash. */
export async function symbolAsset(
  id: string,
  bytes: Uint8Array,
): Promise<WrittenAsset> {
  const raster = rasterType(bytes);
  const out =
    raster !== undefined
      ? bytes
      : looksLikeMarkup(bytes)
        ? await rasteriseSvg(bytes)
        : undefined;
  if (out === undefined) throw new AssetError(`symbol ${id}: not an image`);
  return { file: `${sha256(out)}.${raster ?? 'png'}`, bytes: out };
}

const PLAIN: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/json': 'json',
  'text/csv': 'csv',
  'text/plain': 'txt',
};

/** An attached file, checked against its hash: a plain type's extension, else `.bin`. */
export function attachmentAsset(
  hash: string,
  bytes: Uint8Array,
  mediaType: string | undefined,
): WrittenAsset {
  if (sha256(bytes) !== hash)
    throw new HashMismatchError(
      `attachment ${hash}: the bytes do not match the hash`,
    );
  const raster = rasterType(bytes);
  if (raster !== undefined) return { file: `${hash}.${raster}`, bytes };
  const ext = mediaType === undefined ? undefined : PLAIN[mediaType];
  const safe =
    ext === 'pdf'
      ? new TextDecoder().decode(bytes.subarray(0, 5)) === '%PDF-'
      : ext === 'zip'
        ? bytes[0] === 0x50 && bytes[1] === 0x4b
        : ext !== undefined && !looksLikeMarkup(bytes);
  return { file: `${hash}.${safe ? ext : 'bin'}`, bytes };
}

/**
 * A branding image (#784, `GET /branding/images/{hash}`), checked against its hash: a PNG or a
 * WebP only, as the API takes them; anything else is an `AssetError` (the default image shows).
 */
export function brandingImageAsset(
  hash: string,
  bytes: Uint8Array,
): WrittenAsset {
  if (sha256(bytes) !== hash)
    throw new HashMismatchError(
      `branding image ${hash}: the bytes do not match the hash`,
    );
  const raster = rasterType(bytes);
  if (raster !== 'png' && raster !== 'webp')
    throw new AssetError(`branding image ${hash}: not a PNG or WebP`);
  return { file: `${hash}.${raster}`, bytes };
}

/** A release's rendered PDF, checked against its hash and its first bytes. */
export function pdfAsset(hash: string, bytes: Uint8Array): WrittenAsset {
  if (sha256(bytes) !== hash)
    throw new HashMismatchError(`PDF ${hash}: the bytes do not match the hash`);
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-')
    throw new AssetError(`PDF ${hash}: not a PDF`);
  return { file: `${hash}.pdf`, bytes };
}
