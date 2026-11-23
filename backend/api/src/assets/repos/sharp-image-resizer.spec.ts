import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { SharpImageResizer } from './sharp-image-resizer.js';

const resizer = new SharpImageResizer({
  maxPixels: 40_000_000,
  timeoutMs: 10_000,
});

const picture = (format: 'png' | 'jpeg' | 'gif' | 'webp' | 'tiff') =>
  sharp({
    create: {
      width: 800,
      height: 400,
      channels: 3,
      background: { r: 200, g: 40, b: 40 },
    },
  })
    .toFormat(format)
    .toBuffer();

describe('SharpImageResizer', () => {
  it.each(['png', 'jpeg', 'gif', 'webp'] as const)(
    'makes a WebP rendition of a %s',
    async (format) => {
      const out = await resizer.toWebp(await picture(format), 320);
      const meta = await sharp(out).metadata();
      expect(meta).toMatchObject({ format: 'webp', width: 320, height: 160 });
    },
  );

  it('decodes no other format, whatever it is', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
    );
    for (const source of [svg, await picture('tiff')]) {
      await expect(resizer.toWebp(source, 320)).rejects.toMatchObject({
        code: 'unprocessable-image',
      });
    }
  });

  it('refuses more pixels than the limit, from the header', async () => {
    const small = new SharpImageResizer({ maxPixels: 1000, timeoutMs: 10_000 });
    await expect(small.toWebp(await picture('png'), 320)).rejects.toMatchObject(
      { code: 'too-large' },
    );
  });

  it('times out as a 503, and only once libvips has stopped', async () => {
    const hasty = new SharpImageResizer({
      maxPixels: 40_000_000,
      timeoutMs: 1,
    });
    const big = await sharp({
      create: {
        width: 3000,
        height: 3000,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
        noise: { type: 'gaussian', mean: 128, sigma: 30 },
      },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    await expect(hasty.toWebp(big, 1280)).rejects.toMatchObject({
      code: 'rendition-timeout',
    });
    // Its slot is free only now: nothing of it is still decoding.
    expect(sharp.counters()).toEqual({ queue: 0, process: 0 });
  });
});
