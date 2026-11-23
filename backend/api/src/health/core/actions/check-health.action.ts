import { Injectable } from '@nestjs/common';
import type { UnguardedAction } from '../../../access/core/policy.js';
import { BlobStoreProbe } from '../blob-store-probe.js';
import { DatabaseProbe } from '../database-probe.js';

export interface HealthReport {
  /** `ok` when every dependency is, `degraded` when one is not. */
  status: 'ok' | 'degraded';
  database: 'ok' | 'unavailable';
  /** `saturated` when queries wait for a free database connection. */
  pool: 'ok' | 'saturated';
  /** `unavailable` when the blob store (images, files) does not answer. */
  blobs: 'ok' | 'unavailable';
}

/**
 * Whether the server and its dependencies work: whether the
 * database answers and its pool has a free connection, and whether the blob store answers. The server itself is up either way (content and PDF
 * routes do not need the database), so this never says it is down. The
 * probe logs why a dependency failed; the report (public) never says.
 */
@Injectable()
export class CheckHealthAction implements UnguardedAction {
  /** For load balancers: no token, no actor. */
  readonly policy = 'public';

  constructor(
    private readonly database: DatabaseProbe,
    private readonly blobStore: BlobStoreProbe,
  ) {}

  async handle(): Promise<HealthReport> {
    const pool = this.database.saturated() ? 'saturated' : 'ok';
    const answers = (ping: Promise<void>) =>
      ping.then(
        () => 'ok' as const,
        () => 'unavailable' as const,
      );
    const [database, blobs] = await Promise.all([
      answers(this.database.ping()),
      answers(this.blobStore.ping()),
    ]);
    const ok = database === 'ok' && pool === 'ok' && blobs === 'ok';
    return { status: ok ? 'ok' : 'degraded', database, pool, blobs };
  }
}
