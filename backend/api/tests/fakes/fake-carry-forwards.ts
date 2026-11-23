import type { Transaction } from '../../src/base/core/unit-of-work.js';
import { CarryForwards } from '../../src/change-sets/core/carry-forwards.js';
import type { ChangeSetStore } from '../../src/change-sets/core/change-set-store.js';
import { fakeOf } from './fake-unit-of-work.js';

/**
 * Which change set carries which forward, in memory, with
 * `FakeUnitOfWork`; a change set's state is read from `store`.
 */
export class FakeCarryForwards extends CarryForwards {
  readonly links: { changeSetId: string; sourceId: string }[] = [];

  constructor(private readonly store: Pick<ChangeSetStore, 'find'>) {
    super();
  }

  async record(
    tx: Transaction,
    link: { readonly changeSetId: string; readonly sourceId: string },
  ): Promise<void> {
    fakeOf(tx).onCommit(() => this.links.push({ ...link }));
  }

  async activeOf(sourceId: string): Promise<string | undefined> {
    for (const link of this.links.filter((l) => l.sourceId === sourceId)) {
      const found = await this.store.find(link.changeSetId);
      if (found && found.state !== 'abandoned') return found.id;
    }
    return undefined;
  }

  async sourceOf(changeSetId: string): Promise<string | undefined> {
    return this.links.find((l) => l.changeSetId === changeSetId)?.sourceId;
  }
}
