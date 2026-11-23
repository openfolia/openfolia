import type { Transaction } from '../../src/base/core/unit-of-work.js';
import { ChangeSetCommits } from '../../src/change-sets/core/change-set-commits.js';
import type { ChangeSetCommit } from '../../src/change-sets/core/commit.js';
import { fakeOf } from './fake-unit-of-work.js';

/**
 * Recorded commits in memory, with `FakeUnitOfWork`: a record is kept only
 * when its transaction commits. `records` holds them in order.
 */
export class FakeChangeSetCommits extends ChangeSetCommits {
  readonly records: ChangeSetCommit[] = [];

  async recorded(commits: readonly string[], tx?: Transaction) {
    if (tx) fakeOf(tx);
    return new Set(
      commits.filter((c) => this.records.some((r) => r.commit === c)),
    );
  }

  async record(tx: Transaction, commit: ChangeSetCommit) {
    const transaction = fakeOf(tx);
    if (this.records.some((r) => r.commit === commit.commit)) return false;
    transaction.onCommit(() => this.records.push(commit));
    return true;
  }
}
