import { Injectable } from '@nestjs/common';
import { AuditLog } from '../../../audit/core/audit-log.js';
import { ConflictError, NotFoundError } from '../../../base/core/errors.js';
import {
  BOUNDED,
  runContended,
  UnitOfWork,
} from '../../../base/core/unit-of-work.js';
import { AccessAdmin } from '../access-admin.js';
import { beginAccessChange } from '../access-changes.js';
import type { Actor } from '../actor.js';
import { GroupMappings } from '../group-mappings.js';
import { ActorAction } from '../policy.js';
import { grantOf } from './create-role.action.js';

/**
 * Deletes a role nobody holds. 404 `not-found` for no such role; 409
 * `role-in-use` (`meta.holders`, `meta.groupMappings`) while users or service accounts hold it,
 * or a group mapping gives it (#37): take it from them, or remove the mapping, first, so deleting
 * a role never silently changes what someone may do.
 * Recorded as `role.delete` with what it granted. Needs `admin.roles`.
 */
@Injectable()
export class DeleteRoleAction extends ActorAction<
  { actor: Actor; roleId: string },
  void
> {
  readonly policy = 'admin.roles';

  constructor(
    private readonly admin: AccessAdmin,
    private readonly mappings: GroupMappings,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected run({
    actor,
    roleId,
  }: {
    actor: Actor;
    roleId: string;
  }): Promise<void> {
    return runContended(
      this.unit,
      async (tx) => {
        await beginAccessChange(this.admin, tx, actor);
        const role = await this.admin.findRole(roleId, tx);
        if (!role) throw new NotFoundError(`No role "${roleId}".`);
        const groupMappings = await this.mappings.countForRole(tx, roleId);
        if (role.holders > 0 || groupMappings > 0) {
          throw new ConflictError(
            'role-in-use',
            groupMappings > 0
              ? `The role "${roleId}" is given by ${groupMappings} group mapping(s); remove them first, then take it from whoever holds it directly.`
              : `The role "${roleId}" is held by ${role.holders} user(s) or service account(s); take it from them first.`,
            { holders: role.holders, groupMappings },
          );
        }
        await this.admin.deleteRole(tx, roleId);
        await this.auditLog.record(tx, actor, {
          action: 'role.delete',
          subject: { type: 'role', id: roleId },
          data: grantOf(role),
        });
      },
      BOUNDED,
    );
  }
}
