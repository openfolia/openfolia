import type { Transaction } from '../../base/core/unit-of-work.js';

/** How a change set is linked to the one it moved onto a rewritten base, or the one that did. */
export interface SupersessionLinks {
  /** The newest change set its changes were moved into (#471). */
  readonly supersededBy?: string;
  /** The change set whose changes it holds, moved onto the current base. */
  readonly supersedes?: string;
}

/**
 * Port: which change set supersedes which (#471): a change set whose base
 * was rewritten, its own changes moved onto the current base as a new
 * draft change set.
 */
export abstract class ChangeSetSupersessions {
  /**
   * Records, inside `tx`, that the change set `changeSetId` (just created
   * in `tx`) holds `supersededId`'s changes.
   */
  abstract record(
    tx: Transaction,
    link: { readonly changeSetId: string; readonly supersededId: string },
  ): Promise<void>;

  /**
   * The oldest change set superseding `supersededId` that is not
   * abandoned; undefined for none. Read in `tx` when given (the caller
   * holds `supersededId`'s row there).
   */
  abstract activeOf(
    supersededId: string,
    tx?: Transaction,
  ): Promise<string | undefined>;

  /** The links of the change set `id`, either way. */
  abstract linksOf(id: string): Promise<SupersessionLinks>;
}
