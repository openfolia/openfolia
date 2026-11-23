import { ToolError } from './api-client.js';
import {
  Cached,
  checkRefForm,
  REFRESH_MIN_MS,
  ReleasedRefs,
  TokenCheck,
} from './released.js';
import { COMMIT, paged, StubApi } from '../tests/stub-api.js';

describe('refs', () => {
  it('refuses a change set’s branch, a commit ID or a malformed name by its form', () => {
    for (const ref of [
      'change-sets/0190a1b2',
      'CHANGE-SETS/x',
      'a'.repeat(40),
      'deadbee',
      '../main',
      'refs/heads/main',
      'a b',
      'x.lock',
    ]) {
      expect(() => checkRefForm(ref), ref).toThrow(ToolError);
    }
    expect(() => checkRefForm('main')).not.toThrow();
    expect(() => checkRefForm('release/tugger/2.0')).not.toThrow();
  });

  it('refuses a change set’s branch before any API call', async () => {
    const api = new StubApi();
    const refs = new ReleasedRefs(api);
    await expect(refs.resolve('change-sets/0190a1b2')).rejects.toMatchObject({
      code: 'ref-not-released',
    });
    expect(api.calls).toEqual([]);
  });

  it('takes main without a lookup, a listed tag, and refuses an unknown name or a withdrawn release', async () => {
    const api = new StubApi();
    const refs = new ReleasedRefs(api);
    await expect(refs.resolve(undefined)).resolves.toBe('main');
    expect(api.calls).toEqual([]);
    await expect(refs.resolve('v1')).resolves.toBe('v1');
    await expect(refs.resolve('draft')).rejects.toMatchObject({
      code: 'ref-not-released',
    });
    await expect(refs.resolve('v0')).rejects.toMatchObject({
      code: 'release-withdrawn',
    });
    // Kept; a name not found may look again, but not within REFRESH_MIN_MS of the last read.
    expect(api.callsTo('/refs')).toHaveLength(1);
    expect(api.callsTo('/releases')).toHaveLength(1);
  });

  it('reads the lists again for unknown names at most once in the window, shared by concurrent calls', async () => {
    let now = 0;
    const api = new StubApi();
    const refs = new ReleasedRefs(api, () => now);
    await refs.resolve('v1');
    now = REFRESH_MIN_MS;
    const names = Array.from({ length: 50 }, (_, i) => `nope-${i}`);
    const results = await Promise.allSettled(names.map((n) => refs.resolve(n)));
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(api.callsTo('/refs')).toHaveLength(2);
    // More unknown names, and the same ones again, within the window: no read.
    await Promise.allSettled([...names, 'other'].map((n) => refs.resolve(n)));
    expect(api.callsTo('/refs')).toHaveLength(2);
    expect(api.callsTo('/releases')).toHaveLength(2);
    // A release cut since is found once the window has passed.
    now = 2 * REFRESH_MIN_MS + 1;
    api.set(
      '/refs',
      paged([
        {
          type: 'Ref',
          id: 'tags/v2',
          attributes: { kind: 'tag', name: 'v2', commit: COMMIT },
        },
      ]),
    );
    await expect(refs.resolve('v2')).resolves.toBe('v2');
  });

  it('stops waiting for a lookup when the call is given up', async () => {
    const api = new StubApi();
    api.set('/refs', () => new Promise(() => undefined));
    const controller = new AbortController();
    const pending = new ReleasedRefs(api).resolve('v1', controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('refuses to check a ref against a list too long to read whole', async () => {
    const api = new StubApi();
    api.set('/releases', (q: Record<string, unknown>) => ({
      data: [],
      meta: {
        page: {
          currentPage: Number(q['page[number]']),
          lastPage: 99,
          perPage: 200,
          total: 99 * 200,
        },
      },
    }));
    await expect(new ReleasedRefs(api).resolve('v1')).rejects.toMatchObject({
      code: 'lookup-too-large',
    });
  });
});

describe('TokenCheck', () => {
  it('takes a token holding content.read alone, and refuses a wider one', async () => {
    const api = new StubApi();
    await expect(new TokenCheck(api).ensure()).resolves.toBeUndefined();
    api.set('/me', {
      data: {
        meta: {
          permissions: [
            { permission: 'content.read' },
            { permission: 'content.read.draft' },
          ],
        },
      },
    });
    await expect(new TokenCheck(api).ensure()).rejects.toMatchObject({
      code: 'token-not-read-only',
    });
    api.set('/me', {
      data: { type: 'Actor', id: 'service:agent', meta: { permissions: [] } },
    });
    await expect(new TokenCheck(api).ensure()).rejects.toMatchObject({
      code: 'token-not-read-only',
    });
  });
});

describe('Cached', () => {
  it('keeps a value for its time, and never a failure', async () => {
    let now = 0;
    let n = 0;
    const failing = { fail: true };
    const cached = new Cached(
      async () => {
        n++;
        if (failing.fail) throw new Error('down');
        return n;
      },
      1000,
      () => now,
    );
    await expect(cached.get()).rejects.toThrow('down');
    failing.fail = false;
    await expect(cached.get()).resolves.toBe(2);
    now = 999;
    await expect(cached.get()).resolves.toBe(2);
    now = 1000;
    await expect(cached.get()).resolves.toBe(3);
  });
  it('refreshes at most once in the window even when refreshes fail, keeping a fresh value through them', async () => {
    let now = 0;
    let loads = 0;
    let fail = false;
    const cached = new Cached(
      async () => {
        loads++;
        if (fail) throw new Error('down');
        return loads;
      },
      60_000,
      () => now,
    );
    await expect(cached.get()).resolves.toBe(1);
    fail = true;
    now = 10_000;
    // The refresh fails: the value, still fresh, is served on.
    await expect(cached.refresh(10_000)).resolves.toBe(1);
    await expect(cached.refresh(10_000)).resolves.toBe(1);
    expect(loads).toBe(2);
    // Concurrent refreshes share one load.
    now = 20_000;
    await Promise.all([cached.refresh(10_000), cached.refresh(10_000)]);
    expect(loads).toBe(3);
    // Stale and failing: refused.
    now = 61_000;
    await expect(cached.get()).rejects.toThrow('down');
  });
});
