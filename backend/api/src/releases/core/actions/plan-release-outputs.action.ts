import { Injectable, Logger } from '@nestjs/common';
import {
  deliverySlug,
  variantSlug,
  type ProjectConfig,
} from '@openfolia/content-model';
import type { UnguardedAction } from '../../../access/core/policy.js';
import {
  InvalidContentError,
  NotFoundError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import { UnitOfWork } from '../../../base/core/unit-of-work.js';
import { ChangeSetBranches } from '../../../change-sets/core/change-set-branches.js';
import { changedPathsWithin } from '../../../change-sets/core/review-scope.js';
import { subjectOfPath } from '../../../change-sets/core/subject-kinds.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import { DesignsInUse } from '../../../content/core/design-in-use.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import {
  absoluteUrl,
  addressPath,
  deliveryAccess,
  StableAddressSettings,
} from '../../../addresses/core/stable-address.js';
import type { Release } from '../release.js';
import { RELEASE_READER } from '../release-changes.js';
import {
  NEIGHBOURS_SCANNED,
  newOutputId,
  type NewReleaseOutput,
  PACKAGE_MANUAL,
  packageVariant,
  type OutputQrCode,
  sameQrCode,
  PLAN_BATCH,
  type ReleaseOutput,
  ReleaseOutputSettings,
} from '../release-output.js';
import { type GroupJoin, ReleaseOutputStore } from '../release-output-store.js';
import { ReleaseStore } from '../release-store.js';
import { JobQueue } from '../../../jobs/core/job-queue.js';
import { EARLIER_PLANNING_MS, earlierToPlan } from '../planning-order.js';
import { PlanningTurns } from '../planning-turns.js';
import { ReleaseChangeReader } from './release-changes.action.js';
import { ScheduleReleaseOutputsAction } from './schedule-release-outputs.action.js';

/** One output to have: a manual in one variant and language. */
export interface Wanted {
  readonly manualId: string;
  readonly variant: string;
  readonly lang: string;
  readonly audience: string | null;
  /**
   * Whether its PDF prints the release's name or date (#395, `DesignsInUse.printsRelease`):
   * then it differs from every earlier release's, so it is always rendered, never reused.
   */
  readonly printsRelease: boolean;
}

/** What changed between two releases, for their outputs: everything, or these manuals in these languages. */
type Affected =
  | { readonly all: true }
  | {
      readonly all: false;
      /** `<manualId>\0<lang>`. */
      readonly pairs: ReadonlySet<string>;
    };

/** An output being planned, its reuse group still to settle against later releases. */
type Planned = { -readonly [K in keyof NewReleaseOutput]: NewReleaseOutput[K] };

const pairOf = (manualId: string, lang: string) => `${manualId}\0${lang}`;
const keyOf = (o: Pick<ReleaseOutput, 'manualId' | 'variant' | 'lang'>) =>
  `${o.manualId}\0${o.variant}\0${o.lang}`;

/**
 * Plans a release's outputs (#249), the `release.plan-outputs` job that
 * publishing it enqueued: one PDF per manual, variant (its manifest's)
 * and configured language at the release's tag, as `RELEASE_READER` (all
 * released content) sees the manuals.
 *
 * - **Compared with the nearest planned release before it** (#497): its
 *   previous release that is not withdrawn (a maintenance line's within
 *   its line). Releases are planned in the order cut (#527, `handle`), so
 *   that one is planned, unless its planning ended without outputs or it
 *   lies past `NEIGHBOURS_SCANNED`: then the one before that, and so on.
 * - **Affected** ones are rendered: the manuals and languages the changes
 *   between the two list (`ReleaseChangeReader.against`, as
 *   `RELEASE_READER`), in every language when it changed in the source
 *   language (a translation falls back to it). Everything is affected when
 *   no release before it is planned (a product's first), when any file
 *   but a module or a manifest changed (the configuration with its labels,
 *   a template or a page design's own, a snippet, a symbol, …), and when
 *   the two cannot be compared (`too-many-changes`, content that cannot be
 *   read).
 * - **Every output whose PDF prints the release** (its name or date, by
 *   its page design, #395) is rendered: no earlier release's file says it.
 * - **The rest** reuse that release's output (same manual, variant and
 *   language) and join its reuse group (#497): the same inputs. A `done`
 *   one: a `done` row pointing at the same blob, so every release has a
 *   full set. One still queued or rendering (its files not made yet):
 *   queued, and whichever of the group is rendered first serves them all
 *   (`RenderReleaseOutputAction`), so the newest release, rendered first,
 *   makes the file its predecessors wait for too. One that release failed
 *   for is rendered.
 * - **Releases after it planned first** (#497; since #527 only when this
 *   one's planning failed in their turn, which passed it over, or ended
 *   without outputs and is asked for again): each is compared with it the same way, and an
 *   output with their inputs joins their group, so the group's file is
 *   made once, at its oldest release. One a later release rendered
 *   already renders its own: a file never carries a later commit, and so
 *   a later date, than its release's (#328).
 * - **In batches, idempotent:** the rows are written `PLAN_BATCH` at a
 *   time, each batch in one transaction, and after each the release's
 *   render jobs are topped up (`ScheduleReleaseOutputsAction`, at most
 *   `QUEUED_PER_RELEASE` at a time: the rest are queued as those end), and
 *   a row the release has already is left alone, so a planning attempt cut
 *   off and run again adds nothing twice and goes on where it stopped.
 *   Its end queues again any scheduled output's job that went missing.
 * - **Bounded (#477):** a release of more than `maxOutputs`
 *   (`CCMS_RELEASE_MAX_OUTPUTS`) plans nothing. The refusal is recorded
 *   (`ReleaseOutputStore.refuse`: seen in the release's `meta.outputs`)
 *   and logged once; run again at the same limit, it reads nothing (a tag
 *   never moves, so neither does its count). The first batch planned once
 *   the limit is raised forgets it.
 */
@Injectable()
export class PlanReleaseOutputsAction implements UnguardedAction {
  readonly policy = 'internal';
  private readonly logger = new Logger(PlanReleaseOutputsAction.name);
  /**
   * How long into an attempt (from `handle`'s start, waiting for the turn included) earlier
   * releases are planned before its own (#527): past it, its own release is planned next, so
   * a long backlog does not use up the attempt's 15 minutes on others' plannings. Changed only
   * by tests.
   */
  earlierBudgetMs = EARLIER_PLANNING_MS;

  constructor(
    private readonly releases: ReleaseStore,
    private readonly outputs: ReleaseOutputStore,
    private readonly openSnapshot: OpenSnapshotAction,
    private readonly changes: ReleaseChangeReader,
    private readonly branches: ChangeSetBranches,
    private readonly schedule: ScheduleReleaseOutputsAction,
    private readonly unit: UnitOfWork,
    private readonly settings: ReleaseOutputSettings,
    private readonly addresses: StableAddressSettings,
    private readonly turns: PlanningTurns,
    private readonly jobs: JobQueue,
  ) {}

  /**
   * Plans `releaseId`'s outputs in its product's turn (`PlanningTurns`, #527): never at the
   * same time as another release of the product on another worker, whose outputs it may reuse.
   *
   * **Strictly in the order cut** (#527): in the turn, the product's releases cut before it
   * whose planning is still to come (`earlierToPlan`) are planned first, oldest first, then it.
   * So each is compared with the one cut just before it, whose rows are there, and whichever
   * worker takes the turn, a burst of releases is planned in one order: a later release joins
   * the reuse groups of the earlier one's queued outputs instead of rendering files the earlier
   * one is about to make. Plan jobs are still claimed newest first (`releasePriority`), so a new
   * release's planning starts at once, behind its own product's earlier releases only. One of
   * those that fails is logged and passed over (its own job tries it again): a release that
   * cannot be planned never holds up the ones after it. At most `EARLIER_PLANNING_MS` of an
   * attempt goes to earlier releases; past it, the release is planned next and the rest of
   * the backlog in later turns (they then join its reuse groups, `joinLater`). A release
   * planned to the end (`ReleaseOutputStore.markPlanned`) is not planned again: its own job,
   * when it runs (or a publisher's "plan again"), only tops up its render jobs and queues lost
   * ones again.
   */
  async handle({
    releaseId,
    signal,
  }: {
    readonly releaseId: string;
    /** The job attempt's: waiting for the turn, and planning the earlier releases, end with it. */
    readonly signal?: AbortSignal;
  }): Promise<void> {
    // From the attempt's start: waiting for the turn counts against the attempt too.
    const until = performance.now() + this.earlierBudgetMs;
    const release = await this.releases.find(releaseId);
    if (!release) return;
    await this.turns.take(
      release.product,
      async () => {
        // Planned to the end already (in a later release's turn, or before a retry): its rows
        // are all there, so only its render jobs are topped up and lost ones queued again.
        if ((await this.outputs.plannedWholly([release.id])).has(release.id)) {
          await this.schedule.handle(release);
          await this.schedule.repair(release);
          return;
        }
        const earlier = await earlierToPlan(
          { releases: this.releases, outputs: this.outputs, jobs: this.jobs },
          release,
        );
        for (const before of earlier) {
          signal?.throwIfAborted();
          if (performance.now() >= until) {
            this.logger.warn(
              `Planning release ${release.id} before ${earlier.length - earlier.indexOf(before)} earlier releases of ${release.product} still to plan: this attempt's ${Math.round(this.earlierBudgetMs / 60_000)} minutes for earlier ones (waiting for the turn included) are up.`,
            );
            break;
          }
          try {
            await this.plan(before);
          } catch (error) {
            if (signal?.aborted) throw error;
            this.logger.warn(
              `Planning release ${before.id} (cut before ${release.id}, planned first) failed: ${error instanceof Error ? error.message : String(error)}. Its own job plans it again.`,
            );
          }
        }
        signal?.throwIfAborted();
        await this.plan(release);
      },
      signal,
    );
  }

  private async plan(release: Release): Promise<void> {
    const max = this.settings.maxOutputs;
    const known = await this.outputs.refusal(release.id);
    if (known && known.wanted > max) {
      // Decided at this tag before: told again only for another limit.
      await this.refuse(release, known.wanted, max);
      return;
    }
    const head = await this.openSnapshot.handle({
      actor: RELEASE_READER,
      ref: release.tag,
    });
    if (head.commit !== release.commit) {
      throw new Error(`The tag of release ${release.id} moved.`);
    }
    const wanted = await wantedAt(head);
    const packages = this.settings.offlinePackages
      ? await packagesAt(head)
      : [];
    if (wanted.length + packages.length > max) {
      await this.refuse(release, wanted.length + packages.length, max);
      return;
    }
    // Compared with the nearest release before it that is planned (#497): its previous one,
    // planned first in this turn (#527), unless that one's planning ended without outputs.
    const before = await this.plannedBefore(release);
    const affected = before
      ? await this.affected(before, release, head)
      : ({ all: true } as const);
    const reusable = new Map<string, ReleaseOutput>();
    if (before) {
      for (const output of await this.outputs.all(before.id)) {
        // A failed one is rendered again; one still to render is shared.
        if (output.state !== 'failed' && output.kind === 'pdf') {
          reusable.set(keyOf(output), output);
        }
      }
    }
    const config = await head.config();
    const planned: Planned[] = wanted.map((w): Planned => {
      const id = newOutputId();
      const qrCode = releaseQrCode(this.addresses, release, w, config);
      const candidate =
        affected.all ||
        w.printsRelease ||
        affected.pairs.has(pairOf(w.manualId, w.lang))
          ? undefined
          : reusable.get(keyOf(w));
      // The same file only where it prints the same QR code (another `CCMS_PUBLIC_URL`).
      const previous =
        candidate && sameQrCode(candidate.qrCode, qrCode)
          ? candidate
          : undefined;
      const output = {
        id,
        releaseId: release.id,
        manualId: w.manualId,
        variant: w.variant,
        lang: w.lang,
        kind: 'pdf',
        audience: w.audience,
        // The same inputs as the previous release's: its group (#497).
        reuseGroup: previous ? (previous.reuseGroup ?? previous.id) : id,
        qrCode,
      } as const;
      return previous?.state === 'done'
        ? {
            ...output,
            state: 'done',
            sha256: previous.sha256,
            size: previous.size,
            // The file's own output, however many releases reused it since.
            reusedFrom: previous.reusedFrom ?? {
              releaseId: previous.releaseId,
              outputId: previous.id,
            },
          }
        : {
            ...output,
            state: 'queued',
            sha256: null,
            size: null,
            reusedFrom: null,
          };
    });
    // Only the PDFs, planned above, are shared with later releases (#497): before the packages.
    const joins = await this.joinLater(release, head, wanted, planned);
    // The offline packages (#59), one per language and audience level: built
    // once the release's PDFs are done (`ReleaseOutputStore.schedule` holds
    // them back until then), never reused, since each names its release.
    for (const p of packages) {
      const id = newOutputId();
      planned.push({
        id,
        releaseId: release.id,
        manualId: PACKAGE_MANUAL,
        variant: packageVariant(p.audience),
        lang: p.lang,
        kind: 'offline-package',
        audience: p.audience,
        reuseGroup: id,
        qrCode: null,
        state: 'queued',
        sha256: null,
        size: null,
        reusedFrom: null,
      });
    }
    // At least one batch, so a refusal is forgotten even with no manuals.
    for (let i = 0; i === 0 || i < planned.length; i += PLAN_BATCH) {
      const batch = planned.slice(i, i + PLAN_BATCH);
      const joined = joins.slice(i, i + PLAN_BATCH).flat();
      await this.unit.run(async (tx) => {
        if (i === 0 && known) await this.outputs.clearRefusal(tx, release.id);
        await this.outputs.insertMissing(tx, batch);
        if (joined.length > 0) await this.outputs.joinGroups(tx, joined);
      });
      // The first renders start while the rest is planned.
      await this.schedule.handle(release);
    }
    await this.schedule.repair(release);
    await this.outputs.markPlanned(release.id);
  }

  /**
   * Puts `planned` into the reuse groups of the releases after `release` that were planned
   * before it (#497, `plannedAfter`), wherever an output has the same inputs as theirs: it
   * takes their group when it has none of an earlier release's, else their group is joined
   * into its own (they all have the same inputs). Changes `planned`; the joins, per output.
   * A file is still made at the group's oldest output to render, and serves only those cut at
   * or after it, so an output whose later release rendered it already renders its own.
   */
  private async joinLater(
    release: Release,
    head: ReadableContent,
    wanted: readonly Wanted[],
    planned: Planned[],
  ): Promise<GroupJoin[][]> {
    const joins: GroupJoin[][] = planned.map(() => []);
    for (const later of await this.plannedAfter(release)) {
      const changed = await this.affected(release, later, head);
      if (changed.all) continue;
      const theirs = new Map<string, ReleaseOutput>();
      for (const output of await this.outputs.all(later.id)) {
        if (
          output.state !== 'failed' &&
          output.kind === 'pdf' &&
          output.reuseGroup !== null
        ) {
          theirs.set(keyOf(output), output);
        }
      }
      planned.forEach((output, i) => {
        // A file printing its release is never another's (#395).
        if (wanted[i]?.printsRelease) return;
        if (changed.pairs.has(pairOf(output.manualId, output.lang))) return;
        const other = theirs.get(keyOf(output));
        if (
          !other?.reuseGroup ||
          other.audience !== output.audience ||
          !sameQrCode(other.qrCode, output.qrCode) ||
          other.reuseGroup === output.reuseGroup
        ) {
          return;
        }
        if (output.reuseGroup === output.id) {
          // In no earlier release's group: theirs.
          output.reuseGroup = other.reuseGroup;
          return;
        }
        joins[i]?.push({
          from: other.reuseGroup,
          into: output.reuseGroup,
          manualId: output.manualId,
          variant: output.variant,
          lang: output.lang,
          kind: output.kind,
          audience: output.audience,
        });
      });
    }
    return joins;
  }

  /**
   * The nearest release before `release` whose outputs are planned (#497): its previous one
   * (`ReleaseChangeReader.previousOf`: a maintenance line's within its line), else that one's,
   * and so on, at most `NEIGHBOURS_SCANNED` back; undefined for none.
   */
  private async plannedBefore(release: Release): Promise<Release | undefined> {
    let at = await this.changes.previousOf(release);
    for (let i = 0; at && i < NEIGHBOURS_SCANNED; i++) {
      if ((await this.outputs.planned([at.id])).has(at.id)) return at;
      at = await this.changes.previousOf(at);
    }
    return undefined;
  }

  /**
   * The releases after `release` already planned that would have compared with it, had it
   * been planned first (#497): those whose previous releases (`previousOf`, step by step)
   * reach `release` before any planned one. Among the first `NEIGHBOURS_SCANNED` after it.
   */
  private async plannedAfter(release: Release): Promise<Release[]> {
    const later = await this.releases.after(release, NEIGHBOURS_SCANNED);
    if (later.length === 0) return [];
    const planned = await this.outputs.planned(later.map((r) => r.id));
    const scanned = new Set(later.map((r) => r.id));
    /** Per release not planned: whether its previous ones reach `release` first. */
    const reaches = new Map<string, boolean>();
    const reachesRelease = async (from: Release): Promise<boolean> => {
      const path: string[] = [];
      let at = await this.changes.previousOf(from);
      let found = false;
      // Each step goes to an older release, so this ends.
      while (at) {
        if (at.id === release.id) {
          found = true;
          break;
        }
        // Older than `release` (never reaching it), or planned in between.
        if (!scanned.has(at.id) || planned.has(at.id)) break;
        const known = reaches.get(at.id);
        if (known !== undefined) {
          found = known;
          break;
        }
        path.push(at.id);
        at = await this.changes.previousOf(at);
      }
      for (const id of path) reaches.set(id, found);
      return found;
    };
    const found: Release[] = [];
    for (const candidate of later) {
      if (planned.has(candidate.id) && (await reachesRelease(candidate))) {
        found.push(candidate);
      }
    }
    return found;
  }

  /** Records the release's planning as refused, logging it when that is news. */
  private async refuse(
    release: Release,
    wanted: number,
    max: number,
  ): Promise<void> {
    const recorded = await this.outputs.refuse(release.id, {
      reason: 'too-many-outputs',
      wanted,
      max,
    });
    if (recorded) {
      this.logger.warn(
        `Release ${release.id} would have ${wanted} outputs, more than ${max} (CCMS_RELEASE_MAX_OUTPUTS): none are planned.`,
      );
    }
  }

  /**
   * What changed from `older` to `newer` (#497: any two releases, the nearest planned on
   * either side), for their outputs. `head` is either one's content: its languages are only
   * read when the configuration is the same on both.
   */
  private async affected(
    older: Release,
    newer: Release,
    head: ReadableContent,
  ): Promise<Affected> {
    let changes;
    let paths;
    try {
      changes = await this.changes.against(RELEASE_READER, newer, older);
      paths = await changedPathsWithin(
        this.branches,
        older.commit,
        newer.commit,
      );
    } catch (error) {
      if (!cannotCompare(error)) throw error;
      return { all: true };
    }
    // A file a PDF may show that is neither a module nor a manifest
    // (the configuration, a template, a snippet, a symbol, …), or one no
    // subject names: every output may differ.
    if (
      paths.some(({ path }) => {
        const type = subjectOfPath(path)?.type;
        return type !== 'module' && type !== 'manual';
      })
    ) {
      return { all: true };
    }
    const config = await head.config();
    const { source, targets } = config.languages;
    const pairs = new Set<string>();
    for (const change of changes) {
      for (const lang of change.lang === source
        ? [source, ...targets]
        : [change.lang]) {
        pairs.add(pairOf(change.manualId, lang));
      }
    }
    return { all: false, pairs };
  }
}

/** Every output a release has: each readable manual, in each variant and configured language. */
export async function wantedAt(head: ReadableContent): Promise<Wanted[]> {
  const config = await head.config();
  const langs = [config.languages.source, ...config.languages.targets];
  const wanted: Wanted[] = [];
  const manuals = (await head.manuals()).sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const designs = new DesignsInUse(head);
  for (const listing of manuals) {
    // A broken manifest has nothing to render.
    if ('error' in listing) continue;
    const printsRelease = await designs.printsRelease(listing.manifest, config);
    for (const variant of listing.manifest.variants) {
      for (const lang of langs) {
        wanted.push({
          manualId: listing.id,
          variant: variantSlug(variant),
          lang,
          audience: listing.manifest.audience ?? null,
          printsRelease,
        });
      }
    }
  }
  return wanted;
}

/** One offline package to have (#59): a language and an audience level (null: none configured). */
export interface WantedPackage {
  readonly lang: string;
  readonly audience: string | null;
}

/**
 * The offline packages a release has (#59): one per configured language and
 * audience level, from the lowest up to the highest any manual at its tag has
 * (a manual naming none has the most restricted, as it is read); one per
 * language with no levels configured; none without a manual.
 */
export async function packagesAt(
  head: ReadableContent,
): Promise<WantedPackage[]> {
  const config = await head.config();
  const langs = [config.languages.source, ...config.languages.targets];
  const levels = config.audiences.map((a) => a.id);
  let highest = -1;
  let any = false;
  for (const listing of await head.manuals()) {
    if ('error' in listing) continue;
    any = true;
    const audience = listing.manifest.audience;
    const level =
      audience === undefined ? levels.length - 1 : levels.indexOf(audience);
    highest = Math.max(highest, level);
  }
  if (!any) return [];
  const audiences: (string | null)[] =
    levels.length === 0 ? [null] : levels.slice(0, highest + 1);
  return langs.flatMap((lang) =>
    audiences.map((audience) => ({ lang, audience })),
  );
}

/** Errors that say two releases cannot be compared: everything is rendered then. */
function cannotCompare(error: unknown): boolean {
  return (
    error instanceof NotFoundError ||
    error instanceof InvalidContentError ||
    (error instanceof UnprocessableError && error.code === 'too-many-changes')
  );
}

/**
 * The QR code a release's PDF of `output` prints (#450), by the release's configuration: its
 * stable address (the latest release's, so a printed copy leads to the current version), where
 * `delivery.pdfQrCode` says; none when it says `none`, when the addresses are not `public` (a
 * browser following a printed code has no token; `delivery.access` at most
 * `CCMS_DELIVERY_MAX_ACCESS`, #553) or when `CCMS_PUBLIC_URL` is not set.
 */
export function releaseQrCode(
  settings: StableAddressSettings,
  release: Pick<Release, 'product'>,
  output: {
    readonly manualId: string;
    readonly variant: string;
    readonly lang: string;
  },
  config: ProjectConfig,
): OutputQrCode | null {
  const { pdfQrCode } = config.delivery;
  // At most the operator's cap (#553): a capped project never prints a public code.
  if (pdfQrCode === 'none' || deliveryAccess(config, settings) !== 'public') {
    return null;
  }
  const url = absoluteUrl(
    settings,
    addressPath({
      product: release.product,
      slug: deliverySlug(config, output.manualId),
      variant: output.variant,
      lang: output.lang,
    }),
  );
  return url === undefined ? null : { url, placement: pdfQrCode };
}
