import { subjectFileReferences } from '../../../assets/core/file-references.js';
import { AssetUploads } from '../../../assets/core/asset-uploads.js';
import { ReadableAssets } from '../../../assets/core/readable-assets.js';
import type { ProjectConfig } from '@openfolia/content-model';
import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import {
  ConflictError,
  NotFoundError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import { UnitOfWork } from '../../../base/core/unit-of-work.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import { ChangeSetBranches } from '../change-set-branches.js';
import { ChangeSetStore } from '../change-set-store.js';
import { readsChangeSets } from '../own-work.js';
import type { LockSubject } from '../lock.js';
import { LockStore } from '../lock-store.js';
import { RefreshConflictStore } from '../refresh-conflicts.js';
import {
  MAX_WORKING_COPIES_PER_CHANGE_SET,
  MAX_WORKING_COPY_BYTES,
  type TemplateFileContent,
  type WorkingCopyContent,
  type WorkingCopyView,
  workingCopyBytes,
} from '../working-copy.js';
import {
  authorsChangeSet,
  fileUnchangedSince,
  type OwnBranch,
  staleWorkingCopy,
  workingCopyIssues,
  workingCopySubject,
} from '../working-copy-rules.js';
import { WorkingCopyStore } from '../working-copy-store.js';
import { configUsages, refuseUsages } from '../config-usage.js';
import { workingCopyFilePlaces } from '../file-scope.js';
import {
  checkSubject,
  kindOf,
  refuseFolderClash,
  refuseTemplatePastCaps,
} from '../subject-kinds.js';
import { LOCKING_STATES } from './acquire-lock.action.js';
import { Sandbox } from '../../../sandbox/core/sandbox.js';
import { changeSetRecordBases, keyOf } from '../save-point.js';
import {
  holdsRecord,
  type RecordHolder,
  refuseRecordChange,
} from '../translation-records.js';

export interface SaveWorkingCopyInput {
  readonly actor: Actor;
  readonly changeSetId: string;
  readonly subject: LockSubject;
  /** What the subject's kind holds (`SUBJECT_KINDS`): shape checked. */
  readonly content: WorkingCopyContent;
  /** The version this save is based on: 0 for none saved yet. */
  readonly version: number;
  /**
   * The commit the content is based on: the `baseCommit` last read or
   * saved (for a subject not on the branch yet, the change set's). Left
   * out, the branch head at the first save, kept by later ones.
   */
  readonly baseCommit?: string;
}

/**
 * Autosave: stores the editor's content of a module or manual as the
 * change set's working copy, in Postgres. No commit, no audit event (the
 * commit at a save point is audited); the content's validation issues come
 * back without refusing it, since a draft may be incomplete.
 *
 * Only the change set's author, while it is a draft, and only while the
 * change set holds the subject's lock (409 `lock-required`), which this
 * keeps from being released until the save is written. `version` must be
 * the working copy's current one (409 `version-conflict` with the current
 * in `meta.version` otherwise): a stale save never overwrites a newer one.
 *
 * Files (#335): an image or attachment block may name only a file the
 * actor may read (`ReadableAssets`, `workingCopyFilePlaces`): one a module
 * they may see on the change set's branch or at its base uses, or one
 * uploaded into a change set they are the author of. Any other hash is
 * 422 `unknown-asset`, whether or not it is stored, and the blob store is
 * not asked; one being deleted as unused meanwhile is 409
 * `asset-deleted` (once deleted, it is `unknown-asset` like any other).
 *
 * Scope (403, one answer whatever the reason, so nothing is learnt of
 * what the actor may not see; the subject kind's `checkChange`, e.g.
 * `checkModuleScope`, `checkManualScope`, `checkConfigChange`,
 * `checkTermChange`):
 * the new content and the committed file (looked up past the reading
 * filter) must be editable and readable by the actor; a subject with no
 * committed file (or a broken one) only for an actor who edits and reads
 * all of its language (a module) or every audience (a manual).
 *
 * Translation records (#663): a page design's or manifest's `translations`
 * changes only in the languages the actor manages the translation of
 * (`refuseRecordChange`: 422 `translation-record-protected` otherwise);
 * anyone else keeps it as the branch has it, or as the change set's base
 * has it.
 *
 * A save marks the subject's conflict, if an update from the base reported
 * one (`RefreshConflictStore`), as saved since: "Update again" may then
 * keep the change set's version of the file (#437).
 */
@Injectable()
export class SaveWorkingCopyAction extends ActorAction<
  SaveWorkingCopyInput,
  WorkingCopyView
> {
  readonly policy = 'content.edit';

  constructor(
    private readonly changeSets: ChangeSetStore,
    private readonly locks: LockStore,
    private readonly workingCopies: WorkingCopyStore,
    private readonly openSnapshot: OpenSnapshotAction,
    private readonly branches: ChangeSetBranches,
    private readonly unit: UnitOfWork,
    private readonly assets: AssetUploads,
    private readonly readable: ReadableAssets,
    private readonly reported: RefreshConflictStore,
    private readonly sandbox: Sandbox = Sandbox.OFF,
  ) {
    super();
  }

  protected async run({
    actor,
    changeSetId,
    subject: named,
    content,
    version,
    baseCommit: requested,
  }: SaveWorkingCopyInput): Promise<WorkingCopyView> {
    const subject = workingCopySubject(named);
    // A template is code the renderer runs: a public sandbox (#826) keeps the demo's.
    if (subject.type === 'template') this.sandbox.refuse('templates');
    checkSubject(subject, content);
    const bytes = workingCopyBytes(content);
    if (bytes > MAX_WORKING_COPY_BYTES) {
      throw new UnprocessableError(
        'too-large',
        `A working copy holds at most ${MAX_WORKING_COPY_BYTES} bytes of JSON.`,
        { max: MAX_WORKING_COPY_BYTES },
      );
    }
    this.sandbox.checkBytes(bytes);
    this.sandbox.spend(bytes);
    const changeSet = await authorsChangeSet(
      this.changeSets,
      actor,
      changeSetId,
    );
    // Git is read before the transaction, so no row stays locked meanwhile.
    const snapshot = await this.openSnapshot.handle({
      actor,
      ref: changeSet.branch,
    });
    const config = await snapshot.config();
    await kindOf(subject).checkChange(actor, snapshot, subject, content);
    // The template's folder at the branch, for the caps checked below (#803). Read before the
    // transaction, as all of Git here: a save point moving the branch meanwhile may leave the
    // count a commit behind. Reading stays safe then: every read checks the caps again against
    // the commit it reads (`designTemplate`), and a folder past them is the template's error.
    const templateListing =
      subject.type === 'template'
        ? await snapshot.designTemplateListing(subject.templateId)
        : undefined;
    if (subject.type === 'template') await refuseFolderClash(snapshot, subject);
    if (subject.type === 'config') {
      // What it would make invalid at the head: refused now, as an eager
      // editor needs to know, and again at the save point.
      refuseUsages(
        await configUsages(snapshot, config, content as ProjectConfig),
      );
    }
    const issues = workingCopyIssues(subject, content, config);
    const stored =
      version > 0
        ? (await this.workingCopies.find(changeSetId, subject))?.baseCommit
        : undefined;
    const baseCommit = await this.baseFor(
      actor,
      snapshot,
      subject,
      requested,
      stored,
      // Only for an actor without content.read.draft.
      readsChangeSets(actor)
        ? undefined
        : { branches: this.branches, changeSet },
    );
    // A design's or manifest's translation record only as its manager may write it (#663):
    // checked once the content's base is known, so a stale copy is 409 first. The save point
    // checks it again (`SavePoints.prepare`).
    if (holdsRecord(subject)) {
      await refuseRecordChange(actor, subject, content as RecordHolder, {
        head: snapshot,
        // Resolving a conflict an update from the base reported on it: the
        // base branch's head now, which that update merges in.
        bases: async () =>
          changeSetRecordBases(
            this.openSnapshot,
            actor,
            changeSet,
            (
              await this.unit.run((tx) => this.reported.of(tx, changeSetId))
            ).some((r) => keyOf(r.subject) === keyOf(subject))
              ? [`refs/heads/${changeSet.baseRef}`]
              : [],
          ),
      });
    }
    // The files its image and attachment blocks name (at most
    // `MAX_FILES_PER_WORKING_COPY`, else 422): only files the actor may
    // read (422 `unknown-asset` for any other, stored or not: #335), then
    // checked against deletions below.
    const files = subjectFileReferences(subject.type, content);
    await this.readable.refuseUnreadable(
      actor,
      files,
      workingCopyFilePlaces(this.openSnapshot, actor, changeSet, snapshot),
    );
    // A first save of a module or manual with no file on the branch makes one: a public
    // sandbox (#826) counts it against its cap (once saved; a refused save counts nothing).
    const made =
      version === 0 &&
      (subject.type === 'module' || subject.type === 'manual') &&
      this.sandbox.on &&
      !(await kindOf(subject).exists(snapshot, subject))
        ? subject.type === 'module'
          ? 'modules'
          : 'manuals'
        : undefined;
    const save = () =>
      this.unit.run(async (tx) => {
        // Locked to the end: it cannot be abandoned (which drops its working
        // copies) while this is written.
        const current = await this.changeSets.lock(tx, changeSetId);
        if (!current)
          throw new NotFoundError(`No change set "${changeSetId}".`);
        if (!LOCKING_STATES.includes(current.state)) {
          throw new ConflictError(
            'invalid-state',
            `The change set is ${current.state}; only a draft is edited.`,
            { state: current.state },
          );
        }
        // Under each named file's lock, which deleting an unused file takes:
        // a file marked deleted is never named by a new save (#255).
        await this.assets.lockHashes(tx, files);
        const deleted = await this.assets.deletedAmong(tx, files);
        if (deleted.length > 0) {
          throw new ConflictError(
            'asset-deleted',
            'The working copy names a file that was deleted as unused; upload it again.',
            { assets: deleted.map((hash) => `sha256:${hash}`) },
          );
        }
        const lock = await this.locks.hold(tx, subject);
        if (lock?.changeSetId !== changeSetId) {
          throw new ConflictError(
            'lock-required',
            'Take the lock on it for this change set first.',
          );
        }
        // The base was chosen against the copy read above: one replaced since
        // at the same version (discarded and saved again) is a conflict too.
        if (version > 0) {
          const now = await this.workingCopies.get(tx, changeSetId, subject);
          if (now?.version === version && now.baseCommit !== stored) {
            throw new ConflictError(
              'version-conflict',
              'The working copy was replaced meanwhile; read it again.',
              { version },
            );
          }
        }
        // Counted under the change set's row lock: saves of one change set
        // run one after the other.
        if (
          version === 0 &&
          (await this.workingCopies.countOf(tx, changeSetId)) >=
            MAX_WORKING_COPIES_PER_CHANGE_SET
        ) {
          throw new ConflictError(
            'too-many-working-copies',
            `A change set holds at most ${MAX_WORKING_COPIES_PER_CHANGE_SET} working copies; commit or discard some first.`,
            { max: MAX_WORKING_COPIES_PER_CHANGE_SET },
          );
        }
        // The template's folder within the caps once saved (#803): counted under the change set's
        // row lock, as the copies, so two saves never both take it past them.
        if (subject.type === 'template' && templateListing) {
          refuseTemplatePastCaps(
            templateListing,
            await this.workingCopies.sizesOf(tx, changeSetId),
            subject,
            (content as TemplateFileContent).text,
          );
        }
        const result = await this.workingCopies.save(
          tx,
          {
            changeSetId,
            subject,
            content,
            baseCommit,
            updatedBy: { kind: actor.kind, id: actor.id },
          },
          version,
        );
        if ('conflict' in result) {
          throw new ConflictError(
            'version-conflict',
            result.conflict === 0
              ? `There is no saved working copy (version ${version} was given); save it as version 0.`
              : `The working copy is at version ${result.conflict}, not ${version}; read it again.`,
            { version: result.conflict },
          );
        }
        // Saved after an update reported it conflicting: "Update again" may
        // keep it now (#437).
        await this.reported.markSaved(tx, changeSetId, subject);
        return result;
      });
    const saved =
      made === undefined
        ? await save()
        : await this.sandbox.counted(made, save);
    return {
      changeSetId,
      subject,
      content: saved.content,
      baseCommit: saved.baseCommit,
      version: saved.version,
      updatedBy: saved.updatedBy,
      updatedAt: saved.updatedAt,
      issues,
    };
  }

  /**
   * The commit to store as the content's base. The client names the one
   * it based its content on (`requested`): the stored base, or the branch
   * head, is kept as it is; an older commit is accepted when the subject's
   * file has not changed since (the head is stored then), else the save is
   * 409 `stale-working-copy`, so content edited on an old file never
   * silently replaces a newer one. Without `requested`, the stored base
   * (or for a first save, the head).
   */
  private async baseFor(
    actor: Actor,
    head: ReadableContent,
    subject: LockSubject,
    requested: string | undefined,
    stored: string | undefined,
    own: OwnBranch | undefined,
  ): Promise<string> {
    if (requested === undefined) return stored ?? head.commit;
    if (requested === stored || requested === head.commit) return requested;
    if (
      await fileUnchangedSince(
        this.openSnapshot,
        actor,
        head,
        requested,
        subject,
        own,
      )
    ) {
      return head.commit;
    }
    throw staleWorkingCopy([subject], head.commit);
  }
}
