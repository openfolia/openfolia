import { ErrorDocument, JSON_API } from '../src/base/api/json-api.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

/** `GET /symbols/:id` (#208) and the previews that link it. */
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

const errorOf = (res: { headers: Record<string, unknown>; body: unknown }) => {
  expect(res.headers['content-type']).toBe(JSON_API);
  return ErrorDocument.parse(res.body).errors[0];
};

describe('GET /symbols/:id', () => {
  it('serves a configured symbol’s artwork as an image that can run nothing', async () => {
    const res = await t.get('/symbols/w001').buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/svg+xml');
    expect(res.headers['content-disposition']).toBe('inline');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    expect(Buffer.from(res.body as Buffer).toString('utf8')).toMatch(
      /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/,
    );
    expect(res.headers['x-ccms-commit']).toBe(t.commits.main);
  });

  it('is cached like every content read: an ETag on a branch, immutable at a commit', async () => {
    const res = await t.get('/symbols/w001');
    expect(res.headers['cache-control']).toBe('private, no-cache');
    const etag = res.headers['etag'] as string;
    expect(etag).toBeTruthy();
    const again = await t.get('/symbols/w001').set('If-None-Match', etag);
    expect(again.status).toBe(304);
    const pinned = await t.get(`/symbols/w001?ref=${t.commits.main}`);
    expect(pinned.status).toBe(200);
    expect(pinned.headers['cache-control']).toBe(
      'private, max-age=31536000, immutable',
    );
  });

  it('is 404 for a symbol that is not configured, 400 for no configuration key', async () => {
    const missing = await t.get('/symbols/w999');
    expect(missing.status).toBe(404);
    expect(errorOf(missing)?.code).toBe('not-found');
    const bad = await t.get('/symbols/Not_A_Key');
    expect(bad.status).toBe(400);
  });

  it('is read like any content: content.read, and a ref the reader may open', async () => {
    t.actAs(actorWith([]));
    expect((await t.get('/symbols/w001')).status).toBe(403);
    t.actAs(actorWith(['content.read']));
    expect((await t.get('/symbols/w001')).status).toBe(200);
    // A reader of released content cannot open a draft branch, so no symbol there either.
    expect((await t.get('/symbols/w001?ref=draft')).status).toBe(404);
  });

  it('takes no other query parameter', async () => {
    const res = await t.get('/symbols/w001?width=320');
    expect(res.status).toBe(400);
    expect(errorOf(res)?.code).toBe('unsupported-parameter');
  });
});

describe('symbols in the HTML', () => {
  it('links the artwork beside the signal word, the label as its text alternative', async () => {
    const res = await t.get('/modules/en/safety-note/preview');
    expect(res.status).toBe(200);
    expect(res.text).toContain(
      '<img class="of-safety__symbol" src="../../../symbols/w001" alt="General warning">',
    );
    const pinned = await t.get(
      `/modules/en/safety-note/preview?ref=${t.commits.main}`,
    );
    expect(pinned.text).toContain(
      `src="../../../symbols/w001?ref=${t.commits.main}"`,
    );
  });

  it('links them in a manual’s HTML too, what readers get', async () => {
    // `charging` refers to the safety note.
    const res = await t.get('/manuals/operating/variants/model=large/en/html');
    expect(res.status).toBe(200);
    expect(res.text).toContain(
      '<img class="of-safety__symbol" src="../../../../../symbols/w001" alt="General warning">',
    );
  });
});
