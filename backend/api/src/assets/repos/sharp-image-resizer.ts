import { Logger } from '@nestjs/common';
import sharp from 'sharp';
import {
  UnavailableError,
  UnprocessableError,
} from '../../base/core/errors.js';
import { imageDimensions } from '../core/image-dimensions.js';
import { ImageResizer } from '../core/image-resizer.js';

/**
 * The libvips loaders a rendition may use: PNG, JPEG, GIF and WebP, from
 * memory. libvips reads GIF with its own decoder (`Nsgif`); the name of
 * libvips' older giflib loader is kept for builds that have that one.
 */
const LOADERS = [
  'VipsForeignLoadPngBuffer',
  'VipsForeignLoadJpegBuffer',
  'VipsForeignLoadNsgifBuffer',
  'VipsForeignLoadGifBuffer',
  'VipsForeignLoadWebpBuffer',
];

let blocked = false;

/**
 * Every libvips loader but `LOADERS` is blocked for the whole process
 * (sharp's `block` is global), so SVG (librsvg), TIFF, HEIF, PDF and the
 * rest never decode, whatever bytes arrive and whatever they claim to be.
 */
function blockOtherLoaders(): void {
  if (blocked) return;
  sharp.block({ operation: ['VipsForeignLoad'] });
  sharp.unblock({ operation: LOADERS });
  // Memory, not speed: no cache of decoded images between requests.
  sharp.cache(false);
  // One libvips thread per image: a rendition never takes every core
  // (how many are made at once is `CCMS_RENDITION_CONCURRENCY`).
  sharp.concurrency(1);
  blocked = true;
}

export interface ResizeLimits {
  /** The most pixels (width × height) a source may have. */
  readonly maxPixels: number;
  /** How long one rendition may take to decode and encode, in milliseconds. */
  readonly timeoutMs: number;
}

/** A rendition is at most this many times as tall as it is wide (a very tall image is narrower). */
const MAX_ASPECT = 4;

/**
 * `ImageResizer` with sharp (libvips). Bounded before and during decoding:
 * the header's pixel count is checked first (no decoding past the limit),
 * then libvips' own `limitInputPixels` holds it for what the header did not
 * say; only the first frame of an animation is read; EXIF orientation is
 * applied; metadata is not copied. libvips' timeout and a timer of its own
 * end a rendition that takes too long.
 */
export class SharpImageResizer extends ImageResizer {
  private readonly logger = new Logger('Renditions');

  constructor(private readonly limits: ResizeLimits) {
    super();
    blockOtherLoaders();
  }

  async toWebp(source: Uint8Array, width: number): Promise<Uint8Array> {
    const stated = imageDimensions(source.subarray(0, 256 * 1024));
    if (stated && stated.width * stated.height > this.limits.maxPixels) {
      throw this.tooLarge();
    }
    const work = sharp(source, {
      limitInputPixels: this.limits.maxPixels,
      failOn: 'error',
      animated: false,
      pages: 1,
      sequentialRead: true,
    })
      .rotate()
      .resize({
        width,
        height: width * MAX_ASPECT,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 80, effort: 4 })
      // libvips' own timeout ends the work itself, no later than ours.
      .timeout({
        seconds: Math.max(1, Math.floor(this.limits.timeoutMs / 1000)),
      })
      .toBuffer();
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('timed out')),
        this.limits.timeoutMs,
      );
    });
    try {
      const out = await Promise.race([work, late]);
      return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    } catch (error) {
      // libvips may still be at work after our timer: its result is
      // dropped, but the caller (and its concurrency slot) waits until
      // it stopped, so slow decodes never pile up past the slots.
      await work.catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      if (/pixel limit/i.test(message)) throw this.tooLarge();
      // Too slow may be a busy machine, not the image: not remembered as failed.
      if (/timed? ?out|timeout/i.test(message)) {
        this.logger.warn(`A rendition timed out: ${message}`);
        throw new UnavailableError(
          'rendition-timeout',
          'The rendition took too long; try again later or use the original.',
          30,
        );
      }
      this.logger.warn(`A rendition failed: ${message}`);
      throw new UnprocessableError(
        'unprocessable-image',
        'The image cannot be decoded within the limits; use the original.',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private tooLarge(): UnprocessableError {
    return new UnprocessableError(
      'too-large',
      `The image has more than ${this.limits.maxPixels} pixels; use the original.`,
      { maxPixels: this.limits.maxPixels },
    );
  }
}
