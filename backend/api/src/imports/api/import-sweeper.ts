import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ServerRole } from '../../config/server-role.js';
import { SweepImportsAction } from '../core/actions/sweep-imports.action.js';

/** The first sweep, a while after start-up. */
export const FIRST_SWEEP_MS = 90_000;
/** Then every so often; one at a time per server. */
export const SWEEP_EVERY_MS = 10 * 60_000;

/**
 * Removes expired imports and their uploads (`SweepImportsAction`) on a
 * timer: 90 s after start-up, then every ten minutes, never two at once.
 * Servers side by side may each sweep: every removal is checked again
 * under the import's row lock and its upload's hash lock. A failing sweep
 * is logged and the next one tries again; shutdown waits for a running
 * one.
 */
@Injectable()
export class ImportSweeper
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(ImportSweeper.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly role: ServerRole,
    private readonly sweep: SweepImportsAction,
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
      const report = await this.sweep.handle({ now });
      for (const { id, error } of report.failed) {
        this.logger.warn(
          `Removing the expired import ${id} failed: ${String(error)}`,
        );
      }
    } catch (error) {
      this.logger.error('Sweeping expired imports failed', error);
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
