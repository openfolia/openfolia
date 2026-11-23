import type { ChangeSetAuthor } from '../../change-sets/core/change-set.js';

/** Why the release a tag names was withdrawn (#138): who, when and why. */
export interface TagWithdrawal {
  readonly by: ChangeSetAuthor;
  readonly at: Date;
  readonly reason: string;
}

/**
 * Port: the tags of withdrawn releases (#138). A withdrawn release's tag
 * stays readable (tags are immutable), but it no longer counts as a
 * release where the newest one is looked for (`ReadableRefs.releases`),
 * and where it is read by tag it is marked withdrawn (#330).
 */
export abstract class WithdrawnReleases {
  /**
   * Every withdrawn release's withdrawal, by its tag's name (without
   * `refs/tags/`).
   */
  abstract withdrawals(): Promise<ReadonlyMap<string, TagWithdrawal>>;
}

/** No release is withdrawn: for content without a releases table (tests). */
export class NoWithdrawnReleases extends WithdrawnReleases {
  withdrawals(): Promise<ReadonlyMap<string, TagWithdrawal>> {
    return Promise.resolve(new Map());
  }
}
