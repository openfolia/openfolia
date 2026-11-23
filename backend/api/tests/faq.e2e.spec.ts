import { execFileSync } from 'node:child_process';
import { printModule, type Module } from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import type { z } from 'zod';
import { JSON_API } from '../src/base/api/json-api.js';
import { ChunkPageDocument } from '../src/chunks/api/chunk.resources.js';
import { SearchPageDocument } from '../src/search/api/search.resources.js';
import { READER } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * FAQ entries (#151) through the API: a module of questions committed on
 * `main` of the sample repository, read back as retrieval chunks (one per
 * entry), found by its questions and previewed as disclosures.
 */
const FAQ: Module = {
  schemaVersion: 1,
  id: 'charging-faq',
  meta: {
    title: 'Charging questions',
    type: 'concept',
    lang: 'en',
    audience: 'public',
    facets: {},
  },
  blocks: [
    {
      type: 'faq',
      id: 'overnight',
      question: [{ type: 'text', text: 'Can I charge overnight?' }],
      blocks: [
        {
          type: 'paragraph',
          id: 'overnight-a',
          content: [
            { type: 'text', text: 'Yes: the charger stops when full.' },
          ],
        },
      ],
    },
    {
      type: 'faq',
      id: 'cold',
      question: [{ type: 'text', text: 'Does the cold slow it down?' }],
      blocks: [
        {
          type: 'paragraph',
          id: 'cold-a',
          content: [{ type: 'text', text: 'Below freezing, it takes longer.' }],
        },
      ],
    },
  ],
};

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
  const dir = process.env['CCMS_CONTENT_DIR'] as string;
  const parent = execFileSync(
    'git',
    ['-C', dir, 'rev-parse', 'refs/heads/main'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    },
  ).trim();
  await new GitWriter(dir).commit({
    branch: 'main',
    parent,
    changes: [
      { path: 'modules/en/charging-faq.adoc', content: printModule(FAQ) },
    ],
    message: 'Add charging questions',
    author: { name: 'Test', email: 'test@example.com' },
  });
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

async function get<T extends z.ZodType>(schema: T, path: string) {
  t.actAs(READER);
  const res = await t.get(path);
  expect([path, res.status]).toEqual([path, 200]);
  expect(res.headers['content-type']).toBe(JSON_API);
  return schema.parse(res.body) as z.infer<T>;
}

describe('an FAQ entry through the API', () => {
  it('has a retrieval chunk of its own after its module’s', async () => {
    const page = await get(
      ChunkPageDocument,
      '/chunks?filter[module]=charging-faq',
    );
    expect(page.data.map((c) => c.id)).toEqual([
      'en/charging-faq',
      'en/charging-faq/overnight',
      'en/charging-faq/cold',
    ]);
    expect(page.meta.page.total).toBe(3);
    const [own, overnight] = page.data;
    expect(own?.attributes.entry).toBeUndefined();
    expect(own?.attributes.text).toContain('**Can I charge overnight?**');
    expect(overnight?.attributes).toMatchObject({
      moduleId: 'charging-faq',
      title: 'Charging questions',
      text: '# Can I charge overnight?\n\nYes: the charger stops when full.',
      entry: { blockId: 'overnight', question: 'Can I charge overnight?' },
    });
    expect(overnight?.relationships.module.data).toEqual({
      type: 'Module',
      id: 'en/charging-faq',
    });
  });

  it('is found by its question, naming the entry', async () => {
    const page = await get(SearchPageDocument, '/search?filter[q]=overnight');
    const hit = page.data.find(
      (r) => r.attributes.resourceId === 'en/charging-faq',
    );
    expect(hit?.attributes.blockId).toBe('overnight');
    expect(hit?.meta).toMatchObject({
      matchedOn: 'question',
      excerpt: 'Can I charge overnight?',
    });
  });

  it('previews as a disclosure, its question the summary', async () => {
    t.actAs(READER);
    const res = await t.get('/modules/en/charging-faq/preview');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(
      /<details class="of-faq" id="[^"]*overnight"><summary class="of-faq__question">Can I charge overnight\?<\/summary>/,
    );
  });
});
