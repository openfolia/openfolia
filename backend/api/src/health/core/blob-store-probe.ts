/** Port: whether the blob store answers. */
export abstract class BlobStoreProbe {
  /** Resolves when the store answered in time; rejects otherwise. */
  abstract ping(): Promise<void>;
}
