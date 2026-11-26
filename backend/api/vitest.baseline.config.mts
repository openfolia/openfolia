import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';
import base from './vitest.config.mts';
import { DOMAIN_COMPONENTS } from './src/components.ts';

/**
 * `api:test-baseline`: the tests of every component in the baseline migration without the
 * documentation domain (`src/database/baseline.ts`), each on a database the baseline made
 * (`tests/baseline-global-setup.ts`) instead of the committed migrations. A component with
 * tables has its `src/<name>/<name>.schema.ts`.
 */
const src = join(import.meta.dirname, 'src');
const components = readdirSync(src).filter(
  (name) =>
    existsSync(join(src, name, `${name}.schema.ts`)) &&
    !DOMAIN_COMPONENTS.includes(name),
);

export default defineConfig((env) => {
  const config = base(env);
  return {
    ...config,
    cacheDir: '../../node_modules/.vite/backend/api-baseline',
    test: {
      ...config.test,
      name: 'api-baseline',
      globalSetup: ['tests/baseline-global-setup.ts'],
      include: [`src/{${components.join(',')}}/**/*.spec.ts`],
      // Known limit (#979): these adapters outside the domain query the `imports` table (a
      // domain component's), which a baseline without the domain does not make. Their tests are
      // left out here until they no longer name that table.
      exclude: [
        ...configDefaults.exclude,
        'src/assets/repos/drizzle-held-blobs.spec.ts',
        'src/storage-usage/repos/drizzle-storage-usage.spec.ts',
        'src/branding/repos/branding-image-lock.spec.ts',
      ],
    },
  };
});
