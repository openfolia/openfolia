import type {
  ModuleUse,
  ReadableIndex,
} from '../../modules/core/readable-module-index.js';
import { compareTitles } from '../../base/core/compare-titles.js';

/** One module (by ID, in any language) with where it is used (FR-19). */
export interface ModuleUsageRow {
  readonly moduleId: string;
  /** Its title: its source-language file's, else its first file's the reader sees. */
  readonly title: string;
  /** Its module type, from the same file. */
  readonly type: string;
  /** Deprecated (#266), by the same file. */
  readonly deprecated: boolean;
  /** The languages the reader sees it in, in the configured order. */
  readonly languages: readonly string[];
  /** The manuals including it, directly or through module references. */
  readonly manuals: number;
  /** The modules whose module reference blocks name it. */
  readonly modules: number;
  /** All of them: manuals first, then modules, each by title. */
  readonly uses: readonly ModuleUse[];
}

export const USAGE_SORT_FIELDS = [
  'id',
  'title',
  'type',
  'manuals',
  'modules',
  'usage',
] as const;
export type UsageSortField = (typeof USAGE_SORT_FIELDS)[number];
export interface UsageSort {
  readonly field: UsageSortField;
  readonly descending: boolean;
}

/** What to list; every part given has to hold. */
export interface UsageFilter {
  /**
   * `true`: only modules no manual includes, directly or through module
   * references; `false`: only those some manual includes.
   */
  readonly unused?: boolean | undefined;
  /** One module type; one the configuration does not know matches nothing. */
  readonly type?: string | undefined;
}

/**
 * One row per module the reader may see in some language, from the module
 * index as the reader sees it (`ReadableModuleIndex`): a file that cannot
 * be read gives no row, and uses count only manuals and modules the reader
 * may see, so no row and no count tells of anything outside their scope.
 * Filtered, then ordered by `sort` (default: title), ties by title, then ID.
 */
export function moduleUsageReport(
  index: ReadableIndex,
  source: string,
  languageOrder: readonly string[],
  filter: UsageFilter,
  sort: readonly UsageSort[] = [],
): ModuleUsageRow[] {
  const files = new Map<string, (typeof index.modules)[number][]>();
  for (const file of index.modules) {
    if (!file.meta) continue;
    const found = files.get(file.id);
    if (found) found.push(file);
    else files.set(file.id, [file]);
  }
  const rank = (lang: string) => {
    const i = languageOrder.indexOf(lang);
    return i < 0 ? languageOrder.length : i;
  };
  const rows: ModuleUsageRow[] = [];
  for (const [moduleId, found] of files) {
    const first = found.find((f) => f.lang === source) ?? found[0];
    const meta = first?.meta;
    if (!meta) continue;
    if (filter.type !== undefined && meta.type !== filter.type) continue;
    const usage = index.usage(moduleId);
    if (filter.unused !== undefined && filter.unused !== (usage.manuals === 0))
      continue;
    rows.push({
      moduleId,
      title: meta.title,
      type: meta.type,
      deprecated: meta.deprecated !== undefined,
      languages: found
        .map((f) => f.lang)
        .sort((a, b) => rank(a) - rank(b) || compare(a, b)),
      manuals: usage.manuals,
      modules: usage.modules,
      uses: usage.uses,
    });
  }
  return rows.sort(
    (a, b) =>
      sort.reduce(
        (order, { field, descending }) =>
          order || (descending ? -1 : 1) * by(field, a, b),
        0,
      ) ||
      by('title', a, b) ||
      compare(a.moduleId, b.moduleId),
  );
}

function by(field: UsageSortField, a: ModuleUsageRow, b: ModuleUsageRow) {
  switch (field) {
    case 'id':
      return compare(a.moduleId, b.moduleId);
    case 'title':
      return compareTitles(a.title, b.title);
    case 'type':
      return compare(a.type, b.type);
    case 'manuals':
      return a.manuals - b.manuals;
    case 'modules':
      return a.modules - b.modules;
    case 'usage':
      return a.manuals + a.modules - (b.manuals + b.modules);
  }
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
