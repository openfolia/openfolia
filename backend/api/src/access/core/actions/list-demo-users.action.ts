import { Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../base/core/errors.js';
import type { PageRequest, Paginated } from '../../../base/core/paging.js';
import type { Actor } from '../actor.js';
import { ActorAction } from '../policy.js';
import { type User, UserDirectory } from '../user-directory.js';

/**
 * One page of the users a demo client can act as (`X-Ccms-User`), for its
 * user switcher. Demo mode only: anyone holding the token can already act as
 * any user there (so as one with `admin.roles`, who lists them), so this
 * shows nothing more, and it is 404 everywhere else, which is also how a
 * client learns that demo mode is off.
 */
@Injectable()
export class ListDemoUsersAction extends ActorAction<
  { actor: Actor; page: PageRequest; demo: boolean },
  Paginated<User>
> {
  /** The switcher is used before anyone is chosen: the token's service lists them too. */
  readonly policy = 'any-actor';

  constructor(private readonly users: UserDirectory) {
    super();
  }

  protected run({
    page,
    demo,
  }: {
    page: PageRequest;
    demo: boolean;
  }): Promise<Paginated<User>> {
    if (!demo) {
      return Promise.reject(new NotFoundError('There is no such route.'));
    }
    // A deactivated user cannot act, so it is not offered.
    return this.users.listUsers(page, { active: true });
  }
}
