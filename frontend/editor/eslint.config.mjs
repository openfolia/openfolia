import angular from 'angular-eslint';
import baseConfig from '../../eslint.config.mjs';
import openfolia from './eslint-rules/plugin.mjs';
import openfoliaUi from '../ui/eslint-rules/plugin.mjs';

export default [
  ...baseConfig,
  ...angular.configs.tsRecommended.map((config) => ({
    ...config,
    files: ['**/*.ts'],
  })),
  {
    files: ['**/*.ts'],
    processor: angular.processInlineTemplates,
    plugins: { openfolia, 'openfolia-ui': openfoliaUi },
    rules: {
      // A text with a name in it is never shown as HTML: no `innerHTML`, no string dialog
      // `zContent` (frontend/ui/eslint-rules/no-html-text.mjs).
      'openfolia-ui/no-html-text': 'error',
      '@angular-eslint/directive-selector': [
        'error',
        { type: 'attribute', prefix: 'of', style: 'camelCase' },
      ],
      '@angular-eslint/component-selector': [
        'error',
        { type: 'element', prefix: 'of', style: 'kebab-case' },
      ],
      // The app builds screens from `frontend/ui`; it does not copy its components.
      'openfolia/no-ui-duplicates': 'error',
      // The app never reaches into the library's files, or into a Zard component's internals. It
      // imports a folder's entry (`@openfolia/ui/select`), or `@openfolia/ui/startup` for the code that runs
      // before the first screen, never the whole library: a screen that imports `@openfolia/ui` loads
      // every component any screen uses (frontend/ui/README.md, "Entry points").
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@openfolia/ui',
              message:
                "Import from the component's folder ('@openfolia/ui/select'), or from '@openfolia/ui/startup'.",
            },
          ],
          patterns: [
            {
              group: ['@openfolia/ui/*/*', '**/ui/src/**', '**/frontend/ui/**'],
              message:
                "Import from the component's folder ('@openfolia/ui/select'), or from '@openfolia/ui/startup'.",
            },
          ],
        },
      ],
    },
  },
  {
    // A screen imports the content model's types and schema-free helpers from
    // `@openfolia/content-model/core`: the full entry brings zod and yaml (about 540 kB raw) to every screen
    // that reaches it (packages/content-model/README.md, "Entry points"). A file that validates with
    // a schema at run time says so and disables this rule.
    files: ['**/*.ts'],
    ignores: ['**/*.spec.ts', '**/testing/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@openfolia/content-model',
              allowTypeImports: true,
              message:
                "Import from '@openfolia/content-model/core'. Only a file that validates with a schema at run time imports the full entry.",
            },
          ],
        },
      ],
    },
  },
  ...angular.configs.templateRecommended.map((config) => ({
    ...config,
    files: ['**/*.html'],
  })),
  {
    // Templates take their texts from translations (frontend/ui/README.md, "Internationalisation").
    files: ['**/*.html'],
    // index.html's title is the fallback before the app sets the translated one.
    ignores: ['**/*.spec.ts*', 'src/index.html'],
    plugins: { 'openfolia-ui': openfoliaUi },
    rules: {
      // "Aa": the font sample on the theme screen, the same in every language.
      'openfolia-ui/no-literal-text': ['error', { allow: ['Aa'] }],
      // `[innerHTML]` would show a name as markup (frontend/ui/eslint-rules/no-html-text.mjs).
      'openfolia-ui/no-html-text': 'error',
    },
  },
  {
    // A test may build its fixture's DOM from HTML.
    files: ['**/*.spec.ts'],
    rules: { 'openfolia-ui/no-html-text': 'off' },
  },
  { ignores: ['**/out-tsc', 'src/app/api/schema.d.ts'] },
];
