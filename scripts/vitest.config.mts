import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../node_modules/.vite/scripts',
  // As in the tests' imports: `@/scripts/…`, `@/.claude/hooks/…` (the repository root).
  resolve: { alias: { '@': path.resolve(import.meta.dirname, '..') } },
  test: {
    name: 'workflow',
    watch: false,
    environment: 'node',
    // The scripts' tests, and the guard hooks' (in .claude/hooks/, tested from here).
    include: ['__tests__/**/*.test.ts'],
    reporters: ['default'],
  },
}));
