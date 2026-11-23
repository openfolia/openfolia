import { Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { PageRequest, Paginated } from '../../base/core/paging.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { Database } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import {
  type ChangeSet,
  type ChangeSetAuthor,
  type ChangeSetFilter,
  type ChangeSetState,
  isChangeSetId,
  noneInEachState,
  OPEN_STATES,
} from '../core/change-set.js';
import {
  type ChangeSetCursor,
  type ChangeSetEdit,
  ChangeSetStore,
} from '../core/change-set-store.js';
import { changeSets } from './change-sets.tables.js';

type Row = typeof changeSets.$inferSelect;

/** How many IDs one `existing` query asks about. */
const ID_BATCH = 500;

/** `ChangeSetStore` over the `change_sets` table. */
@Injectable()
export class DrizzleChangeSetStore extends ChangeSetStore {
  constructor(private readonly database: Database) {
    super();
  }

  async insert(tx: Transaction, changeSet: ChangeSet): Promise<void> {
    await drizzleOf(tx)
      .insert(changeSets)
      .values({
        id: changeSet.id,
        title: changeSet.title,
        description: changeSet.description,
        authorKind: changeSet.author.kind,
        authorId: changeSet.author.id,
        baseRef: changeSet.baseRef,
        baseCommit: changeSet.baseCommit,
        baseReleased: changeSet.baseReleased,
        branch: changeSet.branch,
        state: changeSet.state,
        reviewHead: changeSet.reviewHead ?? null,
        mergeCommit: changeSet.mergeCommit ?? null,
        createdAt: changeSet.createdAt,
        updatedAt: changeSet.updatedAt,
      });
  }

  async find(id: string): Promise<ChangeSet | undefined> {
    // Postgres would refuse a malformed UUID with an error, not "none".
    if (!isChangeSetId(id)) return undefined;
    const [row] = await this.database.db
      .select()
      .from(changeSets)
      .where(eq(changeSets.id, id));
    return row && toChangeSet(row);
  }

  async list(
    filter: ChangeSetFilter,
    page: PageRequest,
  ): Promise<Paginated<ChangeSet>> {
    const where = and(...conditions(filter));
    // One snapshot, so the page and the total agree.
    const [rows, [counted]] = await this.database.db.transaction(
      async (tx) => [
        await tx
          .select()
          .from(changeSets)
          .where(where)
          .orderBy(desc(changeSets.createdAt), desc(changeSets.id))
          .limit(page.size)
          .offset((page.number - 1) * page.size),
        await tx.select({ total: count() }).from(changeSets).where(where),
      ],
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    return { total: counted?.total ?? 0, items: rows.map(toChangeSet) };
  }

  async countByState(
    filter: ChangeSetFilter,
  ): Promise<Record<ChangeSetState, number>> {
    const rows = await this.database.db
      .select({ state: changeSets.state, total: count() })
      .from(changeSets)
      .where(and(...conditions({ ...filter, state: undefined })))
      .groupBy(changeSets.state);
    const counts = noneInEachState();
    for (const row of rows) {
      if (row.state in counts) counts[row.state as ChangeSetState] = row.total;
    }
    return counts;
  }

  async lock(tx: Transaction, id: string): Promise<ChangeSet | undefined> {
    if (!isChangeSetId(id)) return undefined;
    const [row] = await drizzleOf(tx)
      .select()
      .from(changeSets)
      .where(eq(changeSets.id, id))
      .for('update');
    return row && toChangeSet(row);
  }

  async setState(
    tx: Transaction,
    id: string,
    state: ChangeSetState,
  ): Promise<ChangeSet> {
    const [row] = await drizzleOf(tx)
      .update(changeSets)
      // The transaction's time: the change's, as the audit event's `at`.
      .set({ state, updatedAt: sql`now()` })
      .where(eq(changeSets.id, id))
      .returning();
    if (!row) throw new Error(`No change set ${id} to update.`);
    return toChangeSet(row);
  }

  async edit(
    tx: Transaction,
    id: string,
    change: ChangeSetEdit,
  ): Promise<ChangeSet> {
    const [row] = await drizzleOf(tx)
      .update(changeSets)
      .set({
        ...(change.title !== undefined && { title: change.title }),
        ...(change.description !== undefined && {
          description: change.description,
        }),
        updatedAt: sql`now()`,
      })
      .where(eq(changeSets.id, id))
      .returning();
    if (!row) throw new Error(`No change set ${id} to update.`);
    return toChangeSet(row);
  }

  async rebase(
    tx: Transaction,
    id: string,
    base: { readonly baseCommit: string; readonly baseReleased: boolean },
  ): Promise<ChangeSet> {
    const [row] = await drizzleOf(tx)
      .update(changeSets)
      .set({
        baseCommit: base.baseCommit,
        baseReleased: base.baseReleased,
        updatedAt: sql`now()`,
      })
      .where(eq(changeSets.id, id))
      .returning();
    if (!row) throw new Error(`No change set ${id} to update.`);
    return toChangeSet(row);
  }

  async transition(
    tx: Transaction,
    id: string,
    change: {
      readonly state: ChangeSetState;
      readonly reviewHead?: string | null;
      readonly mergeCommit?: string | null;
    },
  ): Promise<ChangeSet> {
    const [row] = await drizzleOf(tx)
      .update(changeSets)
      .set({
        state: change.state,
        ...(change.reviewHead !== undefined && {
          reviewHead: change.reviewHead,
        }),
        ...(change.mergeCommit !== undefined && {
          mergeCommit: change.mergeCommit,
        }),
        updatedAt: sql`now()`,
      })
      .where(eq(changeSets.id, id))
      .returning();
    if (!row) throw new Error(`No change set ${id} to update.`);
    return toChangeSet(row);
  }

  async listOpen(max: number, author?: ChangeSetAuthor): Promise<ChangeSet[]> {
    const rows = await this.database.db
      .select()
      .from(changeSets)
      .where(
        and(
          inArray(changeSets.state, [...OPEN_STATES]),
          ...(author
            ? [
                eq(changeSets.authorKind, author.kind),
                eq(changeSets.authorId, author.id),
              ]
            : []),
        ),
      )
      .orderBy(desc(changeSets.createdAt), desc(changeSets.id))
      .limit(max);
    return rows.map(toChangeSet);
  }

  async listInState(
    state: ChangeSetState,
    max: number,
    after?: ChangeSetCursor,
  ): Promise<ChangeSet[]> {
    const rows = await this.database.db
      .select()
      .from(changeSets)
      .where(
        and(
          eq(changeSets.state, state),
          ...(after
            ? [
                sql`(${changeSets.createdAt}, ${changeSets.id}) > (${after.createdAt.toISOString()}::timestamptz, ${after.id}::uuid)`,
              ]
            : []),
        ),
      )
      .orderBy(asc(changeSets.createdAt), asc(changeSets.id))
      .limit(max);
    return rows.map(toChangeSet);
  }

  async existing(ids: readonly string[]): Promise<Set<string>> {
    const found = new Set<string>();
    const valid = ids.filter(isChangeSetId);
    for (let i = 0; i < valid.length; i += ID_BATCH) {
      const rows = await this.database.db
        .select({ id: changeSets.id })
        .from(changeSets)
        .where(inArray(changeSets.id, valid.slice(i, i + ID_BATCH)));
      for (const row of rows) found.add(row.id);
    }
    return found;
  }
}

function conditions({ state, author, authorKind }: ChangeSetFilter): SQL[] {
  const all: SQL[] = [];
  if (state !== undefined) all.push(eq(changeSets.state, state));
  if (author !== undefined) all.push(eq(changeSets.authorId, author));
  if (authorKind !== undefined) {
    all.push(eq(changeSets.authorKind, authorKind));
  }
  return all;
}

function toChangeSet(row: Row): ChangeSet {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    author: {
      kind: row.authorKind as ChangeSet['author']['kind'],
      id: row.authorId,
    },
    baseRef: row.baseRef,
    baseCommit: row.baseCommit,
    baseReleased: row.baseReleased,
    branch: row.branch,
    state: row.state as ChangeSetState,
    ...(row.reviewHead !== null && { reviewHead: row.reviewHead }),
    ...(row.mergeCommit !== null && { mergeCommit: row.mergeCommit }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
