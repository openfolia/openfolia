import { Injectable, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { Database } from '../../database/database.js';
import {
  RELEASE_DIFF_FORMAT,
  type StoredReleaseDiff,
} from '../core/release-changes.js';
import { ReleaseDiffStore } from '../core/release-diff-store.js';
import { releaseDiffs } from './release-diffs.tables.js';

/** `ReleaseDiffStore` over the `release_diffs` table. */
@Injectable()
export class DrizzleReleaseDiffStore extends ReleaseDiffStore {
  private readonly logger = new Logger('ReleaseDiffStore');

  constructor(private readonly database: Database) {
    super();
  }

  async find(
    base: string | undefined,
    head: string,
  ): Promise<StoredReleaseDiff | undefined> {
    const [row] = await this.database.db
      .select({ diff: releaseDiffs.diff })
      .from(releaseDiffs)
      .where(
        and(
          eq(releaseDiffs.headCommit, head),
          eq(releaseDiffs.baseCommit, base ?? ''),
          eq(releaseDiffs.format, RELEASE_DIFF_FORMAT),
        ),
      );
    return row?.diff;
  }

  async keep(
    base: string | undefined,
    head: string,
    diff: StoredReleaseDiff,
  ): Promise<void> {
    try {
      await this.database.db
        .insert(releaseDiffs)
        .values({
          headCommit: head,
          baseCommit: base ?? '',
          format: RELEASE_DIFF_FORMAT,
          diff,
        })
        // One of an older format is replaced, never a newer one (a server
        // not yet upgraded, in a rolling deploy); the same pair worked out
        // at once by two servers is the same diff, kept once.
        .onConflictDoUpdate({
          target: [releaseDiffs.headCommit, releaseDiffs.baseCommit],
          set: { format: RELEASE_DIFF_FORMAT, diff, createdAt: new Date() },
          setWhere: sql`${releaseDiffs.format} < ${RELEASE_DIFF_FORMAT}`,
        });
    } catch (error) {
      // The driver's own error, not the query's text (it holds the diff).
      const cause = error instanceof Error ? error.cause : undefined;
      this.logger.warn(
        `Could not keep the diff of ${head} against ${base ?? 'nothing'}: ${cause instanceof Error ? cause.message : 'the write failed'}`,
      );
    }
  }
}
