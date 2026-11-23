import {
  blockUnits,
  type Block,
  type DesignTranslationRecord,
  designUnitKey,
  isLocalized,
  type Module,
  normalizeBlock,
  type PageDesign,
  type RegionBlocks,
  regionBlocksDiffer,
  regionOwnText,
  regionSourceText,
  type TranslatablePart,
  type Translatable,
} from '@openfolia/content-model';
import { mergeTranslation } from './translation-merge.js';

/** One imported unit of a design's region text: its translated parts and the hash it was exported with. */
export interface DesignUnitImport {
  readonly parts: readonly TranslatablePart[];
  readonly hash: string;
}

/** A region's blocks as a module, so a module's merge (`mergeTranslation`) merges into them. */
const asModule = (blocks: readonly Block[], lang: string): Module =>
  ({
    schemaVersion: 1,
    id: 'region',
    meta: { title: 'region', type: 'region', lang, facets: {} },
    blocks: structuredClone([...blocks]),
  }) as unknown as Module;

/**
 * `design` with the imported units of its region text in `lang` (#568; `units` by unit key,
 * `<slot>.<block>`) merged in, and its translation record for `lang` updated:
 *
 * - each region with a unit keeps every language's text it has, and the text for every
 *   language becomes the source language's (`{ [source]: text, [lang]: … }`), as the design
 *   screen does when a target language gets text of its own;
 * - its text in `lang` keeps the source text's block IDs, so resolving the design never finds
 *   `region-languages-differ`: the text it had in `lang` is the start when it holds exactly the
 *   source's IDs, its other blocks (an image of its own, a variant's condition) as they were;
 *   otherwise the source's blocks are, each keeping the text `lang` had for that block ID;
 *   then each unit's text goes in by block ID (`mergeTranslation`);
 * - the source language's text is never removed, so no region is left without text in some
 *   language (`dropped-text`);
 * - the record names, per unit imported, the hash it was exported with, the job's commit as
 *   `sourceCommit`, the record's other units as they were.
 *
 * A unit of a region without source text, or of a block the source no longer has, is left out
 * (the import's check reported it, `unknown-block`).
 */
export function mergeDesignTranslation(
  design: PageDesign,
  lang: string,
  source: string,
  sourceCommit: string,
  units: ReadonlyMap<string, DesignUnitImport>,
): PageDesign {
  const regions: Record<string, Translatable<RegionBlocks>> = {
    ...design.regions,
  };
  const imported = new Map<string, string>();
  for (const slot of Object.keys(design.regions)) {
    const text = design.regions[slot] as Translatable<RegionBlocks>;
    const sourceText = regionSourceText(text, source)?.map(normalizeBlock);
    if (!sourceText) continue;
    const prefix = designUnitKey(slot, '');
    const mine = new Map<string, readonly TranslatablePart[]>();
    for (const [key, unit] of units) {
      if (key.startsWith(prefix)) {
        mine.set(key.slice(prefix.length), unit.parts);
      }
    }
    if (mine.size === 0) continue;
    const own = regionOwnText(text, lang, source)?.map(normalizeBlock);
    const keeps = own !== undefined && !regionBlocksDiffer(own, sourceText);
    let parts = mine;
    if (own !== undefined && !keeps) {
      // From the source's blocks: the text `lang` had for a block it shares goes back in.
      const before = new Map(
        blockUnits(own).map((u) => [u.blockId, u.parts] as const),
      );
      parts = new Map(before);
      for (const [id, p] of mine) parts.set(id, p);
    }
    const merged = mergeTranslation(
      keeps ? asModule(own, lang) : undefined,
      asModule(sourceText, lang),
      lang,
      parts,
    );
    const inSource = new Set(blockUnits(sourceText).map((u) => u.blockId));
    for (const id of mine.keys()) {
      if (inSource.has(id)) {
        imported.set(
          designUnitKey(slot, id),
          (units.get(designUnitKey(slot, id)) as DesignUnitImport).hash,
        );
      }
    }
    regions[slot] = {
      ...(isLocalized(text) ? text : { [source]: text }),
      [lang]: merged.blocks as RegionBlocks,
    };
  }
  const before: DesignTranslationRecord | undefined =
    design.translations !== undefined &&
    Object.hasOwn(design.translations, lang)
      ? design.translations[lang]
      : undefined;
  const blocks: Record<string, string> = {};
  for (const [key, hash] of Object.entries(before?.blocks ?? {})) {
    blocks[key] = hash;
  }
  for (const [key, hash] of imported) blocks[key] = hash;
  return {
    ...design,
    regions,
    translations: {
      ...design.translations,
      [lang]: { sourceCommit, blocks },
    },
  };
}
