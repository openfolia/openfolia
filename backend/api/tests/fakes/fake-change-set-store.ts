import { paginate, type PageRequest } from '../../src/base/core/paging.js';
import type { Transaction } from '../../src/base/core/unit-of-work.js';
import {
  type ChangeSet,
  type ChangeSetAuthor,
  type ChangeSetFilter,
  type ChangeSetState,
  noneInEachState,
  OPEN_STATES,
} from '../../src/change-sets/core/change-set.js';
import {
  type ChangeSetCursor,
  type ChangeSetEdit,
  ChangeSetStore,
} from '../../src/change-sets/core/change-set-store.js';
import { fakeOf } from './fake-unit-of-work.js';

/**
 * Change sets in memory, with `FakeUnitOfWork`: writes are kept only when
 * their transaction commits. `changeSets` holds them oldest first.
 */
export class FakeChangeSetStore extends ChangeSetStore {
  readonly changeSets: ChangeSet[] = [];
  /** Makes the next insert fail, as a database outage would. */
  failNextInsert = false;

  constructor(changeSets: readonly ChangeSet[] = []) {
    super();
    this.changeSets.push(...changeSets);
  }

  async insert(tx: Transaction, changeSet: ChangeSet): Promise<void> {
    const transaction = fakeOf(tx);
    if (this.failNextInsert) {
      this.failNextInsert = false;
      throw new Error('the database is down');
    }
    if (this.changeSets.some((c) => c.id === changeSet.id)) {
      throw new Error(`duplicate change set ${changeSet.id}`);
    }
    transaction.onCommit(() => this.changeSets.push(changeSet));
  }

  async find(id: string): Promise<ChangeSet | undefined> {
    return this.changeSets.find((c) => c.id === id);
  }

  async list(filter: ChangeSetFilter, page: PageRequest) {
    const matching = this.changeSets
      .filter(
        (c) =>
          (filter.state === undefined || c.state === filter.state) &&
          (filter.author === undefined || c.author.id === filter.author) &&
          (filter.authorKind === undefined ||
            c.author.kind === filter.authorKind),
      )
      .reverse();
    return paginate(matching, page);
  }

  async countByState(
    filter: ChangeSetFilter,
  ): Promise<Record<ChangeSetState, number>> {
    const counts = noneInEachState();
    for (const c of this.changeSets) {
      if (
        (filter.author === undefined || c.author.id === filter.author) &&
        (filter.authorKind === undefined || c.author.kind === filter.authorKind)
      ) {
        counts[c.state]++;
      }
    }
    return counts;
  }

  async lock(tx: Transaction, id: string): Promise<ChangeSet | undefined> {
    fakeOf(tx);
    return this.find(id);
  }

  async setState(
    tx: Transaction,
    id: string,
    state: ChangeSetState,
  ): Promise<ChangeSet> {
    const transaction = fakeOf(tx);
    const index = this.changeSets.findIndex((c) => c.id === id);
    const current = this.changeSets[index];
    if (!current) throw new Error(`No change set ${id} to update.`);
    const updated = { ...current, state, updatedAt: transaction.startedAt };
    transaction.onCommit(() => {
      this.changeSets[index] = updated;
    });
    return updated;
  }

  async rebase(
    tx: Transaction,
    id: string,
    base: { readonly baseCommit: string; readonly baseReleased: boolean },
  ): Promise<ChangeSet> {
    const transaction = fakeOf(tx);
    const index = this.changeSets.findIndex((c) => c.id === id);
    const current = this.changeSets[index];
    if (!current) throw new Error(`No change set ${id} to update.`);
    const updated: ChangeSet = {
      ...current,
      baseCommit: base.baseCommit,
      baseReleased: base.baseReleased,
      updatedAt: transaction.startedAt,
    };
    transaction.onCommit(() => {
      this.changeSets[index] = updated;
    });
    return updated;
  }

  async edit(
    tx: Transaction,
    id: string,
    change: ChangeSetEdit,
  ): Promise<ChangeSet> {
    const transaction = fakeOf(tx);
    const index = this.changeSets.findIndex((c) => c.id === id);
    const current = this.changeSets[index];
    if (!current) throw new Error(`No change set ${id} to update.`);
    const updated: ChangeSet = {
      ...current,
      ...(change.title !== undefined && { title: change.title }),
      ...(change.description !== undefined && {
        description: change.description,
      }),
      updatedAt: transaction.startedAt,
    };
    transaction.onCommit(() => {
      this.changeSets[index] = updated;
    });
    return updated;
  }

  async transition(
    tx: Transaction,
    id: string,
    change: {
      readonly state: ChangeSetState;
      readonly reviewHead?: string | null;
      readonly mergeCommit?: string | null;
    },
  ): Promise<ChangeSet> {
    const transaction = fakeOf(tx);
    const index = this.changeSets.findIndex((c) => c.id === id);
    const current = this.changeSets[index];
    if (!current) throw new Error(`No change set ${id} to update.`);
    const updated: { -readonly [K in keyof ChangeSet]: ChangeSet[K] } = {
      ...current,
      state: change.state,
      updatedAt: transaction.startedAt,
    };
    if (change.reviewHead === null) delete updated.reviewHead;
    else if (change.reviewHead !== undefined) {
      updated.reviewHead = change.reviewHead;
    }
    if (change.mergeCommit === null) delete updated.mergeCommit;
    else if (change.mergeCommit !== undefined) {
      updated.mergeCommit = change.mergeCommit;
    }
    transaction.onCommit(() => {
      this.changeSets[index] = updated;
    });
    return updated;
  }

  async listOpen(max: number, author?: ChangeSetAuthor): Promise<ChangeSet[]> {
    return this.changeSets
      .filter(
        (c) =>
          OPEN_STATES.includes(c.state) &&
          (!author ||
            (c.author.kind === author.kind && c.author.id === author.id)),
      )
      .reverse()
      .slice(0, max);
  }

  async listInState(
    state: ChangeSetState,
    max: number,
    after?: ChangeSetCursor,
  ): Promise<ChangeSet[]> {
    const key = (c: ChangeSetCursor) =>
      `${String(c.createdAt.getTime()).padStart(16, '0')}/${c.id}`;
    return this.changeSets
      .filter((c) => c.state === state && (!after || key(c) > key(after)))
      .sort((a, b) => (key(a) < key(b) ? -1 : 1))
      .slice(0, max);
  }

  async existing(ids: readonly string[]): Promise<Set<string>> {
    return new Set(
      ids.filter((id) => this.changeSets.some((c) => c.id === id)),
    );
  }
}
