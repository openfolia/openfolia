import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ContentRepo } from '@openfolia/content-repo';
import { sniffImageType } from '../../assets/core/sniff-image-type.js';
import type { BlobStore } from '../core/blob-store.js';

/** Larger files under `assets/` are left in Git (and reported). */
export const IMPORT_MAX_BYTES = 256 * 1024 * 1024;

export interface ImportReport {
  /** Hashes put into the store (already there: counted too, a put is a no-op then). */
  imported: string[];
  /** `assets/` files left alone, with why: a name that is not their hash, or too large. */
  skipped: { path: string; reason: string }[];
}

/**
 * The one-off move of images from the repository's `assets/<sha256>` into
 * the blob store: every file under `assets/` at the head of every branch
 * and tag, each once, with its type sniffed from its bytes. Git is not
 * changed (the reader still falls back to it), so this can run again at
 * any time; a file whose name is not the SHA-256 of its bytes is skipped.
 */
export async function importGitAssets(
  repo: ContentRepo,
  blobs: BlobStore,
): Promise<ImportReport> {
  const { branches, tags } = await repo.git.refs();
  const commits = new Set([...branches, ...tags].map((ref) => ref.commit));
  const seen = new Set<string>();
  const report: ImportReport = { imported: [], skipped: [] };
  for (const commit of commits) {
    for (const path of await repo.git.listFiles(commit, 'assets')) {
      if (seen.has(path)) continue;
      seen.add(path);
      const data = await repo.git.readFile(commit, path);
      if (!data) continue;
      const name = path.slice('assets/'.length);
      if (createHash('sha256').update(data).digest('hex') !== name) {
        report.skipped.push({ path, reason: 'not named by its SHA-256' });
        continue;
      }
      if (data.byteLength > IMPORT_MAX_BYTES) {
        report.skipped.push({ path, reason: 'too large' });
        continue;
      }
      const { sha256 } = await blobs.put(Readable.from([data]), {
        contentType: sniffImageType(data),
        maxBytes: IMPORT_MAX_BYTES,
      });
      report.imported.push(sha256);
    }
  }
  return report;
}
