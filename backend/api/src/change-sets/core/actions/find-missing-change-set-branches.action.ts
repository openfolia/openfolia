import { Injectable } from '@nestjs/common';
import type { UnguardedAction } from '../../../access/core/policy.js';
import {
  type ChangeSet,
  type ChangeSetState,
  OPEN_STATES,
} from '../change-set.js';
import { ChangeSetBranches } from '../change-set-branches.js';
import { type ChangeSetCursor, ChangeSetStore } from '../change-set-store.js';

/** How many change sets of one state one page reads. */
export const MISSING_PAGE_SIZE = 100;

/** At most this many pages per state and run; the rest wait for the next run. */
export const MAX_MISSING_PAGES_PER_STATE = 10;

/** An open change set whose branch is gone. */
export interface MissingBranch {
  readonly changeSetId: string;
  readonly branch: string;
  readonly state: ChangeSetState;
}

/** What a run found. */
export interface MissingBranchReport {
  readonly missing: MissingBranch[];
  /** Whether it looked at every open change set (not stopped by its budget). */
  complete: boolean;
}

/**
 * Finds the open change sets (`OPEN_STATES`) whose branch is gone from the
 * content repository (deleted outside the API, or the repository restored
 * or replaced), for the reconciler to log (#317). It only reads: nothing
 * is recreated or changed, and such a change set holds up no other step.
 * One read of the change-set branches, then the open change sets oldest
 * first in keyset pages of `MISSING_PAGE_SIZE`, at most
 * `MAX_MISSING_PAGES_PER_STATE` per state, stopping at `deadline`. Runs for
 * nobody: `ChangeSetReconciler` starts it.
 */
@Injectable()
export class FindMissingChangeSetBranchesAction implements UnguardedAction {
  readonly policy = 'internal';

  constructor(
    private readonly store: ChangeSetStore,
    private readonly branches: ChangeSetBranches,
  ) {}

  async handle(
    budget: {
      /** When to stop (epoch milliseconds); no time limit when left out. */
      readonly deadline?: number;
      /** The clock the deadline is read against. */
      readonly now?: () => number;
    } = {},
  ): Promise<MissingBranchReport> {
    const now = budget.now ?? Date.now;
    const pastDeadline = () =>
      budget.deadline !== undefined && now() >= budget.deadline;
    const report: MissingBranchReport = { missing: [], complete: true };
    const present = new Set((await this.branches.list()).map((b) => b.name));
    const note = (changeSet: ChangeSet) => {
      if (present.has(changeSet.branch)) return;
      report.missing.push({
        changeSetId: changeSet.id,
        branch: changeSet.branch,
        state: changeSet.state,
      });
    };
    for (const state of OPEN_STATES) {
      let after: ChangeSetCursor | undefined;
      for (let page = 0; ; page++) {
        if (page >= MAX_MISSING_PAGES_PER_STATE || pastDeadline()) {
          report.complete = false;
          break;
        }
        const items = await this.store.listInState(
          state,
          MISSING_PAGE_SIZE,
          after,
        );
        items.forEach(note);
        const last = items.at(-1);
        if (items.length < MISSING_PAGE_SIZE || last === undefined) break;
        after = { createdAt: last.createdAt, id: last.id };
      }
    }
    return report;
  }
}
