import angular from 'angular-eslint';
import baseConfig from '../../eslint.config.mjs';
import openfolia from './eslint-rules/plugin.mjs';

export default [
  ...baseConfig,
  ...angular.configs.tsRecommended.map((config) => ({
    ...config,
    files: ['**/*.ts'],
  })),
  {
    files: ['**/*.ts'],
    processor: angular.processInlineTemplates,
    plugins: { openfolia },
    rules: {
      // A text with a name in it is never shown as HTML (eslint-rules/no-html-text.mjs).
      'openfolia/no-html-text': 'error',
      '@angular-eslint/directive-selector': [
        'error',
        { type: 'attribute', prefix: ['of', 'z'], style: 'camelCase' },
      ],
      '@angular-eslint/component-selector': [
        'error',
        {
          type: ['element', 'attribute'],
          prefix: ['of', 'z'],
          style: 'kebab-case',
        },
      ],
    },
  },
  ...angular.configs.templateRecommended.map((config) => ({
    ...config,
    files: ['**/*.html'],
  })),
  {
    // Templates take their texts from translations (README, "Internationalisation").
    files: ['**/*.html'],
    ignores: ['**/*.spec.ts*'],
    plugins: { openfolia },
    rules: {
      'openfolia/no-literal-text': 'error',
      // `[innerHTML]` would show a name as markup (eslint-rules/no-html-text.mjs).
      'openfolia/no-html-text': 'error',
    },
  },
  {
    // A test may build its fixture's DOM from HTML.
    files: ['**/*.spec.ts'],
    rules: { 'openfolia/no-html-text': 'off' },
  },
  { ignores: ['**/out-tsc'] },
];
