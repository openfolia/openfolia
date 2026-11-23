import { sql } from 'drizzle-orm';
import { ContendedError, TimedOutError } from '../base/core/errors.js';
import {
  type RunOptions,
  Transaction,
  UnitOfWork,
} from '../base/core/unit-of-work.js';
import { Database, type Drizzle, isContended, isTimedOut } from './database.js';

/** Drizzle's transaction handle: the same query API as `Drizzle`. */
export type DrizzleTx = Parameters<Parameters<Drizzle['transaction']>[0]>[0];

/** The waits a bounded transaction (`RunOptions.bounded`) gets, in milliseconds. */
export interface WriteTimeouts {
  /** `lock_timeout`: how long a statement waits for a lock. */
  readonly lockTimeoutMs: number;
  /** `statement_timeout`: how long one statement may run. */
  readonly statementTimeoutMs: number;
}

/** The defaults of `CCMS_DATABASE_WRITE_LOCK_TIMEOUT_MS` and `…_STATEMENT_TIMEOUT_MS`. */
export const DEFAULT_WRITE_TIMEOUTS: WriteTimeouts = {
  lockTimeoutMs: 5_000,
  statementTimeoutMs: 30_000,
};

/** A `Transaction` over a Drizzle transaction, open while its `run` lasts. */
class DrizzleTransaction extends Transaction {
  open = true;

  constructor(readonly tx: DrizzleTx) {
    super();
  }
}

/**
 * The Drizzle transaction inside `tx`, for adapters in `repos/`. Throws for
 * a transaction of another unit of work (e.g. a test fake) and for one whose
 * `run` has returned: a write through it would land outside the transaction.
 */
export function drizzleOf(tx: Transaction): DrizzleTx {
  if (!(tx instanceof DrizzleTransaction)) {
    throw new Error('Not a transaction of the Drizzle unit of work.');
  }
  if (!tx.open) {
    throw new Error('The transaction has ended; write inside its run().');
  }
  return tx.tx;
}

/**
 * `UnitOfWork` as a Postgres transaction (Drizzle's `transaction()`). A
 * bounded one sets `lock_timeout` and `statement_timeout` for itself only
 * (`set_config(…, true)`, as `SET LOCAL`), first thing.
 */
export class DrizzleUnitOfWork extends UnitOfWork {
  constructor(
    private readonly database: Database,
    private readonly timeouts: WriteTimeouts = DEFAULT_WRITE_TIMEOUTS,
  ) {
    super();
  }

  async run<T>(
    work: (tx: Transaction) => Promise<T>,
    options: RunOptions = {},
  ): Promise<T> {
    try {
      return await this.transaction(work, options);
    } catch (error) {
      // Rolled back by the database: the core decides whether to retry.
      if (isContended(error)) throw new ContendedError({ cause: error });
      if (isTimedOut(error)) throw new TimedOutError({ cause: error });
      throw error;
    }
  }

  private transaction<T>(
    work: (tx: Transaction) => Promise<T>,
    { bounded = false }: RunOptions,
  ): Promise<T> {
    return this.database.db.transaction(async (tx) => {
      if (bounded) {
        const { lockTimeoutMs, statementTimeoutMs } = this.timeouts;
        await tx.execute(
          sql`select set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true), set_config('statement_timeout', ${`${statementTimeoutMs}ms`}, true)`,
        );
      }
      const transaction = new DrizzleTransaction(tx);
      try {
        const result = await work(transaction);
        // A statement that failed inside `work` and was caught there has
        // aborted the transaction, and Postgres answers the COMMIT with a
        // silent ROLLBACK: this fails instead, so `run` never reports a
        // commit that did not happen.
        await tx.execute(sql`select 1`);
        return result;
      } finally {
        transaction.open = false;
      }
    });
  }
}
