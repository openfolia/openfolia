import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import { isChangeSetId } from '../core/change-set.js';
import { type LockSubject, subjectKey, subjectOfKey } from '../core/lock.js';
import {
  RefreshConflictStore,
  type ReportedConflict,
} from '../core/refresh-conflicts.js';
import { refreshConflicts } from './refresh-conflicts.tables.js';

/** `RefreshConflictStore` over `refresh_conflicts`. */
@Injectable()
export class DrizzleRefreshConflicts extends RefreshConflictStore {
  async of(tx: Transaction, changeSetId: string): Promise<ReportedConflict[]> {
    if (!isChangeSetId(changeSetId)) return [];
    const rows = await drizzleOf(tx)
      .select()
      .from(refreshConflicts)
      .where(eq(refreshConflicts.changeSetId, changeSetId))
      .orderBy(
        asc(refreshConflicts.subjectType),
        asc(refreshConflicts.subjectId),
      );
    return rows.flatMap((row) => {
      const subject = subjectOfKey({
        type: row.subjectType,
        id: row.subjectId,
      });
      if (!subject) return [];
      return [
        {
          subject,
          base: row.base,
          reportedAt: row.reportedAt,
          ...(row.savedAt !== null && { savedAt: row.savedAt }),
        },
      ];
    });
  }

  async report(
    tx: Transaction,
    changeSetId: string,
    reports: readonly {
      readonly subject: LockSubject;
      readonly base: string;
    }[],
  ): Promise<void> {
    if (reports.length === 0) return;
    await drizzleOf(tx)
      .insert(refreshConflicts)
      .values(
        reports.map(({ subject, base }) => {
          const key = subjectKey(subject);
          return {
            changeSetId,
            subjectType: key.type,
            subjectId: key.id,
            base,
            reportedAt: sql`now()`,
            savedAt: null,
          };
        }),
      )
      .onConflictDoUpdate({
        target: [
          refreshConflicts.changeSetId,
          refreshConflicts.subjectType,
          refreshConflicts.subjectId,
        ],
        set: {
          base: sql`excluded.base`,
          reportedAt: sql`excluded.reported_at`,
          savedAt: sql`null`,
        },
      });
  }

  async markSaved(
    tx: Transaction,
    changeSetId: string,
    subject: LockSubject,
  ): Promise<void> {
    if (!isChangeSetId(changeSetId)) return;
    const key = subjectKey(subject);
    await drizzleOf(tx)
      .update(refreshConflicts)
      .set({ savedAt: sql`now()` })
      .where(
        and(
          eq(refreshConflicts.changeSetId, changeSetId),
          eq(refreshConflicts.subjectType, key.type),
          eq(refreshConflicts.subjectId, key.id),
          isNull(refreshConflicts.savedAt),
          // Begun after the report: `now()` is this transaction's start.
          lt(refreshConflicts.reportedAt, sql`now()`),
        ),
      );
  }

  async markUnsaved(
    tx: Transaction,
    changeSetId: string,
    subject: LockSubject,
  ): Promise<void> {
    if (!isChangeSetId(changeSetId)) return;
    const key = subjectKey(subject);
    await drizzleOf(tx)
      .update(refreshConflicts)
      .set({ savedAt: null })
      .where(
        and(
          eq(refreshConflicts.changeSetId, changeSetId),
          eq(refreshConflicts.subjectType, key.type),
          eq(refreshConflicts.subjectId, key.id),
        ),
      );
  }

  async clear(tx: Transaction, changeSetId: string): Promise<number> {
    if (!isChangeSetId(changeSetId)) return 0;
    const removed = await drizzleOf(tx)
      .delete(refreshConflicts)
      .where(eq(refreshConflicts.changeSetId, changeSetId))
      .returning({ id: refreshConflicts.subjectId });
    return removed.length;
  }
}
