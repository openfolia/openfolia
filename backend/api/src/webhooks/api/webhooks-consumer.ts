import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ServerRole } from '../../config/server-role.js';
import type { Env } from '../../config/env.js';
import {
  FanOutWebhooksAction,
  type FanOutReport,
} from '../core/actions/fan-out-webhooks.action.js';
import { PruneWebhookDeliveriesAction } from '../core/actions/prune-webhook-deliveries.action.js';
import { WebhookSettings } from '../core/webhook-ports.js';

/** How long one run may take. */
export const RUN_BUDGET_MS = 20_000;
/** How often old deliveries are removed (and once at start-up). */
export const PRUNE_EVERY_MS = 60 * 60_000;
/** How long shutdown waits for a running pass. */
export const SHUTDOWN_WAIT_MS = 5_000;

/**
 * Runs `FanOutWebhooksAction` at start-up and then every
 * `CCMS_WEBHOOKS_POLL_MS` (default 3 s; 0: never on a timer, as in tests,
 * which call `runOnce`), never two at once, and retention
 * (`PruneWebhookDeliveriesAction`, `CCMS_WEBHOOKS_KEEP_DAYS`) at start-up
 * and every hour. Nothing runs while webhooks are not set up. Servers
 * side by side may each run it (see the action). A failing run is logged
 * (the outbox position and topic, never a URL or payload) and the next
 * one tries again.
 */
@Injectable()
export class WebhooksConsumer
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(WebhooksConsumer.name);
  private readonly pollMs: number;
  private timer?: NodeJS.Timeout;
  private queue: Promise<unknown> = Promise.resolve();
  private busy = 0;
  private stopped = false;
  private lastPrune = 0;
  /** Whether the last pass found the consumer held after a restore (logged once). */
  private held = false;

  constructor(
    private readonly role: ServerRole,
    private readonly fanOut: FanOutWebhooksAction,
    private readonly prune: PruneWebhookDeliveriesAction,
    private readonly settings: WebhookSettings,
    config: ConfigService<Env, true>,
  ) {
    this.pollMs = config.get('CCMS_WEBHOOKS_POLL_MS', { infer: true });
  }

  onApplicationBootstrap(): void {
    // Background work: a `worker` or `all` process runs it (#527).
    if (this.pollMs > 0 && this.settings.enabled && this.role.runsBackground)
      this.schedule(0);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.busy === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const gaveUp = await Promise.race([
      this.queue.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), SHUTDOWN_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (gaveUp) {
      this.logger.warn(
        'Shutting down while making webhook deliveries; the next start reads the unrecorded outbox rows again.',
      );
    }
  }

  /** One pass now (also for tests), after any pass running. Never rejects. */
  runOnce(): Promise<FanOutReport | undefined> {
    const pass = this.queue.then(async () => {
      const report = await this.fanOutOnce();
      await this.pruneIfDue();
      return report;
    });
    this.queue = pass;
    this.busy++;
    return pass.finally(() => this.busy--);
  }

  private async fanOutOnce(): Promise<FanOutReport | undefined> {
    try {
      const report = await this.fanOut.handle({
        deadline: Date.now() + RUN_BUDGET_MS,
      });
      for (const s of report.skipped) {
        const what =
          `outbox row ${s.position.id} (${s.topic})` +
          (s.webhookId === undefined ? '' : ` to webhook ${s.webhookId}`);
        if (s.reason === 'payload') {
          this.logger.error(
            `No webhook deliveries for ${what}: its payload is not what its topic writes.`,
          );
        } else {
          this.logger.error(
            `No webhook deliveries for ${what}; passed over (${errorName(s.error)}).`,
          );
        }
      }
      if (report.retry) {
        this.logger.warn(
          `Webhook deliveries for outbox row ${report.retry.position.id} (${report.retry.topic}) failed (${errorName(report.retry.error)}); tried again next run.`,
        );
      }
      this.logHeld(report.blocked);
      return report;
    } catch (error) {
      this.logger.error(
        `Making webhook deliveries failed (${errorName(error)}).`,
      );
      return undefined;
    }
  }

  /** Logs once when the outbox holds this consumer after a restore, and once when it goes on. */
  private logHeld(blocked: boolean): void {
    if (blocked && !this.held) {
      this.logger.error(
        'Making webhook deliveries stopped: the outbox positions lie ahead of this database (restored from another server?). Nothing is skipped meanwhile; run the SQL in backend/api/README.md, "Outbox", "After a restore".',
      );
    } else if (!blocked && this.held) {
      this.logger.log(
        'Making webhook deliveries goes on: the outbox is no longer held.',
      );
    }
    this.held = blocked;
  }

  private async pruneIfDue(): Promise<void> {
    if (!this.settings.enabled) return;
    if (Date.now() - this.lastPrune < PRUNE_EVERY_MS) return;
    this.lastPrune = Date.now();
    try {
      const removed = await this.prune.handle({
        keepDays: this.settings.keepDays,
      });
      if (removed > 0) {
        this.logger.log(
          `Removed ${removed} webhook deliveries older than ${this.settings.keepDays} days.`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Removing old webhook deliveries failed (${errorName(error)}).`,
      );
    }
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.runOnce().finally(() => this.schedule(this.pollMs));
    }, delay);
    this.timer.unref();
  }
}

/**
 * An error's name and code only: a message could carry what a request
 * held (a URL from a failed lookup), which never goes to the log here.
 */
function errorName(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? `${error.name} ${code}` : error.name;
}
