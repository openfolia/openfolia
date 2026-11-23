import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

import { VALIDATOR_DIR } from './tests/iirds/fetch-validator.js';

const iirdsValidator = `${VALIDATOR_DIR}/src`;

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/backend/api',
  // Nest's dependency injection reads constructor types from decorator
  // metadata, which esbuild (Vitest's default) does not emit; SWC does.
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  // The official iiRDS validator's rules (fetched when the tests start,
  // `tests/iirds/fetch-validator.ts`) import with the tool's own `@/` alias and `jsonld` (for an iiRDS/H rule
  // these tests never run).
  resolve: {
    alias: [
      { find: /^@\/(.*)$/, replacement: `${iirdsValidator}/$1` },
      {
        find: /^jsonld$/,
        replacement: `${import.meta.dirname}/tests/iirds/jsonld-stub.ts`,
      },
    ],
  },
  test: {
    name: 'api',
    watch: false,
    globals: true,
    environment: 'node',
    // Migrates one PGlite database that every test database is copied from.
    // And fetches the iiRDS validator's rules once (`tests/iirds/fetch-validator.ts`).
    globalSetup: ['tests/global-setup.ts', 'tests/iirds/fetch-validator.ts'],
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    // Timing, not behaviour: on a machine running several checks at once
    // (load far above the core count) a migrated PGlite app takes seconds
    // to start and a request can wait seconds for a CPU. Generous bounds,
    // so a busy machine slows the suite down instead of failing it; a hung
    // test still fails. A file or test that needs more says so itself.
    hookTimeout: 30_000,
    testTimeout: 30_000,
    // Each worker holds its own PGlite databases and app (about 1 GB);
    // a quarter of the cores keeps one run from starving the machine and
    // the slots running checks next to it. Speed criteria are not in this
    // suite: `vitest.perf.config.mts` (`api:perf`).
    maxWorkers: '25%',
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
