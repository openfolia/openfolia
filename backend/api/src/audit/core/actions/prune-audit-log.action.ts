import { Injectable } from '@nestjs/common';
import type { UnguardedAction } from '../../../access/core/policy.js';
import { AuditLog } from '../audit-log.js';
import { AuditSettings, AuditSinkCursor } from '../audit-sink.js';

/** Removed per call (one transaction, one `audit-log.prune` event). */
export const PRUNE_BATCH = 5_000;
/** The most calls one run makes; the rest waits for the next run. */
export const PRUNE_CALLS = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Retention (#379): removes the events recorded more than
 * `CCMS_AUDIT_KEEP_DAYS` days ago, `PRUNE_BATCH` at a time (each removal
 * recorded as `audit-log.prune` by the database function that does it)
 * and at most `PRUNE_CALLS` batches per run. With a sink set, never an
 * event it has not sent yet. Nothing when no period is set. Runs for
 * nobody; answers how many it removed.
 */
@Injectable()
export class PruneAuditLogAction implements UnguardedAction {
  readonly policy = 'internal';
  now: () => number = Date.now;

  constructor(
    private readonly auditLog: AuditLog,
    private readonly cursor: AuditSinkCursor,
    private readonly settings: AuditSettings,
  ) {}

  async handle(): Promise<number> {
    const days = this.settings.keepDays;
    if (days === undefined) return 0;
    const before = new Date(this.now() - days * DAY_MS);
    const keptAfter = this.settings.sinkEnabled
      ? await this.cursor.position()
      : undefined;
    let removed = 0;
    for (let call = 0; call < PRUNE_CALLS; call++) {
      const n = await this.auditLog.prune(before, PRUNE_BATCH, keptAfter);
      removed += n;
      if (n < PRUNE_BATCH) break;
    }
    return removed;
  }
}
