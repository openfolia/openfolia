import { inspect } from 'node:util';
import { ApiClient, ApiError } from '../build/api-client.ts';

const TOKEN = `ccms_sat_${'1'.repeat(16)}_${'2'.repeat(64)}`;
const BASE = new URL('https://api.example.com/api/');

type Call = { url: string; init: RequestInit };

function fake(answers: (() => Response)[]): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const next = answers.shift();
      if (!next) throw new TypeError('fetch failed');
      return next();
    }) as typeof fetch,
  };
}

const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/vnd.api+json', ...headers },
  });

describe('the API client', () => {
  it('sends the token in the Authorization header only, and refuses redirects', async () => {
    const { fetch, calls } = fake([
      () => json({ data: { type: 'Actor', id: 'x', attributes: {} } }),
    ]);
    const client = new ApiClient(BASE, TOKEN, { fetch });
    await client.resource('/me', { ref: 'v1' });
    expect(calls[0]!.url).toBe('https://api.example.com/api/me?ref=v1');
    expect(calls[0]!.url).not.toContain(TOKEN);
    expect(calls[0]!.init.redirect).toBe('error');
    expect(
      (calls[0]!.init.headers as Record<string, string>)['Authorization'],
    ).toBe(`Bearer ${TOKEN}`);
  });

  it('never shows the token when printed', () => {
    const client = new ApiClient(BASE, TOKEN);
    expect(JSON.stringify({ client })).not.toContain(TOKEN.slice(-64));
    expect(inspect(client, { showHidden: true, depth: 5 })).not.toContain(
      TOKEN.slice(-64),
    );
  });

  it('names the error code, never the token or the server text', async () => {
    const { fetch } = fake([
      () =>
        json(
          {
            errors: [
              { status: '401', code: 'token-revoked', detail: `bad ${TOKEN}` },
            ],
          },
          401,
        ),
    ]);
    const client = new ApiClient(BASE, TOKEN, { fetch });
    const error = await client.json('/me').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe(
      '/me: the API answered 401 token-revoked',
    );
    expect((error as ApiError).code).toBe('token-revoked');
  });

  it('waits out a 429 or 503 as Retry-After says, a bounded number of times', async () => {
    const waits: number[] = [];
    const { fetch, calls } = fake([
      () => json({ errors: [] }, 429, { 'retry-after': '2' }),
      () => json({ errors: [] }, 503),
      () => json({ data: { type: 'X', id: '1', attributes: {} } }),
    ]);
    const client = new ApiClient(BASE, TOKEN, {
      fetch,
      sleep: async (ms) => void waits.push(ms),
    });
    await client.resource('/x');
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([2000, 1000]);

    const busy = fake(
      [0, 1, 2, 3].map(
        () => () =>
          json({ errors: [{ code: 'renderer-busy' }] }, 503, {
            'retry-after': '1',
          }),
      ),
    );
    const gives = new ApiClient(BASE, TOKEN, {
      fetch: busy.fetch,
      sleep: async () => undefined,
      retries: 3,
    });
    await expect(gives.json('/x')).rejects.toThrow('503 renderer-busy');
    expect(busy.calls).toHaveLength(4);
  });

  it('reads every page of a list', async () => {
    const page = (n: number, last: number) => () =>
      json({
        data: [{ type: 'X', id: String(n), attributes: {} }],
        meta: { page: { currentPage: n, lastPage: last } },
      });
    const { fetch, calls } = fake([page(1, 2), page(2, 2)]);
    const client = new ApiClient(BASE, TOKEN, { fetch });
    expect((await client.list('/xs')).map((x) => x.id)).toEqual(['1', '2']);
    expect(
      calls.map((c) => new URL(c.url).searchParams.get('page[number]')),
    ).toEqual(['1', '2']);
  });

  it('reads only paths of the API', async () => {
    const { fetch, calls } = fake([]);
    const client = new ApiClient(BASE, TOKEN, {
      fetch,
      sleep: async () => undefined,
    });
    await expect(
      client.json('https://elsewhere.example.com/x'),
    ).rejects.toThrow('not a path of the API');
    // A path that looks like another host stays a path of the API.
    await expect(client.json('//elsewhere.example.com/x')).rejects.toThrow(
      ApiError,
    );
    expect(calls.map((c) => new URL(c.url).origin)).toEqual(
      Array(4).fill('https://api.example.com'),
    );
  });
});
