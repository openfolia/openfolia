import { paginate, type PageRequest } from '../../src/base/core/paging.js';
import type { Transaction } from '../../src/base/core/unit-of-work.js';
import type { ChangeSetAuthor } from '../../src/change-sets/core/change-set.js';
import {
  type Comment,
  type CommentFilter,
  type CommentSubject,
  moduleKey,
  type NewComment,
} from '../../src/comments/core/comment.js';
import { CommentStore } from '../../src/comments/core/comment-store.js';
import { fakeOf } from './fake-unit-of-work.js';

/**
 * Comments in memory, with `FakeUnitOfWork`: writes are kept only when
 * their transaction commits. `comments` holds them oldest first.
 */
export class FakeCommentStore extends CommentStore {
  readonly comments: Comment[] = [];
  /** Comments removed in a transaction not yet ended: it no longer sees them. */
  private readonly removing = new WeakMap<object, Set<string>>();

  /** The comments as `tx` sees them: its own removals left out. */
  private seen(tx: object): Comment[] {
    const removed = this.removing.get(tx);
    return removed
      ? this.comments.filter((c) => !removed.has(c.id))
      : this.comments;
  }

  async insert(tx: Transaction, comment: NewComment): Promise<Comment> {
    const transaction = fakeOf(tx);
    if (comment.threadId !== comment.id) {
      const thread = this.comments.find((c) => c.id === comment.threadId);
      if (
        !thread ||
        thread.changeSetId !== comment.changeSetId ||
        moduleKey(thread.subject) !== moduleKey(comment.subject) ||
        thread.blockId !== comment.blockId
      ) {
        throw new Error('fake: a reply off its thread’s anchor');
      }
    }
    const stored: Comment = { ...comment, createdAt: transaction.startedAt };
    transaction.onCommit(() => this.comments.push(stored));
    return stored;
  }

  async find(id: string): Promise<Comment | undefined> {
    return this.comments.find((c) => c.id === id);
  }

  async lock(tx: Transaction, id: string): Promise<Comment | undefined> {
    return this.seen(fakeOf(tx)).find((c) => c.id === id);
  }

  async setResolution(
    tx: Transaction,
    id: string,
    by: ChangeSetAuthor | null,
  ): Promise<Comment> {
    const transaction = fakeOf(tx);
    const index = this.comments.findIndex((c) => c.id === id);
    const current = this.comments[index];
    if (!current) throw new Error(`No comment ${id} to update.`);
    const { resolution: _, ...rest } = current;
    const updated: Comment = by
      ? { ...rest, resolution: { at: transaction.startedAt, by } }
      : rest;
    transaction.onCommit(() => {
      this.comments[index] = updated;
    });
    return updated;
  }

  async edit(tx: Transaction, id: string, body: string): Promise<Comment> {
    const transaction = fakeOf(tx);
    return this.update(transaction, id, (c) => ({
      ...c,
      body,
      editedAt: transaction.startedAt,
    }));
  }

  async markDeleted(tx: Transaction, id: string): Promise<Comment> {
    const transaction = fakeOf(tx);
    return this.update(transaction, id, (c) => {
      if (c.id !== c.threadId) throw new Error('fake: a reply marked deleted');
      return { ...c, body: null, deletedAt: transaction.startedAt };
    });
  }

  async remove(tx: Transaction, id: string): Promise<void> {
    const transaction = fakeOf(tx);
    const seen = this.seen(transaction);
    if (!seen.some((c) => c.id === id)) {
      throw new Error(`No comment ${id} to remove.`);
    }
    // As the database's foreign key: not a thread start with replies.
    if (seen.some((c) => c.threadId === id && c.id !== id)) {
      throw new Error('fake: a thread removed with its replies');
    }
    const removed = this.removing.get(transaction) ?? new Set<string>();
    this.removing.set(transaction, removed.add(id));
    transaction.onCommit(() => {
      const index = this.comments.findIndex((c) => c.id === id);
      if (index >= 0) this.comments.splice(index, 1);
    });
  }

  async replies(tx: Transaction, threadId: string): Promise<number> {
    return this.seen(fakeOf(tx)).filter(
      (c) => c.threadId === threadId && c.id !== threadId,
    ).length;
  }

  private update(
    transaction: ReturnType<typeof fakeOf>,
    id: string,
    change: (c: Comment) => Comment,
  ): Comment {
    const current = this.seen(transaction).find((c) => c.id === id);
    if (!current || current.deletedAt !== undefined) {
      throw new Error(`No comment ${id} to update.`);
    }
    const updated = change(current);
    transaction.onCommit(() => {
      const index = this.comments.findIndex((c) => c.id === id);
      this.comments[index] = updated;
    });
    return updated;
  }

  async moveModule(
    tx: Transaction,
    changeSetId: string,
    from: CommentSubject,
    to: CommentSubject,
  ): Promise<number> {
    const transaction = fakeOf(tx);
    const on = (c: Comment) =>
      c.changeSetId === changeSetId && moduleKey(c.subject) === moduleKey(from);
    const count = this.comments.filter(on).length;
    transaction.onCommit(() => {
      for (const [i, c] of this.comments.entries()) {
        if (on(c)) this.comments[i] = { ...c, subject: to };
      }
    });
    return count;
  }

  async count(tx: Transaction, changeSetId: string): Promise<number> {
    return this.seen(fakeOf(tx)).filter((c) => c.changeSetId === changeSetId)
      .length;
  }

  async modules(changeSetId: string): Promise<CommentSubject[]> {
    const found = new Map<string, CommentSubject>();
    for (const c of this.comments) {
      if (c.changeSetId === changeSetId)
        found.set(moduleKey(c.subject), c.subject);
    }
    return [...found.values()];
  }

  async list(changeSetId: string, filter: CommentFilter, page: PageRequest) {
    const resolved = (c: Comment) =>
      this.comments.find((t) => t.id === c.threadId)?.resolution !== undefined;
    const modules = filter.modules?.map(moduleKey);
    const matching = this.comments.filter(
      (c) =>
        c.changeSetId === changeSetId &&
        (filter.module === undefined ||
          moduleKey(c.subject) === moduleKey(filter.module)) &&
        (filter.blockId === undefined || c.blockId === filter.blockId) &&
        (modules === undefined || modules.includes(moduleKey(c.subject))) &&
        (filter.resolved === undefined || resolved(c) === filter.resolved),
    );
    // Thread order: threads as started, each followed by its replies (a
    // reply matches whatever its thread matches: the same anchor).
    const ordered = matching
      .filter((c) => c.id === c.threadId)
      .flatMap((t) => matching.filter((c) => c.threadId === t.id));
    return paginate(ordered, page);
  }
}
