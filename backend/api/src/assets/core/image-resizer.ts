/**
 * Port: makes a rendition of an image. The adapter (`SharpImageResizer`)
 * decodes only the `RENDITION_SOURCE_TYPES`, and bounds the work: at most
 * a configured number of source pixels (checked from the header before
 * decoding, and by the decoder), a timeout, and an output of at most the
 * asked width and four times that height (never upscaled).
 */
export abstract class ImageResizer {
  /**
   * The image as WebP, at most `width` pixels wide. Throws
   * `UnprocessableError` `too-large` for more source pixels than allowed
   * (`meta.maxPixels`) and `unprocessable-image` for bytes it cannot
   * decode or a decoding that took too long.
   */
  abstract toWebp(source: Uint8Array, width: number): Promise<Uint8Array>;
}
