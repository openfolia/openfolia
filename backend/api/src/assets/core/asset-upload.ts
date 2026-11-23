import type { ChangeSetAuthor } from '../../change-sets/core/change-set.js';
import { sniffImageType } from './sniff-image-type.js';

/**
 * The image types an upload may be, decided from the file's first bytes
 * (`acceptedUploadType`), never from a name or a client's claim. SVG is
 * refused: it is a document that can hold scripts, event handlers and
 * references to other files, which no upload should carry (README,
 * "Assets").
 */
export const UPLOAD_TYPES = ['image/png', 'image/jpeg'] as const;
export type UploadType = (typeof UPLOAD_TYPES)[number];

/** How many of the file's first bytes `acceptedUploadType` needs. */
export const SNIFF_BYTES = 16;

/**
 * The upload type of a file starting with `head` (at least `SNIFF_BYTES`
 * of it, or all of a shorter file), or `undefined` for anything else.
 * A PNG must also start with its `IHDR` chunk, as every PNG does.
 */
export function acceptedUploadType(head: Uint8Array): UploadType | undefined {
  const type = sniffImageType(head);
  // FF D8 FF and a marker that opens a JPEG's first segment: APPn, DQT,
  // DHT, a frame header or a comment.
  const marker = head[3] ?? -1;
  if (
    type === 'image/jpeg' &&
    ((marker >= 0xe0 && marker <= 0xef) ||
      (marker >= 0xc0 && marker <= 0xcf) ||
      marker === 0xdb ||
      marker === 0xfe)
  ) {
    return type;
  }
  if (
    type === 'image/png' &&
    Buffer.from(head.subarray(12, 16)).toString('latin1') === 'IHDR'
  ) {
    return type;
  }
  return undefined;
}

/**
 * What an upload is for: an image (PNG or JPEG only, `UPLOAD_TYPES`), an
 * attachment (any type the settings take: `attachment-types.ts`) or a font
 * for a page design (TrueType, OpenType, WOFF or WOFF2, checked by its
 * structure: `font-file.ts`, #555).
 */
export const UPLOAD_KINDS = ['image', 'attachment', 'font'] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];

/**
 * A file uploaded into a change set (an image, or an attachment since
 * #236): one per change set and hash, so uploading the same file again
 * changes nothing. Kept for retention,
 * which must not delete a blob uploaded within its grace period, even
 * while no commit refers to it yet.
 */
export interface AssetUpload {
  readonly changeSetId: string;
  /** The SHA-256 of the stored bytes, 64 lowercase hex characters. */
  readonly sha256: string;
  readonly size: number;
  /** The media type: `UPLOAD_TYPES` for an image, any for an attachment. */
  readonly contentType: string;
  /**
   * The file's name as uploaded, made a `FileName` (`toFileName`); absent
   * when the client sent none that could be kept. The first upload's.
   */
  readonly fileName?: string;
  /** Who uploaded it first (the change set's author). */
  readonly uploadedBy: ChangeSetAuthor;
  /** When it was first uploaded into this change set (the transaction's time). */
  readonly uploadedAt: Date;
  /**
   * When it was last uploaded into this change set: retention keeps the
   * blob for its grace period from then, as that upload handed out the
   * reference again.
   */
  readonly lastUploadedAt: Date;
}

export type NewAssetUpload = Omit<AssetUpload, 'uploadedAt' | 'lastUploadedAt'>;

/** The most files one change set holds, images and attachments together (`too-many-uploads`). */
export const MAX_UPLOADS_PER_CHANGE_SET = 1000;

/**
 * The largest font `CCMS_MAX_FONT_BYTES` may allow (64 MiB): a font is read whole into memory
 * to be checked, and no larger file is read as a font.
 */
export const MAX_FONT_BYTES = 64 * 1024 * 1024;

/** The most fonts one change set holds (`too-many-uploads`, `meta.max`), of its `MAX_UPLOADS_PER_CHANGE_SET` files. */
export const MAX_FONTS_PER_CHANGE_SET = 100;

/** How a module refers to the image: `sha256:<hash>`. */
export const assetReference = (sha256: string): string => `sha256:${sha256}`;
