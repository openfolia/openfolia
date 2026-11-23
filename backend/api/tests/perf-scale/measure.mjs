// Measuring helpers for the scale benchmarks: statistics, the machine and its load, the quiet-
// machine guard (the same rule as `expectWithin()` in `tests/perf/budget.ts`: a time taken
// while the 1-minute load average is above the core count measures the machine, not the code).

import { execFileSync } from 'node:child_process';
import {
  availableParallelism,
  cpus,
  loadavg,
  platform,
  release,
  totalmem,
} from 'node:os';

export const CORES = availableParallelism();

export const load1 = () => loadavg()[0] ?? 0;

/** Whether the machine has a core to spare now. */
export const quiet = () => load1() <= CORES;

/**
 * Waits until the machine is quiet, checking every 15 s, at most `maxMs`. Resolves to whether
 * it became quiet (false: the caller measures anyway and reports the result as busy).
 */
export async function waitForQuiet(maxMs, log = () => undefined) {
  const deadline = Date.now() + maxMs;
  let said = false;
  while (!quiet()) {
    if (Date.now() >= deadline) return false;
    if (!said) {
      log(
        `waiting for a quiet machine (load ${load1().toFixed(1)} on ${CORES} cores, at most ${Math.round(maxMs / 60_000)} min)`,
      );
      said = true;
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
  return true;
}

/** `n` (count), median, p95, min and max of a list of times in ms (nearest-rank percentiles). */
export function stats(times) {
  if (times.length === 0) return { n: 0 };
  const sorted = [...times].sort((a, b) => a - b);
  const rank = (p) =>
    sorted[
      Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
    ];
  const round = (v) => Math.round(v * 10) / 10;
  return {
    n: sorted.length,
    median: round(rank(0.5)),
    p95: round(rank(0.95)),
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
  };
}

/** A process's resident memory in bytes (`ps`), or undefined once it is gone. */
export function rssOf(pid) {
  try {
    const kb = Number(
      execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], {
        encoding: 'utf8',
      }).trim(),
    );
    return Number.isFinite(kb) ? kb * 1024 : undefined;
  } catch {
    return undefined;
  }
}

/** The machine a report was made on. */
export function machine() {
  return {
    platform: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model ?? 'unknown',
    cores: CORES,
    memoryGiB: Math.round(totalmem() / 1024 ** 3),
    node: process.version,
  };
}

/** Load samples across a measurement: at its start and end, and the highest seen. */
export class LoadWindow {
  constructor() {
    this.start = load1();
    this.max = this.start;
    this.timer = setInterval(() => {
      this.max = Math.max(this.max, load1());
    }, 1_000);
    this.timer.unref();
  }

  close() {
    clearInterval(this.timer);
    this.end = load1();
    this.max = Math.max(this.max, this.end);
    return {
      start: round1(this.start),
      end: round1(this.end),
      max: round1(this.max),
      busy: this.max > CORES,
    };
  }
}

const round1 = (v) => Math.round(v * 10) / 10;
