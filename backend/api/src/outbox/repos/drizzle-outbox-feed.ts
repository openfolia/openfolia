import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { outbox } from '../../change-sets/repos/outbox.tables.js';
import { Database } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import {
  BLOCKED,
  CONSUMER_NAME,
  type OutboxEvent,
  OutboxFeed,
  type OutboxPosition,
} from '../core/outbox-feed.js';
import { outboxConsumers } from './outbox-consumers.tables.js';

/** The most rows one read returns, whatever is asked. */
export const MAX_READ = 1_000;

/**
 * `OutboxFeed` over the `outbox` and `outbox_consumers` tables. Rows are
 * read in `(tx_id, id)` order, only those of transactions older than the
 * oldest one running (`pg_snapshot_xmin(pg_current_snapshot())`): every
 * one of those has ended, so the set of rows below that horizon is final
 * and a cursor moving through it never steps over a row.
 *
 * That holds only while positions are this database's own. Before each
 * read, `latchBlocked` sets the consumer's `blocked` when its cursor or an
 * outbox row lies past every transaction handed out (a restore from
 * another server); a blocked consumer reads nothing (#619).
 */
@Injectable()
export class DrizzleOutboxFeed extends OutboxFeed {
  /** Consumers whose cursor row is known to exist. */
  private readonly known = new Set<string>();

  constructor(private readonly database: Database) {
    super();
  }

  async read(
    consumer: string,
    limit: number,
  ): Promise<{ from: OutboxPosition; events: OutboxEvent[] } | typeof BLOCKED> {
    checkName(consumer);
    await this.ensure(consumer);
    if (await latchBlocked(this.database, consumer)) return BLOCKED;
    const take = Math.max(1, Math.min(MAX_READ, Math.trunc(limit)));
    // One snapshot: the cursor and the rows after it agree.
    return this.database.db.transaction(
      async (tx) => {
        const [cursor] = await tx
          .select({
            tx: sql<string>`${outboxConsumers.lastTxId}::text`,
            id: outboxConsumers.lastOutboxId,
            blocked: outboxConsumers.blocked,
          })
          .from(outboxConsumers)
          .where(sql`${outboxConsumers.name} = ${consumer}`);
        if (!cursor) throw new Error(`No outbox cursor for "${consumer}".`);
        if (cursor.blocked) return BLOCKED;
        const rows = await tx
          .select({
            tx: sql<string>`${outbox.txId}::text`,
            id: outbox.id,
            topic: outbox.topic,
            key: outbox.key,
            payload: outbox.payload,
            createdAt: outbox.createdAt,
          })
          .from(outbox)
          .where(
            sql`(${outbox.txId}, ${outbox.id}) > (${cursor.tx}::xid8, ${cursor.id}::bigint) and ${outbox.txId} < pg_snapshot_xmin(pg_current_snapshot())`,
          )
          .orderBy(outbox.txId, outbox.id)
          .limit(take);
        return {
          from: { tx: cursor.tx, id: Number(cursor.id) },
          events: rows.map((row) => ({
            position: { tx: row.tx, id: Number(row.id) },
            topic: row.topic,
            key: row.key,
            payload: isObject(row.payload) ? row.payload : {},
            createdAt: row.createdAt,
          })),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  async advance(
    tx: Transaction,
    consumer: string,
    from: OutboxPosition,
    to: OutboxPosition,
  ): Promise<boolean> {
    checkName(consumer);
    const moved = await drizzleOf(tx)
      .update(outboxConsumers)
      .set({
        lastTxId: sql`${to.tx}::xid8`,
        lastOutboxId: to.id,
        updatedAt: sql`now()`,
      })
      .where(
        sql`${outboxConsumers.name} = ${consumer} and ${outboxConsumers.lastTxId} = ${from.tx}::xid8 and ${outboxConsumers.lastOutboxId} = ${from.id}`,
      )
      .returning({ name: outboxConsumers.name });
    return moved.length > 0;
  }

  async find(id: number): Promise<OutboxEvent | undefined> {
    const [row] = await this.database.db
      .select({
        tx: sql<string>`${outbox.txId}::text`,
        id: outbox.id,
        topic: outbox.topic,
        key: outbox.key,
        payload: outbox.payload,
        createdAt: outbox.createdAt,
      })
      .from(outbox)
      .where(sql`${outbox.id} = ${id}`);
    return row
      ? {
          position: { tx: row.tx, id: Number(row.id) },
          topic: row.topic,
          key: row.key,
          payload: isObject(row.payload) ? row.payload : {},
          createdAt: row.createdAt,
        }
      : undefined;
  }

  async blocked(): Promise<string[]> {
    const rows = await this.database.db
      .select({ name: outboxConsumers.name })
      .from(outboxConsumers)
      .where(sql`${outboxConsumers.blocked}`)
      .orderBy(outboxConsumers.name);
    return rows.map((r) => r.name);
  }

  /** Makes the consumer's cursor row, at the start, unless it is there. */
  private async ensure(consumer: string): Promise<void> {
    if (this.known.has(consumer)) return;
    await this.database.db
      .insert(outboxConsumers)
      .values({ name: consumer })
      .onConflictDoNothing({ target: outboxConsumers.name });
    this.known.add(consumer);
  }
}

/**
 * Sets `consumer`'s `blocked` (its row must exist) when its cursor, or any
 * outbox row, lies at or past `pg_snapshot_xmax(pg_current_snapshot())`:
 * no transaction this database has handed out has such an ID, so they
 * carry another server's count (a restore). Writes only when it latches;
 * answers whether the consumer is blocked, or found ahead now (a server
 * latching the same row at once updates nothing, and its snapshot may
 * predate the other's latch). The newest row is found on the
 * `(tx_id, id)` index. Shared with the change feed's latch
 * (`DrizzleChangeFeedSource`).
 */
export async function latchBlocked(
  database: Database,
  consumer: string,
): Promise<boolean> {
  const horizon = sql`pg_snapshot_xmax(pg_current_snapshot())`;
  const ahead = sql`(${outboxConsumers.lastTxId} >= ${horizon} or coalesce((select max(${outbox.txId}) from ${outbox}) >= ${horizon}, false))`;
  const result = await database.db.execute<{ blocked: boolean }>(sql`
    with latch as (
      update ${outboxConsumers} set blocked = true, updated_at = now()
      where ${outboxConsumers.name} = ${consumer} and not ${outboxConsumers.blocked} and ${ahead}
      returning ${outboxConsumers.blocked}
    )
    select coalesce((select blocked from latch), false) or coalesce(
      (select ${outboxConsumers.blocked} or ${ahead} from ${outboxConsumers} where ${outboxConsumers.name} = ${consumer}),
      false
    ) as blocked`);
  return result.rows[0]?.blocked === true;
}

function checkName(consumer: string): void {
  if (!CONSUMER_NAME.test(consumer) || consumer.length > 100) {
    throw new Error(`"${consumer}" is no outbox consumer name.`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
