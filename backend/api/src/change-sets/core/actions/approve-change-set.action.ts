import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { ConflictError, ForbiddenError } from '../../../base/core/errors.js';
import {
  runContended,
  type Transaction,
  UnitOfWork,
  BOUNDED,
} from '../../../base/core/unit-of-work.js';
import { type Approval, REVIEW, type Requirement } from '../approval.js';
import { ApprovalStanding } from '../approval-standing.js';
import { ApprovalStore } from '../approval-store.js';
import type { ChangeSet } from '../change-set.js';
import { ChangeSetStore } from '../change-set-store.js';
import {
  coversChanges,
  requirementsOf,
  type ReviewedChanges,
} from '../review-scope.js';
import { SelfApprovalRule, type SelfApproval } from '../self-approval.js';
import {
  AUTHOR_READS,
  type AuthorsAt,
  headMoved,
  readAuthors,
  Workflow,
} from '../workflow.js';
import { REVIEW_OUTSIDE_SCOPE } from './return-change-set.action.js';
import type { TransitionInput } from './submit-change-set.action.js';

/** What an approval or sign-off did. */
export interface ReviewOutcome {
  readonly changeSet: ChangeSet;
  /** Every requirement of the change set, in order. */
  readonly required: readonly Requirement[];
  /** The ones this call met. */
  readonly granted: readonly Requirement[];
  /** The ones still unmet; empty once it is approved. */
  readonly pending: readonly Requirement[];
  /** The approvals of its review head, oldest first. */
  readonly approvals: readonly Approval[];
  /**
   * Those of them that no longer hold (their approver lost the role or
   * scope they took): they count for nothing (`ApprovalStanding`).
   */
  readonly lapsed: readonly Approval[];
  /**
   * The installation's self-approval rule now (#588): whether its author may approve or sign off
   * their own change set.
   */
  readonly selfApproval: SelfApproval;
  /**
   * Whether the actor asking counts as its author (#597: its recorded author, or a writer of a
   * commit it holds, carried ones included): four eyes and the self-approval rule apply to them.
   */
  readonly yours: boolean;
}

/**
 * Records an approval of the change set's review head, by `actor`, of the
 * requirements `grant` picks from what it needs; moves it to `approved`
 * once nothing is pending. Shared by approve and sign-off.
 */
export async function recordApproval(
  deps: {
    readonly workflow: Workflow;
    readonly store: ChangeSetStore;
    readonly approvals: ApprovalStore;
    readonly standing: ApprovalStanding;
    readonly selfApproval: SelfApprovalRule;
    readonly unit: UnitOfWork;
  },
  { actor, id, comment }: TransitionInput,
  name: 'approve' | 'sign-off',
  grant: (
    actor: Actor,
    required: readonly Requirement[],
    changes: ReviewedChanges,
  ) => Requirement[],
): Promise<ReviewOutcome> {
  // Approving is a person's judgement: a service account's approval would
  // never hold (`ApprovalStanding` re-checks only users), so it is refused
  // before anything is written, whatever its roles.
  if (actor.kind !== 'user') {
    throw new ForbiddenError(
      `Only a person may ${name === 'approve' ? 'approve' : 'sign off'} a change set, never a service account.`,
    );
  }
  const { workflow, store, approvals, standing, selfApproval, unit } = deps;
  for (let reads = 1; ; reads++) {
    // Everyone who wrote what is approved (#597), read before the row is held.
    const read = await workflow.authorsBefore(actor, id, name);
    const outcome = await attempt(read);
    if (!('stale' in outcome)) return outcome;
    if (reads >= AUTHOR_READS) {
      throw new Error(
        `Change set ${id} kept moving while its authors were read.`,
      );
    }
  }

  async function attempt(
    read: AuthorsAt | undefined,
  ): Promise<ReviewOutcome | { stale: true }> {
    const outcome = await runContended(
      unit,
      async (
        tx: Transaction,
      ): Promise<
        ReviewOutcome | { moved: [string, string] } | { stale: true }
      > => {
        const changeSet = await workflow.locked(tx, actor, id, name);
        // The rule as it is when the approval is given: one given under it stays when it changes.
        const rule = await selfApproval.read(tx);
        const reviewHead = changeSet.reviewHead;
        if (reviewHead === undefined) {
          throw new Error(
            `Change set ${id} is in review without a review head.`,
          );
        }
        const authors = readAuthors(read, reviewHead);
        if (authors === undefined) return { stale: true };
        const self = workflow.ownApproval(actor, authors, name, rule);
        // The scope first: only someone who could approve it may bounce it.
        const changes = await workflow.changes(actor, changeSet, reviewHead);
        const required = requirementsOf(changes);
        const granted = grant(actor, required, changes);
        const head = await workflow.headOf(changeSet);
        if (head !== reviewHead) {
          // Pushed to outside the API: what was submitted is not what is
          // there. No approval of it holds; back to its author.
          await workflow.returnToDraft(tx, actor, changeSet, {
            data: { reason: 'head-moved', branchHead: head },
          });
          return { moved: [reviewHead, head] };
        }
        const added: Requirement[] = [];
        for (const requirement of granted) {
          const fresh = await approvals.add(tx, {
            changeSetId: id,
            requirement,
            approver: { kind: actor.kind, id: actor.id },
            head: reviewHead,
            self,
          });
          if (fresh) added.push(requirement);
        }
        if (added.length === 0) {
          throw new ConflictError(
            'already-approved',
            'You have approved what you may of this change set already.',
            { granted },
          );
        }
        const all = (await approvals.listOf(tx, id)).filter(
          (a) => a.head === reviewHead,
        );
        // Only approvals whose approver still holds what they gave count.
        const { pending, lapsed } = await standing.standing(
          tx,
          changes,
          all,
          reviewHead,
          actor,
        );
        const after =
          pending.length === 0
            ? await store.transition(tx, id, { state: 'approved' })
            : changeSet;
        await workflow.record(tx, actor, changeSet, {
          name,
          from: changeSet.state,
          to: after.state,
          ...(comment !== undefined && { comment }),
          data: {
            head: reviewHead,
            requirements: added,
            pending,
            ...(self && { self: true }),
            ...(lapsed.length > 0 && {
              lapsed: lapsed.map(
                (a) => `${a.requirement} ${a.approver.kind}/${a.approver.id}`,
              ),
            }),
          },
        });
        return {
          changeSet: after,
          required,
          granted: added,
          pending,
          approvals: all,
          lapsed,
          selfApproval: rule,
          yours: self,
        };
      },
      BOUNDED,
    );
    if ('moved' in outcome) throw headMoved(...outcome.moved);
    return outcome;
  }
}

/**
 * Approves a change set in review: the review approval (`review`), from a
 * reviewer (`content.review`) whose scope covers everything it changes
 * (`coversChanges`), never its own author (four eyes; anyone who wrote a
 * commit it holds counts: `Workflow.authorsOf`, #597) unless the
 * installation's self-approval rule lets them (#588: then recorded, and
 * audited, with `self: true`). It becomes
 * `approved` once every requirement is met: the review, and a sign-off
 * (`SignOffChangeSetAction`) for each restricted module type it changes;
 * until then it stays `in-review` with the approval recorded.
 *
 * Approvals are of its review head. A branch that has moved from it
 * (something pushed outside the API) holds no approval: the change set is
 * returned to draft, and the answer is 409 `head-moved`. A reviewer who
 * approved already is 409 `already-approved`.
 */
@Injectable()
export class ApproveChangeSetAction extends ActorAction<
  TransitionInput,
  ReviewOutcome
> {
  readonly policy = 'content.review';

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
      'approve',
      (actor, _required, changes) => {
        if (!coversChanges(actor, 'content.review', changes)) {
          throw new ForbiddenError(REVIEW_OUTSIDE_SCOPE);
        }
        return [REVIEW];
      },
    );
  }
}
