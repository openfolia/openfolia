import type { Transaction } from '../../base/core/unit-of-work.js';
import type { ChangeSetCommit } from './commit.js';

/**
 * Port: the commits made on change-set branches, as recorded in Postgres:
 * one outbox row each (topic `change-set.commit`, keyed by the commit ID),
 * written in the transaction that records the commit's audit events. A
 * commit on a branch that has no row was never recorded (the process
 * stopped between Git and the database) and is recorded afterwards
 * (`CommitRecorder.catchUp`). The rows are also what later consumers (an
 * index, webhooks) read, in order.
 */
export abstract class ChangeSetCommits {
  /** Which of `commits` are recorded; inside `tx` when given. */
  abstract recorded(
    commits: readonly string[],
    tx?: Transaction,
  ): Promise<Set<string>>;

  /**
   * Records `commit` inside `tx`. False, writing nothing, when it is
   * recorded already (a concurrent transaction recording the same commit
   * waits for the other to end, then gets false).
   */
  abstract record(tx: Transaction, commit: ChangeSetCommit): Promise<boolean>;
}
