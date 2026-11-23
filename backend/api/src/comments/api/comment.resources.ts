import { z } from 'zod';
import {
  PageLinks,
  PageMeta,
  resourceObject,
  singleDocument,
  toOne,
} from '../../base/api/json-api.js';
import {
  CommentBlockId,
  CommentBody,
  CommentSubject,
  type ReadComment,
} from '../core/comment.js';

const Who = z.object({ kind: z.enum(['user', 'service']), id: z.string() });

/** A comment's module, as the API writes it (requests and responses alike). */
export const CommentSubjectSchema = CommentSubject.describe(
  'The module, in one language, the comment is on: `{ type: "module", lang, moduleId }`, as locks name it.',
).meta({ id: 'CommentSubject' });

export const CommentAttributes = z
  .object({
    subject: CommentSubjectSchema,
    blockId: z
      .string()
      .describe(
        'The block, list item or procedure step the comment is on, by its ID: it stays on it when the block is edited or moved; once a save point removes it the comment stays, `meta.orphaned`.',
      ),
    body: z
      .string()
      .nullable()
      .describe(
        'The text (plain text), trimmed; null once its author deleted it (`meta.deleted`).',
      ),
    author: Who.describe('Who wrote it.'),
    commit: z
      .string()
      .describe(
        'The change set’s head it was written on (the review head once submitted, else the branch’s head).',
      ),
    createdAt: z.iso.datetime({ offset: true }),
    resolvedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        'When its thread was resolved; null while open, and always for a reply (a thread’s resolution is its first comment’s).',
      ),
    resolvedBy: Who.nullable().describe(
      'Who resolved its thread; null while open, and always for a reply.',
    ),
  })
  .meta({ id: 'CommentAttributes' });

export const CommentResource = resourceObject('Comment', {
  attributes: CommentAttributes,
  relationships: z.object({
    changeSet: toOne('ChangeSet'),
    thread: toOne('Comment').describe(
      'The thread’s first comment: this comment itself for a thread, the comment it replies to for a reply.',
    ),
  }),
  meta: z.object({
    orphaned: z
      .boolean()
      .describe(
        'Derived: the block (or its whole module) is not at the change set’s head any more, as the reader sees it. False when the module’s file there cannot be read.',
      ),
    deleted: z
      .boolean()
      .describe(
        'Its author deleted it: a thread’s first comment that stays, without its text (`body` null), so its replies stay readable. Any other deleted comment is gone.',
      ),
    editedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        'When its author last changed the text; null while never edited. The earlier text is not kept.',
      ),
  }),
}).meta({ id: 'CommentResource' });

export const CommentDocument = singleDocument(CommentResource).meta({
  id: 'CommentDocument',
});

export const CommentPageDocument = z
  .object({
    data: z.array(CommentResource),
    meta: z.object({
      page: PageMeta,
      head: z
        .string()
        .describe(
          'The change set’s head `meta.orphaned` was worked out against: the review head once submitted, else the branch’s head.',
        ),
    }),
    links: PageLinks,
  })
  .meta({ id: 'CommentPageDocument' });

export function toCommentResource({
  comment,
  orphaned,
}: ReadComment): z.infer<typeof CommentResource> {
  return {
    type: 'Comment',
    id: comment.id,
    attributes: {
      subject: comment.subject,
      blockId: comment.blockId,
      body: comment.body,
      author: comment.author,
      commit: comment.commit,
      createdAt: comment.createdAt.toISOString(),
      resolvedAt: comment.resolution?.at.toISOString() ?? null,
      resolvedBy: comment.resolution?.by ?? null,
    },
    relationships: {
      changeSet: { data: { type: 'ChangeSet', id: comment.changeSetId } },
      thread: { data: { type: 'Comment', id: comment.threadId } },
    },
    meta: {
      orphaned,
      deleted: comment.deletedAt !== undefined,
      editedAt: comment.editedAt?.toISOString() ?? null,
    },
  };
}

/** `PATCH /change-sets/{changeSetId}/comments/{commentId}`: a new text, nothing else. */
export const EditCommentDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('Comment'),
      id: z.string().describe('The comment’s ID, as in the path.'),
      attributes: z.strictObject({
        body: CommentBody.describe(
          'The new text: plain text, 1 to 10,000 characters; tabs and line breaks allowed, no other control characters.',
        ),
      }),
    }),
  })
  .meta({ id: 'EditCommentDocument' });
export type EditCommentDocument = z.output<typeof EditCommentDocument>;

/**
 * `POST /change-sets/{changeSetId}/comments`: a new thread, on a module's
 * block (`subject` and `blockId`), or a reply to a thread
 * (`relationships.thread`), exactly one of the two.
 */
export const CreateCommentDocument = z
  .strictObject({
    data: z
      .strictObject({
        type: z.literal('Comment'),
        attributes: z.strictObject({
          body: CommentBody.describe(
            'Plain text, 1 to 10,000 characters; tabs and line breaks allowed, no other control characters.',
          ),
          subject: CommentSubjectSchema.optional().describe(
            'The module of a new thread. Not for a reply, which is on its thread’s.',
          ),
          blockId: CommentBlockId.optional().describe(
            'The block of a new thread, by its ID: in the module at the change set’s head or at its base. Not for a reply.',
          ),
        }),
        relationships: z
          .strictObject({
            thread: z
              .strictObject({
                data: z.strictObject({
                  type: z.literal('Comment'),
                  id: z.uuid(),
                }),
              })
              .describe(
                'A reply: the thread’s first comment. Without it, the comment starts a thread.',
              ),
          })
          .optional(),
      })
      .refine(
        (d) =>
          d.relationships === undefined
            ? d.attributes.subject !== undefined &&
              d.attributes.blockId !== undefined
            : d.attributes.subject === undefined &&
              d.attributes.blockId === undefined,
        {
          message:
            'give `subject` and `blockId` for a new thread, or `relationships.thread` (and neither) for a reply',
        },
      ),
  })
  .meta({ id: 'CreateCommentDocument' });
export type CreateCommentDocument = z.output<typeof CreateCommentDocument>;

/** Filter parameters of `GET /change-sets/{changeSetId}/comments`, validated before any query. */
export const commentFilters = {
  module: z
    .string()
    .max(200)
    .transform((text, ctx) => {
      const [lang, moduleId, ...rest] = text.split('/');
      const parsed = CommentSubject.safeParse({
        type: 'module',
        lang,
        moduleId,
      });
      if (rest.length > 0 || !parsed.success) {
        ctx.addIssue({
          code: 'custom',
          message: '`<lang>/<moduleId>`, e.g. `en/battery-charging`',
        });
        return z.NEVER;
      }
      return parsed.data;
    }),
  block: CommentBlockId,
  resolved: z
    .enum(['true', 'false', 'any'])
    .transform((v) => (v === 'any' ? ('any' as const) : v === 'true')),
};
