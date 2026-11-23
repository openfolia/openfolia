import { Injectable } from '@nestjs/common';
import type { ChangeSet } from './change-set.js';
import { ChangeSetBranches } from './change-set-branches.js';

/**
 * Which change sets' branches are gone from the content repository
 * (deleted outside the API, or the repository restored or replaced): what
 * `GET /change-sets` and `GET /change-sets/:id` say in `meta.branchMissing`,
 * and the reconciler logs. It only reads refs; nothing is ever recreated
 * (#317: no silent recovery).
 */
@Injectable()
export class ChangeSetBranchPresence {
  constructor(private readonly branches: ChangeSetBranches) {}

  /** The IDs of those of `changeSets` whose branch is not there. */
  async missing(
    changeSets: readonly Pick<ChangeSet, 'id' | 'branch'>[],
  ): Promise<ReadonlySet<string>> {
    const [only, ...rest] = changeSets;
    if (only === undefined) return new Set();
    if (rest.length === 0) {
      return (await this.branches.head(only.branch)) === undefined
        ? new Set([only.id])
        : new Set();
    }
    const present = new Set((await this.branches.list()).map((b) => b.name));
    return new Set(
      changeSets.filter((c) => !present.has(c.branch)).map((c) => c.id),
    );
  }
}
