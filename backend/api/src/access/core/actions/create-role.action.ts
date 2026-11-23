import { Injectable } from '@nestjs/common';
import { AuditLog } from '../../../audit/core/audit-log.js';
import { ConflictError } from '../../../base/core/errors.js';
import {
  BOUNDED,
  runContended,
  UnitOfWork,
} from '../../../base/core/unit-of-work.js';
import {
  AccessAdmin,
  type RoleDefinition,
  type StoredRole,
} from '../access-admin.js';
import { beginAccessChange } from '../access-changes.js';
import type { Actor } from '../actor.js';
import { ActorAction } from '../policy.js';

/** What a role grants, as the audit log records it. */
export function grantOf(role: RoleDefinition): Record<string, unknown> {
  return { permissions: [...role.permissions], scope: { ...role.scope } };
}

/**
 * Creates a role (a name, a description, permissions and a scope), held by
 * nobody yet; 409 `role-exists` when its ID is taken. Recorded as
 * `role.create` with what it grants. Needs `admin.roles`.
 */
@Injectable()
export class CreateRoleAction extends ActorAction<
  { actor: Actor; role: RoleDefinition },
  StoredRole
> {
  readonly policy = 'admin.roles';

  constructor(
    private readonly admin: AccessAdmin,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected run({
    actor,
    role,
  }: {
    actor: Actor;
    role: RoleDefinition;
  }): Promise<StoredRole> {
    return runContended(
      this.unit,
      async (tx) => {
        await beginAccessChange(this.admin, tx, actor);
        if (!(await this.admin.insertRole(tx, role))) {
          throw new ConflictError(
            'role-exists',
            `There is a role "${role.id}" already.`,
          );
        }
        await this.auditLog.record(tx, actor, {
          action: 'role.create',
          subject: { type: 'role', id: role.id },
          data: grantOf(role),
        });
        return { ...role, holders: 0 };
      },
      BOUNDED,
    );
  }
}
