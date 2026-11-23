import type { ChangeSetAuthor } from './change-set.js';

/**
 * What a change set in review needs before it is approved, one approval
 * each: `review` (a reviewer holding `content.review` over everything it
 * changes) always, and `sign-off/<type>` for every restricted module type
 * (`restricted: true` in the configuration) among the modules it changes,
 * from someone holding `content.approve` over every changed module of that
 * type. The configuration decides which types are restricted; none is
 * named in code.
 */
export type Requirement = 'review' | `sign-off/${string}`;

/** The review approval. */
export const REVIEW: Requirement = 'review';

/** The sign-off a restricted module type needs. */
export const signOff = (moduleType: string): Requirement =>
  `sign-off/${moduleType}`;

/** The module type a sign-off is for; undefined for the review. */
export function typeOfSignOff(requirement: Requirement): string | undefined {
  return requirement.startsWith('sign-off/')
    ? requirement.slice('sign-off/'.length)
    : undefined;
}

/** One approval of a change set's review head. */
export interface Approval {
  readonly changeSetId: string;
  readonly requirement: Requirement;
  readonly approver: ChangeSetAuthor;
  /** The commit approved: the change set's review head then. */
  readonly head: string;
  /**
   * Given by the change set's own author, as the installation's self-approval rule allowed when
   * it was given (#588). It stays when the rule changes later.
   */
  readonly self: boolean;
  readonly at: Date;
}

/**
 * The requirements in `required` no approval of `head` in `approvals`
 * meets yet, in order.
 */
export function pendingOf(
  required: readonly Requirement[],
  approvals: readonly Approval[],
  head: string,
): Requirement[] {
  return required.filter(
    (r) => !approvals.some((a) => a.requirement === r && a.head === head),
  );
}

/** The distinct approvers of `head` in `approvals`, ordered by kind and ID. */
export function approversOf(
  approvals: readonly Approval[],
  head: string,
): ChangeSetAuthor[] {
  const seen = new Map<string, ChangeSetAuthor>();
  for (const a of approvals) {
    if (a.head !== head) continue;
    seen.set(`${a.approver.kind}/${a.approver.id}`, {
      kind: a.approver.kind,
      id: a.approver.id,
    });
  }
  return [...seen]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, author]) => author);
}
