import { NotFoundError } from '../../base/core/errors.js';

/**
 * A read at a change set's branch (`?ref=change-sets/<id>`) whose branch
 * is gone from the content repository (deleted outside the API, or the
 * repository restored or replaced), told to a reader who may see that
 * change set (`AuthoredBranches.visibleChangeSet`). Still a 404, and
 * still a `NotFoundError` to every caller that catches one; anyone else
 * gets the generic `not-found`, so it tells nobody a change set exists
 * they could not see anyway.
 */
export class ChangeSetBranchMissingError extends NotFoundError {
  override readonly code = 'change-set-branch-missing';

  constructor(readonly branch: string) {
    super(
      `The branch ${branch} of this change set is missing from the content repository.`,
      { branch },
    );
  }
}
