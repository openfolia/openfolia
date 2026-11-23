import { Injectable } from '@nestjs/common';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { Database } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import { releaseOutputs } from '../../releases/repos/releases.tables.js';
import { ArchivedFiles } from '../core/archived-files.js';

/** `ArchivedFiles` over `release_outputs`: the files of the `done` outputs. */
@Injectable()
export class DrizzleArchivedFiles extends ArchivedFiles {
  constructor(private readonly database: Database) {
    super();
  }

  async hashes(): Promise<ReadonlySet<string>> {
    const rows = await this.database.db
      .selectDistinct({ sha256: releaseOutputs.sha256 })
      .from(releaseOutputs)
      .where(
        and(eq(releaseOutputs.state, 'done'), isNotNull(releaseOutputs.sha256)),
      );
    return new Set(rows.flatMap((row) => (row.sha256 ? [row.sha256] : [])));
  }

  async has(tx: Transaction, sha256: string): Promise<boolean> {
    const [row] = await drizzleOf(tx)
      .select({ sha256: releaseOutputs.sha256 })
      .from(releaseOutputs)
      .where(
        and(
          eq(releaseOutputs.sha256, sha256),
          eq(releaseOutputs.state, 'done'),
        ),
      )
      .limit(1);
    return row !== undefined;
  }
}
