import { defineJob } from '../../jobs/core/job.js';
import { z } from 'zod';

/** A text the search index holds, to be embedded once per model. */
export interface PendingText {
  /** SHA-256 hex of `text`. */
  readonly hash: string;
  readonly text: string;
}

/**
 * Port: the texts the Postgres search index holds (a block's title,
 * keywords and text) and their embeddings, by model. Only text that was
 * indexed is here: what a reader searched at a commit they may read.
 */
export abstract class SearchTextStore {
  /**
   * Up to `limit` texts without an embedding of `model` that some indexed
   * document still uses (a text left by a swept document is never sent),
   * by hash, after `after` (`''` from the first): a keyset walk, so a
   * backlog costs one pass, however long.
   */
  abstract pending(
    model: string,
    after: string,
    limit: number,
  ): Promise<PendingText[]>;

  /**
   * Stores embeddings of `model` for the texts still there (one swept
   * meanwhile is left out); one already there is kept. Records that the
   * model is in use (the sweep drops a model's embeddings once none is).
   */
  abstract store(
    model: string,
    embeddings: readonly { hash: string; embedding: readonly number[] }[],
  ): Promise<void>;
}

/**
 * Embeds what the search index holds without an embedding of the
 * configured model (`EmbedSearchTextsAction`): enqueued when a search
 * indexed new text, and at start-up. One at a time per key, so one job
 * works through the backlog; an attempt runs at most an hour.
 */
export const EMBED_SEARCH_TEXTS = defineJob({
  name: 'search.embed',
  payload: z.strictObject({}),
  retryLimit: 5,
  retryDelaySeconds: 60,
  timeoutSeconds: 60 * 60,
  concurrency: 1,
});

/** The key `EMBED_SEARCH_TEXTS` is enqueued under: one job for the whole backlog. */
export const EMBED_SEARCH_TEXTS_KEY = 'pending';
