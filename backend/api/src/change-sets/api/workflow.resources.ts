import { z } from 'zod';
import { TransitionComment } from '../core/change-set.js';
import type { Approval } from '../core/approval.js';
import type { ReviewOutcome } from '../core/actions/approve-change-set.action.js';
import type { ReportedConflict } from '../core/refresh-conflicts.js';
import { subjectName } from '../core/lock.js';
import { subjectPath } from '../core/commit.js';
import { SELF_APPROVAL } from '../core/self-approval.js';
import {
  PageLinks,
  PageMeta,
  resourceObject,
  toOne,
} from '../../base/api/json-api.js';
import { ChangeSetResource } from './change-set.resources.js';
import { SubjectSchema } from './lock.resources.js';

/** The body of a transition: none, or a comment for the audit log. */
export const TransitionDocument = z
  .strictObject({
    meta: z
      .strictObject({
        comment: TransitionComment.optional().describe(
          'Why (changes requested, what was checked), recorded in the audit log. Up to 10,000 characters.',
        ),
      })
      .optional(),
  })
  .optional()
  .meta({ id: 'TransitionDocument' });
export type TransitionDocument = z.output<typeof TransitionDocument>;

const Requirement = z
  .string()
  .describe(
    '`review`, or `sign-off/<module type>` for a restricted module type (`restricted: true` in the configuration).',
  );

const ApprovalItem = z.object({
  requirement: Requirement,
  approver: z.object({
    kind: z.enum(['user', 'service']),
    id: z.string(),
  }),
  head: z.string().describe('The commit approved (its review head).'),
  self: z
    .boolean()
    .describe(
      'Given by the change set’s own author, as the installation’s self-approval rule allowed when it was given.',
    ),
  at: z.iso.datetime({ offset: true }),
});

export const ReviewMeta = z
  .object({
    required: z
      .array(Requirement)
      .describe('Every approval the change set needs, in order.'),
    granted: z.array(Requirement).describe('The ones this request met.'),
    pending: z
      .array(Requirement)
      .describe('The ones still unmet; empty once it is approved.'),
    approvals: z
      .array(ApprovalItem)
      .describe('The approvals of its review head, oldest first.'),
    lapsed: z
      .array(ApprovalItem)
      .describe(
        'Those of them that no longer hold: their approver lost the role or scope they took (or is gone). They count for nothing; `pending` already says what is unmet.',
      ),
    selfApproved: z
      .boolean()
      .describe(
        'Approved by its author: an approval of `approvals` that still holds (not `lapsed`) was given by the change set’s own author (`self`).',
      ),
    selfApproval: z
      .enum(SELF_APPROVAL)
      .describe(
        'The installation’s self-approval rule now (`GET /settings`): `never` (four eyes), `review` (its author may give the review approval, not a sign-off) or `review-and-sign-off`. Approvals given under an earlier rule stay.',
      ),
    yours: z
      .boolean()
      .describe(
        'Whether you count as its author: you started it, or wrote a commit it holds (one carried into it by a carry-forward or a move onto a rewritten base included). Four eyes and `selfApproval` apply to you then. Who else counts is not told.',
      ),
  })
  .meta({ id: 'ReviewMeta' });

/** The answer to approve and sign-off: the change set, and where its review stands. */
export const ReviewDocument = z
  .object({
    data: ChangeSetResource,
    meta: z.object({ review: ReviewMeta }),
  })
  .meta({ id: 'ReviewDocument' });

/** The answer to a merge: the change set, and the merge commit. */
export const MergeDocument = z
  .object({
    data: ChangeSetResource,
    meta: z.object({
      merge: z.object({
        commit: z
          .string()
          .describe('Where the base branch now is: the merge commit.'),
        fastForward: z.boolean(),
      }),
    }),
  })
  .meta({ id: 'MergeDocument' });

/** The most conflicts a carry-forward lists (`meta.total` counts them all). */
export const MAX_CARRY_CONFLICTS = 100;

/** A path a change set's own diff did not apply to (carrying it forward, or moving it). */
const CarryConflictItem = z
  .object({
    path: z.string(),
    subject: SubjectSchema.optional(),
    kinds: z
      .array(z.string())
      .describe(
        'Why it was left as it is there: git’s conflict kinds (`contents`, `modify/delete`, …), `locked` (another change set holds it), `too-many-locks` (the change set holds as many as it may), `forbidden` (alone: outside the actor’s scope, there or as merged), `invalid` (the merged file is no such file, or a module naming more than 200 files), `unknown-asset` (a module names a file you may not use: one no module you may see there or on the base uses, and not uploaded into a change set of yours), `translation-record` (a page design’s or manual’s translation record you may not write: only a translation manager of its language changes it), `unsupported` (no module, manual, configuration or term), `binary`.',
      ),
    blockIds: z
      .array(z.string())
      .optional()
      .describe(
        'For a module: the blocks the carried change set changed in it, to apply by hand.',
      ),
  })
  .meta({ id: 'CarryConflict' });

const carriedConflicts = z
  .array(CarryConflictItem)
  .describe(
    `What did not apply, by path, at most ${MAX_CARRY_CONFLICTS}: left unchanged on the new branch for the author to fix in the editor (the change set holds its lock where it could take it).`,
  );

/** The answer to carrying a change set forward (#60): the new draft on `main`. */
export const CarryForwardDocument = z
  .object({
    data: ChangeSetResource,
    meta: z.object({
      carryForward: z.object({
        from: z
          .string()
          .describe(
            'The change set carried forward (merged into a maintenance line).',
          ),
        commit: z
          .string()
          .nullable()
          .describe(
            'The commit on the new branch holding what applied; null when nothing did.',
          ),
        applied: z
          .array(SubjectSchema)
          .describe('What that commit changes (written or deleted).'),
        conflicts: carriedConflicts,
        total: z.number().int().describe('Conflicts in all.'),
      }),
    }),
  })
  .meta({ id: 'CarryForwardDocument' });

/** `POST /change-sets/{id}/rebase`: the new change set, and what of the old one's changes it holds. */
export const RebaseDocument = z
  .object({
    data: ChangeSetResource.describe(
      'The new draft change set on the base’s current head (yours), with the same title and description.',
    ),
    meta: z.object({
      rebase: z.object({
        from: z
          .string()
          .describe(
            'The change set moved: abandoned now, superseded by the new one.',
          ),
        commit: z
          .string()
          .nullable()
          .describe(
            'The commit on the new branch holding what applied; null when nothing did.',
          ),
        applied: z
          .array(SubjectSchema)
          .describe('What that commit changes (written or deleted).'),
        conflicts: carriedConflicts,
        total: z.number().int().describe('Conflicts in all.'),
      }),
    }),
  })
  .meta({ id: 'RebaseDocument' });

export function toReviewMeta(
  outcome: ReviewOutcome,
): z.infer<typeof ReviewMeta> {
  return {
    required: [...outcome.required],
    granted: [...outcome.granted],
    pending: [...outcome.pending],
    approvals: outcome.approvals.map(toApprovalItem),
    lapsed: outcome.lapsed.map(toApprovalItem),
    // Only one that still counts: a lapsed self-approval approves nothing.
    selfApproved: outcome.approvals.some(
      (a) =>
        a.self &&
        !outcome.lapsed.some(
          (l) =>
            l.requirement === a.requirement &&
            l.approver.kind === a.approver.kind &&
            l.approver.id === a.approver.id,
        ),
    ),
    selfApproval: outcome.selfApproval,
    yours: outcome.yours,
  };
}

function toApprovalItem(a: Approval): z.infer<typeof ApprovalItem> {
  return {
    requirement: a.requirement,
    approver: { kind: a.approver.kind, id: a.approver.id },
    head: a.head,
    self: a.self,
    at: a.at.toISOString(),
  };
}

/** `POST /change-sets/{id}/refresh`: none, or what to keep and a comment. */
export const RefreshChangeSetDocument = z
  .strictObject({
    meta: z
      .strictObject({
        comment: TransitionComment.optional().describe(
          'Why, recorded in the audit log. Up to 10,000 characters.',
        ),
        keep: z
          .array(SubjectSchema)
          .max(100)
          .optional()
          .describe(
            'Subjects resolved by their author: where its file conflicts with the base, the change set’s version is kept. Each must have been saved (a working-copy save) since an update reported it conflicting, against a base whose file is still the one reported; else 409 `refresh-unresolved`. Their working copies are committed first, as a save point. Each needs the change set’s lock where it conflicts. At most 100 with `keepMine`.',
          ),
        keepMine: z
          .array(SubjectSchema)
          .max(100)
          .optional()
          .describe(
            'Subjects the author keeps as the change set has them by explicit choice (“Keep my version”), saved since or not: the base’s change is dropped where it conflicts. Otherwise as `keep` (never both for one subject); audited apart (`keptByChoice`).',
          ),
      })
      .optional(),
  })
  .optional()
  .meta({ id: 'RefreshChangeSetDocument' });
export type RefreshChangeSetDocument = z.output<
  typeof RefreshChangeSetDocument
>;

/** The answer to an update from the base: the change set, and what was done. */
export const RefreshDocument = z
  .object({
    data: ChangeSetResource,
    meta: z.object({
      refresh: z.object({
        updated: z
          .boolean()
          .describe(
            'False when its branch held the base’s head already: nothing was written to Git.',
          ),
        head: z.string().describe('Where its branch is now.'),
        fastForward: z
          .boolean()
          .describe(
            'Its branch moved to the base’s head (it had no commits of its own).',
          ),
        savePoint: z
          .string()
          .nullable()
          .describe(
            'The save point that committed the kept subjects’ working copies first; null when there was none.',
          ),
      }),
    }),
  })
  .meta({ id: 'RefreshDocument' });

/** A conflict an update from the base reported (#437), and whether it was saved since. */
export const RefreshConflictResource = resourceObject('RefreshConflict', {
  attributes: z.object({
    subject: SubjectSchema,
    path: z.string().describe('The subject’s file in the repository.'),
    base: z
      .string()
      .describe('The base branch’s head the conflict was reported against.'),
    reportedAt: z.iso.datetime({ offset: true }),
    savedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        'The first working-copy save since the report: “Update again” may keep it (`meta.keep`) once set. Null while it was not saved.',
      ),
  }),
  relationships: z.object({ changeSet: toOne('ChangeSet') }),
})
  .describe(
    '`id` is `module/<lang>/<moduleId>`, `manual/<manualId>`, `config` or `term/<termId>`.',
  )
  .meta({ id: 'RefreshConflictResource' });

export const RefreshConflictPageDocument = z
  .object({
    data: z.array(RefreshConflictResource),
    meta: z.object({ page: PageMeta }),
    links: PageLinks,
  })
  .meta({ id: 'RefreshConflictPageDocument' });

export function toRefreshConflictResource(
  changeSetId: string,
): (conflict: ReportedConflict) => z.infer<typeof RefreshConflictResource> {
  return (conflict) => ({
    type: 'RefreshConflict',
    id: subjectName(conflict.subject),
    attributes: {
      subject: conflict.subject,
      path: subjectPath(conflict.subject),
      base: conflict.base,
      reportedAt: conflict.reportedAt.toISOString(),
      savedAt: conflict.savedAt?.toISOString() ?? null,
    },
    relationships: {
      changeSet: { data: { type: 'ChangeSet', id: changeSetId } },
    },
  });
}
