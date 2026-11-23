import type { Transaction } from '../../base/core/unit-of-work.js';
import type { ChangeSetAuthor } from './change-set.js';
import type { LockSubject } from './lock.js';

/**
 * A working copy a save point commits (or drops as unchanged), as it read
 * it: its version and when it was first saved, which together name one
 * content (a copy discarded and saved again starts over at version 1).
 */
export interface ConsumedCopy {
  readonly subject: LockSubject;
  readonly version: number;
  readonly createdAt: Date;
}

/**
 * What a save point is about to commit (#154), recorded before the Git
 * write in a transaction of its own: if the process stops between Git and
 * the database, recovery records the commit only when its first parent
 * and its tree are an intent's, and as that intent's actor. What a commit
 * says about itself (its trailers, its author) never decides: anyone who
 * can push to a change-set branch can write those.
 */
export interface CommitIntent {
  readonly id: number;
  readonly changeSetId: string;
  /** Who commits: the change set's author. */
  readonly actor: ChangeSetAuthor;
  /** The branch head the commit is made on. */
  readonly parent: string;
  /** The tree the commit has (built before the intent is written). */
  readonly tree: string;
  /** Subjects written and deleted, in subject-key order. */
  readonly written: readonly LockSubject[];
  readonly deleted: readonly LockSubject[];
  /** The working copies it commits, at the versions read. */
  readonly consumes: readonly ConsumedCopy[];
  /** The client's message, for the audit event's comment. */
  readonly message?: string;
  readonly createdAt: Date;
}

/** An intent as it is added: the store gives it its ID and time. */
export type NewCommitIntent = Omit<CommitIntent, 'id' | 'createdAt'>;

/**
 * Port: commit intents (Postgres). One is added before a save point's Git
 * write and consumed (removed) in the transaction that records its commit,
 * whether at once or by recovery; one whose commit never landed (a branch
 * that moved, a crash before Git) is removed again or expires.
 */
export abstract class CommitIntents {
  /** Adds `intent` inside `tx`. */
  abstract add(tx: Transaction, intent: NewCommitIntent): Promise<CommitIntent>;

  /** The change set's intents, oldest first (at most `MAX_INTENTS_READ`), read inside `tx`. */
  abstract of(tx: Transaction, changeSetId: string): Promise<CommitIntent[]>;

  /** Removes the intent inside `tx`; false when it was gone already. */
  abstract remove(tx: Transaction, id: number): Promise<boolean>;

  /** Which of `changeSetIds` have an intent (outside any transaction). */
  abstract pendingFor(changeSetIds: readonly string[]): Promise<Set<string>>;

  /**
   * Change sets with an intent older than `olderThanMs` (by the
   * database's clock), at most `limit` of them (outside any transaction).
   */
  abstract expiredChangeSets(
    olderThanMs: number,
    limit: number,
  ): Promise<string[]>;

  /** Removes, inside `tx`, the change set's intents older than `olderThanMs`; how many. */
  abstract removeExpired(
    tx: Transaction,
    changeSetId: string,
    olderThanMs: number,
  ): Promise<number>;
}

/** The most intents `CommitIntents.of` reads for one change set. */
export const MAX_INTENTS_READ = 100;

/**
 * How old an intent gets before it expires: its commit never landed (or
 * could not be recovered), since recovery runs at the change set's next
 * save point and on every reconciler pass (every ten minutes). A save
 * point's own transaction is bounded by the write timeouts, far below it.
 */
export const INTENT_TTL_MS = 60 * 60_000;
