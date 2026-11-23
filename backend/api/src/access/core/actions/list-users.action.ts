import { Injectable } from '@nestjs/common';
import type { PageRequest, Paginated } from '../../../base/core/paging.js';
import type { Actor } from '../actor.js';
import { ActorAction } from '../policy.js';
import {
  type User,
  UserDirectory,
  type UserFilter,
} from '../user-directory.js';

/** One page of the users matching `filter`, with their roles; needs `admin.roles`. */
@Injectable()
export class ListUsersAction extends ActorAction<
  { actor: Actor; page: PageRequest; filter?: UserFilter },
  Paginated<User>
> {
  readonly policy = 'admin.roles';

  constructor(private readonly users: UserDirectory) {
    super();
  }

  protected run({
    page,
    filter,
  }: {
    page: PageRequest;
    filter?: UserFilter;
  }): Promise<Paginated<User>> {
    return this.users.listUsers(page, filter);
  }
}
