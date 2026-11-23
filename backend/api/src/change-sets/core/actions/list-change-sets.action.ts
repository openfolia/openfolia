import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import type { Permission } from '../../../access/core/permissions.js';
import { ActorAction } from '../../../access/core/policy.js';
import type { PageRequest, Paginated } from '../../../base/core/paging.js';
import {
  type ChangeSet,
  type ChangeSetFilter,
  type ChangeSetState,
  noneInEachState,
} from '../change-set.js';
import { ChangeSetStore } from '../change-set-store.js';
import { readsChangeSets } from '../own-work.js';

/**
 * The permission that reads every change set: the one that reads their
 * branches, `content.read.draft`. Without it an actor reads their own
 * (#126: authors always see their own work).
 */
export const READ_CHANGE_SETS = 'content.read.draft' satisfies Permission;

/** A page of change sets, with how many of those the reader sees are in each state. */
export interface ChangeSetPage extends Paginated<ChangeSet> {
  /** Per state, the change sets matching the filter but its `state` (#481). */
  readonly counts: Record<ChangeSetState, number>;
}

/**
 * One page of change sets, newest first: every change set for a holder of
 * `content.read.draft`, only the actor's own for anyone else (another
 * author's filter then lists nothing), so it needs only an actor. With
 * the counts per state of the change sets the filter leaves but for its
 * state, as the reader sees them (a list's state filters show them).
 */
@Injectable()
export class ListChangeSetsAction extends ActorAction<
  { actor: Actor; filter: ChangeSetFilter; page: PageRequest },
  ChangeSetPage
> {
  readonly policy = 'any-actor';

  constructor(private readonly store: ChangeSetStore) {
    super();
  }

  protected async run({
    actor,
    filter,
    page,
  }: {
    actor: Actor;
    filter: ChangeSetFilter;
    page: PageRequest;
  }): Promise<ChangeSetPage> {
    let seen: ChangeSetFilter = filter;
    if (!readsChangeSets(actor)) {
      if (filter.author !== undefined && filter.author !== actor.id) {
        return { total: 0, items: [], counts: noneInEachState() };
      }
      seen = { ...filter, author: actor.id, authorKind: actor.kind };
    }
    const [found, counts] = await Promise.all([
      this.store.list(seen, page),
      this.store.countByState(seen),
    ]);
    return { ...found, counts };
  }
}
