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
import { UnitOfWork } from '../../../base/core/unit-of-work.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import type { Release, ReleaseWithdrawal } from '../release.js';
import { ReleaseEvents } from '../release-events.js';
import { ReleaseStore } from '../release-store.js';
import {
  productTarget,
  RELEASE_OUTSIDE_SCOPE,
} from './create-release.action.js';

export interface WithdrawReleaseInput {
  readonly actor: Actor;
  readonly id: string;
  /** Checked and normalised by `WithdrawalReason`. */
  readonly reason: string;
}

/**
 * Withdraws a published release (#138): marks it withdrawn with who, when
 * and why, and nothing else. The tag stays (tags are immutable: no code
 * path moves or deletes one) and reads at it keep working; a withdrawn
 * release no longer counts as a module's latest release
 * (`ReadableRefs.releases`), and the changelog shows it withdrawn, with
 * the reason, to every reader.
 *
 * - **Who:** as cutting it: `release.publish` in a role whose scope covers
 *   the release's product in every language, module type and audience
 *   (judged by the configuration at the release's commit), and
 *   `content.read`, which opening that commit needs.
 * - **Once:** a withdrawn release is 409 `release-withdrawn`; there is no
 *   undoing it, since subscribers are told (`release.withdrawn`).
 * - **Recorded:** a `release.withdraw` audit event (the reason as its
 *   comment) and a `release.withdrawn` outbox row, in the transaction that
 *   writes the withdrawal.
 */
@Injectable()
export class WithdrawReleaseAction extends ActorAction<
  WithdrawReleaseInput,
  Release
> {
  readonly policy = 'release.publish';

  constructor(
    private readonly store: ReleaseStore,
    private readonly snapshots: OpenSnapshotAction,
    private readonly auditLog: AuditLog,
    private readonly events: ReleaseEvents,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected async run({
    actor,
    id,
    reason,
  }: WithdrawReleaseInput): Promise<Release> {
    const release = await this.store.find(id);
    if (!release) throw new NotFoundError(`No release "${id}".`);
    const content = await this.snapshots.handle({
      actor,
      ref: release.commit,
    });
    if (content.commit !== release.commit) {
      throw new NotFoundError(`No release "${id}".`);
    }
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
    const withdrawn = () =>
      new ConflictError(
        'release-withdrawn',
        `The release "${release.tag}" is withdrawn already.`,
      );
    if (release.withdrawal) throw withdrawn();
    const withdrawal: ReleaseWithdrawal = {
      by: { kind: actor.kind, id: actor.id },
      at: new Date(),
      reason,
    };
    const written = await this.unit.run(async (tx) => {
      if (!(await this.store.withdraw(tx, release.id, withdrawal))) {
        return false;
      }
      await this.auditLog.record(tx, actor, {
        action: 'release.withdraw',
        subject: { type: 'release', id: release.id },
        comment: reason,
        data: {
          product: release.product,
          revision: release.revision,
          tag: release.tag,
          commit: release.commit,
        },
      });
      await this.events.emit(tx, {
        topic: 'release.withdrawn',
        key: release.id,
        payload: {
          releaseId: release.id,
          product: release.product,
          revision: release.revision,
          tag: release.tag,
          commit: release.commit,
          reason,
          actor: withdrawal.by,
        },
      });
      return true;
    });
    if (!written) throw withdrawn();
    return { ...release, withdrawal };
  }
}
