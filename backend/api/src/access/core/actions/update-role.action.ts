import { Injectable } from '@nestjs/common';
import { AuditLog } from '../../../audit/core/audit-log.js';
import { ConflictError, NotFoundError } from '../../../base/core/errors.js';
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
import {
  applyGroupRolesOf,
  beginAccessChange,
  keepAnAdmin,
} from '../access-changes.js';
import { GroupMappings } from '../group-mappings.js';
import { GLOBAL_PERMISSIONS } from '../permissions.js';
import type { Actor } from '../actor.js';
import { ActorAction } from '../policy.js';
import { grantOf } from './create-role.action.js';

/** What may change in a role; a field left out stays as it is. The scope is replaced whole. */
export type RoleChanges = Partial<Omit<RoleDefinition, 'id'>>;

const FIELDS = ['name', 'description', 'permissions', 'scope'] as const;

/** JSON with object keys sorted, so equal values compare equal whatever their key order. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : item,
  );
}

/**
 * Changes a role's name, description, permissions or scope; it takes
 * effect for its holders at their next request. 404 `not-found` for no such
 * role; 409 `last-admin` when it would take `admin.roles` from the last
 * active user holding it. Recorded as `role.update` with the fields changed
 * and what the role grants now. Needs `admin.roles`.
 */
@Injectable()
export class UpdateRoleAction extends ActorAction<
  { actor: Actor; roleId: string; changes: RoleChanges },
  StoredRole
> {
  readonly policy = 'admin.roles';

  constructor(
    private readonly admin: AccessAdmin,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
    private readonly mappings: GroupMappings,
  ) {
    super();
  }

  protected run({
    actor,
    roleId,
    changes,
  }: {
    actor: Actor;
    roleId: string;
    changes: RoleChanges;
  }): Promise<StoredRole> {
    return runContended(
      this.unit,
      async (tx) => {
        await beginAccessChange(this.admin, tx, actor);
        const stored = await this.admin.findRole(roleId, tx);
        if (!stored) throw new NotFoundError(`No role "${roleId}".`);
        const { holders, ...before } = stored;
        const after: RoleDefinition = { ...before, ...changes, id: roleId };
        const changed = FIELDS.filter(
          (field) => stableJson(before[field]) !== stableJson(after[field]),
        );
        if (changed.length === 0) return stored;
        if (
          !before.permissions.includes('admin.roles') &&
          after.permissions.includes('admin.roles') &&
          (await this.admin.serviceAccountHolders(tx, roleId)) > 0
        ) {
          throw new ConflictError(
            'role-held-by-service-account',
            `Service accounts hold the role "${roleId}": take it from them before giving it admin.roles.`,
          );
        }
        await this.admin.updateRole(tx, after);
        if (
          before.permissions.includes('admin.roles') &&
          !after.permissions.includes('admin.roles')
        ) {
          await keepAnAdmin(this.admin, tx);
        }
        await this.auditLog.record(tx, actor, {
          action: 'role.update',
          subject: { type: 'role', id: roleId },
          data: { changed: [...changed], ...grantOf(after) },
        });
        // Whether a SCIM group may give the role turns on its global permissions (#377): when
        // they change, its members through such a group gain or lose it now, not at their next
        // membership change.
        const global = (permissions: readonly string[]) =>
          [...GLOBAL_PERMISSIONS].filter((p) => permissions.includes(p)).join();
        if (global(before.permissions) !== global(after.permissions)) {
          const users = new Set<string>();
          for (const group of await this.mappings.groupsForRole(tx, roleId)) {
            for (const userId of await this.mappings.usersInGroup(tx, group)) {
              users.add(userId);
            }
          }
          let tookAdmin = false;
          for (const userId of users) {
            tookAdmin =
              (await applyGroupRolesOf(
                this.admin,
                this.mappings,
                this.auditLog,
                tx,
                actor,
                userId,
              )) || tookAdmin;
          }
          if (tookAdmin) await keepAnAdmin(this.admin, tx);
        }
        return { ...after, holders };
      },
      BOUNDED,
    );
  }
}
