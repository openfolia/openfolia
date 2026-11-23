/**
 * Moves the content repository's images (`assets/<sha256>`, the old
 * layout) into the blob store and exits: `pnpm nx run api:blobs-import`.
 * Reads `CCMS_CONTENT_DIR` and the blob store's settings (`.env.example`);
 * changes nothing in Git, so it can run again (`importGitAssets`).
 */
import { ContentRepo } from '@openfolia/content-repo';
import { z } from 'zod';
import { BlobEnv, checkBlobEnv } from '../config/blob-env.js';
import { field, text } from '../config/fields.js';
import { StartupError } from '../config/startup-error.js';
import { blobStoreFrom } from './repos/blob-store-from.js';
import { importGitAssets } from './repos/import-git-assets.js';

async function main(): Promise<void> {
  const settings = BlobEnv.extend({ CCMS_CONTENT_DIR: field(text) })
    .superRefine(checkBlobEnv)
    .safeParse(process.env);
  if (!settings.success) {
    throw new StartupError(
      `Invalid settings (see .env.example):\n${z.prettifyError(settings.error)}`,
    );
  }
  const repo = ContentRepo.open(settings.data.CCMS_CONTENT_DIR);
  try {
    const { imported, skipped } = await importGitAssets(
      repo,
      blobStoreFrom(settings.data),
    );
    console.log(
      `Blob store: ${imported.length} image(s) from assets/ stored (already stored ones count too).`,
    );
    for (const { path, reason } of skipped) {
      console.log(`Left in Git: ${path} (${reason})`);
    }
  } finally {
    repo.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof StartupError ? error.message : error);
  process.exit(1);
});
