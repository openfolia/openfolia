import { availableParallelism, loadavg } from 'node:os';

/**
 * Checks a measured wall-clock time against an acceptance criterion's
 * budget, and always prints the measurement (`perf: …`), so the criterion
 * stays measured and reported on every `api:perf` run.
 *
 * The budget is asserted only while the machine has a core to spare: with
 * the 1-minute load average above the core count (several checks running at
 * once), a request waits for a CPU, and the time measures the machine, not
 * the code. Then the line says so and nothing fails.
 */
export function expectWithin(
  what: string,
  tookMs: number,
  budgetMs: number,
): void {
  const [load = 0] = loadavg();
  const cores = availableParallelism();
  const busy = load > cores;
  console.info(
    `perf: ${what}: ${tookMs.toFixed(1)} ms (budget ${budgetMs} ms; load ${load.toFixed(1)} on ${cores} cores` +
      (busy ? ': busy, not asserted)' : ')'),
  );
  if (!busy) expect(tookMs, what).toBeLessThan(budgetMs);
}
