import type { Actor } from '../../src/access/core/actor.js';
import { actorWith, READER } from '../fakes/actors.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { expectWithin } from './budget.js';

/**
 * #70's acceptance criterion: a search on the sample repository answers in
 * under 300 ms. Run by `api:perf` (`vitest.perf.config.mts`), one file at a
 * time after the other checks, never in the default suite.
 */
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());

const q = (query: string, extra = '') =>
  `/search?filter[q]=${encodeURIComponent(query)}${extra}`;

// Nothing is indexed yet in this app, so every search here is cold. Each run
// is a different index (another commit, or a reader with another scope), so
// each builds its own. The first request of a process, which pays for
// loading code, is left out; the median of the runs must stay under the
// 300 ms of the acceptance criterion; a single run only under a generous
// bound, so one slow run does not fail the check.
it('answers a cold search on the sample repository in under 300 ms (median of several runs)', async () => {
  const readers: [Actor, string][] = [
    [READER, ''],
    [READER, '&ref=v1'],
    [
      {
        ...actorWith(['content.read'], { maxAudience: 'public' }),
        id: 'public-only',
      },
      '',
    ],
    [
      {
        ...actorWith(['content.read'], { languages: ['en', 'de'] }),
        id: 'two-languages',
      },
      '',
    ],
    [
      {
        ...actorWith(['content.read'], { languages: ['en'] }),
        id: 'english',
      },
      '',
    ],
  ];
  t.actAs(READER);
  expect((await t.get('/config')).status).toBe(200);
  const cold: number[] = [];
  for (const [actor, ref] of readers) {
    t.actAs(actor);
    const started = performance.now();
    const res = await t.get(q('charging', ref));
    cold.push(performance.now() - started);
    expect(res.status).toBe(200);
  }
  const median = [...cold].sort((a, b) => a - b)[Math.floor(cold.length / 2)];
  expectWithin('search, cold, median of 5', median ?? Infinity, 300);
  expectWithin('search, cold, slowest of 5', Math.max(...cold), 2000);
  // Warm: the index is there already.
  t.actAs(READER);
  const warmStarted = performance.now();
  expect((await t.get(q('automatically'))).status).toBe(200);
  expectWithin('search, warm', performance.now() - warmStarted, 300);
});
