import type { Transaction } from '../../src/base/core/unit-of-work.js';
import { bySubjectKey } from '../../src/change-sets/core/commit.js';
import type { LockSubject } from '../../src/change-sets/core/lock.js';
import {
  RefreshConflictStore,
  type ReportedConflict,
} from '../../src/change-sets/core/refresh-conflicts.js';
import { keyOf } from '../../src/change-sets/core/save-point.js';
import { fakeOf } from './fake-unit-of-work.js';

/** Reported conflicts in memory, with `FakeUnitOfWork`, by change set and subject key. */
export class FakeRefreshConflicts extends RefreshConflictStore {
  readonly reports = new Map<string, Map<string, ReportedConflict>>();

  async of(_tx: Transaction, changeSetId: string): Promise<ReportedConflict[]> {
    return [...(this.reports.get(changeSetId)?.values() ?? [])].sort((a, b) =>
      bySubjectKey(a.subject, b.subject),
    );
  }

  async report(
    tx: Transaction,
    changeSetId: string,
    reports: readonly {
      readonly subject: LockSubject;
      readonly base: string;
    }[],
  ): Promise<void> {
    const at = fakeOf(tx).startedAt;
    fakeOf(tx).onCommit(() => {
      const of = this.reports.get(changeSetId) ?? new Map();
      for (const { subject, base } of reports) {
        of.set(keyOf(subject), { subject, base, reportedAt: at });
      }
      this.reports.set(changeSetId, of);
    });
  }

  async markSaved(
    tx: Transaction,
    changeSetId: string,
    subject: LockSubject,
  ): Promise<void> {
    const at = fakeOf(tx).startedAt;
    fakeOf(tx).onCommit(() => {
      const of = this.reports.get(changeSetId);
      const found = of?.get(keyOf(subject));
      if (
        of &&
        found &&
        found.savedAt === undefined &&
        // Begun after the report (`<=`: the fake's clock counts milliseconds).
        found.reportedAt.getTime() <= at.getTime()
      ) {
        of.set(keyOf(subject), { ...found, savedAt: at });
      }
    });
  }

  async markUnsaved(
    tx: Transaction,
    changeSetId: string,
    subject: LockSubject,
  ): Promise<void> {
    fakeOf(tx).onCommit(() => {
      const of = this.reports.get(changeSetId);
      const found = of?.get(keyOf(subject));
      if (of && found) {
        of.set(keyOf(subject), {
          subject: found.subject,
          base: found.base,
          reportedAt: found.reportedAt,
        });
      }
    });
  }

  async clear(tx: Transaction, changeSetId: string): Promise<number> {
    const count = this.reports.get(changeSetId)?.size ?? 0;
    fakeOf(tx).onCommit(() => this.reports.delete(changeSetId));
    return count;
  }
}
