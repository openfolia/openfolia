import {
  ConceptEmbedder,
  conceptVector,
} from '../../../../tests/fakes/concept-embedder.js';
import { Embedder, MAX_EMBED_BATCH } from '../embedder.js';
import { type PendingText, SearchTextStore } from '../search-texts.js';
import { EmbedSearchTextsAction } from './embed-search-texts.action.js';

/** Texts by hash, and the embeddings stored, by model and hash. */
class FakeTexts extends SearchTextStore {
  readonly stored = new Map<string, readonly number[]>();
  readonly asked: string[] = [];
  keep = true;
  /** Called once per `pending`, before it answers (a text indexed meanwhile). */
  onPending: () => void = () => undefined;
  constructor(readonly texts: PendingText[]) {
    super();
  }
  pending(model: string, after: string, limit: number): Promise<PendingText[]> {
    this.onPending();
    this.asked.push(after);
    return Promise.resolve(
      this.texts
        .filter(
          ({ hash }) => hash > after && !this.stored.has(`${model}|${hash}`),
        )
        .sort((a, b) => (a.hash < b.hash ? -1 : 1))
        .slice(0, limit),
    );
  }
  store(
    model: string,
    embeddings: readonly { hash: string; embedding: readonly number[] }[],
  ): Promise<void> {
    if (this.keep) {
      for (const { hash, embedding } of embeddings) {
        this.stored.set(`${model}|${hash}`, embedding);
      }
    }
    return Promise.resolve();
  }
}

const texts = (n: number): PendingText[] =>
  Array.from({ length: n }, (_, i) => ({
    hash: i.toString(16).padStart(64, '0'),
    text: `battery ${i}`,
  }));

const signal = () => new AbortController().signal;

/** No embedder configured (as `NoEmbedder`): never asked. */
class NoModel extends Embedder {
  readonly model = undefined;
  readonly dimensions = 0;
  embed(): Promise<number[][]> {
    return Promise.reject(new Error('asked'));
  }
}

describe('EmbedSearchTextsAction', () => {
  it('embeds every pending text a batch at a time, and nothing twice', async () => {
    const store = new FakeTexts(texts(MAX_EMBED_BATCH + 3));
    const embedder = new ConceptEmbedder();
    const action = new EmbedSearchTextsAction(embedder, store);
    expect(await action.handle({ signal: signal() })).toBe(MAX_EMBED_BATCH + 3);
    expect(embedder.asked.map((batch) => batch.length)).toEqual([
      MAX_EMBED_BATCH,
      3,
    ]);
    expect(store.stored.get(`${embedder.model}|${'0'.repeat(64)}`)).toEqual(
      conceptVector('battery 0'),
    );
    expect(await action.handle({ signal: signal() })).toBe(0);
    expect(embedder.asked).toHaveLength(2);
  });

  it('walks the texts by hash, each batch after the last, and once more for text indexed behind the walk', async () => {
    const store = new FakeTexts(texts(MAX_EMBED_BATCH + 3));
    const last = (MAX_EMBED_BATCH - 1).toString(16).padStart(64, '0');
    // While the second batch is asked for, a text sorting first is indexed.
    store.onPending = () => {
      if (store.asked.length === 1) {
        store.texts.push({ hash: '0'.repeat(63) + '!', text: 'late' });
      }
    };
    const embedder = new ConceptEmbedder();
    const action = new EmbedSearchTextsAction(embedder, store);
    expect(await action.handle({ signal: signal() })).toBe(MAX_EMBED_BATCH + 4);
    // One walk (the first batch, the second after its last hash, the end),
    // a second that finds the late text, and a third that finds nothing.
    expect(store.asked.slice(0, 2)).toEqual(['', last]);
    expect(store.asked.filter((after) => after === '')).toHaveLength(3);
    expect(embedder.asked.flat()).toContain('late');
  });

  it('does nothing without an embedder', async () => {
    const store = new FakeTexts(texts(2));
    expect(
      await new EmbedSearchTextsAction(new NoModel(), store).handle({
        signal: signal(),
      }),
    ).toBe(0);
  });

  it('stops when told to, keeps what it stored, and never loops on a text that stays pending', async () => {
    const controller = new AbortController();
    controller.abort();
    const store = new FakeTexts(texts(2));
    const embedder = new ConceptEmbedder();
    await expect(
      new EmbedSearchTextsAction(embedder, store).handle({
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(embedder.asked).toEqual([]);
    store.keep = false;
    await expect(
      new EmbedSearchTextsAction(embedder, store).handle({ signal: signal() }),
    ).rejects.toThrow('still pending');
    expect(embedder.asked).toHaveLength(1);
  });

  it('fails when the embedder fails, so the job retries', async () => {
    const embedder = new ConceptEmbedder();
    embedder.fail = true;
    await expect(
      new EmbedSearchTextsAction(embedder, new FakeTexts(texts(1))).handle({
        signal: signal(),
      }),
    ).rejects.toThrow('down');
  });
});
