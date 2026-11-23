import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { NotFoundError } from '../../../base/core/errors.js';
import type { PageRequest, Paginated } from '../../../base/core/paging.js';
import type { Release, ReleaseFilter } from '../release.js';
import { ReleaseStore } from '../release-store.js';

/**
 * One page of the published releases, newest first. Releases are released
 * content (their tags read with `content.read`), so every reader may know
 * them, whatever their scope; what a reader sees at a release's tag is
 * still limited to it.
 */
@Injectable()
export class ListReleasesAction extends ActorAction<
  { actor: Actor; filter: ReleaseFilter; page: PageRequest },
  Paginated<Release>
> {
  readonly policy = 'content.read';

  constructor(private readonly store: ReleaseStore) {
    super();
  }

  protected run({
    filter,
    page,
  }: {
    filter: ReleaseFilter;
    page: PageRequest;
  }): Promise<Paginated<Release>> {
    return this.store.list(filter, page);
  }
}

/** One published release by its ID; not found for any ID that names none. */
@Injectable()
export class GetReleaseAction extends ActorAction<
  { actor: Actor; id: string },
  Release
> {
  readonly policy = 'content.read';

  constructor(private readonly store: ReleaseStore) {
    super();
  }

  protected async run({ id }: { id: string }): Promise<Release> {
    const release = await this.store.find(id);
    if (!release) throw new NotFoundError(`No release "${id}".`);
    return release;
  }
}
