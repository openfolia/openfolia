import type { ReleaseOutput } from '../../releases/core/release-output.js';

/** The media type of an iiRDS package (its ZIP), as the standard names it. */
export const IIRDS_MEDIA_TYPE = 'application/iirds+zip';

/**
 * What a package made leaves out or could not map (#431): a warning of the
 * export, never a silent drop. `id` names the thing (a module type, an
 * audience, a facet, a facet value, a variant attribute, an asset).
 */
export interface IirdsWarning {
  readonly code:
    | 'unmapped-module-type'
    | 'unmapped-audience'
    | 'unmapped-facet'
    | 'unmapped-variant-attribute'
    | 'unmapped-lifecycle-phase'
    | 'missing-asset'
    | 'pdf-not-included'
    | 'manual-empty';
  readonly id: string;
  readonly detail: string;
}

/**
 * One file of a package: bytes made for it, a blob of the blob store
 * streamed when its turn comes, or a file of the repository read again
 * when its turn comes (`load`; never held between requests).
 */
export type IirdsFile =
  | { readonly name: string; readonly size: number; readonly bytes: Uint8Array }
  | { readonly name: string; readonly size: number; readonly blob: string }
  | {
      readonly name: string;
      readonly size: number;
      readonly load: () => Promise<Uint8Array>;
    };

/**
 * A package as it is made (`IirdsPlans`): its files in their
 * order in the ZIP (`mimetype` first), what it left out, and its name. The
 * same release output always makes the same plan, so the same bytes.
 */
export interface IirdsPlan {
  readonly files: readonly IirdsFile[];
  readonly warnings: readonly IirdsWarning[];
  /** How many topics (modules) and media files it holds; whether its PDF is in it. */
  readonly topics: number;
  readonly media: number;
  readonly pdf: boolean;
}

/**
 * The name a package downloads as: the output's file name with the
 * extension the standard requires, `.iirds`
 * (`operating_model-small_en_2.1.iirds`).
 */
export function iirdsFileName(
  output: Pick<ReleaseOutput, 'manualId' | 'variant' | 'lang'>,
  revision: string,
): string {
  const part = (text: string) => text.replace(/[^A-Za-z0-9.-]+/g, '-');
  return `${[output.manualId, output.variant, output.lang, revision].map(part).join('_')}.iirds`;
}

/**
 * A part of an IRI made under the base IRI: percent-encoded as a URI
 * component (so a variant slug's `=` and `,` and anything else but
 * letters, digits and `-_.!~*'()` are escapes), never empty and never
 * `.` or `..` (their dots escaped too), so no consumer resolves it away.
 */
export function iriSegment(text: string): string {
  if (text === '') return '-';
  if (/^\.+$/.test(text)) return text.replaceAll('.', '%2E');
  return encodeURIComponent(text);
}

/** A media file's extension, from its stored type; `.bin` for a type not listed. */
export function mediaExtension(type: string): string {
  return Object.hasOwn(MEDIA_EXTENSIONS, type)
    ? (MEDIA_EXTENSIONS[type] as string)
    : '.bin';
}

const MEDIA_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    '.pptx',
  'application/vnd.oasis.opendocument.text': '.odt',
  'application/vnd.oasis.opendocument.spreadsheet': '.ods',
  'application/xml': '.xml',
  'text/xml': '.xml',
  'image/tiff': '.tif',
  'application/zip': '.zip',
  'application/json': '.json',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'video/mp4': '.mp4',
  'audio/mpeg': '.mp3',
};
