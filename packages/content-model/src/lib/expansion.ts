import type { Block } from './blocks.js';
import type { Module } from './module.js';
import { MAX_MODULE_TABLE_CELLS } from './table-limits.js';

/**
 * The limits on what content may expand to once its module references are included (#679),
 * and the counter that holds a walk to them. `resolveManual` counts a manual with it, `toChunks`
 * a module's chunks (#681): one counter per call, so nothing is shared between two readers.
 */

/**
 * The most content may expand to (#679), in content nodes: every object of a module's blocks
 * (a block, list item, step, table row and cell, inline node, mark, callout, …), counted each
 * time the module is included (a module referred to over several paths counts once per path,
 * as it appears once per path), and each module reference met. Past it, or past
 * `MAX_EXPANDED_CHARS`, the walk stops: a manual resolves to only an `expansion-too-large`
 * error, a chunk is refused with `ExpansionTooLargeError`. So content whose references
 * multiply (a diamond: two modules referring to the same one, both referred to by one, and so
 * on down) fails fast instead of holding the process. Over six times the largest manual
 * measured: the big manual of the scale generator's `xl` profile (`scripts/perf`, 1,600
 * modules, itself four times the size the product must stay fast at) has about 78,000, the
 * `large` profile's about 20,000; the sample content's manuals are tiny, and a chunk (one
 * module with what it includes) far smaller. The same everywhere, not a setting: whether
 * content resolves is the content's, not the deployment's.
 */
export const MAX_EXPANDED_NODES = 500_000;

/**
 * The most text content may expand to (#679), in characters: every string of a module's
 * blocks (text, IDs, …), counted each time the module is included, the values text attributes
 * fill in, and the messages of the module reference cycles met, so a few long texts reached
 * over many paths cannot pass `MAX_EXPANDED_NODES` unnoticed. A chunk also counts the titles
 * its cross-references show, the Markdown it writes around nested blocks (quotes, list
 * items, table cells), once per level, and each table's grid (#681). Over six times the scale generator's `xl` big
 * manual (about 1,900,000).
 */
export const MAX_EXPANDED_CHARS = 12_000_000;

/**
 * The deepest content may nest (#679): blocks inside blocks (a list in a note in a section,
 * …), a module reference counting one level for the module it includes. Deeper, the walk stops
 * as at `MAX_EXPANDED_NODES`: a chain of references thousands deep, or references inside
 * deeply nested blocks, would otherwise overflow the call stack here or in whatever walks the
 * result next. Real content nests a few levels, the scale generator's three.
 */
export const MAX_NESTING_DEPTH = 100;

/**
 * The most table cells content may expand to (#686): each table's grid, its rows times its
 * columns (a cell spanning several counted once per place it covers), counted each time its
 * module is included. A table is capped on its own (`MAX_TABLE_CELLS`, 50,000), but few cells
 * may span that whole area, so a manual referring to such tables many times would hand the
 * renderer tens of millions of grid places in a few thousand nodes. Twenty tables at the cap;
 * over seven times the scale generator's `xl` big manual even if each of its 1,600 modules held
 * its largest table (at most 85 places).
 */
export const MAX_EXPANDED_TABLE_CELLS = MAX_MODULE_TABLE_CELLS;

/**
 * The limits of #679 as one value: what `Expansion` holds a walk to, what
 * `ExpansionBudget.forContent` gives a set room for (`CHUNK_SET_MODULES_AT_LIMITS` modules at
 * them) and what `ExpansionTooLargeError`'s message names. Content is always held to
 * `EXPANSION_LIMITS`: another value is only for tests (#726), so they cross the same boundaries
 * with content a hundred times smaller. Not a setting.
 */
export interface ExpansionLimits {
  /** Content nodes (`MAX_EXPANDED_NODES`). */
  readonly nodes: number;
  /** Characters (`MAX_EXPANDED_CHARS`). */
  readonly chars: number;
  /** Table cells, rows × columns (`MAX_EXPANDED_TABLE_CELLS`). */
  readonly cells: number;
  /** Nesting depth (`MAX_NESTING_DEPTH`). */
  readonly depth: number;
}

/** The limits of #679, the only ones content is held to outside tests. */
export const EXPANSION_LIMITS: ExpansionLimits = Object.freeze({
  nodes: MAX_EXPANDED_NODES,
  chars: MAX_EXPANDED_CHARS,
  cells: MAX_EXPANDED_TABLE_CELLS,
  depth: MAX_NESTING_DEPTH,
});

/**
 * Content past one of the limits (`MAX_EXPANDED_NODES`, `MAX_EXPANDED_CHARS`, or with `depth`
 * `MAX_NESTING_DEPTH`; `limits`, `EXPANSION_LIMITS` but in tests): what `toChunks` throws, and
 * what `resolveManual` turns into its `expansion-too-large` issue.
 */
export class ExpansionTooLargeError extends Error {
  constructor(
    readonly depth: boolean,
    readonly limits: ExpansionLimits = EXPANSION_LIMITS,
  ) {
    super(
      depth
        ? `the content's blocks and module references nest more than ${limits.depth} deep`
        : `the content expands to more than ${limits.nodes.toLocaleString('en')} content nodes, ${limits.chars.toLocaleString('en')} characters or ${limits.cells.toLocaleString('en')} table cells (rows × columns) once its module references are included (a module referred to over several paths counts once per path)`,
    );
    this.name = 'ExpansionTooLargeError';
  }

  /** Which limit was passed: `depth` (`MAX_NESTING_DEPTH`) or `size` (the others). */
  get reason(): 'size' | 'depth' {
    return this.depth ? 'depth' : 'size';
  }
}

/** A weight of content: objects, characters and table cells (`weightOf`). */
export interface Weight {
  nodes: number;
  chars: number;
  cells: number;
}

/**
 * How many objects `value` holds, itself included, how many characters its strings, and how
 * many cells its tables' grids (rows × columns, #686).
 */
export function weightOf(value: unknown): Weight {
  let nodes = 0;
  let chars = 0;
  let cells = 0;
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    if (typeof next === 'string') chars += next.length;
    if (typeof next !== 'object' || next === null) continue;
    if (Array.isArray(next)) {
      for (const item of next) pending.push(item);
      continue;
    }
    nodes += 1;
    const { type, rows, columns } = next as Record<string, unknown>;
    if (type === 'table' && Array.isArray(rows) && Array.isArray(columns)) {
      cells += rows.length * columns.length;
    }
    for (const item of Object.values(next)) pending.push(item);
  }
  return { nodes, chars, cells };
}

/**
 * How many times the content's own weight a set of chunks may expand to (#684): the chunks of
 * every module of a commit together, each module counted as `toChunks` counts it (what it
 * includes, once per path, its FAQ entries again), against the summed weight (`weightOf`) of
 * the modules they are made from, in nodes, characters and table cells each. Each module is
 * held to the limits of #679 on its own, but a hundred small modules each referring to one
 * just under them would expand to over a billion characters together; the set stops at this
 * many times its content instead (`ExpansionBudget`), so its work and its text grow with the
 * content, never with how its references multiply. The scale generator's `xl` profile (77,000
 * module files across its 8 languages, 88,000,000 characters of content) expands to 1.4 times
 * its characters and 1.02 times its nodes and table cells, its most expanded module to under
 * 2 times its own; the `small` profile alike. The same everywhere, not a setting: whether
 * content can be cut is the content's, not the deployment's.
 */
export const MAX_CHUNK_SET_FACTOR = 4;

/**
 * The room a set of chunks has on top of `MAX_CHUNK_SET_FACTOR` times its content (#684), in
 * modules at the limits of #679: a module past them is left out of the chunks (#688), but its
 * walk spent up to `MAX_EXPANDED_NODES` and `MAX_EXPANDED_CHARS` before it stopped, and so
 * does a module just under them. So the modules a slip of an author makes too large (a diamond
 * of references 18 levels deep makes the modules of its top few levels so) leave out only
 * themselves; many more, in a commit of little content, make the set too
 * large.
 */
export const CHUNK_SET_MODULES_AT_LIMITS = 32;

/**
 * The room for the text a set of chunks keeps (#684), on top of `MAX_CHUNK_SET_FACTOR` times its
 * content's characters, in modules at `MAX_EXPANDED_CHARS`: what the modules that get a chunk
 * spent, a module left out not counted (its walk keeps nothing). Smaller than
 * `CHUNK_SET_MODULES_AT_LIMITS`, so a set of little content keeps at most 96,000,000 characters
 * however much work its left-out modules took. `ExpansionBudget.keptChars`.
 */
export const CHUNK_SET_KEPT_AT_LIMITS = 8;

/**
 * Walks that share an `ExpansionBudget` passed it together (#684): what `toChunks` throws when
 * the budget it was given is spent, in whichever module's walk passes it. Not an
 * `ExpansionTooLargeError`: no one module is too large, the walks together are.
 */
export class ExpansionBudgetError extends Error {
  constructor(readonly limit: Readonly<Weight>) {
    super(
      `the chunks together expand to more than ${limit.nodes.toLocaleString('en')} content nodes, ${limit.chars.toLocaleString('en')} characters or ${limit.cells.toLocaleString('en')} table cells (rows × columns)`,
    );
    this.name = 'ExpansionBudgetError';
  }
}

/**
 * What several walks together may expand to (#684), counted with the same counters as each
 * walk's `Expansion`: every node, character and table cell one counts is spent here too, so the
 * work and the text of a whole set of chunks stay within `limit`. Charging past it throws
 * `ExpansionBudgetError`, and every charge after does too. One per set, never shared between
 * two.
 */
export class ExpansionBudget {
  #nodes = 0;
  #chars = 0;
  #cells = 0;

  /**
   * @param limit what the walks may spend together
   * @param keptChars what the walks whose chunks are kept may spend in characters
   *   (`CHUNK_SET_KEPT_AT_LIMITS`); the caller holds it, as only it knows which are kept
   */
  constructor(
    readonly limit: Readonly<Weight>,
    readonly keptChars = limit.chars,
  ) {}

  /**
   * A set's budget: `MAX_CHUNK_SET_FACTOR` times the summed weight of the modules its chunks
   * are made from (each of `weights`), plus `CHUNK_SET_MODULES_AT_LIMITS` times the limits of
   * #679; of its characters, the kept chunks' at most `MAX_CHUNK_SET_FACTOR` times the
   * content's plus `CHUNK_SET_KEPT_AT_LIMITS` times `MAX_EXPANDED_CHARS` (`keptChars`). With
   * `limits` (tests only, #726), the room is that many modules at those instead.
   */
  static forContent(
    weights: Iterable<Readonly<Weight>>,
    limits: ExpansionLimits = EXPANSION_LIMITS,
  ): ExpansionBudget {
    const own: Weight = { nodes: 0, chars: 0, cells: 0 };
    for (const weight of weights) {
      own.nodes += weight.nodes;
      own.chars += weight.chars;
      own.cells += weight.cells;
    }
    const room = CHUNK_SET_MODULES_AT_LIMITS;
    return new ExpansionBudget(
      {
        nodes: own.nodes * MAX_CHUNK_SET_FACTOR + room * limits.nodes,
        chars: own.chars * MAX_CHUNK_SET_FACTOR + room * limits.chars,
        cells: own.cells * MAX_CHUNK_SET_FACTOR + room * limits.cells,
      },
      own.chars * MAX_CHUNK_SET_FACTOR +
        CHUNK_SET_KEPT_AT_LIMITS * limits.chars,
    );
  }

  /** What the walks have spent so far (a charge that passed the limit included). */
  get spent(): Weight {
    return { nodes: this.#nodes, chars: this.#chars, cells: this.#cells };
  }

  /** Spends nodes, characters and table cells; `ExpansionBudgetError` past the limit. */
  charge(nodes: number, chars: number, cells: number): void {
    this.#nodes += nodes;
    this.#chars += chars;
    this.#cells += cells;
    if (
      this.#nodes > this.limit.nodes ||
      this.#chars > this.limit.chars ||
      this.#cells > this.limit.cells
    ) {
      throw new ExpansionBudgetError(this.limit);
    }
  }
}

/**
 * What one walk over content has expanded to so far, held to the limits (`limits`:
 * `EXPANSION_LIMITS` but in tests, #726): each method throws `ExpansionTooLargeError` once a
 * limit is passed. One per walk, never shared; with a `budget`
 * (#684), each count is also spent there, and `ExpansionBudgetError` thrown once it is spent
 * (checked first, so a walk past both reports the budget).
 */
export class Expansion {
  #nodes = 0;
  #chars = 0;
  #nesting = 0;
  #cells = 0;
  /** A module's weight (`weightOf` its blocks), worked out once, counted per inclusion. */
  readonly #weights = new Map<Module, Weight>();

  constructor(
    private readonly budget?: ExpansionBudget,
    readonly limits: ExpansionLimits = EXPANSION_LIMITS,
  ) {}

  /**
   * Counts content nodes, characters and table cells (`MAX_EXPANDED_NODES`,
   * `MAX_EXPANDED_CHARS`, `MAX_EXPANDED_TABLE_CELLS`).
   */
  grow(nodes: number, chars = 0, cells = 0): void {
    this.budget?.charge(nodes, chars, cells);
    this.#nodes += nodes;
    this.#chars += chars;
    this.#cells += cells;
    if (
      this.#nodes > this.limits.nodes ||
      this.#chars > this.limits.chars ||
      this.#cells > this.limits.cells
    ) {
      throw new ExpansionTooLargeError(false, this.limits);
    }
  }

  /** Counts a module's blocks, once for each time it is included. */
  weigh(module: Module): void {
    let weight = this.#weights.get(module);
    if (weight === undefined) {
      weight = weightOf(module.blocks);
      this.#weights.set(module, weight);
    }
    this.grow(weight.nodes, weight.chars, weight.cells);
  }

  /**
   * Counts one block of a module (`weightOf` it), once for each time it is included alone: a
   * module reference to one block (#223) counts that block, as one to the whole module counts
   * the module.
   */
  weighBlock(block: Block): void {
    let weight = this.#blockWeights.get(block);
    if (weight === undefined) {
      weight = weightOf(block);
      this.#blockWeights.set(block, weight);
    }
    this.grow(weight.nodes, weight.chars, weight.cells);
  }

  /** A block's weight (`weighBlock`), worked out once, counted per inclusion. */
  readonly #blockWeights = new Map<Block, Weight>();

  /** Runs `go` one level deeper (`MAX_NESTING_DEPTH`): for each list of blocks walked into. */
  nested<T>(go: () => T): T {
    if (this.#nesting >= this.limits.depth) {
      throw new ExpansionTooLargeError(true, this.limits);
    }
    this.#nesting += 1;
    try {
      return go();
    } finally {
      this.#nesting -= 1;
    }
  }
}
