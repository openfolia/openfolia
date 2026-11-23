import { type LocalizedText, ownTextIn } from './localized-text.js';
import type { TranslatableUnit } from './translatable-units.js';
import { sourceHash, type SourceHash } from './translation.js';

/**
 * The shared part of the translation of short texts kept in their own file (#731): a manifest's
 * title, groups and cover images, the configuration's labels. Each text has a unit key and a
 * `LocalizedText`; the file keeps per target language a record `{ sourceCommit, blocks }`,
 * `blocks` the source hash each unit's translation was made from.
 */
export interface KeyedText {
  readonly key: string;
  readonly text: LocalizedText;
}

/** A record of what a file's texts in one language were translated from. */
export interface TextRecord {
  readonly sourceCommit: string;
  readonly blocks: Readonly<Record<string, string>>;
}

/** One unit's state in a target language. */
export interface TextUnitState {
  readonly blockId: string;
  readonly state: 'up-to-date' | 'outdated' | 'missing';
}

/** The record for `lang` of a file's records, if it has one. */
export function recordIn(
  records: Readonly<Record<string, TextRecord>> | undefined,
  lang: string,
): TextRecord | undefined {
  return records !== undefined && Object.hasOwn(records, lang)
    ? records[lang]
    : undefined;
}

/**
 * Each unit in `lang`: `missing` where its text has no version of its own in `lang`, `outdated`
 * where it has but the record does not name the unit with the hash its source text has now
 * (changed since, or never imported: a text typed in the editor has no record), else
 * `up-to-date`. `units` are the source-language units, `texts` the texts by the same keys.
 */
export function compareTexts(
  units: readonly TranslatableUnit[],
  texts: readonly KeyedText[],
  record: TextRecord | undefined,
  lang: string,
  source: string,
): TextUnitState[] {
  const byKey = new Map(texts.map((t) => [t.key, t.text]));
  return units.map((unit) => {
    const text = byKey.get(unit.blockId);
    if (text === undefined || ownTextIn(text, lang, source) === undefined) {
      return { blockId: unit.blockId, state: 'missing' };
    }
    const up =
      record !== undefined &&
      Object.hasOwn(record.blocks, unit.blockId) &&
      record.blocks[unit.blockId] === sourceHash(unit);
    return { blockId: unit.blockId, state: up ? 'up-to-date' : 'outdated' };
  });
}

/** Whether some text has a version of its own in `lang`. */
export function hasTextIn(
  texts: readonly KeyedText[],
  lang: string,
  source: string,
): boolean {
  return texts.some(({ text }) => ownTextIn(text, lang, source) !== undefined);
}

/**
 * The record's units for `lang` that are still texts: a text removed takes its unit out of the
 * record, so the record never outgrows the file.
 */
export function keptRecord(
  texts: readonly KeyedText[],
  record: TextRecord | undefined,
): Record<string, string> {
  const keys = new Set(texts.map((t) => t.key));
  const blocks: Record<string, string> = {};
  for (const [key, hash] of Object.entries(record?.blocks ?? {})) {
    if (keys.has(key)) blocks[key] = hash;
  }
  return blocks;
}

/**
 * The record for `lang` taking the source's current hash for every unit whose text has a version
 * in `lang`; the others as the record had them. Also how many units it now names as current.
 */
export function markTextsCurrent(
  units: readonly TranslatableUnit[],
  texts: readonly KeyedText[],
  record: TextRecord | undefined,
  lang: string,
  source: string,
  sourceCommit: string,
): { readonly record: TextRecord; readonly units: number } {
  const hashes = new Map<string, SourceHash>(
    units.map((u) => [u.blockId, sourceHash(u)]),
  );
  const blocks = keptRecord(texts, record);
  let count = 0;
  for (const { key, text } of texts) {
    const hash = hashes.get(key);
    if (hash === undefined || ownTextIn(text, lang, source) === undefined) {
      continue;
    }
    blocks[key] = hash;
    count++;
  }
  return { record: { sourceCommit, blocks }, units: count };
}
