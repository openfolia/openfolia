import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { Database } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import type { ChangeSetAuthor } from '../core/change-set.js';
import { isChangeSetId } from '../core/change-set.js';
import {
  type CommitIntent,
  CommitIntents,
  MAX_INTENTS_READ,
  type NewCommitIntent,
} from '../core/commit-intents.js';
import { type LockSubject, subjectKey, subjectOfKey } from '../core/lock.js';
import { commitIntents } from './commit-intents.tables.js';

/** A subject as stored: the audit log's `{ type, id }`. */
const StoredSubject = z.object({ type: z.string(), id: z.string() });

/** The `payload` column, read back strictly. */
const Payload = z.object({
  written: z.array(StoredSubject),
  deleted: z.array(StoredSubject),
  consumes: z.array(
    z.object({
      subject: StoredSubject,
      version: z.number().int().min(1),
      createdAt: z.iso.datetime(),
    }),
  ),
  message: z.string().optional(),
});

/** `CommitIntents` over the `commit_intents` table. */
@Injectable()
export class DrizzleCommitIntents extends CommitIntents {
  constructor(private readonly database: Database) {
    super();
  }

  async add(tx: Transaction, intent: NewCommitIntent): Promise<CommitIntent> {
    const [row] = await drizzleOf(tx)
      .insert(commitIntents)
      .values({
        changeSetId: intent.changeSetId,
        actorKind: intent.actor.kind,
        actorId: intent.actor.id,
        parent: intent.parent,
        tree: intent.tree,
        payload: {
          written: intent.written.map((s) => subjectKey(s)),
          deleted: intent.deleted.map((s) => subjectKey(s)),
          consumes: intent.consumes.map((c) => ({
            subject: subjectKey(c.subject),
            version: c.version,
            createdAt: c.createdAt.toISOString(),
          })),
          ...(intent.message !== undefined && { message: intent.message }),
        },
      })
      .returning();
    if (!row) throw new Error('The commit intent was not inserted.');
    return toIntent(row);
  }

  async of(tx: Transaction, changeSetId: string): Promise<CommitIntent[]> {
    if (!isChangeSetId(changeSetId)) return [];
    const rows = await drizzleOf(tx)
      .select()
      .from(commitIntents)
      .where(eq(commitIntents.changeSetId, changeSetId))
      .orderBy(asc(commitIntents.id))
      .limit(MAX_INTENTS_READ);
    return rows.map(toIntent);
  }

  async remove(tx: Transaction, id: number): Promise<boolean> {
    const removed = await drizzleOf(tx)
      .delete(commitIntents)
      .where(eq(commitIntents.id, id))
      .returning({ id: commitIntents.id });
    return removed.length > 0;
  }

  async pendingFor(changeSetIds: readonly string[]): Promise<Set<string>> {
    const ids = changeSetIds.filter(isChangeSetId);
    if (ids.length === 0) return new Set();
    const rows = await this.database.db
      .selectDistinct({ changeSetId: commitIntents.changeSetId })
      .from(commitIntents)
      .where(inArray(commitIntents.changeSetId, ids));
    return new Set(rows.map((r) => r.changeSetId));
  }

  async expiredChangeSets(
    olderThanMs: number,
    limit: number,
  ): Promise<string[]> {
    // Oldest first, so change sets whose intents keep failing to expire
    // cannot take every slot of a run.
    const rows = await this.database.db
      .select({ changeSetId: commitIntents.changeSetId })
      .from(commitIntents)
      .where(lt(commitIntents.createdAt, before(olderThanMs)))
      .groupBy(commitIntents.changeSetId)
      .orderBy(sql`min(${commitIntents.createdAt})`)
      .limit(limit);
    return rows.map((r) => r.changeSetId);
  }

  async removeExpired(
    tx: Transaction,
    changeSetId: string,
    olderThanMs: number,
  ): Promise<number> {
    if (!isChangeSetId(changeSetId)) return 0;
    const removed = await drizzleOf(tx)
      .delete(commitIntents)
      .where(
        and(
          eq(commitIntents.changeSetId, changeSetId),
          lt(commitIntents.createdAt, before(olderThanMs)),
        ),
      )
      .returning({ id: commitIntents.id });
    return removed.length;
  }
}

/** `now() - olderThanMs`, by the database's clock. */
const before = (olderThanMs: number) =>
  sql`now() - make_interval(secs => ${Math.max(0, olderThanMs) / 1000})`;

function toIntent(row: typeof commitIntents.$inferSelect): CommitIntent {
  const payload = Payload.parse(row.payload);
  return {
    id: row.id,
    changeSetId: row.changeSetId,
    actor: { kind: row.actorKind, id: row.actorId } as ChangeSetAuthor,
    parent: row.parent,
    tree: row.tree,
    written: payload.written.map(subjectOf),
    deleted: payload.deleted.map(subjectOf),
    consumes: payload.consumes.map((c) => ({
      subject: subjectOf(c.subject),
      version: c.version,
      createdAt: new Date(c.createdAt),
    })),
    ...(payload.message !== undefined && { message: payload.message }),
    createdAt: row.createdAt,
  };
}

function subjectOf(stored: { type: string; id: string }): LockSubject {
  const subject = subjectOfKey(stored);
  if (!subject) {
    throw new Error(`A commit intent names no subject: ${stored.type}.`);
  }
  return subject;
}
