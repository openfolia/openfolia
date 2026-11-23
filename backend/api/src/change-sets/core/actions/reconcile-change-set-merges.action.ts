import { Injectable } from '@nestjs/common';
import type { UnguardedAction } from '../../../access/core/policy.js';
import { BOUNDED, UnitOfWork } from '../../../base/core/unit-of-work.js';
import { ChangeSetBranches } from '../change-set-branches.js';
import type { ChangeSet } from '../change-set.js';
import { type ChangeSetCursor, ChangeSetStore } from '../change-set-store.js';
import { Workflow } from '../workflow.js';

/** How many approved change sets one page of a run reads. */
export const MERGES_PAGE_SIZE = 100;

/** At most this many pages per run; the rest wait for the next run. */
export const MAX_MERGE_PAGES_PER_RUN = 5;

/** What a run found and did. */
export interface MergeReconcileReport {
  /** Change sets recorded as merged after the fact. */
  readonly recovered: string[];
  /** Change sets whose check failed, with why; tried again next run. */
  readonly failed: { changeSetId: string; error: unknown }[];
  /** How many approved change sets this run looked at. */
  looked: number;
  /**
   * Whether it stopped at its time or page budget before the end: the
   * next run resumes after the last one it looked at.
   */
  stopped: boolean;
}

/**
 * Records merges that landed in Git but not in the database: a merge
 * (`MergeChangeSetAction`) whose transaction failed, or whose process
 * stopped, after its base branch moved. It walks the `approved` change
 * sets oldest first, in keyset pages of `MERGES_PAGE_SIZE`, and asks for
 * each whether its review head is in its base branch's history; when it
 * is, it holds the change set's row and, if it is still approved at that
 * head, records the merge (`Workflow.recordMerge`, `data.recovered`), as
 * `RECONCILER_ACTOR` (`Workflow.landedMerge`). Reachability, not a
 * trailer, decides: a review head in the base's history is merged, however
 * it got there.
 *
 * **Budget (L6):** a run stops at `deadline` (checked before each change
 * set) and after `MAX_MERGE_PAGES_PER_RUN` pages, and remembers the last
 * change set it looked at: the next run resumes after it, and one that
 * reaches the end starts over at the oldest next time. So however many
 * change sets are approved, each is looked at within a few runs and no run
 * runs on unbounded. The place is kept in this process only (a restart
 * starts at the oldest). Runs for nobody: `ChangeSetReconciler` starts it.
 */
@Injectable()
export class ReconcileChangeSetMergesAction implements UnguardedAction {
  readonly policy = 'internal';

  /** The last change set a run looked at, when it stopped before the end. */
  private resumeAfter: ChangeSetCursor | undefined;

  constructor(
    private readonly store: ChangeSetStore,
    private readonly branches: ChangeSetBranches,
    private readonly workflow: Workflow,
    private readonly unit: UnitOfWork,
  ) {}

  async handle(
    budget: {
      /** When to stop (epoch milliseconds); no time limit when left out. */
      readonly deadline?: number;
      /** The clock the deadline is read against. */
      readonly now?: () => number;
    } = {},
  ): Promise<MergeReconcileReport> {
    const now = budget.now ?? Date.now;
    const report: MergeReconcileReport = {
      recovered: [],
      failed: [],
      looked: 0,
      stopped: false,
    };
    let after = this.resumeAfter;
    for (let page = 0; page < MAX_MERGE_PAGES_PER_RUN; page++) {
      const items = await this.store.listInState(
        'approved',
        MERGES_PAGE_SIZE,
        after,
      );
      for (const changeSet of items) {
        if (budget.deadline !== undefined && now() >= budget.deadline) {
          this.resumeAfter = after;
          report.stopped = true;
          return report;
        }
        await this.reconcile(changeSet, report);
        report.looked++;
        after = { createdAt: changeSet.createdAt, id: changeSet.id };
      }
      if (items.length < MERGES_PAGE_SIZE) {
        // The end: the next run starts at the oldest again.
        this.resumeAfter = undefined;
        return report;
      }
    }
    this.resumeAfter = after;
    report.stopped = true;
    return report;
  }

  private async reconcile(
    changeSet: ChangeSet,
    report: MergeReconcileReport,
  ): Promise<void> {
    const reviewHead = changeSet.reviewHead;
    if (reviewHead === undefined) return;
    try {
      // Before taking the row: most approved change sets are not merged.
      if (!(await this.branches.contains(changeSet.baseRef, reviewHead))) {
        return;
      }
      const recorded = await this.unit.run(async (tx) => {
        const locked = await this.store.lock(tx, changeSet.id);
        if (locked?.state !== 'approved' || locked.reviewHead !== reviewHead) {
          return false;
        }
        return (await this.workflow.landedMerge(tx, locked)) !== undefined;
      }, BOUNDED);
      if (recorded) report.recovered.push(changeSet.id);
    } catch (error) {
      report.failed.push({ changeSetId: changeSet.id, error });
    }
  }
}
