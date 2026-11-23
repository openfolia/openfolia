import { advance, settled, trackTest } from './fake-time';

describe('the fake-time helpers', () => {
  it('stop a test that has ended at its next step (#615)', async () => {
    vi.useFakeTimers();
    const test = new AbortController();
    trackTest(test.signal);
    // A step begun while the test ran, and one begun after Vitest gave up on it.
    const step = advance(10);
    test.abort();
    await expect(step).rejects.toThrow('This test has ended');
    await expect(advance()).rejects.toThrow('This test has ended');
    await expect(settled(new Promise(() => undefined))).rejects.toThrow(
      'This test has ended',
    );
  });

  // The cascade itself: a test that times out while it steps the fake clock, then the next test
  // on fake time, in the same window. Before #615 the first went on stepping the second's clock.
  let stepsAfterTimeout = 0;
  it.fails(
    'times out while stepping the fake clock (expected to fail)',
    { timeout: 50 },
    async ({ signal }) => {
      vi.useFakeTimers();
      for (;;) {
        await advance(1);
        if (signal.aborted) stepsAfterTimeout++;
      }
    },
  );

  it('leaves the next test’s clock alone once that one timed out', async () => {
    vi.useFakeTimers();
    // Steps of its own, between which the abandoned test would step too, were it still running.
    for (let i = 0; i < 50; i++) await advance(1);
    expect(stepsAfterTimeout).toBe(0);
  });
});
