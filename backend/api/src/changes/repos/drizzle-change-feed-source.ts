import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { outbox } from '../../change-sets/repos/outbox.tables.js';
import { Database } from '../../database/database.js';
import {
  type OutboxEvent,
  type OutboxPosition,
  START,
} from '../../outbox/core/outbox-feed.js';
import { latchBlocked } from '../../outbox/repos/drizzle-outbox-feed.js';
import { outboxConsumers } from '../../outbox/repos/outbox-consumers.tables.js';
import { maintenanceLineReleases } from '../../releases/repos/maintenance-lines.tables.js';
import { ChangeFeedSource, FEED_TOPICS } from '../core/change-feed-source.js';

/** The change feed's row in `outbox_consumers`: only its `blocked` latch is used. */
export const CHANGE_FEED_CONSUMER = 'change-feed';

const topics = sql.join(
  FEED_TOPICS.map((t) => sql`${t}`),
  sql`, `,
);

/**
 * `ChangeFeedSource` over the `outbox` table (partial index
 * `outbox_change_feed`): rows of transactions older than the oldest one
 * running (`pg_snapshot_xmin(pg_current_snapshot())`), as
 * `DrizzleOutboxFeed` reads them, so the rows below that horizon are
 * final. Each read is one statement, so it sees one snapshot. Its latch
 * after a restore is the outbox's (`latchBlocked`), on its own row
 * (`CHANGE_FEED_CONSUMER`).
 */
@Injectable()
export class DrizzleChangeFeedSource extends ChangeFeedSource {
  /** Whether the latch's row is known to exist. */
  private made = false;

  constructor(private readonly database: Database) {
    super();
  }

  async blocked(): Promise<boolean> {
    if (!this.made) {
      await this.database.db
        .insert(outboxConsumers)
        .values({ name: CHANGE_FEED_CONSUMER })
        .onConflictDoNothing({ target: outboxConsumers.name });
      this.made = true;
    }
    return latchBlocked(this.database, CHANGE_FEED_CONSUMER);
  }

  async holds(position: OutboxPosition): Promise<boolean> {
    if (position.tx === START.tx && position.id === START.id) return true;
    const [row] = await this.database.db
      .select({ id: outbox.id })
      .from(outbox)
      .where(
        sql`${outbox.id} = ${position.id} and ${outbox.txId} = ${position.tx}::xid8`,
      );
    return row !== undefined;
  }

  async horizon(): Promise<OutboxPosition> {
    const [row] = await this.database.db
      .select({ tx: sql<string>`${outbox.txId}::text`, id: outbox.id })
      .from(outbox)
      .where(
        sql`${outbox.topic} in (${topics}) and ${outbox.txId} < pg_snapshot_xmin(pg_current_snapshot())`,
      )
      .orderBy(sql`${outbox.txId} desc`, sql`${outbox.id} desc`)
      .limit(1);
    return row ? { tx: row.tx, id: Number(row.id) } : START;
  }

  async after(position: OutboxPosition, limit: number): Promise<OutboxEvent[]> {
    const rows = await this.database.db
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
        sql`${outbox.topic} in (${topics}) and (${outbox.txId}, ${outbox.id}) > (${position.tx}::xid8, ${position.id}::bigint) and ${outbox.txId} < pg_snapshot_xmin(pg_current_snapshot())`,
      )
      .orderBy(outbox.txId, outbox.id)
      .limit(Math.max(1, Math.min(1_000, Math.trunc(limit))));
    return rows.map((row) => ({
      position: { tx: row.tx, id: Number(row.id) },
      topic: row.topic,
      key: row.key,
      payload: isObject(row.payload) ? row.payload : {},
      createdAt: row.createdAt,
    }));
  }

  async standingAt(position: OutboxPosition): Promise<string | undefined> {
    const at = sql`(${position.tx}::xid8, ${position.id}::bigint)`;
    const [row] = await this.database.db
      .select({ id: sql<string>`${outbox.payload}->>'releaseId'` })
      .from(outbox)
      .where(
        sql`${outbox.topic} = 'release.published' and (${outbox.txId}, ${outbox.id}) <= ${at}
          and not exists (select 1 from ${maintenanceLineReleases} where ${maintenanceLineReleases.releaseId}::text = ${outbox.payload}->>'releaseId')
          and not exists (select 1 from "outbox" "withdrawal" where "withdrawal"."topic" = 'release.withdrawn' and "withdrawal"."key" = ${outbox.key} and ("withdrawal"."tx_id", "withdrawal"."id") <= ${at})`,
      )
      .orderBy(sql`${outbox.txId} desc`, sql`${outbox.id} desc`)
      .limit(1);
    return row?.id ?? undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
