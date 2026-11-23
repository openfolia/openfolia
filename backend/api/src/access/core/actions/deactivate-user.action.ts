import { Injectable } from '@nestjs/common';
import { AuditLog } from '../../../audit/core/audit-log.js';
import { ConflictError, NotFoundError } from '../../../base/core/errors.js';
import {
  BOUNDED,
  runContended,
  UnitOfWork,
} from '../../../base/core/unit-of-work.js';
import { subjectKey } from '../../../change-sets/core/lock.js';
import { LockStore } from '../../../change-sets/core/lock-store.js';
import { AccessAdmin } from '../access-admin.js';
import { beginAccessChange, keepAnAdmin } from '../access-changes.js';
import type { Actor } from '../actor.js';
import { ActorAction } from '../policy.js';
import type { User } from '../user-directory.js';
import { WaysIn } from '../ways-in.js';

export interface UserInput {
  readonly actor: Actor;
  readonly userId: string;
}

/** A user once deactivated, with how many locks it held and lost. */
export interface Deactivated {
  readonly user: User;
  readonly locksReleased: number;
}

/**
 * Deactivates a user: from its next request on it cannot act (403
 * `user-deactivated`), approvals it gave no longer hold, and every lock it
 * holds is released, each recorded as `lock.release` (`reason`
 * `user.deactivate`), so its modules and manuals are free for others, and
 * its sessions end (#37: `data.sessionsEnded`), with its links to set a
 * password and an open code by email (#645, `WaysIn`). Its
 * roles and work stay, for a reactivation. 404 `not-found` for no such user;
 * 409 `already-deactivated`; 409 `last-admin` when it is the last active
 * user holding `admin.roles` (also oneself). Recorded as `user.deactivate`.
 * Needs `admin.roles`.
 */
@Injectable()
export class DeactivateUserAction extends ActorAction<UserInput, Deactivated> {
  readonly policy = 'admin.roles';

  constructor(
    private readonly admin: AccessAdmin,
    private readonly locks: LockStore,
    private readonly waysIn: WaysIn,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected run({ actor, userId }: UserInput): Promise<Deactivated> {
    return runContended(
      this.unit,
      async (tx) => {
        await beginAccessChange(this.admin, tx, actor);
        const user = await this.admin.findUser(tx, userId);
        if (!user) throw new NotFoundError(`No user "${userId}".`);
        if (user.deactivatedAt !== null) {
          throw new ConflictError(
            'already-deactivated',
            `The user "${userId}" is deactivated already.`,
          );
        }
        const deactivatedAt = await this.admin.setDeactivated(tx, userId, true);
        await keepAnAdmin(this.admin, tx);
        const released = await this.locks.removeAllHeldBy(tx, {
          kind: 'user',
          id: userId,
        });
        const sessionsEnded = await this.waysIn.endAll(tx, userId);
        await this.auditLog.record(tx, actor, {
          action: 'user.deactivate',
          subject: { type: 'user', id: userId },
          data: { locksReleased: released.length, sessionsEnded },
        });
        for (const lock of released) {
          await this.auditLog.record(tx, actor, {
            action: 'lock.release',
            subject: subjectKey(lock.subject),
            data: {
              lockId: lock.id,
              changeSetId: lock.changeSetId,
              reason: 'user.deactivate',
              holder: { kind: 'user', id: userId },
            },
          });
        }
        return {
          user: { ...user, deactivatedAt },
          locksReleased: released.length,
        };
      },
      BOUNDED,
    );
  }
}

/**
 * Lets a deactivated user act again, with the roles it had. 404
 * `not-found` for no such user; 409 `not-deactivated`. Recorded as
 * `user.reactivate`. Needs `admin.roles`.
 */
@Injectable()
export class ReactivateUserAction extends ActorAction<UserInput, User> {
  readonly policy = 'admin.roles';

  constructor(
    private readonly admin: AccessAdmin,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected run({ actor, userId }: UserInput): Promise<User> {
    return runContended(
      this.unit,
      async (tx) => {
        await beginAccessChange(this.admin, tx, actor);
        const user = await this.admin.findUser(tx, userId);
        if (!user) throw new NotFoundError(`No user "${userId}".`);
        if (user.deactivatedAt === null) {
          throw new ConflictError(
            'not-deactivated',
            `The user "${userId}" is active.`,
          );
        }
        await this.admin.setDeactivated(tx, userId, false);
        await this.auditLog.record(tx, actor, {
          action: 'user.reactivate',
          subject: { type: 'user', id: userId },
        });
        return { ...user, deactivatedAt: null };
      },
      BOUNDED,
    );
  }
}
