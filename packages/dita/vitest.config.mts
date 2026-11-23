import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/packages/dita',
  test: {
    name: 'dita',
    watch: false,
    globals: true,
    environment: 'node',
    // Fetches the OASIS DITA 1.3 grammar files once, for validating the fixtures (`src/testing/fetch-grammars.ts`).
    globalSetup: ['src/testing/fetch-grammars.ts'],
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
