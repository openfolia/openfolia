import type {
  AssetRendition,
  NewAssetRendition,
  RenditionWidth,
} from '../../src/assets/core/asset-rendition.js';
import { AssetRenditions } from '../../src/assets/core/asset-renditions.js';
import { ImageResizer } from '../../src/assets/core/image-resizer.js';
import {
  Renditions,
  type RenditionSettings,
} from '../../src/assets/core/renditions.js';
import type { BlobStore } from '../../src/blobs/core/blob-store.js';
import type { Transaction } from '../../src/base/core/unit-of-work.js';
import { FakeAssetUploads } from './fake-asset-uploads.js';
import { fakeOf, FakeUnitOfWork } from './fake-unit-of-work.js';

/** Renditions in memory, with `FakeUnitOfWork`: a change is kept only when its transaction commits. */
export class FakeAssetRenditions extends AssetRenditions {
  readonly renditions: AssetRendition[] = [];
  /** The sources a transaction not yet ended removed the renditions of, which it no longer sees. */
  private readonly removing = new WeakMap<object, Set<string>>();

  async find(
    sourceSha256: string,
    width: RenditionWidth,
  ): Promise<AssetRendition | undefined> {
    return this.renditions.find(
      (r) => r.sourceSha256 === sourceSha256 && r.width === width,
    );
  }

  async record(tx: Transaction, rendition: NewAssetRendition): Promise<void> {
    const transaction = fakeOf(tx);
    transaction.onCommit(() => {
      const at = this.renditions.findIndex(
        (r) =>
          r.sourceSha256 === rendition.sourceSha256 &&
          r.width === rendition.width,
      );
      const recorded = { ...rendition, createdAt: transaction.startedAt };
      if (at >= 0) this.renditions[at] = recorded;
      else this.renditions.push(recorded);
    });
  }

  async removeAllOf(
    tx: Transaction,
    sourceSha256: string,
  ): Promise<AssetRendition[]> {
    const transaction = fakeOf(tx);
    const removed = this.renditions.filter(
      (r) => r.sourceSha256 === sourceSha256,
    );
    const removing = this.removing.get(transaction) ?? new Set<string>();
    removing.add(sourceSha256);
    this.removing.set(transaction, removing);
    transaction.onCommit(() => {
      for (let i = this.renditions.length - 1; i >= 0; i--) {
        if (this.renditions[i]!.sourceSha256 === sourceSha256) {
          this.renditions.splice(i, 1);
        }
      }
    });
    return removed;
  }

  async isRendition(tx: Transaction, sha256: string): Promise<boolean> {
    const removing = this.removing.get(fakeOf(tx));
    return this.renditions.some(
      (r) => r.sha256 === sha256 && !removing?.has(r.sourceSha256),
    );
  }

  async renditionHashes(): Promise<Set<string>> {
    return new Set(this.renditions.map((r) => r.sha256));
  }
}

/** An `ImageResizer` that records its calls and answers bytes naming them. */
export class RecordingImageResizer extends ImageResizer {
  readonly calls: { size: number; width: number }[] = [];
  /** Set: the next calls throw it. */
  failure: Error | undefined;

  async toWebp(source: Uint8Array, width: number): Promise<Uint8Array> {
    this.calls.push({ size: source.byteLength, width });
    if (this.failure) throw this.failure;
    return new TextEncoder().encode(
      `RIFF....WEBP ${width} of ${source.byteLength}`,
    );
  }
}

export const RENDITION_SETTINGS: RenditionSettings = {
  concurrency: 2,
  maxSourceBytes: 50 * 1024 * 1024,
};

/** `Renditions` over fakes; `blobs` is shared with the caller. */
export function fakeRenditions(
  blobs: BlobStore,
  options: {
    renditions?: FakeAssetRenditions;
    resizer?: ImageResizer;
    uploads?: FakeAssetUploads;
    settings?: RenditionSettings;
  } = {},
) {
  const renditions = options.renditions ?? new FakeAssetRenditions();
  const resizer = options.resizer ?? new RecordingImageResizer();
  const service = new Renditions(
    blobs,
    renditions,
    resizer,
    options.uploads ?? new FakeAssetUploads(),
    new FakeUnitOfWork(),
    options.settings ?? RENDITION_SETTINGS,
  );
  return { service, renditions, resizer };
}
