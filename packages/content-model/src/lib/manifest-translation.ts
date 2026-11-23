import type {
  Manifest,
  ManifestEntry,
  ManifestTranslationRecord,
} from './manifest.js';
import {
  coverUnitKey,
  DEFAULT_COVER_UNIT,
  groupUnitKey,
  manifestTexts,
  manifestUnits,
  TITLE_UNIT,
} from './manifest-units.js';
import { type LocalizedText, sourceTextOf } from './localized-text.js';
import {
  compareTexts,
  hasTextIn,
  keptRecord,
  markTextsCurrent,
  recordIn,
} from './text-record.js';
import { sourceHash, type SourceHash } from './translation.js';

type TranslatedParts = Pick<Manifest, 'title' | 'entries' | 'coverImage'>;

/** The source hash of each of a manifest's units, by unit key, in order. */
export function manifestSourceHashes(
  manifest: TranslatedParts,
  source: string,
): Map<string, SourceHash> {
  return new Map(
    manifestUnits(manifest, source).map((unit) => [
      unit.blockId,
      sourceHash(unit),
    ]),
  );
}

/** A manifest's record for `lang`, if it has one. */
export function manifestRecord(
  manifest: Pick<Manifest, 'translations'>,
  lang: string,
): ManifestTranslationRecord | undefined {
  return recordIn(manifest.translations, lang) as
    ManifestTranslationRecord | undefined;
}

/**
 * Each unit of a manifest (`manifestUnits`: its title, its groups' titles, its cover images'
 * alternative text) in `lang`: `missing` where its text has no version of its own in `lang`,
 * `outdated` where it has but the record (`manifest.translations[lang]`) does not name the unit
 * with the hash its source text has now (changed since, or never imported: a text written in the
 * manual builder has no record), else `up-to-date`.
 */
export function compareManifestWithRecord(
  manifest: TranslatedParts & Pick<Manifest, 'translations'>,
  lang: string,
  source: string,
): {
  readonly blockId: string;
  readonly state: 'up-to-date' | 'outdated' | 'missing';
}[] {
  return compareTexts(
    manifestUnits(manifest, source),
    manifestTexts(manifest, source),
    manifestRecord(manifest, lang),
    lang,
    source,
  );
}

/** Whether some text of the manifest (title, group, cover image) has a version of its own in `lang`. */
export function hasManifestTranslation(
  manifest: TranslatedParts,
  lang: string,
  source: string,
): boolean {
  return hasTextIn(manifestTexts(manifest, source), lang, source);
}

/** One imported unit of a manifest: its translated text and the hash it was exported with. */
export interface ManifestUnitImport {
  readonly text: string;
  readonly hash: string;
}

/**
 * `manifest` with imported texts in `lang` (`units` by unit key: its title, its groups' titles,
 * its cover images' alternative text) put in, and its record for `lang` updated: each unit's text
 * keeps every language's version it has, a text for every language becomes the source
 * language's (`{ [source]: text, [lang]: … }`), as the manual builder does when a language gets
 * its own; every group of the unit's title takes it. The record names, per unit put in, the hash
 * it was exported with and the job's commit as `sourceCommit`, its other units as they were. A
 * unit of a text the manifest no longer has, or one without source text, is left out (the
 * import's check reported it). The texts are taken as given: plain text, checked by the caller.
 */
export function mergeManifestTranslation(
  manifest: Manifest,
  lang: string,
  source: string,
  sourceCommit: string,
  units: ReadonlyMap<string, ManifestUnitImport>,
): Manifest {
  const imported = new Map<string, string>();
  const translate = (key: string, text: LocalizedText): LocalizedText => {
    const unit = units.get(key);
    if (!unit || sourceTextOf(text, source) === undefined) return text;
    imported.set(key, unit.hash);
    return {
      ...(typeof text === 'string' ? { [source]: text } : text),
      [lang]: unit.text,
    };
  };

  const title = translate(TITLE_UNIT, manifest.title);
  const mapEntries = (entries: readonly ManifestEntry[]): ManifestEntry[] =>
    entries.map((entry) => {
      if (!('entries' in entry)) return entry;
      const own = sourceTextOf(entry.title, source);
      return {
        ...entry,
        title:
          own === undefined
            ? entry.title
            : translate(groupUnitKey(own), entry.title),
        entries: mapEntries(entry.entries),
      };
    });
  const entries = mapEntries(manifest.entries);

  const cover = manifest.coverImage;
  let coverImage = cover;
  if (cover) {
    // Only a variant's first entry is shown: a later one for it never takes the text.
    const visited = new Set<string>();
    const put = <T extends LocalizedText>(key: string, alt: T): T => {
      if (visited.has(key)) return alt;
      visited.add(key);
      return translate(key, alt) as T;
    };
    coverImage = {
      ...(cover.default && {
        default: {
          ...cover.default,
          alt: put(DEFAULT_COVER_UNIT, cover.default.alt),
        },
      }),
      variants: cover.variants.map((entry) => ({
        ...entry,
        alt: put(coverUnitKey(entry.variant), entry.alt),
      })),
    };
  }
  if (imported.size === 0) return manifest;
  const next: Manifest = {
    ...manifest,
    title,
    entries,
    ...(coverImage !== undefined && { coverImage }),
  };
  const blocks = keptRecord(
    manifestTexts(next, source),
    manifestRecord(manifest, lang),
  );
  for (const [key, hash] of imported) blocks[key] = hash;
  return {
    ...next,
    translations: {
      ...manifest.translations,
      [lang]: { sourceCommit, blocks },
    },
  };
}

/**
 * `manifest` with its record for `lang` taking the source's current hash for every unit whose
 * text has a version in `lang` (`sourceCommit` the commit read), without changing any text
 * (#656, marking a translation current). A unit without one keeps what its record said. Also
 * returns how many units the record now names as current.
 */
export function markManifestCurrent(
  manifest: Manifest,
  lang: string,
  source: string,
  sourceCommit: string,
): { readonly manifest: Manifest; readonly units: number } {
  const { record, units } = markTextsCurrent(
    manifestUnits(manifest, source),
    manifestTexts(manifest, source),
    manifestRecord(manifest, lang),
    lang,
    source,
    sourceCommit,
  );
  return {
    manifest: {
      ...manifest,
      translations: { ...manifest.translations, [lang]: record },
    },
    units,
  };
}
