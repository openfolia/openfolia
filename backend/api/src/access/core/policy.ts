import { ForbiddenError } from '../../base/core/errors.js';
import type { Actor } from './actor.js';
import { allows, ANYWHERE } from './allows.js';
import { Permission } from './permissions.js';

/**
 * What an action acting for someone needs: a permission, held in at least
 * one role (`allows(actor, permission, ANYWHERE)`), or only an actor
 * (`any-actor`, e.g. "who am I").
 */
export type ActorPolicy = Permission | 'any-actor';

/**
 * Actions that act for nobody: `public` ones answer anyone (the health
 * check), `internal` ones are never a request's use case (resolving who a
 * request acts as, before there is anyone to check).
 */
export type UnguardedPolicy = 'public' | 'internal';

export type Policy = ActorPolicy | UnguardedPolicy;

/**
 * An action run for an actor. Each declares its `policy`; `handle` checks
 * it before `run` does anything (no read, no write), so no caller can
 * forget it and no action can leave it out (the compiler requires `policy`,
 * and `policy.spec.ts` checks each action refuses an actor without
 * it). Subclasses implement `run`, never `handle`.
 *
 * The check is whether the permission is held at all (in some role, in
 * any scope). Content is read through `ReadableContent`, which filters it
 * by the actor's scope: a read outside it is not found, as if the item did
 * not exist, so its existence does not leak. Where a change's target
 * matters, `run` checks it once loaded (`allows(actor, permission,
 * moduleTarget(…))`); a change the actor may read but not make is
 * forbidden.
 */
export abstract class ActorAction<In extends { readonly actor: Actor }, Out> {
  abstract readonly policy: ActorPolicy;

  async handle(input: In): Promise<Out> {
    authorize(input?.actor, this.policy);
    return this.run(input);
  }

  protected abstract run(input: In): Promise<Out>;
}

/** An action that runs for nobody in particular; see `UnguardedPolicy`. */
export interface UnguardedAction {
  readonly policy: UnguardedPolicy;
}

/**
 * Throws `ForbiddenError` unless `actor` may act under `policy`. Fails
 * closed: no actor, or a policy that is no permission, refuses.
 */
export function authorize(
  actor: Actor | undefined,
  policy: ActorPolicy,
): asserts actor is Actor {
  if (!actor) throw new ForbiddenError('There is no actor to act for.');
  if (policy === 'any-actor') return;
  if (!Permission.safeParse(policy).success) {
    throw new ForbiddenError(`"${String(policy)}" is no permission.`);
  }
  if (!allows(actor, policy, ANYWHERE)) {
    throw new ForbiddenError(`This needs the ${policy} permission.`);
  }
}
