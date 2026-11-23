import { Injectable } from '@nestjs/common';
import { AuditLog } from '../../../audit/core/audit-log.js';
import { ConflictError } from '../../../base/core/errors.js';
import {
  BOUNDED,
  runContended,
  UnitOfWork,
} from '../../../base/core/unit-of-work.js';
import { subjectKey } from '../../../change-sets/core/lock.js';
import { LockStore } from '../../../change-sets/core/lock-store.js';
import { AccessAdmin } from '../access-admin.js';
import { beginAccessChange } from '../access-changes.js';
import type { Actor } from '../actor.js';
import { ActorAction } from '../policy.js';
import { serviceAccountIn } from '../service-account-changes.js';
import {
  type ServiceAccount,
  ServiceAccountStore,
} from '../service-accounts.js';

export interface ServiceAccountInput {
  readonly actor: Actor;
  readonly serviceAccountId: string;
}

/** A service account once deactivated, with how many locks it held and lost. */
export interface DeactivatedServiceAccount {
  readonly account: ServiceAccount;
  readonly locksReleased: number;
}

/**
 * Deactivates a service account: from its next request on none of its
 * tokens may act (403 `service-account-deactivated`), and every lock it
 * holds is released, each recorded as `lock.release` (`reason`
 * `service-account.deactivate`). Its roles and tokens stay, for a
 * reactivation. 404 `not-found`; 409 `already-deactivated`. Recorded as
 * `service-account.deactivate`. Needs `admin.roles`, held by a user.
 */
@Injectable()
export class DeactivateServiceAccountAction extends ActorAction<
  ServiceAccountInput,
  DeactivatedServiceAccount
> {
  readonly policy = 'admin.roles';

  constructor(
    private readonly admin: AccessAdmin,
    private readonly store: ServiceAccountStore,
    private readonly locks: LockStore,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected run({
    actor,
    serviceAccountId: id,
  }: ServiceAccountInput): Promise<DeactivatedServiceAccount> {
    return runContended(
      this.unit,
      async (tx) => {
        await beginAccessChange(this.admin, tx, actor);
        const account = await serviceAccountIn(this.store, tx, id);
        if (account.deactivatedAt !== null) {
          throw new ConflictError(
            'already-deactivated',
            `The service account "${id}" is deactivated already.`,
          );
        }
        const deactivatedAt = await this.store.setDeactivated(tx, id, true);
        const holder = { kind: 'service', id } as const;
        const released = await this.locks.removeAllHeldBy(tx, holder);
        await this.auditLog.record(tx, actor, {
          action: 'service-account.deactivate',
          subject: { type: 'service-account', id },
          data: { locksReleased: released.length },
        });
        for (const lock of released) {
          await this.auditLog.record(tx, actor, {
            action: 'lock.release',
            subject: subjectKey(lock.subject),
            data: {
              lockId: lock.id,
              changeSetId: lock.changeSetId,
              reason: 'service-account.deactivate',
              holder,
            },
          });
        }
        return {
          account: { ...account, deactivatedAt },
          locksReleased: released.length,
        };
      },
      BOUNDED,
    );
  }
}

/**
 * Lets a deactivated service account act again, with the roles and the
 * tokens it had (those not revoked or expired). 404 `not-found`; 409
 * `not-deactivated`. Recorded as `service-account.reactivate`. Needs
 * `admin.roles`, held by a user.
 */
@Injectable()
export class ReactivateServiceAccountAction extends ActorAction<
  ServiceAccountInput,
  ServiceAccount
> {
  readonly policy = 'admin.roles';

  constructor(
    private readonly admin: AccessAdmin,
    private readonly store: ServiceAccountStore,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected run({
    actor,
    serviceAccountId: id,
  }: ServiceAccountInput): Promise<ServiceAccount> {
    return runContended(
      this.unit,
      async (tx) => {
        await beginAccessChange(this.admin, tx, actor);
        const account = await serviceAccountIn(this.store, tx, id);
        if (account.deactivatedAt === null) {
          throw new ConflictError(
            'not-deactivated',
            `The service account "${id}" is active.`,
          );
        }
        await this.store.setDeactivated(tx, id, false);
        await this.auditLog.record(tx, actor, {
          action: 'service-account.reactivate',
          subject: { type: 'service-account', id },
        });
        return { ...account, deactivatedAt: null };
      },
      BOUNDED,
    );
  }
}
