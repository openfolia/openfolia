import { firstValueFrom } from 'rxjs';

import {
  pageQuery,
  toApiError,
  type ApiClient,
  type Item,
  type Schema,
} from '../api';
import { unitsOf } from '../review/review-diff';

// The module reference graph the module picker checks for cycles: which modules each module
// includes through its module reference blocks, read from `GET /modules` (every module the person
// may see, with its blocks). A module is read in the document's language, else in the source
// language (as a manual falls back to it), so the graph follows the references a manual in that
// language would follow.

type Block = Schema<'Block'>;
type ModuleItem = Item<'/modules'>;
type ModuleStatus = Schema<'ModuleStatus'>;

/** One module of the graph, with what the picker shows of it. */
export interface GraphModule {
  readonly id: string;
  /** The language it was read in: the document's, or the source language as a fallback. */
  readonly lang: string;
  readonly title: string;
  readonly type: string;
  readonly facets: Readonly<Record<string, readonly string[]>>;
  readonly blocks: readonly Block[];
  readonly status: ModuleStatus;
  /** The modules it includes (module reference blocks anywhere in it), each once, in order. */
  readonly refs: readonly string[];
}

export interface ModuleGraph {
  readonly modules: ReadonlyMap<string, GraphModule>;
  /**
   * Whether every module was read: false when there were more than `GRAPH_PAGES` pages, so a
   * module missing here may still exist (and is read on its own, `moduleRefs`).
   */
  readonly complete: boolean;
}

/** Modules per page of `GET /modules` (its maximum). */
export const GRAPH_PAGE_SIZE = 200;
/** At most this many pages are read per language; past them the graph is incomplete. */
export const GRAPH_PAGES = 20;
/** A cycle search stops after this many modules (each a read when the graph is incomplete). */
export const CYCLE_SEARCH_LIMIT = 5000;

/** The modules a module's blocks include, each once, in document order. */
export function refsOf(blocks: readonly Block[]): string[] {
  const refs = new Set<string>();
  for (const unit of unitsOf(blocks)) {
    if (unit.kind === 'moduleRef' && unit.text) refs.add(unit.text);
  }
  return [...refs];
}

/** A module as the graph holds it; null for a module file that cannot be read. */
export function toGraphModule(item: ModuleItem): GraphModule | null {
  if (!('blocks' in item.attributes)) return null; // a module file that cannot be read
  const a = item.attributes;
  const meta = item.meta as { status: ModuleStatus };
  return {
    id: a.moduleId,
    lang: a.lang,
    title: a.title,
    type: a.moduleType,
    facets: a.facets,
    blocks: a.blocks,
    status: meta.status,
    refs: refsOf(a.blocks),
  };
}

/**
 * The graph from the modules read in `lang` and in `source`: a module's `lang` version wins, its
 * `source` version stands in when there is none.
 */
export function graphOf(
  items: readonly ModuleItem[],
  lang: string,
  source: string,
  complete = true,
): ModuleGraph {
  const modules = new Map<string, GraphModule>();
  for (const pass of [source, lang]) {
    for (const item of items) {
      if (item.attributes.lang !== pass) continue;
      const module = toGraphModule(item);
      if (module) modules.set(module.id, module);
    }
  }
  return { modules, complete };
}

/**
 * The way from `from` to `target` along module references (`from`, …, `target`), or null when
 * there is none: including `from` where `target` is would close that way into a cycle. `from`
 * equal to `target` is the way `[target]` (a module including itself). `refsOf` gives a module's
 * references (null: no such module). Breadth first, so the way found is a shortest one; it stops
 * after `limit` modules and then answers null for what it did not reach; `abort` stops it before
 * the next read.
 */
export async function cyclePath(
  from: string,
  target: string,
  refs: (
    id: string,
  ) => readonly string[] | null | Promise<readonly string[] | null>,
  limit = CYCLE_SEARCH_LIMIT,
  abort?: AbortSignal,
): Promise<string[] | null> {
  if (from === target) return [target];
  const cameFrom = new Map<string, string | null>([[from, null]]);
  const queue = [from];
  while (queue.length > 0 && cameFrom.size <= limit) {
    const id = queue.shift() as string;
    const found = await refs(id);
    // Not wanted any more (another module chosen, the dialog closed): no further reads.
    if (abort?.aborted) return null;
    for (const next of found ?? []) {
      if (cameFrom.has(next)) continue;
      cameFrom.set(next, id);
      if (next === target) {
        const path = [next];
        for (let at = cameFrom.get(next); at; at = cameFrom.get(at) ?? null)
          path.unshift(at);
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

/**
 * Every module of the graph from which `target` can be reached along references (`target`
 * itself included): including any of them in `target` would make a cycle. Only meaningful for a
 * complete graph.
 */
export function reachingModules(
  graph: ModuleGraph,
  target: string,
): ReadonlySet<string> {
  const includedBy = new Map<string, string[]>();
  for (const module of graph.modules.values()) {
    for (const ref of module.refs) {
      const list = includedBy.get(ref);
      if (list) list.push(module.id);
      else includedBy.set(ref, [module.id]);
    }
  }
  const reached = new Set([target]);
  const queue = [target];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const by of includedBy.get(id) ?? []) {
      if (reached.has(by)) continue;
      reached.add(by);
      queue.push(by);
    }
  }
  return reached;
}

/** The modules that include `id` directly, by title. */
export function includedBy(
  graph: ModuleGraph,
  id: string,
): readonly GraphModule[] {
  return [...graph.modules.values()]
    .filter((m) => m.id !== id && m.refs.includes(id))
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** Reads every module in `lang` (and `source`, when it differs), page by page, into the graph. */
export async function loadModuleGraph(
  api: ApiClient,
  lang: string,
  source: string,
): Promise<ModuleGraph> {
  const items: ModuleItem[] = [];
  let complete = true;
  for (const l of new Set([lang, source])) {
    for (let number = 1; ; number += 1) {
      if (number > GRAPH_PAGES) {
        complete = false;
        break;
      }
      const page = await firstValueFrom(
        api.get('/modules', {
          query: {
            'filter[lang]': l,
            ...pageQuery({ number, size: GRAPH_PAGE_SIZE }),
          },
        }),
      );
      items.push(...page.data);
      if (number >= page.meta.page.lastPage) break;
    }
  }
  return graphOf(items, lang, source, complete);
}

/**
 * One module's references, read on its own (`GET /modules/:lang/:id`, in `lang`, else in
 * `source`): for a module an incomplete graph does not hold. Null when there is no such module
 * the person may see.
 */
export async function readModuleRefs(
  api: ApiClient,
  id: string,
  lang: string,
  source: string,
): Promise<readonly string[] | null> {
  for (const l of new Set([lang, source])) {
    const found = await firstValueFrom(
      api.get('/modules/{lang}/{id}', { path: { lang: l, id } }),
    ).catch((error: unknown) => {
      if ([403, 404].includes(toApiError(error).status)) return null;
      throw error;
    });
    if (found) return refsOf(found.data.attributes.blocks);
  }
  return null;
}
