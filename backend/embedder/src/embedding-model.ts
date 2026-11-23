/** The most texts one request may hold: what the API's `HttpEmbedder` sends at most (`MAX_EMBED_BATCH`). */
export const MAX_TEXTS = 32;

/** The most characters of one text: what the API sends at most (`MAX_EMBED_TEXT_LENGTH`). */
export const MAX_TEXT_LENGTH = 4_000;

/**
 * Port: the model that turns texts into vectors. One is loaded once per
 * process (`OnnxEmbeddingModel`); the tests use a fake. `embed` is never
 * called twice at once (the server queues), so an implementation need not
 * guard itself.
 */
export interface EmbeddingModel {
  /** How many numbers each vector has. */
  readonly dimensions: number;
  /**
   * One unit-length vector per text, in order: at most `MAX_TEXTS` texts of
   * at most `MAX_TEXT_LENGTH` characters. `tokens` counts what the model
   * read, after cutting.
   */
  embed(
    texts: readonly string[],
  ): Promise<{ vectors: Float32Array[]; tokens: number }>;
  /** Frees the model. */
  close(): Promise<void>;
}

/** A model that cannot be loaded or answered wrongly, named without the text it was given. */
export class ModelError extends Error {
  override readonly name = 'ModelError';
}
