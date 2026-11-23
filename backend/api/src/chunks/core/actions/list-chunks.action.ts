import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  evaluateCondition,
  ExpansionBudget,
  ExpansionBudgetError,
  ExpansionTooLargeError,
  toChunks,
  type Chunk,
  type ExpansionLimits,
  type ManifestEntry,
  type Module,
  type ProjectConfig,
  type VariantValues,
  type Weight,
  weightOf,
} from '@openfolia/content-model';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction, authorize } from '../../../access/core/policy.js';
import { readingKey } from '../../../access/core/reading-scope.js';
import {
  ForbiddenError,
  InvalidParameterError,
  UnavailableError,
} from '../../../base/core/errors.js';
import {
  paginate,
  type PageRequest,
  type Paginated,
} from '../../../base/core/paging.js';
import { OneAtATime } from '../../../base/core/one-at-a-time.js';
import { Recent } from '../../../base/core/recent.js';
import { subjectOfPath } from '../../../change-sets/core/subject-kinds.js';
import {
  foldedKeywords,
  hasKeywords,
  matchesClassification,
  matchesModuleFilter,
  type ModuleFilter,
} from '../../../content/core/module-filter.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import { checkVariant } from '../../../preview/core/actions/preview-module.action.js';
import {
  ChunkSetTooLargeError,
  LARGEST_NAMED,
  type SpentModule,
} from '../chunk-set-too-large.js';
import { ContentChanges } from '../content-changes.js';
import {
  EXPANSION_LIMITS_TOKEN,
  expansionLimitsOf,
} from '../expansion-limits.js';

/** How many sets of chunks (per commit and reading key) are kept. */
export const CHUNK_SETS_KEPT = 8;

/**
 * The most characters the kept sets may hold together (#684), counted as their chunks counted
 * them (`ExpansionBudget`; the modules left out, which keep nothing, not counted): past it, the least recently used are dropped, the newest kept
 * whatever it holds. Two sets of the scale generator's `xl` profile (about 123,000,000 each),
 * eight of the `large`.
 */
export const CHUNK_SETS_KEPT_CHARS = 250_000_000;

/**
 * How many verdicts of sets made only to tell whether they fit (`tooLarge`, #710) are kept, per
 * commit and reading key: a set that fits is not kept for it, only that it fits.
 */
export const CHUNK_SET_VERDICTS_KEPT = 64;

/**
 * How many chunk sets built for a verdict (`tooLarge`, #710) may wait (or be built) at once,
 * across all requests: they are built one at a time, and past this many the checks asking are
 * 503 `chunk-sets-busy` (`Retry-After`), so many heads checked at once never build many sets of
 * a whole commit together.
 */
export const CHUNK_SET_BUILDS_WAITING = 4;

/** A chunk with the manuals that name its module, as the reader may see them. */
export interface ListedChunk extends Chunk {
  /** IDs of the manuals that include the module (name it, within their audience), sorted. */
  manuals: string[];
}

/**
 * A module left out of the chunks (#688): with what it includes, as the reader sees it, it
 * passes one of the limits of #679, so it has no chunk (nor its FAQ entries) and every other
 * module is chunked as usual.
 */
export interface LeftOutModule {
  readonly moduleId: string;
  readonly lang: string;
  /**
   * `size`: past `MAX_EXPANDED_NODES` or `MAX_EXPANDED_CHARS`; `depth`: past
   * `MAX_NESTING_DEPTH`.
   */
  readonly reason: 'size' | 'depth';
}

/** A page of chunks, and the modules left out of what it lists from. */
export interface ChunkList extends Paginated<ListedChunk> {
  /**
   * The modules the request's filters ask for (but `changedSince`) that are left out, in
   * module ID, then language order; absent when there is none. Only modules the reader may
   * see: a hidden one is never there to be left out. With `variant`, a module too large for
   * it alone is added on the page holding its chunks (and stays counted in `total`).
   */
  readonly leftOut?: readonly LeftOutModule[];
}

export interface ChunkFilter extends ModuleFilter {
  /** Only chunks of this module (by ID), in each language the reader may read it in. */
  readonly module?: string | undefined;
  /** Only chunks in this language. */
  readonly lang?: string | undefined;
  /** Only modules the manual names (for `variant`: the entries it includes for it). */
  readonly manual?: string | undefined;
  /** Variant blocks resolved for this variant; without, kept with their conditions. */
  readonly variant?: VariantValues | undefined;
  /** Only chunks whose text or metadata may have changed since this commit (a full ID). */
  readonly changedSince?: string | undefined;
}

interface Input {
  readonly actor: Actor;
  readonly snapshot: ReadableContent;
  readonly filter: ChunkFilter;
  readonly page: PageRequest;
}

/** The chunks of one commit as one reader sees them, with what each was made from. */
interface ChunkSet {
  readonly chunks: readonly ListedChunk[];
  /** Per manual the reader may read: what it names (as the reader sees it). */
  readonly manuals: ReadonlyMap<string, ManualScope>;
  /** The modules the reader may see, by `<lang>/<id>`: what chunks are made from. */
  readonly modules: ReadonlyMap<string, Module>;
  /** The modules left out (#688), in module ID, then language order, with why. */
  readonly leftOut: readonly {
    readonly module: Module;
    readonly reason: LeftOutModule['reason'];
  }[];
  /** What each module with chunks spent of the set's budget (#684), by `<lang>/<id>`. */
  readonly spentBy: ReadonlyMap<string, Readonly<Weight>>;
  /**
   * The characters those modules spent together: what the kept sets weigh
   * (`CHUNK_SETS_KEPT_CHARS`), a module left out not counted, as it keeps nothing.
   */
  readonly keptChars: number;
}

/** A set past its budget (#684), kept as such so asking again costs nothing. */
interface TooLargeSet {
  readonly tooLarge: ChunkSetTooLargeError;
}

/**
 * One page of the retrieval chunks the actor may read at `snapshot`: one
 * per module and language, ordered by module ID, then language, each
 * followed by one per FAQ entry in it, in document order (`entry`; with
 * `variant`, only the entries whose surrounding variant blocks hold for
 * it, left out before paging). Built from
 * `ReadableContent` only, so a module outside the reader's scope is never
 * a chunk, never counted and never included in another's text; the filters
 * run before paging.
 *
 * `changedSince` (a commit in the history of the one read; else 400
 * `invalid-parameter`) keeps the chunks whose text or metadata may differ
 * from that commit's: a module file it was made from changed (its own or
 * one it includes), a readable file of a module it depends on changed
 * (`Chunk.dependsOn`), the configuration changed (labels, audiences), or a
 * manifest naming the module changed. Only files the reader may read now
 * count, so nothing is told of one outside their scope: a chunk whose
 * included module was deleted (or lost its translation, or left the
 * scope) since is not listed for it, nor is a deleted module; a full sync
 * catches those.
 *
 * A module whose chunks pass the limits of #679 (references that multiply, or nest too deep;
 * counted over what the reader may see, each module on a count of its own) is left out, and
 * only it (#688): listed in `leftOut` where the filters ask for it, never counted in `total`.
 */
@Injectable()
export class ListChunksAction extends ActorAction<Input, ChunkList> {
  readonly policy = 'content.read';
  /** The sets, with what each left out (#688), or past their budget (#684). */
  readonly #sets = new Recent<ChunkSet | TooLargeSet>(CHUNK_SETS_KEPT, {
    maxWeight: CHUNK_SETS_KEPT_CHARS,
    weigh: (set) => ('tooLarge' in set ? 0 : set.keptChars),
  });

  /**
   * Whether the sets asked of by `tooLarge` (#710) fit: `undefined` for one that does, its
   * refusal for one that does not. Apart from `#sets`, so checking heads never pushes out the
   * sets readers are served from; `GET /chunks` answers a refusal kept here without work.
   */
  readonly #verdicts = new Recent<ChunkSetTooLargeError | undefined>(
    CHUNK_SET_VERDICTS_KEPT,
  );
  /** The sets built for a verdict, one at a time (`CHUNK_SET_BUILDS_WAITING`). */
  readonly #building = new OneAtATime(
    CHUNK_SET_BUILDS_WAITING,
    () =>
      new UnavailableError(
        'chunk-sets-busy',
        'Too many checks are cutting the chunks of a whole commit; try again later.',
        30,
      ),
  );

  /**
   * The limits of #679 each module's chunks are cut to, and the set's budget gives room for:
   * the content model's `EXPANSION_LIMITS`, smaller only in tests (#726,
   * `EXPANSION_LIMITS_TOKEN`, which no module of the app provides).
   */
  readonly #limits: ExpansionLimits;

  constructor(
    private readonly changes: ContentChanges,
    @Optional()
    @Inject(EXPANSION_LIMITS_TOKEN)
    limits?: ExpansionLimits,
  ) {
    super();
    this.#limits = expansionLimitsOf(limits);
  }

  protected async run({ snapshot, filter, page }: Input): Promise<ChunkList> {
    const config = await snapshot.config();
    if (filter.variant) checkVariant(filter.variant, config);
    const changed =
      filter.changedSince === undefined
        ? undefined
        : await this.changedSince(snapshot, filter.changedSince);
    // Kept without a variant: any number of variants share one set, and a
    // variant's text is made only for the page asked for.
    const set = await this.#setOf(snapshot, config);
    const inManual =
      filter.manual === undefined
        ? undefined
        : await manualScope(snapshot, config, filter.manual, filter.variant);
    const lookup = changed && lookupOf(changed, set, config.languages.source);
    const versionAttributes = new Set(
      config.variantAttributes
        .filter((a) => a.kind === 'version')
        .map((a) => a.id),
    );
    const audiences = config.audiences.map((a) => a.id);
    const listed = set.chunks.filter(
      (chunk) =>
        (filter.module === undefined || chunk.moduleId === filter.module) &&
        (filter.lang === undefined || chunk.lang === filter.lang) &&
        matchesClassification(
          {
            type: chunk.moduleType,
            audience: chunk.audience,
            facets: chunk.facets,
          },
          filter,
          audiences,
        ) &&
        hasKeywords(foldedKeywords(chunk), filter) &&
        (inManual === undefined || includes(inManual, chunk, config)) &&
        (lookup === undefined || changedFor(chunk, lookup)) &&
        // An FAQ entry in a variant block the variant leaves out has no text.
        (filter.variant === undefined ||
          (chunk.entry?.within ?? []).every((when) =>
            evaluateCondition(when, filter.variant as VariantValues, {
              versionAttributes,
            }),
          )),
    );
    const result = paginate(listed, page);
    const leftOut: LeftOutModule[] = set.leftOut
      .filter(
        ({ module }) =>
          (filter.module === undefined || module.id === filter.module) &&
          (filter.lang === undefined || module.meta.lang === filter.lang) &&
          matchesModuleFilter(module.meta, filter, audiences) &&
          (inManual === undefined ||
            includes(
              inManual,
              { moduleId: module.id, audience: module.meta.audience },
              config,
            )),
      )
      .map(({ module, reason }) => ({
        moduleId: module.id,
        lang: module.meta.lang,
        reason,
      }));
    const { variant } = filter;
    if (!variant) return withLeftOut(result, leftOut);
    // Each module of the page made once for the variant, its chunk and its entries' together
    // (#681: a page of a module's entries costs one module, not one per entry).
    const forVariant = new Map<string, Chunk[] | ExpansionTooLargeError>();
    const items: ListedChunk[] = [];
    for (const chunk of result.items) {
      const key = `${chunk.lang}/${chunk.moduleId}`;
      const module = set.modules.get(key);
      if (!module) {
        items.push(chunk);
        continue;
      }
      let chunks = forVariant.get(key);
      if (!chunks) {
        try {
          // Each module's text for the variant on a budget of its own (#684), so one far
          // longer for it never takes another's room.
          const budget = new ExpansionBudget(
            variantBudget(set.spentBy.get(key)),
          );
          chunks = chunksOf(
            module,
            set.modules,
            config,
            budget,
            this.#limits,
            variant,
          );
        } catch (error) {
          // Far longer for the variant than without it: left out of the page, as one past a
          // limit of #679 for it alone.
          if (!(error instanceof ExpansionBudgetError)) throw error;
          chunks = new ExpansionTooLargeError(false, this.#limits);
        }
        forVariant.set(key, chunks);
        // Past a limit for this variant alone (a hidden callout's `[callout]` can be longer
        // than its legend): left out of this page as of the set.
        if (chunks instanceof ExpansionTooLargeError) {
          leftOut.push({
            moduleId: module.id,
            lang: module.meta.lang,
            reason: chunks.reason,
          });
        }
      }
      if (chunks instanceof ExpansionTooLargeError) continue;
      const { entry } = chunk;
      const made = entry
        ? chunks.find((c) => c.entry?.blockId === entry.blockId)
        : chunks[0];
      items.push(made ? { ...made, manuals: chunk.manuals } : chunk);
    }
    leftOut.sort(
      (a, b) => codeUnits(a.moduleId, b.moduleId) || codeUnits(a.lang, b.lang),
    );
    return withLeftOut({ ...result, items }, leftOut);
  }

  /**
   * The kept set of `snapshot`'s commit and reading key, made when there is none; 422
   * `chunk-set-too-large` for one past its budget (#684), kept as such.
   */
  async #setOf(
    snapshot: ReadableContent,
    config: ProjectConfig,
  ): Promise<ChunkSet> {
    const key = [snapshot.commit, snapshot.readingKey].join('|');
    // A refusal a verdict found (#710) costs no work here either.
    const verdict = this.#verdicts.peek(key);
    if (verdict) {
      const refused = await verdict.catch(() => undefined);
      if (refused) throw refused;
    }
    const set = await this.#sets.get(key, () =>
      chunkSet(snapshot, config, this.#limits),
    );
    if ('tooLarge' in set) throw set.tooLarge;
    return set;
  }

  /**
   * Whether the chunks of `snapshot`'s commit, as its reader sees them, are too large together
   * (#684): their refusal (`meta.largest` naming only modules that reader may see), or
   * `undefined` when they fit. For the checks of a change set's head (#710). The set is cut as
   * `GET /chunks` cuts it, to the same budget, or taken from the kept sets. What it finds is
   * kept only as a verdict (`CHUNK_SET_VERDICTS_KEPT`), never in the kept sets, so checking
   * many heads never pushes out the sets readers of releases are served from; content read
   * through an overlay is kept nowhere. Sets are built for it one at a time, at most
   * `CHUNK_SET_BUILDS_WAITING` waiting: past that, 503 `chunk-sets-busy`.
   */
  async tooLarge(
    snapshot: ReadableContent,
  ): Promise<ChunkSetTooLargeError | undefined> {
    const verdictOf = async () => {
      const set = await this.#building.run(async () =>
        chunkSet(snapshot, await snapshot.config(), this.#limits),
      );
      return 'tooLarge' in set ? set.tooLarge : undefined;
    };
    if (snapshot.overlaid) return verdictOf();
    const key = [snapshot.commit, snapshot.readingKey].join('|');
    const kept = this.#sets.peek(key);
    if (kept) {
      const set = await kept;
      return 'tooLarge' in set ? set.tooLarge : undefined;
    }
    return this.#verdicts.get(key, verdictOf);
  }

  /**
   * Every chunk `actor` may read in `snapshot`, with the modules they were made from (by
   * `<lang>/<id>`), from the same kept sets as the list: for the change feed (#43), which
   * compares two of them. Under the action's policy, as `handle` (#527: it was called
   * without it): `actor` needs `content.read`, and `snapshot` must be opened for them
   * (`OpenSnapshotAction` as that actor, `content.read`, no overlay), so it holds only what they
   * may see; anything else is 403 before any chunk is cut.
   */
  async everyChunk({
    actor,
    snapshot,
  }: {
    readonly actor: Actor;
    readonly snapshot: ReadableContent;
  }): Promise<{
    readonly chunks: readonly ListedChunk[];
    readonly modules: ReadonlyMap<string, Module>;
    readonly source: string;
  }> {
    authorize(actor, this.policy);
    if (
      snapshot.overlaid ||
      snapshot.permission !== this.policy ||
      snapshot.readingKey !== readingKey(actor, this.policy)
    ) {
      throw new ForbiddenError(
        'The content was not opened for this reader: their chunks are read from their own content.',
      );
    }
    const config = await snapshot.config();
    const set = await this.#setOf(snapshot, config);
    return {
      chunks: set.chunks,
      modules: set.modules,
      source: config.languages.source,
    };
  }

  /** What changed between `since` and the commit read; 400 when `since` is not in its history. */
  private async changedSince(
    snapshot: ReadableContent,
    since: string,
  ): Promise<Changed> {
    if (!(await this.changes.contains(snapshot.commit, since))) {
      throw new InvalidParameterError(
        'filter[changedSince]',
        'Not a commit in the history of the content read: give a commit ID a response named in `X-Ccms-Commit`.',
      );
    }
    const changed: Changed = {
      config: false,
      modules: new Set(),
      manuals: new Set(),
    };
    for (const path of await this.changes.changedPaths(
      since,
      snapshot.commit,
    )) {
      const subject = subjectOfPath(path);
      if (subject?.type === 'config') changed.config = true;
      if (subject?.type === 'module') {
        changed.modules.add(`${subject.lang}/${subject.moduleId}`);
      }
      if (subject?.type === 'manual') changed.manuals.add(subject.manualId);
    }
    return changed;
  }
}

interface Changed {
  config: boolean;
  /** `<lang>/<moduleId>` of the module files that changed. */
  modules: Set<string>;
  manuals: Set<string>;
}

/** What `changedSince` compares chunks with, worked out once per request. */
interface ChangedLookup {
  readonly config: boolean;
  readonly files: ReadonlySet<string>;
  /** Module ID → the languages of its changed files the reader may see now. */
  readonly readable: ReadonlyMap<string, ReadonlySet<string>>;
  /** The modules a changed manifest the reader may read names. */
  readonly named: ReadonlySet<string>;
  readonly source: string;
}

function lookupOf(
  changed: Changed,
  set: ChunkSet,
  source: string,
): ChangedLookup {
  const readable = new Map<string, Set<string>>();
  for (const key of changed.modules) {
    const module = set.modules.get(key);
    if (!module) continue;
    const langs = readable.get(module.id) ?? new Set<string>();
    langs.add(module.meta.lang);
    readable.set(module.id, langs);
  }
  const named = new Set<string>();
  for (const id of changed.manuals) {
    for (const m of set.manuals.get(id)?.modules ?? []) named.add(m);
  }
  return {
    config: changed.config,
    files: changed.modules,
    readable,
    named,
    source,
  };
}

/**
 * Whether a chunk may differ since: a file it was made from changed, or
 * one the reader may see now of a module it depends on (a translation or
 * a module that appeared, one now within the audience, a cross-reference
 * target's title), the configuration, or a manifest naming its module.
 * Costs its sources and dependencies, never the number of changed files.
 */
function changedFor(chunk: ListedChunk, changed: ChangedLookup): boolean {
  return (
    changed.config ||
    chunk.sources.some((s) => changed.files.has(`${s.lang}/${s.moduleId}`)) ||
    // A module is read in the chunk's language, else in the source language.
    chunk.dependsOn.some((id) => {
      const langs = changed.readable.get(id);
      return (
        langs !== undefined &&
        (langs.has(chunk.lang) || langs.has(changed.source))
      );
    }) ||
    changed.named.has(chunk.moduleId)
  );
}

/** `list` with `leftOut` when there is any. */
function withLeftOut(
  list: Paginated<ListedChunk>,
  leftOut: readonly LeftOutModule[],
): ChunkList {
  return leftOut.length === 0 ? list : { ...list, leftOut };
}

/**
 * A module's chunk and its FAQ entries' (`toChunks`), including only modules in `modules` (what
 * the reader may see), on a count of their own; the error past the limits of #679 (#681), for
 * the module to be left out (#688). Every count is spent from `budget` too: past it,
 * `ExpansionBudgetError` (#684). Held to `limits` (the content model's `EXPANSION_LIMITS` but in
 * tests, #726).
 */
function chunksOf(
  module: Module,
  modules: ReadonlyMap<string, Module>,
  config: ProjectConfig,
  budget: ExpansionBudget,
  limits: ExpansionLimits,
  variant?: VariantValues,
): Chunk[] | ExpansionTooLargeError {
  try {
    return toChunks({
      module,
      config,
      loadModule: (id, lang) => modules.get(`${lang}/${id}`),
      budget,
      limits,
      ...(variant && { variant }),
    });
  } catch (error) {
    if (error instanceof ExpansionTooLargeError) return error;
    throw error;
  }
}

/**
 * The chunks without a variant (every variant block kept): their sources
 * are those of every variant, so `changedSince` holds for each.
 *
 * All of them are held to one budget (#684, `ExpansionBudget.forContent` over the modules the
 * reader may see): each module's walk spends from it, a module left out (#688) as far as it
 * was walked, and what the modules that get chunks spend is held to its `keptChars` too.
 * Past either, the set stops there, with the error naming the modules that spent the most
 * (`LARGEST_NAMED`).
 */
async function chunkSet(
  snapshot: ReadableContent,
  config: ProjectConfig,
  limits: ExpansionLimits,
): Promise<ChunkSet | TooLargeSet> {
  const [listing, manuals] = await Promise.all([
    snapshot.modules(),
    manualScopes(snapshot, config),
  ]);
  const modules = new Map<string, Module>();
  for (const entry of listing) {
    if ('module' in entry)
      modules.set(`${entry.lang}/${entry.id}`, entry.module);
  }
  const budget = ExpansionBudget.forContent(
    [...modules.values()].map((module) => weightOf(module.blocks)),
    limits,
  );
  const leftOut: ChunkSet['leftOut'][number][] = [];
  const largest: SpentModule[] = [];
  const spentBy = new Map<string, Weight>();
  let keptChars = 0;
  const chunks: ListedChunk[] = [];
  const sorted = [...modules.values()].sort(
    (a, b) => codeUnits(a.id, b.id) || codeUnits(a.meta.lang, b.meta.lang),
  );
  for (const module of sorted) {
    const before = budget.spent;
    let made: Chunk[] | ExpansionTooLargeError;
    try {
      // Only what the reader may see is there to include.
      made = chunksOf(module, modules, config, budget, limits);
    } catch (error) {
      if (!(error instanceof ExpansionBudgetError)) throw error;
      noteSpent(largest, module, before, budget.spent);
      return {
        tooLarge: new ChunkSetTooLargeError(budget.limit, largest),
      };
    }
    const after = budget.spent;
    noteSpent(largest, module, before, after);
    if (made instanceof ExpansionTooLargeError) {
      leftOut.push({ module, reason: made.reason });
      continue;
    }
    const spent = {
      nodes: after.nodes - before.nodes,
      chars: after.chars - before.chars,
      cells: after.cells - before.cells,
    };
    spentBy.set(`${module.meta.lang}/${module.id}`, spent);
    // The text kept, held apart: left-out modules' walks may take the rest of the budget.
    keptChars += spent.chars;
    if (keptChars > budget.keptChars) {
      return {
        tooLarge: new ChunkSetTooLargeError(
          { ...budget.limit, chars: budget.keptChars },
          largest,
          true,
        ),
      };
    }
    const [own, ...entries] = made;
    if (!own) continue;
    const including = [...manuals]
      .filter(([, manual]) => includes(manual, own, config))
      .map(([id]) => id)
      .sort(codeUnits);
    for (const chunk of [own, ...entries]) {
      chunks.push({ ...chunk, manuals: including });
    }
  }
  return {
    chunks,
    manuals,
    modules,
    leftOut,
    spentBy,
    keptChars,
  };
}

/**
 * A little room a module's text for a variant has on top of twice its text without one (#684,
 * `variantBudget`), for a small module whose few callouts show `[callout]` for longer legends.
 */
export const VARIANT_SLACK: Readonly<Weight> = {
  nodes: 10_000,
  chars: 100_000,
  cells: 10_000,
};

/**
 * The budget of a module's text for a variant (#684): twice what it spent of the set's without
 * one (a hidden callout's `[callout]` can be longer than its legend), plus `VARIANT_SLACK`. A
 * page of `n` modules then costs at most about twice the text it is made from plus `n` times
 * the slack, never the whole set, and a module past it is left out of that page alone.
 */
export function variantBudget(
  spent: Readonly<Weight> | undefined,
): Readonly<Weight> {
  return {
    nodes: 2 * (spent?.nodes ?? 0) + VARIANT_SLACK.nodes,
    chars: 2 * (spent?.chars ?? 0) + VARIANT_SLACK.chars,
    cells: 2 * (spent?.cells ?? 0) + VARIANT_SLACK.cells,
  };
}

/**
 * Keeps `largest` the `LARGEST_NAMED` modules that spent the most characters (then nodes), most
 * first, with `module`'s spending from `before` to `after`.
 */
function noteSpent(
  largest: SpentModule[],
  module: Module,
  before: Readonly<Weight>,
  after: Readonly<Weight>,
): void {
  const spent: SpentModule = {
    moduleId: module.id,
    lang: module.meta.lang,
    chars: after.chars - before.chars,
    nodes: after.nodes - before.nodes,
  };
  const smallest = largest[LARGEST_NAMED - 1];
  if (smallest && !moreThan(spent, smallest)) return;
  largest.push(spent);
  largest.sort((a, b) => (moreThan(a, b) ? -1 : moreThan(b, a) ? 1 : 0));
  largest.length = Math.min(largest.length, LARGEST_NAMED);
}

function moreThan(a: SpentModule, b: SpentModule): boolean {
  return a.chars !== b.chars ? a.chars > b.chars : a.nodes > b.nodes;
}

/** A manual as chunks use it: the modules it names, and the most restricted audience it includes. */
interface ManualScope {
  readonly modules: ReadonlySet<string>;
  /** Rank of the manual's audience (0: least restricted); -1 for one not configured. */
  readonly maxAudience: number;
}

/** Whether a manual includes the chunk's module: named, and within its audience. */
function includes(
  manual: ManualScope,
  chunk: Pick<Chunk, 'moduleId' | 'audience'>,
  config: ProjectConfig,
) {
  const rank = audienceRank(chunk.audience, config);
  return (
    manual.modules.has(chunk.moduleId) &&
    rank !== undefined &&
    rank <= manual.maxAudience
  );
}

function audienceRank(
  id: string | undefined,
  config: ProjectConfig,
): number | undefined {
  if (id === undefined) return config.audiences.length - 1;
  const rank = config.audiences.findIndex((a) => a.id === id);
  return rank === -1 ? undefined : rank;
}

function scopeOf(
  manifest: {
    audience?: string | undefined;
    entries: readonly ManifestEntry[];
  },
  config: ProjectConfig,
  included: (entry: ManifestEntry) => boolean,
): ManualScope {
  const modules = new Set<string>();
  collect(manifest.entries, modules, included);
  // As resolving does: no audience, every level; one not configured, none.
  const maxAudience =
    manifest.audience === undefined
      ? Infinity
      : (audienceRank(manifest.audience, config) ?? -1);
  return { modules, maxAudience };
}

/** Per manual the reader may read: the modules its manifest names to them. */
async function manualScopes(
  snapshot: ReadableContent,
  config: ProjectConfig,
): Promise<Map<string, ManualScope>> {
  const scopes = new Map<string, ManualScope>();
  for (const listing of await snapshot.manuals()) {
    if (!('manifest' in listing)) continue;
    scopes.set(
      listing.id,
      scopeOf(listing.manifest, config, () => true),
    );
  }
  return scopes;
}

/**
 * The manual `filter[manual]` names, as the reader may read it; for a
 * variant, only the entries whose conditions hold for it. Names nothing
 * for a manual the reader may not see, or that does not exist: a filter
 * matching nothing, so it tells nothing of what lies outside the scope.
 */
async function manualScope(
  snapshot: ReadableContent,
  config: ProjectConfig,
  id: string,
  variant: VariantValues | undefined,
): Promise<ManualScope> {
  const manual = await snapshot.manual(id);
  if (!manual) return { modules: new Set(), maxAudience: -1 };
  const versionAttributes = new Set(
    config.variantAttributes
      .filter((a) => a.kind === 'version')
      .map((a) => a.id),
  );
  return scopeOf(manual.manifest, config, (entry) =>
    variant === undefined || entry.when === undefined
      ? true
      : evaluateCondition(entry.when, variant, { versionAttributes }),
  );
}

function collect(
  entries: readonly ManifestEntry[],
  into: Set<string>,
  included: (entry: ManifestEntry) => boolean,
): void {
  for (const entry of entries) {
    if (!included(entry)) continue;
    if ('entries' in entry) collect(entry.entries, into, included);
    else into.add(entry.module);
  }
}

/** Code-unit order, so the order does not depend on the locale. */
function codeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
