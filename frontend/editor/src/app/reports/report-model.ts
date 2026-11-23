import type { Item, Schema } from '../api';

/** One manual in one target language (`GET /reports/translations`). */
export type CoverageItem = Item<'/reports/translations'>;
/** How many modules or blocks stand in each translation state. */
export type CoverageCounts = Schema<'CoverageCounts'>;
/** One module with where it is used (`GET /reports/module-usage`). */
export type UsageItem = Item<'/reports/module-usage'>;
export type ModuleUse = Schema<'ModuleUse'>;

/** The page sizes both reports offer. */
export const REPORT_PAGE_SIZES = [25, 50, 100] as const;

/** The share of `counts` up to date, from 0 to 1, rounded down to a whole percent. */
export function upToDateShare(counts: CoverageCounts): number {
  return counts.total === 0
    ? 0
    : Math.floor((counts.upToDate * 100) / counts.total) / 100;
}

/** The Usage tab's view: every module, those some manual includes, or those none does. */
export const USAGE_SHOWS = ['all', 'used', 'unused'] as const;
export type UsageShow = (typeof USAGE_SHOWS)[number];

/** `filter[unused]` for a view; none for every module. */
export function unusedFilter(show: UsageShow): 'true' | 'false' | undefined {
  return show === 'unused' ? 'true' : show === 'used' ? 'false' : undefined;
}

/** The Usage tab's orders, each the API's `sort`. */
export const USAGE_SORTS = ['title', 'most-used', 'least-used'] as const;
export type UsageSortChoice = (typeof USAGE_SORTS)[number];

export const USAGE_SORT_PARAM: Readonly<Record<UsageSortChoice, string>> = {
  title: 'title',
  'most-used': '-usage,title',
  'least-used': 'usage,title',
};

export const USAGE_SORT_TEXTS: Readonly<Record<UsageSortChoice, string>> = {
  title: 'editor.reports.usage.sort.title',
  'most-used': 'editor.reports.usage.sort.mostUsed',
  'least-used': 'editor.reports.usage.sort.leastUsed',
};

/** A module ID, a manual ID: what the filters in the address may hold. */
export const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A language tag. */
export const LANG_PATTERN = /^[a-zA-Z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
/** A configuration key (a module type). */
export const KEY_PATTERN = /^[a-z][a-z0-9-]*$/;

/** The manuals a module is in, and the modules referring to it, from `meta.usedIn`. */
export function usesOf(item: UsageItem): {
  readonly manuals: readonly ModuleUse[];
  readonly modules: readonly ModuleUse[];
  /** Uses counted but not named (past the 50 `usedIn` holds). */
  readonly moreManuals: number;
  readonly moreModules: number;
} {
  const manuals = item.meta.usedIn.filter((u) => u.kind === 'manual');
  const modules = item.meta.usedIn.filter((u) => u.kind === 'module');
  return {
    manuals,
    modules,
    moreManuals: Math.max(0, item.meta.usage.manuals - manuals.length),
    moreModules: Math.max(0, item.meta.usage.modules - modules.length),
  };
}
