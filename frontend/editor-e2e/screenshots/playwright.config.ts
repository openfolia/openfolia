import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { SHOTS_DIR } from './global-setup.ts';

/**
 * The user guide's screenshots (README.md, "Screenshots for the user guide"): the built editor on
 * a stack of their own (fresh database, sample content, random ports; never the suite's run
 * folder or log), in light mode, once per UI language. They write WebP files into the docs site
 * (`frontend/docs/public/images/guide/<lang>/`); nothing here is a test of the editor.
 */
// A folder of results per run (the workers inherit the variable), so two runs side by side never
// clear each other's.
process.env['GUIDE_SHOTS_RUN'] ??= String(process.pid);

export default defineConfig({
  testDir: '.',
  testMatch: '*.shots.ts',
  outputDir: join(SHOTS_DIR, 'results', process.env['GUIDE_SHOTS_RUN']),
  globalSetup: './global-setup.ts',
  // One at a time: the shots are few, and the machine is shared.
  workers: 1,
  fullyParallel: false,
  retries: 1,
  forbidOnly: true,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env['E2E_BASE_URL'],
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    reducedMotion: 'reduce',
    timezoneId: 'Europe/Berlin',
    trace: 'retain-on-failure',
    actionTimeout: 20_000,
  },
  projects: [
    { name: 'en', use: { locale: 'en-GB' } },
    { name: 'de', use: { locale: 'de-DE' } },
  ],
});
