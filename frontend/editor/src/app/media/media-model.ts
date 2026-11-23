import type { Query } from '../api';
import { fileTypeName } from '../attachments/attachment-model';
import { tileLabel, typeName, type AssetItem } from '../images/image-model';
import {
  idParam,
  intParam,
  oneOfParam,
  textParam,
  type QueryValues,
} from '../view-state';

/** A file of `GET /assets`: an image or an attached file. */
export type MediaItem = AssetItem;

/** The grid's and the table's page sizes; the first is the default. */
export const PAGE_SIZES = [24, 48, 96] as const;

/** The types the type filter offers, as `filter[type]` takes them. */
export const TYPE_FILTERS = [
  'image',
  'attachment',
  'image/png',
  'image/jpeg',
  'image/svg+xml',
  'image/gif',
  'image/webp',
  'application/pdf',
  'application/zip',
] as const;

export type TypeFilter = (typeof TYPE_FILTERS)[number];

const LANG_TAG = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8}){0,3}$/;
const HASH = /^[a-f0-9]{64}$/;

/**
 * The media library's view state, in the address: the view (`grid`, `table`), the filters
 * (`type`, `usage`, `lang`, `q`), the page and its size, and the file whose details are open
 * (`file`, its hash).
 */
export const MEDIA_PARAMS = {
  view: oneOfParam(['grid', 'table'] as const, 'grid'),
  type: oneOfParam(TYPE_FILTERS),
  usage: oneOfParam(['all', 'unused'] as const, 'all'),
  lang: idParam(LANG_TAG),
  q: textParam(),
  page: intParam(1),
  size: intParam(PAGE_SIZES[0], { only: PAGE_SIZES }),
  file: idParam(HASH),
};

export type MediaView = QueryValues<typeof MEDIA_PARAMS>;

/**
 * The query of `GET /assets` for the view. "Unused" lists the files nobody uses
 * (`filter[unused]`), where a language finds nothing, so it is left out; the change set's own
 * uploads come first in the other list (`filter[changeSet]`: its author only).
 */
export function listQuery(
  view: MediaView,
  ownChangeSet: string | null,
): Query<'/assets'> {
  const unused = view.usage === 'unused';
  return {
    ...(view.type ? { 'filter[type]': view.type } : {}),
    ...(view.q ? { 'filter[q]': view.q } : {}),
    ...(unused ? { 'filter[unused]': 'true' as const } : {}),
    ...(!unused && view.lang ? { 'filter[lang]': view.lang } : {}),
    // On the unused list the API would narrow to that change set's uploads (which count as
    // used): it is left out there.
    ...(!unused && ownChangeSet ? { 'filter[changeSet]': ownChangeSet } : {}),
    'page[number]': view.page,
    'page[size]': view.size,
  };
}

/** Whether a file is an image (by its type or how modules use it); an attachment otherwise. */
export function isImage(item: MediaItem): boolean {
  const type = item.attributes.contentType;
  if (type) return type.startsWith('image/');
  return item.meta.usedAs.includes('image');
}

/** The image types the API makes renditions of (`?width=`). */
const RENDITION_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/** Whether the API has renditions of the file: a PNG, JPEG, GIF or WebP image. */
export function hasRenditions(item: MediaItem): boolean {
  return RENDITION_TYPES.has(item.attributes.contentType ?? '');
}

/**
 * What a file is called: its file name (an attachment's, an upload's), else the title of the
 * first module using it (in `lang` when one there does), else the start of its hash.
 */
export function displayName(item: MediaItem, lang = ''): string {
  if (item.attributes.fileName) return item.attributes.fileName;
  const label = tileLabel(item, lang);
  return label.kind === 'module' ? label.title : item.id.slice(0, 12);
}

/** A file's type in short: `PNG`, `ZIP`, `PDF`…; null when there is no readable one. */
export function shortType(item: MediaItem): string | null {
  const type = item.attributes.contentType;
  return isImage(item) ? typeName(type) : fileTypeName(type);
}

/**
 * Whether a file is in use as far as the list says: a module the reader may see uses it. A file of
 * the "unused" list is never; an upload no module shows yet is not either.
 */
export function inUse(item: MediaItem, unusedList: boolean): boolean {
  // A manual's cover image (#394) is in use too.
  return (
    !unusedList &&
    (item.meta.usedInCount > 0 || (item.meta.usedInManuals?.length ?? 0) > 0)
  );
}

/**
 * Whether a file is an upload into the list's change set that no module the reader may see shows
 * yet: the API previews it at the change set (`GET /change-sets/{id}/assets/{hash}`) until one
 * does, and `GET /assets/{hash}` has none of it.
 */
export function freshUpload(item: MediaItem): boolean {
  return item.meta.uploaded && item.meta.usedInCount === 0;
}

/**
 * A picker's paging with its own uploads counted (#690): the insert-image and attach-file
 * dialogs show their uploads first on page 1, before the API lists them. Each upload on its way
 * (no `asset` yet), or done but not among the page's `listed` files, adds one to the API's total;
 * once the list is read again it lists the upload and counts it itself.
 */
export function pageWithUploads<
  P extends { currentPage: number; total: number },
>(
  page: P | null,
  listed: readonly string[],
  uploads: readonly { readonly asset: string | null }[],
): P | null {
  if (!page || page.currentPage !== 1) return page;
  const known = new Set(listed);
  const unlisted = uploads.filter(
    (u) => u.asset === null || !known.has(u.asset),
  ).length;
  return unlisted === 0 ? page : { ...page, total: page.total + unlisted };
}

/** One place a 409 `asset-in-use` names (`meta.usedIn`). */
export interface InUsePlace {
  readonly in: string;
  readonly ref?: string;
}

/** The places a 409 `asset-in-use` names, as far as they are well formed; at most `max`. */
export function inUsePlaces(meta: unknown, max = 3): InUsePlace[] {
  const list = (meta as { usedIn?: unknown } | undefined)?.usedIn;
  if (!Array.isArray(list)) return [];
  const out: InUsePlace[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const place = entry as { in?: unknown; ref?: unknown };
    if (typeof place.in !== 'string') continue;
    const ref = typeof place.ref === 'string' ? place.ref : undefined;
    const key = `${place.in}\n${ref ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref === undefined ? { in: place.in } : { in: place.in, ref });
    if (out.length >= max) break;
  }
  return out;
}

/** The translation key of a place a file is used in (`InUsePlace.in`); keys written out in full. */
export const PLACE_KEYS: Readonly<Record<string, string>> = {
  main: 'editor.media.places.main',
  release: 'editor.media.places.release',
  branch: 'editor.media.places.branch',
  'change-set': 'editor.media.places.changeSet',
  'working-copy': 'editor.media.places.workingCopy',
  'recent-upload': 'editor.media.places.recentUpload',
  rendition: 'editor.media.places.rendition',
  import: 'editor.media.places.import',
  branding: 'editor.media.places.branding',
  'release-output': 'editor.media.places.releaseOutput',
};

/** The upload kind of a file: PNG and JPEG are images (the image route), anything else attached. */
export function uploadKind(file: File): 'image' | 'attachment' {
  return file.type === 'image/png' || file.type === 'image/jpeg'
    ? 'image'
    : 'attachment';
}
