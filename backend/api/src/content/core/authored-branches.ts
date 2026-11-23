import type { Actor } from '../../access/core/actor.js';

/**
 * Port: the draft branches an actor authors (a change set's branch, whose
 * author they are). Authors always see their own work (#126): such a
 * branch opens for its author by name even without `content.read.draft`
 * (`OpenSnapshotAction`), read through their `content.read` scope as any
 * released ref is. Nothing else opens that way: no other branch, no
 * commit by its ID, no other author's branch.
 */
export abstract class AuthoredBranches {
  /** Whether the branch named exactly `branch` is one `actor` authors. */
  abstract authoredBy(actor: Actor, branch: string): Promise<boolean>;

  /**
   * Whether `branch` is exactly the branch of a change set `actor` may see
   * (as `GET /change-sets/:id` finds it for them: a holder of
   * `content.read.draft` sees every one, anyone else their own), in any
   * state. Asked only once a ref did not resolve, so a read at a change
   * set's branch that is gone can say so (`ChangeSetBranchMissingError`)
   * to whoever may know of that change set, and to nobody else.
   */
  abstract visibleChangeSet(actor: Actor, branch: string): Promise<boolean>;
}
