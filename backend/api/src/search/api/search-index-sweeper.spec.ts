import type { ServerRole } from '../../config/server-role.js';
import {
  NoSearchIndexSweep,
  SearchIndexSweep,
  type SearchSweepReport,
} from '../core/search-index-sweep.js';
import {
  FIRST_SEARCH_SWEEP_MS,
  SEARCH_SWEEP_AGAIN_MS,
  SEARCH_SWEEP_EVERY_MS,
  SearchIndexSweeper,
} from './search-index-sweeper.js';

/** Answers the reports it is given, in turn, counting the runs. */
class FakeSweep extends SearchIndexSweep {
  runs = 0;
  constructor(private readonly reports: Partial<SearchSweepReport>[]) {
    super();
  }
  async sweep(): Promise<SearchSweepReport> {
    const done = await new NoSearchIndexSweep().sweep();
    return { ...done, ...this.reports[this.runs++ % this.reports.length] };
  }
}

const background = { runsBackground: true } as ServerRole;

describe('SearchIndexSweeper (#540)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sweeps a while after start-up, then hourly; a minute later while a backlog is left; hourly after a failure', async () => {
    const sweep = new FakeSweep([
      { complete: false, failed: false },
      { complete: false, failed: true },
      { complete: true },
    ]);
    const sweeper = new SearchIndexSweeper(background, sweep);
    sweeper.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(FIRST_SEARCH_SWEEP_MS);
    expect(sweep.runs).toBe(1);
    // A backlog: again a minute later.
    await vi.advanceTimersByTimeAsync(SEARCH_SWEEP_AGAIN_MS);
    expect(sweep.runs).toBe(2);
    // That one failed: not a minute later, an hour.
    await vi.advanceTimersByTimeAsync(SEARCH_SWEEP_AGAIN_MS);
    expect(sweep.runs).toBe(2);
    await vi.advanceTimersByTimeAsync(SEARCH_SWEEP_EVERY_MS);
    expect(sweep.runs).toBe(3);
    await sweeper.beforeApplicationShutdown();
    await vi.advanceTimersByTimeAsync(2 * SEARCH_SWEEP_EVERY_MS);
    expect(sweep.runs).toBe(3);
  });

  it('never sweeps on a process without background work', async () => {
    const sweep = new FakeSweep([{}]);
    new SearchIndexSweeper(
      { runsBackground: false } as ServerRole,
      sweep,
    ).onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(2 * SEARCH_SWEEP_EVERY_MS);
    expect(sweep.runs).toBe(0);
  });
});
