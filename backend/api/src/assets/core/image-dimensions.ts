/** An image's size in pixels, as its header states it. */
export interface Dimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * The width and height an image's header states, from its first bytes:
 * PNG (`IHDR`), JPEG (the first frame header), GIF and WebP. `undefined`
 * for anything else (an SVG has no pixel size), for a header not within
 * `head` yet, and for a header stating zero. A JPEG's EXIF orientation is
 * not applied: this is the size as stored.
 */
export function imageDimensions(head: Uint8Array): Dimensions | undefined {
  const data = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  const found = png(data) ?? jpeg(data) ?? gif(data) ?? webp(data);
  return found && found.width > 0 && found.height > 0 ? found : undefined;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function png(data: Buffer): Dimensions | undefined {
  if (data.length < 24 || !data.subarray(0, 8).equals(PNG)) return undefined;
  if (data.subarray(12, 16).toString('latin1') !== 'IHDR') return undefined;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

/** Start-of-frame markers: every `C0`–`CF` but `C4` (DHT), `C8` (reserved) and `CC` (DAC). */
const isFrameHeader = (marker: number): boolean =>
  marker >= 0xc0 &&
  marker <= 0xcf &&
  marker !== 0xc4 &&
  marker !== 0xc8 &&
  marker !== 0xcc;

function jpeg(data: Buffer): Dimensions | undefined {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return undefined;
  let at = 2;
  while (at + 4 <= data.length) {
    if (data[at] !== 0xff) return undefined;
    const marker = data[at + 1] ?? 0;
    // Fill bytes before a marker.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    // Markers without a length: TEM, RST0–7.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    // Start of scan or end of image before a frame header: none to find.
    if (marker === 0xda || marker === 0xd9) return undefined;
    const length = data.readUInt16BE(at + 2);
    if (length < 2) return undefined;
    if (isFrameHeader(marker)) {
      if (at + 9 > data.length) return undefined;
      return {
        height: data.readUInt16BE(at + 5),
        width: data.readUInt16BE(at + 7),
      };
    }
    at += 2 + length;
  }
  return undefined;
}

function gif(data: Buffer): Dimensions | undefined {
  if (data.length < 10 || data.subarray(0, 4).toString('latin1') !== 'GIF8') {
    return undefined;
  }
  return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
}

function webp(data: Buffer): Dimensions | undefined {
  if (
    data.length < 30 ||
    data.subarray(0, 4).toString('latin1') !== 'RIFF' ||
    data.subarray(8, 12).toString('latin1') !== 'WEBP'
  ) {
    return undefined;
  }
  const chunk = data.subarray(12, 16).toString('latin1');
  if (chunk === 'VP8X') {
    return {
      width: data.readUIntLE(24, 3) + 1,
      height: data.readUIntLE(27, 3) + 1,
    };
  }
  if (chunk === 'VP8L' && data[20] === 0x2f) {
    const bits = data.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8 ') {
    return {
      width: data.readUInt16LE(26) & 0x3fff,
      height: data.readUInt16LE(28) & 0x3fff,
    };
  }
  return undefined;
}
