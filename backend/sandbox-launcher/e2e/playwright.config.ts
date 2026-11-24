import { defineConfig, devices } from '@playwright/test';

/**
 * The start page in a real browser (README.md, "Tests"): the launcher in the test's own process on
 * fake sandboxes (tests/fakes.ts), so no container runtime is needed. The run against real
 * containers is deploy/launcher-test.sh.
 */
export default defineConfig({
  testDir: '.',
  outputDir: '../dist/e2e-results',
  fullyParallel: false,
  workers: 1,
  retries: 1,
  forbidOnly: true,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    locale: 'en-GB',
    trace: 'retain-on-failure',
  },
});
