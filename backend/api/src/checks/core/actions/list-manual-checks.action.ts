import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { NotFoundError } from '../../../base/core/errors.js';
import type { PageRequest } from '../../../base/core/paging.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import {
  pageOfChecks,
  type CheckFilter,
  type CheckPage,
} from '../check-page.js';
import { ContentChecks, type Checked } from '../content-checks.js';
import { CHECKS_KEPT, CHECKS_TTL_MS, Fresh, keyOf } from '../fresh.js';

interface Input {
  readonly actor: Actor;
  readonly snapshot: ReadableContent;
  readonly id: string;
  readonly filter: CheckFilter;
  readonly page: PageRequest;
}

/**
 * A manual's checks at the commit read (`ContentChecks.manual`), as the
 * actor sees it: a manual they may not see is not found, exactly like a
 * missing one, and nothing about modules they may not see is listed or
 * counted. Filtered, counted and paged.
 */
@Injectable()
export class ListManualChecksAction extends ActorAction<Input, CheckPage> {
  readonly policy = 'content.read';
  /** Kept briefly, so paging and filtering read a manual's checks once. */
  readonly #checks = new Fresh<Checked | undefined>(CHECKS_KEPT, CHECKS_TTL_MS);

  constructor(private readonly checks: ContentChecks) {
    super();
  }

  protected async run({
    snapshot,
    id,
    filter,
    page,
  }: Input): Promise<CheckPage> {
    const checks = await this.#checks.get(
      keyOf(snapshot.commit, snapshot.readingKey, id),
      () => this.checks.manual(snapshot, id),
    );
    if (!checks) throw new NotFoundError(`No manual "${id}".`);
    return { ...pageOfChecks(checks, filter, page), commit: snapshot.commit };
  }
}
