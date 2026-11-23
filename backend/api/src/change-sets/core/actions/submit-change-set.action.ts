import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { ConflictError, ForbiddenError } from '../../../base/core/errors.js';
import {
  BOUNDED,
  runContended,
  UnitOfWork,
} from '../../../base/core/unit-of-work.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import type { ChangeSet } from '../change-set.js';
import { ChangeSetBranches } from '../change-set-branches.js';
import { ChangeSetStore } from '../change-set-store.js';
import { CommitRecorder } from '../commit-recorder.js';
import { coversChanges } from '../review-scope.js';
import { isActor } from '../own-work.js';
import { RefreshConflictStore } from '../refresh-conflicts.js';
import { refuseBranchRecords } from '../save-point.js';
import { Workflow } from '../workflow.js';
import { WorkingCopyStore } from '../working-copy-store.js';

export interface TransitionInput {
  readonly actor: Actor;
  readonly id: string;
  /** For the audit log. */
  readonly comment?: string;
}

/** The 403's detail when a non-author's edit scope does not cover the change set. */
export const SUBMIT_OUTSIDE_EDIT =
  'Only its author, or an editor whose roles cover everything it changes, submits a change set.';

/**
 * Submits a draft for review: `draft` → `in-review`, its branch's head
 * becoming the review head that approvals are of and a merge merges.
 * From then on it is frozen: no lock, save or save point until a reviewer
 * returns it (they take only drafts). Its locks are kept, so nobody else
 * changes its modules while it is reviewed, and a returned change set goes
 * on with them.
 *
 * Its author, or an editor (`content.edit`) whose scope covers everything
 * it changes (`coversChanges`; such an editor reads drafts, or the change
 * set would not be there for them). Refused while it has working copies
 * (409 `uncommitted-working-copies`: make a save point or discard them, so
 * what is reviewed is what is committed) and when it changes nothing (409
 * `no-changes`). A design or manifest an update from the base reported
 * conflicting, and the branch changed, must hold its base commit's
 * translation record in every language the submitter does not manage (422
 * `translation-record-protected`, `refuseBranchRecords`, #663): an update
 * that failed after its own save point landed leaves the base head's entry
 * there, which the merge would bring back after a manager withdrew it on
 * the base; update again first. A record a translation manager wrote
 * otherwise (the XLIFF import, `mark-current`) is not asked about. Save
 * points a crash left unrecorded are recorded first
 * (`CommitRecorder.catchUp`).
 */
@Injectable()
export class SubmitChangeSetAction extends ActorAction<
  TransitionInput,
  ChangeSet
> {
  readonly policy = 'content.edit';

  constructor(
    private readonly workflow: Workflow,
    private readonly store: ChangeSetStore,
    private readonly workingCopies: WorkingCopyStore,
    private readonly recorder: CommitRecorder,
    private readonly unit: UnitOfWork,
    private readonly openSnapshot: OpenSnapshotAction,
    private readonly branches: ChangeSetBranches,
    private readonly reported: RefreshConflictStore,
  ) {
    super();
  }

  protected run({ actor, id, comment }: TransitionInput): Promise<ChangeSet> {
    return runContended(
      this.unit,
      async (tx) => {
        const changeSet = await this.workflow.locked(tx, actor, id, 'submit');
        const head = await this.workflow.headOf(changeSet);
        if (
          !isActor(actor, changeSet.author) &&
          !coversChanges(
            actor,
            'content.edit',
            await this.workflow.changes(actor, changeSet, head),
          )
        ) {
          throw new ForbiddenError(SUBMIT_OUTSIDE_EDIT);
        }
        const copies = await this.workingCopies.countOf(tx, id);
        if (copies > 0) {
          throw new ConflictError(
            'uncommitted-working-copies',
            'The change set has working copies that are not committed: make a save point or discard them first.',
            { count: copies },
          );
        }
        if (head === changeSet.baseCommit) {
          throw new ConflictError(
            'no-changes',
            'The change set changes nothing yet.',
          );
        }
        // Only a subject an update reported conflicting can hold a base
        // head's entry (its own save point took it while resolving).
        const reported = (await this.reported.of(tx, id)).map((r) => r.subject);
        if (
          reported.length > 0 &&
          (await refuseBranchRecords(
            this.openSnapshot,
            this.branches,
            actor,
            changeSet,
            head,
            { only: reported, inTransaction: true },
          )) === 'moved'
        ) {
          throw new ConflictError(
            'branch-moved',
            'The change set’s branch moved while submitting it; try again.',
          );
        }
        await this.recorder.catchUp(tx, changeSet, head);
        const submitted = await this.store.transition(tx, id, {
          state: 'in-review',
          reviewHead: head,
        });
        await this.workflow.record(tx, actor, changeSet, {
          name: 'submit',
          from: changeSet.state,
          to: submitted.state,
          ...(comment !== undefined && { comment }),
          data: { head },
        });
        return submitted;
      },
      BOUNDED,
    );
  }
}
