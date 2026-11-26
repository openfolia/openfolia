import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { errorLine } from '../../base/core/error-line.js';
import { ServerRole } from '../../config/server-role.js';
import type { Env } from '../../config/env.js';
import {
  DeliverNotificationsAction,
  type DeliveryReport,
} from '../core/actions/deliver-notifications.action.js';
import { PruneNotificationsAction } from '../core/actions/prune-notifications.action.js';
import {
  type EmailReport,
  SendNotificationEmailsAction,
} from '../core/actions/send-notification-emails.action.js';

/** How long one run may take; far below any sensible poll interval's worth of work. */
export const RUN_BUDGET_MS = 20_000;
/** How often retention runs (and once at start-up). */
export const PRUNE_EVERY_MS = 60 * 60_000;
/** How long shutdown waits for a running pass before going on without it. */
export const SHUTDOWN_WAIT_MS = 5_000;

/**
 * Runs `DeliverNotificationsAction` at start-up and then every
 * `CCMS_NOTIFICATIONS_POLL_MS` (default 3 s; 0: never on a timer, as in
 * tests, which call `runOnce`), never two at once, then the emails that are
 * due (`SendNotificationEmailsAction`, #884), and retention
 * (`PruneNotificationsAction`, `CCMS_NOTIFICATIONS_KEEP_DAYS`) at start-up
 * and every hour. Servers running side by side may each run it: the
 * outbox cursor moves by compare-and-swap, and notifications are unique
 * per outbox row and recipient. A failing run is logged and the next one
 * tries again. Shutdown waits for a running pass (before the database
 * closes) for at most `SHUTDOWN_WAIT_MS`; what it had not recorded is read
 * again at the next start.
 */
@Injectable()
export class NotificationsConsumer
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(NotificationsConsumer.name);
  private readonly pollMs: number;
  private readonly keepDays: number;
  private timer?: NodeJS.Timeout;
  /** The last pass asked for; the next one starts after it. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Passes asked for and not done yet. */
  private busy = 0;
  private stopped = false;
  private lastPrune = 0;
  /** Whether the last pass found the consumer held after a restore (logged once). */
  private held = false;

  constructor(
    private readonly role: ServerRole,
    private readonly deliver: DeliverNotificationsAction,
    private readonly prune: PruneNotificationsAction,
    private readonly emails: SendNotificationEmailsAction,
    config: ConfigService<Env, true>,
  ) {
    this.pollMs = config.get('CCMS_NOTIFICATIONS_POLL_MS', { infer: true });
    this.keepDays = config.get('CCMS_NOTIFICATIONS_KEEP_DAYS', {
      infer: true,
    });
  }

  onApplicationBootstrap(): void {
    // Background work: a `worker` or `all` process runs it (#527).
    if (this.pollMs > 0 && this.role.runsBackground) this.schedule(0);
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
        'Shutting down while delivering notifications; the next start reads the unrecorded outbox rows again.',
      );
    }
  }

  /**
   * One pass now (also for tests), after any pass running: delivery, then
   * retention when it is due. Resolves when it is done, never rejects.
   */
  runOnce(): Promise<DeliveryReport | undefined> {
    const pass = this.queue.then(async () => {
      const report = await this.deliverOnce();
      await this.emailOnce();
      await this.pruneIfDue();
      return report;
    });
    // Passes run one after the other; each never rejects.
    this.queue = pass;
    this.busy++;
    return pass.finally(() => this.busy--);
  }

  private async deliverOnce(): Promise<DeliveryReport | undefined> {
    try {
      const report = await this.deliver.handle({
        deadline: Date.now() + RUN_BUDGET_MS,
      });
      for (const s of report.skipped) {
        const what = `outbox row ${s.position.id} (${s.topic})`;
        if (s.reason === 'payload') {
          this.logger.error(
            `Notified nobody of ${what}: its payload is not what its topic writes.`,
          );
        } else {
          this.logger.error(
            `Notified nobody of ${what}; passed over: ${errorLine(s.error)}`,
          );
        }
      }
      if (report.retry) {
        this.logger.warn(
          `Notifying of outbox row ${report.retry.position.id} (${report.retry.topic}) failed; tried again next run: ${errorLine(report.retry.error)}`,
        );
      }
      this.logHeld(report.blocked);
      return report;
    } catch (error) {
      this.logger.error(`Delivering notifications failed: ${errorLine(error)}`);
      return undefined;
    }
  }

  /** The notification emails that are due (#884); a failure is logged, the next pass tries again. */
  private async emailOnce(): Promise<EmailReport | undefined> {
    try {
      const report = await this.emails.handle({
        deadline: Date.now() + RUN_BUDGET_MS,
      });
      if (report.sent > 0) {
        this.logger.log(`Queued ${report.sent} notification email(s).`);
      }
      return report;
    } catch (error) {
      this.logger.error(
        `Sending notification emails failed: ${errorLine(error)}`,
      );
      return undefined;
    }
  }

  /** Logs once when the outbox holds this consumer after a restore, and once when it goes on. */
  private logHeld(blocked: boolean): void {
    if (blocked && !this.held) {
      this.logger.error(
        'Delivering notifications stopped: the outbox positions lie ahead of this database (restored from another server?). Nothing is skipped meanwhile; run the SQL in backend/api/README.md, "Outbox", "After a restore".',
      );
    } else if (!blocked && this.held) {
      this.logger.log(
        'Delivering notifications goes on: the outbox is no longer held.',
      );
    }
    this.held = blocked;
  }

  private async pruneIfDue(): Promise<void> {
    if (Date.now() - this.lastPrune < PRUNE_EVERY_MS) return;
    this.lastPrune = Date.now();
    try {
      const removed = await this.prune.handle({ keepDays: this.keepDays });
      await this.emails.prune();
      if (removed > 0) {
        this.logger.log(
          `Removed ${removed} read notification(s) older than ${this.keepDays} days.`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Removing old notifications failed: ${errorLine(error)}`,
      );
    }
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.runOnce().finally(() => this.schedule(this.pollMs));
    }, delay);
    // Never keeps the process alive on its own.
    this.timer.unref();
  }
}
