import type { Transaction } from '../../src/base/core/unit-of-work.js';
import {
  BLOCKED,
  type OutboxEvent,
  OutboxFeed,
  type OutboxPosition,
  samePosition,
  START,
} from '../../src/outbox/core/outbox-feed.js';
import { fakeOf } from './fake-unit-of-work.js';

const after = (a: OutboxPosition, b: OutboxPosition) =>
  BigInt(a.tx) > BigInt(b.tx) || (a.tx === b.tx && a.id > b.id);

/**
 * The outbox in memory: rows in `(tx, id)` order, a cursor per consumer,
 * moved only when its transaction commits. `pending` rows stand for a
 * transaction still running: not read until it is settled.
 */
export class FakeOutboxFeed extends OutboxFeed {
  readonly rows: (OutboxEvent & { pending?: boolean })[] = [];
  readonly cursors = new Map<string, OutboxPosition>();
  /** Consumers held after a restore: they read `BLOCKED`. */
  readonly held = new Set<string>();
  private nextId = 1;
  private nextTx = 100;
  /** Called by `advance` before it compares: a test moves the cursor there. */
  beforeAdvance?: () => void;

  /** Adds a row (its own transaction unless `tx` is given); returns it. */
  add(
    topic: string,
    payload: Record<string, unknown>,
    options: { tx?: string; pending?: boolean; key?: string } = {},
  ): OutboxEvent {
    const id = this.nextId++;
    const event = {
      position: { tx: options.tx ?? String(this.nextTx++), id },
      topic,
      key: options.key ?? `key-${id}`,
      payload,
      createdAt: new Date(),
      ...(options.pending && { pending: true }),
    };
    this.rows.push(event);
    return event;
  }

  async read(consumer: string, limit: number) {
    if (this.held.has(consumer)) return BLOCKED;
    const from = this.cursors.get(consumer) ?? START;
    const ordered = this.rows
      .filter((r) => after(r.position, from))
      .sort((a, b) => (after(a.position, b.position) ? 1 : -1));
    const events: OutboxEvent[] = [];
    for (const row of ordered) {
      // A running transaction holds back the rows after it too.
      if (row.pending) break;
      events.push(row);
      if (events.length >= limit) break;
    }
    return { from, events };
  }

  async blocked(): Promise<string[]> {
    return [...this.held].sort();
  }

  async advance(
    tx: Transaction,
    consumer: string,
    from: OutboxPosition,
    to: OutboxPosition,
  ): Promise<boolean> {
    const transaction = fakeOf(tx);
    this.beforeAdvance?.();
    if (!samePosition(this.cursors.get(consumer) ?? START, from)) return false;
    transaction.onCommit(() => this.cursors.set(consumer, to));
    return true;
  }
}
