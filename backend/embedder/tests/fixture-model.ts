import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * A tiny model folder written at test time, so the ONNX Runtime runs for
 * real in the default suite without a model download: `model.onnx` is one
 * `Gather` (each token's row of a fixed table, `[batch, tokens, 4]`, a
 * "last hidden state"), `tokenizer.json` a WordPiece tokenizer over a few
 * words with `[CLS] … [SEP]` around each text.
 */
export const FIXTURE_DIMENSIONS = 4;

/** The vocabulary: special tokens, then words. */
export const FIXTURE_VOCAB = [
  '[PAD]',
  '[UNK]',
  '[CLS]',
  '[SEP]',
  'battery',
  'cell',
  'change',
  'replace',
  'weather',
  'sunny',
  'the',
] as const;

/** Each token's row: battery and cell point the same way, weather and sunny another. */
const TABLE: Record<(typeof FIXTURE_VOCAB)[number], number[]> = {
  '[PAD]': [100, 100, 100, 100],
  '[UNK]': [0, 0, 0, 1],
  '[CLS]': [0, 0, 0, 0],
  '[SEP]': [0, 0, 0, 0],
  battery: [1, 0, 0, 0],
  cell: [0.9, 0.1, 0, 0],
  change: [0.2, 0, 0.1, 0],
  replace: [0.2, 0, 0.1, 0],
  weather: [0, 1, 0, 0],
  sunny: [0, 0.9, 0.1, 0],
  the: [0, 0, 0.05, 0],
};

export interface FixtureOptions {
  /** Inputs the graph declares besides `input_ids` (default `attention_mask`). */
  readonly extraInputs?: readonly string[];
  /** The output's name (default `last_hidden_state`). */
  readonly output?: string;
  /** Truncation the tokenizer names (`truncation.max_length`), if any. */
  readonly truncation?: number;
}

export interface Fixture {
  readonly dir: string;
  readonly modelSha256: string;
  readonly tokenizerSha256: string;
}

export async function writeFixtureModel(
  dir: string,
  options: FixtureOptions = {},
): Promise<Fixture> {
  await mkdir(dir, { recursive: true });
  const model = onnxModel(options);
  const tokenizer = Buffer.from(JSON.stringify(tokenizerJson(options)));
  await writeFile(path.join(dir, 'model.onnx'), model);
  await writeFile(path.join(dir, 'tokenizer.json'), tokenizer);
  return {
    dir,
    modelSha256: sha256(model),
    tokenizerSha256: sha256(tokenizer),
  };
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function tokenizerJson(options: FixtureOptions) {
  const vocab = Object.fromEntries(
    FIXTURE_VOCAB.map((token, id) => [token, id]),
  );
  return {
    version: '1.0',
    truncation:
      options.truncation === undefined
        ? null
        : {
            direction: 'Right',
            max_length: options.truncation,
            strategy: 'LongestFirst',
            stride: 0,
          },
    padding: null,
    added_tokens: FIXTURE_VOCAB.slice(0, 4).map((content, id) => ({
      id,
      content,
      single_word: false,
      lstrip: false,
      rstrip: false,
      normalized: false,
      special: true,
    })),
    normalizer: {
      type: 'BertNormalizer',
      clean_text: true,
      handle_chinese_chars: true,
      strip_accents: null,
      lowercase: true,
    },
    pre_tokenizer: { type: 'BertPreTokenizer' },
    post_processor: {
      type: 'BertProcessing',
      sep: ['[SEP]', 3],
      cls: ['[CLS]', 2],
    },
    decoder: { type: 'WordPiece', prefix: '##', cleanup: true },
    model: {
      type: 'WordPiece',
      unk_token: '[UNK]',
      continuing_subword_prefix: '##',
      max_input_chars_per_word: 100,
      vocab,
    },
  };
}

// ---- A minimal protobuf writer, enough for an ONNX ModelProto. ----

function varint(value: number | bigint): number[] {
  let v = BigInt(value);
  const out: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return out;
}

const key = (field: number, wire: number) => varint((field << 3) | wire);
const int = (field: number, value: number) => [
  ...key(field, 0),
  ...varint(value),
];
const bytes = (field: number, value: Uint8Array | number[]) => [
  ...key(field, 2),
  ...varint(value.length),
  ...value,
];
const str = (field: number, value: string) =>
  bytes(field, [...Buffer.from(value)]);

const FLOAT = 1;
const INT64 = 7;

function valueInfo(name: string, elemType: number, dims: (string | number)[]) {
  const shape = dims.flatMap((d) =>
    bytes(1, typeof d === 'number' ? int(1, d) : str(2, d)),
  );
  const tensorType = [...int(1, elemType), ...bytes(2, shape)];
  return [...str(1, name), ...bytes(2, bytes(1, tensorType))];
}

function onnxModel(options: FixtureOptions): Buffer {
  const output = options.output ?? 'last_hidden_state';
  const extra = options.extraInputs ?? ['attention_mask'];
  const rows = FIXTURE_VOCAB.map((token) => TABLE[token]).flat();
  const raw = Buffer.alloc(rows.length * 4);
  rows.forEach((n, i) => raw.writeFloatLE(n, i * 4));
  const table = [
    ...int(1, FIXTURE_VOCAB.length),
    ...int(1, FIXTURE_DIMENSIONS),
    ...int(2, FLOAT),
    ...str(8, 'table'),
    ...bytes(9, raw),
  ];
  const gather = [
    ...str(1, 'table'),
    ...str(1, 'input_ids'),
    ...str(2, output),
    ...str(3, 'gather'),
    ...str(4, 'Gather'),
    ...bytes(5, [...str(1, 'axis'), ...int(3, 0), ...int(20, 2)]),
  ];
  const graph = [
    ...bytes(1, gather),
    ...str(2, 'fixture'),
    ...bytes(5, table),
    ...bytes(11, valueInfo('input_ids', INT64, ['batch', 'tokens'])),
    ...extra.flatMap((name) =>
      bytes(11, valueInfo(name, INT64, ['batch', 'tokens'])),
    ),
    ...bytes(
      12,
      valueInfo(output, FLOAT, ['batch', 'tokens', FIXTURE_DIMENSIONS]),
    ),
  ];
  return Buffer.from([
    ...int(1, 8),
    ...str(2, 'fixture'),
    ...bytes(7, graph),
    ...bytes(8, [...str(1, ''), ...int(2, 13)]),
  ]);
}
