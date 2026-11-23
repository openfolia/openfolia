import {
  paginate,
  type PageRequest,
  type Paginated,
} from '../../src/base/core/paging.js';
import type { Transaction } from '../../src/base/core/unit-of-work.js';
import {
  type Branding,
  type BrandingImage,
  DEFAULT_BRANDING,
  type StoredBranding,
} from '../../src/branding/core/branding.js';
import { BrandingStore } from '../../src/branding/core/branding-store.js';
import { fakeOf } from './fake-unit-of-work.js';

/** `BrandingStore` in memory, with `FakeUnitOfWork`: writes apply when the transaction commits. */
export class FakeBrandingStore extends BrandingStore {
  stored: StoredBranding = {
    branding: DEFAULT_BRANDING,
    version: 0,
    updatedAt: null,
  };
  readonly images = new Map<string, BrandingImage>();
  /** How many times `lock` was taken. */
  locks = 0;

  async read(): Promise<StoredBranding> {
    return this.stored;
  }

  async lock(tx: Transaction): Promise<StoredBranding> {
    fakeOf(tx);
    this.locks++;
    return this.stored;
  }

  async write(tx: Transaction, branding: Branding): Promise<StoredBranding> {
    const next: StoredBranding = {
      branding,
      version: this.stored.version + 1,
      updatedAt: fakeOf(tx).startedAt,
    };
    fakeOf(tx).onCommit(() => (this.stored = next));
    return next;
  }

  async findImage(sha256: string): Promise<BrandingImage | undefined> {
    return this.images.get(sha256);
  }

  async countImages({
    inUse,
    since,
  }: {
    inUse: ReadonlySet<string>;
    since: Date;
  }): Promise<number> {
    return [...this.images.values()].filter(
      (image) => image.uploadedAt > since || inUse.has(image.sha256),
    ).length;
  }

  async listImages(page: PageRequest): Promise<Paginated<BrandingImage>> {
    const all = [...this.images.values()].sort(
      (a, b) =>
        b.uploadedAt.getTime() - a.uploadedAt.getTime() ||
        a.sha256.localeCompare(b.sha256),
    );
    return paginate(all, page);
  }

  async unusedImages(
    inUse: ReadonlySet<string>,
    before: Date,
    limit: number,
  ): Promise<BrandingImage[]> {
    return [...this.images.values()]
      .filter((image) => image.uploadedAt <= before && !inUse.has(image.sha256))
      .sort(
        (a, b) =>
          a.uploadedAt.getTime() - b.uploadedAt.getTime() ||
          a.sha256.localeCompare(b.sha256),
      )
      .slice(0, limit);
  }

  async touchImage(
    tx: Transaction,
    sha256: string,
  ): Promise<BrandingImage | undefined> {
    const image = this.images.get(sha256);
    if (!image) return undefined;
    const touched = { ...image, uploadedAt: fakeOf(tx).startedAt };
    fakeOf(tx).onCommit(() => this.images.set(sha256, touched));
    return touched;
  }

  async removeImage(tx: Transaction, sha256: string): Promise<boolean> {
    const had = this.images.has(sha256);
    fakeOf(tx).onCommit(() => this.images.delete(sha256));
    return had;
  }

  async recordImage(
    tx: Transaction,
    image: BrandingImage,
  ): Promise<{ image: BrandingImage; created: boolean }> {
    const existing = this.images.get(image.sha256);
    if (existing) return { image: existing, created: false };
    fakeOf(tx).onCommit(() => this.images.set(image.sha256, image));
    return { image, created: true };
  }
}
