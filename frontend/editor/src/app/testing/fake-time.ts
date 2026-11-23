import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

/**
 * For a spec on fake time (`vi.useFakeTimers()`; `testing/test-setup.ts` restores real timers
 * after each test): runs every timer due within `ms` of the fake clock, at least 1 ms, in order
 * (change detection's own among them), renders, then runs what that render set for now.
 *
 * At least 1 ms: a 0 ms timer set while the fake clock runs (by a timer's callback, say a
 * change detection that starts a component's `setTimeout(…, 0)`) is due 1 ms later, so a step
 * of 0 ms would never reach it.
 *
 * A spec never waits a fixed stretch of real time for something a timer does (#562): change
 * detection itself runs on a timer, so on a busy machine a real `wait(30)` can end before the
 * component's own timer is even set. The fake clock runs them all, in order, however slow the
 * machine is. Not `fixture.whenStable()` either: under fake timers it waits on a faked timer.
 */
export async function advance(ms = 0): Promise<void> {
  const ended = endedCheck();
  ended();
  await vi.advanceTimersByTimeAsync(Math.max(ms, 1));
  ended();
  TestBed.tick();
  await vi.advanceTimersByTimeAsync(0);
  ended();
}

/**
 * The running test's signal (Vitest aborts it when the test times out), set before each test by
 * `testing/test-setup.ts`.
 */
let testSignal: AbortSignal | undefined;

/** Called by `testing/test-setup.ts` before each test, with its signal. */
export function trackTest(signal: AbortSignal | undefined): void {
  testSignal = signal;
}

/**
 * A check that throws once the test that called it has ended (timed out, #615). Vitest stops
 * waiting for a test that timed out, but its code goes on in the background; the specs share one
 * window (`testing/test-setup.ts`), so its next step, run on the fake clock and `TestBed.tick()`
 * of whichever test runs then, broke that test too: one timeout in the page design editor's spec
 * failed the backups page's after it. The signal is the one of the test running when the step
 * began, so the abandoned test's next step throws, and its code ends there.
 */
function endedCheck(): () => void {
  const signal = testSignal;
  return () => {
    if (signal?.aborted) {
      throw new Error(
        'This test has ended (it timed out); its next step is not run.',
      );
    }
  };
}

/**
 * For a spec on fake time: runs the fake clock in steps of 10 ms until `promise` settles, for
 * at most `ms` of fake time, and gives what it settled with. For an answer that comes after a
 * timer change detection starts (a dialog answers after its leave transition): no fixed wait,
 * and no hanging test when it never comes.
 */
export async function settled<T>(promise: Promise<T>, ms = 1000): Promise<T> {
  let done = false;
  const mark = () => {
    done = true;
  };
  // Handled at once: a rejection while the clock runs is the caller's, not an unhandled one.
  promise.then(mark, mark);
  const ended = endedCheck();
  for (let waited = 0; !done && waited < ms; waited += 10) {
    ended();
    await vi.advanceTimersByTimeAsync(10);
  }
  ended();
  if (!done) throw new Error(`not settled within ${ms} ms of the fake clock`);
  return promise;
}
