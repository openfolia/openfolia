import baseConfig from '../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
  {
    // Test doubles: no-op loggers and sleeps are the point.
    files: ['__tests__/**/*.ts'],
    rules: { '@typescript-eslint/no-empty-function': 'off' },
  },
];
