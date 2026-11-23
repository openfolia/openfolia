import { JSON_API } from '../src/base/api/json-api.js';
import { ConfigUsagePageDocument } from '../src/project/api/project.resources.js';
import { createTestApp, type TestApp } from './test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());

const counts = (body: unknown) =>
  Object.fromEntries(
    ConfigUsagePageDocument.parse(body).data.map((r) => [
      r.id,
      [r.meta.modules, r.meta.manuals],
    ]),
  );

describe('GET /config/usages', () => {
  it('counts the modules and manuals naming each configured value, in the configuration’s order', async () => {
    const res = await t.get('/config/usages?page[size]=50');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(JSON_API);
    expect(res.headers['x-ccms-commit']).toMatch(/^[0-9a-f]{40}$/);
    const doc = ConfigUsagePageDocument.parse(res.body);
    expect(doc.meta.page.total).toBe(15);
    expect(doc.data[0]).toEqual({
      type: 'ConfigUsage',
      id: 'language/en',
      attributes: { kind: 'language', valueId: 'en' },
      meta: { modules: 3, manuals: 0 },
    });
    expect(counts(res.body)).toMatchObject({
      'language/de': [1, 0],
      'language/fr': [0, 0],
      'moduleType/concept': [2, 0],
      'moduleType/procedure': [1, 0],
      'audience/public': [2, 1],
      'audience/internal': [1, 1],
      'facet/region': [1, 0],
      'facetValue/region/north': [1, 0],
      'facetValue/region/south': [0, 0],
      'variantValue/model/small': [0, 1],
      'variantValue/model/large': [0, 2],
      'textAttribute/product-name': [1, 2],
      'safetySymbol/w001': [1, 0],
    });
  });

  it('pages, and refuses parameters it does not take', async () => {
    const page = await t.get('/config/usages?page[number]=2&page[size]=5');
    expect(page.status).toBe(200);
    const doc = ConfigUsagePageDocument.parse(page.body);
    expect(doc.data.map((r) => r.id)).toEqual([
      'audience/public',
      'audience/internal',
      'facet/region',
      'facetValue/region/north',
      'facetValue/region/south',
    ]);
    expect(decodeURIComponent(doc.links.next ?? '')).toContain(
      'page[number]=3',
    );
    const bad = await t.get('/config/usages?filter[kind]=language');
    expect(bad.status).toBe(400);
  });

  it('reads the configuration and content at ?ref=', async () => {
    const res = await t.get('/config/usages?ref=v1&page[size]=50');
    expect(res.status).toBe(200);
    expect(counts(res.body)['language/en']).toEqual([3, 0]);
  });
});
