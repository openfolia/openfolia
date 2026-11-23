import {
  type RunOptions,
  Transaction,
  UnitOfWork,
} from '../../src/base/core/unit-of-work.js';

/**
 * A transaction in memory: fakes stage their writes on it (`onCommit`),
 * applied only once the work has succeeded, so a failing action leaves
 * nothing behind, as a rolled-back database transaction would.
 */
export class FakeTransaction extends Transaction {
  open = true;
  /** When it started, as Postgres's `now()` inside it. */
  readonly startedAt = new Date();
  private readonly staged: (() => void)[] = [];
  private readonly undos: (() => void)[] = [];
  private readonly ended: (() => void)[] = [];

  /** Stages a write; throws once the transaction has ended. */
  onCommit(write: () => void): void {
    if (!this.open) throw new Error('The transaction has ended.');
    this.staged.push(write);
  }

  /** Undoes a write a fake made at once, should the transaction roll back. */
  onRollback(undo: () => void): void {
    if (!this.open) throw new Error('The transaction has ended.');
    this.undos.push(undo);
  }

  /** Runs once the transaction has ended, either way (a lock let go). */
  onEnd(end: () => void): void {
    if (!this.open) throw new Error('The transaction has ended.');
    this.ended.push(end);
  }

  commit(): void {
    for (const write of this.staged) write();
  }

  rollback(): void {
    for (const undo of this.undos.reverse()) undo();
  }

  end(): void {
    this.open = false;
    for (const end of this.ended) end();
  }
}

/** `UnitOfWork` over `FakeTransaction`s; counts the runs that committed. */
export class FakeUnitOfWork extends UnitOfWork {
  committed = 0;
  rolledBack = 0;
  /** Transactions running now. */
  active = 0;
  /** The options of every run, in order. */
  readonly runs: RunOptions[] = [];

  async run<T>(
    work: (tx: Transaction) => Promise<T>,
    options: RunOptions = {},
  ): Promise<T> {
    const tx = new FakeTransaction();
    this.runs.push(options);
    this.active++;
    try {
      const result = await work(tx);
      tx.commit();
      this.committed++;
      return result;
    } catch (error) {
      tx.rollback();
      this.rolledBack++;
      throw error;
    } finally {
      tx.end();
      this.active--;
    }
  }
}

/** The fake transaction inside `tx`; throws for any other. */
export function fakeOf(tx: Transaction): FakeTransaction {
  if (!(tx instanceof FakeTransaction)) {
    throw new Error('Not a transaction of the fake unit of work.');
  }
  return tx;
}
