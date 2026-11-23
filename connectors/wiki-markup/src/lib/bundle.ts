import {
  IMPORT_ASSETS_FOLDER,
  IMPORT_DOCUMENT_PATH,
  type ImportDocument,
} from '@openfolia/content-model';
import { zipSync } from 'fflate';

/** What a bundle is made of: its document and the files it uses, by `sha256:<hash>`. */
export interface BundleParts {
  readonly document: ImportDocument;
  readonly assets: ReadonlyMap<string, Uint8Array>;
}

/** The bundle's files by path: `import.json` and `assets/<sha256>`, as `validateImport` reads them. */
export function bundleFiles({
  document,
  assets,
}: BundleParts): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  files.set(
    IMPORT_DOCUMENT_PATH,
    new TextEncoder().encode(JSON.stringify(document, null, 2)),
  );
  for (const [ref, bytes] of assets) {
    files.set(`${IMPORT_ASSETS_FOLDER}${ref.slice('sha256:'.length)}`, bytes);
  }
  return files;
}

/** The bundle as a ZIP archive, ready for `POST /imports` (importer `bundle`) or the import screen. */
export function zipBundle(parts: BundleParts): Uint8Array {
  return zipFiles(bundleFiles(parts));
}

/** A bundle's files (`bundleFiles`) as a ZIP archive. */
export function zipFiles(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, bytes] of files) entries[path] = bytes;
  // A fixed time stamp: the same bundle gives the same bytes.
  return zipSync(entries, { mtime: new Date('2000-01-01T00:00:00Z') });
}
