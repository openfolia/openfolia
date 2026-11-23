import type { AssetItem } from '../images/image-model';

/** A file of `GET /assets?filter[type]=attachment`. */
export type AttachmentItem = AssetItem;

/** Short names people know, for the types whose subtype says nothing readable. */
const NAMES: Readonly<Record<string, string>> = {
  'application/octet-stream': '',
  'application/x-7z-compressed': '7Z',
  'application/x-tar': 'TAR',
  'application/gzip': 'GZIP',
  'text/plain': 'Text',
  'text/tab-separated-values': 'TSV',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'DOCX',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    'PPTX',
  'application/vnd.oasis.opendocument.text': 'ODT',
  'application/vnd.oasis.opendocument.spreadsheet': 'ODS',
};

/**
 * A file type's short name for its facts: `ZIP`, `JSON`, `PDF`, `DOCX`…; null when there is no
 * readable one (`application/octet-stream`, or a long vendor type: the file name says it then).
 */
export function fileTypeName(
  mediaType: string | null | undefined,
): string | null {
  if (!mediaType) return null;
  const type = mediaType.toLowerCase().split(';')[0]?.trim() ?? '';
  if (type in NAMES) return NAMES[type] || null;
  const sub = type.split('/')[1]?.split('+')[0] ?? '';
  return sub && sub.length <= 8 && !sub.startsWith('x-')
    ? sub.toUpperCase()
    : null;
}

/** The name a new attachment starts with: its file name without the extension, spaced. */
export function defaultName(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  return stem.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** What an attachment row is called: its file name, else the start of its hash. */
export function rowName(item: AttachmentItem): string {
  return item.attributes.fileName ?? item.id.slice(0, 12);
}
