import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import {
  type TagWithdrawal,
  WithdrawnReleases,
} from '../../content/core/withdrawn-releases.js';
import { Database } from '../../database/database.js';
import { releases, releaseWithdrawals } from './releases.tables.js';

/** `WithdrawnReleases` over the `releases` and `release_withdrawals` tables. */
@Injectable()
export class DrizzleWithdrawnReleases extends WithdrawnReleases {
  constructor(private readonly database: Database) {
    super();
  }

  async withdrawals(): Promise<ReadonlyMap<string, TagWithdrawal>> {
    const rows = await this.database.db
      .select({
        tag: releases.tag,
        byKind: releaseWithdrawals.withdrawnByKind,
        byId: releaseWithdrawals.withdrawnById,
        at: releaseWithdrawals.withdrawnAt,
        reason: releaseWithdrawals.reason,
      })
      .from(releaseWithdrawals)
      .innerJoin(releases, eq(releases.id, releaseWithdrawals.releaseId));
    return new Map(
      rows.map((row) => [
        row.tag,
        {
          // The table's check holds the kind to these two.
          by: { kind: row.byKind as 'user' | 'service', id: row.byId },
          at: row.at,
          reason: row.reason,
        },
      ]),
    );
  }
}
