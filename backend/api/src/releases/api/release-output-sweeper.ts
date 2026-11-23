import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ServerRole } from '../../config/server-role.js';
import { SweepReleaseOutputsAction } from '../core/actions/sweep-release-outputs.action.js';

/** The first sweep, a while after start-up. */
export const FIRST_SWEEP_MS = 120_000;
/** Then every so often; one at a time per server. */
export const SWEEP_EVERY_MS = 10 * 60_000;

/**
 * Looks at releases whose outputs stopped moving (`SweepReleaseOutputsAction`,
 * #497) on a timer: two minutes after start-up, then every ten minutes,
 * never two at once. Servers side by side may each sweep: queuing a job
 * is keyed by its output and topping a release up holds its lock. A
 * failing sweep is logged and the next one tries again; shutdown waits
 * for a running one.
 */
@Injectable()
export class ReleaseOutputSweeper
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(ReleaseOutputSweeper.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly role: ServerRole,
    private readonly sweep: SweepReleaseOutputsAction,
  ) {}

  onApplicationBootstrap(): void {
    // Background work: a `worker` or `all` process runs it (#527).
    if (!this.role.runsBackground) return;
    this.schedule(FIRST_SWEEP_MS);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  /** One sweep now (also for tests); never rejects. */
  async runOnce(now = new Date()): Promise<void> {
    try {
      await this.sweep.handle({ now });
    } catch (error) {
      this.logger.error('Looking at stalled release outputs failed', error);
    }
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.runOnce().finally(() => {
        this.running = undefined;
        this.schedule(SWEEP_EVERY_MS);
      });
    }, ms);
    this.timer.unref();
  }
}
