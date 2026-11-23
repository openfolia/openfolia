import type { Transaction } from '../../base/core/unit-of-work.js';

/**
 * Port: the files releases keep for good (#241), the PDFs of `done`
 * release outputs. Such a file is no unused file of the media library: it
 * is not listed as unused unless an upload records its bytes too (someone
 * attached a release's PDF), and deleting it is refused (409
 * `asset-in-use`, `{ in: "release-output" }`) while no upload does; with
 * uploads, deleting removes them and keeps the file (#429).
 */
export abstract class ArchivedFiles {
  /** The hashes of every archived file, each once. */
  abstract hashes(): Promise<ReadonlySet<string>>;

  /** Whether `sha256` is an archived file, read inside `tx`. */
  abstract has(tx: Transaction, sha256: string): Promise<boolean>;
}
