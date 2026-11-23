/** The most texts one `embed` call takes. */
export const MAX_EMBED_BATCH = 32;

/** The most characters of one text sent to an embedder; a longer one is cut (models read only so much anyway). */
export const MAX_EMBED_TEXT_LENGTH = 4_000;

/**
 * Port: turns text into vectors that lie close together when the texts
 * mean the same, for semantic search (#54). Which model makes them is a
 * setting (`CCMS_EMBEDDER_*`): off by default (`NoEmbedder`), so nothing
 * leaves the server and search is full text plus trigram only.
 *
 * Used twice: by the background job that embeds indexed text (cached by
 * the text's hash, so a text is embedded once per model), and in a search
 * request for the query alone.
 */
export abstract class Embedder {
  /**
   * What names the vectors: the model and its dimensions
   * (`<model>@<dimensions>`), so vectors of another model are never
   * compared with these. Undefined: no embedder.
   */
  abstract readonly model: string | undefined;
  /** How many numbers each vector has. */
  abstract readonly dimensions: number;

  /**
   * One vector per text, in order: at most `MAX_EMBED_BATCH` texts, each at
   * most `MAX_EMBED_TEXT_LENGTH` characters. Throws `EmbedderError` when
   * the model cannot be reached, answers an error, or answers vectors of
   * the wrong count or size.
   */
  abstract embed(
    texts: readonly string[],
    signal: AbortSignal,
  ): Promise<number[][]>;
}

/** A failure of the embedder, named without its address, its key, the text or the answer. */
export class EmbedderError extends Error {
  override readonly name = 'EmbedderError';
}
