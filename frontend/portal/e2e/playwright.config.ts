import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const results = join(import.meta.dirname, '..', '.e2e');

/**
 * The portal's browser tests (`pnpm nx run portal:e2e`, part of `pnpm check`): Playwright on the
 * fixture sites `portal:build` made (`dist-fixture/`), the files a deployment serves, each
 * audience's sites on a server of its own (`global-setup.ts`). Every spec runs at desktop and
 * phone width, in light and dark; the checks on the built files run once.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: join(results, 'results'),
  globalSetup: './global-setup.ts',
  fullyParallel: true,
  workers: Number(process.env['E2E_WORKERS']) || 4,
  // One retry, never silent: a test that passes on it is reported as flaky.
  retries: 1,
  forbidOnly: true,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    locale: 'en-GB',
  },
  projects: [
    {
      name: 'desktop-light',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        colorScheme: 'light',
      },
    },
    {
      name: 'desktop-dark',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        colorScheme: 'dark',
      },
    },
    {
      name: 'phone-light',
      use: { ...devices['Pixel 7'], colorScheme: 'light' },
    },
    { name: 'phone-dark', use: { ...devices['Pixel 7'], colorScheme: 'dark' } },
  ],
});
