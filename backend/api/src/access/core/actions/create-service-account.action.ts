import { Injectable } from '@nestjs/common';
import { AuditLog } from '../../../audit/core/audit-log.js';
import { ConflictError } from '../../../base/core/errors.js';
import {
  BOUNDED,
  runContended,
  UnitOfWork,
} from '../../../base/core/unit-of-work.js';
import { AccessAdmin } from '../access-admin.js';
import { beginAccessChange } from '../access-changes.js';
import type { Actor } from '../actor.js';
import { ActorAction } from '../policy.js';
import {
  changeServiceAccountRoles,
  serviceAccountIn,
} from '../service-account-changes.js';
import {
  type NewServiceAccount,
  type ServiceAccount,
  ServiceAccountStore,
} from '../service-accounts.js';
import { Sandbox } from '../../../sandbox/core/sandbox.js';

export interface CreateServiceAccountInput {
  readonly actor: Actor;
  readonly account: NewServiceAccount;
  /** The roles it starts with, each once. */
  readonly roleIds: readonly string[];
}

/**
 * Adds a service account: an ID the client chooses, a name, a
 * description and roles; active at once, without tokens (issue one with
 * `IssueServiceTokenAction`). 409 `service-account-exists` when the ID is
 * taken; 422 `unknown-role`. Recorded as `service-account.create` (the IDs
 * only) and a `role.assign` per role. Needs `admin.roles`, held by a user.
 */
@Injectable()
export class CreateServiceAccountAction extends ActorAction<
  CreateServiceAccountInput,
  ServiceAccount
> {
  readonly policy = 'admin.roles';

  constructor(
    private readonly admin: AccessAdmin,
    private readonly store: ServiceAccountStore,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
    private readonly sandbox: Sandbox = Sandbox.OFF,
  ) {
    super();
  }

  protected run({
    actor,
    account,
    roleIds,
  }: CreateServiceAccountInput): Promise<ServiceAccount> {
    this.sandbox.refuse('service-accounts');
    return runContended(
      this.unit,
      async (tx) => {
        await beginAccessChange(this.admin, tx, actor);
        if (!(await this.store.insert(tx, account))) {
          throw new ConflictError(
            'service-account-exists',
            `There is a service account "${account.id}" already.`,
          );
        }
        await this.auditLog.record(tx, actor, {
          action: 'service-account.create',
          subject: { type: 'service-account', id: account.id },
          data: { roleIds: [...roleIds] },
        });
        await changeServiceAccountRoles(
          this.admin,
          this.store,
          this.auditLog,
          tx,
          actor,
          account.id,
          { add: roleIds },
        );
        return serviceAccountIn(this.store, tx, account.id);
      },
      BOUNDED,
    );
  }
}
