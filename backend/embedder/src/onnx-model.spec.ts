import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FIXTURE_DIMENSIONS,
  writeFixtureModel,
  type Fixture,
} from '../tests/fixture-model.js';
import { MAX_TEXT_LENGTH, ModelError } from './embedding-model.js';
import { loadOnnxModel, type OnnxEmbeddingModel } from './onnx-model.js';
import type { EmbedderSettings } from './settings.js';

let root: string;
let fixture: Fixture;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'embedder-model-'));
  fixture = await writeFixtureModel(path.join(root, 'plain'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function settings(
  of: Fixture,
  more: Partial<EmbedderSettings> = {},
): Parameters<typeof loadOnnxModel>[0] {
  return {
    CCMS_EMBEDDER_DIMENSIONS: FIXTURE_DIMENSIONS,
    CCMS_EMBEDDER_MODEL_DIR: of.dir,
    CCMS_EMBEDDER_MODEL_SHA256: of.modelSha256,
    CCMS_EMBEDDER_TOKENIZER_SHA256: of.tokenizerSha256,
    CCMS_EMBEDDER_POOLING: 'mean',
    CCMS_EMBEDDER_PREFIX: '',
    CCMS_EMBEDDER_MAX_TOKENS: undefined,
    CCMS_EMBEDDER_THREADS: 1,
    ...more,
  };
}

const cosine = (a: Float32Array, b: Float32Array) =>
  a.reduce((sum, n, i) => sum + n * b[i]!, 0);

async function withModel<T>(
  of: Fixture,
  more: Partial<EmbedderSettings>,
  use: (model: OnnxEmbeddingModel) => Promise<T>,
): Promise<T> {
  const model = await loadOnnxModel(settings(of, more));
  try {
    return await use(model);
  } finally {
    await model.close();
  }
}

describe('OnnxEmbeddingModel on the ONNX Runtime', () => {
  it('embeds texts as unit vectors that lie close when the words mean the same', async () => {
    await withModel(fixture, {}, async (model) => {
      const { vectors, tokens } = await model.embed([
        'Replace the cell',
        'change the battery',
        'sunny weather',
      ]);
      expect(vectors).toHaveLength(3);
      for (const vector of vectors) {
        expect(vector).toHaveLength(FIXTURE_DIMENSIONS);
        expect(Math.hypot(...vector)).toBeCloseTo(1, 5);
      }
      expect(cosine(vectors[0]!, vectors[1]!)).toBeGreaterThan(0.9);
      expect(cosine(vectors[0]!, vectors[2]!)).toBeLessThan(0.3);
      // [CLS] and [SEP] around each: 5 + 5 + 4.
      expect(tokens).toBe(14);
    });
  });

  it('gives a text the same vector alone as beside longer ones (padding is not pooled)', async () => {
    await withModel(fixture, {}, async (model) => {
      const alone = (await model.embed(['battery'])).vectors[0]!;
      const { vectors } = await model.embed([
        'the battery the cell the battery the cell',
        'battery',
        'sunny',
      ]);
      expect(Array.from(vectors[1]!)).toEqual(Array.from(alone));
    });
  });

  it('keeps the order of the texts across groups of different lengths', async () => {
    await withModel(fixture, {}, async (model) => {
      const texts = Array.from({ length: 32 }, (_, i) =>
        i % 2 === 0 ? 'sunny weather '.repeat(1 + (i % 7)) : 'battery',
      );
      const { vectors } = await model.embed(texts);
      vectors.forEach((vector, i) => {
        const expected = i % 2 === 0 ? 1 : 0; // weather's axis, or battery's
        const axis = vector.indexOf(Math.max(...vector));
        expect(axis).toBe(expected);
      });
    });
  });

  it('cuts a text at CCMS_EMBEDDER_MAX_TOKENS, keeping the closing token', async () => {
    await withModel(fixture, { CCMS_EMBEDDER_MAX_TOKENS: 8 }, async (model) => {
      const long = 'battery '.repeat(3) + 'weather '.repeat(50);
      const { tokens, vectors } = await model.embed([long]);
      expect(tokens).toBe(8);
      // [CLS] battery×3 weather×3 [SEP]: as much weather as battery.
      expect(vectors[0]![0]).toBeCloseTo(vectors[0]![1]!, 5);
    });
  });

  it("cuts at the tokenizer's own truncation length when the setting is unset", async () => {
    const truncated = await writeFixtureModel(path.join(root, 'truncated'), {
      truncation: 4,
    });
    await withModel(truncated, {}, async (model) => {
      expect((await model.embed(['battery cell sunny weather'])).tokens).toBe(
        4,
      );
    });
  });

  it('puts CCMS_EMBEDDER_PREFIX before each text', async () => {
    await withModel(
      fixture,
      { CCMS_EMBEDDER_PREFIX: 'weather ' },
      async (model) => {
        const { vectors, tokens } = await model.embed(['battery']);
        expect(tokens).toBe(4);
        expect(vectors[0]![0]).toBeCloseTo(vectors[0]![1]!, 5);
      },
    );
  });

  it('pools by the first token with CCMS_EMBEDDER_POOLING=cls', async () => {
    await withModel(
      fixture,
      { CCMS_EMBEDDER_POOLING: 'cls' },
      async (model) => {
        // [CLS]'s row is zero: so is the vector.
        const { vectors } = await model.embed(['battery']);
        expect(Array.from(vectors[0]!)).toEqual([0, 0, 0, 0]);
      },
    );
  });

  it('feeds token_type_ids to a model that takes them', async () => {
    const typed = await writeFixtureModel(path.join(root, 'typed'), {
      extraInputs: ['attention_mask', 'token_type_ids'],
    });
    await withModel(typed, {}, async (model) => {
      expect((await model.embed(['battery'])).vectors[0]![0]).toBeCloseTo(1, 5);
    });
  });

  it('refuses more text than a request may hold', async () => {
    await withModel(fixture, {}, async (model) => {
      await expect(model.embed(Array(33).fill('battery'))).rejects.toThrow(
        ModelError,
      );
      await expect(
        model.embed(['a'.repeat(MAX_TEXT_LENGTH + 1)]),
      ).rejects.toThrow(ModelError);
    });
  });
});

describe('loading a model folder', () => {
  it('refuses a model file whose SHA-256 is not the pinned one', async () => {
    await expect(
      loadOnnxModel(
        settings(fixture, { CCMS_EMBEDDER_MODEL_SHA256: '0'.repeat(64) }),
      ),
    ).rejects.toThrow(
      /model\.onnx has the SHA-256 .* CCMS_EMBEDDER_MODEL_SHA256 pins: refused/,
    );
  });

  it('refuses a tokenizer whose SHA-256 is not the pinned one', async () => {
    await expect(
      loadOnnxModel(
        settings(fixture, { CCMS_EMBEDDER_TOKENIZER_SHA256: 'a'.repeat(64) }),
      ),
    ).rejects.toThrow(/tokenizer\.json .* CCMS_EMBEDDER_TOKENIZER_SHA256/);
  });

  it('refuses a folder without the files', async () => {
    await expect(
      loadOnnxModel(settings({ ...fixture, dir: path.join(root, 'missing') })),
    ).rejects.toThrow(/model\.onnx cannot be read/);
  });

  it('refuses a model whose vectors are not CCMS_EMBEDDER_DIMENSIONS long', async () => {
    await expect(
      loadOnnxModel(settings(fixture, { CCMS_EMBEDDER_DIMENSIONS: 384 })),
    ).rejects.toThrow(/4 numbers, CCMS_EMBEDDER_DIMENSIONS says 384/);
  });

  it('refuses a model taking an input it cannot give', async () => {
    const odd = await writeFixtureModel(path.join(root, 'odd'), {
      extraInputs: ['pixel_values'],
    });
    await expect(loadOnnxModel(settings(odd))).rejects.toThrow(
      /an input this worker cannot give \(pixel_values\)/,
    );
  });

  it('refuses a file that is no ONNX model (its pin matching)', async () => {
    const dir = path.join(root, 'broken');
    const broken = await writeFixtureModel(dir);
    const junk = Buffer.from('not a model');
    await writeFile(path.join(dir, 'model.onnx'), junk);
    const { sha256 } = await import('../tests/fixture-model.js');
    await expect(
      loadOnnxModel(settings({ ...broken, modelSha256: sha256(junk) })),
    ).rejects.toThrow(/no ONNX model this worker can run/);
  });
});
