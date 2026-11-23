/**
 * Port: what changed in the content repository between two commits, for
 * incremental syncs (`filter[changedSince]`). Commits are full IDs; the
 * adapter reads Git and never moves anything.
 */
export abstract class ContentChanges {
  /**
   * Whether the commit `since` is `commit` or in its history. False when
   * `since` names no commit of the repository.
   */
  abstract contains(commit: string, since: string): Promise<boolean>;

  /** The repository paths that differ between the commits `from` and `to`, deleted ones included. */
  abstract changedPaths(from: string, to: string): Promise<string[]>;
}
