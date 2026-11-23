import {
  CHUNK_SET_KEPT_AT_LIMITS,
  CHUNK_SET_MODULES_AT_LIMITS,
  MAX_CHUNK_SET_FACTOR,
  type Weight,
} from '@openfolia/content-model';
import { UnprocessableError } from '../../base/core/errors.js';

/** How many of the modules that spent the most a refusal names (`meta.largest`). */
export const LARGEST_NAMED = 5;

/** A module of a chunk set, with what its chunks expanded to (`meta.largest`). */
export interface SpentModule {
  readonly moduleId: string;
  readonly lang: string;
  /** The characters its chunks counted (`toChunks`), as far as they were walked. */
  readonly chars: number;
  /** The content nodes they counted. */
  readonly nodes: number;
}

/**
 * 422 `chunk-set-too-large` (#684): the chunks of a commit, as one reader sees them, together
 * expand past their budget (`ExpansionBudget.forContent`: `MAX_CHUNK_SET_FACTOR` times the
 * content they are made from, plus room for `CHUNK_SET_MODULES_AT_LIMITS` modules at the
 * limits of #679), so none of them is listed: no module is too large on its own, many are
 * together. `meta` holds the budget and the modules that spent the most of it so far, among
 * those the reader may see (`largest`, most first).
 */
export class ChunkSetTooLargeError extends UnprocessableError {
  override readonly code = 'chunk-set-too-large';

  constructor(
    readonly limit: Readonly<Weight>,
    readonly largest: readonly SpentModule[],
    /** Whether the room for the text kept was passed (`chars` is then that room). */
    readonly kept = false,
  ) {
    super(
      'chunk-set-too-large',
      `The chunks of this commit are too large to cut together: once their module references are included ${
        kept
          ? `the chunks kept hold more than ${limit.chars.toLocaleString('en')} characters, ${MAX_CHUNK_SET_FACTOR} times the content they are made from plus room for ${CHUNK_SET_KEPT_AT_LIMITS} modules at the limits of one`
          : `they expand to more than ${limit.nodes.toLocaleString('en')} content nodes, ${limit.chars.toLocaleString('en')} characters or ${limit.cells.toLocaleString('en')} table cells (rows × columns), ${MAX_CHUNK_SET_FACTOR} times the content they are made from plus room for ${CHUNK_SET_MODULES_AT_LIMITS} modules at the limits of one`
      }. Many modules each include a lot (a module referred to over several paths counts once per path): refer to fewer modules, over fewer paths. \`meta.largest\` names the modules that expanded the most.`,
      {
        nodes: limit.nodes,
        chars: limit.chars,
        tableCells: limit.cells,
        ...(kept && { kept: true }),
        largest,
      },
    );
  }
}
