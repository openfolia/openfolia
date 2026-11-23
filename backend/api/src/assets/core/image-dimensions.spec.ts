import { imageDimensions } from './image-dimensions.js';

/** A real 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** A PNG header stating `width`×`height`. */
function png(width: number, height: number): Buffer {
  const data = Buffer.from(PNG);
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

/** A JPEG: an APP0 segment of `app0` bytes, then a frame header (`sof`) of `width`×`height`. */
function jpeg(width: number, height: number, sof = 0xc0, app0 = 16): Buffer {
  const app = Buffer.alloc(2 + app0);
  app.writeUInt16BE(0xffe0, 0);
  app.writeUInt16BE(app0, 2);
  const frame = Buffer.from([0xff, sof, 0, 17, 8, 0, 0, 0, 0, 3]);
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app, frame]);
}

describe('imageDimensions', () => {
  it('reads a PNG’s IHDR', () => {
    expect(imageDimensions(PNG)).toEqual({ width: 1, height: 1 });
    expect(imageDimensions(png(1920, 1080))).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it('reads a JPEG’s first frame header, past other segments and fill bytes', () => {
    expect(imageDimensions(jpeg(640, 480))).toEqual({
      width: 640,
      height: 480,
    });
    expect(imageDimensions(jpeg(800, 600, 0xc2, 4000))).toEqual({
      width: 800,
      height: 600,
    });
    const filled = jpeg(10, 20);
    const withFill = Buffer.concat([
      filled.subarray(0, 2),
      Buffer.from([0xff, 0xff]),
      filled.subarray(2),
    ]);
    expect(imageDimensions(withFill)).toEqual({ width: 10, height: 20 });
  });

  it('does not take a DHT or DAC segment for a frame header', () => {
    for (const marker of [0xc4, 0xcc]) {
      expect(imageDimensions(jpeg(10, 20, marker))).toBeUndefined();
    }
  });

  it('reads GIF and WebP headers', () => {
    const gif = Buffer.from('GIF89a\x40\x01\xf0\x00', 'latin1');
    expect(imageDimensions(gif)).toEqual({ width: 320, height: 240 });
    const vp8x = Buffer.alloc(30);
    vp8x.write('RIFF', 0, 'latin1');
    vp8x.write('WEBPVP8X', 8, 'latin1');
    vp8x.writeUIntLE(99, 24, 3);
    vp8x.writeUIntLE(49, 27, 3);
    expect(imageDimensions(vp8x)).toEqual({ width: 100, height: 50 });
  });

  it('gives none for an SVG, a cut-off header or a zero size', () => {
    expect(imageDimensions(Buffer.from('<svg></svg>'))).toBeUndefined();
    expect(imageDimensions(PNG.subarray(0, 20))).toBeUndefined();
    expect(imageDimensions(jpeg(640, 480).subarray(0, 25))).toBeUndefined();
    expect(imageDimensions(png(0, 10))).toBeUndefined();
    expect(imageDimensions(new Uint8Array())).toBeUndefined();
  });
});
