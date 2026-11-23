import { Injectable } from '@nestjs/common';
import type { Actor } from '../actor.js';
import type { UnguardedAction } from '../policy.js';
import { API_TOKEN_ACTOR } from '../service-actor.js';
import { UserDirectory } from '../user-directory.js';

/** Who an authenticated request acts as, or why it cannot act at all. */
export type ActorResolution =
  | { readonly actor: Actor }
  /** A user was asked for, but demo mode is off: only the token's service exists. */
  | { readonly refused: 'demo-mode-off' }
  /** Demo mode: no such user. */
  | { readonly refused: 'unknown-user' }
  /** The user exists but is deactivated: it cannot act. */
  | { readonly refused: 'user-deactivated' };

/**
 * Resolves the actor of a request whose shared token has already been
 * checked (the caller's job; this never authenticates anything). Without a
 * requested user it is the token's read-only service. With one, it is that
 * user, in demo mode only; outside demo mode the request is refused rather
 * than quietly served as the service, so a client relying on the header
 * learns at once that it is not honoured.
 */
@Injectable()
export class ResolveActorAction implements UnguardedAction {
  /** Run by the guard to find the actor, before there is one to check. */
  readonly policy = 'internal';

  constructor(private readonly users: UserDirectory) {}

  async handle({
    requestedUser,
    demo,
  }: {
    /** The user the request asks to act as; undefined when it asks for none. */
    requestedUser: string | undefined;
    demo: boolean;
  }): Promise<ActorResolution> {
    if (requestedUser === undefined) return { actor: API_TOKEN_ACTOR };
    if (!demo) return { refused: 'demo-mode-off' };
    // A failing directory (database down, invalid stored role) rejects:
    // never a fallback to another actor.
    const actor = await this.users.findActor(requestedUser);
    if (actor) return { actor };
    // Not an actor: no such user, or a deactivated one (`findActor` gives
    // neither), told apart so a client can say which.
    const user = await this.users.findUser(requestedUser);
    return user?.deactivatedAt
      ? { refused: 'user-deactivated' }
      : { refused: 'unknown-user' };
  }
}
