import baseConfig from '../../eslint.config.mjs';
// The documentation domain's components and the platform's, listed once: the baseline migration
// (`src/database/baseline.ts`) reads them too.
import { DOMAIN_COMPONENTS, PLATFORM_FOLDERS } from './src/components.ts';

const noConnectors = {
  group: ['@openfolia/connector-*', '**/connectors/**'],
  message:
    'The API never imports a connector: connectors produce the import format.',
};

export default [
  ...baseConfig,
  {
    files: ['**/*.json'],
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          // Only its types are imported; at runtime it comes with
          // @nestjs/platform-express. `@openfolia/theme`: its CSS and fonts are
          // read by file at run time, never imported.
          ignoredDependencies: ['express', '@openfolia/theme'],
          ignoredFiles: [
            // The baseline migration command, a development tool: it imports drizzle-kit (a
            // devDependency), which the API itself never does.
            '{projectRoot}/src/database/baseline.ts',
            '{projectRoot}/src/database/baseline.main.ts',
            '{projectRoot}/eslint.config.{js,cjs,mjs,ts,cts,mts}',
            '{projectRoot}/vitest.config.{js,ts,mjs,mts}',
            '{projectRoot}/vitest.perf.config.{js,ts,mjs,mts}',
          ],
        },
      ],
    },
    languageOptions: {
      parser: await import('jsonc-eslint-parser'),
    },
  },
  {
    // Hexagonal layout: core/ (use cases, ports) knows nothing of HTTP,
    // the database or Git; api/ and repos/ depend on it, never the reverse.
    files: ['src/**/core/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            ...[
              'express',
              '@nestjs/swagger',
              '@nestjs/platform-express',
              '@nestjs/config',
              '@openfolia/content-repo',
              '@openfolia/render-typst',
              '@openfolia/render-html',
              'drizzle-orm',
              'pg',
              '@aws-sdk/client-s3',
            ].map((name) => ({
              name,
              message: 'core/ must not depend on frameworks or adapters.',
            })),
            {
              name: '@nestjs/common',
              importNames: [
                'HttpException',
                'BadRequestException',
                'NotFoundException',
                'ConflictException',
                'ForbiddenException',
                'UnauthorizedException',
                'UnprocessableEntityException',
                'ServiceUnavailableException',
                'InternalServerErrorException',
              ],
              message:
                'core/ throws domain errors (base/core/errors.ts); the API maps them to HTTP.',
            },
          ],
          patterns: [
            {
              group: [
                '**/api/*',
                '**/repos/*',
                '**/database/*',
                'drizzle-orm/*',
              ],
              message:
                'core/ must not import from api/, repos/ or the database.',
            },
            {
              // The blob store's adapters (S3) stay in repos/.
              group: ['@aws-sdk/*', '@smithy/*'],
              message: 'core/ must not depend on frameworks or adapters.',
            },
          ],
        },
      ],
    },
  },
  {
    // Import connectors (#141) are optional tools outside the core: the API knows only the
    // import format. Its tests may drive one against the real API (tests/import-connectors.e2e.spec.ts).
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [noConnectors] }],
    },
  },
  {
    // Same rule, so the connector pattern is repeated: a later block replaces its options.
    files: PLATFORM_FOLDERS.map((folder) => `src/${folder}/**/*.ts`),
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            noConnectors,
            {
              group: DOMAIN_COMPONENTS.map((name) => `**/${name}/**`),
              message:
                'The platform imports no component of the documentation domain: each component registers its own types (src/permissions.ts, src/webhook-events.ts, src/audit-actions.ts, src/notification-kinds.ts, src/settings.ts).',
            },
          ],
        },
      ],
    },
  },
  {
    // Third-party files, copied verbatim (tests/iirds/vendor/README.md).
    ignores: ['**/out-tsc', 'tests/iirds/vendor/**', '.cache/**'],
  },
];
