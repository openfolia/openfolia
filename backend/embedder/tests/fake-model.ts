import type { EmbeddingModel } from '../src/embedding-model.js';

/**
 * A model without a runtime: each text's vector is its length and its
 * first character's code, so a test can tell which text a vector belongs
 * to. `gate` holds every run until it resolves; `calls` records the texts.
 */
export class FakeModel implements EmbeddingModel {
  readonly calls: string[][] = [];
  gate: Promise<void> = Promise.resolve();
  failWith: Error | undefined;
  answer: ((texts: readonly string[]) => Float32Array[]) | undefined;

  constructor(readonly dimensions = 3) {}

  async embed(
    texts: readonly string[],
  ): Promise<{ vectors: Float32Array[]; tokens: number }> {
    this.calls.push([...texts]);
    await this.gate;
    if (this.failWith) throw this.failWith;
    const vectors =
      this.answer?.(texts) ??
      texts.map((text) => {
        const vector = new Float32Array(this.dimensions);
        vector[0] = text.length;
        vector[1] = text.codePointAt(0) ?? 0;
        return vector;
      });
    return { vectors, tokens: texts.length * 2 };
  }

  async close(): Promise<void> {
    this.calls.length = 0;
  }
}
