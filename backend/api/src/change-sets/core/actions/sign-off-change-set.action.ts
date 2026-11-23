import { Injectable } from '@nestjs/common';
import { ActorAction } from '../../../access/core/policy.js';
import { ConflictError, ForbiddenError } from '../../../base/core/errors.js';
import { UnitOfWork } from '../../../base/core/unit-of-work.js';
import { typeOfSignOff } from '../approval.js';
import { ApprovalStanding } from '../approval-standing.js';
import { ApprovalStore } from '../approval-store.js';
import { ChangeSetStore } from '../change-set-store.js';
import { signsOff } from '../review-scope.js';
import { SelfApprovalRule } from '../self-approval.js';
import { Workflow } from '../workflow.js';
import {
  recordApproval,
  type ReviewOutcome,
} from './approve-change-set.action.js';
import type { TransitionInput } from './submit-change-set.action.js';

/** The 403's detail when an approver covers none of the sign-offs needed. */
export const SIGN_OFF_OUTSIDE_SCOPE =
  'Your roles do not cover the changed modules of any restricted type this change set needs signed off.';

/**
 * Signs off a change set in review, for each restricted module type it
 * changes whose changed modules all lie within the approver's
 * `content.approve` scope (`signsOff`): the extra approval those types need
 * on top of the review. Never by its own author (four eyes), unless the
 * installation's self-approval rule is `review-and-sign-off` (#588). 409
 * `no-sign-off-needed` when it changes no module of a restricted type; 403
 * when the approver covers none of those it does. Otherwise as approve.
 */
@Injectable()
export class SignOffChangeSetAction extends ActorAction<
  TransitionInput,
  ReviewOutcome
> {
  readonly policy = 'content.approve';

  constructor(
    private readonly workflow: Workflow,
    private readonly store: ChangeSetStore,
    private readonly approvals: ApprovalStore,
    private readonly standing: ApprovalStanding,
    private readonly selfApproval: SelfApprovalRule,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected run(input: TransitionInput): Promise<ReviewOutcome> {
    return recordApproval(
      {
        workflow: this.workflow,
        store: this.store,
        approvals: this.approvals,
        standing: this.standing,
        selfApproval: this.selfApproval,
        unit: this.unit,
      },
      input,
      'sign-off',
      (actor, required, changes) => {
        const needed = required.filter((r) => typeOfSignOff(r) !== undefined);
        if (needed.length === 0) {
          throw new ConflictError(
            'no-sign-off-needed',
            'The change set changes no module of a restricted type.',
          );
        }
        const covered = needed.filter((r) =>
          signsOff(actor, typeOfSignOff(r) as string, changes),
        );
        if (covered.length === 0)
          throw new ForbiddenError(SIGN_OFF_OUTSIDE_SCOPE);
        return covered;
      },
    );
  }
}
