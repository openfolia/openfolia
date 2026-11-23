import { z } from 'zod';

/** The most dimensions a vector may have: the most an HNSW index in pgvector takes. */
export const MAX_DIMENSIONS = 2_000;

/** `CCMS_EMBEDDER_*` defaults of the worker. */
export const DEFAULT_MODEL_DIR = '/models';
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8090;
export const DEFAULT_MAX_TOKENS = 512;
export const DEFAULT_THREADS = 2;
export const DEFAULT_QUEUE = 8;

const sha256 = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[0-9a-f]{64}$/, 'the SHA-256 of the file: 64 hexadecimal digits');

const wholeNumber = (min: number, max: number) =>
  z.coerce
    .number({ error: `a whole number ${min}-${max}` })
    .int(`a whole number ${min}-${max}`)
    .min(min, `a whole number ${min}-${max}`)
    .max(max, `a whole number ${min}-${max}`);

const Settings = z.object({
  /** The model's name: what the API sends as `model` (its `CCMS_EMBEDDER_MODEL`); a request naming another is refused. */
  CCMS_EMBEDDER_MODEL: z
    .string({ error: 'required: the name the API sends as the model' })
    .trim()
    .min(1, 'required: the name the API sends as the model')
    .max(200),
  /** How many numbers the model's vectors have; checked against the model as it loads. */
  CCMS_EMBEDDER_DIMENSIONS: wholeNumber(1, MAX_DIMENSIONS),
  /** The folder holding `model.onnx` and `tokenizer.json`. */
  CCMS_EMBEDDER_MODEL_DIR: z.string().trim().min(1).default(DEFAULT_MODEL_DIR),
  /** The SHA-256 of `model.onnx`: another file is refused. */
  CCMS_EMBEDDER_MODEL_SHA256: sha256,
  /** The SHA-256 of `tokenizer.json`: another file is refused. */
  CCMS_EMBEDDER_TOKENIZER_SHA256: sha256,
  /** How a text's token vectors become one: `mean` (the default) or `cls` (the first token's). Unused when the model answers one vector per text itself. */
  CCMS_EMBEDDER_POOLING: z
    .string()
    .trim()
    .pipe(z.enum(['mean', 'cls'], 'must be mean or cls'))
    .default('mean'),
  /** Text put before every input, for a model that expects one; default none. */
  CCMS_EMBEDDER_PREFIX: z.string().max(100).default(''),
  /** The most tokens of one text the model reads; the rest is cut. Unset: the tokenizer's own truncation length, else `DEFAULT_MAX_TOKENS`. */
  CCMS_EMBEDDER_MAX_TOKENS: wholeNumber(8, 2_048).optional(),
  /** The CPU threads one model run uses. */
  CCMS_EMBEDDER_THREADS: wholeNumber(1, 64).default(DEFAULT_THREADS),
  /** Requests waiting while one runs; one more is answered 503. */
  CCMS_EMBEDDER_QUEUE: wholeNumber(0, 64).default(DEFAULT_QUEUE),
  /** The address to listen on. */
  CCMS_EMBEDDER_HOST: z.string().trim().min(1).default(DEFAULT_HOST),
  /** The port to listen on (0: any free one). */
  CCMS_EMBEDDER_PORT: wholeNumber(0, 65_535).default(DEFAULT_PORT),
});

export type EmbedderSettings = z.infer<typeof Settings>;

/**
 * The worker's settings from the environment (an empty value counts as
 * unset), or an error naming each bad one, never its value.
 */
export function loadSettings(
  env: NodeJS.ProcessEnv = process.env,
): EmbedderSettings {
  const present: Record<string, string> = {};
  for (const key of Object.keys(Settings.shape)) {
    const value = env[key];
    if (value !== undefined && value !== '') present[key] = value;
  }
  const result = Settings.safeParse(present);
  if (result.success) return result.data;
  const problems = result.error.issues.map(
    (issue) => `${issue.path.join('.')}: ${issue.message}`,
  );
  throw new Error(`Invalid settings:\n  ${problems.join('\n  ')}`);
}
