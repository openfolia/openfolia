import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { AuditLog } from '../../../audit/core/audit-log.js';
import {
  ConflictError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import { UnitOfWork } from '../../../base/core/unit-of-work.js';
import { ReadableRefs } from '../../../content/core/readable-refs.js';
import {
  BRANCH_PREFIX,
  type ChangeSet,
  changeSetBranch,
  newChangeSetId,
} from '../change-set.js';
import { ChangeSetBranches } from '../change-set-branches.js';
import { ChangeSetStore } from '../change-set-store.js';
import type { MaintenanceLine } from '../../../releases/core/maintenance-line.js';
import { MaintenanceLineStore } from '../../../releases/core/maintenance-line-store.js';

export interface CreateChangeSetInput {
  readonly actor: Actor;
  readonly title: string;
  readonly description?: string;
  /**
   * The branch to start from (and later merge back into). Default: the
   * server's default branch (`ChangeSetBranches.defaultBase`).
   */
  readonly baseRef?: string;
  /**
   * A maintenance line's ID (#60), instead of `baseRef`: start from (and
   * later merge into) the line's branch. Writers pick the product revision
   * they fix, never a branch.
   */
  readonly maintenanceLine?: string;
}

/**
 * Starts a change set: a new branch at the base branch's current commit,
 * then the change set and its audit event in one transaction. A base other
 * than a released branch also needs `content.read.draft` (`ReadableRefs`).
 *
 * Git first, then the database. If the transaction fails (or the process
 * stops between the two), the branch is left without a change set: an
 * orphan holding no commits of its own (nothing can commit to it without
 * one). It is not deleted here, since a failed commit may still have
 * landed; `ReconcileChangeSetBranchesAction` removes it once it is old
 * enough that no transaction can still be recording it.
 *
 * **On a maintenance line** (#60: `maintenanceLine`, or a `baseRef` naming
 * a line's branch, which is the same): the line's branch is the base, and
 * a closed line takes no new change sets (409 `invalid-state`,
 * `meta.state: "closed"`), checked again holding the line's row (shared:
 * closing it waits) in the transaction that records the change set.
 */
@Injectable()
export class CreateChangeSetAction extends ActorAction<
  CreateChangeSetInput,
  ChangeSet
> {
  readonly policy = 'content.edit';

  constructor(
    private readonly refs: ReadableRefs,
    private readonly branches: ChangeSetBranches,
    private readonly store: ChangeSetStore,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
    private readonly lines: MaintenanceLineStore,
  ) {
    super();
  }

  protected async run({
    actor,
    title,
    description,
    baseRef: requested,
    maintenanceLine,
  }: CreateChangeSetInput): Promise<ChangeSet> {
    if (maintenanceLine !== undefined && requested !== undefined) {
      throw new UnprocessableError(
        'invalid-base',
        'Give baseRef or maintenanceLine, not both.',
      );
    }
    const chosen =
      maintenanceLine === undefined
        ? undefined
        : await this.lines.find(maintenanceLine);
    if (maintenanceLine !== undefined && !chosen) {
      throw new UnprocessableError(
        'invalid-base',
        `There is no maintenance line "${maintenanceLine}" to start from.`,
      );
    }
    const baseRef =
      chosen?.branch ?? requested ?? (await this.branches.defaultBase());
    if (baseRef === undefined) {
      throw new UnprocessableError(
        'invalid-base',
        'Give baseRef: the server’s default ref (CCMS_DEFAULT_REF) names no branch.',
      );
    }
    if (baseRef.startsWith(BRANCH_PREFIX)) {
      throw new UnprocessableError(
        'invalid-base',
        'A change set cannot start from another change set’s branch.',
      );
    }
    // A draft branch the actor may not read is refused exactly like a
    // missing one, so the answer does not tell whether it exists. The
    // default is not named: it may be what HEAD points to.
    const base = await this.refs.branch(actor, baseRef);
    if (!base) {
      throw new UnprocessableError(
        'invalid-base',
        requested === undefined
          ? 'The server’s default ref (CCMS_DEFAULT_REF) names no branch to start from; give baseRef.'
          : `There is no branch "${baseRef}" to start from.`,
      );
    }
    // A line's branch named directly is that line.
    const line = chosen ?? (await this.lines.findByBranch(base.name));
    if (line) refuseClosed(line);
    const now = new Date();
    const id = newChangeSetId(now.getTime());
    const changeSet: ChangeSet = {
      id,
      title,
      description: description ?? null,
      author: { kind: actor.kind, id: actor.id },
      baseRef: base.name,
      baseCommit: base.commit,
      baseReleased: base.released,
      branch: changeSetBranch(id),
      state: 'draft',
      createdAt: now,
      updatedAt: now,
    };
    await this.branches.create(changeSet.branch, changeSet.baseCommit);
    await this.unit.run(async (tx) => {
      if (line) {
        const held = await this.lines.lock(tx, line.id, 'share');
        if (held) refuseClosed(held);
      }
      await this.store.insert(tx, changeSet);
      await this.auditLog.record(tx, actor, {
        action: 'change-set.create',
        subject: { type: 'change-set', id },
        data: {
          title,
          baseRef: changeSet.baseRef,
          baseCommit: changeSet.baseCommit,
          baseReleased: changeSet.baseReleased,
          branch: changeSet.branch,
          ...(line && { maintenanceLine: line.id }),
        },
      });
    });
    return changeSet;
  }
}

/** 409 `invalid-state` for a closed line: no new change sets start on it. */
function refuseClosed(line: MaintenanceLine): void {
  if (line.closedAt !== null) {
    throw new ConflictError(
      'invalid-state',
      'The maintenance line is closed: no new change sets start on it.',
      { state: 'closed' },
    );
  }
}
