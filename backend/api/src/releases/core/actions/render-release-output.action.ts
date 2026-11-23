import { Injectable, Logger } from '@nestjs/common';
import type { UnguardedAction } from '../../../access/core/policy.js';
import {
  ContendedError,
  DomainError,
  NotFoundError,
  TooManyRequestsError,
  UnavailableError,
} from '../../../base/core/errors.js';
import {
  BOUNDED,
  type Transaction,
  UnitOfWork,
} from '../../../base/core/unit-of-work.js';
import { BlobStore } from '../../../blobs/core/blob-store.js';
import { StorageQuota } from '../../../storage-usage/core/storage-quota.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import type { ReleaseFacts } from '../../../content/core/readable-content.js';
import { RenderManualPdfAction } from '../../../manuals/core/actions/render-manual-pdf.action.js';
import type { Release } from '../release.js';
import { RELEASE_READER } from '../release-changes.js';
import { ReleaseEvents } from '../release-events.js';
import {
  MAX_ERROR_DETAIL,
  MAX_OUTPUT_BYTES,
  type OutputError,
  outputRenderer,
  type ReleaseOutput,
} from '../release-output.js';
import { ReleaseOutputStore } from '../release-output-store.js';
import { ReleaseStore } from '../release-store.js';
import { ScheduleReleaseOutputsAction } from './schedule-release-outputs.action.js';
import { BuildOfflinePackageAction } from './build-offline-package.action.js';
import { OFFLINE_PACKAGE_TYPE } from '../offline-package.js';

/** An error as an output keeps it: its code and a text safe to show its readers. */
export function outputErrorOf(error: unknown): OutputError {
  if (error instanceof DomainError) {
    return {
      code: error.code,
      detail: error.message.slice(0, MAX_ERROR_DETAIL),
    };
  }
  // Anything else may hold what no reader should see: the log has it.
  return {
    code: 'render-error',
    detail: 'Rendering failed unexpectedly; the server log says why.',
  };
}

/**
 * What `release.output-failed` and `release.output-recovered` say of an
 * output: its release (the commit is what the notifications judge who may
 * read the manual at) and what it is of.
 */
function outputEventPayload(
  output: ReleaseOutput,
  release: Release | undefined,
): Record<string, unknown> {
  return {
    releaseId: output.releaseId,
    outputId: output.id,
    product: release?.product ?? null,
    revision: release?.revision ?? null,
    tag: release?.tag ?? null,
    commit: release?.commit ?? null,
    manualId: output.manualId,
    variant: output.variant,
    lang: output.lang,
    kind: output.kind,
    audience: output.audience,
  };
}

/**
 * Whether an output finished now was told failed (#551): it was `failed`
 * (a late file finished it), or it was queued again after failing (a
 * retry counts one, and only a failed output is retried).
 */
function wasToldFailed(before: ReleaseOutput): boolean {
  return before.state === 'failed' || before.retries > 0;
}

/**
 * What a release's PDF prints of its release (#395): its revision as its name (`2.3`) and the
 * day it was published (`YYYY-MM-DD`, UTC), so the same release always prints the same.
 */
export function releaseFacts(
  release: Pick<Release, 'revision' | 'publishedAt'>,
): ReleaseFacts {
  return {
    name: release.revision,
    date: release.publishedAt.toISOString().slice(0, 10),
  };
}

/** How often a render stores and records its file before the job retries (#593). */
const RECORD_ATTEMPTS = 2;

/**
 * The rendered file was gone when its output was recorded, under its hash
 * lock: a file delete removed the same bytes after they were stored
 * (#593). Retried (`isPermanent` says no).
 */
class FileGoneError extends UnavailableError {
  constructor() {
    super(
      'output-file-gone',
      'The rendered file was removed while it was recorded; it is rendered again.',
      1,
    );
  }
}

/** The output a render makes its file for, and its release. */
interface Source {
  readonly output: ReleaseOutput;
  readonly release: Release;
}

/**
 * Whether an attempt's error says the output can never be rendered at
 * this tag (the document refused for its PDF standard, too slow, broken
 * content, the compiler failing): no retry would help, since the tag
 * fixes everything the PDF is made from. Anything else (the renderer
 * busy, the blob store or the database down or contended, a server
 * shutting down, an
 * error of unknown kind) is worth retrying.
 */
export function isPermanent(error: unknown): error is DomainError {
  return (
    error instanceof DomainError &&
    !(error instanceof UnavailableError) &&
    !(error instanceof ContendedError) &&
    !(error instanceof TooManyRequestsError)
  );
}

/**
 * Fails an output for good, once (#249): `failed` with its error, and a
 * `release.output-failed` outbox row for notifications (#252), in one
 * transaction; keyed by the output and its retry count, so each failure
 * is told once. A `done` output never fails: a failure never replaces a
 * good file, and the previous release's output stays the latest good one.
 * Then the release's next output is queued in its place (#497).
 */
@Injectable()
export class FailReleaseOutputAction implements UnguardedAction {
  readonly policy = 'internal';

  constructor(
    private readonly outputs: ReleaseOutputStore,
    private readonly releases: ReleaseStore,
    private readonly events: ReleaseEvents,
    private readonly unit: UnitOfWork,
    private readonly schedule: ScheduleReleaseOutputsAction,
  ) {}

  async handle({
    outputId,
    retries,
    error,
  }: {
    readonly outputId: string;
    /** Its retry count the failing job was queued at: one queued again since is left alone. */
    readonly retries: number;
    /** Why; left out: the error the last attempt noted. */
    readonly error?: OutputError;
  }): Promise<void> {
    const current = await this.outputs.find(outputId);
    if (!current) return;
    const release = await this.releases.find(current.releaseId);
    await this.unit.run(async (tx) => {
      const failed = await this.outputs.fail(
        tx,
        outputId,
        error ?? current.error ?? undefined,
        retries,
      );
      if (!failed) return;
      await this.events.emit(tx, {
        topic: 'release.output-failed',
        key: `${failed.id}/${failed.retries}`,
        payload: {
          ...outputEventPayload(failed, release),
          code: failed.error?.code ?? null,
        },
      });
    });
    // Its place is free (or was already, for a report that came late).
    if (release) await this.schedule.handle(release);
  }
}

/**
 * Renders one output of a release (#249), the `release.outputs` job:
 * the manual at the release's tag (its commit, never `main`), as a
 * service whose scope is the manual's audience (`outputRenderer`): the
 * same file for every reader who may read the manual, and the same bytes
 * however often it is rendered. The PDF goes into the blob store
 * (content-addressed), and the row becomes `done` with its hash and size.
 *
 * **At least once, idempotent:** a `done` or `failed` output is left
 * alone; an attempt moves `queued` or `rendering` to `rendering`, and only
 * a stored file makes it `done` (the same bytes again are the same blob).
 * An error that says it can never be rendered (`isPermanent`) fails it at
 * once (`FailReleaseOutputAction`); any other is noted on the row and
 * thrown, so the job queue retries it by its policy, and once the job
 * failed for good the handler's `failed` fails the output with the error
 * noted last.
 *
 * **Once per inputs (#497):** an output of its reuse group (the same
 * manual, variant and language in releases that changed nothing it
 * shows) done already gives it its file without a render; a file it
 * renders serves every output of the group still to render. Rendered as
 * background work (`RenderOptions.background`), after what readers wait
 * for. Whenever an output ends here (or was found ended), the release's
 * next one is queued (`ScheduleReleaseOutputsAction`).
 */
@Injectable()
export class RenderReleaseOutputAction implements UnguardedAction {
  readonly policy = 'internal';
  private readonly logger = new Logger(RenderReleaseOutputAction.name);

  constructor(
    private readonly outputs: ReleaseOutputStore,
    private readonly releases: ReleaseStore,
    private readonly openSnapshot: OpenSnapshotAction,
    private readonly renderPdf: RenderManualPdfAction,
    private readonly blobs: BlobStore,
    private readonly fail: FailReleaseOutputAction,
    private readonly unit: UnitOfWork,
    private readonly quota: StorageQuota,
    private readonly schedule: ScheduleReleaseOutputsAction,
    private readonly events: ReleaseEvents,
    private readonly packages: BuildOfflinePackageAction,
  ) {}

  async handle({
    outputId,
    retries,
    signal,
  }: {
    readonly outputId: string;
    /** Its retry count the job was queued at: an output queued again since is the newer job's. */
    readonly retries: number;
    /** Aborted once the attempt is cut off: an offline package's build stops between files. */
    readonly signal?: AbortSignal;
  }): Promise<void> {
    const found = await this.outputs.find(outputId);
    if (!found) return;
    const release = await this.releases.find(found.releaseId);
    if (!release) return;
    if (found.state === 'done' || found.state === 'failed') {
      // Ended already (by its group, or an attempt cut off after it): its place is free.
      await this.schedule.handle(release);
      return;
    }
    // An offline package (#59): built, never reused (it names its release).
    if (found.kind === 'offline-package') {
      return this.buildPackage(found, release, retries, signal);
    }
    // The same inputs rendered already, for another release: that file.
    if (await this.reuse(found, release)) {
      await this.schedule.handle(release);
      return;
    }
    const output = await this.outputs.start(outputId, retries);
    if (!output) {
      // Ended meanwhile (its group's file, or a newer job's): its place is free.
      await this.schedule.handle(release);
      return;
    }
    // The file is made for its group's oldest output still to render (#497):
    // the newest release renders first, and the file then serves every
    // output of its group cut at or after that one, as reuse always went,
    // so no file carries a later commit than its release's (#328), and
    // the older release's output is not rendered again.
    let source: Source;
    let pdf: Uint8Array;
    try {
      ({ source, pdf } = await this.renderFor(output, release));
    } catch (error) {
      return this.failed(output, error);
    }
    try {
      // Stored, then recorded under the file's hash lock (#593). A file
      // delete may remove the very bytes in between (an old upload of
      // exactly them that nothing used): then they are stored again and
      // recorded again, once; gone twice, the job retries.
      for (let attempt = 1; ; attempt++) {
        const file = await this.store(pdf);
        try {
          await this.unit.run((tx) =>
            this.record(tx, output, release, source, file),
          );
          break;
        } catch (error) {
          if (!(error instanceof FileGoneError) || attempt >= RECORD_ATTEMPTS) {
            throw error;
          }
        }
      }
    } catch (error) {
      return this.failed(output, error);
    }
    await this.schedule.handle(release);
    if (source.release.id !== release.id) {
      await this.schedule.handle(source.release);
    }
  }

  /**
   * Builds an offline package (#59) and stores it, streamed from its build
   * into the blob store (never held whole), then records it under its hash
   * lock as a PDF is recorded (#593). Failures go as a PDF's go: one that says
   * it can never be built (`offline-package-too-large`) fails it, any other is
   * retried.
   */
  private async buildPackage(
    found: ReleaseOutput,
    release: Release,
    retries: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const output = await this.outputs.start(found.id, retries);
    if (!output) {
      await this.schedule.handle(release);
      return;
    }
    try {
      for (let attempt = 1; ; attempt++) {
        const stored = await this.blobs.put(
          this.packages.stream(release, output, signal),
          {
            contentType: OFFLINE_PACKAGE_TYPE,
            maxBytes: this.packages.maxBytes,
          },
        );
        if (stored.created) await this.countPdf(stored.size);
        const file = { sha256: stored.sha256, size: stored.size };
        try {
          await this.unit.run(async (tx) => {
            const before = await this.outputs.finish(output.id, file, tx);
            if (!(await this.blobs.exists(file.sha256))) {
              throw new FileGoneError();
            }
            if (before && wasToldFailed(before)) {
              await this.recovered(tx, before, release);
            }
          });
          break;
        } catch (error) {
          if (!(error instanceof FileGoneError) || attempt >= RECORD_ATTEMPTS) {
            throw error;
          }
        }
      }
    } catch (error) {
      return this.failed(output, error);
    }
    await this.schedule.handle(release);
  }

  /** Puts `pdf` into the blob store; its hash and size. */
  private async store(
    pdf: Uint8Array,
  ): Promise<{ sha256: string; size: number }> {
    const stored = await this.blobs.put(
      (async function* () {
        yield pdf;
      })(),
      { contentType: 'application/pdf', maxBytes: MAX_OUTPUT_BYTES },
    );
    // The bytes are stored now, whichever row ends up naming them.
    if (stored.created) await this.countPdf(stored.size);
    return { sha256: stored.sha256, size: stored.size };
  }

  /**
   * Records `file` inside `tx` for `source`'s output and the outputs of
   * `output`'s group (#497). `finish` takes the file's hash lock before it
   * writes, the one lock this transaction takes, which `finishGroup`
   * takes again for the same file (so no other order can arise between
   * two such transactions, #593). Under it, the blob must still be there:
   * a file delete that held the lock first may have removed the bytes
   * after they were stored (`FileGoneError`, all rolled back). A delete
   * after it sees the output `done` and keeps the file.
   */
  private async record(
    tx: Transaction,
    output: ReleaseOutput,
    release: Release,
    source: Source,
    file: { readonly sha256: string; readonly size: number },
  ): Promise<void> {
    const before = await this.outputs.finish(source.output.id, file, tx);
    if (!(await this.blobs.exists(file.sha256))) throw new FileGoneError();
    if (before && wasToldFailed(before)) {
      await this.recovered(tx, before, source.release);
    }
    if (output.reuseGroup !== null) {
      await this.finishGroup(
        tx,
        output,
        file,
        { releaseId: source.output.releaseId, outputId: source.output.id },
        [release, source.release],
      );
    }
  }

  /**
   * `output`'s file, made for its group's oldest output still to render
   * (`sourceOf`). Should that fail at the older release, the error is that
   * release's (its tag, say), never this output's: it is made at its own
   * release instead, and only that attempt's error is this output's.
   */
  private async renderFor(
    output: ReleaseOutput,
    release: Release,
  ): Promise<{ source: Source; pdf: Uint8Array }> {
    const source = await this.sourceOf(output, release);
    if (source.output.id !== output.id) {
      try {
        return { source, pdf: await this.render(source.release, output) };
      } catch (error) {
        this.logger.warn(
          `Rendering output ${output.id} at release ${source.release.id} (its group's oldest) failed, rendering it at its own: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const own = { output, release };
    return { source: own, pdf: await this.render(release, output) };
  }

  /**
   * The output (and its release) whose file `output`'s render makes: the
   * oldest of its group still to render, else itself.
   */
  private async sourceOf(
    output: ReleaseOutput,
    release: Release,
  ): Promise<Source> {
    const oldest = await this.outputs.oldestPendingIn(output);
    if (!oldest || oldest.releaseId === release.id) return { output, release };
    const older = await this.releases.find(oldest.releaseId);
    return older ? { output: oldest, release: older } : { output, release };
  }

  /**
   * Gives every output of the group still to render the file of one done
   * already, if there is one (#497); whether there was.
   */
  private async reuse(
    output: ReleaseOutput,
    release: Release,
  ): Promise<boolean> {
    const done = await this.outputs.doneIn(output);
    if (!done?.sha256 || done.size === null) return false;
    await this.unit.run((tx) =>
      this.finishGroup(
        tx,
        output,
        { sha256: done.sha256 as string, size: done.size as number },
        // The file's own output, however many outputs reused it since.
        done.reusedFrom ?? { releaseId: done.releaseId, outputId: done.id },
        [release],
      ),
    );
    return true;
  }

  /**
   * `finishGroup` inside `tx`, telling of each output it finished that was
   * told failed (#551); `known` the releases at hand, others are read.
   */
  private async finishGroup(
    tx: Transaction,
    output: ReleaseOutput,
    file: { readonly sha256: string; readonly size: number },
    from: { readonly releaseId: string; readonly outputId: string },
    known: readonly Release[],
  ): Promise<void> {
    const finished = await this.outputs.finishGroup(output, file, from, tx);
    for (const member of finished) {
      if (!wasToldFailed(member)) continue;
      const release =
        known.find((r) => r.id === member.releaseId) ??
        (await this.releases.find(member.releaseId));
      await this.recovered(tx, member, release);
    }
  }

  /**
   * `release.output-recovered` (#551) inside `tx`: an output told failed
   * is `done` after all, so whoever heard of the failure hears it is
   * ready. Once per output: a `done` output never fails again.
   */
  private async recovered(
    tx: Transaction,
    output: ReleaseOutput,
    release: Release | undefined,
  ): Promise<void> {
    await this.events.emit(tx, {
      topic: 'release.output-recovered',
      key: output.id,
      payload: outputEventPayload(output, release),
    });
  }

  /**
   * Counts a newly archived PDF towards the storage used. Best effort: the
   * output is done whatever happens here, and the next recount corrects
   * a total this missed.
   */
  private async countPdf(bytes: number): Promise<void> {
    try {
      await this.unit.run((tx) => this.quota.addPdf(tx, bytes), BOUNDED);
    } catch (error) {
      this.logger.warn(
        `An archived PDF was not counted towards the storage used: ${String(error)}`,
      );
    }
  }

  private async failed(output: ReleaseOutput, error: unknown): Promise<void> {
    if (!(error instanceof DomainError)) {
      this.logger.error(
        `Rendering output ${output.id} of release ${output.releaseId} failed`,
        error,
      );
    }
    const kept = outputErrorOf(error);
    if (isPermanent(error)) {
      await this.fail.handle({
        outputId: output.id,
        retries: output.retries,
        error: kept,
      });
      return;
    }
    await this.outputs.noteError(output.id, kept, output.retries);
    throw error;
  }

  /** The PDF of `output`, rendered at the release's tag as the manual's audience reads it. */
  private async render(
    release: Release,
    output: ReleaseOutput,
  ): Promise<Uint8Array> {
    const open = async (actor: typeof RELEASE_READER) => {
      const content = await this.openSnapshot.handle({
        actor,
        ref: release.tag,
      });
      if (content.commit !== release.commit) {
        throw new NotFoundError(`The tag of release ${release.id} moved.`);
      }
      return content;
    };
    const all = await open(RELEASE_READER);
    const config = await all.config();
    const actor = outputRenderer(output.audience, config);
    const snapshot = await open(actor);
    // As planned: outputs share a file only where they print the same code.
    const qrCode = output.qrCode ?? undefined;
    const { pdf } = await this.renderPdf.handle({
      actor,
      snapshot,
      id: output.manualId,
      variant: output.variant,
      lang: output.lang,
      ...(qrCode && { qrCode }),
      // What its page design prints of the release (#395): its revision and its date.
      release: releaseFacts(release),
      // Bulk work: after what readers wait for, and kept out of their cache.
      background: true,
    });
    return pdf;
  }
}
