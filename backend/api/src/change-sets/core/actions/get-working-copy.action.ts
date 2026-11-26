import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { NotFoundError } from '../../../base/core/errors.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import { ChangeSetStore } from '../change-set-store.js';
import { subjectIdForMessage } from '../commit.js';
import { draftReadPermission } from '../own-work.js';
import type { LockSubject } from '../lock.js';
import { kindOf } from '../subject-kinds.js';
import type { WorkingCopyView } from '../working-copy.js';
import {
  authorsChangeSet,
  workingCopyIssues,
  workingCopySubject,
} from '../working-copy-rules.js';
import { WorkingCopyStore } from '../working-copy-store.js';

export interface GetWorkingCopyInput {
  readonly actor: Actor;
  readonly changeSetId: string;
  readonly subject: LockSubject;
}

/**
 * The change set's working copy of a module or manual, else the file
 * committed on its branch (version 0), with its validation issues. Only
 * for the change set's author, and only what their roles holding
 * `content.read.draft` may see (an author without it: their roles
 * holding `content.read`, #126, `draftReadPermission`): a working copy
 * outside that scope is not found, exactly like a missing one; the
 * committed file is read through `ReadableContent` (a manifest names only
 * the modules they may see). A manual's working copy is the author's own
 * text, returned as saved. Reading content needs `content.read`.
 */
@Injectable()
export class GetWorkingCopyAction extends ActorAction<
  GetWorkingCopyInput,
  WorkingCopyView
> {
  readonly policy = 'content.read';

  constructor(
    private readonly changeSets: ChangeSetStore,
    private readonly workingCopies: WorkingCopyStore,
    private readonly openSnapshot: OpenSnapshotAction,
  ) {
    super();
  }

  protected async run({
    actor,
    changeSetId,
    subject: named,
  }: GetWorkingCopyInput): Promise<WorkingCopyView> {
    const subject = workingCopySubject(named);
    const changeSet = await authorsChangeSet(
      this.changeSets,
      actor,
      changeSetId,
    );
    // The working copy first, then the branch: a save point moves the branch before it drops the
    // copies it committed, so what is gone here is on the branch opened after it (#935).
    const saved = await this.workingCopies.find(changeSetId, subject);
    const snapshot = await this.openSnapshot.handle({
      actor,
      ref: changeSet.branch,
      fresh: true,
    });
    const config = await snapshot.config();
    const notFound = () =>
      new NotFoundError(
        `No ${subject.type} "${subjectIdForMessage(subject)}" in change set ${changeSetId}.`,
      );
    const kind = kindOf(subject);
    if (saved) {
      const permission = draftReadPermission(actor);
      if (!kind.showsCopy(actor, permission, saved.content, config)) {
        throw notFound();
      }
      return {
        changeSetId,
        subject,
        content: saved.content,
        baseCommit: saved.baseCommit,
        version: saved.version,
        updatedBy: saved.updatedBy,
        updatedAt: saved.updatedAt,
        issues: workingCopyIssues(subject, saved.content, config),
      };
    }
    const committed = await kind.committed(snapshot, subject, config);
    if (!committed) throw notFound();
    return {
      changeSetId,
      subject,
      content: committed.content,
      baseCommit: snapshot.commit,
      version: 0,
      issues: committed.issues,
    };
  }
}
