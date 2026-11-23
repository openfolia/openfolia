import { sql } from 'drizzle-orm';
import type { Actor } from '../src/access/core/actor.js';
import { SearchPageDocument } from '../src/search/api/search.resources.js';
import { ContentSearch } from '../src/search/core/content-search.js';
import { InMemoryContentSearch } from '../src/search/repos/in-memory-content-search.js';
import { actorWith, READER } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

/** `GET /search` on the in-memory adapter (#54); the rest is `search.e2e.spec.ts`, on Postgres. */
const PUBLIC_ONLY: Actor = {
  ...actorWith(['content.read'], { maxAudience: 'public' }),
  id: 'public-only',
};
const q = (query: string) => `/search?filter[q]=${encodeURIComponent(query)}`;
const ids = (body: unknown) =>
  SearchPageDocument.parse(body).data.map((hit) => hit.attributes.resourceId);

describe('GET /search with CCMS_SEARCH_ADAPTER=memory (#54)', () => {
  let m: TestApp;
  beforeAll(async () => {
    m = await createTestApp({ CCMS_SEARCH_ADAPTER: 'memory' });
  });
  afterAll(() => m?.close());

  it('searches in memory, with the same scope, and writes nothing to the database', async () => {
    expect(m.app.get(ContentSearch)).toBeInstanceOf(InMemoryContentSearch);
    m.actAs(READER);
    const res = await m.get(q('charg'));
    expect(res.status).toBe(200);
    expect(ids(res.body)).toContain('en/charging');
    m.actAs(PUBLIC_ONLY);
    const narrow = SearchPageDocument.parse(
      (await m.get(q('maintenance'))).body,
    );
    expect(ids(narrow)).not.toContain('en/internals');
    const { rows } = await m.database.db.execute<{ n: number }>(
      sql`select count(*)::int as n from search_documents`,
    );
    expect(rows[0]?.n).toBe(0);
  });
});
