import {
  ForbiddenError,
  TooManyRequestsError,
} from '../../../base/core/errors.js';
import type { Actor } from '../../../access/core/actor.js';
import { NOBODY, READER } from '../../../../tests/fakes/actors.js';
import { readable } from '../../../../tests/fakes/fake-content.js';
import {
  FakeContentSearch,
  hit,
} from '../../../../tests/fakes/fake-content-search.js';
import {
  SEARCHES_PER_READER_AT_ONCE,
  SearchContentAction,
} from './search-content.action.js';
import type { SearchHit } from '../content-search.js';
import type { Paginated } from '../../../base/core/paging.js';

const hits = ['a', 'b', 'c', 'd', 'e'].map((id) => hit(id));

const LIMITS = { perMinute: 100 };

describe('SearchContentAction', () => {
  it('pages the hits and counts all of them', async () => {
    const search = new FakeContentSearch(hits);
    const action = new SearchContentAction(search, LIMITS);
    const second = await action.handle({
      actor: READER,
      snapshot: readable(),
      query: 'x',
      filter: {},
      page: { number: 2, size: 2 },
    });
    expect(second.total).toBe(5);
    expect(second.items.map((h) => h.id)).toEqual(['en/c', 'en/d']);
  });

  it('asks the search with the readable content, the query and the filters', async () => {
    const search = new FakeContentSearch();
    const snapshot = readable();
    await new SearchContentAction(search, LIMITS).handle({
      actor: READER,
      snapshot,
      query: 'charging',
      filter: {
        lang: 'de',
        resourceType: 'module',
        type: 'procedure',
        keywords: ['battery'],
      },
      page: { number: 1, size: 10 },
    });
    expect(search.asked).toEqual([
      {
        content: snapshot,
        query: 'charging',
        filter: {
          lang: 'de',
          resourceType: 'module',
          type: 'procedure',
          keywords: ['battery'],
        },
      },
    ]);
  });

  it('refuses an actor who may not read, before searching', async () => {
    const search = new FakeContentSearch(hits);
    await expect(
      new SearchContentAction(search, LIMITS).handle({
        actor: NOBODY,
        snapshot: readable(),
        query: 'x',
        filter: {},
        page: { number: 1, size: 10 },
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(search.asked).toEqual([]);
  });

  it('answers 429 rate-limited with Retry-After past the per-minute limit, per reader, without searching', async () => {
    const search = new FakeContentSearch(hits);
    const action = new SearchContentAction(search, { perMinute: 2 });
    const ask = (actor: Actor) =>
      action.handle({
        actor,
        snapshot: readable(),
        query: 'x',
        filter: {},
        page: { number: 1, size: 10 },
      });
    await ask(READER);
    await ask(READER);
    const refused = await ask(READER).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(TooManyRequestsError);
    expect(refused).toMatchObject({ code: 'rate-limited' });
    const seconds = (refused as TooManyRequestsError).retryAfterSeconds;
    expect(seconds).toBeGreaterThanOrEqual(1);
    expect(seconds).toBeLessThanOrEqual(60);
    expect(search.asked).toHaveLength(2);
    // Another reader has a limit of their own; a service account of the same ID too.
    await ask({ ...READER, id: 'someone-else' });
    await ask({ ...READER, kind: 'service' });
    expect(search.asked).toHaveLength(4);
  });

  it('does not count a reader who may not read', async () => {
    const search = new FakeContentSearch(hits);
    const action = new SearchContentAction(search, { perMinute: 1 });
    const input = {
      snapshot: readable(),
      query: 'x',
      filter: {},
      page: { number: 1, size: 10 },
    };
    await expect(
      action.handle({ ...input, actor: NOBODY }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await action.handle({ ...input, actor: READER });
    expect(search.asked).toHaveLength(1);
  });

  it('runs at most SEARCHES_PER_READER_AT_ONCE of a reader’s searches at once: 429 for another, not counted', async () => {
    const search = new FakeContentSearch(hits);
    const held: (() => void)[] = [];
    search.search = (...args) => {
      FakeContentSearch.prototype.search.apply(search, args);
      return new Promise<Paginated<SearchHit>>((resolve) =>
        held.push(() => resolve({ items: [], total: 0 })),
      );
    };
    const action = new SearchContentAction(search, { perMinute: 100 });
    const ask = (actor: Actor = READER) =>
      action.handle({
        actor,
        snapshot: readable(),
        query: 'x',
        filter: {},
        page: { number: 1, size: 10 },
      });
    const running = Array.from({ length: SEARCHES_PER_READER_AT_ONCE }, () =>
      ask(),
    );
    const refused = await ask().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(TooManyRequestsError);
    expect(refused).toMatchObject({
      code: 'rate-limited',
      retryAfterSeconds: 1,
    });
    // Another reader is not held up.
    const other = ask({ ...READER, id: 'someone-else' });
    await vi.waitFor(() =>
      expect(held).toHaveLength(SEARCHES_PER_READER_AT_ONCE + 1),
    );
    for (const release of held) release();
    await Promise.all([...running, other]);
    // Once they finished, the reader may search again.
    const again = ask();
    await vi.waitFor(() =>
      expect(held).toHaveLength(SEARCHES_PER_READER_AT_ONCE + 2),
    );
    held.at(-1)?.();
    await again;
    expect(search.asked).toHaveLength(SEARCHES_PER_READER_AT_ONCE + 2);
  });
});
