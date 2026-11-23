import { ContendedError } from './errors.js';

/**
 * An open database transaction, opaque to `core/`: an action receives one
 * from `UnitOfWork.run` and hands it to every port that writes within it
 * (`AuditLog.record`, later the stores of locks, change sets, comments), so
 * their writes commit together or not at all. Only the adapter that opened
 * it can use it; it is unusable once `run` has returned.
 */
export abstract class Transaction {
  // Nominal: no plain object is a Transaction.
  protected readonly isTransaction = true;
}

/** How a transaction runs (`UnitOfWork.run`). */
export interface RunOptions {
  /**
   * Bounds its waits with the write timeouts (the settings
   * `CCMS_DATABASE_WRITE_LOCK_TIMEOUT_MS` and
   * `CCMS_DATABASE_WRITE_STATEMENT_TIMEOUT_MS`): for a transaction that
   * holds rows others wait for (a save point, an abandon, a lock break),
   * so neither it nor they wait without end. Past one it rejects with
   * `TimedOutError` (503 `database-timeout`).
   */
  readonly bounded?: boolean;
}

/** `{ bounded: true }`: a transaction with the write timeouts. */
export const BOUNDED: RunOptions = { bounded: true };

/** Port: runs work in one database transaction. */
export abstract class UnitOfWork {
  /**
   * Runs `work` in a new transaction: committed when it resolves, rolled
   * back when it rejects (the rejection is passed on); it also rejects when
   * the database aborted the transaction, even if `work` caught that error.
   * Never call `run` inside `work`; pass the transaction on instead. Reads
   * through ports that take no transaction happen outside it. A
   * transaction the database broke off for contending with another (a
   * deadlock, a serialization failure) rejects with `ContendedError`; one
   * that hit a lock or statement timeout with `TimedOutError`.
   */
  abstract run<T>(
    work: (tx: Transaction) => Promise<T>,
    options?: RunOptions,
  ): Promise<T>;
}

/**
 * `unit.run(work)`, and once more when the database broke it off for
 * contending with another transaction (`ContendedError`): the second
 * failure is passed on (409 `lock-contended`). Only for work that writes
 * nothing outside the database, so running it again is safe.
 */
export async function runContended<T>(
  unit: UnitOfWork,
  work: (tx: Transaction) => Promise<T>,
  options?: RunOptions,
): Promise<T> {
  try {
    return await unit.run(work, options);
  } catch (error) {
    if (!(error instanceof ContendedError)) throw error;
    return unit.run(work, options);
  }
}
