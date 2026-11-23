import type { CoverImageAlt, Manifest, ManifestEntry } from './manifest.js';
import {
  type LocalizedText,
  ownTextIn,
  sourceTextOf,
} from './localized-text.js';
import { sha256Hex } from './sha256.js';
import type { TranslatableUnit } from './translatable-units.js';
import type { VariantValues } from './variant.js';
import { variantSlug } from './variant-slug.js';

/**
 * A translatable unit of a manifest, in the source language, its `blockId` the unit key
 * (`ManifestUnitKey`), one text run of plain text: its title and each group's title (#731, as a
 * section's `title` part), a cover image's alternative text (#656, as an image block's `alt`
 * part).
 */
export interface ManifestUnit extends TranslatableUnit {
  readonly kind: 'section' | 'image';
  /** The variant whose own cover image it is; none for the manual's (`coverImage.default`). */
  readonly variant?: VariantValues;
}

/** The unit key of the manual's title (#731). */
export const TITLE_UNIT = 'title';

/** The unit key of the manual's own cover image's alternative text. */
export const DEFAULT_COVER_UNIT = 'coverImage.default';

/**
 * The unit key of a group's title (#731): `group.` and the first 12 hex digits of the SHA-256 of
 * its title in the source language (NFC), the same wherever the group stands; two groups of the
 * same title share it.
 */
export function groupUnitKey(sourceTitle: string): string {
  return `group.${sha256Hex(sourceTitle.normalize('NFC')).slice(0, 12)}`;
}

/**
 * The unit key of a cover image's alternative text (`ManifestUnitKey`): the manual's own
 * (`coverImage.default`), or a variant's (`coverImage.variant-` and the first 12 hex digits of
 * the SHA-256 of its `variantSlug`, the same whatever the order of its attributes or of the
 * manifest's entries).
 */
export function coverUnitKey(variant?: VariantValues): string {
  return variant === undefined
    ? DEFAULT_COVER_UNIT
    : `coverImage.variant-${sha256Hex(variantSlug(variant)).slice(0, 12)}`;
}

/** An alternative text in the source language: the one for every language, else the source's own. */
export const coverAltSource: (
  alt: CoverImageAlt,
  source: string,
) => string | undefined = sourceTextOf;

/**
 * An alternative text's own version in `lang` (a target language): none when it takes the
 * source language's (one text for every language, or none written for `lang`).
 */
export const coverAltOwn: (
  alt: CoverImageAlt,
  lang: string,
  source: string,
) => string | undefined = ownTextIn;

/**
 * A manifest's cover images with their unit key: the manual's, then each variant's (the first
 * entry for a variant only, as resolving takes it).
 */
export function coverEntries(
  manifest: Pick<Manifest, 'coverImage'>,
): { key: string; alt: CoverImageAlt; variant?: VariantValues }[] {
  const cover = manifest.coverImage;
  if (!cover) return [];
  const found: { key: string; alt: CoverImageAlt; variant?: VariantValues }[] =
    [];
  if (cover.default) {
    found.push({ key: DEFAULT_COVER_UNIT, alt: cover.default.alt });
  }
  const seen = new Set<string>();
  for (const entry of cover.variants) {
    const key = coverUnitKey(entry.variant);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ key, alt: entry.alt, variant: entry.variant });
  }
  return found;
}

/** The groups of `entries`, outer first, in document order. */
export function manifestGroups(
  entries: readonly ManifestEntry[],
): Extract<ManifestEntry, { entries: ManifestEntry[] }>[] {
  const found: Extract<ManifestEntry, { entries: ManifestEntry[] }>[] = [];
  const visit = (list: readonly ManifestEntry[]) => {
    for (const entry of list) {
      if (!('entries' in entry)) continue;
      found.push(entry);
      visit(entry.entries);
    }
  };
  visit(entries);
  return found;
}

/** One translatable text of a manifest with its unit key: the title, a group's, a cover's. */
export interface ManifestText {
  readonly key: string;
  readonly text: LocalizedText;
  readonly kind: 'title' | 'group' | 'cover';
  /** For a variant's cover image: its variant. */
  readonly variant?: VariantValues;
}

/**
 * A manifest's translatable texts in order, each key once: its title, its groups' titles (in
 * document order; a group whose title has no source-language text has no key, and a later
 * group of an earlier one's title shares its key), then its cover images' alternative text
 * (`coverEntries`).
 */
export function manifestTexts(
  manifest: Pick<Manifest, 'title' | 'entries' | 'coverImage'>,
  source: string,
): ManifestText[] {
  const texts: ManifestText[] = [
    { key: TITLE_UNIT, text: manifest.title, kind: 'title' },
  ];
  const seen = new Set<string>();
  for (const group of manifestGroups(manifest.entries)) {
    const title = sourceTextOf(group.title, source);
    if (title === undefined) continue;
    const key = groupUnitKey(title);
    if (seen.has(key)) continue;
    seen.add(key);
    texts.push({ key, text: group.title, kind: 'group' });
  }
  for (const { key, alt, variant } of coverEntries(manifest)) {
    texts.push({
      key,
      text: alt,
      kind: 'cover',
      ...(variant !== undefined && { variant }),
    });
  }
  return texts;
}

/**
 * The translatable units of a manifest, in the source language `source`: its title and its
 * groups' titles (#731), each as a section's `title` part, then the alternative text of the
 * manual's own cover image and of each variant's (#656, `coverEntries`), each as an image's `alt`
 * part. A text without source text has none (`missing-source-text` and `missing-cover-alt`
 * report it). Text attributes are not translated here.
 */
export function manifestUnits(
  manifest: Pick<Manifest, 'title' | 'entries' | 'coverImage'>,
  source: string,
): ManifestUnit[] {
  return manifestTexts(manifest, source).flatMap(
    ({ key, text, kind, variant }) => {
      const value = sourceTextOf(text, source);
      if (value === undefined) return [];
      const run = [{ type: 'text' as const, text: value }];
      return [
        kind === 'cover'
          ? {
              blockId: key,
              kind: 'image' as const,
              parts: [{ field: 'alt' as const, content: run }],
              ...(variant !== undefined && { variant }),
            }
          : {
              blockId: key,
              kind: 'section' as const,
              parts: [{ field: 'title' as const, content: run }],
            },
      ];
    },
  );
}
