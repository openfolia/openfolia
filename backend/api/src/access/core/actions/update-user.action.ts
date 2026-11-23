import { Injectable } from '@nestjs/common';
import { AuditLog } from '../../../audit/core/audit-log.js';
import { NotFoundError } from '../../../base/core/errors.js';
import {
  BOUNDED,
  runContended,
  UnitOfWork,
} from '../../../base/core/unit-of-work.js';
import { AccessAdmin } from '../access-admin.js';
import {
  beginAccessChange,
  changeRoles,
  type RoleChange,
} from '../access-changes.js';
import type { Actor } from '../actor.js';
import { ActorAction } from '../policy.js';
import type { User } from '../user-directory.js';
import { addressReplaced, WaysIn } from '../ways-in.js';
import { emailTaken } from './create-user.action.js';

/**
 * What to change about a user; a field left out stays as it is. `roles`
 * either replaces the roles (`set`) or adds and removes some.
 */
export interface UserChanges {
  readonly name?: string;
  /** Null removes it. */
  readonly email?: string | null;
  readonly roles?: { readonly set: readonly string[] } | RoleChange;
}

export interface UpdateUserInput {
  readonly actor: Actor;
  readonly userId: string;
  readonly changes: UserChanges;
}

/**
 * Changes a user's name, email or roles, in one transaction; role changes
 * take effect at the user's next request. 404 `not-found` for no such user;
 * 409 `email-taken`; 422 `unknown-role`; 409 `last-admin` when it would take
 * `admin.roles` from the last active user holding it. Recorded as
 * `user.update` (which fields changed, never their values) and a
 * `role.assign` or `role.unassign` per role. A new address (or none) ends
 * what was emailed to the old one: the links to set a password and an open
 * code by email (#645, `WaysIn.endMailed`). Needs `admin.roles`.
 */
@Injectable()
export class UpdateUserAction extends ActorAction<UpdateUserInput, User> {
  readonly policy = 'admin.roles';

  constructor(
    private readonly admin: AccessAdmin,
    private readonly waysIn: WaysIn,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected run({ actor, userId, changes }: UpdateUserInput): Promise<User> {
    return runContended(
      this.unit,
      async (tx) => {
        await beginAccessChange(this.admin, tx, actor);
        const user = await this.admin.findUser(tx, userId);
        if (!user) throw new NotFoundError(`No user "${userId}".`);
        const name = changes.name ?? user.name;
        const email = changes.email === undefined ? user.email : changes.email;
        const changed = [
          ...(name !== user.name ? ['name'] : []),
          ...(email !== user.email ? ['email'] : []),
        ];
        if (changed.length > 0) {
          if (
            email !== null &&
            email.toLowerCase() !== user.email?.toLowerCase() &&
            (await this.admin.emailTaken(tx, email, userId))
          ) {
            throw emailTaken();
          }
          await this.admin.updateUser(tx, userId, { name, email });
          if (addressReplaced(user.email, email)) {
            await this.waysIn.endMailed(tx, userId);
          }
          await this.auditLog.record(tx, actor, {
            action: 'user.update',
            subject: { type: 'user', id: userId },
            data: { changed },
          });
        }
        if (changes.roles) {
          const roles = changes.roles;
          // Only direct assignments are set here: a role held through a group follows the group.
          // One the user holds already (through a group too) is left as it is: listing it never
          // makes it direct, so it still goes with the group (`POST …/relationships/roles` does).
          const direct = user.roleIds.filter(
            (id) => !user.groupRoleIds.includes(id),
          );
          const change: RoleChange =
            'set' in roles
              ? {
                  add: roles.set.filter((id) => !user.roleIds.includes(id)),
                  remove: direct.filter((id) => !roles.set.includes(id)),
                }
              : roles;
          await changeRoles(
            this.admin,
            this.auditLog,
            tx,
            actor,
            userId,
            change,
          );
        }
        const updated = await this.admin.findUser(tx, userId);
        if (!updated) throw new NotFoundError(`No user "${userId}".`);
        return updated;
      },
      BOUNDED,
    );
  }
}
