import type { ModuleMeta } from '@openfolia/content-model';

/** A facet value a module has to have: `<facet>:<value>` in a query. */
export interface FacetValue {
  readonly id: string;
  readonly value: string;
}

/**
 * What a module has to be to be listed, by its metadata. Every given part
 * has to hold (AND), and every value of a repeated one: the module has each
 * facet value and each keyword. Values are compared as given (configuration
 * keys), keywords with case and diacritics aside. A value the configuration
 * does not know simply matches nothing; it is never an error, so a filter
 * tells nobody what exists beyond what they may read.
 */
export interface ModuleFilter {
  /** A configured module type. */
  readonly type?: string | undefined;
  /**
   * A configured audience level: the modules that count as it (`countsAsAudience`),
   * so the last, most restricted level includes the modules that name none.
   */
  readonly audience?: string | undefined;
  readonly facets?: readonly FacetValue[] | undefined;
  readonly keywords?: readonly string[] | undefined;
}

/** Whether `filter` restricts anything. */
export function filtersModules(filter: ModuleFilter): boolean {
  return (
    filter.type !== undefined ||
    filter.audience !== undefined ||
    (filter.facets?.length ?? 0) > 0 ||
    (filter.keywords?.length ?? 0) > 0
  );
}

/**
 * Text folded for comparing: lower case, no diacritics (`ä` is `a`), `ß` as
 * `ss`. The search folds its text the same way.
 */
export function foldText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replaceAll('ß', 'ss');
}

/** A keyword as it is compared: folded, its whitespace collapsed and trimmed. */
export const foldKeyword = (keyword: string): string =>
  foldText(keyword).replace(/\s+/g, ' ').trim();

/**
 * Whether a module whose metadata names `audience` counts as `level`, with
 * the configuration's `levels` (least to most restricted), as resolution and
 * the access check place it (#693): a module naming no audience counts as the
 * last level; one naming an audience the configuration does not list sorts
 * past every level, so it counts as none; and a `level` the configuration
 * does not list matches nothing.
 */
export function countsAsAudience(
  audience: string | undefined,
  level: string,
  levels: readonly string[],
): boolean {
  if (!levels.includes(level)) return false;
  return audience === undefined ? levels.at(-1) === level : audience === level;
}

/**
 * Whether a module's metadata matches the type, audience and facet parts of
 * `filter` (not its keywords: see `hasKeywords`, since a module's keywords
 * differ per language). `audiences`: the configuration's levels, least to
 * most restricted.
 */
export function matchesClassification(
  meta: Pick<ModuleMeta, 'type' | 'audience' | 'facets'>,
  filter: ModuleFilter,
  audiences: readonly string[],
): boolean {
  if (filter.type !== undefined && meta.type !== filter.type) return false;
  if (
    filter.audience !== undefined &&
    !countsAsAudience(meta.audience, filter.audience, audiences)
  ) {
    return false;
  }
  return (filter.facets ?? []).every(({ id, value }) =>
    (meta.facets[id] ?? []).includes(value),
  );
}

/** Whether `keywords` (a module's, folded with `foldKeyword`) hold every keyword `filter` asks for. */
export function hasKeywords(
  folded: ReadonlySet<string>,
  filter: ModuleFilter,
): boolean {
  return (filter.keywords ?? []).every((k) => folded.has(foldKeyword(k)));
}

/** A module's keywords folded for `hasKeywords`. */
export function foldedKeywords(
  meta: Pick<ModuleMeta, 'keywords'>,
): Set<string> {
  return new Set((meta.keywords ?? []).map(foldKeyword));
}

/** Whether one language of a module matches all of `filter` (`audiences` as for `matchesClassification`). */
export function matchesModuleFilter(
  meta: Pick<ModuleMeta, 'type' | 'audience' | 'facets' | 'keywords'>,
  filter: ModuleFilter,
  audiences: readonly string[],
): boolean {
  return (
    matchesClassification(meta, filter, audiences) &&
    hasKeywords(foldedKeywords(meta), filter)
  );
}
