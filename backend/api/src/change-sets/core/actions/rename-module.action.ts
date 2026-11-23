import {
  ModuleId,
  type Module,
  namesModule,
  printManifest,
  printModule,
  renameManifestModule,
  renameModuleReferences,
  replacementNamesModule,
} from '@openfolia/content-model';
import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { AuditLog } from '../../../audit/core/audit-log.js';
import {
  ConflictError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import { BOUNDED, UnitOfWork } from '../../../base/core/unit-of-work.js';
import { CommentStore } from '../../../comments/core/comment-store.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import { TranslationJobs } from '../../../translations/core/translation-jobs.js';
import { ChangeSetBranches } from '../change-set-branches.js';
import { ChangeSetStore } from '../change-set-store.js';
import { CommitIntents } from '../commit-intents.js';
import {
  type BranchChange,
  bySubjectKey,
  MAX_COMMIT_CHANGES,
  subjectPath,
} from '../commit.js';
import { CommitRecorder } from '../commit-recorder.js';
import { type LockSubject, subjectKey } from '../lock.js';
import { LockStore } from '../lock-store.js';
import {
  moduleSubjects,
  recordPath,
  recordRewrites,
  rehash,
  rehashRecord,
  renameScope,
  type RenameScope,
  rewrittenModule,
  textOf,
} from '../module-rename.js';
import { keyOf, type SavePointPlan, SavePoints } from '../save-point.js';
import { authorsChangeSet } from '../working-copy-rules.js';
import { WorkingCopyStore } from '../working-copy-store.js';

export interface RenameModuleInput {
  readonly actor: Actor;
  readonly changeSetId: string;
  /** The module's ID now. */
  readonly from: string;
  /** Its new ID. */
  readonly to: string;
}

/** What a rename did. */
export interface ModuleRenameOutcome {
  readonly changeSetId: string;
  readonly branch: string;
  /** The rename's commit. */
  readonly commit: string;
  /** The branch head it was made on. */
  readonly parent: string;
  readonly message: string;
  readonly from: string;
  readonly to: string;
  /** The languages the module moved in. */
  readonly languages: readonly string[];
  /** The other modules (per language) and manuals rewritten to name the new ID. */
  readonly rewritten: readonly LockSubject[];
  /** How many of the change set's comments moved to the new ID. */
  readonly comments: number;
}

/** What only a draft is (the `invalid-state` answer's end). */
const RENAMED_IN = 'has modules renamed in it';

/**
 * Changes a module's ID (#265): one commit on the change set's branch,
 * through the save-point path (`SavePoints`: an intent, then the Git
 * commit by compare-and-swap and its recording in one bounded
 * transaction), that writes every language of the module under the new ID
 * (`modules/<lang>/<to>.adoc`, the file's bytes as they are unless it
 * names itself, and its translation record with it), deletes the old
 * files, and rewrites every module reference, cross-reference and
 * manifest entry naming the old ID at the branch head (`renameScope`; the
 * files are printed canonically). In the same transaction the change
 * set's comments on the old ID follow it (`CommentStore.moveModule`), with
 * a `module.rename` audit event per language (`data: { changeSetId,
 * commit, from, to, rewritten, comments }`, `rewritten` the number of
 * files rewritten, each named by the commit's own `module.write` event and
 * outbox row). A module deprecated in favour of the old ID (its
 * source-language `replacedBy`, #360) is one of those files: its
 * replacement names the new ID, so it is no `unknown-replacement`; the
 * module's own, when it names itself, follows it too.
 *
 * Only the change set's author, only a draft (409 `invalid-state`). It
 * needs the change set to hold the lock of the module under both IDs in
 * every language and of every file it rewrites, a translation record
 * (`recordRewrites`) by its module, #354 (409 `lock-required`,
 * `meta.subject`; the client takes them first, `GetModuleReferencesAction`
 * lists them). Refused: an ID that is no module ID or the same (422
 * `invalid-id`), a new ID that has a file (409 `id-taken`), a working copy
 * of any of those subjects (409 `uncommitted-working-copies`: commit or
 * discard it first, so nothing typed is lost or left naming the old ID), a
 * block of the module at a translation provider (409
 * `translation-at-provider`: its import would name the old ID), more than
 * `MAX_COMMIT_CHANGES` files (422 `too-many-changes`), and anything outside
 * the actor's scope (one 403, `renameScope`).
 *
 * Releases and tags keep the old ID: they are commits, never rewritten.
 * The old ID is not kept as an alias. A crash between the Git commit and
 * the database leaves it recorded later as a save point
 * (`CommitRecorder.catchUp`): the comments then stay on the old ID (shown
 * as orphaned) and no `module.rename` event is written.
 */
@Injectable()
export class RenameModuleAction extends ActorAction<
  RenameModuleInput,
  ModuleRenameOutcome
> {
  readonly policy = 'content.edit';
  private readonly savePoints: SavePoints;

  constructor(
    private readonly changeSets: ChangeSetStore,
    locks: LockStore,
    private readonly workingCopies: WorkingCopyStore,
    branches: ChangeSetBranches,
    recorder: CommitRecorder,
    intents: CommitIntents,
    openSnapshot: OpenSnapshotAction,
    private readonly comments: CommentStore,
    private readonly translationJobs: TranslationJobs,
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

  protected async run(input: RenameModuleInput): Promise<ModuleRenameOutcome> {
    const { actor, changeSetId, from, to } = input;
    checkIds(from, to);
    await authorsChangeSet(this.changeSets, actor, changeSetId);
    return this.savePoints.retrying(async () => {
      const { plan, scope, rewritten } = await this.preflight(input);
      let comments = 0;
      const outcome = await this.savePoints.write(
        actor,
        plan,
        RENAMED_IN,
        async (tx, { commit }) => {
          for (const lang of scope.files.keys()) {
            comments += await this.comments.moveModule(
              tx,
              changeSetId,
              { type: 'module', lang, moduleId: from },
              { type: 'module', lang, moduleId: to },
            );
          }
          for (const subject of moduleSubjects(scope, from)) {
            await this.auditLog.record(tx, actor, {
              action: 'module.rename',
              subject: subjectKey(subject),
              data: {
                changeSetId,
                commit: commit ?? null,
                from,
                to,
                rewritten: rewritten.length,
                comments,
              },
            });
          }
        },
      );
      return {
        changeSetId,
        branch: outcome.branch,
        commit: outcome.commit as string,
        parent: outcome.parent,
        message: outcome.message ?? plan.message,
        from,
        to,
        languages: [...scope.files.keys()].sort(),
        rewritten: scope.references.map((r) => r.subject),
        comments,
      };
    });
  }

  /**
   * Everything but the write: the checks, the new files and the commit's
   * tree, holding nothing past short reads.
   */
  private async preflight({
    actor,
    changeSetId,
    from,
    to,
  }: RenameModuleInput): Promise<{
    plan: SavePointPlan;
    scope: RenameScope;
    /** The files it rewrites, the translation records' modules included. */
    rewritten: readonly LockSubject[];
  }> {
    const { changeSet, head } = await this.savePoints.open(
      actor,
      changeSetId,
      RENAMED_IN,
    );
    const scope = await renameScope(actor, head, from, to);
    const moved = moduleSubjects(scope, from);
    const created = moduleSubjects(scope, to);
    // At least a write and a delete per language and a write per file
    // naming it: refused early here, counted exactly below.
    if (2 * moved.length + scope.references.length > MAX_COMMIT_CHANGES) {
      throw tooMany();
    }
    // The translation records of the modules naming it (#354): their
    // modules are locked, checked and refused with a working copy like the
    // files rewritten.
    const records = await recordRewrites(actor, head, scope, to);
    const rewritten = uniqueSubjects([
      ...scope.references.map((r) => r.subject),
      ...records.map((r) => r.subject),
    ]);
    const locked = [...moved, ...created, ...rewritten];
    await this.unit.run(async (tx) => {
      // Checked here for an early answer; held again by the write step.
      await this.savePoints.holdLocks(tx, changeSetId, locked);
      const keys = new Set(locked.map(keyOf));
      const copies = (await this.workingCopies.sizesOf(tx, changeSetId))
        .map((s) => s.subject)
        .filter((s) => keys.has(keyOf(s)));
      if (copies.length > 0) {
        throw new ConflictError(
          'uncommitted-working-copies',
          'Commit or discard the working copies of the module and the files naming it first.',
          { subjects: copies.sort(bySubjectKey) },
        );
      }
    }, BOUNDED);
    const atProvider = [
      ...new Set(
        (await this.translationJobs.unitsAtProvider({}))
          .filter((u) => u.moduleId === from)
          .map((u) => u.lang),
      ),
    ].sort();
    if (atProvider.length > 0) {
      throw new ConflictError(
        'translation-at-provider',
        'Blocks of the module are at a translation provider; import or cancel the job first.',
        { langs: atProvider },
      );
    }

    const { languages } = await head.config();
    // The module naming itself: its records move with it, their hashes
    // moved on as the references' records' are (`recordRewrites`).
    const source = scope.files.get(languages.source);
    const self =
      source !== undefined &&
      source !== 'unreadable' &&
      namesModule(source, from)
        ? rehash(source, renameModuleReferences(source, from, to))
        : undefined;
    /** Whether the module's file in `lang` names its old ID (a deprecation naming itself counts in the source language). */
    const namesItself = (lang: string, module: Module) =>
      namesModule(module, from) ||
      (lang === languages.source && replacementNamesModule(module, from));
    /** The record at `path` (of module `id` in `lang`) as text, its hashes moved on. */
    const recordText = async (path: string, lang: string, id: string) => {
      const text = await textOf(head, path);
      return self && lang !== languages.source && id === to
        ? rehashRecord(text, self)
        : text;
    };

    const changes: BranchChange[] = [];
    for (const [lang, module] of scope.files) {
      const path = subjectPath({ type: 'module', lang, moduleId: from });
      const text =
        module !== 'unreadable' && namesItself(lang, module)
          ? printModule({
              ...rewrittenModule(module, from, to, lang === languages.source),
              id: to,
            })
          : await textOf(head, path);
      changes.push(
        {
          path: subjectPath({ type: 'module', lang, moduleId: to }),
          content: text,
        },
        { path, delete: true },
      );
      const record = await head.sourceForCheck(recordPath(lang, from));
      if (record !== undefined) {
        changes.push(
          {
            path: recordPath(lang, to),
            content: await recordText(recordPath(lang, from), lang, to),
          },
          { path: recordPath(lang, from), delete: true },
        );
      } else if (
        (await head.sourceForCheck(recordPath(lang, to))) !== undefined
      ) {
        // A record left behind by a module once deleted at the new ID
        // (#287) would describe a translation it never had.
        changes.push({ path: recordPath(lang, to), delete: true });
      }
    }
    for (const reference of scope.references) {
      changes.push({
        path: subjectPath(reference.subject),
        content:
          'module' in reference
            ? printModule(
                rewrittenModule(reference.module, from, to, reference.replaces),
              )
            : printManifest(renameManifestModule(reference.manifest, from, to)),
      });
    }
    for (const record of records) {
      changes.push({ path: record.path, content: record.content });
    }
    if (changes.length > MAX_COMMIT_CHANGES) throw tooMany();

    const message = `Rename module ${from} to ${to}`;
    const tree = await this.savePoints.prepare(actor, changeSet, head, {
      changes,
      message,
    });
    return {
      scope,
      rewritten,
      plan: {
        changeSet,
        head: head.commit,
        tree,
        message,
        consumes: [],
        locked,
        outcome: {
          changeSetId,
          branch: changeSet.branch,
          parent: head.commit,
          written: [...created, ...rewritten].sort(bySubjectKey),
          deleted: moved,
          unchanged: [],
        },
      },
    };
  }
}

/** 422 `invalid-id` unless both are module IDs and differ. */
function checkIds(from: string, to: string): void {
  for (const [member, id] of [
    ['from', from],
    ['to', to],
  ] as const) {
    if (!ModuleId.safeParse(id).success) {
      throw new UnprocessableError(
        'invalid-id',
        `\`${member}\` is no module ID: a lowercase slug of at most 100 characters, e.g. "battery-charging".`,
        { member },
      );
    }
  }
  if (from === to) {
    throw new UnprocessableError(
      'invalid-id',
      'The new ID is the module’s ID already.',
      { member: 'to' },
    );
  }
}

function tooMany(): UnprocessableError {
  return new UnprocessableError(
    'too-many-changes',
    `One commit changes at most ${MAX_COMMIT_CHANGES} files; this rename would change more.`,
    { max: MAX_COMMIT_CHANGES },
  );
}

/** Subjects once each, in subject-key order. */
function uniqueSubjects(subjects: readonly LockSubject[]): LockSubject[] {
  const seen = new Map(subjects.map((s) => [keyOf(s), s]));
  return [...seen.values()].sort(bySubjectKey);
}
