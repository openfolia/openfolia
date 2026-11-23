import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  checkTriggerSignature,
  createTriggerListener,
  parseListen,
  RateLimiter,
  ReplayGuard,
  RunQueue,
  signTrigger,
  TRIGGER_SIGNATURE_HEADER,
  triggerSignatureHeader,
} from './webhook.js';

const SECRET = 'k'.repeat(40);
const NOW = 1_800_000_000_000;
const T = NOW / 1000;
const body = (s: string) => Buffer.from(s);

describe('the trigger signature', () => {
  const check = (header: string | undefined, b = '{}', now = NOW) =>
    checkTriggerSignature(header, body(b), SECRET, {
      now,
      notBefore: NOW - 60_000,
    });

  it('is accepted when it signs the body at a time near now', () => {
    const result = check(triggerSignatureHeader(SECRET, T, '{}'));
    expect(result).toEqual({
      ok: true,
      key: signTrigger(SECRET, T, '{}'),
      expiresAt: (T + 301) * 1000,
    });
    // One of several signatures matching is enough (a source rotating its secret).
    expect(
      check(`t=${T},v1=${'0'.repeat(64)},v1=${signTrigger(SECRET, T, '{}')}`)
        .ok,
    ).toBe(true);
  });

  it('is refused when missing, malformed, for another body or secret', () => {
    expect(check(undefined)).toEqual({ ok: false, code: 'signature-missing' });
    expect(check('v1=abc')).toEqual({ ok: false, code: 'signature-missing' });
    expect(check(`t=${T}`)).toEqual({ ok: false, code: 'signature-missing' });
    expect(check(triggerSignatureHeader(SECRET, T, '{"a":1}'))).toEqual({
      ok: false,
      code: 'signature-invalid',
    });
    expect(check(triggerSignatureHeader('x'.repeat(40), T, '{}'))).toEqual({
      ok: false,
      code: 'signature-invalid',
    });
  });

  it('is refused when its time lies more than five minutes behind, a minute ahead, or before the listener started', () => {
    for (const t of [T - 301, T + 61, T - 120]) {
      expect(check(triggerSignatureHeader(SECRET, t, '{}'))).toEqual({
        ok: false,
        code: 'signature-expired',
      });
    }
    expect(check(triggerSignatureHeader(SECRET, T - 60, '{}')).ok).toBe(true);
    expect(check(triggerSignatureHeader(SECRET, T + 60, '{}')).ok).toBe(true);
  });
});

describe('the replay guard', () => {
  it('refuses a key until it expires, and refuses new ones when full of live ones', () => {
    const guard = new ReplayGuard(2);
    expect(guard.admit('a', 2000, 1000)).toBe('accepted');
    expect(guard.admit('a', 2000, 1500)).toBe('replayed');
    expect(guard.admit('b', 3000, 1500)).toBe('accepted');
    expect(guard.admit('c', 3000, 1500)).toBe('full');
    // Once `a` expired, its room is free again.
    expect(guard.admit('c', 4000, 2000)).toBe('accepted');
    expect(guard.admit('b', 3000, 2500)).toBe('replayed');
  });
});

describe('the rate limiter', () => {
  it('lets a caller make `limit` requests a window and says how long to wait', () => {
    const limiter = new RateLimiter(2, 60_000, 2);
    expect(limiter.take('a', 0)).toBe(0);
    expect(limiter.take('a', 1000)).toBe(0);
    expect(limiter.take('a', 1000)).toBe(59);
    expect(limiter.take('b', 1000)).toBe(0);
    // Two callers in their window: a third waits too.
    expect(limiter.take('c', 1000)).toBe(60);
    expect(limiter.take('a', 60_000)).toBe(0);
  });
});

describe('the run queue', () => {
  it('runs one at a time, folds requests into the run waiting and keeps the gap', async () => {
    let now = 0;
    const started: number[] = [];
    let release: () => void = () => undefined;
    const sleeps: number[] = [];
    const queue = new RunQueue({
      run: () => {
        started.push(now);
        return new Promise<void>((resolve) => (release = resolve));
      },
      minGapMs: 60_000,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    expect(queue.request()).toBe('queued');
    await vi.waitFor(() => expect(started).toEqual([0]));
    // During the run: one more is wanted, further requests fold into it.
    now = 10_000;
    expect(queue.request()).toBe('queued');
    expect(queue.request()).toBe('already-queued');
    release();
    await vi.waitFor(() => expect(started).toHaveLength(2));
    expect(sleeps).toEqual([50_000]);
    expect(started).toEqual([0, 60_000]);
    release();
    await queue.idle();
    expect(started).toHaveLength(2);
  });

  it('goes on after a run that throws at once', async () => {
    let runs = 0;
    const queue = new RunQueue({
      run: () => {
        runs += 1;
        throw new Error('at once');
      },
    });
    queue.request();
    await queue.idle();
    queue.request();
    await queue.idle();
    expect(runs).toBe(2);
  });

  it('goes on after a failed run, and on stop drops the waiting run', async () => {
    let runs = 0;
    const queue = new RunQueue({
      run: async () => {
        runs += 1;
        if (runs === 1) throw new Error('failed');
      },
      minGapMs: 60_000,
      sleep: (_ms, signal) =>
        new Promise((resolve) =>
          signal.addEventListener('abort', () => resolve()),
        ),
    });
    queue.request();
    await queue.idle();
    expect(runs).toBe(1);
    expect(queue.request()).toBe('queued');
    await queue.stop();
    expect(runs).toBe(1);
    expect(queue.request()).toBe('stopped');
  });
});

describe('the trigger listener', () => {
  let server: Server;
  let base: string;
  let runs = 0;
  const lines: string[] = [];
  let now = NOW;

  beforeEach(async () => {
    runs = 0;
    lines.length = 0;
    now = NOW;
    const queue = new RunQueue({
      run: async () => {
        runs += 1;
      },
    });
    server = createTriggerListener({
      secret: SECRET,
      queue,
      perMinute: 5,
      now: () => now,
      log: (l) => lines.push(l),
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(
    () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  );

  const send = (b: string, header?: string, path = '/trigger') =>
    fetch(`${base}${path}`, {
      method: 'POST',
      body: b,
      headers: header ? { [TRIGGER_SIGNATURE_HEADER]: header } : {},
    });

  it('answers a signed trigger at once with 202 and queues a run', async () => {
    const res = await send(
      '{"event":"changed"}',
      triggerSignatureHeader(SECRET, T, '{"event":"changed"}'),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ run: 'queued' });
    await vi.waitFor(() => expect(runs).toBe(1));
    expect(lines).toEqual(['Trigger accepted: a run is queued.']);
  });

  it('refuses an unsigned, wrongly signed, stale or replayed trigger, and runs nothing', async () => {
    expect((await send('{}')).status).toBe(401);
    const wrong = await send(
      '{}',
      triggerSignatureHeader('x'.repeat(40), T, '{}'),
    );
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: 'signature-invalid' });
    const stale = await send(
      '{}',
      triggerSignatureHeader(SECRET, T - 600, '{}'),
    );
    expect(await stale.json()).toEqual({ error: 'signature-expired' });
    const header = triggerSignatureHeader(SECRET, T, 'once');
    expect((await send('once', header)).status).toBe(202);
    await vi.waitFor(() => expect(runs).toBe(1));
    const replay = await send('once', header);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({ error: 'replayed' });
    expect(runs).toBe(1);
    expect(lines.join('\n')).not.toContain(SECRET);
    expect(lines.join('\n')).not.toContain(header.slice(15));
  });

  it('limits refused requests per caller with Retry-After, never a signed one', async () => {
    for (let i = 0; i < 5; i += 1) expect((await send('{}')).status).toBe(401);
    const res = await send('{}');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    // The source, at the same address (a proxy's), still gets through.
    expect(
      (await send('{}', triggerSignatureHeader(SECRET, T, '{}'))).status,
    ).toBe(202);
    await vi.waitFor(() => expect(runs).toBe(1));
    now = NOW + 60_000;
    expect((await send('{}')).status).toBe(401);
  });

  it('refuses a large body, another route and another method', async () => {
    const big = 'x'.repeat(64 * 1024 + 1);
    expect(
      (await send(big, triggerSignatureHeader(SECRET, T, big))).status,
    ).toBe(413);
    expect((await send('{}', undefined, '/other')).status).toBe(404);
    const get = await fetch(`${base}/trigger`);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect(runs).toBe(0);
  });
});

describe('--listen', () => {
  it('is a port on this machine, or a host and port', () => {
    expect(parseListen('8080')).toEqual({ host: '127.0.0.1', port: 8080 });
    expect(parseListen('0.0.0.0:8080')).toEqual({
      host: '0.0.0.0',
      port: 8080,
    });
    expect(parseListen('[::1]:8080')).toEqual({ host: '::1', port: 8080 });
    for (const bad of ['', 'x', '70000', 'a:b', 'http://x:1']) {
      expect(parseListen(bad)).toBeUndefined();
    }
  });
});
