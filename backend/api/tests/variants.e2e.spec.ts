import { execFileSync } from 'node:child_process';
import { parseCondition, printModule } from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import { ErrorDocument } from '../src/base/api/json-api.js';
import {
  VariantAttributePageDocument,
  VariantBuildPageDocument,
  VariantUsePageDocument,
} from '../src/variants/api/variant.resources.js';
import { actorWith, READER } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();

const manual = (title: string, audience: string, models: string[]) =>
  [
    'schemaVersion: 1',
    `title: ${title}`,
    `audience: ${audience}`,
    'variants:',
    ...models.map((model) => `  - model: ${model}`),
    'attributes: {}',
    'entries:',
    '  - module: charging',
    '',
  ].join('\n');

/** `main` before this file's own commit: the sample's manuals, `operating` and `service` (internal). */
let sampleMain: string;

beforeAll(async () => {
  t = await createTestApp();
  sampleMain = git('rev-parse', 'refs/heads/main');
  // Two more manuals on `main`: one only internal readers may see.
  await new GitWriter(dir()).commit({
    branch: 'main',
    parent: sampleMain,
    changes: [
      {
        path: 'manuals/internal.yaml',
        content: manual('Internal manual', 'internal', ['large']),
      },
      {
        path: 'manuals/quick-start.yaml',
        content: manual('Quick start', 'public', ['small']),
      },
    ],
    message: 'More manuals',
    author: { name: 'Someone', email: 'someone@example.com' },
  });
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

const publicReader = actorWith(['content.read'], { maxAudience: 'public' });

const matches = async (when: string, query = '') => {
  const res = await t.get(
    `/variants/matches?when=${encodeURIComponent(when)}${query}`,
  );
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toContain('application/vnd.api+json');
  return VariantBuildPageDocument.parse(res.body);
};
const ids = (doc: ReturnType<typeof VariantBuildPageDocument.parse>) =>
  doc.data.map((build) => build.id);

describe('GET /variants', () => {
  it('lists the configured variant attributes with their values, paged', async () => {
    const res = await t.get('/variants');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/vnd.api+json');
    expect(res.headers['x-ccms-commit']).toBe(git('rev-parse', 'main'));
    const doc = VariantAttributePageDocument.parse(res.body);
    expect(doc.data).toEqual([
      {
        type: 'VariantAttribute',
        id: 'model',
        attributes: {
          kind: 'enum',
          label: 'Model',
          values: [
            { id: 'small', label: 'Small' },
            { id: 'large', label: 'Large' },
          ],
        },
      },
    ]);
    expect(doc.meta.page).toEqual({
      currentPage: 1,
      lastPage: 1,
      perPage: 50,
      total: 1,
    });
    expect(doc.links.next).toBeNull();
  });

  it('reads the configuration at ?ref=', async () => {
    const res = await t.get('/variants?ref=v1');
    expect(res.status).toBe(200);
    expect(res.headers['x-ccms-commit']).toBe(t.commits.v1);
    expect(VariantAttributePageDocument.parse(res.body).meta.page.total).toBe(
      1,
    );
  });

  it('refuses a query parameter it does not support', async () => {
    const res = await t.get('/variants?when=model%20in%20(large)');
    expect(res.status).toBe(400);
    expect(ErrorDocument.parse(res.body).errors[0]?.source).toEqual({
      parameter: 'when',
    });
  });
});

describe('GET /variants/matches', () => {
  it('lists the builds a condition holds for: the count is meta.page.total', async () => {
    t.actAs(READER);
    const doc = await matches('model in (large)');
    expect(ids(doc)).toEqual([
      'internal/model=large',
      'operating/model=large',
      'service/model=large',
    ]);
    expect(doc.meta.page.total).toBe(3);
    expect(doc.data[1]).toEqual({
      type: 'VariantBuild',
      id: 'operating/model=large',
      attributes: { values: { model: 'large' } },
      relationships: { manual: { data: { type: 'Manual', id: 'operating' } } },
      meta: {
        slug: 'model=large',
        label: 'Large',
        manualTitle: 'Operating manual',
      },
    });
    expect(ids(await matches('!(model in (large))'))).toEqual([
      'operating/model=small',
      'quick-start/model=small',
    ]);
    expect((await matches('model in (small, large)')).meta.page.total).toBe(5);
  });

  it('never names nor counts a manual outside the reader’s scope', async () => {
    t.actAs(publicReader);
    const doc = await matches('model in (large)');
    expect(ids(doc)).toEqual(['operating/model=large']);
    expect(doc.meta.page.total).toBe(1);
    expect(JSON.stringify(doc)).not.toContain('internal');
  });

  it('pages the builds, keeping the condition in the links', async () => {
    t.actAs(READER);
    const doc = await matches(
      'model in (small, large)',
      '&page[number]=2&page[size]=3',
    );
    expect(ids(doc)).toEqual([
      'quick-start/model=small',
      'service/model=large',
    ]);
    expect(doc.meta.page).toMatchObject({ currentPage: 2, lastPage: 2 });
    expect(
      new URL(doc.links.first, 'http://api').searchParams.get('when'),
    ).toBe('model in (small, large)');
  });

  it('reads the manuals at ?ref=', async () => {
    const res = await t.get(
      `/variants/matches?when=${encodeURIComponent('model in (large)')}&ref=${sampleMain}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers['x-ccms-commit']).toBe(sampleMain);
    expect(ids(VariantBuildPageDocument.parse(res.body))).toEqual([
      'operating/model=large',
      'service/model=large',
    ]);
  });

  it('answers a malformed condition with 400 and the parser’s message', async () => {
    let parserMessage = '';
    try {
      parseCondition('model in (large');
    } catch (error) {
      parserMessage = (error as Error).message;
    }
    expect(parserMessage).not.toBe('');
    const res = await t.get(
      `/variants/matches?when=${encodeURIComponent('model in (large')}`,
    );
    expect(res.status).toBe(400);
    expect(ErrorDocument.parse(res.body).errors).toEqual([
      expect.objectContaining({
        status: '400',
        code: 'invalid-parameter',
        detail: parserMessage,
        source: { parameter: 'when' },
      }),
    ]);
  });

  it('answers a missing, empty, overlong or repeated condition with 400', async () => {
    for (const query of [
      '',
      '?when=',
      `?when=${'a'.repeat(1001)}`,
      '?when=model%20in%20(large)&when=model%20in%20(small)',
    ]) {
      const res = await t.get(`/variants/matches${query}`);
      expect(res.status, query).toBe(400);
      const [error] = ErrorDocument.parse(res.body).errors;
      expect(error).toMatchObject({
        code: 'invalid-parameter',
        source: { parameter: 'when' },
      });
    }
  });

  it('answers a condition the configuration does not hold with 422 unknown-variant', async () => {
    const res = await t.get(
      `/variants/matches?when=${encodeURIComponent('colour in (red) || model in (huge)')}`,
    );
    expect(res.status).toBe(422);
    expect(ErrorDocument.parse(res.body).errors).toEqual([
      expect.objectContaining({
        code: 'unknown-variant',
        detail: 'variant attribute "colour" is not configured',
        meta: { issue: 'unknown-variant-attribute' },
      }),
      expect.objectContaining({
        code: 'unknown-variant',
        detail: '"huge" is not a value of variant attribute "model"',
        meta: { issue: 'unknown-variant-value' },
      }),
    ]);
  });

  it('answers a comparison with something that is not a version with 422 unknown-variant', async () => {
    // A branch whose configuration has a version attribute.
    const config = git('show', 'main:openfolia.yaml').replace(
      'variantAttributes:\n',
      'variantAttributes:\n  - { id: software, label: Software, kind: version }\n',
    );
    git('branch', 'versions', 'main');
    await new GitWriter(dir()).commit({
      branch: 'versions',
      parent: git('rev-parse', 'refs/heads/main'),
      changes: [{ path: 'openfolia.yaml', content: config }],
      message: 'A version attribute',
      author: { name: 'Someone', email: 'someone@example.com' },
    });
    const res = await t.get(
      `/variants/matches?ref=versions&when=${encodeURIComponent('software >= abc')}`,
    );
    expect(res.status).toBe(422);
    expect(ErrorDocument.parse(res.body).errors).toEqual([
      expect.objectContaining({
        status: '422',
        code: 'unknown-variant',
        detail: '"abc" is not a version (variant attribute "software")',
        meta: { issue: 'invalid-version-value' },
      }),
    ]);
    // A version is fine: no manual sets `software`, so no build.
    const fine = await t.get(
      `/variants/matches?ref=versions&when=${encodeURIComponent('software >= 2.3')}`,
    );
    expect(fine.status).toBe(200);
    expect(VariantBuildPageDocument.parse(fine.body).meta.page.total).toBe(0);
  });

  it('refuses a query parameter it does not support', async () => {
    const res = await t.get(
      '/variants/matches?when=model%20in%20(large)&filter[manual]=operating',
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /variants/:attributeId/usages', () => {
  const usesBranch = async () => {
    if (git('branch', '--list', 'uses') !== '') return;
    const blocks = [
      {
        type: 'variant' as const,
        id: 'large-only',
        when: parseCondition('model in (large)'),
        blocks: [
          {
            type: 'paragraph' as const,
            id: 'large-only-p',
            content: [{ type: 'text' as const, text: 'Only large.' }],
          },
        ],
      },
    ];
    git('branch', 'uses', 'main');
    await new GitWriter(dir()).commit({
      branch: 'uses',
      parent: git('rev-parse', 'uses'),
      changes: [
        {
          path: 'modules/en/large-only.adoc',
          content: printModule({
            schemaVersion: 1,
            id: 'large-only',
            meta: {
              title: 'Large only',
              type: 'concept',
              lang: 'en',
              audience: 'public',
              facets: {},
            },
            blocks,
          }),
        },
        // An internal module (no variant blocks), and a public manual naming
        // `large` only on its entry: a public reader must not learn of it.
        {
          path: 'modules/en/secret-part.adoc',
          content: printModule({
            schemaVersion: 1,
            id: 'secret-part',
            meta: {
              title: 'Secret part',
              type: 'concept',
              lang: 'en',
              audience: 'internal',
              facets: {},
            },
            blocks: blocks.flatMap((b) => b.blocks),
          }),
        },
        {
          path: 'manuals/leaky.yaml',
          content: [
            'schemaVersion: 1',
            'title: Leaky manual',
            'audience: public',
            'variants:',
            '  - model: small',
            'attributes: {}',
            'entries:',
            '  - module: charging',
            '  - module: secret-part',
            '    when: model in (large)',
            '',
          ].join('\n'),
        },
      ],
      message: 'A module for large models',
      author: { name: 'Someone', email: 'someone@example.com' },
    });
  };
  const uses = async (path: string) => {
    const res = await t.get(path);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/vnd.api+json');
    return VariantUsePageDocument.parse(res.body);
  };

  it('lists the manuals, then the modules naming a value, at ?ref=', async () => {
    await usesBranch();
    const doc = await uses(
      '/variants/model/usages?ref=uses&filter[value]=large&page[size]=50',
    );
    expect(doc.data.map((u) => u.id)).toEqual([
      'manual/internal',
      'manual/leaky',
      'manual/operating',
      'manual/service',
      'module/large-only',
    ]);
    expect(doc.data.at(-1)?.attributes).toEqual({
      kind: 'module',
      moduleId: 'large-only',
      title: 'Large only',
      languages: ['en'],
    });
    expect(doc.meta.page.total).toBe(5);
    const small = await uses(
      '/variants/model/usages?ref=uses&filter[value]=small',
    );
    expect(small.data.map((u) => u.id)).toEqual([
      'manual/leaky',
      'manual/operating',
      'manual/quick-start',
    ]);
  });

  it('never names nor counts what lies outside the reader’s scope, an entry naming only a hidden module neither', async () => {
    await usesBranch();
    // A branch is a draft: reading it takes `content.read.draft`.
    t.actAs(
      actorWith(['content.read', 'content.read.draft'], {
        maxAudience: 'public',
      }),
    );
    const doc = await uses(
      '/variants/model/usages?ref=uses&filter[value]=large',
    );
    // `leaky` is public, but only its entry for the internal `secret-part` names `large`.
    expect(doc.data.map((u) => u.id)).toEqual([
      'manual/operating',
      'module/large-only',
    ]);
    expect(doc.meta.page.total).toBe(2);
  });

  it('refuses an ID that is no configuration key', async () => {
    expect((await t.get('/variants/Model/usages')).status).toBe(400);
    expect(
      (await t.get('/variants/model/usages?filter[value]=a%20b')).status,
    ).toBe(400);
    expect(
      (await t.get('/variants/model/usages?filter[manual]=x')).status,
    ).toBe(400);
  });
});
