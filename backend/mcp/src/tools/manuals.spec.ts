import {
  chunk,
  connectClient,
  paged,
  stubContext,
} from '../../tests/stub-api.js';

const RESOLVED = {
  data: {
    type: 'ResolvedManual',
    id: 'operating/model=large/de',
    attributes: {
      title: 'Betriebs*anleitung*',
      lang: 'de',
      variant: { model: 'large' },
      entries: [
        {
          kind: 'module',
          module: 'charging',
          title: 'Laden',
          lang: 'de',
          blocks: [],
        },
        {
          kind: 'group',
          title: 'Sicherheit',
          entries: [
            {
              kind: 'module',
              module: 'safety-note',
              title: 'Safety note',
              lang: 'en',
              blocks: [],
            },
          ],
        },
      ],
      origins: {},
      anchors: {},
    },
    relationships: { manual: { data: { type: 'Manual', id: 'operating' } } },
    meta: { issues: [] },
  },
};

describe('list_manuals', () => {
  it('lists the manuals with their variants and the configured languages', async () => {
    const context = stubContext();
    context.api.set(
      '/manuals',
      paged([
        {
          type: 'Manual',
          id: 'operating',
          attributes: {
            title: 'Operating manual',
            audience: 'public',
            entries: [],
          },
          meta: {
            variants: [
              {
                slug: 'model=large',
                label: 'Large',
                values: { model: 'large' },
              },
            ],
            issues: [],
          },
        },
        { type: 'Manual', id: 'broken', meta: { error: 'not YAML' } },
      ]),
    );
    const mcp = await connectClient(context);
    const { structured } = await mcp.call('list_manuals');
    expect(structured).toMatchObject({
      ref: 'main',
      languages: ['en', 'de'],
      total: 2,
      nextCursor: null,
      manuals: [
        {
          id: 'operating',
          title: 'Operating manual',
          audience: 'public',
          variants: [{ slug: 'model=large', label: 'Large' }],
          url: 'http://api.test/manuals/operating?ref=main',
        },
        { id: 'broken', error: 'not YAML' },
      ],
    });
    expect(context.api.callsTo('/manuals')[0]).toMatchObject({
      'page[size]': '50',
    });
    await mcp.close();
  });
});

describe('read_manual', () => {
  it('gives the manual as Markdown: each module’s text in order, with its ID, language and section', async () => {
    const context = stubContext();
    context.api.set('/manuals/operating/variants/model%3Dlarge/de', RESOLVED);
    context.api.set('/chunks', (query: Record<string, unknown>) =>
      query['filter[lang]'] === 'de'
        ? paged([
            chunk('charging', 'de', '# Laden\n\nDas {product-name} lädt.'),
          ])
        : paged([
            chunk('safety-note', 'en', '# Safety note\n\n> **CAUTION:** Hot'),
          ]),
    );
    const mcp = await connectClient(context);
    const { isError, text, structured } = await mcp.call('read_manual', {
      id: 'operating',
      variant: 'model=large',
      lang: 'de',
    });
    expect(isError).toBe(false);
    expect(text).toBe(
      [
        '# Betriebs\\*anleitung\\*',
        '*Manual* `operating` · *variant* `model=large` · *language* `de`',
        '---',
        '*Module* `charging` · *language* `de`',
        '# Laden\n\nDas {product-name} lädt.',
        '---',
        '*Module* `safety-note` · *language* `en` · *section* Sicherheit',
        '# Safety note\n\n> **CAUTION:** Hot',
      ].join('\n\n') + '\n',
    );
    expect(structured['modules']).toEqual([
      { id: 'charging', lang: 'de', section: [] },
      { id: 'safety-note', lang: 'en', section: ['Sicherheit'] },
    ]);
    // One chunk list per language the manual's modules are in, for the manual and variant.
    expect(
      context.api
        .callsTo('/chunks')
        .map((q) => [
          q['filter[manual]'],
          q['filter[variant]'],
          q['filter[lang]'],
        ]),
    ).toEqual([
      ['operating', 'model=large', 'de'],
      ['operating', 'model=large', 'en'],
    ]);
    await mcp.close();
  });

  it('passes on the API’s not-found for a manual or language outside the scope', async () => {
    const context = stubContext();
    const mcp = await connectClient(context);
    const { isError, structured } = await mcp.call('read_manual', {
      id: 'service',
      variant: 'model=large',
      lang: 'en',
    });
    expect(isError).toBe(true);
    expect(structured['error']).toMatchObject({ code: 'not-found' });
    await mcp.close();
  });
});

describe('read_manual with a module too large to cut into chunks (#688)', () => {
  it('says so in place of the module’s text, and reads the others', async () => {
    const context = stubContext();
    context.api.set('/manuals/operating/variants/model%3Dlarge/de', RESOLVED);
    const page = paged([]);
    context.api.set('/chunks', {
      ...page,
      meta: {
        ...page.meta,
        leftOut: [
          { moduleId: 'charging', lang: 'de', reason: 'depth' },
          { moduleId: 'internals', lang: 'en', reason: 'size' },
        ],
      },
    });
    const mcp = await connectClient(context);
    const { isError, text } = await mcp.call('read_manual', {
      id: 'operating',
      variant: 'model=large',
      lang: 'de',
    });
    expect(isError).toBe(false);
    expect(text).toContain(
      '*(Left out: the module is too large to cut, as its blocks and the modules it refers to nest more than 100 levels deep.)*',
    );
    await mcp.close();
  });
});
