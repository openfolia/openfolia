import type {
  AssetUpload,
  NewAssetUpload,
} from '../../src/assets/core/asset-upload.js';
import {
  AssetUploads,
  type UploadedFile,
} from '../../src/assets/core/asset-uploads.js';
import type { Transaction } from '../../src/base/core/unit-of-work.js';
import type { ChangeSetAuthor } from '../../src/change-sets/core/change-set.js';
import type { FakeHashLocks } from './fake-hash-locks.js';
import { fakeOf } from './fake-unit-of-work.js';

/**
 * Uploads in memory, with `FakeUnitOfWork`: a record is kept only when its
 * transaction commits. `uploads` holds them oldest first.
 */
export class FakeAssetUploads extends AssetUploads {
  readonly uploads: AssetUpload[] = [];
  /** Records made in transactions not yet ended, which `count` sees as Postgres would. */
  private readonly pending = new WeakMap<object, AssetUpload[]>();
  /** The hashes `lockHash` was asked for, in order. */
  readonly lockedHashes: string[] = [];
  /** When set, `lockHash` holds the hash in it, as Postgres would; else it waits for nothing. */
  locks?: FakeHashLocks;

  async record(
    tx: Transaction,
    upload: NewAssetUpload,
  ): Promise<{ upload: AssetUpload; created: boolean }> {
    const transaction = fakeOf(tx);
    const index = this.uploads.findIndex(
      (u) => u.changeSetId === upload.changeSetId && u.sha256 === upload.sha256,
    );
    const existing = this.uploads[index];
    if (existing) {
      const again = { ...existing, lastUploadedAt: transaction.startedAt };
      transaction.onCommit(() => {
        this.uploads[index] = again;
      });
      return { upload: again, created: false };
    }
    const recorded = {
      ...upload,
      uploadedAt: transaction.startedAt,
      lastUploadedAt: transaction.startedAt,
    };
    const pending = this.pending.get(transaction) ?? [];
    pending.push(recorded);
    this.pending.set(transaction, pending);
    transaction.onCommit(() => this.uploads.push(recorded));
    return { upload: recorded, created: true };
  }

  async lockHash(tx: Transaction, sha256: string): Promise<void> {
    fakeOf(tx);
    this.lockedHashes.push(sha256);
    await this.locks?.lock(tx, [sha256]);
  }

  async lockHashes(tx: Transaction, hashes: readonly string[]): Promise<void> {
    fakeOf(tx);
    this.lockedHashes.push(...[...new Set(hashes)].sort());
    await this.locks?.lock(tx, hashes);
  }

  async recorded(tx: Transaction, sha256: string): Promise<boolean> {
    const own = this.pending.get(fakeOf(tx)) ?? [];
    return [...this.uploads, ...own].some((u) => u.sha256 === sha256);
  }

  async count(
    tx: Transaction,
    changeSetId: string,
    topType?: string,
  ): Promise<number> {
    const own = this.pending.get(fakeOf(tx)) ?? [];
    return [...this.uploads, ...own].filter(
      (u) =>
        u.changeSetId === changeSetId &&
        (topType === undefined || u.contentType.startsWith(`${topType}/`)),
    ).length;
  }

  async find(
    changeSetId: string,
    sha256: string,
  ): Promise<AssetUpload | undefined> {
    return this.uploads.find(
      (u) => u.changeSetId === changeSetId && u.sha256 === sha256,
    );
  }

  async list(changeSetId: string): Promise<AssetUpload[]> {
    return this.uploads
      .filter((u) => u.changeSetId === changeSetId)
      .sort(
        (a, b) =>
          b.lastUploadedAt.getTime() - a.lastUploadedAt.getTime() ||
          (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0),
      );
  }

  async lastUploaded(
    tx: Transaction,
    sha256: string,
  ): Promise<Date | undefined> {
    fakeOf(tx);
    const times = this.uploads
      .filter((u) => u.sha256 === sha256)
      .map((u) => u.lastUploadedAt.getTime());
    return times.length ? new Date(Math.max(...times)) : undefined;
  }

  async removeAllOf(tx: Transaction, sha256: string): Promise<number> {
    const transaction = fakeOf(tx);
    const n = this.uploads.filter((u) => u.sha256 === sha256).length;
    transaction.onCommit(() => {
      for (let i = this.uploads.length - 1; i >= 0; i--) {
        if (this.uploads[i]!.sha256 === sha256) this.uploads.splice(i, 1);
      }
    });
    return n;
  }

  async files(): Promise<UploadedFile[]> {
    const files = new Map<string, UploadedFile>();
    for (const u of this.uploads) {
      const seen = files.get(u.sha256);
      const fileName = seen?.fileName ?? u.fileName;
      files.set(u.sha256, {
        sha256: u.sha256,
        lastUploadedAt:
          seen && seen.lastUploadedAt > u.lastUploadedAt
            ? seen.lastUploadedAt
            : u.lastUploadedAt,
        contentType: seen?.contentType ?? u.contentType,
        ...(fileName !== undefined ? { fileName } : {}),
      });
    }
    return [...files.values()];
  }

  /**
   * The author of each change set, for `uploadedForAuthor`; one not set
   * here counts as written by the upload's uploader (only a change set's
   * author uploads into it).
   */
  readonly authors = new Map<string, ChangeSetAuthor>();

  async uploadedForAuthor(
    author: ChangeSetAuthor,
    hashes: readonly string[],
  ): Promise<string[]> {
    const wanted = new Set(hashes);
    const found = this.uploads.filter((u) => {
      const of = this.authors.get(u.changeSetId) ?? u.uploadedBy;
      return (
        wanted.has(u.sha256) && of.kind === author.kind && of.id === author.id
      );
    });
    return [...new Set(found.map((u) => u.sha256))].sort();
  }

  async uploadedInto(changeSetIds: readonly string[]): Promise<string[]> {
    const ids = new Set(changeSetIds);
    return [
      ...new Set(
        this.uploads.filter((u) => ids.has(u.changeSetId)).map((u) => u.sha256),
      ),
    ];
  }

  /** The hashes marked deleted. */
  readonly deleted = new Set<string>();

  async markDeleted(tx: Transaction, sha256: string): Promise<void> {
    fakeOf(tx).onCommit(() => this.deleted.add(sha256));
  }

  async clearDeleted(tx: Transaction, sha256: string): Promise<void> {
    fakeOf(tx).onCommit(() => this.deleted.delete(sha256));
  }

  async deletedAmong(
    tx: Transaction,
    hashes: readonly string[],
  ): Promise<string[]> {
    fakeOf(tx);
    return hashes.filter((hash) => this.deleted.has(hash)).sort();
  }
}
