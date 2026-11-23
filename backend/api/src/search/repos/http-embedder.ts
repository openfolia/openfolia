import {
  Embedder,
  EmbedderError,
  MAX_EMBED_BATCH,
  MAX_EMBED_TEXT_LENGTH,
} from '../core/embedder.js';

/** The endpoint, the model, its dimensions, the key and the timeout (`CCMS_EMBEDDER_*`). */
export interface HttpEmbedderSettings {
  readonly url: string;
  readonly model: string;
  readonly dimensions: number;
  readonly apiKey?: string | undefined;
  readonly timeoutMs: number;
}

/** The most an answer may hold, in bytes; a larger one is refused unread. */
export const MAX_EMBED_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * Embeddings over an HTTP endpoint that takes `{ model, input: [texts] }`
 * and answers `{ data: [{ embedding: [numbers], index? }] }`, the shape
 * most embedding servers speak, self-hosted (a model beside the API) or
 * hosted. **The texts leave the server**: module text, to wherever
 * `CCMS_EMBEDDER_URL` points. Off unless that is set.
 *
 * One POST per batch (at most `MAX_EMBED_BATCH` texts of at most
 * `MAX_EMBED_TEXT_LENGTH` characters), cut off after `timeoutMs`, never
 * retried here (the job retries); redirects are refused, so the texts and
 * the key go to the configured URL only; the answer is read up to
 * `MAX_EMBED_RESPONSE_BYTES` and checked: one vector of `dimensions`
 * finite numbers per text. Errors name the HTTP status at most: never the
 * URL, the key, the texts or the answer.
 */
export class HttpEmbedder extends Embedder {
  readonly model: string;
  readonly dimensions: number;

  constructor(private readonly settings: HttpEmbedderSettings) {
    super();
    this.model = `${settings.model}@${settings.dimensions}`;
    this.dimensions = settings.dimensions;
  }

  async embed(
    texts: readonly string[],
    signal: AbortSignal,
  ): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (
      texts.length > MAX_EMBED_BATCH ||
      texts.some((text) => text.length > MAX_EMBED_TEXT_LENGTH)
    ) {
      throw new EmbedderError('Too much text for one embedding request.');
    }
    const timeout = AbortSignal.timeout(this.settings.timeoutMs);
    const both = AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await fetch(this.settings.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(this.settings.apiKey
            ? { Authorization: `Bearer ${this.settings.apiKey}` }
            : {}),
        },
        body: JSON.stringify({ model: this.settings.model, input: texts }),
        signal: both,
        redirect: 'error',
      });
    } catch {
      // The cause may name the host; it is not passed on.
      throw new EmbedderError(
        both.aborted
          ? 'The embedding request was cut off.'
          : 'The embedder could not be reached.',
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new EmbedderError(`The embedder answered ${response.status}.`);
    }
    let body: unknown;
    try {
      body = JSON.parse(await readCapped(response));
    } catch (error) {
      if (error instanceof EmbedderError) throw error;
      throw new EmbedderError(
        both.aborted
          ? 'The embedding request was cut off.'
          : 'The embedder answered something other than JSON.',
      );
    }
    return vectorsOf(body, texts.length, this.dimensions);
  }
}

/** The answer's body as text, refused past `MAX_EMBED_RESPONSE_BYTES`. */
async function readCapped(response: Response): Promise<string> {
  const length = Number(response.headers.get('content-length') ?? NaN);
  if (length > MAX_EMBED_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new EmbedderError('The embedder answer is too large.');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_EMBED_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new EmbedderError('The embedder answer is too large.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The vectors of an answer, in the order of the texts, checked. */
export function vectorsOf(
  body: unknown,
  count: number,
  dimensions: number,
): number[][] {
  const wrong = () =>
    new EmbedderError('The embedder answered something unexpected.');
  if (typeof body !== 'object' || body === null) throw wrong();
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length !== count) throw wrong();
  const vectors: (number[] | undefined)[] = new Array<number[] | undefined>(
    count,
  );
  data.forEach((item: unknown, position) => {
    if (typeof item !== 'object' || item === null) throw wrong();
    const { embedding, index } = item as {
      embedding?: unknown;
      index?: unknown;
    };
    const at = index === undefined ? position : index;
    if (
      typeof at !== 'number' ||
      !Number.isInteger(at) ||
      at < 0 ||
      at >= count ||
      vectors[at] !== undefined
    ) {
      throw wrong();
    }
    if (
      !Array.isArray(embedding) ||
      embedding.length !== dimensions ||
      !embedding.every((n) => typeof n === 'number' && Number.isFinite(n))
    ) {
      throw wrong();
    }
    vectors[at] = embedding as number[];
  });
  return vectors as number[][];
}
