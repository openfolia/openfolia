import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { PageRequest, Paginated } from '../../base/core/paging.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { Database } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import { isChangeSetId } from '../core/change-set.js';
import {
  isLockId,
  type Lock,
  type LockFilter,
  type LockHolder,
  type LockSubject,
  type NewLock,
  subjectOfKey,
  subjectKey,
} from '../core/lock.js';
import { LockStore } from '../core/lock-store.js';
import { locks } from './locks.tables.js';

type Row = typeof locks.$inferSelect;

/** `LockStore` over the `locks` table. */
@Injectable()
export class DrizzleLockStore extends LockStore {
  constructor(private readonly database: Database) {
    super();
  }

  async insert(tx: Transaction, lock: NewLock): Promise<Lock | undefined> {
    const key = subjectKey(lock.subject);
    // On a subject locked already, or being locked by a transaction not
    // yet ended (Postgres waits for it), nothing is inserted: no error,
    // so the transaction stays usable.
    const [row] = await drizzleOf(tx)
      .insert(locks)
      .values({
        id: lock.id,
        subjectType: key.type,
        subjectId: key.id,
        changeSetId: lock.changeSetId,
        holderKind: lock.holder.kind,
        holderId: lock.holder.id,
        // The transaction's time, as the audit event's `at`.
        since: sql`now()`,
      })
      .onConflictDoNothing({ target: [locks.subjectType, locks.subjectId] })
      .returning();
    return row && toLock(row);
  }

  async findBySubject(
    tx: Transaction,
    subject: LockSubject,
  ): Promise<Lock | undefined> {
    const [row] = await drizzleOf(tx)
      .select()
      .from(locks)
      .where(bySubject(subject));
    return row && toLock(row);
  }

  async hold(tx: Transaction, subject: LockSubject): Promise<Lock | undefined> {
    const [row] = await drizzleOf(tx)
      .select()
      .from(locks)
      .where(bySubject(subject))
      .for('share');
    return row && toLock(row);
  }

  async holdAll(
    tx: Transaction,
    subjects: readonly LockSubject[],
  ): Promise<Lock[]> {
    if (subjects.length === 0) return [];
    // In ID order, as every removal of several locks takes them, so two
    // transactions never wait for each other's rows (#149).
    const rows = await drizzleOf(tx)
      .select()
      .from(locks)
      .where(or(...subjects.map(bySubject)))
      .orderBy(asc(locks.id))
      .for('share');
    return rows.map(toLock);
  }

  async find(id: string): Promise<Lock | undefined> {
    // Postgres would refuse a malformed UUID with an error, not "none".
    if (!isLockId(id)) return undefined;
    const [row] = await this.database.db
      .select()
      .from(locks)
      .where(eq(locks.id, id));
    return row && toLock(row);
  }

  async list(filter: LockFilter, page: PageRequest): Promise<Paginated<Lock>> {
    if (
      filter.changeSetId !== undefined &&
      !isChangeSetId(filter.changeSetId)
    ) {
      return { total: 0, items: [] };
    }
    const where = and(...conditions(filter));
    // One snapshot, so the page and the total agree.
    const [rows, [counted]] = await this.database.db.transaction(
      async (tx) => [
        await tx
          .select()
          .from(locks)
          .where(where)
          .orderBy(desc(locks.since), desc(locks.id))
          .limit(page.size)
          .offset((page.number - 1) * page.size),
        await tx.select({ total: count() }).from(locks).where(where),
      ],
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    return { total: counted?.total ?? 0, items: rows.map(toLock) };
  }

  async all(filter: LockFilter): Promise<Lock[]> {
    if (
      filter.changeSetId !== undefined &&
      !isChangeSetId(filter.changeSetId)
    ) {
      return [];
    }
    const rows = await this.database.db
      .select()
      .from(locks)
      .where(and(...conditions(filter)))
      .orderBy(desc(locks.since), desc(locks.id));
    return rows.map(toLock);
  }

  async countHeldBy(tx: Transaction, holder: LockHolder): Promise<number> {
    const db = drizzleOf(tx);
    await lockHolder(tx, holder);
    const [counted] = await db
      .select({ total: count() })
      .from(locks)
      .where(
        and(eq(locks.holderKind, holder.kind), eq(locks.holderId, holder.id)),
      );
    return counted?.total ?? 0;
  }

  async lock(tx: Transaction, id: string): Promise<Lock | undefined> {
    if (!isLockId(id)) return undefined;
    const [row] = await drizzleOf(tx)
      .select()
      .from(locks)
      .where(eq(locks.id, id))
      .for('update');
    return row && toLock(row);
  }

  async remove(tx: Transaction, id: string): Promise<void> {
    await drizzleOf(tx).delete(locks).where(eq(locks.id, id));
  }

  async removeAllOf(tx: Transaction, changeSetId: string): Promise<Lock[]> {
    return removeOrdered(tx, eq(locks.changeSetId, changeSetId));
  }

  async removeAllHeldBy(tx: Transaction, holder: LockHolder): Promise<Lock[]> {
    await lockHolder(tx, holder);
    return removeOrdered(
      tx,
      and(eq(locks.holderKind, holder.kind), eq(locks.holderId, holder.id)),
    );
  }
}

/**
 * Removes the locks matching `where`, oldest first. Their rows are locked
 * first, in ID order (`FOR UPDATE … ORDER BY id`), as every transaction
 * holding or removing several locks takes them (`holdAll`): a plain
 * `DELETE` takes them in whatever order its plan meets them, and two
 * transactions meeting overlapping locks in opposite orders deadlock
 * (#149). A row removed by another transaction meanwhile is skipped.
 */
async function removeOrdered(
  tx: Transaction,
  where: SQL | undefined,
): Promise<Lock[]> {
  const db = drizzleOf(tx);
  const held = await db
    .select({ id: locks.id })
    .from(locks)
    .where(where)
    .orderBy(asc(locks.id))
    .for('update');
  if (held.length === 0) return [];
  const removed = await db
    .delete(locks)
    .where(
      inArray(
        locks.id,
        held.map((row) => row.id),
      ),
    )
    .returning();
  return oldestFirst(removed.map(toLock));
}

/**
 * Held until the transaction ends: two change sets of one holder taking
 * locks at once count one after the other, and a bulk removal of the
 * holder's locks waits for (or is waited for by) each of them.
 */
async function lockHolder(tx: Transaction, holder: LockHolder): Promise<void> {
  await drizzleOf(tx).execute(
    sql`select pg_advisory_xact_lock(hashtext(${`locks:${holder.kind}:${holder.id}`}))`,
  );
}

function oldestFirst(found: Lock[]): Lock[] {
  return found.sort(
    (a, b) => a.since.getTime() - b.since.getTime() || a.id.localeCompare(b.id),
  );
}

function bySubject(subject: LockSubject): SQL | undefined {
  const key = subjectKey(subject);
  return and(eq(locks.subjectType, key.type), eq(locks.subjectId, key.id));
}

function conditions({
  holder,
  changeSetId,
  subject,
  moduleLanguages,
}: LockFilter): SQL[] {
  const all: SQL[] = [];
  if (moduleLanguages !== undefined) {
    const manual = ne(locks.subjectType, 'module');
    const where =
      moduleLanguages.length === 0
        ? manual
        : or(
            manual,
            and(
              eq(locks.subjectType, 'module'),
              inArray(sql`split_part(${locks.subjectId}, '/', 1)`, [
                ...moduleLanguages,
              ]),
            ),
          );
    if (where) all.push(where);
  }
  if (holder !== undefined) all.push(eq(locks.holderId, holder));
  if (changeSetId !== undefined) all.push(eq(locks.changeSetId, changeSetId));
  if (subject !== undefined) {
    const where = bySubject(subject);
    if (where) all.push(where);
  }
  return all;
}

function toLock(row: Row): Lock {
  const subject = subjectOfKey({ type: row.subjectType, id: row.subjectId });
  if (!subject) {
    throw new Error(`Lock ${row.id} names an invalid subject.`);
  }
  return {
    id: row.id,
    subject,
    changeSetId: row.changeSetId,
    holder: {
      kind: row.holderKind as LockHolder['kind'],
      id: row.holderId,
    },
    since: row.since,
  };
}
