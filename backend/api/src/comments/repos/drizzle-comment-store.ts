import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { PageRequest, Paginated } from '../../base/core/paging.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import type { ChangeSetAuthor } from '../../change-sets/core/change-set.js';
import { isChangeSetId } from '../../change-sets/core/change-set.js';
import { Database } from '../../database/database.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import {
  type Comment,
  type CommentFilter,
  CommentSubject,
  isCommentId,
  moduleKey,
  type NewComment,
} from '../core/comment.js';
import { CommentStore } from '../core/comment-store.js';
import { comments } from './comments.tables.js';

type Row = typeof comments.$inferSelect;

/** A comment's thread, for filtering by the thread's resolution. */
const thread = alias(comments, 'thread');

/** `CommentStore` over the `comments` table. */
@Injectable()
export class DrizzleCommentStore extends CommentStore {
  constructor(private readonly database: Database) {
    super();
  }

  async insert(tx: Transaction, comment: NewComment): Promise<Comment> {
    const [row] = await drizzleOf(tx)
      .insert(comments)
      .values({
        id: comment.id,
        changeSetId: comment.changeSetId,
        threadId: comment.threadId,
        subjectType: comment.subject.type,
        subjectId: moduleKey(comment.subject),
        blockId: comment.blockId,
        commit: comment.commit,
        authorKind: comment.author.kind,
        authorId: comment.author.id,
        body: comment.body,
        // The transaction's time, as the audit event's `at`.
        createdAt: sql`now()`,
      })
      .returning();
    if (!row) throw new Error(`The comment ${comment.id} was not stored.`);
    return toComment(row);
  }

  async find(id: string): Promise<Comment | undefined> {
    // Postgres would refuse a malformed UUID with an error, not "none".
    if (!isCommentId(id)) return undefined;
    const [row] = await this.database.db
      .select()
      .from(comments)
      .where(eq(comments.id, id));
    return row && toComment(row);
  }

  async lock(tx: Transaction, id: string): Promise<Comment | undefined> {
    if (!isCommentId(id)) return undefined;
    const [row] = await drizzleOf(tx)
      .select()
      .from(comments)
      .where(eq(comments.id, id))
      .for('update');
    return row && toComment(row);
  }

  async setResolution(
    tx: Transaction,
    id: string,
    by: ChangeSetAuthor | null,
  ): Promise<Comment> {
    const [row] = await drizzleOf(tx)
      .update(comments)
      .set(
        by
          ? {
              resolvedAt: sql`now()`,
              resolvedByKind: by.kind,
              resolvedById: by.id,
            }
          : { resolvedAt: null, resolvedByKind: null, resolvedById: null },
      )
      .where(eq(comments.id, id))
      .returning();
    if (!row) throw new Error(`No comment ${id} to update.`);
    return toComment(row);
  }

  async edit(tx: Transaction, id: string, body: string): Promise<Comment> {
    const [row] = await drizzleOf(tx)
      .update(comments)
      .set({ body, editedAt: sql`now()` })
      .where(and(eq(comments.id, id), isNull(comments.deletedAt)))
      .returning();
    if (!row) throw new Error(`No comment ${id} to edit.`);
    return toComment(row);
  }

  async markDeleted(tx: Transaction, id: string): Promise<Comment> {
    const [row] = await drizzleOf(tx)
      .update(comments)
      .set({ body: null, deletedAt: sql`now()` })
      .where(and(eq(comments.id, id), isNull(comments.deletedAt)))
      .returning();
    if (!row) throw new Error(`No comment ${id} to mark deleted.`);
    return toComment(row);
  }

  async remove(tx: Transaction, id: string): Promise<void> {
    // A thread's first comment with replies is held by the replies'
    // foreign key (`restrict`): the database refuses to remove it.
    const removed = await drizzleOf(tx)
      .delete(comments)
      .where(eq(comments.id, id))
      .returning({ id: comments.id });
    if (removed.length === 0) throw new Error(`No comment ${id} to remove.`);
  }

  async replies(tx: Transaction, threadId: string): Promise<number> {
    const [counted] = await drizzleOf(tx)
      .select({ total: count() })
      .from(comments)
      .where(
        and(
          eq(comments.threadId, threadId),
          ne(comments.id, comments.threadId),
        ),
      );
    return counted?.total ?? 0;
  }

  async moveModule(
    tx: Transaction,
    changeSetId: string,
    from: CommentSubject,
    to: CommentSubject,
  ): Promise<number> {
    // One statement: a reply's foreign key to its thread's anchor is
    // checked at its end, when both have moved.
    const moved = await drizzleOf(tx)
      .update(comments)
      .set({ subjectId: moduleKey(to) })
      .where(
        and(
          eq(comments.changeSetId, changeSetId),
          eq(comments.subjectType, from.type),
          eq(comments.subjectId, moduleKey(from)),
        ),
      )
      .returning({ id: comments.id });
    return moved.length;
  }

  async count(tx: Transaction, changeSetId: string): Promise<number> {
    const [counted] = await drizzleOf(tx)
      .select({ total: count() })
      .from(comments)
      .where(eq(comments.changeSetId, changeSetId));
    return counted?.total ?? 0;
  }

  async modules(changeSetId: string): Promise<CommentSubject[]> {
    if (!isChangeSetId(changeSetId)) return [];
    const rows = await this.database.db
      .selectDistinct({ subjectId: comments.subjectId })
      .from(comments)
      .where(eq(comments.changeSetId, changeSetId))
      .orderBy(asc(comments.subjectId));
    return rows.map((row) => subjectOf(row.subjectId));
  }

  async list(
    changeSetId: string,
    filter: CommentFilter,
    page: PageRequest,
  ): Promise<Paginated<Comment>> {
    if (
      !isChangeSetId(changeSetId) ||
      (filter.modules !== undefined && filter.modules.length === 0)
    ) {
      return { total: 0, items: [] };
    }
    const where = and(...conditions(changeSetId, filter));
    // One snapshot, so the page and the total agree.
    const [rows, [counted]] = await this.database.db.transaction(
      async (tx) => [
        await tx
          .select({ comment: comments })
          .from(comments)
          .innerJoin(thread, eq(thread.id, comments.threadId))
          .where(where)
          .orderBy(
            // Threads by when they were started (the ID's time is the
            // app's clock, and random within a millisecond).
            asc(thread.createdAt),
            asc(comments.threadId),
            // The thread's first comment, then its replies.
            asc(sql`${comments.id} <> ${comments.threadId}`),
            asc(comments.createdAt),
            asc(comments.id),
          )
          .limit(page.size)
          .offset((page.number - 1) * page.size),
        await tx
          .select({ total: count() })
          .from(comments)
          .innerJoin(thread, eq(thread.id, comments.threadId))
          .where(where),
      ],
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    return {
      total: counted?.total ?? 0,
      items: rows.map((row) => toComment(row.comment)),
    };
  }
}

function conditions(changeSetId: string, filter: CommentFilter): SQL[] {
  const where: SQL[] = [eq(comments.changeSetId, changeSetId)];
  if (filter.module !== undefined) {
    where.push(eq(comments.subjectId, moduleKey(filter.module)));
  }
  if (filter.blockId !== undefined) {
    where.push(eq(comments.blockId, filter.blockId));
  }
  if (filter.modules !== undefined) {
    where.push(inArray(comments.subjectId, filter.modules.map(moduleKey)));
  }
  if (filter.resolved !== undefined) {
    where.push(
      filter.resolved
        ? isNotNull(thread.resolvedAt)
        : isNull(thread.resolvedAt),
    );
  }
  return where;
}

/** The module named `<lang>/<moduleId>`, as stored. */
function subjectOf(subjectId: string): CommentSubject {
  const [lang, moduleId] = subjectId.split('/');
  return CommentSubject.parse({ type: 'module', lang, moduleId });
}

function toComment(row: Row): Comment {
  const author = {
    kind: row.authorKind as ChangeSetAuthor['kind'],
    id: row.authorId,
  };
  return {
    id: row.id,
    changeSetId: row.changeSetId,
    threadId: row.threadId,
    subject: subjectOf(row.subjectId),
    blockId: row.blockId,
    commit: row.commit,
    author,
    body: row.body,
    createdAt: row.createdAt,
    ...(row.editedAt !== null && { editedAt: row.editedAt }),
    ...(row.deletedAt !== null && { deletedAt: row.deletedAt }),
    ...(row.resolvedAt !== null &&
      row.resolvedByKind !== null &&
      row.resolvedById !== null && {
        resolution: {
          at: row.resolvedAt,
          by: {
            kind: row.resolvedByKind as ChangeSetAuthor['kind'],
            id: row.resolvedById,
          },
        },
      }),
  };
}
