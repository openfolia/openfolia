import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ServerRole } from '../../config/server-role.js';
import { SweepBrandingImagesAction } from '../core/actions/sweep-branding-images.action.js';

/** The first sweep, a while after start-up. */
export const FIRST_SWEEP_MS = 120_000;
/** Then every so often; one at a time per server. */
export const SWEEP_EVERY_MS = 60 * 60_000;

/**
 * Removes unused branding images a day old (`SweepBrandingImagesAction`,
 * #559) on a timer: two minutes after start-up, then hourly, never two at
 * once. Servers side by side may each sweep: every removal is decided
 * again under the branding's row lock and the image's hash lock. A failing
 * sweep is logged and the next one tries again; shutdown stops a running
 * one after the image it is on (`signal`) and waits for that.
 */
@Injectable()
export class BrandingImageSweeper
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(BrandingImageSweeper.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;
  private readonly shutdown = new AbortController();

  constructor(
    private readonly role: ServerRole,
    private readonly sweep: SweepBrandingImagesAction,
  ) {}

  onApplicationBootstrap(): void {
    // Background work: a `worker` or `all` process runs it (#527).
    if (!this.role.runsBackground) return;
    this.schedule(FIRST_SWEEP_MS);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.shutdown.abort();
    await this.running;
  }

  /** One sweep now (also for tests); never rejects. */
  async runOnce(now = new Date()): Promise<void> {
    try {
      const report = await this.sweep.handle({
        now,
        signal: this.shutdown.signal,
      });
      for (const { sha256, error } of report.failed) {
        this.logger.warn(
          `Removing the unused branding image ${sha256} failed: ${String(error)}`,
        );
      }
    } catch (error) {
      this.logger.error('Sweeping unused branding images failed', error);
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
