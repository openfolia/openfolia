import { z } from 'zod';
import { field, text, wholeNumber } from './fields.js';
import { endpoint, isLoopback } from './style-review-env.js';

/** `CCMS_EMBEDDER_*` defaults (#54). */
export const DEFAULT_EMBEDDER_TIMEOUT_MS = 10_000;
export const DEFAULT_EMBEDDER_MIN_SIMILARITY = 50;
/** The most dimensions an HNSW index takes (pgvector). */
export const MAX_EMBEDDER_DIMENSIONS = 2_000;
/** `CCMS_SEARCH_TIMEOUT_MS`, `_PER_MINUTE` and `_CONCURRENCY` defaults (#539). */
export const DEFAULT_SEARCH_TIMEOUT_MS = 5_000;
export const DEFAULT_SEARCH_PER_MINUTE = 120;
export const DEFAULT_SEARCH_CONCURRENCY = 4;
/** `CCMS_SEARCH_SWEEP_AFTER_DAYS` and `CCMS_SEARCH_MODEL_KEPT_DAYS` defaults (#540). */
export const DEFAULT_SEARCH_SWEEP_AFTER_DAYS = 7;
export const DEFAULT_SEARCH_MODEL_KEPT_DAYS = 7;

/**
 * The search's settings (`src/search/`): part of `Env`. The adapter
 * (`postgres`, the default, or `memory`) and the embedder for semantic
 * search, off unless `CCMS_EMBEDDER_URL` is set; `checkSearchEnv` says
 * what goes with it.
 */
export const SearchEnv = z.object({
  /** `postgres` (default): the index in the database (#54). `memory`: in each server's memory, word prefixes only (#70). */
  CCMS_SEARCH_ADAPTER: field(
    z
      .string()
      .trim()
      .pipe(z.enum(['postgres', 'memory'], 'must be postgres or memory'))
      .default('postgres'),
  ),
  /** The most time one search may spend in the database, all its statements together, in ms (default 5 s); past it, 503 `database-timeout`. */
  CCMS_SEARCH_TIMEOUT_MS: field(
    wholeNumber(100, 60_000).default(DEFAULT_SEARCH_TIMEOUT_MS),
  ),
  /** Searches one reader (a person or a service account) may ask for per minute, on each server (default 120); past it, 429 `rate-limited`. */
  CCMS_SEARCH_PER_MINUTE: field(
    wholeNumber(1, 6_000).default(DEFAULT_SEARCH_PER_MINUTE),
  ),
  /** Searches one server runs in the database at once (default 4); more wait briefly, then 503 `search-busy`. */
  CCMS_SEARCH_CONCURRENCY: field(
    wholeNumber(1, 100).default(DEFAULT_SEARCH_CONCURRENCY),
  ),
  /** The index's grace period, in days (default 7): a scope unused this long is dropped, a document no scope names and as old, and a text no document uses for this long, with its embeddings (#540). */
  CCMS_SEARCH_SWEEP_AFTER_DAYS: field(
    wholeNumber(1, 365).default(DEFAULT_SEARCH_SWEEP_AFTER_DAYS),
  ),
  /** Days the embeddings of a model no server has configured any more are kept (default 7), then the sweep drops them (#540). */
  CCMS_SEARCH_MODEL_KEPT_DAYS: field(
    wholeNumber(1, 365).default(DEFAULT_SEARCH_MODEL_KEPT_DAYS),
  ),
  /** An embeddings endpoint (the full URL a request is posted to); unset: no semantic search, nothing is sent anywhere. */
  CCMS_EMBEDDER_URL: field(endpoint.optional()),
  /** Sent as `Authorization: Bearer …`; optional. Never logged. */
  CCMS_EMBEDDER_API_KEY: field(text.max(4096).optional()),
  /** The model name the endpoint expects. */
  CCMS_EMBEDDER_MODEL: field(text.max(200).optional()),
  /** How many numbers the model's vectors have. */
  CCMS_EMBEDDER_DIMENSIONS: field(
    wholeNumber(1, MAX_EMBEDDER_DIMENSIONS).optional(),
  ),
  /** How long one request to the endpoint may take, in ms (default 10 s). */
  CCMS_EMBEDDER_TIMEOUT_MS: field(
    wholeNumber(100, 120_000).default(DEFAULT_EMBEDDER_TIMEOUT_MS),
  ),
  /** How close (cosine similarity, in percent) a block's meaning has to be to the query's to be found by meaning alone (default 50). */
  CCMS_EMBEDDER_MIN_SIMILARITY: field(
    wholeNumber(0, 100).default(DEFAULT_EMBEDDER_MIN_SIMILARITY),
  ),
});
export type SearchSettings = z.infer<typeof SearchEnv>;

/**
 * The checks across fields, for `Env.superRefine`: the model and its
 * dimensions with the URL, nothing without it, the Postgres adapter for
 * it, and a key only over `https://` (or to this machine).
 */
export function checkSearchEnv(
  env: SearchSettings,
  ctx: z.RefinementCtx,
): void {
  const need = (name: keyof SearchSettings, message: string) =>
    ctx.addIssue({ code: 'custom', path: [name], message });
  const url = env.CCMS_EMBEDDER_URL;
  if (url && !URL.canParse(url)) return;
  if (!url) {
    for (const name of [
      'CCMS_EMBEDDER_MODEL',
      'CCMS_EMBEDDER_DIMENSIONS',
      'CCMS_EMBEDDER_API_KEY',
    ] as const) {
      if (env[name] !== undefined) {
        need('CCMS_EMBEDDER_URL', `is required when ${name} is set`);
        return;
      }
    }
    return;
  }
  if (!env.CCMS_EMBEDDER_MODEL) {
    need('CCMS_EMBEDDER_MODEL', 'is required when CCMS_EMBEDDER_URL is set');
  }
  if (env.CCMS_EMBEDDER_DIMENSIONS === undefined) {
    need(
      'CCMS_EMBEDDER_DIMENSIONS',
      'is required when CCMS_EMBEDDER_URL is set',
    );
  }
  if (env.CCMS_SEARCH_ADAPTER !== 'postgres') {
    need(
      'CCMS_EMBEDDER_URL',
      'needs CCMS_SEARCH_ADAPTER=postgres (the in-memory search has no semantic search)',
    );
  }
  const { protocol, hostname } = new URL(url);
  if (
    env.CCMS_EMBEDDER_API_KEY &&
    protocol !== 'https:' &&
    !isLoopback(hostname)
  ) {
    need(
      'CCMS_EMBEDDER_URL',
      'must be https:// when CCMS_EMBEDDER_API_KEY is set (http:// only to localhost)',
    );
  }
}
