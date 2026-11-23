import type { Transaction } from '../../base/core/unit-of-work.js';
import type { LockSubject } from './lock.js';

/**
 * A subject an update from the base reported as conflicting (#437), as it
 * stands: what it was reported against and whether its author saved it
 * since. "Update again" keeps the change set's version of a file only once
 * it was saved after the report (or the author chose to keep it as it is).
 */
export interface ReportedConflict {
  readonly subject: LockSubject;
  /** The base branch's head the conflict was reported against. */
  readonly base: string;
  readonly reportedAt: Date;
  /**
   * When the subject's working copy was first saved after the report;
   * undefined while it was not. A report made again (the base changed the
   * file since) starts over.
   */
  readonly savedAt?: Date;
}

/**
 * Port: the conflicts reported per change set (Postgres), one per subject.
 * Written when an update answers `refresh-conflict` (or
 * `refresh-unresolved`), marked saved by a working-copy save, cleared when
 * an update goes through.
 */
export abstract class RefreshConflictStore {
  /** The change set's reported conflicts, in subject-key order, read inside `tx`. */
  abstract of(
    tx: Transaction,
    changeSetId: string,
  ): Promise<ReportedConflict[]>;

  /**
   * Records each of `reports` inside `tx` as reported now against `base`,
   * replacing what was recorded for its subject (so `savedAt` starts over).
   */
  abstract report(
    tx: Transaction,
    changeSetId: string,
    reports: readonly {
      readonly subject: LockSubject;
      readonly base: string;
    }[],
  ): Promise<void>;

  /**
   * Marks the subject's report, if there is one not marked yet and made
   * before `tx` began, as saved now, inside `tx` (the transaction of the
   * save): a save begun before the report was not made seeing it.
   */
  abstract markSaved(
    tx: Transaction,
    changeSetId: string,
    subject: LockSubject,
  ): Promise<void>;

  /**
   * Marks the subject's report as not saved since, inside `tx` (its
   * working copy was discarded: what was saved is gone).
   */
  abstract markUnsaved(
    tx: Transaction,
    changeSetId: string,
    subject: LockSubject,
  ): Promise<void>;

  /** Removes the change set's reports inside `tx`; how many. */
  abstract clear(tx: Transaction, changeSetId: string): Promise<number>;
}
