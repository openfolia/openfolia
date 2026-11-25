import { Injectable } from '@nestjs/common';
import type { UnguardedAction } from '../../../access/core/policy.js';
import type { AuditKind } from '../audit-event.js';
import { AuditLog } from '../audit-log.js';
import { AuditSettings, AuditSinkCursor } from '../audit-sink.js';

/** Removed per call (one transaction, one `audit-log.prune` event). */
export const PRUNE_BATCH = 5_000;
/** The most calls one run makes per kind; the rest waits for the next run. */
export const PRUNE_CALLS = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

/** What one run removed, per kind. */
export interface PruneReport {
  readonly write: number;
  readonly read: number;
  /**
   * The kinds whose removal failed, with the error's name only: each kind
   * runs even when the other failed. Absent when none did.
   */
  readonly failed?: readonly { kind: AuditKind; error: string }[];
}

/**
 * Retention (#379): removes the changes recorded more than
 * `CCMS_AUDIT_KEEP_DAYS` days ago (none when no period is set) and the
 * reads (#877) recorded more than `CCMS_AUDIT_READ_KEEP_DAYS` days ago,
 * `PRUNE_BATCH` at a time (each removal recorded as `audit-log.prune` by
 * the database function that does it) and at most `PRUNE_CALLS` batches
 * per kind and run. With a sink set, never an event it has not sent yet.
 * Runs for nobody; answers how many it removed of each kind.
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

  async handle(): Promise<PruneReport> {
    const keptAfter = this.settings.sinkEnabled
      ? await this.cursor.position()
      : undefined;
    const prune = async (kind: AuditKind, days: number | undefined) => {
      if (days === undefined) return 0;
      const before = new Date(this.now() - days * DAY_MS);
      let removed = 0;
      for (let call = 0; call < PRUNE_CALLS; call++) {
        const n = await this.auditLog.prune(
          before,
          PRUNE_BATCH,
          keptAfter,
          kind,
        );
        removed += n;
        if (n < PRUNE_BATCH) break;
      }
      return removed;
    };
    const failed: { kind: AuditKind; error: string }[] = [];
    const attempt = async (kind: AuditKind, days: number | undefined) => {
      try {
        return await prune(kind, days);
      } catch (error) {
        failed.push({
          kind,
          error: error instanceof Error ? error.name : 'unknown error',
        });
        return 0;
      }
    };
    const write = await attempt('write', this.settings.keepDays);
    const read = await attempt('read', this.settings.readKeepDays);
    return { write, read, ...(failed.length > 0 && { failed }) };
  }
}
