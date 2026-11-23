import { BlockId, ModuleId } from '@openfolia/content-model';
import { z } from 'zod';
import {
  type ChangeSetAuthor,
  ChangeSetDescription,
  isChangeSetId,
  newChangeSetId,
} from '../../change-sets/core/change-set.js';
import { SubjectLanguage } from '../../change-sets/core/lock.js';

/**
 * What a comment is anchored to: a module in one language, as locks name
 * it. Only modules for now; the `type` leaves room for manuals.
 */
export const CommentSubject = z.strictObject({
  type: z.literal('module'),
  lang: SubjectLanguage,
  moduleId: ModuleId,
});
export type CommentSubject = z.output<typeof CommentSubject>;

/** The block a comment is on: a block, list item or procedure step, by its ID. */
export const CommentBlockId = BlockId;

/** A comment's text: 1 to 10,000 characters, no control characters but tabs and line breaks. */
export const CommentBody = ChangeSetDescription;

/** A thread's resolution: when and by whom it was resolved. */
export interface CommentResolution {
  readonly at: Date;
  readonly by: ChangeSetAuthor;
}

/**
 * A comment on a block of a module in a change set. The first comment of
 * a thread anchors it (`threadId` is its own ID); a reply is in the same
 * thread (`threadId` the first comment's), on the same anchor. Only a
 * thread's first comment is resolved and reopened: `resolution` is always
 * undefined on a reply, and the thread's resolution is its first comment's.
 *
 * The anchor is the block's ID, never its position or text: a block keeps
 * its ID when it is edited or moved (even into another container), so the
 * comment stays on it; a comment whose block a later save point removed
 * stays too, `orphaned` (derived on reading, never stored).
 */
export interface Comment {
  readonly id: string;
  readonly changeSetId: string;
  readonly threadId: string;
  readonly subject: CommentSubject;
  readonly blockId: string;
  /** The change set's head the comment was written on. */
  readonly commit: string;
  readonly author: ChangeSetAuthor;
  /** The text; null once deleted (`deletedAt`). */
  readonly body: string | null;
  readonly createdAt: Date;
  readonly resolution?: CommentResolution;
  /** When its author last changed the text; undefined while never edited. */
  readonly editedAt?: Date;
  /**
   * When its author deleted it. Only a thread's first comment with replies
   * is still there once deleted, without its text, so the thread stays
   * readable; any other deleted comment is gone.
   */
  readonly deletedAt?: Date;
}

/** A comment as it is written: its text, none of what later changes do. */
export type NewComment = Omit<
  Comment,
  'body' | 'createdAt' | 'resolution' | 'editedAt' | 'deletedAt'
> & { readonly body: string };

/** Whether `comment` is a thread's first comment (not a reply). */
export const isThread = (comment: Pick<Comment, 'id' | 'threadId'>): boolean =>
  comment.id === comment.threadId;

/** A comment as read: with whether its block is gone from the change set's head. */
export interface ReadComment {
  readonly comment: Comment;
  /**
   * The block is not in the module at the change set's head (the review
   * head once submitted), or the module is not there any more: a save
   * point removed it. False when the module's file there cannot be read.
   */
  readonly orphaned: boolean;
}

/** Which of a change set's comments to list; every field optional. */
export interface CommentFilter {
  readonly module?: CommentSubject;
  readonly blockId?: string;
  /**
   * Only threads resolved (`true`) or open (`false`), each with its
   * replies; undefined for both.
   */
  readonly resolved?: boolean;
  /** Only comments on these modules (those the reader may see); undefined for all. */
  readonly modules?: readonly CommentSubject[];
}

/** Whether `actor` wrote `comment`: only its author edits or deletes it. */
export const isAuthor = (
  comment: Pick<Comment, 'author'>,
  actor: ChangeSetAuthor,
): boolean =>
  comment.author.kind === actor.kind && comment.author.id === actor.id;

/** A comment's ID: a UUID version 7, made by the server. */
export const newCommentId = newChangeSetId;
export const isCommentId = isChangeSetId;

/** A module as the audit log and the table name it: `<lang>/<moduleId>`. */
export const moduleKey = (subject: CommentSubject): string =>
  `${subject.lang}/${subject.moduleId}`;

/** The most comments one change set holds (replies included). */
export const MAX_COMMENTS = 10_000;
