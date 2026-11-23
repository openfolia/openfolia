import { AboutDocument } from '../src/about/api/about.resources.js';
import { createTestApp, type TestApp } from './test-app.js';

// A file of its own: the settings are read once per test file (`createTestApp`).
describe('GET /about without CCMS_SOURCE_URL', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t?.close());

  it('says the source address is not set', async () => {
    const res = await t.anonymous().get('/about');
    expect(res.status).toBe(200);
    expect(AboutDocument.parse(res.body).data.attributes).toEqual({
      license: 'AGPL-3.0-only',
      licenseUrl: 'https://www.gnu.org/licenses/agpl-3.0.html',
      sourceUrl: null,
      docsUrl: 'https://docs.openfolia.com/',
    });
  });
});
