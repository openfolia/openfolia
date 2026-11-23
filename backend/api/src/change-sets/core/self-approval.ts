import type { Transaction } from '../../base/core/unit-of-work.js';

/**
 * Who may approve their own change set (#588), an installation setting:
 *
 * - `never` (the default): four eyes; its author neither approves nor signs it off;
 * - `review`: its author may give the review approval, but a restricted type's sign-off still
 *   needs someone else;
 * - `review-and-sign-off`: its author may give both.
 *
 * Scope and permissions are unchanged: the author still needs `content.review` (and
 * `content.approve` for a sign-off) over everything the change set touches. An author never
 * returns their own change set, whatever the setting.
 */
export const SELF_APPROVAL = [
  'never',
  'review',
  'review-and-sign-off',
] as const;
export type SelfApproval = (typeof SELF_APPROVAL)[number];

/** Four eyes: what an installation that set nothing has. */
export const DEFAULT_SELF_APPROVAL: SelfApproval = 'never';

/**
 * Whether `rule` lets a change set's author give `name` (approve: the review approval; sign-off:
 * a restricted type's sign-off).
 */
export function allowsSelf(
  rule: SelfApproval,
  name: 'approve' | 'sign-off',
): boolean {
  return name === 'approve'
    ? rule === 'review' || rule === 'review-and-sign-off'
    : rule === 'review-and-sign-off';
}

/**
 * Port: the installation's self-approval rule now (the `settings` component keeps it in
 * Postgres). Read inside the approval's own transaction, when the approval is given: an approval
 * recorded under it stays when the rule changes later.
 */
export abstract class SelfApprovalRule {
  abstract read(tx?: Transaction): Promise<SelfApproval>;
}
