import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Database } from '../../database/database.js';
import {
  type AuditPosition,
  AuditSinkCursor,
  SINK_START,
  type SinkEntry,
} from '../core/audit-sink.js';
import { AUDIT_SINK_ROW, auditEvents, auditSink } from './audit.tables.js';
import { toEvent } from './drizzle-audit-log.js';

/** The most events one read returns, whatever is asked. */
export const MAX_SINK_READ = 1_000;

/**
 * `AuditSinkCursor` over `audit_sink` and `audit_events`. Events are read
 * in `(tx_id, id)` order, only those of transactions older than the
 * oldest one running (`pg_snapshot_xmin(pg_current_snapshot())`): every
 * one of those has ended, so the events below that horizon are final and
 * a cursor moving through them never steps over one (`DrizzleOutboxFeed`'s
 * rule). The lease and the move are single statements on the one row.
 */
@Injectable()
export class DrizzleAuditSinkCursor extends AuditSinkCursor {
  private made = false;

  constructor(private readonly database: Database) {
    super();
  }

  async claim(
    holder: string,
    leaseMs: number,
  ): Promise<AuditPosition | undefined | 'ahead'> {
    await this.ensure();
    const ms = Math.max(1_000, Math.trunc(leaseMs));
    // Ahead: the cursor, or an event, lies past every transaction this
    // database has handed out (restored from another server, whose count
    // they carry). Latched in `blocked` until the operator's recipe clears
    // it, so the check cannot pass again once this database's count has
    // caught up while the restored positions still mean nothing here.
    const ahead = sql`(${auditSink.lastTxId} >= pg_snapshot_xmax(pg_current_snapshot()) or coalesce((select max(${auditEvents.txId}) from ${auditEvents} where ${auditEvents.txId} is distinct from pg_current_xact_id_if_assigned()) >= pg_snapshot_xmax(pg_current_snapshot()), false))`;
    const [row] = await this.database.db
      .update(auditSink)
      .set({
        claimedBy: holder,
        claimedUntil: sql`now() + ${ms} * interval '1 millisecond'`,
        blocked: sql`${auditSink.blocked} or ${ahead}`,
      })
      .where(
        sql`${auditSink.name} = ${AUDIT_SINK_ROW} and (${auditSink.claimedBy} is null or ${auditSink.claimedBy} = ${holder} or ${auditSink.claimedUntil} < now())`,
      )
      .returning({
        tx: sql<string>`${auditSink.lastTxId}::text`,
        id: sql<string>`${auditSink.lastId}::text`,
        ahead: auditSink.blocked,
      });
    if (!row) return undefined;
    return row.ahead ? 'ahead' : { tx: row.tx, id: row.id };
  }

  async read(after: AuditPosition, limit: number): Promise<SinkEntry[]> {
    const take = Math.max(1, Math.min(MAX_SINK_READ, Math.trunc(limit)));
    const rows = await this.database.db
      .select({
        row: auditEvents,
        tx: sql<string>`${auditEvents.txId}::text`,
      })
      .from(auditEvents)
      .where(
        sql`(${auditEvents.txId}, ${auditEvents.id}) > (${after.tx}::xid8, ${after.id}::bigint) and ${auditEvents.txId} < pg_snapshot_xmin(pg_current_snapshot())`,
      )
      .orderBy(auditEvents.txId, auditEvents.id)
      .limit(take);
    return rows.map(({ row, tx }) => ({
      position: { tx, id: String(row.id) },
      event: toEvent(row),
    }));
  }

  async advance(
    holder: string,
    from: AuditPosition,
    to: AuditPosition,
  ): Promise<boolean> {
    const moved = await this.database.db
      .update(auditSink)
      .set({
        lastTxId: sql`${to.tx}::xid8`,
        lastId: sql`${to.id}::bigint`,
        updatedAt: sql`now()`,
      })
      .where(
        sql`${auditSink.name} = ${AUDIT_SINK_ROW} and ${auditSink.claimedBy} = ${holder} and ${auditSink.lastTxId} = ${from.tx}::xid8 and ${auditSink.lastId} = ${from.id}::bigint`,
      )
      .returning({ name: auditSink.name });
    return moved.length > 0;
  }

  async release(holder: string): Promise<void> {
    await this.database.db
      .update(auditSink)
      .set({ claimedBy: null, claimedUntil: null })
      .where(
        sql`${auditSink.name} = ${AUDIT_SINK_ROW} and ${auditSink.claimedBy} = ${holder}`,
      );
  }

  async position(): Promise<AuditPosition> {
    const [row] = await this.database.db
      .select({
        tx: sql<string>`${auditSink.lastTxId}::text`,
        id: sql<string>`${auditSink.lastId}::text`,
      })
      .from(auditSink)
      .where(sql`${auditSink.name} = ${AUDIT_SINK_ROW}`);
    return row ? { tx: row.tx, id: row.id } : SINK_START;
  }

  /** Makes the cursor row, at the start of the log, unless it is there. */
  private async ensure(): Promise<void> {
    if (this.made) return;
    await this.database.db
      .insert(auditSink)
      .values({ name: AUDIT_SINK_ROW })
      .onConflictDoNothing({ target: auditSink.name });
    this.made = true;
  }
}
