import { Injectable, Logger } from '@nestjs/common';
import { BlobStore } from '../../blobs/core/blob-store.js';
import { BlobStoreProbe } from '../core/blob-store-probe.js';
import { PING_REUSE_MS, PING_TIMEOUT_MS } from './drizzle-database-probe.js';

/**
 * `BlobStoreProbe` over the application's `BlobStore`, on the same terms
 * as the database's: one ping at a time, its outcome reused for
 * `PING_REUSE_MS` (the check is public, so it must not be a way to flood
 * the store), at most `PING_TIMEOUT_MS`, and only a change is logged.
 */
@Injectable()
export class BlobStoreHealthProbe extends BlobStoreProbe {
  private readonly logger = new Logger('Health');
  private last?: { result: Promise<void>; at: number };
  private down = false;

  constructor(private readonly blobs: BlobStore) {
    super();
  }

  ping(): Promise<void> {
    if (!this.last || Date.now() - this.last.at >= PING_REUSE_MS) {
      const entry = {
        result: withTimeout(this.blobs.ping(), PING_TIMEOUT_MS),
        at: Number.POSITIVE_INFINITY,
      };
      entry.result.then(
        () => {
          entry.at = Date.now();
          if (this.down) this.logger.log('Blob store available again');
          this.down = false;
        },
        (error: unknown) => {
          entry.at = Date.now();
          if (!this.down) {
            this.logger.warn(
              `Blob store unavailable: ${error instanceof Error ? error.message : String(error)}`,
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

function withTimeout(work: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`no answer within ${ms} ms`)),
      ms,
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
