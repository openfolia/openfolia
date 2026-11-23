import {
  BACK_PAGE_SLOTS,
  isLocalized,
  regionSlots,
  type Block,
} from '@openfolia/content-model/core';

import type { PageDesign } from './design-model';

/**
 * A page design's region text (#393), as the screen edits it: per slot, one block list for
 * every language, or one per language tag (`Translatable<RegionBlocks>`); a language without its
 * own takes the source language's, as the PDF does (`textInLanguage`).
 */
export type RegionText =
  readonly Block[] | Readonly<Record<string, readonly Block[]>>;
export type Regions = Readonly<Record<string, RegionText>>;

/** A design's regions with the content model's block type (the API's schema type is the same data). */
export function regionsOf(design: PageDesign): Regions {
  return design.regions as unknown as Regions;
}

/** The regions as the API's design takes them. */
export function asDesignRegions(regions: Regions): PageDesign['regions'] {
  return regions as unknown as PageDesign['regions'];
}

/** Whether a region's text is written per language. */
function perLanguage(
  text: RegionText,
): text is Readonly<Record<string, readonly Block[]>> {
  return isLocalized(text as never);
}

/** What a region shows in one language. */
export interface RegionInLanguage {
  /** The blocks shown: the language's own, else the source language's; none: the region is empty. */
  readonly blocks: readonly Block[];
  /**
   * `own`: the language has its own text (or the text is the same in every language, in the
   * source language); `source`: it takes the source language's (a missing translation); `empty`:
   * the region has no text to show in it.
   */
  readonly state: 'own' | 'source' | 'empty';
}

/** The region `slot` in `lang`, the source language being `source`. */
export function regionIn(
  regions: Regions,
  slot: string,
  lang: string,
  source: string,
): RegionInLanguage {
  const text = Object.hasOwn(regions, slot) ? regions[slot] : undefined;
  if (text === undefined) return { blocks: [], state: 'empty' };
  if (!perLanguage(text)) {
    return { blocks: text, state: lang === source ? 'own' : 'source' };
  }
  if (Object.hasOwn(text, lang))
    return { blocks: text[lang] as readonly Block[], state: 'own' };
  if (Object.hasOwn(text, source))
    return { blocks: text[source] as readonly Block[], state: 'source' };
  return { blocks: [], state: 'empty' };
}

/** The regions without `slot`. */
function without(regions: Regions, slot: string): Regions {
  const next = { ...regions };
  delete next[slot];
  return next;
}

/**
 * Written per language with only the source language left: the same text for every language
 * again (the file's short form).
 */
function compact(
  text: Readonly<Record<string, readonly Block[]>>,
  source: string,
): RegionText | undefined {
  const langs = Object.keys(text);
  if (langs.length === 0) return undefined;
  if (langs.length === 1 && langs[0] === source) return text[source];
  return text;
}

/**
 * The regions with `slot`'s text in `lang` set to `blocks` (`[]`: no text of its own there).
 * In the source language the text is the same for every language until some language has its
 * own; a target language's first own text turns the region into one text per language, the
 * source language's kept. Emptying a target language's text puts the source language's back for
 * it; emptying the source language's leaves the translations (each then shows its own).
 */
export function withRegionText(
  regions: Regions,
  slot: string,
  lang: string,
  source: string,
  blocks: readonly Block[],
): Regions {
  const text = Object.hasOwn(regions, slot) ? regions[slot] : undefined;
  if (text === undefined) {
    if (blocks.length === 0) return regions;
    return {
      ...regions,
      [slot]: lang === source ? blocks : { [lang]: blocks },
    };
  }
  if (!perLanguage(text)) {
    if (lang === source)
      return blocks.length === 0
        ? without(regions, slot)
        : { ...regions, [slot]: blocks };
    // A target language with nothing of its own already takes the source language's text.
    if (blocks.length === 0) return regions;
    return { ...regions, [slot]: { [source]: text, [lang]: blocks } };
  }
  const next: Record<string, readonly Block[]> = { ...text };
  if (blocks.length === 0) delete next[lang];
  else next[lang] = blocks;
  const kept = compact(next, source);
  return kept === undefined
    ? without(regions, slot)
    : { ...regions, [slot]: kept };
}

/** The regions with `lang`'s own text of `slot` gone: it takes the source language's again. */
export function withoutTranslation(
  regions: Regions,
  slot: string,
  lang: string,
  source: string,
): Regions {
  if (lang === source) return regions;
  return withRegionText(regions, slot, lang, source, []);
}

/** The regions with `slot` gone in every language (a region the layout no longer has). */
export function withoutRegion(regions: Regions, slot: string): Regions {
  return Object.hasOwn(regions, slot) ? without(regions, slot) : regions;
}

/** The slots the screen lists: the preset's title page's, then the back page's. */
export function regionGroups(preset: string): {
  readonly titlePage: readonly string[];
  readonly backPage: readonly string[];
} {
  const back: readonly string[] = BACK_PAGE_SLOTS;
  return {
    titlePage: regionSlots(preset).filter((s) => !back.includes(s)),
    backPage: back,
  };
}

/** Slots with text that the preset does not have (kept, and flagged `unknown-region`). */
export function strayRegions(regions: Regions, preset: string): string[] {
  const known = regionSlots(preset);
  return Object.keys(regions).filter((slot) => !known.includes(slot));
}

/**
 * The regions with text whose translation into `lang` is missing (it takes the source
 * language's), among `slots`: what the language switch counts.
 */
export function missingTranslations(
  regions: Regions,
  slots: readonly string[],
  lang: string,
  source: string,
): string[] {
  if (lang === source) return [];
  return slots.filter(
    (slot) => regionIn(regions, slot, lang, source).state === 'source',
  );
}

/** A slot's name as the screen shows it (a translation key). */
export const REGION_LABELS: Readonly<Record<string, string>> = {
  'above-title': 'editor.admin.pageDesigns.regions.slots.aboveTitle',
  'below-fields': 'editor.admin.pageDesigns.regions.slots.belowFields',
  band: 'editor.admin.pageDesigns.regions.slots.band',
  footer: 'editor.admin.pageDesigns.regions.slots.footer',
  back: 'editor.admin.pageDesigns.regions.slots.back',
  'back-footer': 'editor.admin.pageDesigns.regions.slots.backFooter',
};

/** What a slot is for (a translation key). */
export const REGION_HINTS: Readonly<Record<string, string>> = {
  'above-title': 'editor.admin.pageDesigns.regions.hints.aboveTitle',
  'below-fields': 'editor.admin.pageDesigns.regions.hints.belowFields',
  band: 'editor.admin.pageDesigns.regions.hints.band',
  footer: 'editor.admin.pageDesigns.regions.hints.footer',
  back: 'editor.admin.pageDesigns.regions.hints.back',
  'back-footer': 'editor.admin.pageDesigns.regions.hints.backFooter',
};
