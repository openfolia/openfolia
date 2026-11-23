import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { NotFoundError } from '../../../base/core/errors.js';
import { UnitOfWork } from '../../../base/core/unit-of-work.js';
import { ChangeSetStore } from '../change-set-store.js';
import { subjectIdForMessage } from '../commit.js';
import type { LockSubject } from '../lock.js';
import { authorsChangeSet, workingCopySubject } from '../working-copy-rules.js';
import { WorkingCopyStore } from '../working-copy-store.js';
import { RefreshConflictStore } from '../refresh-conflicts.js';

export interface DiscardWorkingCopyInput {
  readonly actor: Actor;
  readonly changeSetId: string;
  readonly subject: LockSubject;
}

/**
 * Discards the change set's working copy of a module or manual: what is
 * committed on the branch is left as it is. Only the change set's author;
 * no lock needed (discarding changes nothing others could see, and clears
 * up after a lock was broken). Not audited, like the saves it throws away.
 */
@Injectable()
export class DiscardWorkingCopyAction extends ActorAction<
  DiscardWorkingCopyInput,
  void
> {
  readonly policy = 'content.edit';

  constructor(
    private readonly changeSets: ChangeSetStore,
    private readonly workingCopies: WorkingCopyStore,
    private readonly unit: UnitOfWork,
    private readonly reported: RefreshConflictStore,
  ) {
    super();
  }

  protected async run({
    actor,
    changeSetId,
    subject: named,
  }: DiscardWorkingCopyInput): Promise<void> {
    const subject = workingCopySubject(named);
    await authorsChangeSet(this.changeSets, actor, changeSetId);
    const removed = await this.unit.run(async (tx) => {
      const gone = await this.workingCopies.remove(tx, changeSetId, subject);
      // What was saved since an update reported it is gone: it is no
      // resolution any more (#437).
      if (gone) await this.reported.markUnsaved(tx, changeSetId, subject);
      return gone;
    });
    if (!removed) {
      throw new NotFoundError(
        `No working copy of ${subject.type} "${subjectIdForMessage(subject)}" in change set ${changeSetId}.`,
      );
    }
  }
}
