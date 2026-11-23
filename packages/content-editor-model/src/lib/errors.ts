/** One thing the model refuses, with the block it is in (`null`: the module itself). */
export interface ConversionProblem {
  blockId: string | null;
  message: string;
}

/**
 * A document that can't become a module, or a module that can't become a
 * document. `blockId` names the block the first problem is in: the block's
 * own ID (even an invalid one, when that is the problem), or the nearest
 * enclosing block's when the node at fault has none (a list item's text, a
 * table cell, a block missing its ID). `null` when there is no block around
 * the problem: the module's own ID or metadata, or a top-level node that
 * isn't a block or has no ID.
 */
export class ConversionError extends Error {
  override readonly name = 'ConversionError';
  readonly blockId: string | null;

  constructor(
    readonly problems: readonly [ConversionProblem, ...ConversionProblem[]],
  ) {
    const [first] = problems;
    const more =
      problems.length > 1 ? ` (and ${problems.length - 1} more)` : '';
    super(
      first.blockId === null
        ? `${first.message}${more}`
        : `block "${first.blockId}": ${first.message}${more}`,
    );
    this.blockId = first.blockId;
  }

  static at(blockId: string | null, message: string): ConversionError {
    return new ConversionError([{ blockId, message }]);
  }
}
