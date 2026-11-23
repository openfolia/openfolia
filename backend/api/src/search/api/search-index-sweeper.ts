import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ServerRole } from '../../config/server-role.js';
import {
  SearchIndexSweep,
  type SearchSweepReport,
} from '../core/search-index-sweep.js';

/** The first sweep, a while after start-up. */
export const FIRST_SEARCH_SWEEP_MS = 5 * 60_000;
/** Then every hour; one at a time per server. */
export const SEARCH_SWEEP_EVERY_MS = 60 * 60_000;
/** After a run its bounds stopped (and no step failed): the next one this soon. */
export const SEARCH_SWEEP_AGAIN_MS = 60_000;

/**
 * Sweeps the search index (`SearchIndexSweep`, #540) on a timer: five
 * minutes after start-up, then every hour (a minute after a run its
 * bounds stopped, so a backlog is worked off), never two at once, on a
 * process that runs background work (`all`, `worker`; #527). Servers side
 * by side may each sweep: every removal is checked again in its own
 * statement and skips rows another transaction holds. Each run is bounded
 * (rows, time); what it removed is logged, never what the rows held.
 * Shutdown waits for a running one.
 */
@Injectable()
export class SearchIndexSweeper
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(SearchIndexSweeper.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<SearchSweepReport>;
  private stopped = false;

  constructor(
    private readonly role: ServerRole,
    private readonly index: SearchIndexSweep,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.role.runsBackground) return;
    this.schedule(FIRST_SEARCH_SWEEP_MS);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  /** One sweep now (also for tests); never rejects. */
  async runOnce(): Promise<SearchSweepReport> {
    const report = await this.index.sweep();
    const removed =
      report.scopes +
      report.memberSets +
      report.documents +
      report.textsMarked +
      report.texts +
      report.orphans +
      report.modelEmbeddings;
    if (removed > 0) {
      this.logger.log(
        `Search index swept in ${report.ms} ms: ${report.scopes} scopes, ${report.memberSets} member sets (${report.scopeMembers} members), ` +
          `${report.documents} documents, ${report.textsMarked} texts marked unused, ` +
          `${report.texts} texts with ${report.embeddings} embeddings, ${report.orphans} embeddings without text, ` +
          `${report.modelEmbeddings} embeddings of models no longer configured` +
          (report.complete ? '.' : '; more is left for the next run.'),
      );
    }
    if (report.failed) {
      this.logger.warn(
        'A step of the search index sweep failed (logged above); the next run is in an hour.',
      );
    }
    return report;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      let again = false;
      this.running = this.runOnce()
        .then((report) => {
          // Sooner only to work off a backlog, never after a failure (a
          // step that keeps failing would otherwise run every minute).
          again = !report.complete && !report.failed;
          return report;
        })
        .finally(() => {
          this.running = undefined;
          this.schedule(again ? SEARCH_SWEEP_AGAIN_MS : SEARCH_SWEEP_EVERY_MS);
        });
    }, ms);
    this.timer.unref();
  }
}
