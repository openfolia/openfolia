import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Tokenizer } from '@huggingface/tokenizers';
import type { InferenceSession, Tensor } from 'onnxruntime-node';
import {
  type EmbeddingModel,
  MAX_TEXT_LENGTH,
  MAX_TEXTS,
  ModelError,
} from './embedding-model.js';
import { MAX_BATCH_TOKENS, planBatches, poolRows } from './pooling.js';
import { DEFAULT_MAX_TOKENS, type EmbedderSettings } from './settings.js';

/** The files of a model folder (`CCMS_EMBEDDER_MODEL_DIR`). */
export const MODEL_FILE = 'model.onnx';
export const TOKENIZER_FILE = 'tokenizer.json';

/** The inputs a model may take; any other is refused as it loads. */
const INPUT_IDS = 'input_ids';
const ATTENTION_MASK = 'attention_mask';
const TOKEN_TYPE_IDS = 'token_type_ids';
const KNOWN_INPUTS = new Set([INPUT_IDS, ATTENTION_MASK, TOKEN_TYPE_IDS]);

/** The output used, the first a model has: one vector per text, or one per token. */
const OUTPUTS = ['sentence_embedding', 'last_hidden_state'];

type OnnxRuntime = typeof import('onnxruntime-node');

type ModelSettings = Pick<
  EmbedderSettings,
  | 'CCMS_EMBEDDER_DIMENSIONS'
  | 'CCMS_EMBEDDER_MODEL_DIR'
  | 'CCMS_EMBEDDER_MODEL_SHA256'
  | 'CCMS_EMBEDDER_TOKENIZER_SHA256'
  | 'CCMS_EMBEDDER_POOLING'
  | 'CCMS_EMBEDDER_PREFIX'
  | 'CCMS_EMBEDDER_MAX_TOKENS'
  | 'CCMS_EMBEDDER_THREADS'
>;

/**
 * Loads the model folder: `model.onnx` and `tokenizer.json`, each checked
 * against its pinned SHA-256 before anything reads it (the bytes checked
 * are the bytes loaded). On the CPU only, never a GPU provider; nothing is
 * fetched. Then embeds one text, so a model whose vectors are not
 * `CCMS_EMBEDDER_DIMENSIONS` long stops the start.
 */
export async function loadOnnxModel(
  settings: ModelSettings,
  runtime?: OnnxRuntime,
): Promise<OnnxEmbeddingModel> {
  const dir = settings.CCMS_EMBEDDER_MODEL_DIR;
  const modelBytes = await pinned(
    path.join(dir, MODEL_FILE),
    settings.CCMS_EMBEDDER_MODEL_SHA256,
    'CCMS_EMBEDDER_MODEL_SHA256',
  );
  const tokenizerBytes = await pinned(
    path.join(dir, TOKENIZER_FILE),
    settings.CCMS_EMBEDDER_TOKENIZER_SHA256,
    'CCMS_EMBEDDER_TOKENIZER_SHA256',
  );
  let tokenizerJson: TokenizerJson;
  let tokenizer: Tokenizer;
  try {
    tokenizerJson = JSON.parse(
      tokenizerBytes.toString('utf8'),
    ) as TokenizerJson;
    tokenizer = new Tokenizer(tokenizerJson, {});
  } catch {
    throw new ModelError(
      `${TOKENIZER_FILE} is no tokenizer this worker reads.`,
    );
  }
  const ort = runtime ?? (await import('onnxruntime-node'));
  let session: InferenceSession;
  try {
    session = await ort.InferenceSession.create(modelBytes, {
      executionProviders: ['cpu'],
      intraOpNumThreads: settings.CCMS_EMBEDDER_THREADS,
      interOpNumThreads: 1,
      executionMode: 'sequential',
      graphOptimizationLevel: 'all',
      logSeverityLevel: 3,
    });
  } catch {
    throw new ModelError(`${MODEL_FILE} is no ONNX model this worker can run.`);
  }
  const model = new OnnxEmbeddingModel(ort, session, tokenizer, {
    dimensions: settings.CCMS_EMBEDDER_DIMENSIONS,
    pooling: settings.CCMS_EMBEDDER_POOLING,
    prefix: settings.CCMS_EMBEDDER_PREFIX,
    maxTokens:
      settings.CCMS_EMBEDDER_MAX_TOKENS ??
      positive(tokenizerJson.truncation?.max_length) ??
      DEFAULT_MAX_TOKENS,
    padId: padIdOf(tokenizerJson, tokenizer),
  });
  try {
    await model.embed(['ok']);
  } catch (error) {
    await session.release().catch(() => undefined);
    throw error;
  }
  return model;
}

/** What this worker reads of a `tokenizer.json` besides what the tokenizer reads. */
interface TokenizerJson {
  truncation?: { max_length?: unknown } | null;
  padding?: { pad_id?: unknown } | null;
}

interface Options {
  readonly dimensions: number;
  readonly pooling: 'mean' | 'cls';
  readonly prefix: string;
  readonly maxTokens: number;
  readonly padId: number;
}

/**
 * A sentence-embedding model on ONNX Runtime: tokenized, cut at
 * `maxTokens` (keeping the closing special token), run in groups of about
 * the same length (`planBatches`), pooled and scaled to unit length.
 */
export class OnnxEmbeddingModel implements EmbeddingModel {
  readonly dimensions: number;
  readonly #output: string;
  readonly #inputs: ReadonlySet<string>;

  constructor(
    private readonly ort: OnnxRuntime,
    private readonly session: InferenceSession,
    private readonly tokenizer: Tokenizer,
    private readonly options: Options,
  ) {
    this.dimensions = options.dimensions;
    const inputs = new Set(session.inputNames);
    for (const name of inputs) {
      if (!KNOWN_INPUTS.has(name)) {
        throw new ModelError(
          `${MODEL_FILE} takes an input this worker cannot give (${name}): only ${[...KNOWN_INPUTS].join(', ')}.`,
        );
      }
    }
    if (!inputs.has(INPUT_IDS)) {
      throw new ModelError(`${MODEL_FILE} takes no ${INPUT_IDS}.`);
    }
    this.#inputs = inputs;
    const output =
      OUTPUTS.find((name) => session.outputNames.includes(name)) ??
      session.outputNames[0];
    if (!output) throw new ModelError(`${MODEL_FILE} has no output.`);
    this.#output = output;
  }

  async embed(
    texts: readonly string[],
  ): Promise<{ vectors: Float32Array[]; tokens: number }> {
    if (
      texts.length > MAX_TEXTS ||
      texts.some((text) => text.length > MAX_TEXT_LENGTH)
    ) {
      throw new ModelError('Too much text for one request.');
    }
    const ids = texts.map((text) => this.#tokens(text));
    const vectors = new Array<Float32Array>(texts.length);
    for (const batch of planBatches(
      ids.map((row) => row.length),
      MAX_BATCH_TOKENS,
    )) {
      const rows = batch.map((index) => ids[index] ?? []);
      const pooled = await this.#run(rows);
      batch.forEach((index, at) => {
        const vector = pooled[at];
        if (vector) vectors[index] = vector;
      });
    }
    return { vectors, tokens: ids.reduce((sum, row) => sum + row.length, 0) };
  }

  async close(): Promise<void> {
    await this.session.release();
  }

  /** A text's token IDs, cut at `maxTokens` keeping the last (the closing special token). */
  #tokens(text: string): number[] {
    const { ids } = this.tokenizer.encode(this.options.prefix + text);
    const max = this.options.maxTokens;
    if (ids.length <= max) return ids;
    return [...ids.slice(0, max - 1), ...ids.slice(-1)];
  }

  /** One unit vector per row of token IDs, run at once, padded to the longest. */
  async #run(rows: readonly number[][]): Promise<Float32Array[]> {
    const width = Math.max(1, ...rows.map((row) => row.length));
    const size = rows.length * width;
    const inputIds = new BigInt64Array(size).fill(BigInt(this.options.padId));
    const attention = new BigInt64Array(size);
    const mask: number[][] = [];
    rows.forEach((row, r) => {
      const rowMask = new Array<number>(width).fill(0);
      row.forEach((id, t) => {
        inputIds[r * width + t] = BigInt(id);
        attention[r * width + t] = 1n;
        rowMask[t] = 1;
      });
      mask.push(rowMask);
    });
    const dims = [rows.length, width];
    const feeds: Record<string, Tensor> = {
      [INPUT_IDS]: new this.ort.Tensor('int64', inputIds, dims),
    };
    if (this.#inputs.has(ATTENTION_MASK)) {
      feeds[ATTENTION_MASK] = new this.ort.Tensor('int64', attention, dims);
    }
    if (this.#inputs.has(TOKEN_TYPE_IDS)) {
      feeds[TOKEN_TYPE_IDS] = new this.ort.Tensor(
        'int64',
        new BigInt64Array(size),
        dims,
      );
    }
    let output: Tensor | undefined;
    try {
      const results = await this.session.run(feeds, [this.#output]);
      output = results[this.#output];
    } catch {
      throw new ModelError('The model could not be run.');
    }
    if (!output || output.type !== 'float32') {
      throw new ModelError(`The model's ${this.#output} is no float32 tensor.`);
    }
    const outDims = output.dims;
    const dimensions = outDims[outDims.length - 1];
    if (
      (outDims.length !== 2 && outDims.length !== 3) ||
      outDims[0] !== rows.length ||
      (outDims.length === 3 && outDims[1] !== width)
    ) {
      throw new ModelError(
        `The model's ${this.#output} has the shape [${outDims.join(', ')}], not one vector per text or per token.`,
      );
    }
    if (dimensions !== this.dimensions) {
      throw new ModelError(
        `The model's vectors have ${dimensions} numbers, CCMS_EMBEDDER_DIMENSIONS says ${this.dimensions}.`,
      );
    }
    const vectors = poolRows(
      output.data as Float32Array,
      outDims,
      mask,
      this.options.pooling,
    );
    output.dispose();
    if (vectors.some((vector) => !vector.every(Number.isFinite))) {
      throw new ModelError('The model answered a number that is not finite.');
    }
    return vectors;
  }
}

/** A file's bytes, once their SHA-256 is `expected`; otherwise refused, naming the setting. */
async function pinned(
  file: string,
  expected: string,
  setting: string,
): Promise<Buffer> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    throw new ModelError(
      `${path.basename(file)} cannot be read from CCMS_EMBEDDER_MODEL_DIR.`,
    );
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) {
    throw new ModelError(
      `${path.basename(file)} has the SHA-256 ${actual}, not the one ${setting} pins: refused.`,
    );
  }
  return bytes;
}

/** The padding token's ID: the tokenizer's padding setting, else its `<pad>` or `[PAD]`, else 0 (masked out anyway). */
function padIdOf(json: TokenizerJson, tokenizer: Tokenizer): number {
  const configured = json.padding?.pad_id;
  if (
    typeof configured === 'number' &&
    Number.isInteger(configured) &&
    configured >= 0
  ) {
    return configured;
  }
  return tokenizer.token_to_id('<pad>') ?? tokenizer.token_to_id('[PAD]') ?? 0;
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}
