import { Injectable } from '@nestjs/common';
import { type Actor, UserId } from '../actor.js';
import { DeactivatedUsers } from '../deactivated-users.js';
import { ActorAction } from '../policy.js';

/** A user named in an answer, and whether they are deactivated. */
export interface Person {
  readonly id: string;
  readonly deactivated: boolean;
}

/**
 * The users an answer names, each once, by ID, and whether they are deactivated: all it says of
 * them, so an answer tells no more about a user than that the one it names is deactivated. An ID
 * no user has is an active one's: it is not told apart.
 */
@Injectable()
export class GetPeopleAction extends ActorAction<
  { actor: Actor; userIds: readonly string[] },
  readonly Person[]
> {
  /** For the users an answer already names: what it names is its own action's policy. */
  readonly policy = 'any-actor';

  constructor(private readonly users: DeactivatedUsers) {
    super();
  }

  protected async run({
    userIds,
  }: {
    userIds: readonly string[];
  }): Promise<readonly Person[]> {
    const ids = [...new Set(userIds)].sort();
    const known = ids.filter((id) => UserId.safeParse(id).success);
    const deactivated =
      known.length > 0 ? await this.users.among(known) : new Set<string>();
    return ids.map((id) => ({ id, deactivated: deactivated.has(id) }));
  }
}
