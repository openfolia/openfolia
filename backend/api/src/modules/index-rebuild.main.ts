/**
 * Rebuilds the module index (#45) and the index of where files are used
 * (#476), empties the search index (#54; it is made again as readers
 * search, its texts and embeddings kept and marked unused, so the sweep
 * drops what is not indexed again, #540), and exits:
 * `pnpm nx run api:index-rebuild`; with `-- --drop-embeddings` it drops
 * every embedding too (everything is embedded again). Drops every kept
 * commit index (`module_index_*`, `asset_reference_*`), then indexes the
 * commit of every branch and tag of the content repository again; any
 * other commit is indexed when it is first read. Both are derived from
 * Git alone, so this changes no result, only when the work is done. Reads
 * `CCMS_CONTENT_DIR` and `CCMS_DATABASE_URL` (`.env.example`); applies
 * pending migrations first.
 */
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { DatabaseEnv } from '../config/database-env.js';
import { field, text } from '../config/fields.js';
import { StartupError } from '../config/startup-error.js';
import { AssetReferenceIndex } from '../assets/core/asset-reference-index.js';
import { DrizzleAssetReferenceStore } from '../assets/repos/drizzle-asset-reference-store.js';
import { ToolContentRepo } from '../content/repos/git-content.repo.js';
import { openDatabase } from '../database/open-database.js';
import { ModuleIndex } from './core/module-index.js';
import { DrizzleModuleIndexStore } from './repos/drizzle-module-index-store.js';
import { clearSearchIndex } from '../search/repos/postgres-content-search.js';

async function main(): Promise<void> {
  const { values: flags } = parseArgs({
    options: { 'drop-embeddings': { type: 'boolean', default: false } },
  });
  const dropEmbeddings = flags['drop-embeddings'];
  const settings = DatabaseEnv.omit({ CCMS_DATABASE_MIGRATE: true })
    .extend({ CCMS_CONTENT_DIR: field(text) })
    .safeParse(process.env);
  if (!settings.success) {
    throw new StartupError(
      `Invalid settings (see .env.example):\n${z.prettifyError(settings.error)}`,
    );
  }
  const database = await openDatabase({
    ...settings.data,
    CCMS_DATABASE_MIGRATE: true,
  });
  const content = new ToolContentRepo(settings.data.CCMS_CONTENT_DIR);
  try {
    const index = new ModuleIndex(
      new DrizzleModuleIndexStore(database),
      content,
    );
    const commits = await index.rebuild();
    console.log(
      `Module index rebuilt in ${database.target}: ${commits.length} commit(s) of the branches and tags indexed.`,
    );
    const references = await new AssetReferenceIndex(
      content,
      new DrizzleAssetReferenceStore(database),
    ).rebuild();
    console.log(
      `Index of where files are used rebuilt: ${references.length} commit(s) of the branches and tags indexed.`,
    );
    await clearSearchIndex(database, { dropEmbeddings });
    console.log(
      dropEmbeddings
        ? 'Search index emptied, embeddings dropped: each commit is indexed again when it is first searched, and its text embedded again.'
        : 'Search index emptied: each commit is indexed again when it is first searched (texts and embeddings are kept; what is not indexed again within the grace period is swept).',
    );
  } finally {
    content.close();
    await database.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof StartupError ? error.message : error);
  process.exit(1);
});
