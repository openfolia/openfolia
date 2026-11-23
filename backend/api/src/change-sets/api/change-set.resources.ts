import { z } from 'zod';
import {
  PageLinks,
  PageMeta,
  resourceObject,
  singleDocument,
} from '../../base/api/json-api.js';
import {
  AbandonComment,
  CHANGE_SET_STATES,
  type ChangeSet,
  ChangeSetDescription,
  ChangeSetState,
  ChangeSetTitle,
  hasControl,
} from '../core/change-set.js';

export const ChangeSetAttributes = z
  .object({
    title: z.string(),
    description: z.string().nullable(),
    state: ChangeSetState.describe(
      'Where it is in its life: `draft` → `in-review` (submitted) → `approved` → `merged`; returned to `draft` by a reviewer; `abandoned` from any open state.',
    ),
    author: z
      .object({ kind: z.enum(['user', 'service']), id: z.string() })
      .describe('Who started it.'),
    baseRef: z
      .string()
      .describe('The branch it started from, and will be merged back into.'),
    baseCommit: z
      .string()
      .describe('The commit `baseRef` pointed to when it started.'),
    branch: z
      .string()
      .describe(
        'Its own branch, named by the server (`change-sets/<id>`): read its content with `?ref=<branch>`.',
      ),
    reviewHead: z
      .string()
      .nullable()
      .describe(
        'The commit of its branch submitted for review: what approvals are of and a merge merges. Null for a draft.',
      ),
    mergeCommit: z
      .string()
      .nullable()
      .describe(
        'Where its base branch was once it was merged; null until then.',
      ),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({ id: 'ChangeSetAttributes' });

export const ChangeSetMeta = z
  .object({
    branchMissing: z
      .boolean()
      .describe(
        'Its branch is gone from the content repository (deleted outside the API, or the repository restored or replaced): reads at it answer 404 `change-set-branch-missing`. It is never recreated; leave the change set, or abandon it.',
      ),
    behind: z
      .number()
      .int()
      .min(0)
      .nullable()
      .optional()
      .describe(
        'How many commits its base branch has that its branch does not (counted up to 1000): above 0, `POST /change-sets/{changeSetId}/refresh` brings them in. Given by `GET /change-sets/{changeSetId}` for an open change set whose branch and base are there (and the base one the caller may read); null when its base was rewritten (`base.state`), where no update can bring them in.',
      ),
    base: z
      .object({
        state: z
          .enum(['current', 'rewritten'])
          .describe(
            '`current`: its base branch still holds the commit it started from. `rewritten`: it does not (the base’s history was rewritten, by a force-push or a restore), so it can be neither updated nor merged; `POST /change-sets/{changeSetId}/rebase` moves its changes onto the base’s current head, as a new change set.',
          ),
      })
      .optional()
      .describe(
        'Given by `GET /change-sets/{changeSetId}` with `behind`, for an open change set whose branch and base are there.',
      ),
    supersededBy: z
      .string()
      .optional()
      .describe(
        'The change set its changes were moved into, once its base was rewritten (`POST /change-sets/{changeSetId}/rebase`): the newest one. Given by `GET /change-sets/{changeSetId}`.',
      ),
    supersedes: z
      .string()
      .optional()
      .describe(
        'The change set whose changes it holds, moved onto the base’s current head. Given by `GET /change-sets/{changeSetId}`.',
      ),
  })
  .meta({ id: 'ChangeSetMeta' });

export const ChangeSetResource = resourceObject('ChangeSet', {
  attributes: ChangeSetAttributes,
  meta: ChangeSetMeta.optional().describe(
    'Derived from Git, not stored: given by `GET /change-sets` and `GET /change-sets/{changeSetId}`.',
  ),
}).meta({ id: 'ChangeSetResource' });

export const ChangeSetDocument = singleDocument(ChangeSetResource).meta({
  id: 'ChangeSetDocument',
});

/** Per state, how many change sets the list's filters but `filter[state]` leave (#481). */
export const ChangeSetStateCounts = z
  .object(
    Object.fromEntries(
      CHANGE_SET_STATES.map((state) => [state, z.number().int().nonnegative()]),
    ) as Record<(typeof CHANGE_SET_STATES)[number], z.ZodNumber>,
  )
  .describe(
    'Per state, how many change sets match the other filters (`filter[author]`), as the reader sees them, whatever `filter[state]` says: a list’s state filters show these counts without a request per state.',
  )
  .meta({ id: 'ChangeSetStateCounts' });

export const ChangeSetPageDocument = z
  .object({
    data: z.array(ChangeSetResource),
    meta: z.object({ page: PageMeta, counts: ChangeSetStateCounts }),
    links: PageLinks,
  })
  .meta({ id: 'ChangeSetPageDocument' });

export function toChangeSetResource(
  changeSet: ChangeSet,
): z.infer<typeof ChangeSetResource> {
  return {
    type: 'ChangeSet',
    id: changeSet.id,
    attributes: {
      title: changeSet.title,
      description: changeSet.description,
      state: changeSet.state,
      author: changeSet.author,
      baseRef: changeSet.baseRef,
      baseCommit: changeSet.baseCommit,
      branch: changeSet.branch,
      reviewHead: changeSet.reviewHead ?? null,
      mergeCommit: changeSet.mergeCommit ?? null,
      createdAt: changeSet.createdAt.toISOString(),
      updatedAt: changeSet.updatedAt.toISOString(),
    },
  };
}

/**
 * `toChangeSetResource` with `meta.branchMissing`: whether the change set's
 * ID is among `missing` (`ChangeSetBranchPresence`).
 */
export const toChangeSetResourceWithBranch =
  (missing: ReadonlySet<string>) =>
  (changeSet: ChangeSet): z.infer<typeof ChangeSetResource> => ({
    ...toChangeSetResource(changeSet),
    meta: { branchMissing: missing.has(changeSet.id) },
  });

/**
 * `POST /change-sets`: a new change set. No `id` (the server makes it) and
 * no branch name (the server names it from the ID).
 */
export const CreateChangeSetDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('ChangeSet'),
      attributes: z.strictObject({
        title: ChangeSetTitle.describe('One line, 1 to 200 characters.'),
        description: ChangeSetDescription.nullable()
          .optional()
          .describe('Up to 10,000 characters.'),
        baseRef: z
          .string()
          .min(1)
          .max(256)
          .optional()
          .describe(
            "The branch to start from. Default: the server's `CCMS_DEFAULT_REF`, or the branch `HEAD` names when that is `HEAD`. Not with `maintenanceLine`.",
          ),
        maintenanceLine: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe(
            'A maintenance line’s ID, instead of `baseRef`: start from the head of the line’s branch (an older product revision) and merge back into it. A closed line takes no new change sets.',
          ),
      }),
    }),
  })
  .meta({ id: 'CreateChangeSetDocument' });
export type CreateChangeSetDocument = z.output<typeof CreateChangeSetDocument>;

/**
 * `PATCH /change-sets/{id}`: a new title or description (`null` clears
 * it); nothing else changes this way.
 */
export const EditChangeSetDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('ChangeSet'),
      id: z.string().describe('The change set’s ID, as in the path.'),
      attributes: z.strictObject({
        title: ChangeSetTitle.optional().describe(
          'One line, 1 to 200 characters.',
        ),
        description: ChangeSetDescription.nullable()
          .optional()
          .describe('Up to 10,000 characters; `null` clears it.'),
      }),
    }),
  })
  .meta({ id: 'EditChangeSetDocument' });
export type EditChangeSetDocument = z.output<typeof EditChangeSetDocument>;

/** `POST /change-sets/{id}/abandon`: no body, or a comment for the audit log. */
export const AbandonChangeSetDocument = z
  .strictObject({
    meta: z
      .strictObject({
        comment: AbandonComment.optional().describe(
          'Why, recorded in the audit log.',
        ),
      })
      .optional(),
  })
  .optional()
  .meta({ id: 'AbandonChangeSetDocument' });
export type AbandonChangeSetDocument = z.output<
  typeof AbandonChangeSetDocument
>;

/** Filter parameters of `GET /change-sets`, validated before any query. */
export const changeSetFilters = {
  state: ChangeSetState,
  // A user's ID or a service's (which no user ID can look like).
  author: z
    .string()
    .min(1)
    .max(200)
    .refine((s) => !hasControl(s), 'no control characters'),
};
