import type {
  Manifest,
  Module,
  PageDesign,
  Term,
} from '@openfolia/content-model';
import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { AuditLog } from '../../../audit/core/audit-log.js';
import { UnprocessableError } from '../../../base/core/errors.js';
import { BOUNDED, UnitOfWork } from '../../../base/core/unit-of-work.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import type { ChangeSet } from '../change-set.js';
import { ChangeSetBranches } from '../change-set-branches.js';
import { ChangeSetStore } from '../change-set-store.js';
import { CommitIntents, type ConsumedCopy } from '../commit-intents.js';
import {
  type BranchChange,
  bySubjectKey,
  MAX_COMMIT_CHANGES,
  subjectPath,
} from '../commit.js';
import { CommitRecorder } from '../commit-recorder.js';
import { type LockSubject, subjectKey, subjectName } from '../lock.js';
import { checkedFile, configUsages, refuseUsages } from '../config-usage.js';
import { refuseTermUsages, termUsages } from '../term-usage.js';
import { designUsages, refuseDesignUsages } from '../design-usage.js';
import { LockStore } from '../lock-store.js';
import { opensAsAuthor } from '../own-work.js';
import {
  type CommitOutcome,
  distinct,
  keyOf,
  type SavePointPlan,
  SavePoints,
} from '../save-point.js';
import { recordPath } from '../module-rename.js';
import { checkCommittedScope } from '../subject-scope.js';
import { authorsChangeSet, sameBytes } from '../working-copy-rules.js';
import { WorkingCopyStore } from '../working-copy-store.js';

export interface RevertChangesInput {
  readonly actor: Actor;
  readonly changeSetId: string;
  /** The subjects (modules, manuals, terms, the configuration) to take out of the change set. */
  readonly subjects: readonly LockSubject[];
}

/** What taking changes out did. */
export interface RevertOutcome {
  readonly changeSetId: string;
  readonly branch: string;
  /** The commit made; undefined when only working copies were dropped. */
  readonly commit?: string;
  /** The branch head now. */
  readonly head: string;
  /** Subjects whose file was put back as it is at the base commit. */
  readonly restored: readonly LockSubject[];
  /** Subjects the change set created, deleted again. */
  readonly deleted: readonly LockSubject[];
  /** Subjects whose working copy was dropped. */
  readonly discarded: readonly LockSubject[];
}

/** What only a draft is (the `invalid-state` answer's end). */
const TAKEN_FROM = 'has changes taken out';

/**
 * Takes subjects (modules, manuals, terms, the configuration) back out of
 * a change set: one commit on its
 * branch, through the save-point path (`SavePoints`: an intent, then the
 * Git commit by compare-and-swap and its recording in one bounded
 * transaction), that puts each subject's file back as it is at the
 * change set's base commit, byte for byte (a subject the change set
 * created is deleted); its working copy is dropped and its lock released
 * in the same transaction, with a `change-set.revert` audit event (and the
 * commit's own: `change-set.commit`, one `<module|manual>.write` or
 * `.delete` per file, and one `lock.release` per lock, `data.reason`
 * `change-set.revert`). The configuration put back is checked as a saved
 * one is: 422 `config-in-use` while it would make what the head keeps
 * invalid (`configUsages`). A subject whose file is the same as at the base
 * and that has only a working copy makes no commit: the copy is dropped
 * and the lock released.
 *
 * Only the change set's author, only a draft (409 `invalid-state`), only
 * for subjects whose lock the change set holds (409 `lock-required`).
 * Scope is checked as for deleting the file at the branch head
 * (`checkCommittedScope`: one 403 whatever the reason) and, where the
 * base has the file, as for changing it there, so nothing is written back
 * that the author may not edit. A subject the change set does not change
 * (its file the same as at the base and no working copy) is 422
 * `not-changed`.
 *
 * A crash between the Git commit and the database leaves the commit
 * recorded later from its intent (`CommitRecorder.catchUp`), as for a
 * save point; its locks then stay, for the author to release.
 */
@Injectable()
export class RevertChangesAction extends ActorAction<
  RevertChangesInput,
  RevertOutcome
> {
  readonly policy = 'content.edit';
  private readonly savePoints: SavePoints;

  constructor(
    private readonly changeSets: ChangeSetStore,
    private readonly locks: LockStore,
    private readonly workingCopies: WorkingCopyStore,
    branches: ChangeSetBranches,
    recorder: CommitRecorder,
    intents: CommitIntents,
    private readonly openSnapshot: OpenSnapshotAction,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {
    super();
    this.savePoints = new SavePoints(
      changeSets,
      locks,
      workingCopies,
      branches,
      recorder,
      intents,
      openSnapshot,
      unit,
    );
  }

  protected async run(input: RevertChangesInput): Promise<RevertOutcome> {
    const subjects = distinct(input.subjects, 'subjects');
    if (subjects.length === 0) {
      throw new UnprocessableError(
        'nothing-to-revert',
        'Name at least one subject to take out.',
      );
    }
    if (subjects.length > MAX_COMMIT_CHANGES) {
      throw new UnprocessableError(
        'too-many-changes',
        `One commit changes at most ${MAX_COMMIT_CHANGES} files.`,
        { max: MAX_COMMIT_CHANGES },
      );
    }
    await authorsChangeSet(this.changeSets, input.actor, input.changeSetId);
    return this.savePoints.retrying(async () => {
      const { plan, discarded } = await this.preflight(
        input.actor,
        input.changeSetId,
        subjects,
      );
      const outcome = await this.savePoints.write(
        input.actor,
        plan,
        TAKEN_FROM,
        async (tx, { held, commit }) => {
          for (const lock of held) {
            await this.locks.remove(tx, lock.id);
            await this.auditLog.record(tx, input.actor, {
              action: 'lock.release',
              subject: subjectKey(lock.subject),
              data: {
                lockId: lock.id,
                changeSetId: input.changeSetId,
                reason: 'change-set.revert',
              },
            });
          }
          await this.auditLog.record(tx, input.actor, {
            action: 'change-set.revert',
            subject: { type: 'change-set', id: input.changeSetId },
            data: {
              commit: commit ?? null,
              subjects: subjects.map(keyOf).sort(),
              restored: plan.outcome.written.length,
              deleted: plan.outcome.deleted.length,
              ...(discarded.length > 0 && {
                workingCopies: discarded.length,
              }),
            },
          });
        },
      );
      return toRevertOutcome(outcome, discarded);
    });
  }

  /**
   * Everything but the write: the checks, what each subject's file goes
   * back to, and the commit's tree.
   */
  private async preflight(
    actor: Actor,
    changeSetId: string,
    subjects: readonly LockSubject[],
  ): Promise<{ plan: SavePointPlan; discarded: LockSubject[] }> {
    const { changeSet, head } = await this.savePoints.open(
      actor,
      changeSetId,
      TAKEN_FROM,
    );
    const copies = await this.unit.run(async (tx) => {
      // Checked here for an early answer; held again by the write step.
      await this.savePoints.holdLocks(tx, changeSetId, subjects);
      const saved = new Map(
        (await this.workingCopies.sizesOf(tx, changeSetId)).map((s) => [
          keyOf(s.subject),
          s,
        ]),
      );
      return subjects.flatMap((subject): ConsumedCopy[] => {
        const found = saved.get(keyOf(subject));
        return found
          ? [{ subject, version: found.version, createdAt: found.createdAt }]
          : [];
      });
    }, BOUNDED);
    const copied = new Set(copies.map((c) => keyOf(c.subject)));
    const base = await this.openBase(actor, changeSet);

    const changes: BranchChange[] = [];
    const restored: LockSubject[] = [];
    const deleted: LockSubject[] = [];
    for (const subject of subjects) {
      const path = subjectPath(subject);
      const [now, was] = await Promise.all([
        head.sourceForCheck(path),
        base.sourceForCheck(path),
      ]);
      // As for changing or deleting it at the head, and for changing it at
      // the base. One the change set deleted is checked at the base alone:
      // at the head nothing is left to scope it by. One at neither keeps the
      // head's rule for a missing file.
      if (now !== undefined || was === undefined) {
        await checkCommittedScope(actor, head, subject);
      }
      if (was !== undefined) await checkCommittedScope(actor, base, subject);
      // A module's translation record goes back with it (#287): a save
      // point deleting the module deleted the record too, and one writing
      // it (#51) described a text that may be taken out now.
      const record = await recordChange(head, base, subject);
      if (sameBytes(now, was) && !record) {
        if (!copied.has(keyOf(subject))) {
          throw new UnprocessableError(
            'not-changed',
            `This change set does not change ${keyOf(subject)}.`,
            { subject },
          );
        }
        continue;
      }
      if (record) changes.push(record);
      if (sameBytes(now, was)) {
        // Only its record changes; a module at neither stays absent.
        (was === undefined ? deleted : restored).push(subject);
      } else if (was === undefined) {
        changes.push({ path, delete: true });
        deleted.push(subject);
      } else {
        changes.push({ path, content: decodeSource(subject, was) });
        restored.push(subject);
      }
    }
    // A module's record is a file of its own.
    if (changes.length > MAX_COMMIT_CHANGES) {
      throw new UnprocessableError(
        'too-many-changes',
        `One commit changes at most ${MAX_COMMIT_CHANGES} files.`,
        { max: MAX_COMMIT_CHANGES },
      );
    }

    // What the head keeps must stay valid under the configuration the
    // revert leaves (#253): the base's, when the configuration goes back
    // too, else the head's, which a file put back may no longer fit.
    const headConfig = await head.config();
    const baseConfig = await base.config();
    const left = restored.some((s) => s.type === 'config')
      ? baseConfig
      : headConfig;
    const back = new Map<
      string,
      Module | Manifest | Term | PageDesign | null
    >();
    for (const subject of deleted) back.set(subjectName(subject), null);
    for (const subject of restored) {
      const file = checkedFile(
        subject,
        (await base.sourceForCheck(subjectPath(subject))) as Uint8Array,
      );
      // A file that does not parse is no content to keep valid.
      back.set(subjectName(subject), file ?? null);
    }
    refuseUsages(await configUsages(head, headConfig, left, back, baseConfig));
    // A term the change set added, taken out again, while modules link it
    // (#245): as for deleting a linked term.
    refuseTermUsages(
      await termUsages(
        head,
        new Set(deleted.flatMap((s) => (s.type === 'term' ? [s.termId] : []))),
        back,
      ),
    );
    // A design the change set added, taken out again, while the configuration or a manual
    // names it (#554): as for deleting a design in use.
    refuseDesignUsages(
      await designUsages(
        head,
        new Set(
          deleted.flatMap((s) => (s.type === 'design' ? [s.designId] : [])),
        ),
        back,
        left,
      ),
    );

    const outcome = {
      changeSetId,
      branch: changeSet.branch,
      parent: head.commit,
      written: restored.sort(bySubjectKey),
      deleted: deleted.sort(bySubjectKey),
      unchanged: [],
    };
    const message = revertMessage(subjects);
    const tree =
      changes.length > 0
        ? await this.savePoints.prepare(actor, changeSet, head, {
            changes,
            message,
          })
        : undefined;
    return {
      plan: {
        changeSet,
        head: head.commit,
        ...(tree !== undefined && { tree }),
        message,
        consumes: copies,
        locked: subjects,
        outcome,
      },
      discarded: copies.map((c) => c.subject).sort(bySubjectKey),
    };
  }

  /** The change set's base commit as the actor reads it (`openSides`). */
  private async openBase(
    actor: Actor,
    changeSet: ChangeSet,
  ): Promise<ReadableContent> {
    const base = await this.openSnapshot.handle({
      actor,
      ref: changeSet.baseCommit,
      ...(opensAsAuthor(actor, changeSet) && { authoredBase: true }),
    });
    if (base.commit !== changeSet.baseCommit) {
      throw new Error('A commit opened as another; refusing to read it.');
    }
    return base;
  }
}

function toRevertOutcome(
  outcome: CommitOutcome,
  discarded: readonly LockSubject[],
): RevertOutcome {
  return {
    changeSetId: outcome.changeSetId,
    branch: outcome.branch,
    ...(outcome.commit !== undefined && { commit: outcome.commit }),
    head: outcome.commit ?? outcome.parent,
    restored: outcome.written,
    deleted: outcome.deleted,
    discarded,
  };
}

/** The commit's message: what it takes out. */
function revertMessage(subjects: readonly LockSubject[]): string {
  if (subjects.length === 1) {
    const { type, id } = subjectKey(subjects[0] as LockSubject);
    return `Take ${type} ${id} out of the change set`;
  }
  return `Take ${subjects.length} files out of the change set`;
}

/** What puts a module's translation record back as at the base, if it differs at the head. */
async function recordChange(
  head: ReadableContent,
  base: ReadableContent,
  subject: LockSubject,
): Promise<BranchChange | undefined> {
  if (subject.type !== 'module') return undefined;
  const path = recordPath(subject.lang, subject.moduleId);
  const [now, was] = await Promise.all([
    head.sourceForCheck(path),
    base.sourceForCheck(path),
  ]);
  if (sameBytes(now, was)) return undefined;
  return was === undefined
    ? { path, delete: true }
    : { path, content: decodeSource(subject, was) };
}

/** The base's bytes as text, exactly: a byte-order mark kept, bad UTF-8 refused. */
function decodeSource(subject: LockSubject, bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }).decode(
      bytes,
    );
  } catch {
    throw new UnprocessableError(
      'not-restorable',
      `${keyOf(subject)} at the change set's base is not UTF-8 text.`,
      { subject },
    );
  }
}
