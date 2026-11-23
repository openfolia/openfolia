/** One still picture, an animation, or no well-formed PNG or WebP (`imageFrames`). */
export type ImageFrames = 'still' | 'animated' | 'malformed';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_ANIMATION = new Set(['acTL', 'fcTL', 'fdAT']);
const WEBP_ANIMATION = new Set(['ANIM', 'ANMF']);
/** The animation flag in the first byte of `VP8X`'s data. */
const VP8X_ANIMATION = 0x02;

/**
 * Whether a whole PNG or WebP file is one still picture, an animation, or
 * not well formed: its chunks walked to the end, none read past it.
 *
 * - **PNG:** chunk after chunk up to `IEND`; an animation control or frame
 *   chunk (`acTL`, `fcTL`, `fdAT`: an APNG) anywhere is `animated`. A chunk
 *   running past the end, or no `IEND`, is `malformed`.
 * - **WebP:** the RIFF container's chunks up to its stated size; the
 *   animation flag of `VP8X`, or an `ANIM` or `ANMF` chunk, is `animated`.
 *   A container larger than the file, or a chunk running past it, is
 *   `malformed`.
 *
 * Any other type is `malformed`. A pixel limit checked on the header holds
 * per frame only; an animation multiplies it, so callers refusing large
 * images refuse animations too.
 */
export function imageFrames(bytes: Uint8Array): ImageFrames {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.length >= 8 && data.subarray(0, 8).equals(PNG)) return png(data);
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('latin1') === 'RIFF' &&
    data.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return webp(data);
  }
  return 'malformed';
}

function png(data: Buffer): ImageFrames {
  let at = 8;
  // Length (4), type (4), data, CRC (4).
  while (at + 12 <= data.length) {
    const length = data.readUInt32BE(at);
    const type = data.subarray(at + 4, at + 8).toString('latin1');
    const end = at + 12 + length;
    if (end > data.length) return 'malformed';
    if (PNG_ANIMATION.has(type)) return 'animated';
    if (type === 'IEND') return 'still';
    at = end;
  }
  return 'malformed';
}

function webp(data: Buffer): ImageFrames {
  const end = 8 + data.readUInt32LE(4);
  if (end > data.length) return 'malformed';
  let at = 12;
  // FourCC (4), size (4, little-endian), data padded to an even length.
  while (at + 8 <= end) {
    const type = data.subarray(at, at + 4).toString('latin1');
    const size = data.readUInt32LE(at + 4);
    if (at + 8 + size > end) return 'malformed';
    if (WEBP_ANIMATION.has(type)) return 'animated';
    if (
      type === 'VP8X' &&
      size > 0 &&
      ((data[at + 8] ?? 0) & VP8X_ANIMATION) !== 0
    ) {
      return 'animated';
    }
    at += 8 + size + (size & 1);
  }
  return 'still';
}
