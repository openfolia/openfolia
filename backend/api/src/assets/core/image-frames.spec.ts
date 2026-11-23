import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import { imageFrames } from './image-frames.js';

const still = (channels: 3 | 4 = 3) =>
  sharp({
    create: {
      width: 4,
      height: 4,
      channels,
      background: channels === 4 ? '#12345680' : '#123456',
    },
  });

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.byteLength, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

describe('imageFrames', () => {
  it('tells a still PNG and WebP from animated ones', async () => {
    const png = await still().png().toBuffer();
    expect(imageFrames(png)).toBe('still');
    expect(imageFrames(await still(4).webp().toBuffer())).toBe('still');
    expect(imageFrames(await still().webp({ lossless: true }).toBuffer())).toBe(
      'still',
    );
    const control = chunk('acTL', Buffer.alloc(8));
    expect(
      imageFrames(
        Buffer.concat([png.subarray(0, 33), control, png.subarray(33)]),
      ),
    ).toBe('animated');
    // A frame chunk alone, after the image data, is an animation too.
    const end = png.byteLength - 12;
    expect(
      imageFrames(
        Buffer.concat([
          png.subarray(0, end),
          chunk('fdAT', Buffer.alloc(4)),
          png.subarray(end),
        ]),
      ),
    ).toBe('animated');
    const other = await sharp({
      create: { width: 4, height: 4, channels: 3, background: '#654321' },
    })
      .png()
      .toBuffer();
    const animated = await sharp([png, other], { join: { animated: true } })
      .webp()
      .toBuffer();
    expect(imageFrames(animated)).toBe('animated');
  });

  it('finds the animation flag of VP8X however the chunks are laid out', async () => {
    const webp = await still(4).webp().toBuffer();
    expect(webp.subarray(12, 16).toString('latin1')).toBe('VP8X');
    const flagged = Buffer.from(webp);
    flagged[20] = (flagged[20] ?? 0) | 0x02;
    expect(imageFrames(flagged)).toBe('animated');
  });

  it('calls a file cut short, a chunk past the end or another type malformed', async () => {
    const png = await still().png().toBuffer();
    expect(imageFrames(png.subarray(0, png.byteLength - 12))).toBe('malformed');
    const huge = Buffer.from(png);
    huge.writeUInt32BE(0xffffffff, 33);
    expect(imageFrames(huge)).toBe('malformed');
    const webp = await still().webp().toBuffer();
    expect(imageFrames(webp.subarray(0, webp.byteLength - 1))).toBe(
      'malformed',
    );
    const lying = Buffer.from(webp);
    lying.writeUInt32LE(0xfffffff0, 16);
    expect(imageFrames(lying)).toBe('malformed');
    expect(imageFrames(Buffer.from('GIF89a'))).toBe('malformed');
    expect(imageFrames(new Uint8Array())).toBe('malformed');
  });
});
