import { Injectable } from '@nestjs/common';
import type { Actor } from '../../access/core/actor.js';
import { allows, ANYWHERE } from '../../access/core/allows.js';
import { UserDirectory } from '../../access/core/user-directory.js';
import { ConflictError } from '../../base/core/errors.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import {
  type Approval,
  pendingOf,
  REVIEW,
  type Requirement,
  typeOfSignOff,
} from './approval.js';
import {
  coversChanges,
  requirementsOf,
  type ReviewedChanges,
  signsOff,
} from './review-scope.js';

/**
 * Whether `approver`, as they are now, could still give `requirement` for
 * `changes`: the review needs `content.review` over all of it
 * (`coversChanges`), a sign-off `content.approve` over the restricted
 * type's changed modules (`signsOff`), exactly as approve and sign-off
 * check them. No approver (a user who is gone, a service) holds nothing.
 */
export function stillMeets(
  approver: Actor | undefined,
  requirement: Requirement,
  changes: ReviewedChanges,
): boolean {
  if (approver === undefined) return false;
  if (requirement === REVIEW) {
    return (
      allows(approver, 'content.review', ANYWHERE) &&
      coversChanges(approver, 'content.review', changes)
    );
  }
  const type = typeOfSignOff(requirement);
  return (
    type !== undefined &&
    allows(approver, 'content.approve', ANYWHERE) &&
    signsOff(approver, type, changes)
  );
}

/** Where a change set's review stands at one head, its approvers as they are now. */
export interface ReviewStanding {
  /** Every requirement of the change set, in order. */
  readonly required: readonly Requirement[];
  /** The ones no approval that still holds meets, in order. */
  readonly pending: readonly Requirement[];
  /** The approvals of the head whose approver still holds what they gave. */
  readonly holding: readonly Approval[];
  /**
   * The approvals of the head whose approver no longer does: their role
   * or scope changed since, or they are gone. They count for nothing.
   */
  readonly lapsed: readonly Approval[];
}

/**
 * The one place that decides where a change set's review stands
 * (`standing`): what it needs, and which approvals of a head still count.
 * An approval holds only while its approver, looked up again in the user
 * directory, still holds the permission and scope it took (L4: a role
 * removed after approving voids that approval). Approve, sign-off and
 * merge all ask it, so their answers agree.
 */
@Injectable()
export class ApprovalStanding {
  constructor(private readonly users: UserDirectory) {}

  /**
   * Where the review of `head` stands (approvers read in `tx`), from `approvals` (any heads; only
   * `head`'s count) and `changes` (read at that head). `current`, when
   * given, is the acting actor: their own approvals are judged by the
   * actor the request acts as, not looked up again.
   */
  async standing(
    tx: Transaction,
    changes: ReviewedChanges,
    approvals: readonly Approval[],
    head: string,
    current?: Actor,
  ): Promise<ReviewStanding> {
    const required = requirementsOf(changes);
    const ofHead = approvals.filter((a) => a.head === head);
    const approvers = await this.approversOf(tx, ofHead, current);
    const holding: Approval[] = [];
    const lapsed: Approval[] = [];
    for (const approval of ofHead) {
      const approver = approvers.get(keyOf(approval.approver));
      (stillMeets(approver, approval.requirement, changes)
        ? holding
        : lapsed
      ).push(approval);
    }
    return {
      required,
      pending: pendingOf(required, holding, head),
      holding,
      lapsed,
    };
  }

  /** Each distinct approver as they are now (undefined: no such user). */
  private async approversOf(
    tx: Transaction,
    approvals: readonly Approval[],
    current: Actor | undefined,
  ): Promise<Map<string, Actor | undefined>> {
    const found = new Map<string, Actor | undefined>();
    for (const { approver } of approvals) {
      const key = keyOf(approver);
      if (found.has(key)) continue;
      if (
        current?.kind === 'user' &&
        current.kind === approver.kind &&
        current.id === approver.id
      ) {
        found.set(key, current);
      } else {
        // Only users are in the directory: a service approver (none may
        // approve: `recordApproval` refuses them) holds nothing. A failing directory rejects:
        // never an approval counted on a guess.
        found.set(
          key,
          approver.kind === 'user'
            ? await this.users.findActor(approver.id, tx)
            : undefined,
        );
      }
    }
    return found;
  }
}

const keyOf = (approver: { kind: string; id: string }) =>
  `${approver.kind}/${approver.id}`;

/**
 * 409 for a change set that lacks approvals it needs: `approval-lapsed`
 * when an approval that would meet a pending requirement no longer holds
 * (its approver lost the role or scope, or was deactivated), else
 * `not-approved`. Both carry
 * `meta.pending`; `approval-lapsed` also `meta.lapsed`, who gave what.
 */
export function notApproved(standing: ReviewStanding): ConflictError {
  const lapsed = standing.lapsed.filter((a) =>
    standing.pending.includes(a.requirement),
  );
  if (lapsed.length > 0) {
    return new ConflictError(
      'approval-lapsed',
      'An approval the change set needs no longer holds: its approver lost the role or scope it took, or was deactivated. Return it to be reviewed again.',
      {
        pending: [...standing.pending],
        lapsed: lapsed.map((a) => ({
          requirement: a.requirement,
          approver: { kind: a.approver.kind, id: a.approver.id },
        })),
      },
    );
  }
  return new ConflictError(
    'not-approved',
    'The change set’s review head lacks approvals it needs.',
    { pending: [...standing.pending] },
  );
}
