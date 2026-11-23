import { paginate, type PageRequest } from '../../src/base/core/paging.js';
import type { Transaction } from '../../src/base/core/unit-of-work.js';
import {
  type Lock,
  type LockFilter,
  type LockHolder,
  type LockSubject,
  type NewLock,
  subjectKey,
} from '../../src/change-sets/core/lock.js';
import { LockStore } from '../../src/change-sets/core/lock-store.js';
import { fakeOf } from './fake-unit-of-work.js';

const sameSubject = (a: LockSubject, b: LockSubject) => {
  const [x, y] = [subjectKey(a), subjectKey(b)];
  return x.type === y.type && x.id === y.id;
};

/**
 * Locks in memory, with `FakeUnitOfWork`: writes are kept only when their
 * transaction commits. `locks` holds them oldest first. One lock per
 * subject, as the database's unique index holds it.
 */
export class FakeLockStore extends LockStore {
  readonly locks: Lock[] = [];
  /**
   * Called inside `insert` before it looks for a conflict: a test takes
   * the subject there, as a concurrent transaction would.
   */
  beforeInsert?: () => void;

  async insert(tx: Transaction, lock: NewLock): Promise<Lock | undefined> {
    const transaction = fakeOf(tx);
    this.beforeInsert?.();
    if (this.locks.some((l) => sameSubject(l.subject, lock.subject))) {
      return undefined;
    }
    const taken: Lock = { ...lock, since: transaction.startedAt };
    transaction.onCommit(() => this.locks.push(taken));
    return taken;
  }

  async findBySubject(
    tx: Transaction,
    subject: LockSubject,
  ): Promise<Lock | undefined> {
    fakeOf(tx);
    return this.locks.find((l) => sameSubject(l.subject, subject));
  }

  async hold(tx: Transaction, subject: LockSubject): Promise<Lock | undefined> {
    return this.findBySubject(tx, subject);
  }

  async holdAll(
    tx: Transaction,
    subjects: readonly LockSubject[],
  ): Promise<Lock[]> {
    fakeOf(tx);
    return this.locks
      .filter((l) => subjects.some((s) => sameSubject(l.subject, s)))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async find(id: string): Promise<Lock | undefined> {
    return this.locks.find((l) => l.id === id);
  }

  async list(filter: LockFilter, page: PageRequest) {
    return paginate(await this.all(filter), page);
  }

  async all(filter: LockFilter): Promise<Lock[]> {
    const { holder, changeSetId, subject, moduleLanguages } = filter;
    return this.locks
      .filter(
        (l) =>
          (holder === undefined || l.holder.id === holder) &&
          (changeSetId === undefined || l.changeSetId === changeSetId) &&
          (subject === undefined || sameSubject(l.subject, subject)) &&
          (moduleLanguages === undefined ||
            l.subject.type !== 'module' ||
            moduleLanguages.includes(l.subject.lang)),
      )
      .reverse();
  }

  async countHeldBy(tx: Transaction, holder: LockHolder): Promise<number> {
    fakeOf(tx);
    return this.locks.filter(
      (l) => l.holder.kind === holder.kind && l.holder.id === holder.id,
    ).length;
  }

  async lock(tx: Transaction, id: string): Promise<Lock | undefined> {
    fakeOf(tx);
    return this.find(id);
  }

  async remove(tx: Transaction, id: string): Promise<void> {
    fakeOf(tx).onCommit(() => {
      const index = this.locks.findIndex((l) => l.id === id);
      if (index >= 0) this.locks.splice(index, 1);
    });
  }

  async removeAllOf(tx: Transaction, changeSetId: string): Promise<Lock[]> {
    const removed = this.locks.filter((l) => l.changeSetId === changeSetId);
    fakeOf(tx).onCommit(() => {
      for (const lock of removed)
        this.locks.splice(this.locks.indexOf(lock), 1);
    });
    return removed;
  }

  async removeAllHeldBy(tx: Transaction, holder: LockHolder): Promise<Lock[]> {
    const removed = this.locks.filter(
      (l) => l.holder.kind === holder.kind && l.holder.id === holder.id,
    );
    fakeOf(tx).onCommit(() => {
      for (const lock of removed)
        this.locks.splice(this.locks.indexOf(lock), 1);
    });
    return removed;
  }
}
