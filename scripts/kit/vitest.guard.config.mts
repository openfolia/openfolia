import path from 'node:path';
import { defineConfig } from 'vitest/config';

// The guard's tests (scripts/__tests__/claude-hooks.test.ts, as they are) run on an installed
// copy of the kit (scripts/kit/smoke.mjs sets KIT_GUARD_ROOT): `@/.claude/hooks/…` resolves to
// that repository's hooks, so every case its decide() pins is decided by the kit's copy. (Its
// two tests that spawn pre-tool-use.mjs and post-tool-use.mjs as processes run this
// repository's files, byte for byte the copy's.)
const root = process.env.KIT_GUARD_ROOT;
if (!root)
  throw new Error('KIT_GUARD_ROOT names no installed copy of the kit.');

export default defineConfig(() => ({
  root: path.resolve(import.meta.dirname, '..'),
  cacheDir: '../node_modules/.vite/scripts-kit-guard',
  resolve: { alias: { '@': path.resolve(root) } },
  test: {
    name: 'workflow-kit-guard',
    watch: false,
    environment: 'node',
    include: ['__tests__/claude-hooks.test.ts'],
    reporters: ['dot'],
  },
}));
