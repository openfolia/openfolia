import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { ISOLATED_SPECS as ISOLATED } from './isolated.ts';
import { E2E_DIR } from './stack/stack.ts';

/**
 * The editor's real-browser suite (README.md). `globalSetup` starts the stack (the built API on
 * a fresh database and sample content, the built editor) and hands its addresses to the workers
 * through the environment, which is why `baseURL` is read here: the workers load this file
 * after the setup ran.
 */
export default defineConfig({
  testDir: './specs',
  outputDir: join(E2E_DIR, 'results'),
  globalSetup: './stack/global-setup.ts',
  fullyParallel: true,
  workers: Number(process.env['E2E_WORKERS']) || 4,
  // One retry, never silent: a test that passes on it is listed as flaky in the summary.
  retries: 1,
  forbidOnly: true,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: join(E2E_DIR, 'report'), open: 'never' }],
    ['./src/summary-reporter.ts'],
  ],
  use: {
    baseURL: process.env['E2E_BASE_URL'],
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    locale: 'en-GB',
    timezoneId: 'Europe/Berlin',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'desktop',
      testIgnore: ISOLATED,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      // Only the flows tagged @narrow: layout at phone width.
      name: 'narrow',
      grep: /@narrow/,
      testIgnore: ISOLATED,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: false,
      },
    },
    {
      // Starts once `desktop` and `narrow` are done, so nothing else runs meanwhile, and on one
      // worker, so one test at a time. `mode: 'serial'` alone orders a file's tests but not
      // the files, nor the copies `--repeat-each` makes: each ran on a worker of its own, beside
      // the others, and one copy's `afterEach` put the setting back while another read it (#724).
      name: 'isolated',
      testMatch: ISOLATED,
      dependencies: ['desktop', 'narrow'],
      workers: 1,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
});
