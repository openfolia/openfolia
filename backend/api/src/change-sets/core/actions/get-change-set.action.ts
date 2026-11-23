import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { NotFoundError } from '../../../base/core/errors.js';
import type { ChangeSet } from '../change-set.js';
import { ChangeSetStore } from '../change-set-store.js';
import { isActor, readsChangeSets } from '../own-work.js';

/**
 * One change set by its ID; not found for any ID that names none. A
 * holder of `content.read.draft` reads every one; anyone else only their
 * own (#126), another author's being not found exactly like a missing one
 * (#125), so it needs only an actor.
 */
@Injectable()
export class GetChangeSetAction extends ActorAction<
  { actor: Actor; id: string },
  ChangeSet
> {
  readonly policy = 'any-actor';

  constructor(private readonly store: ChangeSetStore) {
    super();
  }

  protected async run({
    actor,
    id,
  }: {
    actor: Actor;
    id: string;
  }): Promise<ChangeSet> {
    const changeSet = await this.store.find(id);
    if (
      !changeSet ||
      (!readsChangeSets(actor) && !isActor(actor, changeSet.author))
    ) {
      throw new NotFoundError(`No change set "${id}".`);
    }
    return changeSet;
  }
}
