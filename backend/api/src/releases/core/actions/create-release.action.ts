import { Injectable } from '@nestjs/common';
import { productFacet, type ProjectConfig } from '@openfolia/content-model';
import type { Actor } from '../../../access/core/actor.js';
import { allows, type ContentTarget } from '../../../access/core/allows.js';
import { ActorAction } from '../../../access/core/policy.js';
import { AuditLog } from '../../../audit/core/audit-log.js';
import {
  ConflictError,
  ForbiddenError,
  InvalidContentError,
  NotFoundError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import { UnitOfWork } from '../../../base/core/unit-of-work.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import { RELEASED_BRANCH } from '../../../content/core/released.js';
import { JobQueue } from '../../../jobs/core/job-queue.js';
import {
  MAX_MESSAGE,
  newReleaseId,
  type Release,
  releaseMessage,
} from '../release.js';
import {
  changedManuals,
  RELEASE_READER,
  type ReleaseChange,
} from '../release-changes.js';
import { ReleaseEvents } from '../release-events.js';
import { PLAN_RELEASE_OUTPUTS, releasePriority } from '../release-output.js';
import { type StoredRelease, ReleaseStore } from '../release-store.js';
import { ReleaseTags } from '../release-tags.js';
import { ReleaseChangeReader } from './release-changes.action.js';
import { MaintenanceLineStore } from '../maintenance-line-store.js';

export interface CreateReleaseInput {
  readonly actor: Actor;
  /** A value of the configured product facet. */
  readonly product: string;
  /** Checked by `ReleaseRevision`. */
  readonly revision: string;
  /** Checked and normalised by `ReleaseNotes`; null for none. */
  readonly notes: string | null;
  /** Per language tag (one configured at `main`), each by `ReleaseNotes`. */
  readonly notesByLanguage?: Readonly<Record<string, string>>;
  /** Marked a major change: told to its readers (#252). */
  readonly major?: boolean;
  /**
   * The maintenance line to release (#60): its branch's head instead of
   * `main`'s, of the line's product.
   */
  readonly maintenanceLine?: string;
}

/** The most manuals and modules a `release.published` row names. */
export const MAX_EVENT_SUBJECTS = 1_000;

/**
 * How old a reservation must be before another request may finish it: a
 * release whose tag write was cut off (the process stopped, Git failed).
 * Longer than any tag write takes.
 */
export const RESUME_AFTER_MS = 60_000;

/** The 403's detail when the publisher's scope does not cover the product. */
export const RELEASE_OUTSIDE_SCOPE =
  'Your roles may not publish this product in every language and audience.';

/**
 * Cuts a release (#40): tags the commit `main` points to now, the whole of
 * it, as `revision` of `product`, with an annotated tag (`ReleaseTags`)
 * that nothing ever moves or deletes. With `maintenanceLine` (#60), the
 * line's branch head instead, of the line's product only (422
 * `invalid-product`), recorded as the line's (`MaintenanceLineStore.
 * linkRelease`, in the reservation's transaction); that head is a draft
 * once a fix is merged, so it needs `content.read.draft` too.
 *
 * - **Who:** `release.publish` in a role whose scope covers the product
 *   (a value of the product facet: `release.productFacet` in `openfolia.yaml`,
 *   else the first facet) in every language, module type and audience,
 *   since the release holds all of it; and `content.read`, which opening
 *   `main` for its configuration needs.
 * - **Product:** a value of the product facet in `openfolia.yaml` at the commit
 *   tagged (422 `invalid-product`; `no-product-facet` when none is
 *   configured).
 * - **Immutable:** a product and revision (or tag name) in use is 409
 *   `release-exists`, whatever the commit.
 *
 * **Order: the database, Git, the database.** The name is reserved first
 * (a row without its tag object, unique by product and revision and by tag
 * name), so two requests for one release never both write; then the tag is
 * made with the reservation's exact data (commit, message, date); then the
 * release is published, audited (`release.publish`), with a
 * `release.published` outbox row and its outputs' planning job
 * (`release.plan-outputs`, #249) in that transaction. A request that fails
 * where nothing can have been written (a client error from the tag
 * writer) drops its reservation. One cut off between the two (the process
 * stopped, Git or the database failed) leaves it: a later request for the
 * same release, once the reservation is `RESUME_AFTER_MS` old, finishes it
 * with the reservation's data, never its own. The tag it finds is taken as
 * the release's only if it is exactly what the reservation would make
 * (commit, tagger date and message); any other tag of that name is a
 * release made outside the API (409, and the reservation is dropped).
 */
@Injectable()
export class CreateReleaseAction extends ActorAction<
  CreateReleaseInput,
  Release
> {
  readonly policy = 'release.publish';

  constructor(
    private readonly snapshots: OpenSnapshotAction,
    private readonly tags: ReleaseTags,
    private readonly store: ReleaseStore,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
    private readonly events: ReleaseEvents,
    private readonly changes: ReleaseChangeReader,
    private readonly jobs: JobQueue,
    private readonly lines: MaintenanceLineStore,
  ) {
    super();
  }

  protected async run({
    actor,
    product,
    revision,
    notes,
    notesByLanguage = {},
    major = false,
    maintenanceLine,
  }: CreateReleaseInput): Promise<Release> {
    const line =
      maintenanceLine === undefined
        ? undefined
        : await this.lines.find(maintenanceLine);
    if (maintenanceLine !== undefined && !line) {
      throw new UnprocessableError(
        'unknown-maintenance-line',
        `There is no maintenance line "${maintenanceLine}".`,
      );
    }
    if (line && line.product !== product) {
      throw new UnprocessableError(
        'invalid-product',
        `The maintenance line maintains "${line.product}"; its releases are of that product.`,
        { product: line.product },
      );
    }
    const ref = line?.branch ?? RELEASED_BRANCH;
    // A line's head after a fix is a draft: opening it needs
    // `content.read.draft`, and without it the branch is not there.
    const main = await this.snapshots
      .handle({ actor, ref })
      .catch((error: unknown) => {
        if (error instanceof NotFoundError) {
          throw new ConflictError(
            'branch-missing',
            `There is no branch "${ref}" to release.`,
          );
        }
        throw error;
      });
    const config = await main.config();
    const facet = productFacet(config);
    if (!facet) {
      throw new UnprocessableError(
        'no-product-facet',
        'openfolia.yaml configures no facet whose values name products (release.productFacet).',
      );
    }
    if (!facet.values.some((value) => value.id === product)) {
      throw new UnprocessableError(
        'invalid-product',
        `"${product}" is no value of the product facet "${facet.id}".`,
        { facet: facet.id },
      );
    }
    if (
      !allows(
        actor,
        'release.publish',
        productTarget(config, facet.id, product),
      )
    ) {
      throw new ForbiddenError(RELEASE_OUTSIDE_SCOPE);
    }
    const languages = [config.languages.source, ...config.languages.targets];
    for (const lang of Object.keys(notesByLanguage)) {
      if (!languages.includes(lang)) {
        throw new UnprocessableError(
          'invalid-language',
          `"${lang}" is no language configured in openfolia.yaml.`,
          { lang },
        );
      }
    }
    if (
      releaseMessage(product, revision, { notes, notesByLanguage, major })
        .length > MAX_MESSAGE
    ) {
      throw new UnprocessableError(
        'invalid-notes',
        `The notes, in all languages together, may hold at most ${MAX_MESSAGE.toLocaleString('en')} characters.`,
      );
    }
    const tag = this.tags.nameOf(product, revision);
    // The tagger date keeps whole seconds; the row says the same.
    const exact = Date.now();
    const now = Math.floor(exact / 1000) * 1000;
    const candidate: StoredRelease = {
      // To the millisecond: two releases cut in one second still list (and
      // count their changes) in the order they were cut.
      id: newReleaseId(exact),
      product,
      productFacet: facet.id,
      revision,
      tag,
      tagObject: null,
      commit: main.commit,
      notes,
      notesByLanguage,
      major,
      publishedBy: { kind: actor.kind, id: actor.id },
      publishedAt: new Date(now),
    };
    const reserve = () =>
      this.unit.run(async (tx) => {
        if (!(await this.store.reserve(tx, candidate))) return false;
        // Dropped with the reservation, kept with the release.
        if (line) await this.lines.linkRelease(tx, line.id, candidate.id);
        return true;
      });
    // A reservation dropped between our attempt and the lookup frees the
    // name: one more attempt.
    const reserved =
      (await reserve()) ||
      (!(await this.holder(product, revision, tag)) && (await reserve()));
    const release = reserved
      ? candidate
      : await this.resumable(product, revision, tag);
    const tagObject = await this.tagOf(release);
    const event = await this.publishedEvent(release);
    const published = await this.unit.run(async (tx) => {
      // A concurrent request finishing the same reservation published it.
      if (!(await this.store.publish(tx, release.id, tagObject))) return false;
      await this.auditLog.record(tx, actor, {
        action: 'release.publish',
        subject: { type: 'release', id: release.id },
        data: {
          product: release.product,
          productFacet: release.productFacet,
          revision: release.revision,
          tag: release.tag,
          tagObject,
          commit: release.commit,
          major: release.major,
          ...(reserved &&
            line && { maintenanceLine: line.id, branch: line.branch }),
          ...(!reserved && {
            resumed: true,
            publishedBy: `${release.publishedBy.kind}/${release.publishedBy.id}`,
          }),
        },
      });
      await this.events.emit(tx, {
        topic: 'release.published',
        key: release.id,
        payload: { ...event, tagObject },
      });
      // Its outputs (#249), planned in the background: the job exists
      // exactly when the release does.
      await this.jobs.enqueue(
        PLAN_RELEASE_OUTPUTS,
        { releaseId: release.id },
        // Newest first, as its files render (#497): a new release is
        // planned before older ones still waiting, which then join the
        // reuse groups it made.
        { key: release.id, priority: releasePriority(release), tx },
      );
      return true;
    });
    if (!published && !(await this.store.find(release.id))) {
      throw new ConflictError(
        'release-pending',
        `The release "${tag}" was dropped meanwhile; try again.`,
        { retryAfter: 1 },
      );
    }
    return { ...release, tagObject, withdrawal: null };
  }

  /**
   * The `release.published` outbox row's payload (without the tag
   * object): the release, whether it is major (and as `level`, which the
   * notifications read), and the manuals and modules it changed against
   * the product's previous release, as `RELEASE_READER` sees them, at most
   * `MAX_EVENT_SUBJECTS` of each (`complete: false` when cut, or when too
   * many files changed to compare, or the previous release cannot be read:
   * then every manual, and no modules; none when even that cannot be read).
   */
  private async publishedEvent(
    release: StoredRelease,
  ): Promise<Record<string, unknown>> {
    // Best effort: the tag exists already, so content that cannot be
    // compared never keeps the release from being published. Anything
    // else (an outage) leaves the reservation for a later request.
    const tolerated = (error: unknown) =>
      error instanceof NotFoundError ||
      error instanceof InvalidContentError ||
      error instanceof UnprocessableError;
    let changes: readonly ReleaseChange[] = [];
    let complete = true;
    try {
      ({ changes } = await this.changes.of(RELEASE_READER, release));
    } catch (error) {
      if (!tolerated(error)) throw error;
      complete = false;
      try {
        changes = await this.changes.everyManual(RELEASE_READER, release);
      } catch (again) {
        if (!tolerated(again)) throw again;
      }
    }
    const manualIds = changedManuals(changes);
    const modules = [
      ...new Map(
        changes.flatMap((c) =>
          c.modules.map((m) => [
            `${c.lang}/${m.moduleId}`,
            { moduleId: m.moduleId, lang: c.lang, change: m.change },
          ]),
        ),
      ).values(),
    ];
    return {
      releaseId: release.id,
      product: release.product,
      revision: release.revision,
      tag: release.tag,
      commit: release.commit,
      major: release.major,
      level: release.major ? 'major' : 'minor',
      actor: release.publishedBy,
      manualIds: manualIds.slice(0, MAX_EVENT_SUBJECTS),
      modules: modules.slice(0, MAX_EVENT_SUBJECTS),
      complete:
        complete &&
        manualIds.length <= MAX_EVENT_SUBJECTS &&
        modules.length <= MAX_EVENT_SUBJECTS,
    };
  }

  /** The release, published or reserved, holding the name. */
  private holder(product: string, revision: string, tag: string) {
    return this.store.findByName(product, revision, tag);
  }

  /**
   * The reservation holding the name, when it is one this request may
   * finish: still unpublished, of this very product, revision and tag, and
   * `RESUME_AFTER_MS` old. One that is younger is 409 `release-pending`
   * (try again after `meta.retryAfter`); a published release, or a
   * reservation this request can never finish (the same tag in another
   * case), is 409 `release-exists`.
   */
  private async resumable(
    product: string,
    revision: string,
    tag: string,
  ): Promise<StoredRelease> {
    const existing = await this.holder(product, revision, tag);
    if (
      existing?.tagObject === null &&
      existing.product === product &&
      existing.revision === revision &&
      existing.tag === tag
    ) {
      const left =
        RESUME_AFTER_MS - (Date.now() - existing.publishedAt.getTime());
      if (left <= 0) return existing;
      // Being made, or cut off and not yet old enough to finish: the
      // client tries again later, and then finishes it.
      throw new ConflictError(
        'release-pending',
        `The release "${tag}" is being made; try again in a minute.`,
        {
          releaseId: existing.id,
          retryAfter: Math.max(1, Math.ceil(left / 1000)),
        },
      );
    }
    throw new ConflictError(
      'release-exists',
      `The release "${tag}" exists already.`,
      existing?.tagObject ? { releaseId: existing.id } : undefined,
    );
  }

  /**
   * Makes the release's tag from the reservation's data, or takes the tag
   * of that name that is exactly what it would make (an earlier attempt's).
   * Drops the reservation where it can never be published.
   */
  private async tagOf(release: StoredRelease): Promise<string> {
    const message = releaseMessage(release.product, release.revision, release);
    try {
      const made = await this.tags.create({
        product: release.product,
        revision: release.revision,
        commit: release.commit,
        message,
        actor: release.publishedBy,
        date: release.publishedAt,
      });
      return made.tag;
    } catch (error) {
      if (error instanceof ConflictError && error.code === 'release-exists') {
        const found = await this.tags.find(release.tag);
        if (
          found &&
          found.commit === release.commit &&
          found.taggedAt.getTime() === release.publishedAt.getTime() &&
          found.message === message
        ) {
          return found.tag;
        }
        await this.drop(release);
        throw error;
      }
      if (error instanceof UnprocessableError) {
        await this.drop(release);
        if (error.code === 'invalid-message') {
          throw new UnprocessableError(
            'invalid-notes',
            'The notes (the last language’s, when there are some per language) end in lines Git reads as trailers ("Key: value"); end them with a sentence.',
          );
        }
      }
      // Anything else may have written the tag: the reservation stays,
      // for a later request to finish.
      throw error;
    }
  }

  private async drop(release: StoredRelease): Promise<void> {
    await this.unit.run((tx) => this.store.discard(tx, release.id));
  }
}

/**
 * What publishing `product` is checked against: everything of it, in
 * every language, module type and audience (each left out, so a role
 * restricted in any of them does not cover it), and the product facet
 * naming exactly `product`.
 */
export function productTarget(
  config: Pick<ProjectConfig, 'audiences' | 'facets'>,
  facet: string,
  product: string,
): ContentTarget {
  return {
    audiences: config.audiences.map((a) => a.id),
    facetIds: config.facets.map((f) => f.id),
    lang: undefined,
    moduleType: undefined,
    audience: undefined,
    facets: { [facet]: [product] },
  };
}
