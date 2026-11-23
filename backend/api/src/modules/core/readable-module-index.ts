import { Injectable } from '@nestjs/common';
import { Recent } from '../../base/core/recent.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import {
  type CommitIndex,
  type IndexedManual,
  type IndexedModule,
  ModuleIndex,
} from './module-index.js';
import { mergeVariantNames } from './variant-names.js';
import { compareTitles } from '../../base/core/compare-titles.js';

/** The most uses `meta.usedIn` names; `meta.usage` counts them all. */
export const MAX_USED_IN = 50;

/** How many readers' views of an index are kept in memory (per commit and reading key). */
export const VIEWS_KEPT = 64;

/** A manual or a module using a module. */
export interface ModuleUse {
  readonly kind: 'manual' | 'module';
  readonly id: string;
  readonly title: string;
  /**
   * A manual: true when one of its entries names the module, false when it
   * includes it only through module references. A module: always true (its
   * own reference block names it).
   */
  readonly direct: boolean;
  /**
   * It is deprecated (#266): a manual by its manifest, a module by its
   * source-language file (else its first file the reader sees).
   */
  readonly deprecated: boolean;
}

/** Where a module is used, as one reader sees it. */
export interface ModuleUsage {
  /** The manuals including it, directly or through module references. */
  readonly manuals: number;
  /** The modules whose reference blocks name it. */
  readonly modules: number;
  /** All of them: manuals first, then modules, each by title (then ID). */
  readonly uses: readonly ModuleUse[];
}

const UNUSED: ModuleUsage = { manuals: 0, modules: 0, uses: [] };

/** A module file linking a term (#245). */
export interface TermUse {
  readonly moduleId: string;
  readonly lang: string;
  readonly title: string;
}

/** Where a term is linked, as one reader sees it. */
export interface TermUsage {
  /** The module files (each language apart) linking it. */
  readonly modules: number;
  /** All of them, by title, then module ID and language. */
  readonly uses: readonly TermUse[];
}

const UNLINKED: TermUsage = { modules: 0, uses: [] };

/** A commit's module index as one reader may see it. */
export interface ReadableIndex {
  /** The module files the reader may see, by ID then language (`modules()`'s set). */
  readonly modules: readonly IndexedModule[];
  /**
   * The manifests the reader may see that can be read, by ID. Their
   * `variants` are what they name as the reader sees them: an entry's
   * condition counts only where the entry covers a module they may name
   * (one they may see, or one with no file), as a manifest served to them
   * leaves out the others; `entryVariants` is left out. A derived manual
   * gathering notices (#670) has the modules the reader's own gathering
   * gives (`ReadableContent.noticeManualModules`), and an entry's condition
   * counts only where it covers one of those.
   */
  readonly manuals: readonly IndexedManual[];
  /** Where a module (by ID, in any language) is used, counting only what the reader may see. */
  usage(id: string): ModuleUsage;
  /** Where a term is linked (#245): the module files the reader may see whose term links name it. */
  termUsage(id: string): TermUsage;
}

/**
 * The module index (`ModuleIndex`) filtered to what a reader may see
 * (`ReadableContent.judgeIndexed`): only modules and manuals they may see
 * are listed, named or counted as uses, and a use through module
 * references counts only where every module on the way is one they may
 * see, so neither a use nor a count says anything about what lies outside
 * their scope. Kept per commit and reading key.
 */
@Injectable()
export class ReadableModuleIndex {
  readonly #views = new Recent<ReadableIndex>(VIEWS_KEPT);

  constructor(private readonly index: ModuleIndex) {}

  of(snapshot: ReadableContent): Promise<ReadableIndex> {
    return this.#views.get(`${snapshot.commit}|${snapshot.readingKey}`, () =>
      this.view(snapshot),
    );
  }

  private async view(snapshot: ReadableContent): Promise<ReadableIndex> {
    const [index, judge, config, gathered] = await Promise.all([
      this.index.at(snapshot.commit),
      snapshot.judgeIndexed(snapshot.commit),
      snapshot.config(),
      // A notice gathering's modules, as the reader's own gathering gives them (#670): the
      // index's, gathered for everyone, would name a module whose only notice is in one they
      // may not see.
      snapshot.noticeManualModules(),
    ]);
    const modules = index.modules.filter((m) => judge.module(m));
    // A manifest may name a module the reader sees, or one with no file at all.
    const seen = new Set(modules.map((m) => m.id));
    const filed = new Set(index.modules.map((m) => m.id));
    const nameable = (id: string) => seen.has(id) || !filed.has(id);
    const manuals = index.manuals
      .filter((m) => m.error === undefined && judge.manual(m))
      .map(({ entryVariants, ...indexed }): IndexedManual => {
        const own = gathered.get(indexed.id);
        const m = own ? { ...indexed, modules: own } : indexed;
        if (!entryVariants) return m;
        // A notice gathering's conditions only where they cover a module it gathers for them.
        const mine = own && new Set(own);
        const counts = mine ? (id: string) => mine.has(id) : nameable;
        const variants = mergeVariantNames(
          m.variants,
          entryVariants
            .filter((e) => e.modules.some(counts))
            .map((e) => e.names),
        );
        const rest: IndexedManual = {
          id: m.id,
          ...(m.title !== undefined && { title: m.title }),
          ...(m.audience !== undefined && { audience: m.audience }),
          ...(m.deprecated && { deprecated: m.deprecated }),
          modules: m.modules,
        };
        return Object.keys(variants).length > 0 ? { ...rest, variants } : rest;
      });
    return usageOf(modules, manuals, config.languages.source);
  }
}

/** Uses among `modules` and `manuals`, all of which the reader may see. */
function usageOf(
  modules: readonly IndexedModule[],
  manuals: CommitIndex['manuals'],
  source: string,
): ReadableIndex {
  // A module's title: its source-language file's, else its first one's.
  const titles = new Map<string, string>();
  // Whether a module is deprecated: by the same file as its title.
  const deprecated = new Map<string, boolean>();
  // Module ID → the module IDs its readable files reference.
  const refs = new Map<string, Set<string>>();
  for (const m of modules) {
    if (!m.meta) continue;
    if (!titles.has(m.id) || m.lang === source) {
      titles.set(m.id, m.meta.title);
      deprecated.set(m.id, m.meta.deprecated !== undefined);
    }
    let found = refs.get(m.id);
    if (!found) refs.set(m.id, (found = new Set()));
    for (const ref of m.refs) if (ref !== m.id) found.add(ref);
  }
  const uses = new Map<string, ModuleUse[]>();
  const add = (id: string, use: ModuleUse) => {
    const found = uses.get(id);
    if (found) found.push(use);
    else uses.set(id, [use]);
  };
  for (const manual of manuals) {
    const direct = new Set(manual.modules);
    // Everything reachable through the references of readable modules.
    const reached = new Set<string>();
    const queue = [...direct];
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      for (const ref of refs.get(id) ?? []) {
        if (direct.has(ref) || reached.has(ref)) continue;
        reached.add(ref);
        queue.push(ref);
      }
    }
    const title = manual.title ?? manual.id;
    const manualDeprecated = manual.deprecated !== undefined;
    for (const [ids, isDirect] of [
      [direct, true],
      [reached, false],
    ] as const) {
      for (const id of ids) {
        add(id, {
          kind: 'manual',
          id: manual.id,
          title,
          direct: isDirect,
          deprecated: manualDeprecated,
        });
      }
    }
  }
  for (const [user, named] of refs) {
    const title = titles.get(user) ?? user;
    const userDeprecated = deprecated.get(user) ?? false;
    for (const id of named) {
      add(id, {
        kind: 'module',
        id: user,
        title,
        direct: true,
        deprecated: userDeprecated,
      });
    }
  }
  const usage = new Map<string, ModuleUsage>();
  for (const [id, found] of uses) {
    const sorted = found.sort(
      (a, b) =>
        (a.kind === b.kind ? 0 : a.kind === 'manual' ? -1 : 1) ||
        compareTitles(a.title, b.title) ||
        compare(a.id, b.id),
    );
    usage.set(id, {
      manuals: sorted.filter((u) => u.kind === 'manual').length,
      modules: sorted.filter((u) => u.kind === 'module').length,
      uses: sorted,
    });
  }
  const termUses = new Map<string, TermUse[]>();
  for (const m of modules) {
    if (!m.meta) continue;
    for (const term of m.terms ?? []) {
      const use = { moduleId: m.id, lang: m.lang, title: m.meta.title };
      const found = termUses.get(term);
      if (found) found.push(use);
      else termUses.set(term, [use]);
    }
  }
  const termUsage = new Map<string, TermUsage>();
  for (const [term, found] of termUses) {
    const sorted = found.sort(
      (a, b) =>
        compareTitles(a.title, b.title) ||
        compare(a.moduleId, b.moduleId) ||
        compare(a.lang, b.lang),
    );
    termUsage.set(term, { modules: sorted.length, uses: sorted });
  }
  return {
    modules,
    manuals,
    usage: (id) => usage.get(id) ?? UNUSED,
    termUsage: (id) => termUsage.get(id) ?? UNLINKED,
  };
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
