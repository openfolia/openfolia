import type { PageRequest, Paginated } from '../../base/core/paging.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import type {
  Lock,
  LockFilter,
  LockHolder,
  LockSubject,
  NewLock,
} from './lock.js';

/**
 * Port: locks on modules and manuals (Postgres). One lock per subject: the
 * database refuses a second, so of two transactions taking the same
 * subject at once exactly one gets it.
 */
export abstract class LockStore {
  /**
   * Takes `lock` inside `tx` unless its subject is locked already (by a
   * committed lock, or one a concurrent transaction is taking: this waits
   * for that transaction to end). Returns the lock taken, stamped with the
   * transaction's time, or undefined when the subject was locked.
   */
  abstract insert(tx: Transaction, lock: NewLock): Promise<Lock | undefined>;

  /** The lock on `subject`, read inside `tx`; undefined when there is none. */
  abstract findBySubject(
    tx: Transaction,
    subject: LockSubject,
  ): Promise<Lock | undefined>;

  /**
   * The lock on `subject`, read inside `tx` and kept until it ends: no
   * concurrent transaction releases, breaks or removes it meanwhile
   * (`SELECT … FOR SHARE`), so a write that needs the lock cannot outlive
   * it. Undefined when there is none.
   */
  abstract hold(
    tx: Transaction,
    subject: LockSubject,
  ): Promise<Lock | undefined>;

  /**
   * The locks on `subjects` that exist, read inside `tx` and kept until it
   * ends, as `hold` keeps one. Taken in lock-ID order, as every removal of
   * several locks takes them (`removeAllOf`, `removeAllHeldBy`), so two
   * transactions never wait for each other in a cycle.
   */
  abstract holdAll(
    tx: Transaction,
    subjects: readonly LockSubject[],
  ): Promise<Lock[]>;

  /** The lock `id`; undefined when there is none (or `id` is malformed). */
  abstract find(id: string): Promise<Lock | undefined>;

  /** One page of the locks matching `filter`, newest first. */
  abstract list(
    filter: LockFilter,
    page: PageRequest,
  ): Promise<Paginated<Lock>>;

  /**
   * Every lock matching `filter`, newest first: for a reader whose scope
   * has to be checked lock by lock before the list is paged.
   */
  abstract all(filter: LockFilter): Promise<Lock[]>;

  /**
   * How many locks `holder` holds, across change sets, read inside `tx`.
   * Serializes with every other transaction counting the same holder
   * until `tx` ends, so a count and the insert after it cannot race.
   */
  abstract countHeldBy(tx: Transaction, holder: LockHolder): Promise<number>;

  /**
   * The lock `id`, read inside `tx` and locked until it ends, so no
   * concurrent transaction releases or breaks it meanwhile
   * (`SELECT … FOR UPDATE`).
   */
  abstract lock(tx: Transaction, id: string): Promise<Lock | undefined>;

  /** Removes the lock `id` (locked by `lock` in the same `tx`). */
  abstract remove(tx: Transaction, id: string): Promise<void>;

  /**
   * Removes every lock of the change set `changeSetId` inside `tx` and
   * returns them, oldest first (for the audit log). Their rows are taken
   * in lock-ID order (see `holdAll`).
   */
  abstract removeAllOf(tx: Transaction, changeSetId: string): Promise<Lock[]>;

  /**
   * Removes every lock `holder` holds, across change sets, inside `tx` and
   * returns them, oldest first, their rows taken in lock-ID order (see
   * `holdAll`). Takes the same per-holder lock as
   * `countHeldBy` and keeps it until `tx` ends, so it cannot interleave
   * with that holder taking a lock: one taken meanwhile waits and is
   * taken after this ends.
   */
  abstract removeAllHeldBy(
    tx: Transaction,
    holder: LockHolder,
  ): Promise<Lock[]>;
}
