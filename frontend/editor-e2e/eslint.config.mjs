import baseConfig from '../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
  {
    // Playwright fixtures that need no other fixture take `{}` (its documented form).
    files: ['src/fixtures.ts'],
    rules: { 'no-empty-pattern': 'off' },
  },
];
