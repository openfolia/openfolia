import type { PageRequest, Paginated } from '../../base/core/paging.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import type {
  AudienceLang,
  NewReleaseOutput,
  OutputCounts,
  OutputError,
  OutputFilter,
  OutputKind,
  PlanRefusal,
  ReleaseOutput,
} from './release-output.js';

/** What places an output in its reuse group (#497). */
export type GroupMember = Pick<
  ReleaseOutput,
  | 'releaseId'
  | 'reuseGroup'
  | 'manualId'
  | 'variant'
  | 'lang'
  | 'kind'
  | 'audience'
>;

/** One reuse group joined into another (`ReleaseOutputStore.joinGroups`). */
export interface GroupJoin extends Pick<
  ReleaseOutput,
  'manualId' | 'variant' | 'lang' | 'kind' | 'audience'
> {
  readonly from: string;
  readonly into: string;
}

/**
 * Port: the outputs of releases (Postgres, `release_outputs`, #249). One
 * row per release, kind, manual, variant and language; its state moves
 * only by compare-and-swap, and a `done` one never leaves `done`, so a
 * failure never replaces a good file.
 */
export abstract class ReleaseOutputStore {
  /**
   * Writes the planned outputs inside `tx`, but those the release has
   * already (its kind, manual, variant and language); the ones written.
   */
  abstract insertMissing(
    tx: Transaction,
    outputs: readonly NewReleaseOutput[],
  ): Promise<ReleaseOutput[]>;

  /** The output `id`; undefined for none (or a malformed ID). */
  abstract find(id: string): Promise<ReleaseOutput | undefined>;

  /**
   * The release's output of one manual, variant and language, of `kind` (#450, a stable
   * address's file); undefined for none.
   */
  abstract findOf(
    releaseId: string,
    of: {
      readonly manualId: string;
      readonly variant: string;
      readonly lang: string;
      readonly kind: OutputKind;
    },
  ): Promise<ReleaseOutput | undefined>;

  /**
   * The outputs of one manual, variant and language, of `kind`, of each of `releaseIds` that has
   * one (#139, a download's versions): at most one per release, in no order.
   */
  abstract across(
    releaseIds: readonly string[],
    of: {
      readonly manualId: string;
      readonly variant: string;
      readonly lang: string;
      readonly kind: OutputKind;
    },
  ): Promise<ReleaseOutput[]>;

  /** Every output of the release (at most `ReleaseOutputSettings.maxOutputs`), in list order. */
  abstract all(releaseId: string): Promise<ReleaseOutput[]>;

  /** The distinct manual audiences and languages among the release's outputs. */
  abstract audiences(releaseId: string): Promise<AudienceLang[]>;

  /** How many of the release's outputs whose audience and language are among `visible` are in each state. */
  abstract counts(
    releaseId: string,
    visible: readonly AudienceLang[],
  ): Promise<OutputCounts>;

  /**
   * One page of the release's outputs matching `filter` whose audience
   * and language are among `visible`, by manual, variant, language and
   * kind.
   */
  abstract list(
    releaseId: string,
    filter: OutputFilter,
    visible: readonly AudienceLang[],
    page: PageRequest,
  ): Promise<Paginated<ReleaseOutput>>;

  /**
   * An attempt starts: `queued` or `rendering` becomes `rendering`, one
   * more attempt counted, while its retry count is `retries` (the job
   * starting it is its current one); the output then, or undefined
   * (nothing changed) when it is `done` or `failed`, gone, or was queued
   * again since.
   */
  abstract start(
    id: string,
    retries: number,
  ): Promise<ReleaseOutput | undefined>;

  /**
   * Its file is stored: any state but `done` becomes `done`, with the
   * file's hash and size and no error, inside `tx` when given. The output
   * as it was before (a `failed` one, say, which a late file finishes:
   * #551), or undefined when it was `done` already.
   *
   * Under the file's hash lock (`AssetUploads.lockHash`, #593), taken
   * before the row and held until `tx` ends: a file delete checks the
   * release outputs under that lock and removes the blob before letting
   * it go, so it either sees this output (and keeps the file) or ends
   * first, and the caller, still under the lock, finds the blob gone.
   */
  abstract finish(
    id: string,
    file: { readonly sha256: string; readonly size: number },
    tx?: Transaction,
  ): Promise<ReleaseOutput | undefined>;

  /** Keeps why the latest attempt failed, while it is `queued` or `rendering` at retry count `retries`. */
  abstract noteError(
    id: string,
    error: OutputError,
    retries: number,
  ): Promise<void>;

  /**
   * Fails it for good inside `tx`: `queued` or `rendering` becomes
   * `failed`, with `error` (else the error noted last), while its retry
   * count is `retries` (the job reporting it is its current one); the
   * output then, or undefined (nothing changed) when it is `done` or
   * `failed` already, or was queued again since.
   */
  abstract fail(
    tx: Transaction,
    id: string,
    error: OutputError | undefined,
    retries: number,
  ): Promise<ReleaseOutput | undefined>;

  /**
   * Queues a failed output again inside `tx`: `failed` becomes `queued`
   * and scheduled (its job is queued with it), one more retry counted, the
   * error cleared; the output then, or undefined (nothing changed) when it
   * was not `failed`.
   */
  abstract requeue(
    tx: Transaction,
    id: string,
  ): Promise<ReleaseOutput | undefined>;

  /**
   * Queues more of the release's outputs inside `tx` (#497): of its
   * `queued` outputs not scheduled yet, in list order, as many as `limit`
   * leaves beside those scheduled and not finished (queued or rendering)
   * are marked scheduled now. One at a time per release (concurrent calls
   * wait for each other), so a release never has more than `limit`
   * scheduled at once; the ones marked, whose render jobs the caller
   * queues in the same transaction.
   */
  abstract schedule(
    tx: Transaction,
    releaseId: string,
    limit: number,
  ): Promise<ReleaseOutput[]>;

  /**
   * Moves a `queued` output up the queue inside `tx` (#497): someone asked
   * for its file now. Under the lock `schedule` holds for its release, and
   * only while fewer than `limit` of the release's unfinished outputs were
   * moved up already: then it is marked promoted (and scheduled, if it was
   * not; `scheduled` says so: its job is the caller's to queue). Undefined
   * when nothing changed (not queued, moved up already, or at the limit).
   */
  abstract promote(
    tx: Transaction,
    id: string,
    limit: number,
  ): Promise<{ output: ReleaseOutput; scheduled: boolean } | undefined>;

  /**
   * Releases with outputs still to render (queued or rendering) none of
   * which moved since `before` (started, ended or scheduled), by release
   * ID, those after `after` (a cursor: the last one of the previous page),
   * at most `limit` (#497): those whose render jobs may be lost.
   */
  abstract stalled(
    before: Date,
    limit: number,
    after?: string,
  ): Promise<string[]>;

  /**
   * Where the stalled-outputs sweep stopped (#527): the last release ID the
   * previous sweep looked at (`after`, undefined: from the first) and the
   * cursor's `version`, kept in the database so every server's sweep goes
   * on after the last one, whichever server ran it, also after a restart.
   */
  abstract sweepCursor(): Promise<{ after?: string; version: number }>;

  /**
   * Moves the sweep's cursor to `after` (undefined: back to the first), if
   * it is still at `version` (compare-and-swap); `false` when another
   * server moved it first, which then sweeps that window itself.
   */
  abstract moveSweepCursor(
    version: number,
    after: string | undefined,
  ): Promise<boolean>;

  /** The release's outputs that are scheduled and not finished (queued or rendering): those that have a render job. */
  abstract scheduled(releaseId: string): Promise<ReleaseOutput[]>;

  /**
   * A `done` output of `output`'s reuse group (#497), if one is: of the
   * same manual, variant, language, kind and audience, so a file is only
   * ever reused for the same inputs, whatever a group ID says), whose file
   * was rendered for `output`'s release or one cut before it: a file
   * never carries a later commit than the release it is reused for.
   */
  abstract doneIn(output: GroupMember): Promise<ReleaseOutput | undefined>;

  /**
   * The output of `output`'s reuse group (the same inputs, as `doneIn`)
   * still to render (queued or rendering) whose release was cut first
   * (#497); `output` itself when it is that one or has no group. Its
   * release's file serves every member cut at or after it.
   */
  abstract oldestPendingIn(
    output: GroupMember & { readonly id: string },
  ): Promise<ReleaseOutput | undefined>;

  /**
   * Every `queued` or `rendering` output of `output`'s reuse group (of the
   * same manual, variant, language, kind and audience, as `doneIn`) of a
   * release cut at or after `from`'s becomes `done` with `file`, reusing
   * the output that holds it (`from`), without a render (#497): the same
   * inputs, and never a file of a later commit than its own release's.
   * Inside `tx` when given. The outputs it finished, as they are now.
   *
   * Under the file's hash lock, as `finish`, taken before any member's
   * row. Each call locks its one file; a transaction that records several
   * files must not take their locks in any other than hash order (the
   * render's records one file: `finish` and `finishGroup` lock the same).
   */
  abstract finishGroup(
    output: GroupMember,
    file: { readonly sha256: string; readonly size: number },
    from: { readonly releaseId: string; readonly outputId: string },
    tx?: Transaction,
  ): Promise<ReleaseOutput[]>;

  /** Which of `releaseIds` have outputs (#497: planned, wholly or in part). */
  abstract planned(releaseIds: readonly string[]): Promise<Set<string>>;

  /** Records that the release's planning ran to its end (#527); once, kept. */
  abstract markPlanned(releaseId: string): Promise<void>;

  /** Which of `releaseIds` were planned to the end (`markPlanned`, #527), with when. */
  abstract plannedWholly(
    releaseIds: readonly string[],
  ): Promise<ReadonlyMap<string, Date>>;

  /**
   * Joins reuse groups inside `tx` (#497): every output of group `from` with the very inputs
   * named (manual, variant, language, kind and audience) moves to group `into`. For a release
   * planned after a later one: its output has the same inputs as both, so their groups are one.
   * Changes only which group an output is in, never its state or file.
   */
  abstract joinGroups(
    tx: Transaction,
    joins: readonly GroupJoin[],
  ): Promise<void>;

  /**
   * How many outputs of the same product's releases cut after `release`
   * (by `publishedAt`, then ID) are queued or rendering (#497): what
   * renders before its own. Only that product's: other products' releases
   * are not the caller's to know of.
   */
  abstract ahead(release: {
    readonly id: string;
    readonly publishedAt: Date;
    readonly product: string;
    readonly productFacet: string;
  }): Promise<number>;

  /** The release's refused planning (#477); undefined for none. */
  abstract refusal(releaseId: string): Promise<PlanRefusal | undefined>;

  /**
   * Records that the release's planning was refused, replacing an earlier
   * refusal; false when one with the same reason, count and limit was
   * recorded already (nothing changed, so nothing new to tell).
   */
  abstract refuse(
    releaseId: string,
    refusal: Omit<PlanRefusal, 'refusedAt'>,
  ): Promise<boolean>;

  /** Forgets the release's refused planning inside `tx` (it is planned now). */
  abstract clearRefusal(tx: Transaction, releaseId: string): Promise<void>;
}
