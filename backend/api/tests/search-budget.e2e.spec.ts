import { errors, q, reader, slowDown, speedUp } from './search-limits.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * `GET /search` (#539): the time budget of a search in the database (503
 * `database-timeout`) and the searches at once on a server (503
 * `search-busy`), on PGlite; on a real Postgres server:
 * `search-budget-postgres.e2e.spec.ts`.
 */
describe('GET /search time budget and searches at once (#539)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({
      CCMS_SEARCH_TIMEOUT_MS: '1000',
      CCMS_SEARCH_CONCURRENCY: '1',
    });
  });
  afterAll(() => t?.close());
  afterEach(() => t?.actAs(undefined));

  it('answers a query slower than CCMS_SEARCH_TIMEOUT_MS with 503 database-timeout and Retry-After', async () => {
    t.actAs(reader('search-slow'));
    // Indexed first, at full speed.
    expect((await t.get(q('charging'))).status).toBe(200);
    await slowDown(t, 1.5);
    try {
      const res = await t.get(q('automatically charges'));
      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('1');
      expect(errors(res.body)[0]).toMatchObject({
        status: '503',
        code: 'database-timeout',
      });
    } finally {
      await speedUp(t);
    }
    expect((await t.get(q('automatically charges'))).status).toBe(200);
  });

  it('answers 429 for a third search of one reader while two of theirs run; the server-wide limit (503 search-busy) is in the adapter spec', async () => {
    t.actAs(reader('search-busy'));
    expect((await t.get(q('charging'))).status).toBe(200);
    await slowDown(t, 0.2);
    try {
      const answers = await Promise.all(
        Array.from({ length: 3 }, () =>
          t.get(q('automatically')).then((r) => r),
        ),
      );
      const refused = answers.filter((res) => res.status === 429);
      expect(refused).toHaveLength(1);
      expect(refused[0]?.headers['retry-after']).toBe('1');
      expect(errors(refused[0]?.body)[0]?.code).toBe('rate-limited');
      // The other two waited their turn (CCMS_SEARCH_CONCURRENCY=1) and answered.
      expect(answers.filter((res) => res.status === 200).length).toBe(2);
    } finally {
      await speedUp(t);
    }
  });
});
