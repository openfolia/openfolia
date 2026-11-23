/**
 * Port: maintenance lines' branches in the content repository. A branch
 * is only ever created here, at an exact commit ("must not exist"), and
 * only under the name `CCMS_MAINTENANCE_BRANCH` gives; after that it moves
 * only by merges of change sets (`ChangeSetBranches.merge`) and is never
 * deleted.
 */
export abstract class MaintenanceBranches {
  /**
   * The branch of the line maintaining `revision` of `product` by the
   * configured pattern. Throws `UnprocessableError`
   * (`invalid-maintenance-branch`) when they cannot be part of one.
   */
  abstract nameOf(product: string, revision: string): string;

  /**
   * Creates the branch `name` at `commit` (compare-and-swap: it must not
   * exist). `existed` when it exists already at exactly `commit` (an
   * earlier attempt made it); throws `ConflictError` (`branch-exists`)
   * when it exists elsewhere or clashes with another branch or tag (the
   * same name in another case, or one a folder of the other).
   */
  abstract create(name: string, commit: string): Promise<'created' | 'existed'>;

  /** Where the branch `name` points; undefined when there is none. */
  abstract head(name: string): Promise<string | undefined>;
}
