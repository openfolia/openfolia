import { Embedder } from '../core/embedder.js';

/** No embedder (the default): no semantic search, nothing is sent anywhere. */
export class NoEmbedder extends Embedder {
  readonly model = undefined;
  readonly dimensions = 0;

  embed(): Promise<number[][]> {
    return Promise.reject(new Error('No embedder is configured.'));
  }
}
