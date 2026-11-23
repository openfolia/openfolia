import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { allows } from '../../../access/core/allows.js';
import { ActorAction } from '../../../access/core/policy.js';
import { AuditLog } from '../../../audit/core/audit-log.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../../base/core/errors.js';
import type { PageRequest, Paginated } from '../../../base/core/paging.js';
import { BOUNDED, UnitOfWork } from '../../../base/core/unit-of-work.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import { MaintenanceBranches } from '../maintenance-branches.js';
import {
  type MaintenanceLine,
  type MaintenanceLineFilter,
  newMaintenanceLineId,
} from '../maintenance-line.js';
import { MaintenanceLineStore } from '../maintenance-line-store.js';
import type { Release } from '../release.js';
import { ReleaseStore } from '../release-store.js';
import { productTarget } from './create-release.action.js';

/** A line with where its branch points now (undefined: the branch is gone). */
export interface MaintenanceLineView {
  readonly line: MaintenanceLine;
  readonly head: string | undefined;
}

/** The 403's detail when the publisher's scope does not cover the line's product. */
export const LINE_OUTSIDE_SCOPE =
  'Your roles may not publish this product in every language and audience.';

/**
 * Whether `actor` publishes `release`'s product everywhere (as cutting a
 * release of it needs: `productTarget`), by the configuration at the
 * release's tag (released content: `content.read` opens it). 403 if not.
 */
async function checkPublishes(
  snapshots: OpenSnapshotAction,
  actor: Actor,
  release: Release,
): Promise<void> {
  const config = await (
    await snapshots.handle({ actor, ref: release.tag })
  ).config();
  if (
    !allows(
      actor,
      'release.publish',
      productTarget(config, release.productFacet, release.product),
    )
  ) {
    throw new ForbiddenError(LINE_OUTSIDE_SCOPE);
  }
}

/**
 * Starts a maintenance line (#60) from a release: the branch named by
 * `CCMS_MAINTENANCE_BRANCH` for the release's product and revision, at
 * exactly the release's commit, and the line recorded with a
 * `maintenance-line.start` audit event.
 *
 * - **Who:** `release.publish` in a role covering the release's product
 *   everywhere (as cutting a release of it does), and `content.read` for
 *   the configuration at its tag.
 * - **One line per release** (409 `maintenance-line-exists`,
 *   `meta.maintenanceLineId`); an unknown release is 404 `not-found`
 *   (JSON:API: a related resource that does not exist).
 *
 * **Git first, then the database.** The branch is created by
 * compare-and-swap ("must not exist"); one that exists at exactly the
 * release's commit is an earlier attempt's, cut off before it was
 * recorded, and is taken (the audit event says `branchExisted`). One
 * elsewhere is 409 `branch-exists`, and nothing is recorded.
 */
@Injectable()
export class StartMaintenanceLineAction extends ActorAction<
  { actor: Actor; releaseId: string },
  MaintenanceLineView
> {
  readonly policy = 'release.publish';

  constructor(
    private readonly snapshots: OpenSnapshotAction,
    private readonly releases: ReleaseStore,
    private readonly lines: MaintenanceLineStore,
    private readonly branches: MaintenanceBranches,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected async run({
    actor,
    releaseId,
  }: {
    actor: Actor;
    releaseId: string;
  }): Promise<MaintenanceLineView> {
    const release = await this.releases.find(releaseId);
    if (!release) {
      throw new NotFoundError(
        `There is no release "${releaseId}" to start a line from.`,
      );
    }
    await checkPublishes(this.snapshots, actor, release);
    await this.refuseExisting(release.id);
    const branch = this.branches.nameOf(release.product, release.revision);
    const made = await this.branches.create(branch, release.commit);
    const now = new Date();
    const line: MaintenanceLine = {
      id: newMaintenanceLineId(now.getTime()),
      product: release.product,
      revision: release.revision,
      baseRelease: release.id,
      baseCommit: release.commit,
      branch,
      createdBy: { kind: actor.kind, id: actor.id },
      createdAt: now,
      closedAt: null,
      closedBy: null,
    };
    const recorded = await this.unit.run(async (tx) => {
      if (!(await this.lines.insert(tx, line))) return false;
      await this.auditLog.record(tx, actor, {
        action: 'maintenance-line.start',
        subject: { type: 'maintenance-line', id: line.id },
        data: {
          product: line.product,
          revision: line.revision,
          baseRelease: line.baseRelease,
          branch: line.branch,
          commit: line.baseCommit,
          ...(made === 'existed' && { branchExisted: true }),
        },
      });
      return true;
    }, BOUNDED);
    if (!recorded) {
      // Another request recorded it meanwhile (on the same branch).
      await this.refuseExisting(release.id);
      throw new ConflictError(
        'branch-exists',
        `A maintenance line holds the branch "${branch}" already.`,
      );
    }
    return { line, head: release.commit };
  }

  private async refuseExisting(releaseId: string): Promise<void> {
    const existing = await this.lines.findByRelease(releaseId);
    if (existing) {
      throw new ConflictError(
        'maintenance-line-exists',
        'A maintenance line was started from this release already.',
        { maintenanceLineId: existing.id },
      );
    }
  }
}

/**
 * Closes a maintenance line (#60): its branch stays, and so do its change
 * sets (they may still be merged) and its releases, but no change set
 * starts on it any more (409 `invalid-state`). Releases may still be cut
 * from it. Once only: a closed line is 409 `invalid-state`
 * (`meta.state: "closed"`). Who: as starting one. Audited
 * (`maintenance-line.close`, with the comment), in the transaction that
 * holds the line's row, so no change set starts on it meanwhile.
 */
@Injectable()
export class CloseMaintenanceLineAction extends ActorAction<
  { actor: Actor; id: string; comment?: string },
  MaintenanceLineView
> {
  readonly policy = 'release.publish';

  constructor(
    private readonly snapshots: OpenSnapshotAction,
    private readonly releases: ReleaseStore,
    private readonly lines: MaintenanceLineStore,
    private readonly branches: MaintenanceBranches,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected async run({
    actor,
    id,
    comment,
  }: {
    actor: Actor;
    id: string;
    comment?: string;
  }): Promise<MaintenanceLineView> {
    const found = await this.lines.find(id);
    if (!found) throw new NotFoundError(`No maintenance line "${id}".`);
    const release = await this.releases.find(found.baseRelease);
    if (!release) {
      throw new Error(`The base release of the line ${id} is gone.`);
    }
    await checkPublishes(this.snapshots, actor, release);
    const at = new Date();
    const by = { kind: actor.kind, id: actor.id };
    const closed = await this.unit.run(async (tx) => {
      const line = await this.lines.lock(tx, id, 'update');
      if (!line) throw new NotFoundError(`No maintenance line "${id}".`);
      if (
        line.closedAt !== null ||
        !(await this.lines.close(tx, id, { by, at }))
      ) {
        throw new ConflictError(
          'invalid-state',
          'The maintenance line is closed already.',
          { state: 'closed' },
        );
      }
      await this.auditLog.record(tx, actor, {
        action: 'maintenance-line.close',
        subject: { type: 'maintenance-line', id },
        ...(comment !== undefined && { comment }),
        data: {
          branch: line.branch,
          product: line.product,
          revision: line.revision,
        },
      });
      return { ...line, closedAt: at, closedBy: by };
    }, BOUNDED);
    return { line: closed, head: await this.branches.head(closed.branch) };
  }
}

/**
 * One page of the maintenance lines, newest first. Lines are draft work
 * (their branches hold unreleased fixes), so `content.read.draft`.
 */
@Injectable()
export class ListMaintenanceLinesAction extends ActorAction<
  { actor: Actor; filter: MaintenanceLineFilter; page: PageRequest },
  Paginated<MaintenanceLineView>
> {
  readonly policy = 'content.read.draft';

  constructor(
    private readonly lines: MaintenanceLineStore,
    private readonly branches: MaintenanceBranches,
  ) {
    super();
  }

  protected async run({
    filter,
    page,
  }: {
    filter: MaintenanceLineFilter;
    page: PageRequest;
  }): Promise<Paginated<MaintenanceLineView>> {
    const { total, items } = await this.lines.list(filter, page);
    return {
      total,
      items: await Promise.all(
        items.map(async (line) => ({
          line,
          head: await this.branches.head(line.branch),
        })),
      ),
    };
  }
}

/** One maintenance line; not found for any ID that names none. */
@Injectable()
export class GetMaintenanceLineAction extends ActorAction<
  { actor: Actor; id: string },
  MaintenanceLineView
> {
  readonly policy = 'content.read.draft';

  constructor(
    private readonly lines: MaintenanceLineStore,
    private readonly branches: MaintenanceBranches,
  ) {
    super();
  }

  protected async run({ id }: { id: string }): Promise<MaintenanceLineView> {
    const line = await this.lines.find(id);
    if (!line) throw new NotFoundError(`No maintenance line "${id}".`);
    return { line, head: await this.branches.head(line.branch) };
  }
}

/**
 * One page of the releases cut from a maintenance line, newest first (its
 * base release is `relationships.baseRelease`, not one of them).
 */
@Injectable()
export class ListMaintenanceLineReleasesAction extends ActorAction<
  { actor: Actor; id: string; page: PageRequest },
  Paginated<Release>
> {
  readonly policy = 'content.read.draft';

  constructor(
    private readonly lines: MaintenanceLineStore,
    private readonly releases: ReleaseStore,
  ) {
    super();
  }

  protected async run({
    id,
    page,
  }: {
    id: string;
    page: PageRequest;
  }): Promise<Paginated<Release>> {
    if (!(await this.lines.find(id))) {
      throw new NotFoundError(`No maintenance line "${id}".`);
    }
    const { total, items } = await this.lines.releasesOf(id, page);
    const found = await Promise.all(items.map((r) => this.releases.find(r)));
    return {
      total,
      items: found.filter((r): r is Release => r !== undefined),
    };
  }
}
