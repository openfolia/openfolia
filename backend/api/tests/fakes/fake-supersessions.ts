import type { Transaction } from '../../src/base/core/unit-of-work.js';
import type { ChangeSetStore } from '../../src/change-sets/core/change-set-store.js';
import {
  ChangeSetSupersessions,
  type SupersessionLinks,
} from '../../src/change-sets/core/supersessions.js';
import { fakeOf } from './fake-unit-of-work.js';

/**
 * Which change set supersedes which, in memory, with `FakeUnitOfWork`; a
 * change set's state is read from `store`.
 */
export class FakeChangeSetSupersessions extends ChangeSetSupersessions {
  readonly links: { changeSetId: string; supersededId: string }[] = [];

  constructor(private readonly store: Pick<ChangeSetStore, 'find'>) {
    super();
  }

  async record(
    tx: Transaction,
    link: { readonly changeSetId: string; readonly supersededId: string },
  ): Promise<void> {
    fakeOf(tx).onCommit(() => this.links.push({ ...link }));
  }

  async activeOf(supersededId: string): Promise<string | undefined> {
    for (const link of this.links.filter(
      (l) => l.supersededId === supersededId,
    )) {
      const found = await this.store.find(link.changeSetId);
      if (found && found.state !== 'abandoned') return found.id;
    }
    return undefined;
  }

  async linksOf(id: string): Promise<SupersessionLinks> {
    const by = this.links.filter((l) => l.supersededId === id).at(-1);
    const of = this.links.find((l) => l.changeSetId === id);
    return {
      ...(by && { supersededBy: by.changeSetId }),
      ...(of && { supersedes: of.supersededId }),
    };
  }
}
