import { createTestApp, type TestApp } from '../test-app.js';
import { expectWithin } from './budget.js';

/**
 * #27's acceptance criterion: the preview of a module answers in under one
 * second, from a cold start. Run by `api:perf` (`vitest.perf.config.mts`),
 * one file at a time after the other checks, never in the default suite.
 */
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());

const MODULE = '/modules/en/charging/preview';

// Nothing has read the repository yet in this app.
it('previews a module in under one second, from a cold start', async () => {
  const started = performance.now();
  const res = await t.get(`${MODULE}?variant=model=large`);
  const took = performance.now() - started;
  expect(res.status).toBe(200);
  expectWithin('module preview, cold', took, 1000);
  const again = performance.now();
  expect((await t.get(`${MODULE}?variant=model=small`)).status).toBe(200);
  expectWithin(
    'module preview, another variant',
    performance.now() - again,
    1000,
  );
});
