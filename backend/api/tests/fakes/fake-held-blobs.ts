import {
  type BlobHolder,
  HeldBlobs,
} from '../../src/assets/core/held-blobs.js';
import type { Transaction } from '../../src/base/core/unit-of-work.js';
import { fakeOf } from './fake-unit-of-work.js';

/** `HeldBlobs` in memory: imports' bundles in `hashes`, branding images in `branding`. */
export class FakeHeldBlobs extends HeldBlobs {
  readonly hashes = new Set<string>();
  readonly branding = new Set<string>();

  async held(): Promise<{ sha256: string; by: BlobHolder }[]> {
    return [
      ...[...this.hashes].map((sha256) => ({ sha256, by: 'import' as const })),
      ...[...this.branding].map((sha256) => ({
        sha256,
        by: 'branding' as const,
      })),
    ];
  }

  async holds(
    tx: Transaction,
    sha256: string,
    by?: BlobHolder,
  ): Promise<BlobHolder | null> {
    fakeOf(tx);
    if (by !== 'branding' && this.hashes.has(sha256)) return 'import';
    if (by === 'import') return null;
    return this.branding.has(sha256) ? 'branding' : null;
  }
}
