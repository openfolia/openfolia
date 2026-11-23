import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { TooManyRequestsError } from '../../../base/core/errors.js';
import { type PageRequest, type Paginated } from '../../../base/core/paging.js';
import { SlidingWindowLimit } from '../../../base/core/rate-limit.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import {
  ContentSearch,
  SearchLimits,
  type AskedSearchFilter,
  type SearchHit,
} from '../content-search.js';

/** Searches one reader may have running at once on a server; another is 429 `rate-limited` (#539). */
export const SEARCHES_PER_READER_AT_ONCE = 2;

/**
 * One page of the hits for a query and filters, over what the actor may
 * read; the total counts only those hits, so it tells nothing about content
 * outside the scope.
 *
 * At most `SearchLimits.perMinute` searches per actor (a person or a
 * service account) and minute, on this server (#539): past it 429
 * `rate-limited` with `Retry-After`, before anything is searched, so it
 * also bounds the embedder calls a reader's queries make. Every search
 * counts, a page of a kept ranking too. And at most
 * `SEARCHES_PER_READER_AT_ONCE` of a reader's searches run at once (429
 * `rate-limited`, `Retry-After: 1`), so one reader cannot take every one of
 * the server's search slots (`CCMS_SEARCH_CONCURRENCY`) from the others.
 */
@Injectable()
export class SearchContentAction extends ActorAction<
  {
    actor: Actor;
    snapshot: ReadableContent;
    query?: string | undefined;
    filter: AskedSearchFilter;
    page: PageRequest;
  },
  Paginated<SearchHit>
> {
  readonly policy = 'content.read';

  /** Made on first use: the policy check comes before any use of the dependencies. */
  private perActor: SlidingWindowLimit | undefined;
  /** Searches running now, per reader (only readers with one running). */
  private readonly running = new Map<string, number>();

  constructor(
    private readonly search: ContentSearch,
    private readonly limits: SearchLimits,
  ) {
    super();
  }

  protected async run({
    actor,
    snapshot,
    query,
    filter,
    page,
  }: {
    actor: Actor;
    snapshot: ReadableContent;
    query?: string | undefined;
    filter: AskedSearchFilter;
    page: PageRequest;
  }): Promise<Paginated<SearchHit>> {
    const key = `${actor.kind}:${actor.id}`;
    const now = this.running.get(key) ?? 0;
    // Before the rate, so a refused search does not use up the reader's minute.
    if (now >= SEARCHES_PER_READER_AT_ONCE) {
      throw new TooManyRequestsError(
        `At most ${SEARCHES_PER_READER_AT_ONCE} of your searches at once.`,
        1,
      );
    }
    this.perActor ??= new SlidingWindowLimit(this.limits.perMinute);
    const allowed = this.perActor.take(key);
    if (!allowed.ok) {
      throw new TooManyRequestsError(
        `At most ${this.limits.perMinute} searches a minute.`,
        allowed.retryAfterSeconds,
      );
    }
    this.running.set(key, now + 1);
    try {
      return await this.search.search(snapshot, query, filter, page);
    } finally {
      const left = (this.running.get(key) ?? 1) - 1;
      if (left > 0) this.running.set(key, left);
      else this.running.delete(key);
    }
  }
}
