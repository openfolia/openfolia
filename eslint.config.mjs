import nx from '@nx/eslint-plugin';

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    ignores: ['**/dist', '**/out-tsc', '**/vitest.config.*.timestamp*'],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'],
          depConstraints: [
            // Frontend layering: the app builds on the UI library, which builds on the theme, and on the
            // content model packages.
            {
              sourceTag: 'type:theme',
              onlyDependOnLibsWithTags: ['type:theme'],
            },
            {
              sourceTag: 'type:ui',
              onlyDependOnLibsWithTags: ['type:ui', 'type:theme'],
            },
            {
              sourceTag: 'type:app',
              onlyDependOnLibsWithTags: ['type:ui', 'type:theme', 'type:model'],
            },
            // The content model and its editor schema: framework-free, shared by the API and the
            // editor app, built only on each other.
            {
              sourceTag: 'type:model',
              onlyDependOnLibsWithTags: ['type:model'],
            },
            // Import connectors (#141): optional tools outside the core that produce the documented
            // import format. They build on the content model (and each other) only; the model never
            // depends on one (above), nor does the API's source (backend/api/eslint.config.mjs).
            {
              sourceTag: 'type:connector',
              onlyDependOnLibsWithTags: ['type:model', 'type:connector'],
            },
            {
              sourceTag: '*',
              onlyDependOnLibsWithTags: ['*'],
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      '**/*.ts',
      '**/*.tsx',
      '**/*.cts',
      '**/*.mts',
      '**/*.js',
      '**/*.jsx',
      '**/*.cjs',
      '**/*.mjs',
    ],
    // Override or add rules here
    rules: {},
  },
];
