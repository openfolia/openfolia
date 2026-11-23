import baseConfig from '../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    files: ['**/*.json'],
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          // react-dom is Next's peer, the @types packages are only read by the compiler. The
          // editor's key caps (`@openfolia/editor`) are one source file the generator imports by path
          // at build time, so the shortcut reference names keys as the editor does.
          ignoredDependencies: [
            'react-dom',
            '@openfolia/editor',
            '@types/mdx',
            '@types/react',
            '@types/react-dom',
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
      '.next/**',
      'out/**',
      'generated/**',
      '.source/**',
      'next-env.d.ts',
    ],
  },
];
