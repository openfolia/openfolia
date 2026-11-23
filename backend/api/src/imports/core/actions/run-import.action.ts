import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { allows, ANYWHERE } from '../../../access/core/allows.js';
import type { UnguardedAction } from '../../../access/core/policy.js';
import { UserDirectory } from '../../../access/core/user-directory.js';
import { UploadAssetAction } from '../../../assets/core/actions/upload-asset.action.js';
import { AuditLog } from '../../../audit/core/audit-log.js';
import {
  ConflictError,
  ContendedError,
  DomainError,
  UnavailableError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import { UnitOfWork } from '../../../base/core/unit-of-work.js';
import { BlobStore } from '../../../blobs/core/blob-store.js';
import { AcquireLockAction } from '../../../change-sets/core/actions/acquire-lock.action.js';
import { CommitWorkingCopiesAction } from '../../../change-sets/core/actions/commit-working-copies.action.js';
import { CreateChangeSetAction } from '../../../change-sets/core/actions/create-change-set.action.js';
import { SaveWorkingCopyAction } from '../../../change-sets/core/actions/save-working-copy.action.js';
import { changeSetBranch } from '../../../change-sets/core/change-set.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import {
  IMPORT_TTL_MS,
  type ImportFailure,
  type ImportProgress,
  type ImportRecord,
  type ImportReport,
  ImportSettings,
} from '../import.js';
import {
  batches,
  decisionsOf,
  type PlannedUpload,
  type PlannedWrite,
  withCommittedRecord,
} from '../import-plan.js';
import { ImportPipeline } from '../import-pipeline.js';
import { ImportStore } from '../import-store.js';
import { ImporterRegistry } from '../importer.js';

/** Codes of 409s that may well pass when tried again: another write got in the way. */
const PASSING = new Set([
  'lock-contended',
  'branch-moved',
  'working-copy-changed',
]);

/** Whether an error says the import cannot be done (no retry will help), rather than "not now". */
export function isPermanent(error: unknown): error is DomainError {
  return (
    error instanceof DomainError &&
    !(error instanceof UnavailableError) &&
    !(error instanceof ContendedError) &&
    !PASSING.has(error.code)
  );
}

/** An actor as the audit log names it, for an importer who can no longer act. */
const named = (record: ImportRecord): Actor => ({
  kind: record.createdBy.kind,
  id: record.createdBy.id,
  roles: [],
});

/** The longest change-set title. */
const MAX_TITLE = 200;

/**
 * The job of an import being applied (`import.apply`): writes it into a
 * new change set, **as the person who uploaded it**, through the
 * change-set and asset actions every edit goes through (never around
 * them), so each step checks what it checks for an editor: the policy,
 * the scope, the locks, the content, the limits. The payload names only
 * the import; the uploader is read from its record and resolved again
 * (`UserDirectory.findActor`), with their roles as they are now: a
 * deactivated one fails the import. (Not the component's own service
 * actor, as other jobs use: the change set must be theirs, reviewed like
 * any edit of theirs.)
 *
 * Steps, each idempotent, so an attempt cut off is run again safely:
 * 1. Without a change set yet: check the import again against the target
 *    as it is now (`ImportPipeline.check`); a report that is no longer
 *    applicable, or decides any item differently, fails it
 *    (`import-outdated`: upload it again to see the new report). An import
 *    whose report refused items was applied with `skipRefused` (the apply
 *    takes no other): its rest must still stand without them
 *    (`applicableWithoutRefused`), and the refused items, the same ones,
 *    are left out, said with why in the change set's description and in
 *    every commit message (`leftOutText`). Then `CreateChangeSetAction`
 *    (named after the import) and the change set recorded on the import.
 * 2. The files, by `UploadAssetAction` (the same file again is no new one).
 * 3. The modules, then the manuals, in save points within
 *    `CCMS_IMPORT_COMMIT_FILES` files and `CCMS_IMPORT_COMMIT_BYTES` of
 *    working copies each (at most the save point's own 1,000 files and
 *    32 MiB): for each, `AcquireLockAction` (held already: no change) and
 *    `SaveWorkingCopyAction` (an existing working copy at its version),
 *    then `CommitWorkingCopiesAction` for the batch (what is committed
 *    already is unchanged and makes no commit).
 * 4. `applied`, with one `import.apply` audit event holding the counts.
 *
 * A domain error that says it cannot be done (forbidden, a conflict, a
 * refusal) fails the import at once, with its code, and the same event;
 * the change set keeps what was written so far, for its author to abandon
 * or finish. Anything else (the store or the database unavailable, a write
 * that got in the way) is thrown, so the job is retried; once it failed
 * for good, `FailImportAction` marks the import failed.
 */
@Injectable()
export class RunImportAction implements UnguardedAction {
  readonly policy = 'internal';

  constructor(
    private readonly store: ImportStore,
    private readonly users: UserDirectory,
    private readonly blobs: BlobStore,
    private readonly registry: ImporterRegistry,
    private readonly pipeline: ImportPipeline,
    private readonly settings: ImportSettings,
    private readonly createChangeSet: CreateChangeSetAction,
    private readonly uploadAsset: UploadAssetAction,
    private readonly acquireLock: AcquireLockAction,
    private readonly saveWorkingCopy: SaveWorkingCopyAction,
    private readonly commitWorkingCopies: CommitWorkingCopiesAction,
    private readonly openSnapshot: OpenSnapshotAction,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {}

  async handle({
    importId,
    signal,
  }: {
    readonly importId: string;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    const record = await this.store.find(importId);
    // Finished already (an attempt that ran on after its end), or never applied.
    if (record?.state !== 'applying') return;
    const actor =
      record.createdBy.kind === 'user'
        ? await this.users.findActor(record.createdBy.id)
        : undefined;
    if (!actor) {
      await finish(this.deps, record, named(record), {
        code: 'importer-gone',
        detail:
          'The person who started the import can no longer act (deactivated or removed).',
      });
      return;
    }
    // Still allowed to import, as at the start: roles may have changed.
    if (
      !allows(actor, 'admin.roles', ANYWHERE) ||
      !allows(actor, 'content.edit', ANYWHERE)
    ) {
      await finish(this.deps, record, actor, {
        code: 'forbidden',
        detail:
          'The person who started the import may no longer import (admin.roles and content.edit).',
      });
      return;
    }
    try {
      await this.apply(record, actor, signal);
    } catch (error) {
      if (!isPermanent(error)) throw error;
      await finish(this.deps, record, actor, {
        code: error.code,
        detail: error.message,
      });
    }
  }

  private get deps() {
    return { store: this.store, auditLog: this.auditLog, unit: this.unit };
  }

  private async apply(
    record: ImportRecord,
    actor: Actor,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const stored = await this.blobs.get(record.upload.sha256);
    if (!stored) {
      throw new ConflictError(
        'upload-missing',
        'The uploaded file is gone from the blob store; upload it again.',
      );
    }
    const bytes = await readAll(stored.stream, record.upload.size);
    const importer = this.registry.get(record.importerId);
    const options = importer.options.parse(record.options);
    const file = {
      bytes,
      ...(record.fileName !== null && { fileName: record.fileName }),
    };
    let progress = record.progress;
    let changeSetId = record.changeSetId;
    let writes: readonly PlannedWrite[];
    let uploads: readonly PlannedUpload[];
    if (changeSetId === null) {
      const checked = await this.pipeline.check(actor, {
        importer,
        options,
        file,
        baseRef: record.baseRef,
        updateExisting: record.updateExisting,
      });
      const now = checked.plan.report;
      // Applied with `skipRefused` exactly when its report refused something.
      const stands = record.report.applicable
        ? now.applicable
        : now.applicableWithoutRefused;
      if (
        !stands ||
        decisionsOf(now).join('\n') !== decisionsOf(record.report).join('\n')
      ) {
        throw new ConflictError(
          'import-outdated',
          'What the import would do changed since it was checked (the target moved on); upload it again to see the new report.',
        );
      }
      ({ writes, uploads } = checked.plan);
      progress = {
        phase: 'change-set',
        assets: { done: 0, total: uploads.length },
        files: { done: 0, total: writes.length },
        commits: [],
      };
      signal?.throwIfAborted();
      const leftOut = leftOutText(record.report);
      const changeSet = await this.createChangeSet.handle({
        actor,
        title: titleOf(record),
        description: `Imported with the "${record.importerId}" importer (import ${record.id}).${leftOut === undefined ? '' : `\n\n${leftOut}`}`,
        baseRef: record.baseRef,
      });
      changeSetId = changeSet.id;
      const id = changeSetId;
      await this.unit.run((tx) =>
        this.store.update(tx, record.id, { changeSetId: id, progress }),
      );
    } else {
      // A retry: the decisions checked before, from the same bundle, in
      // the same order (converted for the change set branch's configuration,
      // which is the target's as checked, unless the change set changed it).
      const snapshot = await this.openSnapshot.handle({
        actor,
        ref: changeSetBranch(changeSetId),
      });
      ({ writes, uploads } = await this.pipeline.replay(
        { importer, options, file },
        record.report,
        await snapshot.config(),
      ));
    }
    const changeSet = changeSetId;
    const save = (next: ImportProgress) =>
      this.unit.run((tx) =>
        this.store.update(tx, record.id, { progress: next }),
      );

    progress = { ...progress, phase: 'assets' };
    for (const [index, upload] of uploads.entries()) {
      // Uploaded by an earlier attempt (the same files in the same order):
      // not again, so a change set at its upload limit is not refused.
      if (index < progress.assets.done) continue;
      signal?.throwIfAborted();
      await this.uploadAsset.handle({
        actor,
        changeSetId: changeSet,
        kind: upload.kind,
        maxBytes:
          upload.kind === 'image'
            ? this.settings.maxImageBytes
            : this.settings.maxAttachmentBytes,
        attachmentTypes: this.settings.attachmentTypes,
        fileName: () => upload.fileName,
        file: () => once(upload.bytes),
      });
      progress = {
        ...progress,
        assets: { done: index + 1, total: uploads.length },
      };
      await save(progress);
    }

    progress = { ...progress, phase: 'files' };
    const parts = batches(writes, {
      files: this.settings.commitFiles,
      bytes: this.settings.commitBytes,
    });
    const leftOut = leftOutText(record.report);
    let written = 0;
    for (const [index, part] of parts.entries()) {
      // Parts an earlier attempt committed are skipped (the same parts:
      // the same writes in the same order with the same limits).
      if (written + part.length <= progress.files.done) {
        written += part.length;
        continue;
      }
      for (const write of part) {
        signal?.throwIfAborted();
        await this.acquireLock.handle({
          actor,
          changeSetId: changeSet,
          subject: write.subject,
        });
        await this.saveCopy(actor, changeSet, write);
      }
      signal?.throwIfAborted();
      const title =
        parts.length === 1
          ? titleOf(record)
          : `${titleOf(record)}, part ${index + 1} of ${parts.length}`;
      const made = await this.commitPart(
        actor,
        changeSet,
        part,
        leftOut === undefined ? title : `${title}\n\n${leftOut}`,
      );
      written += part.length;
      progress = {
        ...progress,
        files: { done: written, total: writes.length },
        commits: [
          ...progress.commits,
          ...made.filter((commit) => !progress.commits.includes(commit)),
        ],
      };
      await save(progress);
    }
    await finish(this.deps, { ...record, changeSetId }, actor, null, {
      ...progress,
      phase: 'done',
    });
  }

  /**
   * Commits one planned save point. The plan sizes it by the content's
   * compact JSON, the commit by the stored working copies' text, which is
   * longer: a part the commit finds too large is committed in halves
   * instead (the same subjects, the same order), never failed.
   */
  private async commitPart(
    actor: Actor,
    changeSetId: string,
    part: readonly PlannedWrite[],
    message: string,
  ): Promise<string[]> {
    try {
      const outcome = await this.commitWorkingCopies.handle({
        actor,
        changeSetId,
        subjects: part.map((w) => w.subject),
        message,
      });
      return outcome.commit === undefined ? [] : [outcome.commit];
    } catch (error) {
      if (
        !(error instanceof UnprocessableError) ||
        error.code !== 'too-large' ||
        part.length < 2
      ) {
        throw error;
      }
      const half = Math.ceil(part.length / 2);
      return [
        ...(await this.commitPart(
          actor,
          changeSetId,
          part.slice(0, half),
          message,
        )),
        ...(await this.commitPart(
          actor,
          changeSetId,
          part.slice(half),
          message,
        )),
      ];
    }
  }

  /** Saves the working copy, at the version a working copy an earlier attempt saved has. */
  private async saveCopy(
    actor: Actor,
    changeSetId: string,
    write: PlannedWrite,
  ): Promise<void> {
    // A manual takes the record its file has on the change set's branch now
    // (#663): the plan's may be older (a retry rebuilds it from the bundle,
    // which has none; the base may have moved since the check).
    const content =
      write.subject.type === 'manual' && 'entries' in write.content
        ? await withCommittedRecord(
            await this.openSnapshot.handle({
              actor,
              ref: changeSetBranch(changeSetId),
            }),
            write.subject,
            write.content,
          )
        : write.content;
    const save = (version: number) =>
      this.saveWorkingCopy.handle({
        actor,
        changeSetId,
        subject: write.subject,
        content,
        version,
      });
    try {
      await save(0);
    } catch (error) {
      const version = error instanceof ConflictError && error.meta?.['version'];
      if (
        error instanceof ConflictError &&
        error.code === 'version-conflict' &&
        typeof version === 'number' &&
        version > 0
      ) {
        await save(version);
        return;
      }
      throw error;
    }
  }
}

/**
 * Ends an applying import, `applied` (no `failure`) or `failed`, with its
 * one `import.apply` audit event (the counts, never content), in one
 * transaction holding its row; an import no longer applying is left as
 * it is (another attempt ended it).
 */
async function finish(
  deps: { store: ImportStore; auditLog: AuditLog; unit: UnitOfWork },
  record: ImportRecord,
  actor: Actor,
  failure: ImportFailure | null,
  progress?: ImportProgress,
): Promise<void> {
  await deps.unit.run(async (tx) => {
    const current = await deps.store.lock(tx, record.id);
    if (current?.state !== 'applying') return;
    const now = new Date();
    const state = failure ? 'failed' : 'applied';
    const changeSetId = record.changeSetId ?? current.changeSetId;
    const ended = progress ?? current.progress;
    await deps.store.update(tx, record.id, {
      state,
      failure,
      progress: ended,
      finishedAt: now,
      // Shown for an hour after its end, then removed with its upload.
      expiresAt: new Date(now.getTime() + IMPORT_TTL_MS),
    });
    const { counts } = current.report;
    await deps.auditLog.record(tx, actor, {
      action: 'import.apply',
      subject: { type: 'import', id: record.id },
      data: {
        state,
        importer: current.importerId,
        baseRef: current.baseRef,
        ...(changeSetId !== null && { changeSetId }),
        ...(failure && { failure: failure.code }),
        counts: {
          create: counts.create,
          update: counts.update,
          skip: counts.skip,
          // Refused, so left out by an apply with `skipRefused` (#758).
          refuse: counts.refuse,
          modules: counts.modules,
          manuals: counts.manuals,
          assets: counts.assets,
          passthrough: counts.passthrough,
        },
        written: { files: ended.files.done, assets: ended.assets.done },
        commits: ended.commits.length,
      },
    });
  });
}

/**
 * Marks an import failed once its job failed for good (its last attempt
 * threw, ran out of time, or its server vanished), so it never shows as
 * applying forever. Idempotent: only an applying import changes.
 */
@Injectable()
export class FailImportAction implements UnguardedAction {
  readonly policy = 'internal';

  constructor(
    private readonly store: ImportStore,
    private readonly users: UserDirectory,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {}

  async handle({ importId }: { readonly importId: string }): Promise<void> {
    const record = await this.store.find(importId);
    if (record?.state !== 'applying') return;
    const actor =
      (record.createdBy.kind === 'user'
        ? await this.users.findActor(record.createdBy.id)
        : undefined) ?? named(record);
    await finish(
      { store: this.store, auditLog: this.auditLog, unit: this.unit },
      record,
      actor,
      {
        code: 'import-failed',
        detail:
          'Applying the import failed again and again (the server log says why); what was written so far is in its change set.',
      },
    );
  }
}

/** The most left-out items named one by one; the rest are counted. */
const MAX_LEFT_OUT_LISTED = 25;
/** The longest line naming one, so the text stays within a commit message's 10,000 characters. */
const MAX_LEFT_OUT_LINE = 300;

/**
 * What an import applied with `skipRefused` leaves out, and why (#758): its
 * report's refused items, each with its reasons' codes and the first reason's
 * sentence, for the change set's description and every commit message.
 * `undefined` when nothing is refused. At most `MAX_LEFT_OUT_LISTED` are
 * named; the import's report lists them all.
 */
export function leftOutText(report: ImportReport): string | undefined {
  const refused = report.items.filter((i) => i.action === 'refuse');
  if (refused.length === 0) return undefined;
  const lines = refused.slice(0, MAX_LEFT_OUT_LISTED).map((item) => {
    const what =
      item.kind === 'asset'
        ? `file ${item.id}`
        : `${item.kind} ${item.lang === undefined ? '' : `${item.lang}/`}${item.id}`;
    const codes = [...new Set(item.reasons.map((r) => r.code))].join(', ');
    const first = item.reasons[0]?.message;
    const why = [codes, first].filter((part) => part).join(': ');
    return oneLine(`- ${what}${why === '' ? '' : ` (${why})`}`);
  });
  const more = refused.length - lines.length;
  return [
    `Left out: ${refused.length} item${refused.length === 1 ? '' : 's'} the check refused.`,
    ...lines,
    ...(more > 0
      ? [`- and ${more} more; the import's report lists them all.`]
      : []),
  ].join('\n');
}

/**
 * `text` on one line: control and format characters (C0, C1, bidirectional and
 * zero-width ones, line and paragraph separators) as spaces, so a commit
 * message takes it and it reads as it is; at most `MAX_LEFT_OUT_LINE`
 * characters, cut between code points.
 */
function oneLine(text: string): string {
  const flat = [...text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ')];
  return flat.length > MAX_LEFT_OUT_LINE
    ? `${flat.slice(0, MAX_LEFT_OUT_LINE - 1).join('')}…`
    : flat.join('');
}

function titleOf(record: ImportRecord): string {
  const what =
    record.fileName ?? record.report.source?.system ?? `import ${record.id}`;
  return `Import of ${what}`.slice(0, MAX_TITLE);
}

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

/** The stored upload, read whole: at most its recorded size. */
async function readAll(
  stream: AsyncIterable<Uint8Array>,
  size: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let read = 0;
  for await (const chunk of stream) {
    read += chunk.byteLength;
    if (read > size) {
      throw new ConflictError(
        'upload-missing',
        'The stored upload is not the file that was uploaded; upload it again.',
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
