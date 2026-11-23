import { Injectable } from '@nestjs/common';
import type { UnguardedAction } from '../../../access/core/policy.js';
import {
  Embedder,
  EmbedderError,
  MAX_EMBED_BATCH,
  MAX_EMBED_TEXT_LENGTH,
} from '../embedder.js';
import { SearchTextStore } from '../search-texts.js';

/** Walks over the pending texts per run, at most: a text indexed behind the walk is found by the next. */
export const EMBED_PASSES = 3;

/**
 * Embeds every indexed text some document still uses that has no
 * embedding of the configured model yet, a batch at a time, walking the
 * texts by hash (`pending` after the last one), until none is left or
 * `signal` stops it; nothing without an embedder. A walk that embedded
 * something is followed by another from the start (text indexed behind
 * it meanwhile), at most `EMBED_PASSES`. Each batch is stored as it
 * comes, so an attempt cut off keeps what it did, and the next one goes
 * on from there. Only texts the search index holds and uses are sent,
 * never anything else: not a swept draft's, not to a new model.
 *
 * Runs for nobody: the `search.embed` job starts it.
 */
@Injectable()
export class EmbedSearchTextsAction implements UnguardedAction {
  readonly policy = 'internal';

  constructor(
    private readonly embedder: Embedder,
    private readonly texts: SearchTextStore,
  ) {}

  /** How many texts it embedded. */
  async handle({ signal }: { signal: AbortSignal }): Promise<number> {
    const { model } = this.embedder;
    if (model === undefined) return 0;
    let embedded = 0;
    const done = new Set<string>();
    for (let pass = 0; pass < EMBED_PASSES; pass++) {
      const before = embedded;
      await this.#walk(model, signal, done, (n) => (embedded += n));
      if (embedded === before) break;
    }
    return embedded;
  }

  /** One walk over the pending texts by hash, from the first. */
  async #walk(
    model: string,
    signal: AbortSignal,
    done: Set<string>,
    count: (n: number) => void,
  ): Promise<void> {
    let after = '';
    for (;;) {
      signal.throwIfAborted();
      const batch = await this.texts.pending(model, after, MAX_EMBED_BATCH);
      if (batch.length === 0) return;
      // A text stored already and pending again: never loop on it.
      if (batch.some(({ hash }) => done.has(hash))) {
        throw new Error('An embedded text is still pending.');
      }
      const vectors = await this.embedder.embed(
        batch.map(({ text }) => text.slice(0, MAX_EMBED_TEXT_LENGTH)),
        signal,
      );
      if (vectors.length !== batch.length) {
        throw new EmbedderError(
          'The embedder answered the wrong number of vectors.',
        );
      }
      await this.texts.store(
        model,
        batch.map(({ hash }, i) => ({ hash, embedding: vectors[i] ?? [] })),
      );
      for (const { hash } of batch) done.add(hash);
      count(batch.length);
      after = batch.at(-1)?.hash ?? after;
    }
  }
}
