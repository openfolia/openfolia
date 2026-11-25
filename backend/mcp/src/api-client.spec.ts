import {
  HttpContentApi,
  JSON_API,
  MAX_RESPONSE_BYTES,
  segments,
  ToolError,
} from './api-client.js';

function fakeFetch(answer: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: URL, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return answer();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('HttpContentApi', () => {
  it('sends the token and the media type on every GET, repeats list values and reads the commit', async () => {
    const f = fakeFetch(
      () =>
        new Response('{"data":[]}', {
          status: 200,
          headers: { 'X-Ccms-Commit': 'abc' },
        }),
    );
    const api = new HttpContentApi('http://api.test/', 'ccms_sat_secret', f.fn);
    const answer = await api.get('/chunks', {
      ref: 'main',
      'filter[facet]': ['a:b', 'c:d'],
      skip: undefined,
    });
    expect(answer).toEqual({ body: { data: [] }, commit: 'abc' });
    expect(f.calls[0]?.url).toBe(
      'http://api.test/chunks?ref=main&filter%5Bfacet%5D=a%3Ab&filter%5Bfacet%5D=c%3Ad',
    );
    expect(f.calls[0]?.init).toMatchObject({
      headers: {
        Authorization: 'Bearer ccms_sat_secret',
        Accept: JSON_API,
        'X-OpenFolia-Client': 'mcp',
      },
      redirect: 'error',
    });
    expect(f.calls[0]?.init.method ?? 'GET').toBe('GET');
  });

  // #877: the API records each read of the account with what it was for.
  it('names what a read is for in X-OpenFolia-Client', async () => {
    const f = fakeFetch(() => new Response('{}', { status: 200 }));
    const api = new HttpContentApi('http://api.test', 'ccms_sat_secret', f.fn);
    await api.get('/search', {}, undefined, 'mcp/search');
    expect(f.calls[0]?.init.headers).toMatchObject({
      'X-OpenFolia-Client': 'mcp/search',
    });
  });

  it('turns a JSON:API error into a ToolError with its code, status and retry time', async () => {
    const f = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            errors: [
              {
                status: '404',
                code: 'not-found',
                title: 'Not found',
                detail: 'No module.',
              },
            ],
          }),
          { status: 404 },
        ),
    );
    const api = new HttpContentApi('http://api.test', 't', f.fn);
    await expect(api.get('/x')).rejects.toMatchObject({
      code: 'not-found',
      status: 404,
      detail: 'No module.',
    });
    const limited = new HttpContentApi(
      'http://api.test',
      't',
      fakeFetch(
        () =>
          new Response('', { status: 429, headers: { 'Retry-After': '12' } }),
      ).fn,
    );
    await expect(limited.get('/x')).rejects.toMatchObject({
      code: 'http-429',
      status: 429,
      retryAfter: 12,
    });
  });

  it('says the API is unavailable when it cannot be reached, and refuses an answer too large', async () => {
    const down = new HttpContentApi('http://api.test', 't', (async () => {
      throw new TypeError('fetch failed: ccms_sat_secret');
    }) as unknown as typeof fetch);
    const error = await down.get('/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolError);
    expect(error).toMatchObject({ code: 'api-unavailable' });
    expect(JSON.stringify(error)).not.toContain('ccms_sat_secret');
    const huge = new HttpContentApi(
      'http://api.test',
      't',
      fakeFetch(() => new Response('x'.repeat(MAX_RESPONSE_BYTES + 1))).fn,
    );
    await expect(huge.get('/x')).rejects.toMatchObject({
      code: 'response-too-large',
    });
  });

  it('gives a request up when its signal aborts', async () => {
    const api = new HttpContentApi(
      'http://api.test',
      't',
      ((_url: URL, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        })) as unknown as typeof fetch,
    );
    const controller = new AbortController();
    const pending = api.get('/x', {}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('encodes path segments', () => {
    expect(segments('manuals', 'a', 'variants', 'model=large,x=a b')).toBe(
      '/manuals/a/variants/model%3Dlarge%2Cx%3Da%20b',
    );
  });
});
