import { Injectable } from '@nestjs/common';
import { AuditLog } from '../../../audit/core/audit-log.js';
import {
  BOUNDED,
  runContended,
  UnitOfWork,
} from '../../../base/core/unit-of-work.js';
import { AccessAdmin } from '../access-admin.js';
import { beginAccessChange, type RoleChange } from '../access-changes.js';
import type { Actor } from '../actor.js';
import { ActorAction } from '../policy.js';
import {
  changeServiceAccountRoles,
  serviceAccountIn,
} from '../service-account-changes.js';
import {
  type ServiceAccount,
  ServiceAccountStore,
} from '../service-accounts.js';

/**
 * What to change about a service account; a field left out stays as it
 * is. `roles` either replaces the roles (`set`) or adds and removes some.
 */
export interface ServiceAccountChanges {
  readonly name?: string;
  /** Null removes it. */
  readonly description?: string | null;
  readonly roles?: { readonly set: readonly string[] } | RoleChange;
}

export interface UpdateServiceAccountInput {
  readonly actor: Actor;
  readonly serviceAccountId: string;
  readonly changes: ServiceAccountChanges;
}

/**
 * Changes a service account's name, description or roles, in one
 * transaction; role changes apply from its next request. 404 `not-found`;
 * 422 `unknown-role`. Recorded as `service-account.update` (which fields
 * changed, never their values) and a `role.assign` or `role.unassign` per
 * role. Needs `admin.roles`, held by a user.
 */
@Injectable()
export class UpdateServiceAccountAction extends ActorAction<
  UpdateServiceAccountInput,
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
    changes,
  }: UpdateServiceAccountInput): Promise<ServiceAccount> {
    return runContended(
      this.unit,
      async (tx) => {
        await beginAccessChange(this.admin, tx, actor);
        const account = await serviceAccountIn(this.store, tx, id);
        const name = changes.name ?? account.name;
        const description =
          changes.description === undefined
            ? account.description
            : changes.description;
        const changed = [
          ...(name !== account.name ? ['name'] : []),
          ...(description !== account.description ? ['description'] : []),
        ];
        if (changed.length > 0) {
          await this.store.update(tx, id, { name, description });
          await this.auditLog.record(tx, actor, {
            action: 'service-account.update',
            subject: { type: 'service-account', id },
            data: { changed },
          });
        }
        if (changes.roles) {
          const roles = changes.roles;
          const change: RoleChange =
            'set' in roles
              ? {
                  add: roles.set.filter((r) => !account.roleIds.includes(r)),
                  remove: account.roleIds.filter((r) => !roles.set.includes(r)),
                }
              : roles;
          await changeServiceAccountRoles(
            this.admin,
            this.store,
            this.auditLog,
            tx,
            actor,
            id,
            change,
          );
        }
        return serviceAccountIn(this.store, tx, id);
      },
      BOUNDED,
    );
  }
}
