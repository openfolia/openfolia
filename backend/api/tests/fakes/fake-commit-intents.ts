import type { Transaction } from '../../src/base/core/unit-of-work.js';
import {
  type CommitIntent,
  CommitIntents,
  MAX_INTENTS_READ,
  type NewCommitIntent,
} from '../../src/change-sets/core/commit-intents.js';
import { fakeOf } from './fake-unit-of-work.js';

/**
 * Commit intents in memory, with `FakeUnitOfWork`: an add or remove is
 * kept only when its transaction commits. `age` makes an intent older, as
 * time passing would.
 */
export class FakeCommitIntents extends CommitIntents {
  readonly intents: CommitIntent[] = [];
  private next = 1;

  async add(tx: Transaction, intent: NewCommitIntent): Promise<CommitIntent> {
    const added: CommitIntent = {
      ...intent,
      id: this.next++,
      createdAt: new Date(),
    };
    fakeOf(tx).onCommit(() => this.intents.push(added));
    return added;
  }

  async of(tx: Transaction, changeSetId: string): Promise<CommitIntent[]> {
    fakeOf(tx);
    return this.intents
      .filter((i) => i.changeSetId === changeSetId)
      .slice(0, MAX_INTENTS_READ);
  }

  async remove(tx: Transaction, id: number): Promise<boolean> {
    const found = this.intents.some((i) => i.id === id);
    fakeOf(tx).onCommit(() => this.drop((i) => i.id === id));
    return found;
  }

  async pendingFor(changeSetIds: readonly string[]): Promise<Set<string>> {
    return new Set(
      changeSetIds.filter((id) =>
        this.intents.some((i) => i.changeSetId === id),
      ),
    );
  }

  async expiredChangeSets(olderThanMs: number, limit: number) {
    const ids = this.intents
      .filter((i) => this.expired(i, olderThanMs))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((i) => i.changeSetId);
    return [...new Set(ids)].slice(0, limit);
  }

  async removeExpired(
    tx: Transaction,
    changeSetId: string,
    olderThanMs: number,
  ): Promise<number> {
    const doomed = (i: CommitIntent) =>
      i.changeSetId === changeSetId && this.expired(i, olderThanMs);
    const count = this.intents.filter(doomed).length;
    fakeOf(tx).onCommit(() => this.drop(doomed));
    return count;
  }

  /** Makes every intent `ms` older. */
  age(ms: number): void {
    for (const [n, i] of this.intents.entries()) {
      this.intents[n] = {
        ...i,
        createdAt: new Date(i.createdAt.getTime() - ms),
      };
    }
  }

  private expired(intent: CommitIntent, olderThanMs: number): boolean {
    return intent.createdAt.getTime() < Date.now() - olderThanMs;
  }

  private drop(which: (i: CommitIntent) => boolean): void {
    for (let n = this.intents.length - 1; n >= 0; n--) {
      if (which(this.intents[n] as CommitIntent)) this.intents.splice(n, 1);
    }
  }
}
