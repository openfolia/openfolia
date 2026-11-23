import { Injectable } from '@nestjs/common';
import type { UnguardedAction } from '../../../access/core/policy.js';
import { createdAtOf, idOfBranch } from '../change-set.js';
import { ChangeSetBranches } from '../change-set-branches.js';
import { ChangeSetStore } from '../change-set-store.js';

/**
 * How old a change-set branch without a change set must be before it is
 * removed: far longer than any request creating one can take, so a
 * transaction still recording its change set is never overtaken.
 */
export const ORPHAN_GRACE_MS = 60 * 60 * 1000;

/**
 * At most this many orphans are looked at (history walk, database check,
 * delete) per run; the rest wait for the next.
 */
export const MAX_ORPHANS_PER_RUN = 100;

/** What a run found and did, by branch name. */
export interface ReconcileReport {
  /** Orphans removed: no change set, no commit of their own. */
  readonly removed: string[];
  /** Orphans left because they hold commits no other ref has: for a person to look at. */
  readonly withCommits: string[];
  /** Under the change-set prefix but not named by a change-set ID: left alone. */
  readonly foreign: string[];
  /** Orphans left for a later run (moved meanwhile, or past the run's limit). */
  readonly deferred: string[];
}

/**
 * Removes change-set branches whose change set was never recorded: a
 * creation that stopped between the Git branch and the database
 * transaction (`CreateChangeSetAction`). Only branches older than
 * `ORPHAN_GRACE_MS` (by the time in their ID) are considered, only those
 * holding no commit of their own (their head is in another branch's or
 * tag's history) are deleted, the database is asked again right before
 * each, and each delete is a compare-and-swap on the commit just seen, so
 * nothing a writer added meanwhile is lost. A run looks at no more than
 * `MAX_ORPHANS_PER_RUN` orphans, and none past its `deadline`. Runs for nobody: the server starts it
 * (`ChangeSetReconciler`).
 */
@Injectable()
export class ReconcileChangeSetBranchesAction implements UnguardedAction {
  readonly policy = 'internal';

  constructor(
    private readonly branches: ChangeSetBranches,
    private readonly store: ChangeSetStore,
  ) {}

  async handle({
    now,
    deadline,
  }: {
    now: number;
    /** When to stop looking (epoch milliseconds, `Date.now()`); the rest are deferred. */
    deadline?: number;
  }): Promise<ReconcileReport> {
    const report: ReconcileReport = {
      removed: [],
      withCommits: [],
      foreign: [],
      deferred: [],
    };
    const old: { name: string; commit: string; id: string }[] = [];
    for (const head of await this.branches.list()) {
      const id = idOfBranch(head.name);
      if (id === undefined) {
        report.foreign.push(head.name);
        continue;
      }
      const createdAt = createdAtOf(id) ?? now;
      if (now - createdAt >= ORPHAN_GRACE_MS) old.push({ ...head, id });
    }
    if (old.length === 0) return report;
    const recorded = await this.store.existing(old.map((b) => b.id));
    let looked = 0;
    for (const orphan of old.filter((b) => !recorded.has(b.id))) {
      if (
        looked >= MAX_ORPHANS_PER_RUN ||
        (deadline !== undefined && Date.now() >= deadline)
      ) {
        report.deferred.push(orphan.name);
        continue;
      }
      looked++;
      if (await this.branches.hasOwnCommits(orphan.name, orphan.commit)) {
        report.withCommits.push(orphan.name);
        continue;
      }
      // Asked again right before the delete: a change set recorded since
      // the first look (a very late commit, a skewed clock) keeps its branch.
      if ((await this.store.existing([orphan.id])).has(orphan.id)) continue;
      if (await this.branches.deleteIfAt(orphan.name, orphan.commit)) {
        report.removed.push(orphan.name);
      } else {
        report.deferred.push(orphan.name);
      }
    }
    return report;
  }
}
