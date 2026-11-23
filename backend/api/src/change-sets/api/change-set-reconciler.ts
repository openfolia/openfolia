import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ServerRole } from '../../config/server-role.js';
import { ReconcileChangeSetBranchesAction } from '../core/actions/reconcile-change-set-branches.action.js';
import { ReconcileChangeSetCommitsAction } from '../core/actions/reconcile-change-set-commits.action.js';
import { ReconcileChangeSetMergesAction } from '../core/actions/reconcile-change-set-merges.action.js';
import { FindMissingChangeSetBranchesAction } from '../core/actions/find-missing-change-set-branches.action.js';

/** The first run, a while after start-up (not in the way of it). */
export const FIRST_RUN_MS = 60_000;
/** Then every so often; one run at a time per server. */
export const RUN_EVERY_MS = 10 * 60_000;
/**
 * How long one pass may take (L6): each of its three steps stops looking
 * at more once it is past, and the rest wait for the next pass (the merges
 * step resumes where it stopped). Far below `RUN_EVERY_MS`.
 */
export const RUN_BUDGET_MS = 2 * 60_000;
/** How long shutdown waits for a running pass before going on without it. */
export const SHUTDOWN_WAIT_MS = 5_000;

/**
 * Runs `ReconcileChangeSetBranchesAction`, then
 * `ReconcileChangeSetCommitsAction`, then `ReconcileChangeSetMergesAction`,
 * then `FindMissingChangeSetBranchesAction` (open change sets whose branch
 * is gone: each logged once per process, again only after it came back
 * and went again; never recreated, #317), on a timer: a minute after
 * start-up, then every ten minutes, never two at once, each pass within
 * `RUN_BUDGET_MS`. Servers running
 * side by side may each run it; every delete is a compare-and-swap, so they
 * cannot get in each other's way. A failing run is logged and the next one
 * tries again. Shutdown waits for a running pass (before the database
 * closes) for at most `SHUTDOWN_WAIT_MS`; history walks time out on their
 * own (`GitRepo.refsContaining`).
 */
@Injectable()
export class ChangeSetReconciler
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(ChangeSetReconciler.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;
  /** Open change sets whose missing branch was logged already, by ID. */
  private readonly loggedMissing = new Set<string>();

  constructor(
    private readonly role: ServerRole,
    private readonly reconcile: ReconcileChangeSetBranchesAction,
    private readonly reconcileCommits: ReconcileChangeSetCommitsAction,
    private readonly reconcileMerges: ReconcileChangeSetMergesAction,
    private readonly findMissing: FindMissingChangeSetBranchesAction,
  ) {}

  onApplicationBootstrap(): void {
    // Background work: a `worker` or `all` process runs it (#527).
    if (!this.role.runsBackground) return;
    this.schedule(FIRST_RUN_MS);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    if (!this.running) return;
    let timer: NodeJS.Timeout | undefined;
    const gaveUp = await Promise.race([
      this.running.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), SHUTDOWN_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (gaveUp) {
      this.logger.warn(
        'Shutting down while reconciling change-set branches; every step is a compare-and-swap, so the next start picks it up.',
      );
    }
  }

  /**
   * One pass now (also for tests); resolves when it is done, never
   * rejects. It stops looking at more at `deadline` (default: in
   * `RUN_BUDGET_MS`); a step already running finishes its item.
   */
  async runOnce(deadline = Date.now() + RUN_BUDGET_MS): Promise<void> {
    try {
      const report = await this.reconcile.handle({ now: Date.now(), deadline });
      if (report.removed.length > 0) {
        this.logger.warn(
          `Removed ${report.removed.length} change-set branch(es) without a change set: ${report.removed.join(', ')}`,
        );
      }
      if (report.withCommits.length > 0) {
        this.logger.error(
          `Change-set branches without a change set hold commits of their own; left for a person to look at: ${report.withCommits.join(', ')}`,
        );
      }
      if (report.foreign.length > 0) {
        this.logger.warn(
          `Branches under change-sets/ that no change set can have; left alone: ${report.foreign.join(', ')}`,
        );
      }
    } catch (error) {
      this.logger.error('Reconciling change-set branches failed', error);
    }
    await this.runCommitsOnce(deadline);
    await this.runMergesOnce(deadline);
    await this.runMissingOnce(deadline);
  }

  /**
   * Logs the open change sets whose branch is gone, each once (a person
   * leaves or abandons them; nothing is recreated); never rejects.
   */
  private async runMissingOnce(deadline: number): Promise<void> {
    try {
      const report = await this.findMissing.handle({ deadline });
      const missing = new Set(report.missing.map((m) => m.changeSetId));
      const fresh = report.missing.filter(
        (m) => !this.loggedMissing.has(m.changeSetId),
      );
      if (fresh.length > 0) {
        this.logger.warn(
          `Open change set(s) whose branch is gone from the content repository; never recreated, left for their author or an admin to abandon: ${fresh.map((m) => `${m.changeSetId} (${m.state})`).join(', ')}`,
        );
      }
      for (const m of fresh) this.loggedMissing.add(m.changeSetId);
      // One whose branch came back (or that is no longer open) is logged
      // again should it go missing later; only a pass that looked at all
      // of them can tell.
      if (report.complete) {
        for (const id of this.loggedMissing) {
          if (!missing.has(id)) this.loggedMissing.delete(id);
        }
      }
    } catch (error) {
      this.logger.error(
        'Looking for change sets whose branch is gone failed',
        error,
      );
    }
  }

  /** Records merges that landed in Git but were never recorded; never rejects. */
  private async runMergesOnce(deadline: number): Promise<void> {
    try {
      const report = await this.reconcileMerges.handle({ deadline });
      if (report.stopped) {
        this.logger.warn(
          `Reconciling change-set merges stopped at its budget after ${report.looked} approved change set(s); the next pass resumes there.`,
        );
      }
      if (report.recovered.length > 0) {
        this.logger.warn(
          `Recorded ${report.recovered.length} merge(s) of change sets that were never recorded: ${report.recovered.join(', ')}`,
        );
      }
      for (const { changeSetId, error } of report.failed) {
        this.logger.error(
          `Checking whether change set ${changeSetId} was merged failed`,
          error,
        );
      }
    } catch (error) {
      this.logger.error('Reconciling change-set merges failed', error);
    }
  }

  /** Records commits a save point left unrecorded; never rejects. */
  private async runCommitsOnce(deadline: number): Promise<void> {
    try {
      const report = await this.reconcileCommits.handle({ deadline });
      if (report.recovered.length > 0) {
        this.logger.warn(
          `Recorded ${report.recovered.length} commit(s) on change-set branches that were never recorded (dropped ${report.dropped} working copies they hold): ${report.recovered.join(', ')}`,
        );
      }
      if (report.unrecorded.length > 0) {
        this.logger.error(
          `Change-set branches with commits no save point of this API made (no commit intent matches them, whatever their trailers say); never recorded, left for a person to look at: ${report.unrecorded.join(', ')}`,
        );
      }
      if (report.expired > 0) {
        this.logger.warn(
          `Removed ${report.expired} expired commit intent(s): their commits never landed, or matched no commit on the branch.`,
        );
      }
      for (const { branch, error } of report.failed) {
        this.logger.error(`Recording the commits of ${branch} failed`, error);
      }
    } catch (error) {
      this.logger.error('Reconciling change-set commits failed', error);
    }
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.runOnce().finally(() => {
        this.running = undefined;
        this.schedule(RUN_EVERY_MS);
      });
    }, delay);
    this.timer.unref();
  }
}
