import { Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../base/core/errors.js';
import type { PageRequest, Paginated } from '../../../base/core/paging.js';
import { AccessAdmin, type StoredRole } from '../access-admin.js';
import type { Actor } from '../actor.js';
import { ActorAction } from '../policy.js';

/** One page of the roles, by name, with how many users hold each; needs `admin.roles`. */
@Injectable()
export class ListRolesAction extends ActorAction<
  { actor: Actor; page: PageRequest },
  Paginated<StoredRole>
> {
  readonly policy = 'admin.roles';

  constructor(private readonly admin: AccessAdmin) {
    super();
  }

  protected run({
    page,
  }: {
    page: PageRequest;
  }): Promise<Paginated<StoredRole>> {
    return this.admin.listRoles(page);
  }
}

/** One role; 404 `not-found` when there is none. Needs `admin.roles`. */
@Injectable()
export class GetRoleAction extends ActorAction<
  { actor: Actor; roleId: string },
  StoredRole
> {
  readonly policy = 'admin.roles';

  constructor(private readonly admin: AccessAdmin) {
    super();
  }

  protected async run({ roleId }: { roleId: string }): Promise<StoredRole> {
    const role = await this.admin.findRole(roleId);
    if (!role) throw new NotFoundError(`No role "${roleId}".`);
    return role;
  }
}
