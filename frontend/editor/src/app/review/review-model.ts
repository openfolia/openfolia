import type { ApiError, Schema } from '../api';
import type { PermissionState } from '../permissions/permissions';

export type ChangeSet = Schema<'ChangeSetResource'>;
export type ChangeSetState = Schema<'ChangeSetAttributes'>['state'];
export type ReviewMeta = Schema<'ReviewMeta'>;
export type ChangeSetChange = Schema<'ChangeSetChangeResource'>;

/** The workflow's transitions the review screen offers, as the API names their routes. */
export type TransitionName =
  'submit' | 'return' | 'approve' | 'sign-off' | 'merge';

/** Which change sets the list shows: a state the API filters by. */
export type ReviewFilter = 'in-review' | 'approved' | 'draft';

export const REVIEW_FILTERS: readonly ReviewFilter[] = [
  'in-review',
  'approved',
  'draft',
];

/** The filter's label (the segmented control) and the page title while it is chosen. */
export const FILTER_LABELS: Readonly<Record<ReviewFilter, string>> = {
  'in-review': 'editor.review.filters.inReview',
  approved: 'editor.review.filters.approved',
  draft: 'editor.review.filters.draft',
};

export const FILTER_TITLES: Readonly<Record<ReviewFilter, string>> = {
  'in-review': 'editor.review.titles.inReview',
  approved: 'editor.review.titles.approved',
  draft: 'editor.review.titles.draft',
};

/** The person acting, as far as the review needs them. */
export interface Reviewer {
  readonly id: string;
  readonly kind: string;
  readonly permissions: ReadonlySet<string>;
}

/** Who may approve their own change set, the installation's rule (`meta.review.selfApproval`). */
export type SelfApproval = ReviewMeta['selfApproval'];

/**
 * Whether the installation's rule lets a change set's author give `name` themselves (#588):
 * the review with `review` or `review-and-sign-off`, a sign-off only with `review-and-sign-off`.
 */
export function allowsSelf(
  rule: SelfApproval | undefined,
  name: 'approve' | 'sign-off',
): boolean {
  return name === 'approve'
    ? rule === 'review' || rule === 'review-and-sign-off'
    : rule === 'review-and-sign-off';
}

/**
 * Whether `me` may approve their own change set now: its author, in review, under a rule that
 * lets them give the review or a sign-off. The panel says four eyes is off then.
 */
export function selfApprovalOpen(
  me: Reviewer,
  changeSet: ChangeSet,
  review: ReviewMeta | null,
): boolean {
  return (
    changeSet.attributes.state === 'in-review' &&
    countsAsAuthor(me, changeSet, review) &&
    allowsSelf(review?.selfApproval, 'approve')
  );
}

/**
 * Whether `me` started the change set: they never return it, and review or sign it off only as
 * the installation's self-approval rule allows (#588).
 */
export function isAuthor(me: Reviewer, changeSet: ChangeSet): boolean {
  const author = changeSet.attributes.author;
  return author.kind === me.kind && author.id === me.id;
}

/**
 * Whether four eyes treats `me` as the change set's author (#597): they started it, or the API
 * says they wrote a commit it holds (`meta.review.yours`: a fix of theirs carried forward by
 * someone else, say). The API decides in the end; this keeps the screen from offering it.
 */
export function countsAsAuthor(
  me: Reviewer,
  changeSet: ChangeSet,
  review: ReviewMeta | null,
): boolean {
  return isAuthor(me, changeSet) || review?.yours === true;
}

/**
 * Whether the change set's base was rewritten past the commit it started from (#471, as
 * `GET /change-sets/{id}` says it): it can be neither updated nor merged, only moved.
 */
export function isRewritten(changeSet: ChangeSet): boolean {
  return changeSet.meta?.base?.state === 'rewritten';
}

/** The module type a sign-off requirement is for; undefined for the review. */
export function signOffType(requirement: string): string | undefined {
  return requirement.startsWith('sign-off/')
    ? requirement.slice('sign-off/'.length)
    : undefined;
}

const hidden: PermissionState = { kind: 'hidden' };
const enabled: PermissionState = { kind: 'enabled' };
const blocked = (reason: string): PermissionState => ({
  kind: 'disabled',
  reason,
});

/**
 * What each transition button does for `me` on `changeSet` now: hidden when their role can never
 * do it or the change set's state does not take it, disabled with the reason (a key) when it is
 * blocked now. The API decides in the end (the scope of a role, a moved head); this only keeps
 * the screen from offering what cannot work.
 */
export function transitionStates(
  me: Reviewer,
  changeSet: ChangeSet,
  review: ReviewMeta | null,
  comment: string,
  busy: boolean,
): Readonly<Record<TransitionName, PermissionState>> {
  const state = changeSet.attributes.state;
  const own = countsAsAuthor(me, changeSet, review);
  const can = (permission: string) => me.permissions.has(permission);
  const wait = (s: PermissionState): PermissionState =>
    busy && s.kind === 'enabled' ? blocked('editor.review.blocked.busy') : s;
  const pending = review?.pending ?? [];
  const signOffs = (review?.required ?? []).filter((r) => signOffType(r));
  const rule = review?.selfApproval;

  // Its author, or an editor over all of it (the API checks the scope).
  const submit = state === 'draft' && can('content.edit') ? enabled : hidden;

  let ret: PermissionState = hidden;
  if (
    (state === 'in-review' || state === 'approved') &&
    can('content.review')
  ) {
    ret = own
      ? blocked('editor.review.blocked.own')
      : comment.trim() === ''
        ? blocked('editor.review.blocked.commentRequired')
        : enabled;
  }

  let approve: PermissionState = hidden;
  if (state === 'in-review' && can('content.review')) {
    approve =
      own && !allowsSelf(rule, 'approve')
        ? blocked('editor.review.blocked.own')
        : review && !pending.includes('review')
          ? blocked('editor.review.blocked.reviewed')
          : enabled;
  }

  let signOff: PermissionState = hidden;
  if (state === 'in-review' && can('content.approve') && signOffs.length > 0) {
    signOff =
      own && !allowsSelf(rule, 'sign-off')
        ? blocked(
            allowsSelf(rule, 'approve')
              ? 'editor.review.blocked.ownSignOff'
              : 'editor.review.blocked.own',
          )
        : signOffs.some((r) => pending.includes(r))
          ? enabled
          : blocked('editor.review.blocked.signedOff');
  }

  // A base rewritten past where it started (#471): what would be merged is not what was reviewed.
  const merge =
    state === 'approved' && can('release.publish')
      ? isRewritten(changeSet)
        ? blocked('editor.changeSet.rewritten.mergeBlocked')
        : enabled
      : hidden;

  return {
    submit: wait(submit),
    return: wait(ret),
    approve: wait(approve),
    'sign-off': wait(signOff),
    merge: wait(merge),
  };
}

/**
 * The change set and its review as they will be once `name` went through, shown at once while
 * the API is asked (eager): rolled back if it refuses.
 */
export function expectedAfter(
  name: TransitionName,
  me: Reviewer,
  changeSet: ChangeSet,
  review: ReviewMeta | null,
): { changeSet: ChangeSet; review: ReviewMeta | null } {
  const withState = (state: ChangeSetState): ChangeSet => ({
    ...changeSet,
    attributes: { ...changeSet.attributes, state },
  });
  const head = changeSet.attributes.reviewHead ?? '';
  const self = countsAsAuthor(me, changeSet, review);
  const grant = (met: readonly string[]): ReviewMeta | null => {
    if (!review) return null;
    const granted = met.filter((r) => review.pending.includes(r));
    const at = new Date().toISOString();
    return {
      ...review,
      granted,
      pending: review.pending.filter((r) => !granted.includes(r)),
      selfApproved: review.selfApproved || (self && granted.length > 0),
      approvals: [
        ...review.approvals,
        ...granted.map((requirement) => ({
          requirement,
          approver: {
            kind:
              me.kind === 'service' ? ('service' as const) : ('user' as const),
            id: me.id,
          },
          head,
          self,
          at,
        })),
      ],
    };
  };
  switch (name) {
    case 'submit':
      return { changeSet: withState('in-review'), review };
    case 'return':
      return {
        changeSet: withState('draft'),
        review: review && {
          ...review,
          granted: [],
          pending: review.required,
          approvals: [],
          lapsed: [],
          selfApproved: false,
        },
      };
    case 'approve':
    case 'sign-off': {
      const after = grant(
        name === 'approve'
          ? ['review']
          : (review?.pending.filter((r) => signOffType(r)) ?? []),
      );
      return {
        changeSet:
          after && after.pending.length === 0
            ? withState('approved')
            : changeSet,
        review: after,
      };
    }
    case 'merge':
      return { changeSet: withState('merged'), review };
  }
}

/** The summary under a change set's title, from what the list knows. */
export interface ChangeSummary {
  readonly modules: number;
  readonly manuals: number;
  readonly languages: readonly string[];
}

export function summaryOf(changes: readonly ChangeSetChange[]): ChangeSummary {
  const languages = new Set<string>();
  let modules = 0;
  let manuals = 0;
  for (const c of changes) {
    const s = c.attributes.subject;
    if (s.type === 'module') {
      modules++;
      languages.add(s.lang);
    } else manuals++;
  }
  return { modules, manuals, languages: [...languages].sort() };
}

/** Codes of refusals that trying again can get past (contention, a timeout, a moved base). */
const RETRYABLE_CODES = new Set([
  'lock-contended',
  'base-moved',
  'database-timeout',
]);

/** A failed write that trying again can help with: offered a Retry. */
export const retryableFailure = (failure: ApiError): boolean =>
  failure.kind === 'unavailable' ||
  failure.kind === 'network' ||
  RETRYABLE_CODES.has(failure.code);
