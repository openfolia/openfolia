import { SearchPageDocument } from '../src/search/api/search.resources.js';
import { errors, q, reader } from './search-limits.js';
import { createTestApp, type TestApp } from './test-app.js';

/** `GET /search`: requests per reader and minute (#539), 429 past them. */
describe('GET /search per-reader rate (#539)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ CCMS_SEARCH_PER_MINUTE: '3' });
  });
  afterAll(() => t?.close());
  afterEach(() => t?.actAs(undefined));

  it('answers 429 rate-limited with Retry-After past CCMS_SEARCH_PER_MINUTE, per reader', async () => {
    const rater = reader('search-rater');
    t.actAs(rater);
    for (let i = 0; i < 3; i++) {
      const res = await t.get(q('charging'));
      expect(res.status).toBe(200);
      SearchPageDocument.parse(res.body);
    }
    const refused = await t.get(q('charging'));
    expect(refused.status).toBe(429);
    const wait = Number(refused.headers['retry-after']);
    expect(wait).toBeGreaterThanOrEqual(1);
    expect(wait).toBeLessThanOrEqual(60);
    expect(errors(refused.body)[0]).toMatchObject({
      status: '429',
      code: 'rate-limited',
      meta: { retryAfter: wait },
    });
    // Another reader has a limit of their own.
    t.actAs(reader('search-other'));
    expect((await t.get(q('charging'))).status).toBe(200);
  });
});
