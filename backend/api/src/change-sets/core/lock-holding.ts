import { Injectable } from '@nestjs/common';
import type { Transaction } from '../../base/core/unit-of-work.js';
import type { ChangeSet, ChangeSetState } from './change-set.js';
import { ChangeSetBranches } from './change-set-branches.js';
import { ChangeSetStore } from './change-set-store.js';
import { type LockSubject, subjectName } from './lock.js';
import { recordPath } from './module-rename.js';
import { subjectOfPath } from './subject-kinds.js';
import { WorkingCopyStore } from './working-copy-store.js';

/** The change set holding a lock, as a refusal of the lock names it (`lockedMeta`). */
export interface HoldingChangeSet {
  readonly title: string;
  readonly state: ChangeSetState;
  /** It has changes to the locked subject: a working copy, or commits since its base. */
  readonly hasChanges: boolean;
}

/** Where a change set's branch stood when its changes to a subject were read. */
export interface CommittedChanges {
  /** The branch's head then; undefined when the branch is gone. */
  readonly head: string | undefined;
  readonly changed: boolean;
}

/**
 * What a change set holding a lock has done with its subject, for the
 * holder deciding whether to release it from another change set (#472):
 * a working copy of it (Postgres), or commits changing its file (or a
 * module's translation record) between the change set's base commit and
 * its branch's head (Git). Read from the store and Git each time, never
 * kept.
 */
@Injectable()
export class LockHolding {
  constructor(
    private readonly changeSets: ChangeSetStore,
    private readonly workingCopies: WorkingCopyStore,
    private readonly branches: ChangeSetBranches,
  ) {}

  /** The change set `changeSetId`, as a refusal of its lock names it; undefined when it is gone. */
  async describe(
    changeSetId: string,
    subject: LockSubject,
  ): Promise<HoldingChangeSet | undefined> {
    const changeSet = await this.changeSets.find(changeSetId);
    if (!changeSet) return undefined;
    // One after the other: a save point moves the branch before it drops the copy (#935).
    const copy = await this.workingCopies.find(changeSetId, subject);
    const committed = await this.committed(changeSet, subject);
    return {
      title: changeSet.title,
      state: changeSet.state,
      hasChanges: copy !== undefined || committed.changed,
    };
  }

  /**
   * Whether `changeSet`'s branch changes `subject` since its base commit,
   * and the head that was read. A branch that cannot be compared (gone,
   * or its base unknown to Git) counts as changing it: nothing is released
   * on a guess.
   */
  async committed(
    changeSet: ChangeSet,
    subject: LockSubject,
  ): Promise<CommittedChanges> {
    const head = await this.branches
      .head(changeSet.branch)
      .catch(() => undefined);
    if (head === undefined) return { head, changed: true };
    if (head === changeSet.baseCommit) return { head, changed: false };
    try {
      const paths = await this.branches.changedPaths(
        changeSet.baseCommit,
        head,
      );
      return { head, changed: paths.some((p) => touches(p.path, subject)) };
    } catch {
      return { head, changed: true };
    }
  }

  /** The working copy of `subject` in the change set exists, read inside `tx`. */
  async hasWorkingCopy(
    tx: Transaction,
    changeSetId: string,
    subject: LockSubject,
  ): Promise<boolean> {
    return (
      (await this.workingCopies.get(tx, changeSetId, subject)) !== undefined
    );
  }

  /** Where the change set's branch points now (undefined: gone). */
  head(changeSet: ChangeSet): Promise<string | undefined> {
    return this.branches.head(changeSet.branch);
  }
}

/** Whether the file at `path` belongs to `subject`: its own file, or a module's translation record. */
function touches(path: string, subject: LockSubject): boolean {
  const of = subjectOfPath(path);
  if (of !== undefined && subjectName(of) === subjectName(subject)) return true;
  return (
    subject.type === 'module' &&
    path === recordPath(subject.lang, subject.moduleId)
  );
}
