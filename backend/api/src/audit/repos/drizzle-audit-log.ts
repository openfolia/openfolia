import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import type { PageRequest, Paginated } from '../../base/core/paging.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { Database } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import type {
  AuditEvent,
  AuditFilter,
  AuditKind,
} from '../core/audit-event.js';
import {
  AuditLog,
  type CheckedAuditEvent,
  MAX_PRUNE_ROWS,
} from '../core/audit-log.js';
import type { AuditPosition } from '../core/audit-sink.js';
import { auditEvents } from './audit.tables.js';

/** How many events one read of an export takes. */
export const STREAM_BATCH = 500;

export type AuditRow = typeof auditEvents.$inferSelect;

/** `AuditLog` over the `audit_events` table: inserts and reads, nothing else. */
@Injectable()
export class DrizzleAuditLog extends AuditLog {
  constructor(private readonly database: Database) {
    super();
  }

  protected async append(
    tx: Transaction,
    event: CheckedAuditEvent,
  ): Promise<void> {
    await drizzleOf(tx).insert(auditEvents).values({
      kind: event.kind,
      actorKind: event.actor.kind,
      actorId: event.actor.id,
      action: event.action,
      subjectType: event.subject.type,
      subjectId: event.subject.id,
      comment: event.comment,
      data: event.data,
    });
  }

  async list(
    filter: AuditFilter,
    page: PageRequest,
  ): Promise<Paginated<AuditEvent>> {
    const where = and(...conditions(filter));
    // One snapshot, so the page and the total agree.
    const [rows, [counted]] = await this.database.db.transaction(
      async (tx) => [
        await tx
          .select()
          .from(auditEvents)
          .where(where)
          .orderBy(desc(auditEvents.id))
          .limit(page.size)
          .offset((page.number - 1) * page.size),
        await tx.select({ total: count() }).from(auditEvents).where(where),
      ],
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    return { total: counted?.total ?? 0, items: rows.map(toEvent) };
  }

  /**
   * Keyset batches by `id`, newest first: each batch reads below the last
   * ID the one before ended at, so an event recorded meanwhile (a higher
   * ID) never shifts or repeats one, as an offset would.
   */
  async *stream(filter: AuditFilter): AsyncIterable<AuditEvent> {
    const where = conditions(filter);
    let below: bigint | undefined;
    for (;;) {
      const rows = await this.database.db
        .select()
        .from(auditEvents)
        .where(
          and(
            ...where,
            ...(below === undefined ? [] : [lt(auditEvents.id, below)]),
          ),
        )
        .orderBy(desc(auditEvents.id))
        .limit(STREAM_BATCH);
      for (const row of rows) yield toEvent(row);
      const last = rows.at(-1);
      if (rows.length < STREAM_BATCH || !last) return;
      below = last.id;
    }
  }

  /**
   * Through `audit_events_prune` (migration `0050`) for changes and
   * `audit_events_prune_reads` (`0063`) for reads: the only ways rows leave
   * the table.
   */
  async prune(
    before: Date,
    maxRows: number,
    keptAfter?: AuditPosition,
    kind: AuditKind = 'write',
  ): Promise<number> {
    const fn =
      kind === 'read'
        ? sql.raw('audit_events_prune_reads')
        : sql.raw('audit_events_prune');
    const rows = Math.max(1, Math.min(MAX_PRUNE_ROWS, Math.trunc(maxRows)));
    const kept = keptAfter
      ? sql`${keptAfter.tx}::xid8, ${keptAfter.id}::bigint`
      : sql`null, null`;
    const result = await this.database.db.execute<{ removed: number }>(
      sql`select ${fn}(${before.toISOString()}::timestamptz, ${rows}::integer, ${kept}) as removed`,
    );
    return Number(result.rows[0]?.removed ?? 0);
  }
}

export function toEvent(row: AuditRow): AuditEvent {
  return {
    id: String(row.id),
    at: row.at,
    kind: row.kind as AuditKind,
    actor: {
      kind: row.actorKind as AuditEvent['actor']['kind'],
      id: row.actorId,
    },
    action: row.action,
    subject: { type: row.subjectType, id: row.subjectId },
    comment: row.comment,
    data: row.data,
  };
}

function conditions({
  subject,
  actor,
  action,
  kind,
  from,
  to,
}: AuditFilter): SQL[] {
  const all: SQL[] = [];
  if (subject) {
    all.push(eq(auditEvents.subjectType, subject.type));
    if (subject.id !== undefined) {
      all.push(eq(auditEvents.subjectId, subject.id));
    }
  }
  if (actor) {
    all.push(eq(auditEvents.actorKind, actor.kind));
    if (actor.id !== undefined) all.push(eq(auditEvents.actorId, actor.id));
  }
  if (action !== undefined) all.push(eq(auditEvents.action, action));
  if (kind !== undefined) all.push(eq(auditEvents.kind, kind));
  if (from !== undefined) all.push(gte(auditEvents.at, from));
  if (to !== undefined) all.push(lt(auditEvents.at, to));
  return all;
}
