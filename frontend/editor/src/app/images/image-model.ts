import type { Item } from '../api';

/** An image of `GET /assets`. */
export type AssetItem = Item<'/assets'>;

const ASSET_REF = /^sha256:([a-f0-9]{64})$/;

/** The hash an image block's `asset` names (`sha256:<hash>`), or null for any other value. */
export function assetHash(asset: string): string | null {
  return ASSET_REF.exec(asset)?.[1] ?? null;
}

/** The image block's size presets: a percentage of the text column each. */
export const SIZE_PRESETS = [
  { id: 'icon', width: 10, label: 'editor.images.size.icon' },
  { id: '30', width: 30, label: 'editor.images.size.30' },
  { id: '50', width: 50, label: 'editor.images.size.50' },
  { id: '75', width: 75, label: 'editor.images.size.75' },
  { id: 'full', width: 100, label: 'editor.images.size.full' },
] as const;

export type SizePreset = (typeof SIZE_PRESETS)[number]['id'];

/** A new image's size. */
export const DEFAULT_PRESET: SizePreset = '50';

/** The preset a width is, or '' for a width no preset gives (kept as it is unless one is chosen). */
export function presetOf(width: number | null): SizePreset | '' {
  return SIZE_PRESETS.find((p) => p.width === width)?.id ?? '';
}

/** The width a preset gives. */
export function widthOf(preset: SizePreset): number {
  return SIZE_PRESETS.find((p) => p.id === preset)?.width ?? 100;
}

/**
 * What a tile is called: images have no file name, so the first module showing it (in `lang`,
 * the module's language, when one there does), else whether it is a fresh upload, else the start
 * of its hash.
 */
export type TileLabel =
  | { readonly kind: 'module'; readonly title: string; readonly more: number }
  | { readonly kind: 'uploaded' }
  | { readonly kind: 'unused'; readonly hash: string };

export function tileLabel(item: AssetItem, lang = ''): TileLabel {
  const first =
    item.meta.usedIn.find((use) => use.lang === lang) ?? item.meta.usedIn[0];
  if (first)
    return {
      kind: 'module',
      title: first.title || first.moduleId,
      more: Math.max(0, item.meta.usedInCount - 1),
    };
  if (item.meta.uploaded) return { kind: 'uploaded' };
  return { kind: 'unused', hash: item.id.slice(0, 12) };
}

/** A media type's short name: `PNG`, `JPEG`, `SVG`…; null when there is none. */
export function typeName(
  contentType: string | null | undefined,
): string | null {
  if (!contentType) return null;
  const sub = contentType.split('/')[1]?.split(/[+;]/)[0] ?? '';
  return sub ? sub.toUpperCase() : null;
}

/** The query `filter[q]` takes: trimmed, at most 200 characters; empty when there is none. */
export function searchQuery(typed: string): string {
  return typed.trim().slice(0, 200).trim();
}

/**
 * The image types shown from an object URL. Never SVG: a `blob:` URL is a document of the
 * editor's own origin without the API's sandbox, and an SVG opened from it ("Open image in new
 * tab") would run its script there.
 */
export const SHOWN_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
]);

/** The types the upload takes (the API takes the same). */
export const UPLOAD_TYPES: readonly string[] = ['image/png', 'image/jpeg'];
