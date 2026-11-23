import { ErrorDocument } from '../src/base/api/json-api.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());

const PAGES = '/manuals/operating/variants/model=large/en/pdf/pages';

const errorOf = (body: unknown) => ErrorDocument.parse(body).errors[0];
const isPng = (data: Buffer) =>
  data
    .subarray(0, 8)
    .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
/** Width and height from the PNG's IHDR chunk. */
const size = (png: Buffer) => ({
  width: png.readUInt32BE(16),
  height: png.readUInt32BE(20),
});
const png = async (path: string) => {
  const res = await t.get(path).buffer(true);
  expect([path, res.status]).toEqual([path, 200]);
  return res;
};

describe('PDF pages as PNG', () => {
  it('serves a page as a PNG, safely, at the default or asked width', async () => {
    const cover = await png(`${PAGES}/1.png`);
    expect(cover.headers['content-type']).toBe('image/png');
    expect(cover.headers['x-content-type-options']).toBe('nosniff');
    expect(cover.headers['content-security-policy']).toMatch(
      /default-src 'none'.*sandbox/,
    );
    const body = cover.body as Buffer;
    expect(isPng(body)).toBe(true);
    expect(size(body)).toEqual({ width: 480, height: 679 });

    const small = (await png(`${PAGES}/2.png?width=120`)).body as Buffer;
    expect(size(small).width).toBe(120);

    // The same bytes again, also for requests at once (they share one rendering).
    const [a, b] = await Promise.all([
      t.get(`${PAGES}/1.png`).buffer(true),
      t.get(`${PAGES}/1.png`).buffer(true),
    ]);
    expect(a.body).toEqual(body);
    expect(b.body).toEqual(body);
  }, 60_000);

  it('answers 404 past the last page or for an unknown manual', async () => {
    const past = await t.get(`${PAGES}/999.png`);
    expect(past.status).toBe(404);
    expect(past.headers['content-type']).toMatch(
      /^application\/vnd\.api\+json/,
    );
    const error = errorOf(past.body);
    expect(error?.code).toBe('not-found');
    expect(error?.meta?.['pages']).toEqual(expect.any(Number));

    // Known now: answered again without rendering, the same way.
    const again = await t.get(`${PAGES}/1000.png`);
    expect(again.status).toBe(404);
    expect(errorOf(again.body)?.meta).toEqual(error?.meta);

    const unknown = await t.get(
      '/manuals/nope/variants/model=large/en/pdf/pages/1.png',
    );
    expect(unknown.status).toBe(404);
  }, 60_000);

  it('refuses malformed pages, widths and parameters with 400', async () => {
    for (const path of [
      `${PAGES}/0.png`,
      `${PAGES}/01.png`,
      `${PAGES}/x.png`,
      `${PAGES}/10000.png`,
      `${PAGES}/1.png?width=8`,
      `${PAGES}/1.png?width=99999`,
      `${PAGES}/1.png?width=12.5`,
      `${PAGES}/1.png?height=100`,
    ]) {
      const res = await t.get(path);
      expect([path, res.status]).toEqual([path, 400]);
    }
  });

  it('needs content.read, like the PDF', async () => {
    expect((await t.anonymous().get(`${PAGES}/1.png`)).status).toBe(401);
    t.actAs(actorWith([]));
    try {
      const res = await t.get(`${PAGES}/1.png`);
      expect(res.status).toBe(403);
      expect(errorOf(res.body)?.code).toBe('forbidden');
    } finally {
      t.actAs(undefined);
    }
  });
});
