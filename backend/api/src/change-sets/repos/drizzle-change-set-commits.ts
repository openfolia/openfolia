import { Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { Database } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import { ChangeSetCommits } from '../core/change-set-commits.js';
import type { ChangeSetCommit } from '../core/commit.js';
import { subjectKey } from '../core/lock.js';
import { outbox } from './outbox.tables.js';

/** The outbox topic of a commit on a change-set branch. */
export const COMMIT_TOPIC = 'change-set.commit';

/** `ChangeSetCommits` over the `outbox` table. */
@Injectable()
export class DrizzleChangeSetCommits extends ChangeSetCommits {
  constructor(private readonly database: Database) {
    super();
  }

  async recorded(
    commits: readonly string[],
    tx?: Transaction,
  ): Promise<Set<string>> {
    if (commits.length === 0) return new Set();
    const db = tx ? drizzleOf(tx) : this.database.db;
    const rows = await db
      .select({ key: outbox.key })
      .from(outbox)
      .where(
        and(eq(outbox.topic, COMMIT_TOPIC), inArray(outbox.key, [...commits])),
      );
    return new Set(rows.map((r) => r.key));
  }

  async record(tx: Transaction, commit: ChangeSetCommit): Promise<boolean> {
    const inserted = await drizzleOf(tx)
      .insert(outbox)
      .values({
        topic: COMMIT_TOPIC,
        key: commit.commit,
        payload: {
          changeSetId: commit.changeSetId,
          branch: commit.branch,
          commit: commit.commit,
          parent: commit.parent,
          actor: { kind: commit.actor.kind, id: commit.actor.id },
          written: commit.written.map((s) => subjectKey(s)),
          deleted: commit.deleted.map((s) => subjectKey(s)),
        },
      })
      .onConflictDoNothing({ target: [outbox.topic, outbox.key] })
      .returning({ id: outbox.id });
    return inserted.length > 0;
  }
}
