import type { Transaction } from '../../base/core/unit-of-work.js';

/**
 * Where a consumer stands in the outbox: after the row `id` of the
 * transaction `tx` (its top-level transaction ID, as decimal text). Rows
 * are read in `(tx, id)` order, not by `id` alone: identities are handed
 * out when a row is inserted, not when its transaction commits, so a row
 * with a lower `id` can become visible after one with a higher `id`, and a
 * cursor on `id` alone would step over it for good.
 */
export interface OutboxPosition {
  readonly tx: string;
  readonly id: number;
}

/** The position of a consumer that has read nothing yet. */
export const START: OutboxPosition = Object.freeze({ tx: '0', id: 0 });

/** One outbox row, as a consumer reads it. */
export interface OutboxEvent {
  readonly position: OutboxPosition;
  /** `change-set.submit`, `lock.break`, … */
  readonly topic: string;
  readonly key: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** When its transaction wrote it. */
  readonly createdAt: Date;
}

/**
 * What `OutboxFeed.read` answers for a consumer held after a restore onto
 * another database server (#619): its cursor, or an outbox row, lay past
 * every transaction this database has handed out, so a row written now
 * could sort before ones it has passed and be skipped for good. It reads
 * nothing until the operator's recipe clears it (README, "Outbox", "After a
 * restore"), even once this server's count has caught up.
 */
export const BLOCKED = 'blocked';

/** A consumer's name: a lowercase key (`notifications`, `webhooks`). */
export const CONSUMER_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * Port: the outbox (`outbox`) read in order by named consumers, each with
 * its own cursor (`outbox_consumers`), so a consumer catches up after a
 * restart and several consumers (notifications, webhooks) read the same
 * rows independently. `outbox.delivered_at` is not used.
 *
 * A consumer reads a batch (`read`), acts on it, and moves its cursor in
 * the transaction that writes what it made of the batch (`advance`, a
 * compare-and-swap): when that transaction rolls back, or another server
 * moved the cursor meanwhile, the batch is read again, so what a consumer
 * writes must be idempotent per outbox row.
 */
export abstract class OutboxFeed {
  /**
   * The consumer's position and up to `limit` rows after it, in order.
   * Only rows whose transaction is settled: every transaction older than
   * the oldest one still running has committed or rolled back, so no row
   * can later appear before the last one returned. A transaction kept
   * open delays the rows after it; it never makes them skipped.
   *
   * `BLOCKED`, and nothing read, once the consumer's cursor or an outbox
   * row is found past every transaction this database has handed out (a
   * restore from another server); latched, checked on every read.
   */
  abstract read(
    consumer: string,
    limit: number,
  ): Promise<{ from: OutboxPosition; events: OutboxEvent[] } | typeof BLOCKED>;

  /** The consumers held after a restore (`BLOCKED`), by name. */
  abstract blocked(): Promise<string[]>;

  /**
   * Moves the consumer's cursor from `from` to `to` inside `tx`; false
   * (nothing moved) when it is no longer at `from` (another server read
   * and recorded the same batch).
   */
  abstract advance(
    tx: Transaction,
    consumer: string,
    from: OutboxPosition,
    to: OutboxPosition,
  ): Promise<boolean>;
}

/** Whether two positions are the same. */
export function samePosition(a: OutboxPosition, b: OutboxPosition): boolean {
  return a.tx === b.tx && a.id === b.id;
}
