import { Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../base/core/errors.js';
import type { Actor } from '../actor.js';
import { ActorAction } from '../policy.js';
import { type User, UserDirectory } from '../user-directory.js';

/** One user, deactivated or not; 404 `not-found` when there is none. Needs `admin.roles`. */
@Injectable()
export class GetUserAction extends ActorAction<
  { actor: Actor; userId: string },
  User
> {
  readonly policy = 'admin.roles';

  constructor(private readonly users: UserDirectory) {
    super();
  }

  protected async run({ userId }: { userId: string }): Promise<User> {
    const user = await this.users.findUser(userId);
    if (!user) throw new NotFoundError(`No user "${userId}".`);
    return user;
  }
}
