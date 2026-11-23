import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, sql, type SQL } from 'drizzle-orm';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { Database } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import { isChangeSetId } from '../core/change-set.js';
import { type LockSubject, subjectKey, subjectOfKey } from '../core/lock.js';
import { kindOf } from '../core/subject-kinds.js';
import type { WorkingCopy, WorkingCopyWrite } from '../core/working-copy.js';
import {
  type VersionConflict,
  WorkingCopyStore,
  type WorkingCopySize,
} from '../core/working-copy-store.js';
import { workingCopies } from './working-copies.tables.js';

type Row = typeof workingCopies.$inferSelect;
type Db = ReturnType<typeof drizzleOf> | Database['db'];

/** `WorkingCopyStore` over the `working_copies` table. */
@Injectable()
export class DrizzleWorkingCopyStore extends WorkingCopyStore {
  constructor(private readonly database: Database) {
    super();
  }

  async find(
    changeSetId: string,
    subject: LockSubject,
  ): Promise<WorkingCopy | undefined> {
    // Postgres would refuse a malformed UUID with an error, not "none".
    if (!isChangeSetId(changeSetId)) return undefined;
    return findIn(this.database.db, changeSetId, subject);
  }

  async save(
    tx: Transaction,
    write: WorkingCopyWrite,
    expected: number,
  ): Promise<WorkingCopy | VersionConflict> {
    const db = drizzleOf(tx);
    const key = subjectKey(write.subject);
    const stored = kindOf(write.subject).stored(write.content);
    const values = {
      schemaVersion: stored.schemaVersion,
      baseCommit: write.baseCommit,
      content: stored,
      updatedByKind: write.updatedBy.kind,
      updatedById: write.updatedBy.id,
      // The transaction's time.
      updatedAt: sql`now()`,
    };
    const [row] =
      expected === 0
        ? await db
            .insert(workingCopies)
            .values({
              changeSetId: write.changeSetId,
              subjectType: key.type,
              subjectId: key.id,
              version: 1,
              createdAt: sql`now()`,
              ...values,
            })
            .onConflictDoNothing()
            .returning()
        : // Compare-and-swap: only the version the client last saw.
          await db
            .update(workingCopies)
            .set({ ...values, version: sql`${workingCopies.version} + 1` })
            .where(
              and(
                byKey(write.changeSetId, write.subject),
                eq(workingCopies.version, expected),
              ),
            )
            .returning();
    if (row) return toWorkingCopy(row);
    const current = await findIn(db, write.changeSetId, write.subject);
    return { conflict: current?.version ?? 0 };
  }

  async get(
    tx: Transaction,
    changeSetId: string,
    subject: LockSubject,
  ): Promise<WorkingCopy | undefined> {
    if (!isChangeSetId(changeSetId)) return undefined;
    return findIn(drizzleOf(tx), changeSetId, subject);
  }

  async referencedAssets(): Promise<Set<string>> {
    const rows = await this.database.db.execute<{ sha256: string }>(
      sql`select distinct m[1] as sha256 from ${workingCopies}, regexp_matches(${workingCopies.content}::text, 'sha256:([0-9a-f]{64})', 'g') as m`,
    );
    return new Set(rows.rows.map((row) => row.sha256));
  }

  async sizesOf(
    tx: Transaction,
    changeSetId: string,
  ): Promise<WorkingCopySize[]> {
    if (!isChangeSetId(changeSetId)) return [];
    const rows = await drizzleOf(tx)
      .select({
        subjectType: workingCopies.subjectType,
        subjectId: workingCopies.subjectId,
        version: workingCopies.version,
        createdAt: workingCopies.createdAt,
        // What `JSON.stringify` makes of it is a little shorter; close enough for a cap.
        bytes:
          sql<number>`octet_length(${workingCopies.content}::text)`.mapWith(
            Number,
          ),
        // A template file's text as the file will hold it (#803): its UTF-8 bytes (the database's
        // encoding is UTF8, so `octet_length` counts them).
        textBytes: sql<
          number | null
        >`case when ${workingCopies.subjectType} = 'template' then octet_length(${workingCopies.content} ->> 'text') end`,
      })
      .from(workingCopies)
      .where(eq(workingCopies.changeSetId, changeSetId))
      .orderBy(asc(workingCopies.subjectType), asc(workingCopies.subjectId));
    return rows.map((row) => {
      const subject = subjectOfKey({
        type: row.subjectType,
        id: row.subjectId,
      });
      if (!subject) {
        throw new Error(
          `A working copy of change set ${changeSetId} names an invalid subject.`,
        );
      }
      return {
        subject,
        version: row.version,
        createdAt: row.createdAt,
        bytes: row.bytes,
        ...(row.textBytes === null || row.textBytes === undefined
          ? {}
          : { textBytes: Number(row.textBytes) }),
      };
    });
  }

  async removeAt(
    tx: Transaction,
    changeSetId: string,
    subject: LockSubject,
    version: number,
    createdAt?: Date,
  ): Promise<boolean> {
    if (!isChangeSetId(changeSetId)) return false;
    const removed = await drizzleOf(tx)
      .delete(workingCopies)
      .where(
        and(
          byKey(changeSetId, subject),
          eq(workingCopies.version, version),
          // Postgres keeps microseconds, a Date milliseconds.
          createdAt === undefined
            ? undefined
            : sql`date_trunc('milliseconds', ${workingCopies.createdAt}) = ${createdAt.toISOString()}::timestamptz`,
        ),
      )
      .returning({ version: workingCopies.version });
    return removed.length > 0;
  }

  async rebase(
    tx: Transaction,
    changeSetId: string,
    subject: LockSubject,
    from: string,
    to: string,
  ): Promise<boolean> {
    if (!isChangeSetId(changeSetId)) return false;
    const moved = await drizzleOf(tx)
      .update(workingCopies)
      .set({
        baseCommit: to,
        version: sql`${workingCopies.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        and(byKey(changeSetId, subject), eq(workingCopies.baseCommit, from)),
      )
      .returning({ version: workingCopies.version });
    return moved.length > 0;
  }

  async countOf(tx: Transaction, changeSetId: string): Promise<number> {
    const [counted] = await drizzleOf(tx)
      .select({ total: count() })
      .from(workingCopies)
      .where(eq(workingCopies.changeSetId, changeSetId));
    return counted?.total ?? 0;
  }

  async remove(
    tx: Transaction,
    changeSetId: string,
    subject: LockSubject,
  ): Promise<boolean> {
    if (!isChangeSetId(changeSetId)) return false;
    const removed = await drizzleOf(tx)
      .delete(workingCopies)
      .where(byKey(changeSetId, subject))
      .returning({ version: workingCopies.version });
    return removed.length > 0;
  }

  async removeAllOf(tx: Transaction, changeSetId: string): Promise<number> {
    if (!isChangeSetId(changeSetId)) return 0;
    const removed = await drizzleOf(tx)
      .delete(workingCopies)
      .where(eq(workingCopies.changeSetId, changeSetId))
      .returning({ version: workingCopies.version });
    return removed.length;
  }
}

async function findIn(
  db: Db,
  changeSetId: string,
  subject: LockSubject,
): Promise<WorkingCopy | undefined> {
  const [row] = await db
    .select()
    .from(workingCopies)
    .where(byKey(changeSetId, subject));
  return row && toWorkingCopy(row);
}

function byKey(changeSetId: string, subject: LockSubject): SQL | undefined {
  const key = subjectKey(subject);
  return and(
    eq(workingCopies.changeSetId, changeSetId),
    eq(workingCopies.subjectType, key.type),
    eq(workingCopies.subjectId, key.id),
  );
}

function toWorkingCopy(row: Row): WorkingCopy {
  const subject = subjectOfKey({ type: row.subjectType, id: row.subjectId });
  if (!subject) {
    throw new Error(
      `A working copy of change set ${row.changeSetId} names an invalid subject.`,
    );
  }
  // Read back with the schema it was written with: a stored copy the
  // current model does not read (an older schema version) is an error,
  // never content passed on unchecked.
  const content = kindOf(subject).fromStored(row.content);
  if (content === undefined) {
    throw new Error(
      `The working copy of ${row.subjectType} ${row.subjectId} in change set ${row.changeSetId} does not fit the content model (schema version ${row.schemaVersion}).`,
    );
  }
  return {
    changeSetId: row.changeSetId,
    subject,
    content,
    baseCommit: row.baseCommit,
    version: row.version,
    updatedBy: {
      kind: row.updatedByKind as WorkingCopy['updatedBy']['kind'],
      id: row.updatedById,
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
