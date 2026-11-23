import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { NotFoundError } from '../../../base/core/errors.js';
import {
  type PageRequest,
  type Paginated,
  paginate,
} from '../../../base/core/paging.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import type { Lock, LockFilter } from '../lock.js';
import { LockStore } from '../lock-store.js';
import { seesLock, visibleLocks } from '../lock-visibility.js';
import { readsChangeSets } from '../own-work.js';
import { draftLanguages, readsAllDrafts } from '../subject-scope.js';

/**
 * One page of locks, newest first: who holds what, for which change set.
 * Reading locks follows reading change sets: a holder of
 * `content.read.draft` sees the locks whose subject lies within that scope,
 * anyone else only their own (#126), within their `content.read` scope
 * (`visibleLocks`), filtered before paging so the total counts only those.
 * So it needs only an actor.
 */
@Injectable()
export class ListLocksAction extends ActorAction<
  { actor: Actor; filter: LockFilter; page: PageRequest },
  Paginated<Lock>
> {
  readonly policy = 'any-actor';

  constructor(
    private readonly locks: LockStore,
    private readonly openSnapshot: OpenSnapshotAction,
  ) {
    super();
  }

  protected async run({
    actor,
    filter,
    page,
  }: {
    actor: Actor;
    filter: LockFilter;
    page: PageRequest;
  }): Promise<Paginated<Lock>> {
    // A reader of everything: the database pages.
    if (readsAllDrafts(actor)) return this.locks.list(filter, page);
    if (!readsChangeSets(actor)) {
      // Their own locks only: another holder's filter lists nothing.
      if (filter.holder !== undefined && filter.holder !== actor.id) {
        return { total: 0, items: [] };
      }
      const own = await this.locks.all({ ...filter, holder: actor.id });
      return paginate(await visibleLocks(this.openSnapshot, actor, own), page);
    }
    // The languages in SQL first, so content is read only for what is left.
    const languages = draftLanguages(actor);
    const all = await this.locks.all(
      languages === undefined
        ? filter
        : { ...filter, moduleLanguages: languages },
    );
    return paginate(await visibleLocks(this.openSnapshot, actor, all), page);
  }
}

/**
 * One lock by its ID; not found for any ID that names none, and for a lock
 * the reader may not know of (`visibleLocks`: outside their scope, or
 * another holder's for an actor without `content.read.draft`), exactly
 * alike. So it needs only an actor.
 */
@Injectable()
export class GetLockAction extends ActorAction<
  { actor: Actor; id: string },
  Lock
> {
  readonly policy = 'any-actor';

  constructor(
    private readonly locks: LockStore,
    private readonly openSnapshot: OpenSnapshotAction,
  ) {
    super();
  }

  protected async run({ actor, id }: { actor: Actor; id: string }) {
    const lock = await this.locks.find(id);
    if (!lock || !(await seesLock(this.openSnapshot, actor, lock))) {
      throw new NotFoundError(`No lock "${id}".`);
    }
    return lock;
  }
}
