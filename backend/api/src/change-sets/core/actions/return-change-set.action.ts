import { Injectable } from '@nestjs/common';
import { ActorAction } from '../../../access/core/policy.js';
import { ForbiddenError } from '../../../base/core/errors.js';
import {
  BOUNDED,
  runContended,
  UnitOfWork,
} from '../../../base/core/unit-of-work.js';
import type { ChangeSet } from '../change-set.js';
import { coversChanges } from '../review-scope.js';
import {
  AUTHOR_READS,
  type AuthorsAt,
  mergedMeanwhile,
  readAuthors,
  Workflow,
} from '../workflow.js';
import type { TransitionInput } from './submit-change-set.action.js';

/** The 403's detail when the reviewer's scope does not cover the change set. */
export const REVIEW_OUTSIDE_SCOPE =
  'Your roles do not cover everything the change set changes.';

/**
 * Returns a change set in review (or approved but not merged, say after a
 * merge conflict) to its author: → `draft`, with changes requested in the
 * comment. Its review head is cleared and its approvals removed (the audit
 * log keeps them); its locks stay, so the author goes on with them.
 *
 * A reviewer (`content.review`) whose scope covers everything it changes,
 * never its own author (four eyes), nor anyone who wrote a commit it holds
 * (`Workflow.authorsOf`, #597).
 */
@Injectable()
export class ReturnChangeSetAction extends ActorAction<
  TransitionInput,
  ChangeSet
> {
  readonly policy = 'content.review';

  constructor(
    private readonly workflow: Workflow,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected async run({
    actor,
    id,
    comment,
  }: TransitionInput): Promise<ChangeSet> {
    for (let reads = 1; ; reads++) {
      // Everyone who wrote it (#597), read before the row is held.
      const read = await this.workflow.authorsBefore(actor, id, 'return');
      const outcome = await this.attempt(actor, id, comment, read);
      if (outcome !== 'stale') return outcome;
      if (reads >= AUTHOR_READS) {
        throw new Error(
          `Change set ${id} kept moving while its authors were read.`,
        );
      }
    }
  }

  private async attempt(
    actor: TransitionInput['actor'],
    id: string,
    comment: string | undefined,
    read: AuthorsAt | undefined,
  ): Promise<ChangeSet | 'stale'> {
    const outcome = await runContended(
      this.unit,
      async (tx) => {
        const changeSet = await this.workflow.locked(tx, actor, id, 'return');
        // What was submitted is what the reviewer answers for; a branch
        // moved since is returned all the same.
        const reviewed =
          changeSet.reviewHead ?? (await this.workflow.headOf(changeSet));
        // Nobody who wrote it returns it (#597).
        const authors = readAuthors(read, reviewed);
        if (authors === undefined) return { stale: true as const };
        this.workflow.notTheAuthor(actor, authors);
        const changes = await this.workflow.changes(actor, changeSet, reviewed);
        if (!coversChanges(actor, 'content.review', changes)) {
          throw new ForbiddenError(REVIEW_OUTSIDE_SCOPE);
        }
        // A merge that landed but was never recorded is recorded, not lost.
        if (await this.workflow.landedMerge(tx, changeSet)) {
          return { merged: true as const };
        }
        return this.workflow.returnToDraft(tx, actor, changeSet, {
          ...(comment !== undefined && { comment }),
        });
      },
      BOUNDED,
    );
    if ('stale' in outcome) return 'stale';
    if ('merged' in outcome) throw mergedMeanwhile();
    return outcome;
  }
}
