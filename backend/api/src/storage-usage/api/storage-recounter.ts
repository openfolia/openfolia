import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ServerRole } from '../../config/server-role.js';
import { RecordStorageLimitAction } from '../core/actions/record-storage-limit.action.js';
import { RecountStorageAction } from '../core/actions/recount-storage.action.js';

/** The first look, a while after start-up. */
export const FIRST_RECOUNT_MS = 60_000;
/** Then every so often; the action recounts only when one is due. */
export const RECOUNT_CHECK_MS = 15 * 60_000;

/**
 * At start-up, records the storage limit in force (`RecordStorageLimitAction`,
 * audited when it changed); then, on a timer (a minute after start-up,
 * then every 15 minutes, never two at once), recounts the storage when a
 * recount is due (`RecountStorageAction`). A failure is logged and the
 * next round tries again; shutdown stops a running recount and waits for
 * it to end.
 */
@Injectable()
export class StorageRecounter
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(StorageRecounter.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;
  private readonly shutdown = new AbortController();

  constructor(
    private readonly role: ServerRole,
    private readonly recount: RecountStorageAction,
    private readonly recordLimit: RecordStorageLimitAction,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // The limit is the one the API enforces: recorded where HTTP is served
    // (`all`, `api`); the recount is background work (`all`, `worker`; #527).
    if (this.role.servesHttp) {
      try {
        await this.recordLimit.handle();
      } catch (error) {
        // Tried again at the next start; the limit applies all the same.
        this.logger.error('Recording the storage limit failed', error);
      }
    }
    if (this.role.runsBackground) this.schedule(FIRST_RECOUNT_MS);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.shutdown.abort();
    await this.running;
  }

  /** One round now (also for tests); never rejects. */
  async runOnce(now = new Date()): Promise<void> {
    try {
      await this.recount.handle({ now, signal: this.shutdown.signal });
    } catch (error) {
      // Stopped for the shutdown: nothing failed.
      if (this.shutdown.signal.aborted) return;
      this.logger.error('Recounting the storage failed', error);
    }
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.runOnce().finally(() => {
        this.running = undefined;
        this.schedule(RECOUNT_CHECK_MS);
      });
    }, ms);
    this.timer.unref();
  }
}
