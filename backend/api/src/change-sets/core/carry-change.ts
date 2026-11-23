import {
  parseConfig,
  parseManifest,
  parseModule,
  parseTerm,
  parsePageDesign,
} from '@openfolia/content-model';
import { Injectable } from '@nestjs/common';
import type { Actor } from '../../access/core/actor.js';
import { subjectFileReferences } from '../../assets/core/file-references.js';
import {
  ReadableAssets,
  type UsagePlace,
} from '../../assets/core/readable-assets.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from '../../base/core/errors.js';
import { type Transaction, UnitOfWork } from '../../base/core/unit-of-work.js';
import { OpenSnapshotAction } from '../../content/core/actions/open-snapshot.action.js';
import type { ChangeSet } from './change-set.js';
import { ChangeSetBranches } from './change-set-branches.js';
import { writersOf } from './change-set-authors.js';
import { diffBlocks } from './change-set-diff.js';
import { ChangeSetStore } from './change-set-store.js';
import { CommitIntents } from './commit-intents.js';
import { CommitRecorder } from './commit-recorder.js';
import {
  type BranchChange,
  bySubjectKey,
  MAX_COMMIT_CHANGES,
  subjectOfPath,
} from './commit.js';
import { workingCopyFilePlaces } from './file-scope.js';
import type { LockSubject } from './lock.js';
import { LockStore } from './lock-store.js';
import { changedPathsWithin } from './review-scope.js';
import { Moved, changeSetRecordBases, SavePoints } from './save-point.js';
import {
  holdsRecord,
  type RecordHolder,
  type RecordSides,
  once,
  refusedRecordLanguages,
} from './translation-records.js';
import { kindOf } from './subject-kinds.js';
import {
  TEMPLATE_FILE_SCHEMA_VERSION,
  type WorkingCopyContent,
} from './working-copy.js';
import { WorkingCopyStore } from './working-copy-store.js';
import { AcquireLockAction } from './actions/acquire-lock.action.js';

/** A path of the change that was not carried: left as it is where it was applied. */
export interface CarryConflict {
  readonly path: string;
  /** The module, manual, configuration or term it is the file of. */
  readonly subject?: LockSubject;
  /**
   * Why: git's conflict kinds (`contents`, `modify/delete`, …), `locked`
   * (another change set holds its lock), `forbidden` (the actor may not
   * change it there), `unsupported` (no module, manual, configuration
   * or term: a template, an image in the old layout), `binary`,
   * `too-many-locks`, `invalid` (no such file, or a module naming more
   * than `MAX_FILES_PER_WORKING_COPY` files), `unknown-asset` (a module
   * naming a file the actor may not use, #335), `translation-record` (a
   * design's or manifest's translation record the actor may not write
   * there, #663).
   */
  readonly kinds: readonly string[];
  /**
   * For a module, the blocks the carried change set changed in it (added,
   * changed or removed), where it can tell: what to apply by hand.
   */
  readonly blockIds?: readonly string[];
}

/** A change set's own diff applied three-way onto another commit, not yet written. */
export interface CarryPlan {
  /** The files that applied cleanly: their text, or null for a deletion. */
  readonly files: Map<string, string | null>;
  /** What did not apply, by path (so far: git's conflicts, non-subjects, non-text). */
  readonly conflicts: Map<string, CarryConflict>;
}

/** What `CarryChange.apply` wrote. */
export interface CarryOutcome {
  /** The commit holding what applied; undefined when nothing did. */
  readonly commit?: string;
  /** The subjects changed by that commit, in subject-key order. */
  readonly applied: readonly LockSubject[];
  /** What did not apply, by path, modules with their blocks. */
  readonly conflicts: readonly CarryConflict[];
}

/** More of the save point's write step, in its transaction, once it is known what applied. */
export type AfterCarry = (
  tx: Transaction,
  done: {
    readonly commit?: string;
    readonly applied: number;
    readonly conflicts: number;
  },
) => Promise<void>;

/**
 * Carries a change set's own diff (`from` its base commit `to` a head of
 * it) onto another commit, as the first save point of a new draft change
 * set started there: what carrying a fix forward (#60) and moving a change
 * set onto a rewritten base (#471) share.
 *
 * - **`plan`:** the diff applied three-way onto `onto`
 *   (`ChangeSetBranches.applyChange`, no rename detection), only the
 *   paths the change set changed (git names others too, which may be
 *   content the actor may not see); a file that is no subject is
 *   `unsupported`, a non-text one `binary`.
 * - **`apply`:** each subject it touches is locked for the new change set
 *   (`AcquireLockAction`, with its scope rules there: `locked`,
 *   `too-many-locks`, `forbidden`), the merged content checked as a save
 *   checks it (`forbidden`, `invalid`, `unknown-asset`), then what is left
 *   is committed as one save point (`SavePoints.write`: intent, the commit
 *   by compare-and-swap and its record), `after` in its transaction, naming
 *   who wrote the carried change set (`writersOf`: its author and the writers
 *   of its commits) in `Carried-author` trailers, so they stay its authors
 *   for four eyes where it lands (#597). What
 *   did not apply stays as it is there, listed with the blocks the change
 *   set changed in each module (as the actor reads its two sides); the
 *   locks taken stay, so the author applies those by hand in the editor.
 */
@Injectable()
export class CarryChange {
  private readonly savePoints: SavePoints;

  constructor(
    private readonly branches: ChangeSetBranches,
    private readonly acquireLock: AcquireLockAction,
    private readonly openSnapshot: OpenSnapshotAction,
    private readonly readable: ReadableAssets,
    store: ChangeSetStore,
    locks: LockStore,
    workingCopies: WorkingCopyStore,
    recorder: CommitRecorder,
    intents: CommitIntents,
    unit: UnitOfWork,
  ) {
    this.savePoints = new SavePoints(
      store,
      locks,
      workingCopies,
      branches,
      recorder,
      intents,
      openSnapshot,
      unit,
    );
  }

  /**
   * The change from `from` to `to` applied onto `onto`, in memory: 422
   * `too-many-changes` past what one commit takes.
   */
  async plan(request: {
    readonly from: string;
    readonly to: string;
    readonly onto: string;
  }): Promise<CarryPlan> {
    const changed = await changedPathsWithin(
      this.branches,
      request.from,
      request.to,
    );
    if (changed.length > MAX_COMMIT_CHANGES) {
      throw new UnprocessableError(
        'too-many-changes',
        `A change set carried over changes at most ${MAX_COMMIT_CHANGES} files.`,
        { max: MAX_COMMIT_CHANGES },
      );
    }
    const applied = await this.branches.applyChange({
      from: request.from,
      to: request.to,
      onto: request.onto,
      paths: changed.map((c) => c.path),
    });
    const plan: CarryPlan = { files: new Map(), conflicts: new Map() };
    // Only the paths the change set changed: git names others too (both
    // sides of a clash), which may be content the actor may not see.
    const changedPaths = new Set(changed.map((c) => c.path));
    for (const c of applied.conflicts) {
      if (changedPaths.has(c.path)) conflict(plan, c.path, c.kinds);
    }
    for (const [path, bytes] of applied.files) {
      if (!subjectOfPath(path)) {
        conflict(plan, path, ['unsupported']);
        continue;
      }
      const text = bytes === null ? null : utf8(bytes);
      if (text === undefined) conflict(plan, path, ['binary']);
      else plan.files.set(path, text);
    }
    return plan;
  }

  /** Nothing to carry: the commit it was applied onto holds the change already. */
  isEmpty(plan: CarryPlan): boolean {
    return plan.files.size === 0 && plan.conflicts.size === 0;
  }

  /**
   * Writes `plan` to `changeSet` (a new draft of `actor`'s, its branch at
   * `onto` with no commits of its own): locks, checks, one save point,
   * `after` in its transaction (also when nothing applied). `source` at
   * `sourceHead` is the change set carried, for the blocks of a conflict;
   * the files a module names are judged by the rule a save applies, used
   * at `onto` or at `placesRef` as the actor reads them, or uploaded into a
   * change set of theirs (#335).
   */
  async apply(
    actor: Actor,
    request: {
      readonly changeSet: ChangeSet;
      readonly onto: string;
      readonly plan: CarryPlan;
      readonly source: ChangeSet;
      readonly sourceHead: string;
      readonly placesRef: string;
      readonly message: string;
      readonly after: AfterCarry;
    },
  ): Promise<CarryOutcome> {
    const { changeSet, onto, plan, message } = request;
    const files = new Map(plan.files);
    const conflicts = new Map(plan.conflicts);
    const into = { files, conflicts };
    // Every subject the change touches, so its author can edit those that
    // did not apply too.
    const subjects = new Map<string, LockSubject>();
    for (const path of [...files.keys(), ...conflicts.keys()]) {
      const subject = subjectOfPath(path);
      if (subject) subjects.set(path, subject);
    }
    for (const [path, subject] of subjects) {
      const refusal = await this.lock(actor, changeSet.id, subject);
      if (refusal) {
        conflict(into, path, [refusal]);
        files.delete(path);
      }
    }
    // The lock judged the subject as `onto` holds it; the merged content
    // must lie in the actor's scope too, as a save's does.
    const there =
      files.size > 0
        ? await this.openSnapshot.handle({ actor, ref: onto })
        : undefined;
    if (there && there.commit !== onto) {
      throw new Error('A commit opened as another; refusing to carry onto it.');
    }
    if (there) {
      const places = workingCopyFilePlaces(
        this.openSnapshot,
        actor,
        { baseRef: request.placesRef },
        there,
      );
      const recordSides = {
        head: there,
        bases: once(() =>
          changeSetRecordBases(this.openSnapshot, actor, changeSet),
        ),
      };
      for (const [path, text] of [...files]) {
        if (text === null) continue;
        const subject = subjects.get(path) as LockSubject;
        const refusal = await this.checkContent(
          actor,
          recordSides,
          subject,
          text,
          places,
        );
        if (refusal) {
          conflict(into, path, [refusal]);
          files.delete(path);
        }
      }
    }

    const changes: BranchChange[] = [...files].map(([path, content]) =>
      content === null ? { path, delete: true } : { path, content },
    );
    const written = changes
      .filter((c) => !('delete' in c))
      .map((c) => subjectOfPath(c.path) as LockSubject)
      .sort(bySubjectKey);
    const deleted = changes
      .filter((c) => 'delete' in c)
      .map((c) => subjectOfPath(c.path) as LockSubject)
      .sort(bySubjectKey);
    // Whoever wrote what is carried stays an author where it lands (#597): named in the commit.
    const carried =
      changes.length > 0
        ? await writersOf(this.branches, request.source, request.sourceHead)
        : [];
    const tree =
      changes.length > 0 && there
        ? await this.savePoints.prepare(actor, changeSet, there, {
            changes,
            message,
            carried,
          })
        : undefined;
    const listed = await this.withBlocks(
      actor,
      request.source,
      request.sourceHead,
      [...conflicts.values()],
    );
    let commit: string | undefined;
    try {
      const outcome = await this.savePoints.write(
        actor,
        {
          changeSet,
          head: onto,
          ...(tree !== undefined && { tree }),
          message,
          carried,
          consumes: [],
          locked: [...written, ...deleted],
          outcome: {
            changeSetId: changeSet.id,
            branch: changeSet.branch,
            parent: onto,
            written,
            deleted,
            unchanged: [],
          },
        },
        'is committed to',
        (tx, done) =>
          request.after(tx, {
            ...(done.commit !== undefined && { commit: done.commit }),
            applied: written.length + deleted.length,
            conflicts: listed.length,
          }),
      );
      commit = outcome.commit;
    } catch (error) {
      // Only this request writes to the new branch: nothing else moves it.
      if (error instanceof Moved) throw error.conflict();
      throw error;
    }
    return {
      ...(commit !== undefined && { commit }),
      applied: [...written, ...deleted].sort(bySubjectKey),
      conflicts: listed,
    };
  }

  /**
   * Takes the lock on `subject` for the new change set; why not (`locked`,
   * `too-many-locks`, `forbidden`) when it cannot, anything else thrown.
   */
  private async lock(
    actor: Actor,
    changeSetId: string,
    subject: LockSubject,
  ): Promise<string | undefined> {
    try {
      await this.acquireLock.handle({ actor, changeSetId, subject });
      return undefined;
    } catch (error) {
      if (
        error instanceof ConflictError &&
        (error.code === 'locked' || error.code === 'too-many-locks')
      ) {
        return error.code;
      }
      if (error instanceof ForbiddenError) return 'forbidden';
      throw error;
    }
  }

  /**
   * Whether `actor` may change `subject` into `text` (the checks a save
   * makes): `forbidden` when outside their scope
   * (`SubjectKind.checkChange`), `invalid` when the text is no such file
   * (or a module names too many files), `unknown-asset` when a module
   * names a file they may not use (`ReadableAssets` in `places`; the store
   * is not asked), `translation-record` when it changes a design's or
   * manifest's translation record they may not write
   * (`refusedRecordLanguages`, against `sides`), undefined when they may.
   */
  private async checkContent(
    actor: Actor,
    sides: RecordSides,
    subject: LockSubject,
    text: string,
    places: readonly UsagePlace[],
  ): Promise<string | undefined> {
    let content: WorkingCopyContent;
    try {
      content = parsed(subject, text);
    } catch {
      return 'invalid';
    }
    // The scope first, as a save checks it: content outside it is
    // `forbidden` alone, whatever else is wrong with it.
    try {
      await kindOf(subject).checkChange(actor, sides.head, subject, content);
    } catch (error) {
      if (error instanceof ForbiddenError) return 'forbidden';
      throw error;
    }
    // A translation record the actor may not write (#663): left as it is there.
    if (
      holdsRecord(subject) &&
      (
        await refusedRecordLanguages(
          actor,
          subject,
          content as RecordHolder,
          sides,
        )
      ).length > 0
    ) {
      return 'translation-record';
    }
    let hashes: string[];
    try {
      hashes = subjectFileReferences(subject.type, content);
    } catch (error) {
      if (error instanceof UnprocessableError) return 'invalid';
      throw error;
    }
    const refused = await this.readable.unreadable(actor, hashes, places);
    return refused.length > 0 ? 'unknown-asset' : undefined;
  }

  /**
   * The conflicts, by path, each module's with the blocks the carried
   * change set changed in it, as the actor reads its two sides (left out
   * where they cannot read one, or the file is no module there).
   */
  private async withBlocks(
    actor: Actor,
    source: ChangeSet,
    head: string,
    conflicts: readonly CarryConflict[],
  ): Promise<CarryConflict[]> {
    const sorted = [...conflicts].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    if (!sorted.some((c) => c.subject?.type === 'module')) return sorted;
    const open = (ref: string) =>
      this.openSnapshot.handle({ actor, ref }).catch((error: unknown) => {
        if (error instanceof NotFoundError) return undefined;
        throw error;
      });
    const [base, at] = await Promise.all([open(source.baseCommit), open(head)]);
    if (!base || !at) return sorted;
    const out: CarryConflict[] = [];
    for (const c of sorted) {
      if (c.subject?.type !== 'module' || c.kinds.includes('forbidden')) {
        out.push(c);
        continue;
      }
      const { moduleId, lang } = c.subject;
      const [before, after] = await Promise.all([
        base.module(moduleId, lang).catch(() => undefined),
        at.module(moduleId, lang).catch(() => undefined),
      ]);
      if (!before && !after) {
        out.push(c);
        continue;
      }
      const blockIds = diffBlocks(
        before?.blocks ?? [],
        after?.blocks ?? [],
      ).map((b) => b.blockId);
      out.push({ ...c, blockIds });
    }
    return out;
  }
}

/** Adds `kinds` to the conflict at `path` (made when there is none). */
function conflict(
  into: Pick<CarryPlan, 'conflicts'>,
  path: string,
  kinds: readonly string[],
): void {
  const subject = subjectOfPath(path);
  const known = into.conflicts.get(path);
  const all = [...new Set([...(known?.kinds ?? []), ...kinds])];
  into.conflicts.set(path, {
    path,
    ...(subject && { subject }),
    // Outside the actor's scope: that alone, never what git found there,
    // which would tell of content they may not see.
    kinds: all.includes('forbidden') ? ['forbidden'] : all,
  });
}

/** A subject's file text as the content a working copy holds. */
function parsed(subject: LockSubject, text: string): WorkingCopyContent {
  switch (subject.type) {
    case 'module':
      return parseModule(text, { id: subject.moduleId });
    case 'manual':
      return parseManifest(text, { id: subject.manualId });
    case 'config':
      return parseConfig(text);
    case 'term':
      return parseTerm(text, { id: subject.termId });
    case 'design':
      return parsePageDesign(text, { id: subject.designId });
    case 'template':
      // A template file is its text (#396).
      return { schemaVersion: TEMPLATE_FILE_SCHEMA_VERSION, text };
  }
}

/** `bytes` as UTF-8 text; undefined when they are no such text. */
function utf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
