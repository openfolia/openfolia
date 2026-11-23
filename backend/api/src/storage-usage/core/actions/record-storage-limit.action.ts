import { Injectable } from '@nestjs/common';
import type { UnguardedAction } from '../../../access/core/policy.js';
import { AuditLog } from '../../../audit/core/audit-log.js';
import { BOUNDED, UnitOfWork } from '../../../base/core/unit-of-work.js';
import {
  STORAGE_SERVICE,
  STORAGE_SUBJECT,
  StorageSettings,
} from '../storage-quota.js';
import { StorageUsage } from '../storage-usage.js';

/**
 * Records the storage limit in force (#404) at start-up: when the setting
 * differs from the limit last recorded, it is recorded with a
 * `storage.limit-change` audit event (`from`, `to`, in bytes; null for
 * none), by the server itself. Under the totals' row lock, so servers
 * starting together record a change once. An installation that never
 * sets a limit records nothing.
 */
@Injectable()
export class RecordStorageLimitAction implements UnguardedAction {
  readonly policy = 'internal';

  constructor(
    private readonly usage: StorageUsage,
    private readonly settings: StorageSettings,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {}

  /** Whether the limit changed. */
  async handle(): Promise<boolean> {
    const limit = this.settings.limitBytes;
    return this.unit.run(async (tx) => {
      const recorded = await this.usage.lockLimit(tx);
      if (recorded === limit) return false;
      await this.usage.recordLimit(tx, limit);
      await this.auditLog.record(tx, STORAGE_SERVICE, {
        action: 'storage.limit-change',
        subject: STORAGE_SUBJECT,
        data: { from: recorded, to: limit },
      });
      return true;
    }, BOUNDED);
  }
}
