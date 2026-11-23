import type { Readable } from 'node:stream';
import { READER } from '../../../tests/fakes/actors.js';
import { TooManyRequestsError } from './errors.js';
import {
  PACKAGE_SENDS_AT_ONCE,
  PackageSends,
  PackageSendTimeout,
} from './package-sends.js';

const settings = {
  idleTimeoutMs: 1_000,
  sendTimeoutMs: 10_000,
  perActor: 1,
  minBytesPerSecond: 1,
};
const someone = (id: string) => ({ ...READER, id });

/** A body that would go on for ever: a chunk every 100 ms (time passing between them, as a blob read's does). */
async function* endless(): AsyncIterable<Uint8Array> {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    yield new Uint8Array(16);
  }
}

const closed = (body: Readable) =>
  new Promise<void>((resolve) => body.once('close', () => resolve()));

const sends = (overrides: Partial<typeof settings> = {}) =>
  new PackageSends({ ...settings, ...overrides }, 'test package');

describe('PackageSends', () => {
  afterEach(() => vi.useRealTimers());

  it('lets one reader take at most their share of the turns, and all of them at most the cap', () => {
    const limiter = sends();
    const first = limiter.send(someone('a'), endless());
    expect(() => limiter.send(someone('a'), endless())).toThrow(
      TooManyRequestsError,
    );
    const others = Array.from({ length: PACKAGE_SENDS_AT_ONCE - 1 }, (_, n) =>
      limiter.send(someone(`b${n}`), endless()),
    );
    expect(() => limiter.send(someone('c'), endless())).toThrow(
      TooManyRequestsError,
    );
    for (const body of [first, ...others]) body.destroy();
  });

  it('never lets one reader take every turn, whatever their share', () => {
    const limiter = sends({ perActor: PACKAGE_SENDS_AT_ONCE });
    const mine = Array.from({ length: PACKAGE_SENDS_AT_ONCE - 1 }, () =>
      limiter.send(someone('a'), endless()),
    );
    expect(() => limiter.send(someone('a'), endless())).toThrow(
      TooManyRequestsError,
    );
    // The turn kept back is another reader's to take.
    const theirs = limiter.send(someone('b'), endless());
    for (const body of [...mine, theirs]) body.destroy();
  });

  it('tells a reader past a bound when to try again, naming what is sent', () => {
    const limiter = sends();
    const first = limiter.send(someone('a'), endless());
    let refused: unknown;
    try {
      limiter.send(someone('a'), endless());
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(TooManyRequestsError);
    expect((refused as TooManyRequestsError).retryAfterSeconds).toBeGreaterThan(
      0,
    );
    expect((refused as Error).message).toContain('test package');
    first.destroy();
  });

  it('frees a turn once its body is destroyed (the client gone)', async () => {
    const limiter = sends();
    const body = limiter.send(someone('a'), endless());
    const done = closed(body);
    body.destroy();
    await done;
    limiter.send(someone('a'), endless()).destroy();
  });

  it('frees a stalled reader’s turn after the idle timeout', async () => {
    vi.useFakeTimers();
    const limiter = sends();
    const body = limiter.send(someone('a'), endless());
    let failure: unknown;
    body.on('error', (error) => {
      failure = error;
    });
    // Its first chunk is read, then nobody reads on: it stalls.
    body.read(0);
    const done = closed(body);
    for (let t = 0; t < 5; t++) {
      await vi.advanceTimersByTimeAsync(settings.idleTimeoutMs / 2);
    }
    await done;
    expect(body.destroyed).toBe(true);
    expect(failure).toBeInstanceOf(PackageSendTimeout);
    expect((failure as PackageSendTimeout).reason).toBe('idle');
    limiter.send(someone('a'), endless()).destroy();
  });

  it('calls `onCut` when a timeout ends the send, and not when the body closes on its own', async () => {
    vi.useFakeTimers();
    const limiter = sends();
    const onCut = vi.fn();
    const stalled = limiter.send(someone('a'), endless(), { onCut });
    stalled.on('error', () => undefined);
    stalled.read(0);
    await vi.advanceTimersByTimeAsync(settings.idleTimeoutMs * 2);
    expect(onCut).toHaveBeenCalledTimes(1);

    const left = vi.fn();
    const gone = limiter.send(someone('b'), endless(), { onCut: left });
    gone.destroy();
    await vi.advanceTimersByTimeAsync(settings.sendTimeoutMs * 2);
    expect(left).not.toHaveBeenCalled();
  });

  it('ends a send read too slowly to hold a turn, after its first idle timeout', async () => {
    vi.useFakeTimers();
    // 16 bytes every 100 ms: 160 bytes a second, under the 1,000 asked for.
    const limiter = sends({ minBytesPerSecond: 1_000 });
    const body = limiter.send(someone('a'), endless());
    body.on('data', () => undefined);
    body.on('error', () => undefined);
    const done = closed(body);
    for (let t = 0; t < 8; t++) await vi.advanceTimersByTimeAsync(500);
    await done;
    expect(body.destroyed).toBe(true);
    limiter.send(someone('a'), endless()).destroy();
  });

  it('frees the turn when a timeout destroys the body, even if its source never ends', async () => {
    vi.useFakeTimers();
    const limiter = sends();
    // A source whose next chunk never comes (a store that hangs).
    const hanging: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
        return: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
      }),
    };
    const body = limiter.send(someone('a'), hanging);
    body.on('error', () => undefined);
    body.read(0);
    await vi.advanceTimersByTimeAsync(settings.idleTimeoutMs + 1);
    expect(() => limiter.send(someone('a'), endless()).destroy()).not.toThrow();
  });

  it('ends a send past the total timeout even while it is read', async () => {
    vi.useFakeTimers();
    const limiter = sends({ sendTimeoutMs: 3_000 });
    const body = limiter.send(someone('a'), endless());
    body.on('data', () => undefined);
    body.on('error', () => undefined);
    const done = closed(body);
    for (let t = 0; t < 4; t++) await vi.advanceTimersByTimeAsync(900);
    await done;
    expect(body.destroyed).toBe(true);
    limiter.send(someone('a'), endless()).destroy();
  });

  it('counts a large chunk read slowly as progress, in slices', async () => {
    vi.useFakeTimers();
    const limiter = sends();
    async function* one(): AsyncIterable<Uint8Array> {
      yield new Uint8Array(1024 * 1024);
    }
    const body = limiter.send(someone('a'), one());
    body.on('error', () => undefined);
    let read = 0;
    let largest = 0;
    // A slice every half idle timeout: slow, but never idle.
    for (let t = 0; t < 4; t++) {
      await vi.advanceTimersByTimeAsync(settings.idleTimeoutMs / 2);
      const slice = body.read() as Uint8Array | null;
      if (slice) {
        read += slice.length;
        largest = Math.max(largest, slice.length);
      }
    }
    expect(body.destroyed).toBe(false);
    expect(read).toBeGreaterThan(0);
    expect(largest).toBeLessThanOrEqual(64 * 1024);
    body.destroy();
  });

  it('keeps the turns of one limiter apart from another’s', () => {
    const one = sends({ perActor: 1 });
    const other = sends({ perActor: 1 });
    const a = one.send(someone('a'), endless());
    const b = other.send(someone('a'), endless());
    a.destroy();
    b.destroy();
  });
});
