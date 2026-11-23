import type { Transaction } from '../../src/base/core/unit-of-work.js';
import {
  type LockSubject,
  subjectKey,
} from '../../src/change-sets/core/lock.js';
import type {
  WorkingCopy,
  WorkingCopyWrite,
} from '../../src/change-sets/core/working-copy.js';
import {
  type VersionConflict,
  WorkingCopyStore,
  type WorkingCopySize,
} from '../../src/change-sets/core/working-copy-store.js';
import { fakeOf } from './fake-unit-of-work.js';

const keyOf = (changeSetId: string, subject: LockSubject) => {
  const { type, id } = subjectKey(subject);
  return `${changeSetId}:${type}/${id}`;
};

/**
 * Working copies in memory, with `FakeUnitOfWork`: writes are kept only
 * when their transaction commits. Saves are compare-and-swap on the
 * version, as in the database.
 */
export class FakeWorkingCopyStore extends WorkingCopyStore {
  readonly copies = new Map<string, WorkingCopy>();
  /** What each open transaction has written (undefined: removed), as it sees it. */
  private readonly overlays = new WeakMap<
    Transaction,
    Map<string, WorkingCopy | undefined>
  >();

  /** The copy at `key` as `tx` sees it: its own writes over the committed ones. */
  private read(tx: Transaction, key: string): WorkingCopy | undefined {
    const overlay = this.overlays.get(tx);
    return overlay?.has(key) ? overlay.get(key) : this.copies.get(key);
  }

  /** Writes `copy` (undefined: removes it) at `key` in `tx`, kept on commit. */
  private stage(tx: Transaction, key: string, copy: WorkingCopy | undefined) {
    const overlay = this.overlays.get(tx) ?? new Map();
    this.overlays.set(tx, overlay);
    overlay.set(key, copy);
    fakeOf(tx).onCommit(() => {
      if (copy) this.copies.set(key, copy);
      else this.copies.delete(key);
    });
  }

  async find(changeSetId: string, subject: LockSubject) {
    return this.copies.get(keyOf(changeSetId, subject));
  }

  private lastCreated = 0;

  /**
   * A new copy's `createdAt`: the transaction's time, but always later than
   * the last one, as a real clock is between two requests (a copy discarded
   * and saved again in the same millisecond would otherwise look the same).
   */
  private newCreatedAt(at: Date): Date {
    this.lastCreated = Math.max(at.getTime(), this.lastCreated + 1);
    return new Date(this.lastCreated);
  }

  async save(
    tx: Transaction,
    write: WorkingCopyWrite,
    expected: number,
  ): Promise<WorkingCopy | VersionConflict> {
    const transaction = fakeOf(tx);
    const key = keyOf(write.changeSetId, write.subject);
    const current = this.read(tx, key);
    if ((current?.version ?? 0) !== expected) {
      return { conflict: current?.version ?? 0 };
    }
    const saved: WorkingCopy = {
      ...write,
      version: expected + 1,
      createdAt: current?.createdAt ?? this.newCreatedAt(transaction.startedAt),
      updatedAt: transaction.startedAt,
    };
    this.stage(tx, key, saved);
    return saved;
  }

  async get(tx: Transaction, changeSetId: string, subject: LockSubject) {
    fakeOf(tx);
    return this.read(tx, keyOf(changeSetId, subject));
  }

  async referencedAssets(): Promise<Set<string>> {
    const found = new Set<string>();
    for (const copy of this.copies.values()) {
      for (const [, hash] of JSON.stringify(copy.content).matchAll(
        /sha256:([0-9a-f]{64})/g,
      )) {
        if (hash) found.add(hash);
      }
    }
    return found;
  }

  async sizesOf(
    tx: Transaction,
    changeSetId: string,
  ): Promise<WorkingCopySize[]> {
    fakeOf(tx);
    const keys = new Set([
      ...this.copies.keys(),
      ...(this.overlays.get(tx)?.keys() ?? []),
    ]);
    return [...keys]
      .filter((k) => k.startsWith(`${changeSetId}:`))
      .sort((a, b) => a.localeCompare(b))
      .flatMap((k) => this.read(tx, k) ?? [])
      .map((copy) => ({
        subject: copy.subject,
        version: copy.version,
        createdAt: copy.createdAt,
        bytes: new TextEncoder().encode(JSON.stringify(copy.content)).length,
        ...(copy.subject.type === 'template'
          ? {
              textBytes: new TextEncoder().encode(
                (copy.content as { text: string }).text,
              ).length,
            }
          : {}),
      }));
  }

  async removeAt(
    tx: Transaction,
    changeSetId: string,
    subject: LockSubject,
    version: number,
    createdAt?: Date,
  ) {
    const key = keyOf(changeSetId, subject);
    const current = this.read(tx, key);
    if (current?.version !== version) return false;
    if (
      createdAt !== undefined &&
      current.createdAt.getTime() !== createdAt.getTime()
    ) {
      return false;
    }
    this.stage(tx, key, undefined);
    return true;
  }

  async rebase(
    tx: Transaction,
    changeSetId: string,
    subject: LockSubject,
    from: string,
    to: string,
  ) {
    const transaction = fakeOf(tx);
    const key = keyOf(changeSetId, subject);
    const current = this.read(tx, key);
    if (current?.baseCommit !== from) return false;
    const moved = {
      ...current,
      baseCommit: to,
      version: current.version + 1,
      updatedAt: transaction.startedAt,
    };
    this.stage(tx, key, moved);
    return true;
  }

  async countOf(tx: Transaction, changeSetId: string) {
    fakeOf(tx);
    return [...this.copies.keys()].filter((k) =>
      k.startsWith(`${changeSetId}:`),
    ).length;
  }

  async remove(tx: Transaction, changeSetId: string, subject: LockSubject) {
    const key = keyOf(changeSetId, subject);
    const found = this.copies.has(key);
    fakeOf(tx).onCommit(() => this.copies.delete(key));
    return found;
  }

  async removeAllOf(tx: Transaction, changeSetId: string) {
    const keys = [...this.copies.keys()].filter((k) =>
      k.startsWith(`${changeSetId}:`),
    );
    fakeOf(tx).onCommit(() => {
      for (const key of keys) this.copies.delete(key);
    });
    return keys.length;
  }
}
