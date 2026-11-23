const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The image type from the file's first bytes, never from a name or a
 * client's claim; anything unrecognised is `application/octet-stream`.
 */
export function sniffImageType(bytes: Uint8Array): string {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const head = data.subarray(0, 12);
  if (head.subarray(0, 8).equals(PNG)) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return 'image/jpeg';
  }
  if (head.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (
    /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/.test(
      data.subarray(0, 4096).toString('utf8'),
    )
  ) {
    return 'image/svg+xml';
  }
  return 'application/octet-stream';
}

/** What a cover image may be, by its bytes (#394): anything else is left out of the PDF. */
export const COVER_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);
