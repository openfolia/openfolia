import { Injectable } from '@nestjs/common';
import type { Actor } from '../../access/core/actor.js';
import { ReadableRefs } from '../../content/core/readable-refs.js';
import { type ChangeSet, OPEN_STATES } from './change-set.js';
import { ChangeSetBranches } from './change-set-branches.js';

/** Where an open change set stands against its base branch (`ChangeSetBehind.of`). */
export interface BaseStanding {
  /**
   * `current`: the base still holds the commit the change set started
   * from; `rewritten`: it does not (its history was rewritten, a
   * force-push or a restore), so it can neither be updated nor merged.
   */
  readonly base: 'current' | 'rewritten';
  /** The commits the base's head has that the branch lacks; null when rewritten. */
  readonly behind: number | null;
}

/**
 * Whether the base branch's history no longer holds the commit the change
 * set started from (#471): its head is not that commit and has not it as an
 * ancestor. What it changes is counted from that commit, so an update or a
 * merge would bring in something else.
 */
export async function baseRewritten(
  branches: Pick<ChangeSetBranches, 'contains'>,
  changeSet: Pick<ChangeSet, 'baseRef' | 'baseCommit'>,
  baseHead: string,
): Promise<boolean> {
  return (
    baseHead !== changeSet.baseCommit &&
    !(await branches.contains(changeSet.baseRef, changeSet.baseCommit))
  );
}

/**
 * How far an open change set's branch is behind its base branch (#22):
 * the commits the base's head has that the branch does not, what
 * `GET /change-sets/:id` says in `meta.behind` (counted up to
 * `MAX_BEHIND`), and whether the base was rewritten past its base commit
 * (`meta.base`, #471: no count then). Read only.
 */
@Injectable()
export class ChangeSetBehind {
  constructor(
    private readonly branches: ChangeSetBranches,
    private readonly refs: ReadableRefs,
  ) {}

  /**
   * The standing; undefined for a change set no longer open, or when its
   * branch or its base is gone, or the base is a draft `actor` may not
   * read (nothing is told about it then).
   */
  async of(
    actor: Actor,
    changeSet: ChangeSet,
  ): Promise<BaseStanding | undefined> {
    if (!OPEN_STATES.includes(changeSet.state)) return undefined;
    const [base, head] = await Promise.all([
      this.refs.branch(actor, changeSet.baseRef),
      this.branches.head(changeSet.branch),
    ]);
    if (!base || head === undefined) return undefined;
    if (await baseRewritten(this.branches, changeSet, base.commit)) {
      return { base: 'rewritten', behind: null };
    }
    return {
      base: 'current',
      behind: await this.branches.behind(head, base.commit),
    };
  }
}
