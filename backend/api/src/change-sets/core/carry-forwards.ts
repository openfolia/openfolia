import type { Transaction } from '../../base/core/unit-of-work.js';

/**
 * Port: which change set carries which forward (#60): a change set merged
 * into a maintenance line, applied again as a new draft on `main`.
 */
export abstract class CarryForwards {
  /**
   * Records, inside `tx`, that the change set `changeSetId` (just created
   * in `tx`) carries `sourceId` forward.
   */
  abstract record(
    tx: Transaction,
    link: { readonly changeSetId: string; readonly sourceId: string },
  ): Promise<void>;

  /**
   * The oldest change set carrying `sourceId` forward that is not
   * abandoned; undefined for none. Read in `tx` when given (the caller
   * holds `sourceId`'s row there).
   */
  abstract activeOf(
    sourceId: string,
    tx?: Transaction,
  ): Promise<string | undefined>;

  /** The change set `changeSetId` carries forward; undefined when it carries none. */
  abstract sourceOf(changeSetId: string): Promise<string | undefined>;
}
