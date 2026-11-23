import { Injectable } from '@nestjs/common';
import { ActorAction } from '../../../access/core/policy.js';
import { ConflictError, ForbiddenError } from '../../../base/core/errors.js';
import { BOUNDED, UnitOfWork } from '../../../base/core/unit-of-work.js';
import { approversOf } from '../approval.js';
import { ApprovalStanding, notApproved } from '../approval-standing.js';
import { ApprovalStore } from '../approval-store.js';
import type { ChangeSet } from '../change-set.js';
import {
  ChangeSetBranches,
  type MergeConflictPath,
} from '../change-set-branches.js';
import { refuseUsages } from '../config-usage.js';
import { refuseTermUsages } from '../term-usage.js';
import { coversChanges } from '../review-scope.js';
import { headMoved, Workflow } from '../workflow.js';
import type { TransitionInput } from './submit-change-set.action.js';

/** How often a merge is tried again when its base moved meanwhile. */
export const MERGE_ATTEMPTS = 3;

/** The most conflicting paths one answer lists (`meta.total` counts all). */
export const MAX_CONFLICTS = 100;

/** The 403's detail when the publisher's scope does not cover the change set. */
export const MERGE_OUTSIDE_SCOPE =
  'Your roles may not publish everything the change set changes.';

/** What a merge did. */
export interface MergeOutcome {
  readonly changeSet: ChangeSet;
  /** Where its base branch is now: the merge commit. */
  readonly commit: string;
  readonly fastForward: boolean;
}

/**
 * Merges an approved change set into its base branch (`baseRef`):
 * exactly its review head, the commit that was approved, by
 * `ChangeSetBranches.merge` (compare-and-swap on the base's head), with one
 * `Approved-by` trailer per approver, so it is always a merge commit. Then
 * `merged`, audited (`change-set.merge`), an outbox row, its locks
 * released and any working copies dropped (`Workflow.recordMerge`).
 *
 * A publisher (`release.publish`) whose scope covers everything it changes;
 * merging is what makes the content reach its base (`main`: released).
 * The approvals are checked again (`ApprovalStanding`): every
 * requirement met for the review head by an approval whose approver,
 * looked up again, still holds the role and scope it took (409
 * `approval-lapsed` when one no longer does and nothing else meets its
 * requirement; `not-approved` otherwise). The requirements and those
 * checks are made against the base commit each attempt merges onto, so a
 * restriction pushed to the base between two attempts is not missed. A branch that has moved from the review head (pushed to outside
 * the API) holds no approval: the change set is returned to draft and the
 * answer is 409 `head-moved`. **Conflicts** are answered as data: 409
 * `merge-conflict` with the paths (`meta.conflicts`, at most
 * `MAX_CONFLICTS`; `meta.total`), nothing written, and the change set
 * stays approved but unmerged (a reviewer returns it for its author to
 * resolve). A merge that would leave content invalid under the
 * configuration it keeps (a value one side removed, the other uses) is
 * 422 `config-in-use` with the usages (`Workflow.mergeUsages`), and the
 * change set stays approved but unmerged too. A base that keeps moving is 409 `base-moved` after
 * `MERGE_ATTEMPTS`.
 *
 * **Order: Git first, then the database**, as save points do. One
 * transaction holds the change set's row from the checks to the end; the
 * merge is made inside it and recorded after. If the transaction fails, or
 * the process stops, after the merge landed, the change set is still
 * `approved` with its review head in its base's history:
 * `ReconcileChangeSetMergesAction` records it then (and a merge tried again
 * finds it up to date and records it). Never retried on contention: a 409
 * `lock-contended` is answered as it is.
 */
@Injectable()
export class MergeChangeSetAction extends ActorAction<
  TransitionInput,
  MergeOutcome
> {
  readonly policy = 'release.publish';

  constructor(
    private readonly workflow: Workflow,
    private readonly approvals: ApprovalStore,
    private readonly standing: ApprovalStanding,
    private readonly branches: ChangeSetBranches,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected async run({
    actor,
    id,
    comment,
  }: TransitionInput): Promise<MergeOutcome> {
    const outcome = await this.unit.run(
      async (tx): Promise<MergeOutcome | { moved: [string, string] }> => {
        const changeSet = await this.workflow.locked(tx, actor, id, 'merge');
        const reviewHead = changeSet.reviewHead;
        if (reviewHead === undefined) {
          throw new Error(
            `Change set ${id} is approved without a review head.`,
          );
        }
        const approvals = await this.approvals.listOf(tx, id);
        for (let attempt = 1; attempt <= MERGE_ATTEMPTS; attempt++) {
          // Every attempt is checked against the base commit it merges
          // onto: a type restricted there by a push between two attempts
          // needs its sign-off as much as one restricted before the first.
          const expected = await this.branches.head(changeSet.baseRef);
          if (expected === undefined) {
            throw new ConflictError(
              'base-missing',
              `The change set’s base branch ${changeSet.baseRef} is gone.`,
            );
          }
          const changes = await this.workflow.changes(
            actor,
            changeSet,
            reviewHead,
            expected,
          );
          // The scope first: only someone who could merge it may bounce it.
          if (!coversChanges(actor, 'release.publish', changes)) {
            throw new ForbiddenError(MERGE_OUTSIDE_SCOPE);
          }
          if (attempt === 1) {
            const head = await this.workflow.headOf(changeSet);
            if (head !== reviewHead) {
              await this.workflow.returnToDraft(tx, actor, changeSet, {
                data: { reason: 'head-moved', branchHead: head },
              });
              return { moved: [reviewHead, head] };
            }
          }
          // What was reviewed is the diff from the base commit: a base
          // rewound past it (outside the API) would bring in more.
          if (
            !(await this.branches.contains(
              changeSet.baseRef,
              changeSet.baseCommit,
            ))
          ) {
            throw new ConflictError(
              'base-rewritten',
              'The base branch no longer holds the commit the change set started from; what would be merged is not what was reviewed.',
              { baseCommit: changeSet.baseCommit },
            );
          }
          // Approvals count only while their approver still holds the
          // role and scope they took (looked up again now).
          const review = await this.standing.standing(
            tx,
            changes,
            approvals,
            reviewHead,
          );
          if (review.pending.length > 0) throw notApproved(review);
          // The merged tree must stay valid under the configuration it
          // keeps: a value removed on one side, used on the other. Not
          // for a merge that landed already (recorded below as it is).
          if (!(await this.branches.contains(changeSet.baseRef, reviewHead))) {
            refuseUsages(
              await this.workflow.mergeUsages(
                actor,
                changeSet,
                reviewHead,
                expected,
              ),
            );
            // Nor may it link a term one side deleted (#245).
            refuseTermUsages(
              await this.workflow.mergeTermUsages(
                actor,
                changeSet,
                reviewHead,
                expected,
              ),
            );
          }
          const approvedBy = approversOf(review.holding, reviewHead);
          const merged = await this.mergeOnto(
            changeSet,
            reviewHead,
            expected,
            actor,
            approvedBy,
          );
          if (merged === undefined) continue;
          const after = await this.workflow.recordMerge(tx, actor, changeSet, {
            ...merged,
            approvedBy,
            ...(comment !== undefined && { comment }),
          });
          return { changeSet: after, ...merged };
        }
        throw new ConflictError(
          'base-moved',
          'The base branch kept moving while merging; try again.',
        );
      },
      BOUNDED,
    );
    if ('moved' in outcome) throw headMoved(...outcome.moved);
    return outcome;
  }

  /**
   * The merge in Git onto `expected` (compare-and-swap); undefined when
   * the base moved from it meanwhile (checked and tried again on top).
   */
  private async mergeOnto(
    changeSet: ChangeSet,
    head: string,
    expected: string,
    actor: TransitionInput['actor'],
    approvedBy: readonly { kind: 'user' | 'service'; id: string }[],
  ): Promise<{ commit: string; fastForward: boolean } | undefined> {
    const result = await this.branches.merge({
      into: changeSet.baseRef,
      expected,
      head,
      // The title first: a last paragraph git could read as trailers is
      // refused, and this one reads as none.
      message: `${changeSet.title}\n\nMerge change set ${changeSet.id}.`,
      actor: { kind: actor.kind, id: actor.id },
      changeSetId: changeSet.id,
      approvedBy,
    });
    switch (result.kind) {
      case 'merged':
        return { commit: result.commit, fastForward: result.fastForward };
      case 'up-to-date': {
        // Merged already (a run that stopped before recording it).
        const found = await this.branches.mergedInto(
          changeSet.baseRef,
          head,
          changeSet.id,
        );
        return { commit: found?.commit ?? result.commit, fastForward: false };
      }
      case 'conflicts':
        throw mergeConflict(result.conflicts);
      case 'moved':
        return undefined;
    }
  }
}

/** 409 `merge-conflict`, the paths as data. */
export function mergeConflict(
  conflicts: readonly MergeConflictPath[],
): ConflictError {
  return new ConflictError(
    'merge-conflict',
    `The change set conflicts with its base in ${conflicts.length} file(s); it stays approved but unmerged. Return it for its author to resolve.`,
    {
      conflicts: conflicts.slice(0, MAX_CONFLICTS).map((c) => ({
        path: c.path,
        kinds: [...c.kinds],
      })),
      total: conflicts.length,
    },
  );
}
