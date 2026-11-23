import type { Transaction } from '../../base/core/unit-of-work.js';
import type { LockSubject } from './lock.js';
import type { WorkingCopy, WorkingCopyWrite } from './working-copy.js';

/** A working copy's subject, version and stored size, without its content. */
export interface WorkingCopySize {
  readonly subject: LockSubject;
  readonly version: number;
  /**
   * When this copy was first saved. A copy discarded and saved again
   * starts over at version 1 with a new `createdAt`, so the two together
   * name one content (version alone does not).
   */
  readonly createdAt: Date;
  /** Its content as UTF-8 JSON, in bytes. */
  readonly bytes: number;
  /**
   * A template file's copy (#803): its text's length in UTF-8 bytes, what the file will hold;
   * undefined for any other subject.
   */
  readonly textBytes?: number;
}

/** A save refused because the working copy is at another version. */
export interface VersionConflict {
  /** The version it is at (0: there is none). */
  readonly conflict: number;
}

/**
 * Port: working copies (Postgres), one per change set and subject. Saves
 * are compare-and-swap on the version, so two saves based on the same
 * version cannot both succeed and none overwrites a newer one.
 */
export abstract class WorkingCopyStore {
  /** The working copy of `subject` in the change set; undefined when there is none. */
  abstract find(
    changeSetId: string,
    subject: LockSubject,
  ): Promise<WorkingCopy | undefined>;

  /**
   * Saves `write` inside `tx` when the working copy is at version
   * `expected` (0: there is none yet, and this creates it at 1); the saved
   * copy is one version further. Otherwise nothing is written and the
   * version it is at comes back.
   */
  abstract save(
    tx: Transaction,
    write: WorkingCopyWrite,
    expected: number,
  ): Promise<WorkingCopy | VersionConflict>;

  /** The working copy of `subject` in the change set, read inside `tx`. */
  abstract get(
    tx: Transaction,
    changeSetId: string,
    subject: LockSubject,
  ): Promise<WorkingCopy | undefined>;

  /**
   * Every working copy of the change set, read inside `tx`, without its
   * content: its subject, version and stored size (UTF-8 JSON bytes; a
   * template file's text length too), in subject-key order.
   */
  abstract sizesOf(
    tx: Transaction,
    changeSetId: string,
  ): Promise<WorkingCopySize[]>;

  /**
   * Removes the working copy inside `tx` if it is still at `version`
   * (compare-and-swap) and, when given, was first saved at `createdAt`
   * (to the millisecond: one discarded and saved again since is another
   * copy); false when it is not (or there is none).
   */
  abstract removeAt(
    tx: Transaction,
    changeSetId: string,
    subject: LockSubject,
    version: number,
    createdAt?: Date,
  ): Promise<boolean>;

  /**
   * Moves the working copy's base from `from` to `to` inside `tx`, one
   * version further (so a tab holding the old base reads it again); false
   * when its base is not `from` (or there is none).
   */
  abstract rebase(
    tx: Transaction,
    changeSetId: string,
    subject: LockSubject,
    from: string,
    to: string,
  ): Promise<boolean>;

  /** How many working copies the change set has, read inside `tx`. */
  abstract countOf(tx: Transaction, changeSetId: string): Promise<number>;

  /** Removes the working copy inside `tx`; false when there was none. */
  abstract remove(
    tx: Transaction,
    changeSetId: string,
    subject: LockSubject,
  ): Promise<boolean>;

  /**
   * Every file hash (`sha256:<64 hex>`, the 64 hex characters) any working
   * copy of any change set mentions anywhere in its content: what a file
   * that is about to be deleted must not be (#255). Read as text, so a
   * mention outside a block counts too (more is kept, never less).
   */
  abstract referencedAssets(): Promise<Set<string>>;

  /** Removes every working copy of the change set inside `tx`; how many. */
  abstract removeAllOf(tx: Transaction, changeSetId: string): Promise<number>;
}
