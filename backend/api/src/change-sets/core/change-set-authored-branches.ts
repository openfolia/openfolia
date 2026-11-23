import { Injectable } from '@nestjs/common';
import type { Actor } from '../../access/core/actor.js';
import { AuthoredBranches } from '../../content/core/authored-branches.js';
import { idOfBranch } from './change-set.js';
import { ChangeSetStore } from './change-set-store.js';
import { isActor, opensAsAuthor, readsChangeSets } from './own-work.js';

/**
 * `AuthoredBranches` over the change sets: a change-set branch
 * (`change-sets/<id>`) is authored by its change set's author, in any
 * state (an abandoned one's branch stays readable), when it started from
 * released content (`opensAsAuthor`). Every other name is
 * authored by nobody.
 */
@Injectable()
export class ChangeSetAuthoredBranches extends AuthoredBranches {
  constructor(private readonly changeSets: ChangeSetStore) {
    super();
  }

  async authoredBy(actor: Actor, branch: string): Promise<boolean> {
    const id = idOfBranch(branch);
    if (id === undefined) return false;
    const changeSet = await this.changeSets.find(id);
    return (
      changeSet !== undefined &&
      changeSet.branch === branch &&
      opensAsAuthor(actor, changeSet)
    );
  }

  async visibleChangeSet(actor: Actor, branch: string): Promise<boolean> {
    const id = idOfBranch(branch);
    if (id === undefined) return false;
    const changeSet = await this.changeSets.find(id);
    return (
      changeSet !== undefined &&
      changeSet.branch === branch &&
      (readsChangeSets(actor) || isActor(actor, changeSet.author))
    );
  }
}
