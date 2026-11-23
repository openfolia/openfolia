import { ArchivedFiles } from '../../src/assets/core/archived-files.js';
import type { Transaction } from '../../src/base/core/unit-of-work.js';
import { fakeOf } from './fake-unit-of-work.js';

/** `ArchivedFiles` in memory: the archived release PDFs' hashes in `files`. */
export class FakeArchivedFiles extends ArchivedFiles {
  readonly files = new Set<string>();

  async hashes(): Promise<ReadonlySet<string>> {
    return new Set(this.files);
  }

  async has(tx: Transaction, sha256: string): Promise<boolean> {
    fakeOf(tx);
    return this.files.has(sha256);
  }
}
