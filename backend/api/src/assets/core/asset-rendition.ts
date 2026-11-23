/** The widths a rendition is made at, in pixels (#242's default). */
export const RENDITION_WIDTHS = [320, 640, 1280] as const;
export type RenditionWidth = (typeof RENDITION_WIDTHS)[number];

/** What every rendition is: WebP. */
export const RENDITION_TYPE = 'image/webp';

/**
 * The image types a rendition is made of. SVG and every other type have
 * none (400 `invalid-parameter`): an SVG is a document, not pixels, and
 * other formats would put more decoders on the request path.
 */
export const RENDITION_SOURCE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

/** A rendition, as recorded: the source and width it was made of, and its own bytes' hash. */
export interface AssetRendition {
  readonly sourceSha256: string;
  readonly width: RenditionWidth;
  /** The SHA-256 of the WebP in the blob store. */
  readonly sha256: string;
  readonly size: number;
  readonly createdAt: Date;
}

export type NewAssetRendition = Omit<AssetRendition, 'createdAt'>;
