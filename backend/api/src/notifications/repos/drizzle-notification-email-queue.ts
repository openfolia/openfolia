import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { users } from '../../access/repos/access.tables.js';
import { Database } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import {
  NOTIFICATION_KINDS,
  NotificationKind,
  NotificationSubjectType,
} from '../core/notification.js';
import {
  type ClaimedEmails,
  type EmailGroup,
  type EmailSend,
  NotificationEmailQueue,
  type ScheduledEmail,
  type WaitingDigest,
} from '../core/notification-email-queue.js';
import { toNotification } from './drizzle-notification-store.js';
import {
  notificationEmails,
  notificationEmailSends,
} from './notification-emails.tables.js';
import { notifications } from './notifications.tables.js';

/** A row no sender holds: never claimed, or its lease ran out. */
const free = sql`(${notificationEmails.claimedUntil} is null or ${notificationEmails.claimedUntil} < now())`;

/** `NotificationEmailQueue` over `notification_emails` and `notification_email_sends`. */
@Injectable()
export class DrizzleNotificationEmailQueue extends NotificationEmailQueue {
  constructor(private readonly database: Database) {
    super();
  }

  async schedule(
    tx: Transaction,
    emails: readonly ScheduledEmail[],
  ): Promise<number> {
    let scheduled = 0;
    for (let start = 0; start < emails.length; start += 500) {
      const slice = emails.slice(start, start + 500);
      const values = sql.join(
        slice.map(
          (e) =>
            sql`(${e.outboxId}::bigint, ${e.recipient}::text, ${e.mode}::text)`,
        ),
        sql`, `,
      );
      const rows = await drizzleOf(tx).execute<{ id: number }>(sql`
        insert into ${notificationEmails} (notification_id, recipient_id, mode)
        select n.id, n.recipient_id, v.mode
        from (values ${values}) as v(outbox_id, recipient_id, mode)
        join ${notifications} n
          on n.outbox_id = v.outbox_id and n.recipient_id = v.recipient_id
        join ${users} u on u.id = n.recipient_id
        on conflict (notification_id) do nothing
        returning id`);
      scheduled += rows.rows.length;
    }
    return scheduled;
  }

  async dueNow(before: Date, limit: number): Promise<EmailGroup[]> {
    const rows = await this.database.db
      .select({
        recipient: notificationEmails.recipientId,
        kind: notifications.kind,
        subjectType: notifications.subjectType,
        subjectId: notifications.subjectId,
        oldest: sql<Date>`min(${notificationEmails.createdAt})`,
      })
      .from(notificationEmails)
      .innerJoin(
        notifications,
        eq(notifications.id, notificationEmails.notificationId),
      )
      .where(
        and(
          eq(notificationEmails.mode, 'now'),
          free,
          // Only kinds this server knows: another's would hold up the oldest-first limit.
          inArray(notifications.kind, [...NOTIFICATION_KINDS]),
        ),
      )
      .groupBy(
        notificationEmails.recipientId,
        notifications.kind,
        notifications.subjectType,
        notifications.subjectId,
      )
      .having(
        sql`min(${notificationEmails.createdAt}) <= ${before.toISOString()}::timestamptz`,
      )
      .orderBy(sql`min(${notificationEmails.createdAt})`)
      .limit(limit);
    const groups: EmailGroup[] = [];
    for (const row of rows) {
      const kind = NotificationKind.safeParse(row.kind);
      const type = NotificationSubjectType.safeParse(row.subjectType);
      if (!kind.success || !type.success) continue;
      groups.push({
        mode: 'now',
        recipient: row.recipient,
        kind: kind.data,
        subject: { type: type.data, id: row.subjectId },
      });
    }
    return groups;
  }

  async waitingDigests(limit: number): Promise<WaitingDigest[]> {
    const rows = await this.database.db
      .select({
        recipient: notificationEmails.recipientId,
        oldest: sql<string>`min(${notificationEmails.createdAt})`,
      })
      .from(notificationEmails)
      .where(and(eq(notificationEmails.mode, 'digest'), free))
      .groupBy(notificationEmails.recipientId)
      .orderBy(sql`min(${notificationEmails.createdAt})`)
      .limit(limit);
    return rows.map((r) => ({
      recipient: r.recipient,
      oldest: new Date(r.oldest),
    }));
  }

  async claim(
    group: EmailGroup,
    leaseMs: number,
    limit: number,
  ): Promise<ClaimedEmails | undefined> {
    const claim = randomUUID();
    const db = this.database.db;
    const ofGroup =
      group.mode === 'now'
        ? sql`and n.kind = ${group.kind} and n.subject_type = ${group.subject.type} and n.subject_id = ${group.subject.id}`
        : sql``;
    // Held in one statement: rows another sender is claiming at the same moment are skipped.
    const held = await db.execute<{ id: number }>(sql`
      update ${notificationEmails} set claim = ${claim}::uuid,
        claimed_until = now() + ${`${Math.ceil(leaseMs)} milliseconds`}::interval
      where id in (
        select e.id from ${notificationEmails} e
        join ${notifications} n on n.id = e.notification_id
        where e.recipient_id = ${group.recipient} and e.mode = ${group.mode}
          and (e.claimed_until is null or e.claimed_until < now()) ${ofGroup}
        order by e.id
        limit ${limit}
        for update of e skip locked)
      returning id`);
    const ids = held.rows.map((r) => Number(r.id));
    if (ids.length === 0) return undefined;
    const rows = await db
      .select({ id: notificationEmails.id, notification: notifications })
      .from(notificationEmails)
      .innerJoin(
        notifications,
        eq(notifications.id, notificationEmails.notificationId),
      )
      .where(inArray(notificationEmails.id, ids))
      .orderBy(asc(notificationEmails.id));
    const items = [];
    for (const row of rows) {
      try {
        items.push({
          id: row.id,
          notification: toNotification(row.notification),
        });
      } catch {
        // A kind this server does not know: it goes out no more.
        await this.release(claim, [row.id], 'drop');
      }
    }
    return { claim, items };
  }

  async complete(
    tx: Transaction,
    claim: string,
    ids: readonly number[],
    send: EmailSend,
  ): Promise<boolean> {
    if (ids.length === 0) return false;
    const db = drizzleOf(tx);
    const removed = await db
      .delete(notificationEmails)
      .where(
        and(
          eq(notificationEmails.claim, claim),
          inArray(notificationEmails.id, [...ids]),
        ),
      )
      .returning({ id: notificationEmails.id });
    if (removed.length === 0) return false;
    if (removed.length !== ids.length) {
      // Some went elsewhere meanwhile (a lease ran out): roll back, send none of them twice.
      throw new Error('Notification email rows were taken over while sending.');
    }
    const recorded = await db
      .insert(notificationEmailSends)
      .values({ key: send.key, recipientId: send.recipient, mode: send.mode })
      .onConflictDoNothing()
      .returning({ key: notificationEmailSends.key });
    // Sent already under this key: its rows went out with that email, so they go (committed).
    return recorded.length > 0;
  }

  async release(
    claim: string,
    ids: readonly number[],
    to: 'drop' | 'digest',
  ): Promise<void> {
    if (ids.length === 0) return;
    const where = and(
      eq(notificationEmails.claim, claim),
      inArray(notificationEmails.id, [...ids]),
    );
    if (to === 'drop') {
      await this.database.db.delete(notificationEmails).where(where);
      return;
    }
    await this.database.db
      .update(notificationEmails)
      .set({ mode: 'digest', claim: null, claimedUntil: null })
      .where(where);
  }

  async sentSince(recipient: string, since: Date): Promise<number> {
    const [row] = await this.database.db
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(notificationEmailSends)
      .where(
        and(
          eq(notificationEmailSends.recipientId, recipient),
          sql`${notificationEmailSends.sentAt} >= ${since.toISOString()}::timestamptz`,
        ),
      );
    return row?.n ?? 0;
  }

  async prune(before: Date, limit: number): Promise<number> {
    const db = this.database.db;
    const sends = await db
      .delete(notificationEmailSends)
      .where(
        inArray(
          notificationEmailSends.key,
          db
            .select({ key: notificationEmailSends.key })
            .from(notificationEmailSends)
            .where(lt(notificationEmailSends.sentAt, before))
            .limit(limit),
        ),
      )
      .returning({ key: notificationEmailSends.key });
    const rows = await db
      .delete(notificationEmails)
      .where(
        inArray(
          notificationEmails.id,
          db
            .select({ id: notificationEmails.id })
            .from(notificationEmails)
            .where(and(lt(notificationEmails.createdAt, before), free))
            .limit(limit),
        ),
      )
      .returning({ id: notificationEmails.id });
    return sends.length + rows.length;
  }
}
