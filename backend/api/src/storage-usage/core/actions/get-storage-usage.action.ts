import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import type { Permission } from '../../../access/core/permissions.js';
import { ActorAction } from '../../../access/core/policy.js';
import { UnitOfWork } from '../../../base/core/unit-of-work.js';
import { StorageQuota, WARN_AT } from '../storage-quota.js';
import {
  type StorageTotals,
  StorageUsage,
  usedBytes,
} from '../storage-usage.js';

/** Who reads the storage used: administrators (`admin.roles`), as for the audit log. */
export const READ_STORAGE_USAGE = 'admin.roles' satisfies Permission;

/** How near the limit the storage used is. */
export type StorageLevel = 'unlimited' | 'ok' | 'warning' | 'reached';

export interface StorageReport {
  readonly totals: StorageTotals;
  readonly limit: number | null;
  readonly used: number;
  readonly level: StorageLevel;
}

/** The level of `used` against `limit`: a warning from `WARN_AT` of it on. */
export function levelOf(used: number, limit: number | null): StorageLevel {
  if (limit === null) return 'unlimited';
  if (used >= limit) return 'reached';
  return used >= limit * WARN_AT ? 'warning' : 'ok';
}

/**
 * The storage the instance uses (#404), per category, as the kept totals
 * say (no store is counted on request), with the limit when one is set.
 */
@Injectable()
export class GetStorageUsageAction extends ActorAction<
  { actor: Actor },
  StorageReport
> {
  readonly policy = READ_STORAGE_USAGE;

  constructor(
    private readonly usage: StorageUsage,
    private readonly quota: StorageQuota,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected async run(): Promise<StorageReport> {
    const totals = await this.unit.run((tx) => this.usage.read(tx));
    const used = usedBytes(totals);
    const limit = this.quota.limit;
    return { totals, limit, used, level: levelOf(used, limit) };
  }
}
