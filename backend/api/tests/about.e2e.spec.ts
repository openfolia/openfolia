import { JSON_API } from '../src/base/api/json-api.js';
import { AboutDocument } from '../src/about/api/about.resources.js';
import { createTestApp, type TestApp } from './test-app.js';

describe('GET /about', () => {
  describe('with CCMS_SOURCE_URL set', () => {
    let t: TestApp;
    beforeAll(async () => {
      t = await createTestApp({
        CCMS_SOURCE_URL: ' https://code.example.org/docs-platform ',
        CCMS_DOCS_URL: 'https://docs.example.org/guide',
      });
    });
    afterAll(() => t?.close());

    it('names the licence and the source, without a token', async () => {
      const res = await t.anonymous().get('/about');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe(JSON_API);
      expect(AboutDocument.parse(res.body)).toEqual({
        data: {
          type: 'About',
          id: 'about',
          attributes: {
            license: 'AGPL-3.0-only',
            licenseUrl: 'https://www.gnu.org/licenses/agpl-3.0.html',
            sourceUrl: 'https://code.example.org/docs-platform',
            docsUrl: 'https://docs.example.org/guide/',
          },
        },
      });
    });

    it('answers a signed-in client the same', async () => {
      const res = await t.get('/about');
      expect(res.status).toBe(200);
      expect(AboutDocument.parse(res.body).data.attributes.sourceUrl).toBe(
        'https://code.example.org/docs-platform',
      );
    });

    it('refuses query parameters it does not support', async () => {
      const res = await t.anonymous().get('/about?include=x');
      expect(res.status).toBe(400);
    });
  });
});
