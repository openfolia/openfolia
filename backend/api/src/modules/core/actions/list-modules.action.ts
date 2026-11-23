import { Injectable } from '@nestjs/common';
import {
  productFacet,
  validateModule,
  type Issue,
  type Module,
} from '@openfolia/content-model';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { InvalidContentError } from '../../../base/core/errors.js';
import {
  paginate,
  type PageRequest,
  type Paginated,
} from '../../../base/core/paging.js';
import {
  filtersModules,
  matchesModuleFilter,
  type ModuleFilter,
} from '../../../content/core/module-filter.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import type { IndexedModule } from '../module-index.js';
import {
  type ModuleUsage,
  ReadableModuleIndex,
} from '../readable-module-index.js';
import {
  GetModuleStatusesAction,
  type ModuleStatus,
} from './get-module-statuses.action.js';
import { compareTitles } from '../../../base/core/compare-titles.js';

export type ModuleListEntry =
  | {
      id: string;
      lang: string;
      module: Module;
      issues: Issue[];
      status: ModuleStatus;
      usage: ModuleUsage;
    }
  | { id: string; lang: string; error: string };

/**
 * Where a module stands (`ModuleStatus`), as `filter[status]` asks:
 * `released`, the newest release holding it holds exactly this file;
 * `changed`, a release holds it but this file differs; `unreleased`, no
 * release holds it; `in-change-set`, an open change set the reader may
 * read changes it (none for a reader who is not told of change sets).
 */
export const MODULE_STATUSES = [
  'released',
  'changed',
  'unreleased',
  'in-change-set',
] as const;
export type ModuleStatusFilter = (typeof MODULE_STATUSES)[number];

/** What a list may be sorted by. */
export const MODULE_SORT_FIELDS = [
  'id',
  'lang',
  'title',
  'type',
  'usage',
] as const;
export type ModuleSortField = (typeof MODULE_SORT_FIELDS)[number];

export interface ModuleSort {
  readonly field: ModuleSortField;
  readonly descending: boolean;
}

/** The order without `sort`: by language, then ID. */
export const DEFAULT_MODULE_SORT: readonly ModuleSort[] = [
  { field: 'lang', descending: false },
  { field: 'id', descending: false },
];

export interface ModuleListFilter extends ModuleFilter {
  readonly lang?: string | undefined;
  /** A value of the product facet (`productFacet`: `release.productFacet`, else the first facet). */
  readonly product?: string | undefined;
  readonly status?: ModuleStatusFilter | undefined;
}

interface Input {
  actor: Actor;
  snapshot: ReadableContent;
  filter?: ModuleListFilter;
  sort?: readonly ModuleSort[];
  page: PageRequest;
}

/**
 * One page of the modules the actor may see, filtered and sorted on the
 * module index (`ReadableModuleIndex`), before paging, so the total counts
 * only what is listed; only the page's files are read in full. Each
 * module has its status and where it is used (`usage`, only what the
 * actor may see). A module that cannot be read is listed with its error
 * (to an actor who may read everything in its language), so one broken
 * file never hides the rest; a filter on its metadata or status leaves it
 * out.
 */
@Injectable()
export class ListModulesAction extends ActorAction<
  Input,
  Paginated<ModuleListEntry>
> {
  readonly policy = 'content.read';

  constructor(
    private readonly index: ReadableModuleIndex,
    private readonly statuses: GetModuleStatusesAction,
  ) {
    super();
  }

  protected async run({
    actor,
    snapshot,
    filter = {},
    sort = DEFAULT_MODULE_SORT,
    page,
  }: Input): Promise<Paginated<ModuleListEntry>> {
    const [config, index] = await Promise.all([
      snapshot.config(),
      this.index.of(snapshot),
    ]);
    const product = productFacet(config)?.id;
    const audiences = config.audiences.map((a) => a.id);
    const byMeta = filtersModules(filter) || filter.product !== undefined;
    let found = index.modules.filter(({ lang, meta }) => {
      if (filter.lang !== undefined && lang !== filter.lang) return false;
      if (!byMeta && filter.status === undefined) return true;
      if (!meta) return false;
      if (!matchesModuleFilter(meta, filter, audiences)) return false;
      return (
        filter.product === undefined ||
        (product !== undefined &&
          (meta.facets[product] ?? []).includes(filter.product))
      );
    });
    let statuses: Map<string, ModuleStatus> | undefined;
    if (filter.status !== undefined) {
      statuses = await this.statuses.handle({
        actor,
        snapshot,
        modules: found,
      });
      const wanted = filter.status;
      found = found.filter((m) => {
        const status = statuses?.get(key(m));
        return status !== undefined && hasStatus(status, wanted);
      });
    }
    const sorted = found.sort(order(sort, (id) => index.usage(id)));
    const { items, total } = paginate(sorted, page);
    const readable = items.filter((m) => m.meta);
    statuses ??= await this.statuses.handle({
      actor,
      snapshot,
      modules: readable,
    });
    return {
      total,
      items: await Promise.all(
        items.map(async (m): Promise<ModuleListEntry> => {
          if (!m.meta) return { id: m.id, lang: m.lang, error: m.error ?? '' };
          let module: Module | undefined;
          try {
            module = await snapshot.module(m.id, m.lang);
          } catch (error) {
            if (!(error instanceof InvalidContentError)) throw error;
            return { id: m.id, lang: m.lang, error: error.message };
          }
          const status = statuses?.get(key(m));
          if (!module || !status) {
            // The index and the commit disagree: never list what was not read.
            throw new Error(`The module index does not match ${key(m)}.`);
          }
          return {
            id: m.id,
            lang: m.lang,
            module,
            issues: validateModule(module, config),
            status,
            usage: index.usage(m.id),
          };
        }),
      ),
    };
  }
}

const key = (m: { id: string; lang: string }) => `${m.lang}/${m.id}`;

function hasStatus(status: ModuleStatus, wanted: ModuleStatusFilter): boolean {
  switch (wanted) {
    case 'released':
      return status.release?.same === true;
    case 'changed':
      return status.release !== null && !status.release.same;
    case 'unreleased':
      return status.release === null;
    case 'in-change-set':
      return (status.changeSets?.length ?? 0) > 0;
  }
}

/**
 * Compares by each field in turn, then by language and ID, so pages are
 * stable. A file that cannot be read has no title or type: by either, it
 * comes after every one that has, whichever the direction.
 */
function order(
  sort: readonly ModuleSort[],
  usage: (id: string) => ModuleUsage,
): (a: IndexedModule, b: IndexedModule) => number {
  const fields = [...sort, ...DEFAULT_MODULE_SORT];
  const count = (id: string) => {
    const u = usage(id);
    return u.manuals + u.modules;
  };
  return (a, b) => {
    for (const { field, descending } of fields) {
      if ((field === 'title' || field === 'type') && !a.meta !== !b.meta) {
        return a.meta ? -1 : 1;
      }
      const found = compareBy(field, a, b, count);
      if (found !== 0) return descending ? -found : found;
    }
    return 0;
  };
}

function compareBy(
  field: ModuleSortField,
  a: IndexedModule,
  b: IndexedModule,
  count: (id: string) => number,
): number {
  switch (field) {
    case 'id':
      return compare(a.id, b.id);
    case 'lang':
      return compare(a.lang, b.lang);
    case 'usage':
      return count(a.id) - count(b.id);
    case 'title':
      return compareTitles(a.meta?.title ?? '', b.meta?.title ?? '');
    case 'type':
      return compare(a.meta?.type ?? '', b.meta?.type ?? '');
  }
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
