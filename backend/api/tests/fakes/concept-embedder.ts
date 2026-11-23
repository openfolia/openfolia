import { Embedder } from '../../src/search/core/embedder.js';

/**
 * Words that mean the same, one group per dimension: a stand-in for a
 * model in tests, so a paraphrase lands near what it paraphrases ("machine
 * won't start" near "drive does not power up") and an unrelated text does
 * not. Matched as word beginnings, case aside.
 */
export const CONCEPTS: readonly (readonly string[])[] = [
  ['start', 'power up', 'power on', 'boot', 'switch on', 'turn on'],
  ['machine', 'drive', 'device', 'unit', 'motor'],
  ['fault', 'error', 'problem', 'trouble', 'fail', 'won’t', "won't", 'not'],
  ['battery', 'charg', 'accumulator', 'cell'],
  ['clean', 'wash', 'wipe'],
  ['cable', 'wire', 'wiring', 'plug', 'harness'],
];

/** A vector of `CONCEPTS.length + 1` dimensions: how often each group's words occur, normalised; the last for a text of none. */
export function conceptVector(text: string): number[] {
  const lower = ` ${text.toLowerCase()}`;
  const vector = CONCEPTS.map((words) =>
    words.reduce(
      (n, word) =>
        n + (lower.split(new RegExp(`[^\\p{L}']${word}`, 'u')).length - 1),
      0,
    ),
  );
  const length = Math.hypot(...vector);
  // A text of no concept: a direction of its own, far from every concept.
  return length === 0 ? [...vector, 1] : [...vector.map((n) => n / length), 0];
}

/** An `Embedder` of `conceptVector`s, counting what it was asked. */
export class ConceptEmbedder extends Embedder {
  readonly model = `concepts@${CONCEPTS.length + 1}`;
  readonly dimensions = CONCEPTS.length + 1;
  readonly asked: string[][] = [];
  fail = false;

  embed(texts: readonly string[]): Promise<number[][]> {
    this.asked.push([...texts]);
    if (this.fail) return Promise.reject(new Error('down'));
    return Promise.resolve(texts.map(conceptVector));
  }
}
