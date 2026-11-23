import { z } from 'zod';
import {
  resourceObject,
  singleDocument,
  toOne,
} from '../../base/api/json-api.js';
import { hasControl } from '../core/change-set.js';
import type { CommitOutcome } from '../core/actions/commit-working-copies.action.js';
import type { RevertOutcome } from '../core/actions/revert-changes.action.js';
import { MAX_COMMIT_CHANGES, MAX_COMMIT_MESSAGE } from '../core/commit.js';
import { LockSubject } from '../core/lock.js';

const Subjects = (describe: string) => z.array(LockSubject).describe(describe);

const Unchanged = Subjects(
  'Working copies dropped because they hold exactly what is committed, and listed subjects that have none: nothing to commit for these.',
);

/** A commit on a change set's branch, made at a save point. */
export const CommitResource = resourceObject('Commit', {
  attributes: z.object({
    branch: z.string().describe('The change set’s branch.'),
    parent: z.string().describe('The branch head it was made on.'),
    message: z.string(),
    written: Subjects('Modules and manuals written (created or replaced).'),
    deleted: Subjects('Modules and manuals deleted.'),
  }),
  relationships: z.object({ changeSet: toOne('ChangeSet') }),
  meta: z.object({ unchanged: Unchanged }),
})
  .describe('`id` is the commit’s ID.')
  .meta({ id: 'CommitResource' });

/** `POST /change-sets/{id}/commits`, 201: the commit made. */
export const CommitDocument = singleDocument(CommitResource).meta({
  id: 'CommitDocument',
});

/** `POST /change-sets/{id}/commits`, 200: nothing changed, so no commit. */
export const NoCommitDocument = z
  .object({
    meta: z.object({
      commit: z.null().describe('No commit was made.'),
      head: z.string().describe('The branch head, unchanged.'),
      unchanged: Unchanged,
    }),
  })
  .meta({ id: 'NoCommitDocument' });

export function toCommitDocument(
  outcome: CommitOutcome,
): z.infer<typeof CommitDocument> | z.infer<typeof NoCommitDocument> {
  if (outcome.commit === undefined) {
    return {
      meta: {
        commit: null,
        head: outcome.parent,
        unchanged: [...outcome.unchanged],
      },
    };
  }
  return {
    data: {
      type: 'Commit',
      id: outcome.commit,
      attributes: {
        branch: outcome.branch,
        parent: outcome.parent,
        message: outcome.message ?? '',
        written: [...outcome.written],
        deleted: [...outcome.deleted],
      },
      relationships: {
        changeSet: { data: { type: 'ChangeSet', id: outcome.changeSetId } },
      },
      meta: { unchanged: [...outcome.unchanged] },
    },
  };
}

const SubjectList = (describe: string) =>
  z.array(LockSubject).max(MAX_COMMIT_CHANGES).describe(describe);

/**
 * `POST /change-sets/{id}/commits`: no body (commit every working copy),
 * or which subjects to commit and delete, and the message.
 */
export const CreateCommitDocument = z
  .strictObject({
    data: z
      .strictObject({
        type: z.literal('Commit'),
        attributes: z.strictObject({
          subjects: SubjectList(
            'The working copies to commit. Default: every working copy of the change set.',
          ).optional(),
          deletes: SubjectList(
            'Modules, manuals, terms and page designs to delete in the same commit (their working copies, if any, are dropped); the configuration is never deleted (422 `not-deletable`), nor a page design still named by the configuration or a manual (409 `design-in-use`).',
          ).optional(),
          message: z
            .string()
            .trim()
            .min(1)
            .max(MAX_COMMIT_MESSAGE)
            .refine(
              (m) => !hasControl(m, '\n\t'),
              'no control characters but newline and tab',
            )
            .optional()
            .describe(
              'The commit message (up to 10,000 characters; no `---` lines, and not ending in `Key: value` lines). Default: what changed.',
            ),
        }),
      })
      .optional(),
  })
  .optional()
  .meta({ id: 'CreateCommitDocument' });
export type CreateCommitDocument = z.output<typeof CreateCommitDocument>;

/** `POST /change-sets/{id}/reverts`: the subjects to take out. */
export const CreateRevertDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('Revert'),
      attributes: z.strictObject({
        subjects: SubjectList(
          'The modules and manuals to take out of the change set: each goes back to what it is at the change set’s base commit.',
        ).min(1),
      }),
    }),
  })
  .meta({ id: 'CreateRevertDocument' });
export type CreateRevertDocument = z.output<typeof CreateRevertDocument>;

/** `POST /change-sets/{id}/reverts`, 200: what was taken out. */
export const RevertDocument = z
  .object({
    meta: z.object({
      commit: z
        .string()
        .nullable()
        .describe(
          'The commit made; null when only working copies were dropped.',
        ),
      head: z.string().describe('The change set’s branch head now.'),
      restored: Subjects(
        'Modules and manuals put back as they are at the base commit.',
      ),
      deleted: Subjects('Modules and manuals the change set created, deleted.'),
      discarded: Subjects(
        'Modules and manuals whose working copy was dropped.',
      ),
    }),
  })
  .meta({ id: 'RevertDocument' });

export function toRevertDocument(
  outcome: RevertOutcome,
): z.infer<typeof RevertDocument> {
  return {
    meta: {
      commit: outcome.commit ?? null,
      head: outcome.head,
      restored: [...outcome.restored],
      deleted: [...outcome.deleted],
      discarded: [...outcome.discarded],
    },
  };
}
