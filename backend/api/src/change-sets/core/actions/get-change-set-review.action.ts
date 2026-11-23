import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { UnitOfWork } from '../../../base/core/unit-of-work.js';
import { ApprovalStore } from '../approval-store.js';
import { isActor } from '../own-work.js';
import { REVIEW, type Requirement, typeOfSignOff } from '../approval.js';
import { ApprovalStanding } from '../approval-standing.js';
import { coversChanges, signsOff } from '../review-scope.js';
import { SelfApprovalRule } from '../self-approval.js';
import { Workflow } from '../workflow.js';
import type { ReviewOutcome } from './approve-change-set.action.js';
import { GetChangeSetAction } from './get-change-set.action.js';

/**
 * Where a change set's review stands, read only, asked of
 * `ApprovalStanding` exactly as approve, sign-off and merge ask it: every
 * approval it needs (its changes at its review head, else at its branch's
 * head while a draft), the approvals of that head, what is still pending
 * and the approvals that lapsed. `granted` is always empty: a read meets
 * nothing; `selfApproval` is the installation's rule now (#588); `yours` whether the reader counts as
 * its author (`Workflow.authorsOf`, #597). A reader whose `content.read.draft` scope does not cover every
 * change hears of the review and the sign-offs they may give only: the
 * others would name restricted types changed outside what they may see.
 *
 * Needs `content.read.draft`, as reviewing does (its commits are read by
 * ID). The change set is found exactly as `GetChangeSetAction` finds it: one
 * that names none is not found.
 */
@Injectable()
export class GetChangeSetReviewAction extends ActorAction<
  { actor: Actor; id: string },
  ReviewOutcome
> {
  readonly policy = 'content.read.draft';

  constructor(
    private readonly getChangeSet: GetChangeSetAction,
    private readonly workflow: Workflow,
    private readonly approvals: ApprovalStore,
    private readonly standing: ApprovalStanding,
    private readonly selfApproval: SelfApprovalRule,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected async run({
    actor,
    id,
  }: {
    actor: Actor;
    id: string;
  }): Promise<ReviewOutcome> {
    const changeSet = await this.getChangeSet.handle({ actor, id });
    const head =
      changeSet.reviewHead ?? (await this.workflow.headOf(changeSet));
    const changes = await this.workflow.changes(actor, changeSet, head);
    // Only whether the reader is one: who else wrote it is not told (#597).
    const yours = (await this.workflow.authorsOf(changeSet, head)).some((a) =>
      isActor(actor, a),
    );
    return this.unit.run(async (tx) => {
      const all = (await this.approvals.listOf(tx, id)).filter(
        (a) => a.head === head,
      );
      const { required, pending, lapsed } = await this.standing.standing(
        tx,
        changes,
        all,
        head,
        actor,
      );
      // The sign-offs come from every module the change set changes, read past the reader's
      // scope: one who does not see all of it learns of the review and the sign-offs they may
      // give alone, as the change set's changes list nothing outside their scope either.
      const covers = coversChanges(actor, 'content.read.draft', changes);
      const shown = (requirement: Requirement): boolean => {
        if (covers || requirement === REVIEW) return true;
        // A sign-off they may give themselves names only what they may see.
        const type = typeOfSignOff(requirement);
        return type !== undefined && signsOff(actor, type, changes);
      };
      return {
        changeSet,
        required: required.filter(shown),
        granted: [],
        pending: pending.filter(shown),
        approvals: all.filter((a) => shown(a.requirement)),
        lapsed: lapsed.filter((a) => shown(a.requirement)),
        selfApproval: await this.selfApproval.read(tx),
        yours,
      };
    });
  }
}
