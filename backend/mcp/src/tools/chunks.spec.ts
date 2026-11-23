import {
  chunk,
  connectClient,
  paged,
  stubContext,
} from '../../tests/stub-api.js';
import { ToolError } from '../api-client.js';
import { CHUNK_TEXT_LIMIT, MODULE_TEXT_LIMIT } from './chunks.js';

const TEXT = '# Charging\n\n> **CAUTION:** Hot surface\n>\n> Let it cool down.';

describe('read_module', () => {
  it('reads the module’s chunk by ID and language (and variant) and gives its Markdown', async () => {
    const context = stubContext();
    context.api.set(
      '/chunks',
      paged([chunk('charging', 'en', TEXT, { manuals: ['operating'] })]),
    );
    const mcp = await connectClient(context);
    const { isError, structured, text } = await mcp.call('read_module', {
      id: 'charging',
      lang: 'en',
      variant: 'model=large',
    });
    expect(isError).toBe(false);
    expect(text).toBe(TEXT);
    expect(context.api.callsTo('/chunks')).toEqual([
      {
        ref: 'main',
        'filter[module]': 'charging',
        'filter[lang]': 'en',
        'filter[variant]': 'model=large',
        'page[size]': '1',
      },
    ]);
    expect(structured).toMatchObject({
      moduleId: 'charging',
      lang: 'en',
      manuals: ['operating'],
      audience: 'public',
      release: { tag: 'v1', same: true },
      variant: 'model=large',
      text: TEXT,
      nextCursor: null,
      url: 'http://api.test/modules/en/charging?ref=main',
    });
    await mcp.close();
  });

  it('is not-found for a module it gets no chunk for (missing or outside the scope alike)', async () => {
    const context = stubContext();
    context.api.set('/chunks', paged([]));
    const mcp = await connectClient(context);
    const { isError, structured } = await mcp.call('read_module', {
      id: 'internals',
      lang: 'en',
    });
    expect(isError).toBe(true);
    expect(structured['error']).toMatchObject({
      code: 'not-found',
      status: 404,
    });
    await mcp.close();
  });

  it('gives a long text in parts, by cursor', async () => {
    const long = 'a'.repeat(MODULE_TEXT_LIMIT + 10);
    const context = stubContext();
    context.api.set('/chunks', paged([chunk('big', 'en', long)]));
    const mcp = await connectClient(context);
    const first = await mcp.call('read_module', { id: 'big', lang: 'en' });
    expect(first.text).toHaveLength(MODULE_TEXT_LIMIT);
    expect(first.structured['nextCursor']).toBe(String(MODULE_TEXT_LIMIT));
    const rest = await mcp.call('read_module', {
      id: 'big',
      lang: 'en',
      cursor: first.structured['nextCursor'],
    });
    expect(rest.text).toHaveLength(10);
    expect(rest.structured['nextCursor']).toBeNull();
    await mcp.close();
  });
});

describe('get_chunks', () => {
  it('passes its filters to GET /chunks, pages by cursor and caps each text', async () => {
    const context = stubContext();
    context.api.set(
      '/chunks',
      paged(
        [
          chunk('charging', 'en', TEXT),
          chunk('big', 'en', 'b'.repeat(CHUNK_TEXT_LIMIT + 1)),
        ],
        {
          currentPage: 1,
          lastPage: 3,
        },
      ),
    );
    const mcp = await connectClient(context);
    const commit = 'd'.repeat(40);
    const { structured } = await mcp.call('get_chunks', {
      lang: 'en',
      manual: 'operating',
      variant: 'model=large',
      keywords: ['battery'],
      changedSince: commit,
    });
    expect(context.api.callsTo('/chunks')[0]).toEqual({
      ref: 'main',
      'filter[lang]': 'en',
      'filter[type]': undefined,
      'filter[audience]': undefined,
      'filter[facet]': undefined,
      'filter[keyword]': ['battery'],
      'filter[manual]': 'operating',
      'filter[variant]': 'model=large',
      'filter[changedSince]': commit,
      'page[number]': '1',
      'page[size]': '10',
    });
    expect(structured['nextCursor']).toBe('2');
    const chunks = structured['chunks'] as {
      id: string;
      text: string;
      truncated: boolean;
    }[];
    expect(chunks.map((c) => [c.id, c.text.length, c.truncated])).toEqual([
      ['en/charging', TEXT.length, false],
      ['en/big', CHUNK_TEXT_LIMIT, true],
    ]);
    await mcp.close();
  });
});

describe('a module too large to cut into chunks (#688)', () => {
  const withLeftOut = (data: unknown[]) => {
    const page = paged(data);
    return {
      ...page,
      meta: {
        ...page.meta,
        leftOut: [{ moduleId: 'deep', lang: 'en', reason: 'size' }],
      },
    };
  };

  it('read_module says the module is too large to cut, and why', async () => {
    const context = stubContext();
    context.api.set('/chunks', withLeftOut([]));
    const mcp = await connectClient(context);
    const { isError, structured } = await mcp.call('read_module', {
      id: 'deep',
      lang: 'en',
    });
    expect(isError).toBe(true);
    const error = structured['error'] as Record<string, unknown>;
    expect(error).toMatchObject({
      code: 'expansion-too-large',
      title: 'The module is too large to cut into chunks',
      status: 422,
    });
    expect(error['detail']).toContain('"deep" (en)');
    expect(error['detail']).toContain('500,000 content nodes');
    await mcp.close();
  });

  it('get_chunks lists the other chunks and names the module left out', async () => {
    const context = stubContext();
    context.api.set('/chunks', withLeftOut([chunk('charging', 'en', TEXT)]));
    const mcp = await connectClient(context);
    const { isError, structured } = await mcp.call('get_chunks', {});
    expect(isError).toBe(false);
    expect(
      (structured['chunks'] as { moduleId: string }[]).map((c) => c.moduleId),
    ).toEqual(['charging']);
    expect(structured['leftOut']).toEqual([
      {
        moduleId: 'deep',
        lang: 'en',
        reason: 'size',
        detail: expect.stringContaining('too large to cut'),
      },
    ]);
    await mcp.close();
  });

  it('get_chunks gives an empty leftOut when nothing is left out', async () => {
    const context = stubContext();
    context.api.set('/chunks', paged([chunk('charging', 'en', TEXT)]));
    const mcp = await connectClient(context);
    const { structured } = await mcp.call('get_chunks', {});
    expect(structured['leftOut']).toEqual([]);
    await mcp.close();
  });
});

describe('chunks too large to cut together (#684)', () => {
  const refusal = () =>
    new ToolError(
      'chunk-set-too-large',
      'The chunks are too large to cut together',
      'The chunks of this commit are too large to cut together: …',
      422,
    );

  it.each([
    ['read_module', { id: 'charging', lang: 'en' }],
    ['get_chunks', {}],
  ])('%s gives the API’s refusal as it is', async (tool, args) => {
    const context = stubContext();
    context.api.set('/chunks', refusal());
    const mcp = await connectClient(context);
    const { isError, structured } = await mcp.call(tool, args);
    expect(isError).toBe(true);
    expect(structured['error']).toMatchObject({
      code: 'chunk-set-too-large',
      status: 422,
      detail: expect.stringContaining('too large to cut together'),
    });
    await mcp.close();
  });
});
