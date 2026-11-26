/**
 * Writes a baseline migration for a chosen set of components (for a fresh database):
 * `pnpm nx run api:db-baseline -- --out <folder> --components <a,b,…>`, or `--without-domain`
 * for every component with tables but the documentation domain's (`src/components.ts`). A
 * relative `--out` is taken from `backend/api`. `backend/api/README.md`, "Database".
 */
import { parseArgs } from 'node:util';
import {
  BaselineRefused,
  baselineMigration,
  componentsWithoutDomain,
  writeBaseline,
} from './baseline.js';

const USAGE = `Writes a baseline migration for a chosen set of components (for a fresh database).

  db-baseline --out <folder> --components <a,b,...>
  db-baseline --out <folder> --without-domain

  --out             a new or empty folder, outside backend/api/migrations
  --components      components (folders of backend/api/src) whose tables it makes
  --without-domain  every component with tables but the documentation domain's`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    // pnpm and node pass a `--` separator on to the script; nx drops it.
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      out: { type: 'string' },
      components: { type: 'string' },
      'without-domain': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (!values.out || !values.components === !values['without-domain']) {
    throw new BaselineRefused(
      `Give --out, and either --components or --without-domain.\n\n${USAGE}`,
    );
  }
  const components = values['without-domain']
    ? componentsWithoutDomain()
    : values
        .components!.split(',')
        .map((name) => name.trim())
        .filter((name) => name !== '');
  const baseline = await baselineMigration(components);
  const written = await writeBaseline(values.out, baseline);
  console.log(
    `Wrote a baseline of ${baseline.components.join(', ')}:\n${written.map((path) => `  ${path}`).join('\n')}`,
  );
}

main().catch((error: unknown) => {
  // parseArgs' own refusals: an unknown option, a missing value.
  const usage = String((error as { code?: unknown }).code).startsWith(
    'ERR_PARSE_ARGS',
  );
  console.error(
    error instanceof BaselineRefused
      ? error.message
      : usage
        ? `${(error as Error).message}\n\n${USAGE}`
        : error,
  );
  process.exit(1);
});
