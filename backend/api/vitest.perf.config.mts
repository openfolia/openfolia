import { defineConfig } from 'vitest/config';
import base from './vitest.config.mjs';

/**
 * The speed criteria (`tests/perf/*.perf.ts`), apart from the default suite
 * so a busy machine never fails `api:test` on wall-clock time. `api:perf`
 * runs them after the other checks of `pnpm check`, one file at a time in
 * one worker, so they don't compete with each other or with the suite.
 */
export default defineConfig((env) => {
  const config = base(env);
  // Spread, not mergeConfig: that would append to `include`, not replace it.
  return {
    ...config,
    test: {
      ...config.test,
      name: 'api-perf',
      include: ['tests/perf/**/*.perf.ts'],
      maxWorkers: 1,
      fileParallelism: false,
    },
  };
});
