import baseConfig from '../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    files: ['**/*.json'],
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          // Astro's checker and the browser tests' tools run as commands, not imports; the
          // theme is imported by the stylesheet and the .astro layout, which this lint skips.
          ignoredDependencies: [
            '@openfolia/theme',
            '@astrojs/check',
            'typescript',
            '@playwright/test',
            '@axe-core/playwright',
          ],
          ignoredFiles: [
            '{projectRoot}/eslint.config.{js,cjs,mjs,ts,cts,mts}',
            '{projectRoot}/vitest.config.{js,ts,mjs,mts}',
            '{projectRoot}/tests/**/*',
            '{projectRoot}/e2e/**/*',
          ],
        },
      ],
    },
    languageOptions: {
      parser: await import('jsonc-eslint-parser'),
    },
  },
  {
    ignores: [
      'dist/**',
      'dist-dev/**',
      'dist-fixture/**',
      'dist.next/**',
      '.astro/**',
      '.e2e/**',
      '**/*.astro',
    ],
  },
];
