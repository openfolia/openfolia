import { Injectable } from '@nestjs/common';
import type { UnguardedAction } from '../../../access/core/policy.js';
import { API_TOKEN_ACTOR } from '../../../access/core/service-actor.js';
import { NotFoundError } from '../../../base/core/errors.js';
import { BOUNDED, UnitOfWork } from '../../../base/core/unit-of-work.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import { changeSetBranch, idOfBranch } from '../change-set.js';
import { ChangeSetBranches } from '../change-set-branches.js';
import { ChangeSetCommits } from '../change-set-commits.js';
import { CommitIntents, INTENT_TTL_MS } from '../commit-intents.js';
import { ChangeSetStore } from '../change-set-store.js';
import { CommitRecorder } from '../commit-recorder.js';

/** At most this many branches are caught up per run; the rest wait for the next. */
export const MAX_BRANCHES_PER_RUN = 100;

/** At most this many change sets have their expired intents removed per run. */
export const MAX_EXPIRED_PER_RUN = 100;

/** What a run found and did. */
export interface CommitReconcileReport {
  /** Commits recorded after the fact, by commit ID. */
  readonly recovered: string[];
  /** Working copies dropped because what they hold was committed. */
  dropped: number;
  /**
   * Branches whose head (or a commit under it) is unrecorded and matches
   * no commit intent: not made by a save point of this API, whatever its
   * trailers say. Left as they are, for a person to look at.
   */
  readonly unrecorded: string[];
  /** Branches left for a later run (past the run's limit or its deadline). */
  readonly deferred: string[];
  /** Commit intents removed because they expired (their commit never landed). */
  expired: number;
  /** Branches whose catching up failed, with why; tried again next run. */
  readonly failed: { branch: string; error: unknown }[];
}

/**
 * Records commits on change-set branches that were never recorded: a save
 * point (`CommitWorkingCopiesAction`) that stopped, or whose transaction
 * failed, after its Git commit. Looks at every branch whose head is
 * neither its change set's base commit nor a recorded commit and whose
 * change set has a commit intent, and, holding its change set's row,
 * records what `CommitRecorder.catchUp` finds (audit events and outbox
 * rows, from the intents: a commit matching none is never recorded), then
 * drops the working copies that hold exactly what the branch now has. A
 * working copy that differs stays (nothing typed is lost). A head with no
 * intent to match is reported (`unrecorded`) and left, without a lock.
 * Then intents older than `INTENT_TTL_MS` are removed (oldest first, at
 * most `MAX_EXPIRED_PER_RUN` change sets), after one more catch-up of
 * their change set under its row lock, and also when its branch is
 * gone: their commit never landed, or cannot be recovered. Runs for nobody: the server starts it
 * (`ChangeSetReconciler`); it reads the branches as the read-only service
 * the API token acts as.
 */
@Injectable()
export class ReconcileChangeSetCommitsAction implements UnguardedAction {
  readonly policy = 'internal';

  constructor(
    private readonly branches: ChangeSetBranches,
    private readonly store: ChangeSetStore,
    private readonly commits: ChangeSetCommits,
    private readonly intents: CommitIntents,
    private readonly recorder: CommitRecorder,
    private readonly openSnapshot: OpenSnapshotAction,
    private readonly unit: UnitOfWork,
  ) {}

  async handle(
    budget: {
      /** When to stop (epoch milliseconds, `Date.now()`); the rest are deferred. */
      readonly deadline?: number;
    } = {},
  ): Promise<CommitReconcileReport> {
    const pastDeadline = () =>
      budget.deadline !== undefined && Date.now() >= budget.deadline;
    const report: CommitReconcileReport = {
      recovered: [],
      dropped: 0,
      unrecorded: [],
      deferred: [],
      expired: 0,
      failed: [],
    };
    const heads = (await this.branches.list()).flatMap((head) => {
      const id = idOfBranch(head.name);
      return id === undefined ? [] : [{ ...head, id }];
    });
    const recorded = await this.commits.recorded(heads.map((h) => h.commit));
    const unrecorded = heads.filter((h) => !recorded.has(h.commit));
    const pending = await this.intents.pendingFor(unrecorded.map((h) => h.id));
    let looked = 0;
    for (const head of unrecorded) {
      const changeSet = await this.store.find(head.id);
      // No change set: an orphan branch, for the branch reconciler.
      if (!changeSet || changeSet.baseCommit === head.commit) continue;
      // Nothing to match it against: never recorded. Told apart before
      // any lock, and not counted against the limit, so such branches
      // never starve a real recovery.
      if (!pending.has(head.id)) {
        report.unrecorded.push(head.name);
        continue;
      }
      if (looked >= MAX_BRANCHES_PER_RUN || pastDeadline()) {
        report.deferred.push(head.name);
        continue;
      }
      looked++;
      await this.catchUp(head.id, head.name, report, 0);
    }
    for (const id of await this.intents.expiredChangeSets(
      INTENT_TTL_MS,
      MAX_EXPIRED_PER_RUN,
    )) {
      // Past the deadline: the rest expire next run.
      if (pastDeadline()) break;
      await this.catchUp(id, changeSetBranch(id), report, INTENT_TTL_MS);
    }
    return report;
  }

  /**
   * Catches the change set's branch up under its row lock, then (with
   * `expireAfterMs`) removes its intents older than that.
   */
  private async catchUp(
    id: string,
    branch: string,
    report: CommitReconcileReport,
    expireAfterMs: number,
  ): Promise<void> {
    try {
      const result = await this.unit.run(async (tx) => {
        // Held: no commit of this change set is made or recorded meanwhile.
        const locked = await this.store.lock(tx, id);
        if (!locked) return undefined;
        // `authored` given: inside this transaction, no second query (a
        // branch that is gone is then plainly not found, never asked about).
        const snapshot = await this.openSnapshot.handle({
          actor: API_TOKEN_ACTOR,
          ref: locked.branch,
          authored: false,
        });
        const found = await this.recorder.catchUp(tx, locked, snapshot.commit);
        const dropped =
          found.recovered.length > 0
            ? await this.recorder.dropCommitted(tx, locked.id, snapshot)
            : 0;
        const expired =
          expireAfterMs > 0
            ? await this.intents.removeExpired(tx, id, expireAfterMs)
            : 0;
        return { found, dropped: dropped + found.dropped, expired };
      }, BOUNDED);
      if (!result) return;
      report.recovered.push(...result.found.recovered);
      report.dropped += result.dropped;
      report.expired += result.expired;
      if (
        result.found.unmatched !== undefined &&
        !report.unrecorded.includes(branch)
      ) {
        report.unrecorded.push(branch);
      }
    } catch (error) {
      // One branch failing (a broken file, a Git error) holds up no other.
      // A branch that is gone is no failure of this step: the missing
      // branches step logs it, once (#317).
      const gone =
        error instanceof NotFoundError &&
        (await this.branches.head(branch).catch(() => '')) === undefined;
      if (!gone) report.failed.push({ branch, error });
      // An intent past its time whose branch is gone (deleted from
      // outside) goes even so: nothing can be recovered from it. Any other
      // failure keeps it, so a commit that landed is never written off.
      if (expireAfterMs > 0 && error instanceof NotFoundError) {
        try {
          report.expired += await this.unit.run(async (tx) => {
            if (!(await this.store.lock(tx, id))) return 0;
            return this.intents.removeExpired(tx, id, expireAfterMs);
          }, BOUNDED);
        } catch {
          // Tried again next run; the failure above is reported.
        }
      }
    }
  }
}
