import { StubApi, stubContext } from '../tests/stub-api.js';
import { ToolError } from './api-client.js';
import {
  CALLER_IDLE_MS,
  Callers,
  isRefusal,
  REFUSED_TTL_MS,
  SERVICE_TOKEN,
} from './callers.js';

describe('Callers', () => {
  it('takes service tokens of the API’s form only', () => {
    expect(
      SERVICE_TOKEN.test(`ccms_sat_${'a'.repeat(16)}_${'b'.repeat(64)}`),
    ).toBe(true);
    expect(
      SERVICE_TOKEN.test(`ccms_sat_${'a'.repeat(16)}_${'b'.repeat(63)}`),
    ).toBe(false);
    expect(
      SERVICE_TOKEN.test(`ccms_pat_${'a'.repeat(16)}_${'b'.repeat(64)}`),
    ).toBe(false);
  });

  it('tells a refusal of the token from a failure to check it', () => {
    expect(isRefusal(new ToolError('unauthorized', 'x', undefined, 401))).toBe(
      true,
    );
    expect(
      isRefusal(
        new ToolError('service-account-deactivated', 'x', undefined, 403),
      ),
    ).toBe(true);
    expect(
      isRefusal(new ToolError('too-many-failed-attempts', 'x', undefined, 429)),
    ).toBe(true);
    expect(isRefusal(new ToolError('token-not-read-only', 'x'))).toBe(true);
    expect(isRefusal(new ToolError('api-unavailable', 'x'))).toBe(false);
    expect(isRefusal(new ToolError('http-502', 'x', undefined, 502))).toBe(
      false,
    );
    expect(isRefusal(new ToolError('unexpected-answer', 'x'))).toBe(false);
    // A 401 or 403 of something in front of the API, without the API's code.
    expect(isRefusal(new ToolError('http-403', 'x', undefined, 403))).toBe(
      false,
    );
    expect(isRefusal(new ToolError('http-401', 'x', undefined, 401))).toBe(
      false,
    );
    expect(isRefusal(new Error('x'))).toBe(false);
  });

  it('keeps a context per token once it passed, and forgets it when the API refuses it later', async () => {
    const apis = new Map<string, StubApi>();
    const callers = new Callers((token) => {
      const api = new StubApi();
      apis.set(token, api);
      return stubContext(api);
    });
    const first = await callers.admit('a', 'ka');
    expect(await callers.admit('a', 'ka')).toBe(first);
    expect(await callers.admit('b', 'kb')).not.toBe(first);
    expect(callers.size).toBe(2);
    // A check that fails for want of an answer keeps the caller.
    const check = vi
      .spyOn(first.token, 'ensure')
      .mockRejectedValueOnce(new ToolError('api-unavailable', 'x'));
    await expect(callers.admit('a', 'ka')).rejects.toMatchObject({
      code: 'api-unavailable',
    });
    expect(callers.size).toBe(2);
    check.mockRejectedValueOnce(
      new ToolError('token-revoked', 'x', undefined, 401),
    );
    await expect(callers.admit('a', 'ka')).rejects.toMatchObject({
      code: 'token-revoked',
    });
    expect(callers.size).toBe(1);
  });

  it('never keeps a token the API refuses', async () => {
    const callers = new Callers(() =>
      stubContext(
        new StubApi().set(
          '/me',
          new ToolError('unauthorized', 'x', undefined, 401),
        ),
      ),
    );
    await expect(callers.admit('x', 'kx')).rejects.toMatchObject({
      code: 'unauthorized',
    });
    expect(callers.size).toBe(0);
  });

  it('keeps at most its bound, forgetting the one used longest ago, and forgets idle callers', async () => {
    let now = 0;
    const callers = new Callers(
      () => stubContext(),
      () => now,
      2,
    );
    const a = await callers.admit('a', 'ka');
    await callers.admit('b', 'kb');
    await callers.admit('a', 'ka');
    await callers.admit('c', 'kc');
    expect(callers.size).toBe(2);
    expect(await callers.admit('a', 'ka')).toBe(a);
    now = CALLER_IDLE_MS;
    await callers.admit('d', 'kd');
    expect(callers.size).toBe(1);
  });

  it('refuses a refused token again for a while without the API, and shares checks at once', async () => {
    let now = 0;
    const api = new StubApi().set(
      '/me',
      new ToolError('unauthorized', 'x', undefined, 401),
    );
    const callers = new Callers(
      () => stubContext(api),
      () => now,
    );
    await expect(callers.admit('x', 'kx')).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await expect(callers.admit('x', 'kx')).rejects.toMatchObject({
      code: 'unauthorized',
    });
    expect(api.callsTo('/me')).toHaveLength(1);
    now = REFUSED_TTL_MS;
    await expect(callers.admit('x', 'kx')).rejects.toThrow();
    expect(api.callsTo('/me')).toHaveLength(2);
    const ok = new StubApi();
    const fresh = new Callers(() => stubContext(ok));
    const [a, b] = await Promise.all([
      fresh.admit('y', 'ky'),
      fresh.admit('y', 'ky'),
    ]);
    expect(a).toBe(b);
    expect(ok.callsTo('/me')).toHaveLength(1);
  });
});
