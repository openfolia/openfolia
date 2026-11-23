import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/packages/content-editor-model',
  test: {
    name: 'content-editor-model',
    watch: false,
    globals: true,
    environment: 'node',
    // Property tests run thousands of cases; on a busy machine that takes longer than the default 5 s.
    testTimeout: 120_000,
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
