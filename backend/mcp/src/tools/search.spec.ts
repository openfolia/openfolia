import { ToolError } from '../api-client.js';
import { connectClient, paged, stubContext } from '../../tests/stub-api.js';

function searchResult(
  resourceType: string,
  resourceId: string,
  title: string,
  lang?: string,
) {
  return {
    type: 'SearchResult',
    id: `${resourceType}:${resourceId}`,
    attributes: { resourceType, resourceId, title, ...(lang && { lang }) },
    meta: {
      matchedOn: 'keyword',
      excerpt: 'maintenance, battery',
      matches: [],
    },
  };
}

describe('search', () => {
  it('passes the query and filters to GET /search at main, and gives IDs, excerpts and URLs', async () => {
    const context = stubContext();
    context.api.set(
      '/search',
      paged(
        [
          searchResult('Module', 'en/charging', 'Charging', 'en'),
          searchResult('Manual', 'operating', 'Operating manual'),
        ],
        { currentPage: 1, lastPage: 2 },
      ),
    );
    const mcp = await connectClient(context);
    const { isError, structured } = await mcp.call('search', {
      query: 'battery',
      lang: 'en',
      moduleType: 'procedure',
      facets: ['region:north'],
    });
    expect(isError).toBe(false);
    expect(context.api.callsTo('/search')).toEqual([
      {
        ref: 'main',
        'filter[q]': 'battery',
        'filter[lang]': 'en',
        'filter[resourceType]': undefined,
        'filter[type]': 'procedure',
        'filter[audience]': undefined,
        'filter[facet]': ['region:north'],
        'filter[keyword]': undefined,
        'page[number]': '1',
        'page[size]': '20',
      },
    ]);
    expect(structured).toMatchObject({
      ref: 'main',
      total: 52,
      nextCursor: '2',
    });
    expect(structured['results']).toEqual([
      {
        resourceType: 'Module',
        id: 'charging',
        lang: 'en',
        title: 'Charging',
        excerpt: 'maintenance, battery',
        matchedOn: 'keyword',
        url: 'http://api.test/modules/en/charging?ref=main',
      },
      {
        resourceType: 'Manual',
        id: 'operating',
        title: 'Operating manual',
        excerpt: 'maintenance, battery',
        matchedOn: 'keyword',
        url: 'http://api.test/manuals/operating?ref=main',
      },
    ]);
    await mcp.close();
  });

  it('reads the next page from a cursor, at a release tag', async () => {
    const context = stubContext();
    context.api.set('/search', paged([], { currentPage: 2, lastPage: 2 }));
    const mcp = await connectClient(context);
    const { structured } = await mcp.call('search', {
      query: 'x',
      ref: 'v1',
      cursor: '2',
    });
    expect(context.api.callsTo('/search')[0]).toMatchObject({
      ref: 'v1',
      'page[number]': '2',
    });
    expect(structured['nextCursor']).toBeNull();
    await mcp.close();
  });

  it('turns an API refusal into a tool error with its code, never a stack trace', async () => {
    const context = stubContext();
    context.api.set(
      '/search',
      new ToolError(
        'too-many-failed-attempts',
        'Too many failed attempts',
        undefined,
        429,
        30,
      ),
    );
    const mcp = await connectClient(context);
    const { isError, structured, text } = await mcp.call('search', {
      query: 'x',
    });
    expect(isError).toBe(true);
    expect(structured).toEqual({
      error: {
        code: 'too-many-failed-attempts',
        title: 'Too many failed attempts',
        status: 429,
        retryAfter: 30,
      },
    });
    expect(text).not.toMatch(/\bat\s.+:\d+:\d+/);
    await mcp.close();
  });

  it('refuses arguments outside its schema before any API call', async () => {
    const context = stubContext();
    const mcp = await connectClient(context);
    expect((await mcp.call('search', { query: '' })).isError).toBe(true);
    expect(
      (await mcp.call('search', { query: 'x', facets: ['no-colon'] })).isError,
    ).toBe(true);
    expect(
      (await mcp.call('search', { query: 'x', cursor: '0' })).isError,
    ).toBe(true);
    expect(context.api.calls).toEqual([]);
    await mcp.close();
  });
});
