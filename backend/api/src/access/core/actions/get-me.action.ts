import { Injectable } from '@nestjs/common';
import type { Actor } from '../actor.js';
import {
  type EffectivePermission,
  effectivePermissions,
} from '../effective-permissions.js';
import { ActorAction } from '../policy.js';
import { ServiceAccountStore } from '../service-accounts.js';
import { API_TOKEN_ACTOR, API_TOKEN_NAME } from '../service-actor.js';
import { UserDirectory } from '../user-directory.js';

export interface Me {
  readonly actor: Actor;
  /** The user's name, or the service's. */
  readonly name: string;
  readonly permissions: readonly EffectivePermission[];
}

/** The acting user or service, with its roles and effective permissions. */
@Injectable()
export class GetMeAction extends ActorAction<{ actor: Actor }, Me> {
  /** Anyone acting may see who they act as. */
  readonly policy = 'any-actor';

  constructor(
    private readonly users: UserDirectory,
    private readonly serviceAccounts: ServiceAccountStore,
  ) {
    super();
  }

  protected async run({ actor }: { actor: Actor }): Promise<Me> {
    // Gone since the request was resolved: its ID is all there is.
    const name =
      actor.kind === 'user'
        ? ((await this.users.findUser(actor.id))?.name ?? actor.id)
        : actor.id === API_TOKEN_ACTOR.id
          ? API_TOKEN_NAME
          : ((await this.serviceAccounts.find(actor.id))?.name ?? actor.id);
    return { actor, name, permissions: effectivePermissions(actor) };
  }
}
