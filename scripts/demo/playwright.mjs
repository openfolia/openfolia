// Playwright for the demo's scripts: the editor's end-to-end suite's own (a pinned dependency
// of `frontend/editor-e2e`), so the demo adds none of its own.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ROOT } from './paths.mjs';

const require = createRequire(join(ROOT, 'frontend/editor-e2e/package.json'));

/** Chromium, as the suite runs it (its headless shell: `pnpm nx run editor-e2e:browsers`). */
export const { chromium } = require('@playwright/test');
