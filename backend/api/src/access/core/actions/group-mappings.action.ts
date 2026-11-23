import { Injectable } from '@nestjs/common';
import { AuditLog } from '../../../audit/core/audit-log.js';
import {
  ConflictError,
  NotFoundError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import type { PageRequest, Paginated } from '../../../base/core/paging.js';
import {
  BOUNDED,
  runContended,
  type Transaction,
  UnitOfWork,
} from '../../../base/core/unit-of-work.js';
import { AccessAdmin } from '../access-admin.js';
import { beginAccessChange, keepAnAdmin } from '../access-changes.js';
import type { Actor } from '../actor.js';
import {
  type GroupMapping,
  type GroupMappingFilter,
  GroupMappings,
} from '../group-mappings.js';
import { ActorAction } from '../policy.js';

/** One page of the group mappings (#37), filtered. Needs `admin.roles`. */
@Injectable()
export class ListGroupMappingsAction extends ActorAction<
  { actor: Actor; page: PageRequest; filter?: GroupMappingFilter },
  Paginated<GroupMapping>
> {
  readonly policy = 'admin.roles';

  constructor(private readonly mappings: GroupMappings) {
    super();
  }

  protected run({
    page,
    filter,
  }: {
    actor: Actor;
    page: PageRequest;
    filter?: GroupMappingFilter;
  }): Promise<Paginated<GroupMapping>> {
    return this.mappings.list(page, filter);
  }
}

/** One group mapping; 404 `not-found` for none. Needs `admin.roles`. */
@Injectable()
export class GetGroupMappingAction extends ActorAction<
  { actor: Actor; id: string },
  GroupMapping
> {
  readonly policy = 'admin.roles';

  constructor(private readonly mappings: GroupMappings) {
    super();
  }

  protected async run({
    id,
  }: {
    actor: Actor;
    id: string;
  }): Promise<GroupMapping> {
    const mapping = await this.mappings.find(id);
    if (!mapping) throw new NotFoundError(`No group mapping "${id}".`);
    return mapping;
  }
}

/**
 * Applies the mappings to every user last seen in `group`, recording each
 * role gained or lost (`role.assign` / `role.unassign`, `data.via`
 * `groups`); answers whether a role with `admin.roles` was lost.
 */
async function reapply(
  admin: AccessAdmin,
  mappings: GroupMappings,
  auditLog: AuditLog,
  tx: Transaction,
  actor: Actor,
  group: string,
): Promise<boolean> {
  let tookAdmin = false;
  for (const userId of await mappings.usersInGroup(tx, group)) {
    const change = await mappings.applyGroupRoles(tx, userId);
    for (const roleId of change.unassigned) {
      const role = await admin.findRole(roleId, tx);
      if (role?.permissions.includes('admin.roles')) tookAdmin = true;
      await auditLog.record(tx, actor, {
        action: 'role.unassign',
        subject: { type: 'role', id: roleId },
        data: { userId, via: 'groups' },
      });
    }
    for (const roleId of change.assigned) {
      await auditLog.record(tx, actor, {
        action: 'role.assign',
        subject: { type: 'role', id: roleId },
        data: { userId, via: 'groups' },
      });
    }
  }
  return tookAdmin;
}

/**
 * Gives the members of `group` the role `roleId` (#37): at once for every
 * user last seen in the group (from their next request), and at sign-in for
 * everyone else. 422 `unknown-role` (`meta.roles`); 409
 * `group-mapping-exists` when the group holds the role already. Recorded as
 * `group-mapping.create`, and a `role.assign` per user it gives the role.
 * Needs `admin.roles`.
 */
@Injectable()
export class CreateGroupMappingAction extends ActorAction<
  { actor: Actor; group: string; roleId: string },
  GroupMapping
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
    group,
    roleId,
  }: {
    actor: Actor;
    group: string;
    roleId: string;
  }): Promise<GroupMapping> {
    return runContended(
      this.unit,
      async (tx) => {
        await beginAccessChange(this.admin, tx, actor);
        if ((await this.admin.missingRoles(tx, [roleId])).length > 0) {
          throw new UnprocessableError('unknown-role', `No role "${roleId}".`, {
            roles: [roleId],
          });
        }
        const mapping = await this.mappings.insert(tx, group, roleId);
        if (!mapping) {
          throw new ConflictError(
            'group-mapping-exists',
            `The group already holds the role "${roleId}".`,
          );
        }
        await this.auditLog.record(tx, actor, {
          action: 'group-mapping.create',
          subject: { type: 'group-mapping', id: mapping.id },
          data: { group, roleId },
        });
        await reapply(
          this.admin,
          this.mappings,
          this.auditLog,
          tx,
          actor,
          group,
        );
        return mapping;
      },
      BOUNDED,
    );
  }
}

/**
 * Removes a group mapping (#37): the group's members lose the role at once
 * (a direct assignment of it stays). 404 `not-found`; 409 `last-admin` when
 * that leaves no active user holding `admin.roles`. Recorded as
 * `group-mapping.delete`, and a `role.unassign` per user losing the role.
 * Needs `admin.roles`.
 */
@Injectable()
export class DeleteGroupMappingAction extends ActorAction<
  { actor: Actor; id: string },
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

  protected run({ actor, id }: { actor: Actor; id: string }): Promise<void> {
    return runContended(
      this.unit,
      async (tx) => {
        await beginAccessChange(this.admin, tx, actor);
        const mapping = await this.mappings.delete(tx, id);
        if (!mapping) throw new NotFoundError(`No group mapping "${id}".`);
        await this.auditLog.record(tx, actor, {
          action: 'group-mapping.delete',
          subject: { type: 'group-mapping', id },
          data: { group: mapping.group, roleId: mapping.roleId },
        });
        const tookAdmin = await reapply(
          this.admin,
          this.mappings,
          this.auditLog,
          tx,
          actor,
          mapping.group,
        );
        if (tookAdmin) await keepAnAdmin(this.admin, tx);
      },
      BOUNDED,
    );
  }
}
