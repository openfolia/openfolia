import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit: `pnpm nx run api:db-generate -- --name <what>` writes a
 * migration for the changes in `src/database/schema.ts` to `migrations/`.
 * Applying them is the API's job (on start, or `api:db-migrate`), not
 * drizzle-kit's, so no connection is configured here.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/schema.ts',
  out: './migrations',
});
