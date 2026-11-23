import { Injectable, Logger } from '@nestjs/common';
import { Database } from '../../database/database.js';
import { DatabaseProbe } from '../core/database-probe.js';

/** How long the database may take to answer before it counts as unavailable. */
export const PING_TIMEOUT_MS = 2_000;

/** How long an answer is reused, so a flood of health checks costs one query a second. */
export const PING_REUSE_MS = 1_000;

/**
 * `DatabaseProbe` over the application's `Database`. Concurrent checks
 * share one ping, and its outcome is reused for `PING_REUSE_MS`: the check
 * is public, so it must not be a way to take the pool's connections or to
 * flood the log. Only a change is logged: unavailable (with the reason)
 * and available again.
 */
@Injectable()
export class DrizzleDatabaseProbe extends DatabaseProbe {
  private readonly logger = new Logger('Health');
  private last?: { result: Promise<void>; at: number };
  /** Whether the last ping failed: only a change is logged. */
  private down = false;

  constructor(private readonly database: Database) {
    super();
  }

  saturated(): boolean {
    return this.database.saturated();
  }

  ping(): Promise<void> {
    if (!this.last || Date.now() - this.last.at >= PING_REUSE_MS) {
      // Reused while running, then for PING_REUSE_MS after it settled.
      const entry = {
        result: this.database.ping(PING_TIMEOUT_MS),
        at: Number.POSITIVE_INFINITY,
      };
      entry.result.then(
        () => {
          entry.at = Date.now();
          if (this.down) this.logger.log('Database available again');
          this.down = false;
        },
        (error: unknown) => {
          entry.at = Date.now();
          if (!this.down) {
            this.logger.warn(
              `Database unavailable: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          this.down = true;
        },
      );
      this.last = entry;
    }
    return this.last.result;
  }
}
