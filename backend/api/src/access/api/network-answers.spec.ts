import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import {
  ADDRESS_IN_TURN,
  NETWORK_QUEUE,
  NetworkAnswers,
  TURN_LIMIT_MS,
} from './failed-authentications.js';

describe('NetworkAnswers (#965)', () => {
  const make = () =>
    new NetworkAnswers({ get: () => 60_000 } as unknown as ConfigService<
      Env,
      true
    >);
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  it('gives the turn to one answer of a network at a time, in order', async () => {
    const answers = make();
    const order: number[] = [];
    const take = async (i: number, client: string) => {
      const end = await answers.enter('net', client);
      order.push(i);
      return end!;
    };
    const first = await take(1, 'a');
    const second = take(2, 'b');
    const third = take(3, 'c');
    await tick();
    expect(order).toEqual([1]);
    first();
    const endSecond = await second;
    expect(order).toEqual([1, 2]);
    endSecond();
    (await third)();
    expect(order).toEqual([1, 2, 3]);
    // Another network never waits for it.
    expect(await answers.enter('other', 'a')).toBeTypeOf('function');
  });

  it('refuses past what a network, or one address of it, may have in turn, and makes room when one ends', async () => {
    const answers = make();
    const ends: (() => void)[] = [];
    // The first is in turn at once, the others wait: all count.
    const first = await answers.enter('net', 'a');
    ends.push(first!);
    for (let i = 1; i < ADDRESS_IN_TURN; i++) {
      void answers.enter('net', 'a').then((end) => end && ends.push(end));
    }
    expect(await answers.enter('net', 'a')).toBeUndefined();
    for (let i = 0; i < NETWORK_QUEUE - ADDRESS_IN_TURN; i++) {
      void answers.enter('net', `b${i}`);
    }
    expect(await answers.enter('net', 'z')).toBeUndefined();
    first!();
    // Room again: it is not refused, it waits for its turn.
    const again = await Promise.race([
      answers.enter('net', 'a'),
      tick().then(() => 'waiting'),
    ]);
    expect(again).toBe('waiting');
  });

  it('ends a turn that is held too long, once', async () => {
    vi.useFakeTimers();
    try {
      const answers = make();
      const first = await answers.enter('net', 'a');
      const second = answers.enter('net', 'b');
      await vi.advanceTimersByTimeAsync(TURN_LIMIT_MS);
      const end = await second;
      expect(end).toBeTypeOf('function');
      // Ending the first now changes nothing.
      first!();
      end!();
      expect(await answers.enter('net', 'c')).toBeTypeOf('function');
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs a refusal once per network and window', () => {
    const answers = make();
    let now = 0;
    answers.now = () => now;
    expect(answers.firstRefusal('a')).toBe(true);
    expect(answers.firstRefusal('a')).toBe(false);
    expect(answers.firstRefusal('b')).toBe(true);
    now = 60_000;
    expect(answers.firstRefusal('a')).toBe(true);
  });
});
