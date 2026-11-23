import { Injectable, Logger } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { allows } from '../../../access/core/allows.js';
import { ActorAction } from '../../../access/core/policy.js';
import { AuditLog } from '../../../audit/core/audit-log.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import type { PageRequest, Paginated } from '../../../base/core/paging.js';
import { UnitOfWork } from '../../../base/core/unit-of-work.js';
import { BlobStore, type StoredBlob } from '../../../blobs/core/blob-store.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import {
  DesignsInUse,
  type DesignInUse,
} from '../../../content/core/design-in-use.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import { JobQueue } from '../../../jobs/core/job-queue.js';
import type { Release } from '../release.js';
import {
  type AudienceLang,
  INTERACTIVE_PRIORITY,
  MAX_RETRIES,
  type OutputFilter,
  type OutputsProgress,
  type OutputsQueue,
  type OutputsRefusal,
  outputsProgress,
  outputFileName,
  PLAN_RELEASE_OUTPUTS,
  outputJob,
  type ReleaseOutput,
  ReleaseOutputSettings,
} from '../release-output.js';
import { ReleaseOutputStore } from '../release-output-store.js';
import { ReleaseStore } from '../release-store.js';
import { earlierToPlan } from '../planning-order.js';
import {
  productTarget,
  RELEASE_OUTSIDE_SCOPE,
} from './create-release.action.js';
import { ReaderPromotions } from '../reader-promotions.js';
import { ScheduleReleaseOutputsAction } from './schedule-release-outputs.action.js';

/** The release and its tag, opened as `actor` reads released content; 404 for either missing. */
export async function releaseAt(
  store: ReleaseStore,
  snapshots: OpenSnapshotAction,
  actor: Actor,
  id: string,
): Promise<{ release: Release; content: ReadableContent }> {
  const release = await store.find(id);
  if (!release) throw new NotFoundError(`No release "${id}".`);
  const content = await snapshots.handle({ actor, ref: release.tag });
  if (content.commit !== release.commit) {
    throw new NotFoundError(`No release "${id}".`);
  }
  return { release, content };
}

/** The output of the release, when one role of the reader covers all of its manual in its language at the tag (`seesWholeManualIn`). */
async function outputFor(
  outputs: ReleaseOutputStore,
  content: ReadableContent,
  release: Release,
  outputId: string,
): Promise<ReleaseOutput> {
  const output = await outputs.find(outputId);
  if (
    !output ||
    output.releaseId !== release.id ||
    !(await content.seesWholeManualIn(
      output.audience ?? undefined,
      output.lang,
    ))
  ) {
    throw new NotFoundError(`No output "${outputId}" of this release.`);
  }
  return output;
}

/**
 * The audiences and languages among the release's outputs whose manual
 * the reader reads whole at its tag (`seesWholeManualIn`): the outputs
 * they may see.
 */
export async function visibleIn(
  outputs: ReleaseOutputStore,
  content: ReadableContent,
  releaseId: string,
): Promise<AudienceLang[]> {
  const visible: AudienceLang[] = [];
  for (const pair of await outputs.audiences(releaseId)) {
    if (
      await content.seesWholeManualIn(pair.audience ?? undefined, pair.lang)
    ) {
      visible.push(pair);
    }
  }
  return visible;
}

/**
 * Where the release's outputs stand for this reader (#456, the release's
 * `meta.outputs`): whether they are still being planned (the
 * `release.plan-outputs` job, keyed by the release), and how many of
 * those they may read (as `GET /releases/:id/outputs` judges it, so no
 * count tells of one outside their scope) are in each state; and a
 * planning refused (#477, `too-many-outputs`), with the count only for a
 * publisher of the product (it counts every manual at the tag); and,
 * while its planning waits, how many of the product's earlier releases
 * are planned before it (#527), and while some of its outputs wait to
 * render, how many of the product's later releases' render before them
 * (#497, `queue`: for a publisher of
 * the product only, as it counts every manual; null for anyone else). Null when the release's tag
 * cannot be opened as theirs (missing, or moved).
 */
@Injectable()
export class ReleaseOutputsProgressAction extends ActorAction<
  { actor: Actor; release: Release; withQueue?: boolean },
  OutputsProgress | null
> {
  readonly policy = 'content.read';

  constructor(
    private readonly outputs: ReleaseOutputStore,
    private readonly snapshots: OpenSnapshotAction,
    private readonly jobs: JobQueue,
    private readonly settings: ReleaseOutputSettings,
    private readonly releases: ReleaseStore,
  ) {
    super();
  }

  /**
   * How many of the same product's releases cut before `release` are still to be planned
   * (#527, `earlierToPlan`): planned strictly in the order cut, they go before it. Among the
   * nearest `NEIGHBOURS_SCANNED`.
   */
  private async plansAhead(release: Release): Promise<number> {
    return (
      await earlierToPlan(
        { releases: this.releases, outputs: this.outputs, jobs: this.jobs },
        release,
      )
    ).length;
  }

  protected async run({
    actor,
    release,
    withQueue = true,
  }: {
    actor: Actor;
    release: Release;
    /** Whether to count what waits ahead of it (`queue`); a list of releases does not. */
    withQueue?: boolean;
  }): Promise<OutputsProgress | null> {
    let content: ReadableContent;
    try {
      content = await this.snapshots.handle({ actor, ref: release.tag });
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
    if (content.commit !== release.commit) return null;
    const [counts, job, refusal, wholly] = await Promise.all([
      visibleIn(this.outputs, content, release.id).then((visible) =>
        this.outputs.counts(release.id, visible),
      ),
      this.jobs.latest(PLAN_RELEASE_OUTPUTS, release.id),
      this.outputs.refusal(release.id),
      this.outputs.plannedWholly([release.id]),
    ]);
    // Planned to the end (#527: perhaps in a later release's turn): a job of it from before
    // that, still to run or run out of tries waiting for the turn, says nothing more about it.
    // One queued since (a publisher's "plan again") still shows.
    const plannedAt = wholly.get(release.id);
    const planning =
      plannedAt && job && job.createdAt <= plannedAt ? undefined : job;
    let publishes: boolean | undefined;
    const publisher = async () =>
      (publishes ??= allows(
        actor,
        'release.publish',
        productTarget(
          await content.config(),
          release.productFacet,
          release.product,
        ),
      ));
    let refused: OutputsRefusal | null = null;
    // A refusal the limit has been raised past is no longer why: told as a planning that failed.
    if (refusal && refusal.wanted > this.settings.maxOutputs) {
      refused = {
        reason: refusal.reason,
        wanted: (await publisher()) ? refusal.wanted : null,
        // The limit now, as planning again is judged.
        max: this.settings.maxOutputs,
      };
    }
    // Its own wait (#497): its planning behind the planning of the
    // product's earlier releases (in the order cut, #527), its queued
    // outputs behind later releases' outputs still to render (newest
    // first). Only for a publisher of the product (who may plan it again):
    // the counts are of every manual of the product's other releases.
    // Anyone else gets null whatever the queue holds, so the answer tells
    // them nothing. Not counted for a list (`withQueue` false).
    let queue: OutputsQueue | null = null;
    // Running too: its job may hold the product's turn while the earlier ones are planned.
    const waitsToPlan =
      planning?.state === 'queued' ||
      planning?.state === 'retrying' ||
      planning?.state === 'running';
    if (
      withQueue &&
      (counts.queued > 0 || waitsToPlan) &&
      (await publisher())
    ) {
      const [ahead, releases] = await Promise.all([
        counts.queued > 0 ? this.outputs.ahead(release) : 0,
        waitsToPlan ? this.plansAhead(release) : 0,
      ]);
      if (ahead > 0 || releases > 0) queue = { ahead, releases };
    }
    // Its planning (refused) ended without outputs: until it is planned again, that failed.
    const stale = refusal !== undefined && refused === null;
    return outputsProgress(
      stale && (planning === undefined || planning.state === 'done')
        ? 'failed'
        : planning?.state,
      counts,
      refused,
      queue,
    );
  }
}

/** One page of a release's outputs, with the release. */
export interface ReleaseOutputsPage extends Paginated<ReleaseOutput> {
  readonly release: Release;
  /** The page design each manual on the page is printed with at the release's tag (#589), by manual ID. */
  readonly designs: ReadonlyMap<string, DesignInUse>;
}

/**
 * The page design each of `manualIds` is printed with at the release's tag (#589): its manifest's
 * `design`, else the configuration's `pdf.design`, else the built-in design, read once per
 * design. A manual that cannot be read there counts as naming none.
 */
export async function designsAt(
  content: ReadableContent,
  manualIds: Iterable<string>,
): Promise<Map<string, DesignInUse>> {
  const config = await content.config();
  const designs = new DesignsInUse(content);
  const found = new Map<string, DesignInUse>();
  for (const id of new Set(manualIds)) {
    const manual = await content.manual(id).catch(() => undefined);
    found.set(id, await designs.of(manual?.manifest ?? {}, config));
  }
  return found;
}

/**
 * `GET /releases/:id/outputs` (#249): the release's outputs whose manual
 * one role of the reader covers all of at the release's tag, in the
 * output's language (`seesWholeManualIn`: the manual's audience and the
 * language, with no module type or facet left out; filtered before
 * paging, so neither the list nor the total tells of one outside their
 * scope). Each is rendered as the manual's audience reads it, the same
 * file for all of them, so it may hold any module the manual names: a
 * reader whose scope leaves some out reads the manual's PDF route instead.
 */
@Injectable()
export class ListReleaseOutputsAction extends ActorAction<
  {
    actor: Actor;
    releaseId: string;
    filter: OutputFilter;
    page: PageRequest;
  },
  ReleaseOutputsPage
> {
  readonly policy = 'content.read';

  constructor(
    private readonly store: ReleaseStore,
    private readonly outputs: ReleaseOutputStore,
    private readonly snapshots: OpenSnapshotAction,
  ) {
    super();
  }

  protected async run({
    actor,
    releaseId,
    filter,
    page,
  }: {
    actor: Actor;
    releaseId: string;
    filter: OutputFilter;
    page: PageRequest;
  }): Promise<ReleaseOutputsPage> {
    const { release, content } = await releaseAt(
      this.store,
      this.snapshots,
      actor,
      releaseId,
    );
    const visible = await visibleIn(this.outputs, content, release.id);
    const found = await this.outputs.list(release.id, filter, visible, page);
    const designs = await designsAt(
      content,
      found.items
        .filter((output) => output.kind === 'pdf')
        .map((output) => output.manualId),
    );
    return { ...found, release, designs };
  }
}

/** An output's file, as `GET …/outputs/:outputId/file` sends it. */
export interface ReleaseOutputFile {
  readonly output: ReleaseOutput;
  readonly blob: StoredBlob;
  /** The name it downloads as (`outputFileName`). */
  readonly fileName: string;
}

/**
 * `GET /releases/:id/outputs/:outputId/file` (#249): the output's file
 * from the blob store, for a reader one of whose roles covers all of its
 * manual in its language at the release's tag (else 404, exactly like a
 * missing one).
 * Never renders: 409 `output-not-ready` until it is `done`. One still
 * queued goes ahead of every release's bulk work (#497,
 * `ScheduleReleaseOutputsAction.now`): someone waits for it now. That
 * starts no render it would not have had, only an earlier one.
 */
@Injectable()
export class ReleaseOutputFileAction extends ActorAction<
  { actor: Actor; releaseId: string; outputId: string },
  ReleaseOutputFile
> {
  readonly policy = 'content.read';
  private readonly logger = new Logger(ReleaseOutputFileAction.name);

  constructor(
    private readonly store: ReleaseStore,
    private readonly outputs: ReleaseOutputStore,
    private readonly snapshots: OpenSnapshotAction,
    private readonly blobs: BlobStore,
    private readonly schedule: ScheduleReleaseOutputsAction,
    private readonly promotions: ReaderPromotions,
  ) {
    super();
  }

  protected async run({
    actor,
    releaseId,
    outputId,
  }: {
    actor: Actor;
    releaseId: string;
    outputId: string;
  }): Promise<ReleaseOutputFile> {
    const { release, content } = await releaseAt(
      this.store,
      this.snapshots,
      actor,
      releaseId,
    );
    const output = await outputFor(this.outputs, content, release, outputId);
    if (output.state !== 'done' || output.sha256 === null) {
      // Best effort: the answer is 409 either way. Past the reader's own budget
      // (`PROMOTIONS_PER_READER` a minute) it waits its turn, unmoved. An offline
      // package (#59) is never moved up, and costs no place: it is built once the
      // release's PDFs are done. The place is reserved before the move is tried,
      // so parallel requests never overrun it.
      const place =
        output.state === 'queued' && output.kind === 'pdf'
          ? this.promotions.tryTake(actor)
          : undefined;
      if (place) {
        const moved = await this.schedule
          .now(output)
          .catch((error: unknown) => {
            this.logger.warn(
              `Output ${output.id} could not be moved up the queue: ${error instanceof Error ? error.message : String(error)}`,
            );
            // It may have moved before the failure: the place stays taken.
            return undefined;
          });
        // Nothing moved (moved up already, done meanwhile, the release's bound): costs nothing.
        if (moved === false) place.refund();
      }
      throw new ConflictError(
        'output-not-ready',
        `The output is ${output.state}, not done.`,
        { state: output.state },
      );
    }
    const blob = await this.blobs.get(output.sha256);
    if (!blob) {
      throw new NotFoundError('The output’s file is no longer stored.');
    }
    return {
      output,
      blob,
      fileName: outputFileName(output, release.revision),
    };
  }
}

/**
 * What retrying answers: the queued output in full for a publisher who
 * reads all of its manual (`seesWholeManualIn`, as `GET` judges it), else
 * only where it stands (#340), so retrying never shows a publisher what
 * reading the output would not.
 */
export type RetriedOutput =
  | {
      readonly release: Release;
      readonly whole: true;
      readonly output: ReleaseOutput;
      /** The page design its manual is printed with at the release's tag (#589); none for an offline package. */
      readonly design: DesignInUse | undefined;
    }
  | {
      readonly release: Release;
      readonly whole: false;
      readonly output: Pick<
        ReleaseOutput,
        'id' | 'state' | 'attempts' | 'retries'
      >;
    };

/**
 * `POST /releases/:id/outputs/:outputId/retry` (#249): queues a failed
 * output again (`failed` becomes `queued`, its render job enqueued and a
 * `release.output-retry` audit event, in one transaction). Needs what
 * cutting the release needs: `release.publish` in a role whose scope
 * covers its product in every language, module type and audience (judged
 * by the configuration at the release's commit), and `content.read`.
 * Only a failed output: anything else is 409 `output-not-failed`, so a
 * request never renders what is queued, rendering or done. Answers the
 * output in full only to a publisher who may read it (`RetriedOutput`).
 */
@Injectable()
export class RetryReleaseOutputAction extends ActorAction<
  { actor: Actor; releaseId: string; outputId: string },
  RetriedOutput
> {
  readonly policy = 'release.publish';

  constructor(
    private readonly store: ReleaseStore,
    private readonly outputs: ReleaseOutputStore,
    private readonly snapshots: OpenSnapshotAction,
    private readonly jobs: JobQueue,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected async run({
    actor,
    releaseId,
    outputId,
  }: {
    actor: Actor;
    releaseId: string;
    outputId: string;
  }): Promise<RetriedOutput> {
    const { release, content } = await releaseAt(
      this.store,
      this.snapshots,
      actor,
      releaseId,
    );
    const config = await content.config();
    if (
      !allows(
        actor,
        'release.publish',
        productTarget(config, release.productFacet, release.product),
      )
    ) {
      throw new ForbiddenError(RELEASE_OUTSIDE_SCOPE);
    }
    // A publisher of the product may queue any of its outputs again, read
    // or not (a role scoped to the product by a facet reads no output's
    // file): retrying shows nothing of the file, and of the output only
    // its state to one who may not read it (below).
    const output = await this.outputs.find(outputId);
    if (!output || output.releaseId !== release.id) {
      throw new NotFoundError(`No output "${outputId}" of this release.`);
    }
    const notFailed = (state: string) =>
      new ConflictError(
        'output-not-failed',
        `The output is ${state}: only a failed one is queued again.`,
        { state },
      );
    if (output.state !== 'failed') throw notFailed(output.state);
    if (output.retries >= MAX_RETRIES) {
      throw new ConflictError(
        'retry-limit',
        `The output was queued again ${MAX_RETRIES} times already: change the content and cut a new release.`,
        { retries: output.retries },
      );
    }
    // Judged before anything is written, so the answer needs no read after it.
    const whole = await content.seesWholeManualIn(
      output.audience ?? undefined,
      output.lang,
    );
    const queued = await this.unit.run(async (tx) => {
      const requeued = await this.outputs.requeue(tx, output.id);
      if (!requeued) return undefined;
      const job = await this.jobs.enqueue(
        outputJob(requeued),
        { outputId: requeued.id, retries: requeued.retries },
        // Someone waits for it (#497): ahead of every release's bulk work.
        { key: requeued.id, tx, priority: INTERACTIVE_PRIORITY },
      );
      // The job that failed it still holds its key while it ends: nothing
      // was queued, so nothing is changed (rolled back) and it is retried.
      if (job === undefined) {
        throw new ConflictError(
          'output-busy',
          'The output’s last attempt is still ending: try again in a moment.',
        );
      }
      await this.auditLog.record(tx, actor, {
        action: 'release.output-retry',
        subject: { type: 'release-output', id: requeued.id },
        data: {
          releaseId: release.id,
          tag: release.tag,
          manualId: requeued.manualId,
          variant: requeued.variant,
          lang: requeued.lang,
          kind: requeued.kind,
          retries: requeued.retries,
        },
      });
      return requeued;
    });
    if (!queued) {
      throw notFailed(
        (await this.outputs.find(output.id))?.state ?? output.state,
      );
    }
    if (whole) {
      // An offline package (#59) is printed with no design.
      const design =
        queued.kind === 'pdf'
          ? (await designsAt(content, [queued.manualId])).get(queued.manualId)
          : undefined;
      return { release, whole: true, output: queued, design };
    }
    const { id, state, attempts, retries } = queued;
    return { release, whole: false, output: { id, state, attempts, retries } };
  }
}

/**
 * `POST /releases/:id/outputs/plan` (#249): plans the release's outputs
 * again (`release.plan-outputs`, keyed by the release, and a
 * `release.outputs-plan` audit event, in one transaction), for a release
 * whose planning failed for good (an outage longer than the job's
 * retries) or was cut off. Planning writes only the rows the release does
 * not have and renders only those, so it never renders an output twice:
 * once every output is there, it changes nothing. Needs what retrying an
 * output needs. Queued ahead of other releases' planning (#497).
 * `queued` false: a planning job of the release is queued or running
 * already (one that waits is moved ahead). A release whose planning was refused for more
 * outputs than `maxOutputs` (#477, recorded by the planning job), still
 * over it, is 422 `too-many-outputs`, with the count and the limit, and
 * nothing is queued.
 */
@Injectable()
export class ReplanReleaseOutputsAction extends ActorAction<
  { actor: Actor; releaseId: string },
  { queued: boolean }
> {
  readonly policy = 'release.publish';

  constructor(
    private readonly store: ReleaseStore,
    private readonly snapshots: OpenSnapshotAction,
    private readonly jobs: JobQueue,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
    private readonly outputs: ReleaseOutputStore,
    private readonly settings: ReleaseOutputSettings,
  ) {
    super();
  }

  protected async run({
    actor,
    releaseId,
  }: {
    actor: Actor;
    releaseId: string;
  }): Promise<{ queued: boolean }> {
    const { release, content } = await releaseAt(
      this.store,
      this.snapshots,
      actor,
      releaseId,
    );
    const config = await content.config();
    if (
      !allows(
        actor,
        'release.publish',
        productTarget(config, release.productFacet, release.product),
      )
    ) {
      throw new ForbiddenError(RELEASE_OUTSIDE_SCOPE);
    }
    // Recorded by the planning job (which runs when the release is cut):
    // no tag is read here.
    const max = this.settings.maxOutputs;
    const wanted = (await this.outputs.refusal(release.id))?.wanted ?? 0;
    if (wanted > max) {
      throw new UnprocessableError(
        'too-many-outputs',
        `The release would have ${wanted} outputs, more than the ${max} a release may have (CCMS_RELEASE_MAX_OUTPUTS): none are planned.`,
        { wanted, max },
      );
    }
    const queued = await this.unit.run(async (tx) => {
      const job = await this.jobs.enqueue(
        PLAN_RELEASE_OUTPUTS,
        { releaseId: release.id },
        // Someone waits for it (#497): ahead of every release's planning.
        { key: release.id, priority: INTERACTIVE_PRIORITY, tx },
      );
      if (job === undefined) return { queued: false };
      await this.auditLog.record(tx, actor, {
        action: 'release.outputs-plan',
        subject: { type: 'release', id: release.id },
        data: { tag: release.tag },
      });
      return { queued: true };
    });
    return queued;
  }
}
