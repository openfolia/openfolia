import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadOnnxModel } from '../src/onnx-model.js';
import { sha256 } from './fixture-model.js';

/**
 * Opt-in: a real model folder (`backend/embedder/README.md`, "Testing with
 * a real model"). Skipped unless `CCMS_EMBEDDER_TEST_MODEL_DIR` and
 * `CCMS_EMBEDDER_TEST_DIMENSIONS` are set, so the default suite never
 * loads a large model.
 */
const dir = process.env['CCMS_EMBEDDER_TEST_MODEL_DIR'];
const dimensions = Number(process.env['CCMS_EMBEDDER_TEST_DIMENSIONS']);

describe.skipIf(!dir || !Number.isInteger(dimensions))('a real model', () => {
  it('puts paraphrases, in one language and across languages, closer than unrelated text', async () => {
    const folder = dir!;
    const model = await loadOnnxModel({
      CCMS_EMBEDDER_DIMENSIONS: dimensions,
      CCMS_EMBEDDER_MODEL_DIR: folder,
      CCMS_EMBEDDER_MODEL_SHA256: sha256(
        await readFile(path.join(folder, 'model.onnx')),
      ),
      CCMS_EMBEDDER_TOKENIZER_SHA256: sha256(
        await readFile(path.join(folder, 'tokenizer.json')),
      ),
      CCMS_EMBEDDER_POOLING: 'mean',
      CCMS_EMBEDDER_PREFIX: process.env['CCMS_EMBEDDER_TEST_PREFIX'] ?? '',
      CCMS_EMBEDDER_MAX_TOKENS: undefined,
      CCMS_EMBEDDER_THREADS: 1,
    });
    try {
      const { vectors } = await model.embed([
        'How do I change the battery?',
        'Replacing the rechargeable battery',
        'Wie wechsle ich den Akku?',
        'The warranty covers two years.',
      ]);
      const [query, paraphrase, german, unrelated] = vectors as [
        Float32Array,
        Float32Array,
        Float32Array,
        Float32Array,
      ];
      const cosine = (a: Float32Array, b: Float32Array) =>
        a.reduce((sum, n, i) => sum + n * b[i]!, 0);
      expect(cosine(query, paraphrase)).toBeGreaterThan(
        cosine(query, unrelated),
      );
      expect(cosine(query, german)).toBeGreaterThan(cosine(query, unrelated));
    } finally {
      await model.close();
    }
  });
});
