import type { ChangeSetAuthor } from '../../change-sets/core/change-set.js';
import type { PageRequest, Paginated } from '../../base/core/paging.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import type {
  Comment,
  CommentFilter,
  CommentSubject,
  NewComment,
} from './comment.js';

/** Port: the comments on change sets (Postgres; never Git). */
export abstract class CommentStore {
  /**
   * Records a new comment inside `tx`, as written by its author at the
   * transaction's time (`createdAt` is the time stored).
   */
  abstract insert(tx: Transaction, comment: NewComment): Promise<Comment>;

  /** The comment `id`; undefined when there is none (or `id` is malformed). */
  abstract find(id: string): Promise<Comment | undefined>;

  /**
   * The comment `id`, read inside `tx` and locked until it ends
   * (`SELECT … FOR UPDATE`), so no concurrent transaction resolves or
   * reopens it meanwhile.
   */
  abstract lock(tx: Transaction, id: string): Promise<Comment | undefined>;

  /**
   * Resolves (`by`: at the transaction's time) or reopens (`null`) the
   * thread whose first comment is `id` (locked by `lock` in the same `tx`),
   * and returns it as it now is.
   */
  abstract setResolution(
    tx: Transaction,
    id: string,
    by: ChangeSetAuthor | null,
  ): Promise<Comment>;

  /**
   * Sets the text of the comment `id` (locked by `lock` in the same `tx`),
   * marked edited at the transaction's time, and returns it as it now is.
   */
  abstract edit(tx: Transaction, id: string, body: string): Promise<Comment>;

  /**
   * Marks the thread's first comment `id` (locked by `lock` in the same
   * `tx`) deleted at the transaction's time, its text gone; it stays for
   * its replies. Returns it as it now is.
   */
  abstract markDeleted(tx: Transaction, id: string): Promise<Comment>;

  /**
   * Removes the comment `id` (locked by `lock` in the same `tx`). A
   * thread's first comment goes only once it has no replies.
   */
  abstract remove(tx: Transaction, id: string): Promise<void>;

  /** How many replies the thread whose first comment is `threadId` has, inside `tx`. */
  abstract replies(tx: Transaction, threadId: string): Promise<number>;

  /**
   * Moves the change set's comments on module `from` (threads and their
   * replies) to `to`, the same module under another ID, inside `tx`, block
   * IDs kept (#265). Returns how many moved.
   */
  abstract moveModule(
    tx: Transaction,
    changeSetId: string,
    from: CommentSubject,
    to: CommentSubject,
  ): Promise<number>;

  /** How many comments the change set holds, replies included, inside `tx`. */
  abstract count(tx: Transaction, changeSetId: string): Promise<number>;

  /** The modules the change set's comments are on, each once. */
  abstract modules(changeSetId: string): Promise<CommentSubject[]>;

  /**
   * One page of the change set's comments matching `filter`, in thread
   * order: threads by when they were started, each followed by its
   * replies, oldest first.
   */
  abstract list(
    changeSetId: string,
    filter: CommentFilter,
    page: PageRequest,
  ): Promise<Paginated<Comment>>;
}
