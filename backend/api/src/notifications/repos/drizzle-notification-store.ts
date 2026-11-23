import { Injectable } from '@nestjs/common';
import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  max,
  sql,
} from 'drizzle-orm';
import type { PageRequest, Paginated } from '../../base/core/paging.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { Database } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import {
  type NewNotification,
  type Notification,
  NotificationKind,
  NotificationSubjectType,
} from '../core/notification.js';
import {
  NotificationStore,
  type UnreadState,
} from '../core/notification-store.js';
import { notifications } from './notifications.tables.js';

type Row = typeof notifications.$inferSelect;

/** `NotificationStore` over the `notifications` table; every query names its recipient. */
@Injectable()
export class DrizzleNotificationStore extends NotificationStore {
  constructor(private readonly database: Database) {
    super();
  }

  async list(
    recipient: string,
    filter: { readonly unread?: boolean },
    page: PageRequest,
  ): Promise<Paginated<Notification> & { unreadCount: number }> {
    const mine = eq(notifications.recipientId, recipient);
    const where =
      filter.unread === undefined
        ? mine
        : and(
            mine,
            filter.unread
              ? isNull(notifications.readAt)
              : sql`${notifications.readAt} is not null`,
          );
    // One snapshot, so the page, the total and the unread count agree.
    return this.database.db.transaction(
      async (tx) => {
        const rows = await tx
          .select()
          .from(notifications)
          .where(where)
          .orderBy(desc(notifications.createdAt), desc(notifications.id))
          .limit(page.size)
          .offset((page.number - 1) * page.size);
        const [counted] = await tx
          .select({ total: count() })
          .from(notifications)
          .where(where);
        const [unread] = await tx
          .select({ total: count() })
          .from(notifications)
          .where(and(mine, isNull(notifications.readAt)));
        return {
          items: rows.map(toNotification),
          total: counted?.total ?? 0,
          unreadCount: unread?.total ?? 0,
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  async find(recipient: string, id: string): Promise<Notification | undefined> {
    const [row] = await this.database.db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.recipientId, recipient),
          eq(notifications.id, Number(id)),
        ),
      );
    return row && toNotification(row);
  }

  async unread(recipient: string): Promise<UnreadState> {
    const [row] = await this.database.db
      .select({
        count:
          sql<number>`count(*) filter (where ${notifications.readAt} is null)`.mapWith(
            Number,
          ),
        latest: max(notifications.id),
      })
      .from(notifications)
      .where(eq(notifications.recipientId, recipient));
    return {
      count: row?.count ?? 0,
      latest: row?.latest == null ? undefined : String(row.latest),
    };
  }

  async owned(
    tx: Transaction,
    recipient: string,
    ids: readonly string[],
  ): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await drizzleOf(tx)
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.recipientId, recipient),
          inArray(notifications.id, ids.map(Number)),
        ),
      );
    return new Set(rows.map((r) => String(r.id)));
  }

  async markRead(
    tx: Transaction,
    recipient: string,
    ids: readonly string[] | 'all',
  ): Promise<number> {
    if (ids !== 'all' && ids.length === 0) return 0;
    const marked = await drizzleOf(tx)
      .update(notifications)
      .set({ readAt: sql`now()` })
      .where(
        and(
          eq(notifications.recipientId, recipient),
          isNull(notifications.readAt),
          ...(ids === 'all'
            ? []
            : [inArray(notifications.id, ids.map(Number))]),
        ),
      )
      .returning({ id: notifications.id });
    return marked.length;
  }

  async add(
    tx: Transaction,
    added: readonly NewNotification[],
  ): Promise<number> {
    let stored = 0;
    // In slices: one statement's parameters stay well below Postgres's limit.
    for (let start = 0; start < added.length; start += 500) {
      const rows = await drizzleOf(tx)
        .insert(notifications)
        .values(
          added.slice(start, start + 500).map((n) => ({
            outboxId: n.outboxId,
            recipientId: n.recipient,
            kind: n.kind,
            subjectType: n.subject.type,
            subjectId: n.subject.id,
            payload: n.payload,
            createdAt: n.createdAt,
          })),
        )
        .onConflictDoNothing({
          target: [notifications.outboxId, notifications.recipientId],
        })
        .returning({ id: notifications.id });
      stored += rows.length;
    }
    return stored;
  }

  async removeReadBefore(before: Date, limit: number): Promise<number> {
    const db = this.database.db;
    const oldest = db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(lt(notifications.readAt, before)))
      .limit(limit);
    const removed = await db
      .delete(notifications)
      .where(inArray(notifications.id, oldest))
      .returning({ id: notifications.id });
    return removed.length;
  }
}

function toNotification(row: Row): Notification {
  return {
    id: String(row.id),
    outboxId: Number(row.outboxId),
    recipient: row.recipientId,
    kind: NotificationKind.parse(row.kind),
    subject: {
      type: NotificationSubjectType.parse(row.subjectType),
      id: row.subjectId,
    },
    payload: row.payload as Record<string, unknown>,
    createdAt: row.createdAt,
    ...(row.readAt && { readAt: row.readAt }),
  };
}
