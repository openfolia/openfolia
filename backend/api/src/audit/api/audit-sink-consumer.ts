import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { ServerRole } from '../../config/server-role.js';
import { waitAfter } from '../../webhooks/core/actions/deliver-webhook.action.js';
import {
  PRUNE_BATCH,
  PRUNE_CALLS,
  PruneAuditLogAction,
} from '../core/actions/prune-audit-log.action.js';
import {
  type SinkReport,
  SendToAuditSinkAction,
} from '../core/actions/send-to-audit-sink.action.js';
import { AuditSettings, AuditSinkCursor } from '../core/audit-sink.js';

/** How long one delivery pass may take. */
export const SINK_RUN_BUDGET_MS = 20_000;
/** How often retention runs (and once at start-up). */
export const RETENTION_EVERY_MS = 24 * 60 * 60_000;
/** When a run removed all it may, the next comes this soon (a backlog). */
export const RETENTION_BACKLOG_MS = 10 * 60_000;
/** How long shutdown waits for a running pass. */
export const SINK_SHUTDOWN_WAIT_MS = 5_000;

/**
 * Runs the audit log's background work (#379) in a `worker` or `all`
 * process: delivery to the sink (`SendToAuditSinkAction`) at start-up and
 * every `CCMS_AUDIT_SINK_POLL_MS` (0: never on a timer, as in tests, which
 * call `runOnce`), never two at once; after a failed delivery the next
 * waits 30 s, doubling to at most 10 min, for as long as it takes (the
 * cursor stays, so nothing is skipped and the order holds). Retention
 * (`PruneAuditLogAction`, `CCMS_AUDIT_KEEP_DAYS`) at start-up and daily,
 * again after 10 min while a backlog lasts.
 * Logs say how many and why, never the URL, a header or an event.
 */
@Injectable()
export class AuditSinkConsumer
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger('AuditSink');
  private readonly pollMs: number;
  private readonly leaseMs: number;
  /** This process, as the lease names it. */
  private readonly holder = `${hostname().slice(0, 150)}:${process.pid}:${randomBytes(6).toString('hex')}`;
  private sinkTimer?: NodeJS.Timeout;
  private retentionTimer?: NodeJS.Timeout;
  private queue: Promise<unknown> = Promise.resolve();
  private busy = 0;
  private stopped = false;
  private failures = 0;

  constructor(
    private readonly role: ServerRole,
    private readonly send: SendToAuditSinkAction,
    private readonly prune: PruneAuditLogAction,
    private readonly settings: AuditSettings,
    private readonly cursor: AuditSinkCursor,
    config: ConfigService<Env, true>,
  ) {
    this.pollMs = config.get('CCMS_AUDIT_SINK_POLL_MS', { infer: true });
    // Longer than any one delivery, so a live sender keeps it.
    this.leaseMs = Math.max(
      60_000,
      3 * config.get('CCMS_AUDIT_SINK_TIMEOUT_MS', { infer: true }),
    );
  }

  onApplicationBootstrap(): void {
    if (!this.role.runsBackground) return;
    if (this.settings.sinkEnabled && this.pollMs > 0) this.scheduleSink(0);
    if (this.settings.keepDays !== undefined) this.scheduleRetention(0);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.sinkTimer);
    clearTimeout(this.retentionTimer);
    if (this.busy === 0) {
      await this.releaseLease();
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const gaveUp = await Promise.race([
      this.queue.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), SINK_SHUTDOWN_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (!gaveUp) await this.releaseLease();
    if (gaveUp) {
      this.logger.warn(
        'Shutting down while delivering the audit log; the next start sends the undelivered events again.',
      );
    }
  }

  /** Gives the lease up once no pass runs, so a restarted server sends at once. */
  private async releaseLease(): Promise<void> {
    if (!this.settings.sinkEnabled || !this.role.runsBackground) return;
    try {
      await this.cursor.release(this.holder);
    } catch {
      // The lease then runs out by itself.
    }
  }

  /** One delivery pass now (also for tests), after any pass running. Never rejects. */
  runOnce(): Promise<SinkReport | undefined> {
    return this.enqueue(() => this.sendOnce());
  }

  /** One retention run now (also for tests), after any pass running. Never rejects. */
  pruneOnce(): Promise<number | undefined> {
    return this.enqueue(() => this.pruneNow());
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const pass = this.queue.then(work);
    this.queue = pass.catch(() => undefined);
    this.busy++;
    return pass.finally(() => this.busy--);
  }

  private async sendOnce(): Promise<SinkReport | undefined> {
    if (!this.settings.sinkEnabled) return undefined;
    try {
      const report = await this.send.handle({
        holder: this.holder,
        leaseMs: this.leaseMs,
        deadline: Date.now() + SINK_RUN_BUDGET_MS,
      });
      if (report.stopped?.reason === 'cursor-ahead') {
        this.failures++;
        this.logger.error(
          'The audit sink sends nothing: its position lies ahead of this database (restored from another server?). Set it as backend/api/README.md, "Audit log", "After a restore" says.',
        );
      } else if (report.stopped?.reason === 'failed') {
        this.failures++;
        const { error, statusCode } = report.stopped.result;
        this.logger.warn(
          `Delivering the audit log to the sink failed (${error}${statusCode === undefined ? '' : ` ${statusCode}`}); trying again in ${Math.round(waitAfter(this.failures) / 1000)} s.`,
        );
      } else if (report.stopped?.reason !== 'leased') {
        if (this.failures > 0) {
          this.logger.log('Delivering the audit log to the sink works again.');
        }
        this.failures = 0;
      }
      return report;
    } catch (error) {
      this.failures++;
      this.logger.error(
        `Delivering the audit log to the sink failed (${errorName(error)}); trying again in ${Math.round(waitAfter(this.failures) / 1000)} s.`,
      );
      return undefined;
    }
  }

  private async pruneNow(): Promise<number | undefined> {
    try {
      const removed = await this.prune.handle();
      if (removed > 0) {
        this.logger.log(
          `Removed ${removed} audit events older than ${this.settings.keepDays} days.`,
        );
      }
      return removed;
    } catch (error) {
      this.logger.error(
        `Removing old audit events failed (${errorName(error)}).`,
      );
      return undefined;
    }
  }

  private scheduleSink(delay: number): void {
    if (this.stopped) return;
    this.sinkTimer = setTimeout(() => {
      void this.runOnce().finally(() =>
        this.scheduleSink(
          this.failures > 0 ? waitAfter(this.failures) : this.pollMs,
        ),
      );
    }, delay);
    this.sinkTimer.unref();
  }

  private scheduleRetention(delay: number): void {
    if (this.stopped) return;
    this.retentionTimer = setTimeout(() => {
      void this.pruneOnce().then((removed) =>
        this.scheduleRetention(
          removed !== undefined && removed >= PRUNE_BATCH * PRUNE_CALLS
            ? RETENTION_BACKLOG_MS
            : RETENTION_EVERY_MS,
        ),
      );
    }, delay);
    this.retentionTimer.unref();
  }
}

/** An error's name and code only: a message could carry a URL or a value. */
function errorName(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? `${error.name} ${code}` : error.name;
}
