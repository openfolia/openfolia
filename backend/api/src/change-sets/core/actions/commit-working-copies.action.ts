import {
  printTranslationRecord,
  type Module,
  type ProjectConfig,
  type Term,
  type TranslationRecord,
} from '@openfolia/content-model';
import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { subjectFileReferences } from '../../../assets/core/file-references.js';
import { ReadableAssets } from '../../../assets/core/readable-assets.js';
import {
  ConflictError,
  type Problem,
  UnprocessableError,
  UnprocessableProblems,
} from '../../../base/core/errors.js';
import { BOUNDED, UnitOfWork } from '../../../base/core/unit-of-work.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import { ChangeSetBranches } from '../change-set-branches.js';
import { CommitIntents, type ConsumedCopy } from '../commit-intents.js';
import { ChangeSetStore } from '../change-set-store.js';
import {
  type BranchChange,
  bySubjectKey,
  MAX_COMMIT_CHANGES,
  MAX_COMMIT_JSON_BYTES,
  subjectPath,
} from '../commit.js';
import { CommitRecorder, printWorkingCopy } from '../commit-recorder.js';
import {
  type LockSubject,
  type SubjectOf,
  subjectKey,
  subjectName,
} from '../lock.js';
import { LockStore } from '../lock-store.js';
import { readsChangeSets } from '../own-work.js';
import { recordPath } from '../module-rename.js';
import {
  type AfterWrite,
  type CommitOutcome,
  distinct,
  keyOf,
  type SavePointPlan,
  SavePoints,
} from '../save-point.js';
import type { DraftManifest, WorkingCopy } from '../working-copy.js';
import {
  authorsChangeSet,
  fileUnchangedSince,
  filesUnchangedSince,
  sameBytes,
  staleWorkingCopy,
  workingCopyIssues,
  workingCopySubject,
} from '../working-copy-rules.js';
import { WorkingCopyStore } from '../working-copy-store.js';
import { configUsages, refuseUsages } from '../config-usage.js';
import { designUsages, refuseDesignUsages } from '../design-usage.js';
import { workingCopyFilePlaces } from '../file-scope.js';
import {
  checkDeletable,
  checkSubject,
  CONFIG_FILE,
  kindOf,
} from '../subject-kinds.js';
import { refuseTermUsages, termUsages } from '../term-usage.js';
import { checkCommittedScope } from '../subject-scope.js';

export type { CommitOutcome } from '../save-point.js';

/** What only a draft is (the `invalid-state` answer's end). */
const COMMITTED_TO = 'is committed to';

export interface CommitWorkingCopiesInput {
  readonly actor: Actor;
  readonly changeSetId: string;
  /** The working copies to commit; all of the change set's when left out. */
  readonly subjects?: readonly LockSubject[];
  /**
   * Subjects to delete in the same commit (never the configuration); a
   * module's translation record in that language goes with it (#287).
   */
  readonly deletes?: readonly LockSubject[];
  /** The commit message; a default names what changed. */
  readonly message?: string;
  /**
   * Translation records to write in the same commit (#51: the translation
   * import, marking a translation current), each beside its module's file
   * (`modules/<lang>/<id>.translation.yaml`) and under that module's lock,
   * checked as a change of the module is. For callers in the API only,
   * never taken from a request body.
   */
  readonly translationRecords?: readonly TranslationRecordWrite[];
  /** More of the write step, in its transaction (`AfterWrite`): callers in the API only. */
  readonly after?: AfterWrite;
  /**
   * Base heads whose translation records the commit may take (`changeSetRecordBases`): an
   * update from the base resolving its conflicts against that head. Callers in the API only.
   */
  readonly reportedBases?: readonly string[];
}

/** A translation record a save point writes, and the module (in the record's language) it belongs to. */
export interface TranslationRecordWrite {
  readonly subject: SubjectOf<'module'>;
  readonly record: TranslationRecord;
  /**
   * The commit the record was made from (#957): a record file changed on the branch since is
   * 409 `stale-working-copy`, as a working copy's file is. Left out, the head's record is
   * replaced whatever it says.
   */
  readonly baseCommit?: string;
}

/**
 * A save point: commits the change set's working copies (all, or the
 * listed ones) and deletions in one commit on its branch, printed
 * canonically, with the actor as author, then drops those working copies
 * and records the commit (outbox row and audit events).
 *
 * Only the change set's author, while it is a draft (409 `invalid-state`),
 * and only for subjects whose lock the change set holds (409
 * `lock-required`). Everything a save checks is checked again, against
 * the branch head and the actor's current roles: the subject, the scope
 * (one 403 whatever the reason, so a hidden file and a missing one answer
 * alike), the files a module names (422 `unknown-asset` for one the actor
 * may not read, `ReadableAssets`, #335), and the schema version. The content must be valid: any
 * validation error is 422 `invalid-working-copy`, one error object per
 * problem. A working copy based on a file that has changed on the branch
 * since is 409 `stale-working-copy`; one that prints to exactly the
 * committed file is dropped without a commit (nothing at all to commit
 * makes no commit).
 *
 * **Order (#155).** A preflight holds nothing: it reads the working
 * copies (in a short transaction), checks, validates and prints them and
 * builds the commit's tree in Git (objects only, no ref moves). Then a
 * **commit intent** (#154) is written in a transaction of its own: the
 * actor, the parent, the tree and the working copies at their versions.
 * The write step is one bounded transaction (`BOUNDED`: lock and
 * statement timeouts, 503 `database-timeout` past them) that holds the
 * change set's row (no save, abandon or other commit of it runs
 * meanwhile) and the locks (`FOR SHARE`), checks again the state, the
 * locks and that no working copy moved, makes the Git commit of that tree
 * (compare-and-swap on the head read), drops the working copies, records
 * the commit and consumes the intent. Something that moved (the branch,
 * a working copy) is tried once more from the preflight, then 409
 * `branch-moved` or `working-copy-changed`.
 *
 * Git lands first: if the transaction fails after it, or the process
 * stops, the commit is on the branch but unrecorded, and its working
 * copies and its intent are still there. `CommitRecorder.catchUp` records
 * it later (the next commit of the change set, or
 * `ReconcileChangeSetCommitsAction`), from the intent only.
 */
@Injectable()
export class CommitWorkingCopiesAction extends ActorAction<
  CommitWorkingCopiesInput,
  CommitOutcome
> {
  readonly policy = 'content.edit';
  private readonly savePoints: SavePoints;

  constructor(
    private readonly changeSets: ChangeSetStore,
    locks: LockStore,
    private readonly workingCopies: WorkingCopyStore,
    private readonly branches: ChangeSetBranches,
    recorder: CommitRecorder,
    intents: CommitIntents,
    private readonly openSnapshot: OpenSnapshotAction,
    private readonly unit: UnitOfWork,
    private readonly readable: ReadableAssets,
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

  protected async run(input: CommitWorkingCopiesInput): Promise<CommitOutcome> {
    const subjects = input.subjects && distinct(input.subjects, 'subjects');
    const deletes = distinct(input.deletes ?? [], 'deletes');
    const deleting = new Set(deletes.map(keyOf));
    const both = (subjects ?? []).find((s) => deleting.has(keyOf(s)));
    if (both) {
      throw new UnprocessableError(
        'duplicate-subject',
        `${keyOf(both)} is both committed and deleted.`,
        { subject: both },
      );
    }
    await authorsChangeSet(this.changeSets, input.actor, input.changeSetId);
    return this.savePoints.retrying(async () =>
      this.savePoints.write(
        input.actor,
        await this.preflight(input, subjects, deletes),
        COMMITTED_TO,
        input.after,
      ),
    );
  }

  /**
   * Everything but the write, holding no row or lock past a short read:
   * the checks, validation, printing and the commit's tree.
   */
  private async preflight(
    {
      actor,
      changeSetId,
      message,
      translationRecords = [],
      reportedBases,
    }: CommitWorkingCopiesInput,
    subjects: readonly LockSubject[] | undefined,
    deletes: readonly LockSubject[],
  ): Promise<SavePointPlan> {
    const { changeSet, head } = await this.savePoints.open(
      actor,
      changeSetId,
      COMMITTED_TO,
    );

    const deleting = new Set(deletes.map(keyOf));
    const records = translationRecords.map((r) => ({
      ...r,
      subject: workingCopySubject(r.subject) as SubjectOf<'module'>,
    }));
    const read = await this.unit.run(async (tx) => {
      const sizes = await this.workingCopies.sizesOf(tx, changeSetId);
      const saved = new Map(sizes.map((s) => [keyOf(s.subject), s]));
      const chosen = subjects
        ? subjects.flatMap((s) => saved.get(keyOf(s)) ?? [])
        : sizes.filter((s) => !deleting.has(keyOf(s.subject)));
      const bytes = chosen.reduce((sum, s) => sum + s.bytes, 0);
      if (bytes > MAX_COMMIT_JSON_BYTES) {
        throw new UnprocessableError(
          'too-large',
          `One commit takes at most ${MAX_COMMIT_JSON_BYTES} bytes of working copies; commit fewer subjects at once.`,
          { max: MAX_COMMIT_JSON_BYTES },
        );
      }
      if (
        chosen.length + deletes.length + records.length >
        MAX_COMMIT_CHANGES
      ) {
        throw tooManyChanges();
      }
      // Checked here for an early answer; held again by the write step.
      await this.savePoints.holdLocks(tx, changeSetId, [
        ...chosen.map((c) => c.subject),
        ...deletes,
        ...records.map((r) => r.subject),
      ]);
      // A record describes the module's file as committed: a working copy
      // of it left out of this commit would make it describe another text.
      const committing = new Set(chosen.map((c) => keyOf(c.subject)));
      const pending = records
        .map((r) => r.subject)
        .filter((s) => saved.has(keyOf(s)) && !committing.has(keyOf(s)));
      if (pending.length > 0) {
        throw new ConflictError(
          'uncommitted-working-copies',
          'Commit or discard the working copies of these modules first.',
          { subjects: pending.sort(bySubjectKey) },
        );
      }
      const copies: { subject: LockSubject; copy: WorkingCopy | undefined }[] =
        [];
      for (const { subject } of chosen) {
        copies.push({
          subject,
          copy: await this.workingCopies.get(tx, changeSetId, subject),
        });
      }
      const deleted: ConsumedCopy[] = [];
      for (const subject of deletes) {
        const found = saved.get(keyOf(subject));
        if (found) {
          deleted.push({
            subject,
            version: found.version,
            createdAt: found.createdAt,
          });
        }
      }
      return { copies, deleted };
    }, BOUNDED);

    const unchanged: LockSubject[] = (subjects ?? []).filter(
      (s) => !read.copies.some((c) => keyOf(c.subject) === keyOf(s)),
    );
    const committedConfig = await head.config();
    // A configuration written in the same commit is what everything else
    // in it is checked against, and what the content must stay valid under.
    const newConfig = read.copies.find(
      (c) => c.subject.type === 'config' && c.copy,
    )?.copy?.content as ProjectConfig | undefined;
    const config = newConfig ?? committedConfig;
    // Many working copies share a base: each is opened once per attempt.
    const opened = new Map<string, Promise<ReadableContent>>();
    const bases: Pick<OpenSnapshotAction, 'handle'> = {
      handle: (input) => {
        let found = opened.get(input.ref);
        if (!found) {
          found = this.openSnapshot.handle(input);
          opened.set(input.ref, found);
        }
        return found;
      },
    };
    const changes: BranchChange[] = [];
    const written: LockSubject[] = [];
    const stale: LockSubject[] = [];
    const problems: Problem[] = [];
    const consumes: ConsumedCopy[] = [];
    /** What this commit writes, by subject name, for the configuration's check. */
    const writes = new Map<string, Module | DraftManifest | Term | null>();
    /** The files the modules it writes name, checked as a save checks them. */
    const files = new Set<string>();
    for (const { subject, copy } of read.copies) {
      if (!copy) {
        unchanged.push(subject);
        continue;
      }
      const { content } = copy;
      const kind = kindOf(subject);
      const version = kind.versionOf(content);
      if (version !== kind.schemaVersion) {
        problems.push(
          problemOf(subject, {
            code: 'schema-version',
            message: `Schema version ${version}; the content model reads ${kind.schemaVersion}.`,
          }),
        );
        continue;
      }
      checkSubject(subject, content);
      await kind.checkChange(actor, head, subject, content);
      // The configuration is checked apart; a template file (#396) names nothing it checks.
      if (subject.type !== 'config' && subject.type !== 'template') {
        writes.set(
          subjectName(subject),
          content as Module | DraftManifest | Term,
        );
      }
      const printed = printWorkingCopy(subject, content);
      const path = subjectPath(subject);
      const committed = await head.sourceForCheck(path);
      if (
        'text' in printed &&
        sameBytes(new TextEncoder().encode(printed.text), committed)
      ) {
        // Exactly what is committed: nothing to commit, nothing to check.
        consumes.push({
          subject,
          version: copy.version,
          createdAt: copy.createdAt,
        });
        unchanged.push(subject);
        continue;
      }
      for (const hash of subjectFileReferences(subject.type, content)) {
        files.add(hash);
      }
      const errors = workingCopyIssues(subject, content, config).filter(
        (i) => i.severity === 'error',
      );
      if (errors.length > 0) {
        problems.push(...errors.map((issue) => problemOf(subject, issue)));
        continue;
      }
      if (!('text' in printed)) {
        problems.push(
          problemOf(subject, { code: printed.code, message: printed.problem }),
        );
        continue;
      }
      consumes.push({
        subject,
        version: copy.version,
        createdAt: copy.createdAt,
      });
      if (
        !(await fileUnchangedSince(
          bases,
          actor,
          head,
          copy.baseCommit,
          subject,
          readsChangeSets(actor)
            ? undefined
            : { branches: this.branches, changeSet },
        ))
      ) {
        stale.push(subject);
        continue;
      }
      changes.push({ path, content: printed.text });
      written.push(subject);
    }
    for (const subject of deletes) {
      await checkDeletable(actor, head, subject, keyOf(subject));
      changes.push({ path: subjectPath(subject), delete: true });
      writes.set(subjectName(subject), null);
      // Its translation record goes with it (#287): left behind, it would
      // describe a file created again at that ID later, which was never
      // translated from the source it names.
      if (subject.type === 'module') {
        const record = recordPath(subject.lang, subject.moduleId);
        if ((await head.sourceForCheck(record)) !== undefined) {
          changes.push({ path: record, delete: true });
        }
      }
    }
    const writtenKeys = new Set(written.map(keyOf));
    for (const { subject, record, baseCommit } of records) {
      if (deleting.has(keyOf(subject))) {
        throw new UnprocessableError(
          'duplicate-subject',
          `${keyOf(subject)} is both deleted and given a translation record.`,
          { subject },
        );
      }
      // Changing a module's record is changing the module: its scope as committed.
      await checkCommittedScope(actor, head, subject);
      const path = recordPath(subject.lang, subject.moduleId);
      if (
        baseCommit !== undefined &&
        !(await filesUnchangedSince(
          bases,
          actor,
          head,
          baseCommit,
          [path],
          readsChangeSets(actor)
            ? undefined
            : { branches: this.branches, changeSet },
        ))
      ) {
        stale.push(subject);
        continue;
      }
      const text = printTranslationRecord(record);
      if (
        sameBytes(
          new TextEncoder().encode(text),
          await head.sourceForCheck(path),
        )
      ) {
        continue;
      }
      changes.push({ path, content: text });
      if (!writtenKeys.has(keyOf(subject))) {
        written.push(subject);
        writtenKeys.add(keyOf(subject));
      }
    }
    // A deleted module's record is a file of its own (#287).
    if (changes.length > MAX_COMMIT_CHANGES) throw tooManyChanges();
    consumes.push(...read.deleted);
    // Checked again as a save checks it (#335), against the head and the
    // actor's roles now: a working copy saved before, or a file no longer
    // readable since, is never committed.
    await this.readable.refuseUnreadable(
      actor,
      [...files],
      workingCopyFilePlaces(bases, actor, changeSet, head),
    );
    if (stale.length > 0) throw staleWorkingCopy(stale, head.commit);
    if (problems.length > 0) {
      throw new UnprocessableProblems(
        'invalid-working-copy',
        'The working copies cannot be committed as they are.',
        // Enough to work on; the rest show once these are fixed.
        problems.slice(0, MAX_PROBLEMS),
      );
    }
    if (newConfig && written.some((s) => s.type === 'config')) {
      // The head as this commit leaves it must stay valid under it.
      refuseUsages(
        await configUsages(head, committedConfig, newConfig, writes),
      );
    }
    // A term still linked is not deleted (#245): its links would point at
    // nothing. Checked against the head as this commit leaves it.
    const deletedTerms = new Set(
      deletes.flatMap((d) => (d.type === 'term' ? [d.termId] : [])),
    );
    refuseTermUsages(await termUsages(head, deletedTerms, writes));
    // Nor a page design the configuration or a manual still names (#554): checked against
    // the configuration and manifests this commit leaves.
    refuseDesignUsages(
      await designUsages(
        head,
        new Set(
          deletes.flatMap((d) => (d.type === 'design' ? [d.designId] : [])),
        ),
        writes,
        config,
      ),
    );

    const outcome = {
      changeSetId,
      branch: changeSet.branch,
      parent: head.commit,
      written: written.sort(bySubjectKey),
      deleted: [...deletes].sort(bySubjectKey),
      unchanged: unchanged.sort(bySubjectKey),
    };
    const text = message ?? defaultMessage(outcome.written, outcome.deleted);
    const tree =
      changes.length > 0
        ? await this.savePoints.prepare(actor, changeSet, head, {
            changes,
            message: text,
            ...(reportedBases !== undefined && { reported: reportedBases }),
          })
        : undefined;
    return {
      changeSet,
      head: head.commit,
      ...(tree !== undefined && { tree }),
      message: text,
      ...(message !== undefined && { comment: message }),
      consumes,
      // A copy discarded before it was read needs no lock any more.
      locked: uniqueSubjects([
        ...read.copies.flatMap((c) => (c.copy ? [c.subject] : [])),
        ...deletes,
        ...records.map((r) => r.subject),
      ]),
      outcome,
    };
  }
}

/** 422 `too-many-changes`: past `MAX_COMMIT_CHANGES` files in one commit. */
function tooManyChanges(): UnprocessableError {
  return new UnprocessableError(
    'too-many-changes',
    `One commit changes at most ${MAX_COMMIT_CHANGES} files.`,
    { max: MAX_COMMIT_CHANGES },
  );
}

/** Subjects once each, in the order first given. */
function uniqueSubjects(subjects: readonly LockSubject[]): LockSubject[] {
  return [...new Map(subjects.map((s) => [keyOf(s), s])).values()];
}

/** The most validation problems one refusal lists. */
export const MAX_PROBLEMS = 100;

/** A validation problem as an error object: the pointer names the subject and the block. */
function problemOf(
  subject: LockSubject,
  issue: { code: string; message: string; at?: string },
): Problem {
  const { type, id } = subjectKey(subject);
  return {
    detail: issue.message,
    pointer: `/${type}/${id}${issue.at === undefined ? '' : `/blocks/${issue.at}`}`,
    meta: {
      subject,
      issue: issue.code,
      ...(issue.at !== undefined && { at: issue.at }),
    },
  };
}

/** What a commit without a message says: what it changed. */
function defaultMessage(
  written: readonly LockSubject[],
  deleted: readonly LockSubject[],
): string {
  const name = (s: LockSubject) => {
    // The configuration by its file's name, not its stored subject ID (`CONFIG_SUBJECT_ID`).
    if (s.type === 'config') return `config ${CONFIG_FILE}`;
    const { type, id } = subjectKey(s);
    return `${type} ${id}`;
  };
  if (written.length + deleted.length === 1) {
    return written[0]
      ? `Update ${name(written[0])}`
      : `Delete ${name(deleted[0] as LockSubject)}`;
  }
  const parts = [
    ...(written.length > 0 ? [`update ${written.length}`] : []),
    ...(deleted.length > 0 ? [`delete ${deleted.length}`] : []),
  ];
  const content = [...written, ...deleted].every(
    (s) => s.type === 'module' || s.type === 'manual',
  );
  const text = `${parts.join(' and ')} ${content ? 'modules and manuals' : 'files'}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
