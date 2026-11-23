import { normalizeBlock } from './normalize.js';
import {
  type DesignTranslationRecord,
  isLocalized,
  type PageDesign,
  type RegionBlocks,
  type Translatable,
} from './page-design.js';
import { regionSlots } from './page-design-options.js';
import { sourceHash, type SourceHash } from './translation.js';
import { blockUnits, type TranslatableUnit } from './translatable-units.js';
import { walk } from './walk.js';

/**
 * A translatable unit of a page design's region text (#568): a unit of the region's blocks in
 * the source language (`blockUnits`), its `blockId` the design's unit key (`<slot>.<block>`,
 * `DesignUnitKey`), so it is unique in the design.
 */
export interface DesignUnit extends TranslatableUnit {
  /** The region's slot. */
  readonly slot: string;
  /** The block's (or item's, or callout's) ID in the region. */
  readonly block: string;
}

/** A design's unit key: the slot and the block ID (`DesignUnitKey`). */
export const designUnitKey = (slot: string, block: string): string =>
  `${slot}.${block}`;

/**
 * A region's text in the source language: the text for every language (the design screen's
 * source text until a language has its own), else the source language's own; none when only
 * other languages have text.
 */
export function regionSourceText(
  text: Translatable<RegionBlocks>,
  source: string,
): RegionBlocks | undefined {
  if (!isLocalized(text)) return text;
  return Object.hasOwn(text, source) ? text[source] : undefined;
}

/**
 * A region's own text in `lang` (a target language): the version written for it; none when it
 * takes the source language's (the text is the same for every language, or `lang` has none).
 */
export function regionOwnText(
  text: Translatable<RegionBlocks>,
  lang: string,
  source: string,
): RegionBlocks | undefined {
  if (!isLocalized(text)) return lang === source ? text : undefined;
  return Object.hasOwn(text, lang) ? text[lang] : undefined;
}

/** The design's slots with text, the preset's in its order, then any others sorted. */
function slotOrder(design: PageDesign): string[] {
  const known = regionSlots(design.preset);
  const names = Object.keys(design.regions);
  return [
    ...known.filter((slot) => names.includes(slot)),
    ...names.filter((slot) => !known.includes(slot)).sort(),
  ];
}

/**
 * The translatable units of a design's region text (#568), in the source language: per region
 * (the preset's slots in its order, then others), the units of its source text
 * (`regionSourceText`) as a module's blocks have them (`blockUnits`), normalized. A region with
 * no source text has none. Running headers and footers, cover image alt text and the back
 * page's copyright line are not region text and have no units here.
 */
export function designUnits(design: PageDesign, source: string): DesignUnit[] {
  const units: DesignUnit[] = [];
  for (const slot of slotOrder(design)) {
    const text = design.regions[slot] as Translatable<RegionBlocks>;
    const blocks = regionSourceText(text, source);
    if (!blocks) continue;
    for (const unit of blockUnits(blocks.map(normalizeBlock))) {
      units.push({
        ...unit,
        blockId: designUnitKey(slot, unit.blockId),
        slot,
        block: unit.blockId,
      });
    }
  }
  return units;
}

/** The source hash of each unit of the design's region text, by unit key, in order. */
export function designSourceHashes(
  design: PageDesign,
  source: string,
): Map<string, SourceHash> {
  return new Map(
    designUnits(design, source).map((unit) => [unit.blockId, sourceHash(unit)]),
  );
}

/** Where one unit of a design's region text stands in a target language. */
export type DesignUnitTranslation = 'up-to-date' | 'outdated' | 'missing';

/** The IDs of the blocks, items and callouts of `blocks`. */
function idsOf(blocks: RegionBlocks): Set<string> {
  const ids = new Set<string>();
  for (const { node } of walk(blocks)) ids.add(node.id);
  for (const unit of blockUnits(blocks)) ids.add(unit.blockId);
  return ids;
}

/**
 * Each unit of the design's region text (`designUnits`) in `lang`: `missing` where the region
 * has no text of its own in `lang` (it takes the source language's), `outdated` where it has
 * but the block is not in it (its blocks differ from the source's) or its record
 * (`design.translations[lang]`) does not name the unit with the hash its source text has now
 * (changed since, or never imported: a translation written in the design screen has no record),
 * else `up-to-date`.
 */
export function compareDesignWithRecord(
  design: PageDesign,
  lang: string,
  source: string,
): { readonly blockId: string; readonly state: DesignUnitTranslation }[] {
  const record: DesignTranslationRecord | undefined =
    design.translations !== undefined &&
    Object.hasOwn(design.translations, lang)
      ? design.translations[lang]
      : undefined;
  const own = new Map<string, Set<string> | undefined>();
  const ownIds = (slot: string) => {
    if (!own.has(slot)) {
      const text = regionOwnText(
        design.regions[slot] as Translatable<RegionBlocks>,
        lang,
        source,
      );
      own.set(slot, text && idsOf(text));
    }
    return own.get(slot);
  };
  return designUnits(design, source).map((unit) => {
    const ids = ownIds(unit.slot);
    if (!ids) return { blockId: unit.blockId, state: 'missing' };
    const up =
      ids.has(unit.block) &&
      record !== undefined &&
      Object.hasOwn(record.blocks, unit.blockId) &&
      record.blocks[unit.blockId] === sourceHash(unit);
    return { blockId: unit.blockId, state: up ? 'up-to-date' : 'outdated' };
  });
}

/** Whether some region of the design has text of its own in `lang`. */
export function hasDesignTranslation(
  design: PageDesign,
  lang: string,
  source: string,
): boolean {
  return Object.values(design.regions).some(
    (text) => regionOwnText(text, lang, source) !== undefined,
  );
}

/**
 * `design` with its record for `lang` taking the source's current hash for every unit whose
 * region has text of its own in `lang` holding that block (`sourceCommit` the commit read),
 * without changing any text (#656, marking a translation current). A unit the translation lacks
 * keeps what its record said (it is still to be translated). Also returns how many units the
 * record now names as current.
 */
export function markDesignCurrent(
  design: PageDesign,
  lang: string,
  source: string,
  sourceCommit: string,
): { readonly design: PageDesign; readonly units: number } {
  const before: DesignTranslationRecord | undefined =
    design.translations !== undefined &&
    Object.hasOwn(design.translations, lang)
      ? design.translations[lang]
      : undefined;
  const blocks: Record<string, string> = {};
  for (const [key, hash] of Object.entries(before?.blocks ?? {})) {
    blocks[key] = hash;
  }
  const own = new Map<string, Set<string> | undefined>();
  let units = 0;
  for (const unit of designUnits(design, source)) {
    if (!own.has(unit.slot)) {
      const text = regionOwnText(
        design.regions[unit.slot] as Translatable<RegionBlocks>,
        lang,
        source,
      );
      own.set(unit.slot, text && idsOf(text));
    }
    if (!own.get(unit.slot)?.has(unit.block)) continue;
    blocks[unit.blockId] = sourceHash(unit);
    units++;
  }
  return {
    design: {
      ...design,
      translations: {
        ...design.translations,
        [lang]: { sourceCommit, blocks },
      },
    },
    units,
  };
}
