import type { ProjectConfig } from '@openfolia/content-model';
import { z } from 'zod';
import type { Actor } from '../../access/core/actor.js';
import { type JobState, MAX_JOB_PRIORITY } from '../../jobs/core/job-queue.js';
import { defineJob } from '../../jobs/core/job.js';
import {
  isChangeSetId,
  newChangeSetId,
} from '../../change-sets/core/change-set.js';

/**
 * What a release output is: a PDF of a manual in one variant and language
 * (#249), or an offline package (#59), a ZIP of every manual a language and
 * audience level reads, as HTML and PDF, that opens from the file system.
 */
export const OUTPUT_KINDS = ['pdf', 'offline-package'] as const;
export type OutputKind = (typeof OUTPUT_KINDS)[number];

/**
 * What an offline package's row names as its manual (#59): every manual of the
 * release its audience reads, so no manual (a manual's ID never holds `*`).
 */
export const PACKAGE_MANUAL = '*';

/**
 * What an offline package's row holds as its variant (#59): its audience level,
 * since the row's subject (release, manual, variant, language, kind) is unique
 * and a release has one package per language and level; `*` when no levels are
 * configured.
 */
export function packageVariant(audience: string | null): string {
  return audience ?? PACKAGE_MANUAL;
}

/**
 * Where an output stands: `queued` (its render job waits), `rendering`
 * (an attempt has started; a retry after a transient failure stays here),
 * `done` (its file is in the blob store) or `failed` (for good, with the
 * error; `POST …/retry` queues it again).
 */
export const OUTPUT_STATES = ['queued', 'rendering', 'done', 'failed'] as const;
export type OutputState = (typeof OUTPUT_STATES)[number];

/** Why an output failed: a stable code and a text safe to show its readers. */
export interface OutputError {
  readonly code: string;
  readonly detail: string;
}

/**
 * One file of a release (#249): a manual in one variant and language,
 * rendered at the release's tag as its audience reads it, kept in the
 * blob store by its hash. A manual the release did not change points at
 * the previous release's file (`reusedFrom`), so every release has a
 * full set.
 */
export interface ReleaseOutput {
  /** A UUID version 7, made by the server. */
  readonly id: string;
  readonly releaseId: string;
  readonly manualId: string;
  /** The variant's slug, e.g. `model=large`. */
  readonly variant: string;
  readonly lang: string;
  readonly kind: OutputKind;
  /**
   * The manual's audience at the release's tag (its manifest's; null for
   * none: the most restricted level): who may read the output is judged
   * by it, as for the manual.
   */
  readonly audience: string | null;
  readonly state: OutputState;
  /** The file's SHA-256 in the blob store; null until done. */
  readonly sha256: string | null;
  /** The file's size in bytes; null until done. */
  readonly size: number | null;
  readonly error: OutputError | null;
  /** The output (of an earlier release) whose file this one reuses; null when rendered for it. */
  readonly reusedFrom: {
    readonly releaseId: string;
    readonly outputId: string;
  } | null;
  /** Render attempts started, over every retry. */
  readonly attempts: number;
  /** How often it was queued again after failing (`POST …/retry`). */
  readonly retries: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** When it was done or failed; null while queued or rendering. */
  readonly finishedAt: Date | null;
  /**
   * When its render job was queued (#497); null for one that waits for
   * its turn (a release keeps at most `QUEUED_PER_RELEASE` at a time) or
   * needs none (reused).
   */
  readonly scheduledAt: Date | null;
  /**
   * Its reuse group (#497): the outputs of the same manual, variant and
   * language in releases that changed nothing it shows, so the same file
   * serves them all, whichever of them is rendered first. The group's
   * first output's ID; null for rows planned before groups were kept.
   */
  readonly reuseGroup: string | null;
  /**
   * When someone asked for its file before it was rendered (#497), which
   * moved it up the queue; null otherwise. A release has at most
   * `PROMOTED_PER_RELEASE` such outputs unfinished at a time.
   */
  readonly promotedAt: Date | null;
  /**
   * The QR code its file prints (#450): the stable address and where, decided when it was
   * planned (`delivery.pdfQrCode`, `CCMS_PUBLIC_URL`); null for none. Part of what makes two
   * outputs the same file: one is reused only for an output that prints the same. Planning a
   * release again keeps the code of the rows it has already (they are never written twice).
   */
  readonly qrCode: OutputQrCode | null;
}

/** A QR code a release's PDF prints (`ReleaseOutput.qrCode`). */
export interface OutputQrCode {
  readonly url: string;
  readonly placement: 'title-page' | 'back-cover';
}

/** Whether two outputs print the same QR code (or both none). */
export function sameQrCode(
  a: OutputQrCode | null,
  b: OutputQrCode | null,
): boolean {
  return a === null || b === null
    ? a === b
    : a.url === b.url && a.placement === b.placement;
}

/** An output as planned: what `ReleaseOutputStore.insertMissing` writes. */
export type NewReleaseOutput = Pick<
  ReleaseOutput,
  | 'id'
  | 'releaseId'
  | 'manualId'
  | 'variant'
  | 'lang'
  | 'kind'
  | 'audience'
  | 'state'
  | 'sha256'
  | 'size'
  | 'reusedFrom'
  | 'qrCode'
> & { readonly reuseGroup: string };

/** Which of a release's outputs to list; every field optional. */
export interface OutputFilter {
  readonly manual?: string;
  /** Only outputs of this kind (#59: `filter[kind]`). */
  readonly kind?: OutputKind;
  readonly lang?: string;
  readonly state?: OutputState;
}

/** A manual's audience (null: none) and a language: what deciding who reads an output takes. */
export interface AudienceLang {
  readonly audience: string | null;
  readonly lang: string;
}

/** How many of a release's outputs are in each state. */
export type OutputCounts = Readonly<Record<OutputState, number>>;

/**
 * Why a release's outputs were not planned (#477): `too-many-outputs`, more
 * of them (every manual × variant × language at its tag) than
 * `ReleaseOutputSettings.maxOutputs`. Recorded, so the planning is not
 * tried (and logged) again until the limit is raised.
 */
export const PLAN_REFUSAL_REASONS = ['too-many-outputs'] as const;
export type PlanRefusalReason = (typeof PLAN_REFUSAL_REASONS)[number];

/** A planning refused (#477): why, how many outputs the release would have, and the limit then. */
export interface PlanRefusal {
  readonly reason: PlanRefusalReason;
  /** The outputs the release would have. */
  readonly wanted: number;
  /** The limit it was refused at (`maxOutputs`). */
  readonly max: number;
  readonly refusedAt: Date;
}

/**
 * Where a release's outputs stand, as a reader sees them (#456): `planning`
 * while the planning job is queued, running or waiting to retry;
 * `rendering` while any output is queued or rendering; then `failed` when
 * any failed, or planning failed for good or was cancelled (it may have
 * planned some batches: the set is incomplete) or was refused
 * (`refused`), else `done`
 * (with `total` 0: the release has no outputs the reader may read).
 */
export const OUTPUTS_STATES = [
  'planning',
  'rendering',
  'done',
  'failed',
] as const;
export type OutputsState = (typeof OUTPUTS_STATES)[number];

/**
 * A refused planning as a reader sees it: `wanted` only for one who may
 * plan the release again (a publisher of its product), since it counts
 * every manual of the tag, read or not.
 */
export interface OutputsRefusal {
  readonly reason: PlanRefusalReason;
  readonly wanted: number | null;
  readonly max: number;
}

/**
 * Where a release's outputs wait (#497): while its planning waits, behind
 * the planning of `releases` releases cut before it (in the order cut,
 * #527); while
 * its queued outputs wait, behind `ahead` outputs of releases cut after it
 * (queued or rendering, newest first). Counted over every manual, so only
 * for one who may plan the release again (a publisher of its product);
 * null for other readers.
 */
export interface OutputsQueue {
  /** Outputs of the same product's releases cut after it, queued or rendering. */
  readonly ahead: number;
  /** The same product's releases cut before it still to be planned, planned first (#527). */
  readonly releases: number;
}

export interface OutputsProgress {
  readonly state: OutputsState;
  readonly total: number;
  readonly queued: number;
  readonly rendering: number;
  readonly done: number;
  readonly failed: number;
  /** Why the outputs were not planned; null when they were (or are being). */
  readonly refused: OutputsRefusal | null;
  /**
   * While it waits behind other releases' planning or outputs (#497); null
   * otherwise.
   */
  readonly queue: OutputsQueue | null;
}

/**
 * The progress of a release's outputs from its planning job's state
 * (`undefined`: none found, never enqueued or cleaned up), the counts
 * of the outputs the reader may read and a refused planning (null for
 * none).
 */
export function outputsProgress(
  planning: JobState | undefined,
  counts: OutputCounts,
  refused: OutputsRefusal | null = null,
  queue: OutputsQueue | null = null,
): OutputsProgress {
  const total = counts.queued + counts.rendering + counts.done + counts.failed;
  const active =
    planning === 'queued' || planning === 'running' || planning === 'retrying';
  const state: OutputsState = active
    ? 'planning'
    : counts.queued + counts.rendering > 0
      ? 'rendering'
      : refused !== null ||
          counts.failed > 0 ||
          // Planned in batches: one that failed for good may have left some.
          planning === 'failed' ||
          planning === 'cancelled'
        ? 'failed'
        : 'done';
  return {
    state,
    total,
    ...counts,
    // While it is planned again, the refusal is no longer the last word.
    refused: active ? null : refused,
    queue: queueWhile(state, planning, counts, queue),
  };
}

/**
 * The queue a progress tells of (#497): while its planning waits (queued, to retry, or running
 * while the product's earlier releases are planned in its turn, #527) behind earlier releases'
 * planning, with the files ahead its own rows wait for, if any; while it
 * renders, the files ahead while some of its own wait. Null when nothing is ahead.
 */
function queueWhile(
  state: OutputsState,
  planning: JobState | undefined,
  counts: OutputCounts,
  queue: OutputsQueue | null,
): OutputsQueue | null {
  if (!queue) return null;
  if (state === 'planning') {
    if (queue.releases === 0) return null;
    return {
      ahead: counts.queued > 0 ? queue.ahead : 0,
      releases: queue.releases,
    };
  }
  if (state === 'rendering' && counts.queued > 0 && queue.ahead > 0) {
    return { ahead: queue.ahead, releases: 0 };
  }
  return null;
}

export const newOutputId = newChangeSetId;
export const isOutputId = isChangeSetId;

/**
 * How many outputs one release may have (#477; manuals × variants ×
 * languages at its tag, `CCMS_RELEASE_MAX_OUTPUTS`): a release with more
 * gets none, and its planning is recorded as refused (`PlanRefusal`), seen
 * in its `meta.outputs` and the answer of `POST …/outputs/plan`: rendering
 * is costly, and a release is no way to start unbounded work.
 */
export abstract class ReleaseOutputSettings {
  abstract readonly maxOutputs: number;
  /**
   * How many outputs one server renders at once (#497,
   * `CCMS_RENDER_CONCURRENCY`): at most the PDF workers it has, by
   * default half of them, so readers' PDFs and previews always find one,
   * and all of them on a `worker`, which serves no readers
   * (`defaultRenderConcurrencyFor`, `config/role.ts`).
   */
  abstract readonly renderConcurrency: number;
  /**
   * Whether a release gets its offline packages (#59, `CCMS_OFFLINE_PACKAGES`,
   * default true): one per language and audience level.
   */
  abstract readonly offlinePackages: boolean;
}

/**
 * The most render jobs (#497) one release has queued at a time, beyond
 * what renders: the rest of its outputs wait as rows (`scheduledAt`
 * null) and are queued as these end (`ScheduleReleaseOutputsAction`). So
 * the job queue holds a few dozen per release, not every output of every
 * release (pg-boss warns past 10,000 queued jobs of one kind).
 */
export const QUEUED_PER_RELEASE = 40;

/**
 * The job priority of work someone waits for (#497): a failed output queued
 * again, a release planned again, a file asked for before it was rendered.
 * Ahead of every release's bulk work.
 */
export const INTERACTIVE_PRIORITY = MAX_JOB_PRIORITY;

/**
 * The job priority of an output whose file a reader asked for before it
 * was rendered (#497): ahead of every release's bulk work, just behind a
 * publisher's retry or replan (`INTERACTIVE_PRIORITY`), so readers asking
 * for many files never hold those up.
 */
export const PROMOTED_PRIORITY = MAX_JOB_PRIORITY - 1;

/**
 * At most this many of a release's outputs are moved up the queue at a
 * time by readers asking for their files (#497), beside its
 * `QUEUED_PER_RELEASE`: a reader asking for every file of a large backlog
 * moves only these, so the queue stays bounded and the release's order
 * mostly stands. One asked for past it waits its turn (still 409).
 */
export const PROMOTED_PER_RELEASE = 8;

/** 2020-01-01, in seconds: where `releasePriority` counts from. */
const PRIORITY_EPOCH_SECONDS = Date.UTC(2020, 0, 1) / 1000;

/**
 * The job priority of a release's planning and render jobs (#497): the
 * later it was cut, the sooner (seconds since 2020), so a new release's
 * files come before older releases' backlog, and below
 * `PROMOTED_PRIORITY` and `INTERACTIVE_PRIORITY`.
 */
export function releasePriority(release: {
  readonly publishedAt: Date;
}): number {
  const seconds =
    Math.floor(release.publishedAt.getTime() / 1000) - PRIORITY_EPOCH_SECONDS;
  return Math.min(Math.max(seconds, 1), PROMOTED_PRIORITY - 1);
}

/** `CCMS_RELEASE_MAX_OUTPUTS`: its default, well above a repository of 300 manuals in 8 languages (about 6,000). */
export const DEFAULT_MAX_OUTPUTS = 20_000;

/** `CCMS_RELEASE_MAX_OUTPUTS`: its largest value. */
export const MAX_MAX_OUTPUTS = 1_000_000;

/**
 * Outputs planned per transaction (their rows and render jobs): a large
 * release is planned in batches, each kept once written, so a planning cut
 * off goes on where it stopped.
 */
export const PLAN_BATCH = 500;

/**
 * How many releases planning looks through on each side for the nearest ones already planned
 * (#497): past them a release shares no files with its neighbours, and renders its own. Also
 * the most earlier releases planned before one, in its turn (#527, `earlierToPlan`), and so
 * counted ahead of it (`OutputsQueue.releases`).
 */
export const NEIGHBOURS_SCANNED = 200;

/** The largest PDF kept as a release output, in bytes. */
export const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;

/**
 * How often one output may be queued again after failing
 * (`POST …/retry`): a failure that keeps coming back needs a change of
 * content, not another render.
 */
export const MAX_RETRIES = 10;

/** The longest error detail kept with an output, in characters. */
export const MAX_ERROR_DETAIL = 1_000;

/**
 * Planning a release's outputs: one job per release, enqueued in the
 * transaction that publishes it, so it exists exactly when the release
 * does. Its steps are idempotent (`PlanReleaseOutputsAction`).
 */
export const PLAN_RELEASE_OUTPUTS = defineJob({
  name: 'release.plan-outputs',
  payload: z.strictObject({ releaseId: z.uuid() }),
  retryLimit: 5,
  retryDelaySeconds: 30,
  timeoutSeconds: 15 * 60,
  concurrency: 1,
});
export type PlanReleaseOutputsPayload = z.infer<
  typeof PLAN_RELEASE_OUTPUTS.payload
>;

/**
 * Rendering one output (`release.outputs`): its job names the output
 * row, nothing else. `CCMS_RENDER_CONCURRENCY` at a time per server
 * (`ReleaseOutputSettings.renderConcurrency`, the handler's), on the PDF
 * workers readers share but after what they wait for (`background`); a
 * transient failure (the renderer busy, the blob store down) is retried
 * after 30 s, 60 s, 120 s, … (`RenderReleaseOutputAction`).
 */
export const RENDER_RELEASE_OUTPUT = defineJob({
  name: 'release.outputs',
  payload: z.strictObject({
    outputId: z.uuid(),
    /**
     * The output's retry count when the job was queued: a job's report
     * of failing for good (`failed`) fails the output only while it is
     * still that one's, never one queued again since.
     */
    retries: z.number().int().min(0),
  }),
  retryLimit: 5,
  retryDelaySeconds: 30,
  // An older release's renders may wait long behind newer ones' (#497):
  // a job dropped unrun would hold one of its release's places.
  retentionSeconds: 365 * 86_400,
  timeoutSeconds: 10 * 60,
  concurrency: 1,
});
/**
 * Builds a release's offline package (#59): the same payload and the same
 * action as `release.outputs`, but a job of its own, as a package is one
 * long piece of work (every manual of a level, its PDFs and media): two
 * hours an attempt, two retries, one at a time per server, and the attempt
 * stops between files once it is cut off (`signal`).
 */
export const BUILD_OFFLINE_PACKAGE = defineJob({
  name: 'release.offline-package',
  payload: RENDER_RELEASE_OUTPUT.payload,
  retryLimit: 2,
  retryDelaySeconds: 60,
  retentionSeconds: 365 * 86_400,
  timeoutSeconds: 2 * 3_600,
  concurrency: 1,
});

/** The job that makes `output`: a PDF's render, or an offline package's build. */
export function outputJob(
  output: Pick<ReleaseOutput, 'kind'>,
): typeof RENDER_RELEASE_OUTPUT {
  return output.kind === 'offline-package'
    ? BUILD_OFFLINE_PACKAGE
    : RENDER_RELEASE_OUTPUT;
}

export type RenderReleaseOutputPayload = z.infer<
  typeof RENDER_RELEASE_OUTPUT.payload
>;

/**
 * Who renders a release's outputs of a manual: a service reading released
 * content (`content.read`) up to the manual's audience, and nothing past
 * it. Not the publisher, nor any reader: so the file is the same for
 * everyone who may read the manual. `audience` null (none in the
 * manifest) is the most restricted configured level.
 */
export function outputRenderer(
  audience: string | null,
  config: Pick<ProjectConfig, 'audiences'>,
): Actor {
  const maxAudience = audience ?? config.audiences.at(-1)?.id;
  return {
    kind: 'service',
    // Outside the `UserId` format (":"), so no user can have this ID.
    id: 'service:release-outputs',
    roles: [
      {
        id: 'release-output-renderer',
        name: 'Release outputs (read-only)',
        permissions: ['content.read'],
        scope: maxAudience === undefined ? {} : { maxAudience },
      },
    ],
  };
}

/**
 * The name an output's file downloads as: the manual, its variant, its
 * language and the release's revision, e.g.
 * `operating_model-small_en_2.1.pdf` (each part ASCII letters, digits, `.`
 * and `-` only, anything else `-`; the parts joined by `_`).
 */
export function outputFileName(
  output: Pick<
    ReleaseOutput,
    'manualId' | 'variant' | 'lang' | 'kind' | 'audience'
  >,
  revision: string,
): string {
  const part = (text: string) => text.replace(/[^A-Za-z0-9.-]+/g, '-');
  // An offline package (#59): `offline_<audience>_<lang>_<revision>.zip`.
  if (output.kind === 'offline-package') {
    return `${['offline', output.audience ?? 'all', output.lang, revision].map(part).join('_')}.zip`;
  }
  return `${[output.manualId, output.variant, output.lang, revision].map(part).join('_')}.${output.kind}`;
}
