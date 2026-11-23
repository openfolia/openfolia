import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  type EmbeddingModel,
  MAX_TEXT_LENGTH,
  MAX_TEXTS,
  ModelError,
} from './embedding-model.js';

/** Where the API posts (`CCMS_EMBEDDER_URL` is `http://<host>:<port>/v1/embeddings`). */
export const EMBEDDINGS_PATH = '/v1/embeddings';
/** The health check: 200 once the model is loaded (the server starts only then). */
export const HEALTH_PATH = '/health';

/**
 * The most bytes a request body may have: 32 texts of 4,000 characters,
 * each character escaped in JSON (`\uXXXX`, 6 bytes), with room to spare.
 */
export const MAX_BODY_BYTES = 1024 * 1024;

/** Connections allowed beyond the queue (the one running, health checks, callers arriving). */
export const EXTRA_CONNECTIONS = 8;

/** How long a request may take to arrive, headers and body, in ms. */
export const REQUEST_TIMEOUT_MS = 30_000;

export interface ServerOptions {
  /** The model's name: a request naming another is refused. */
  readonly model: string;
  /** Requests waiting while one runs; one more is answered 503. */
  readonly queue: number;
  readonly host: string;
  readonly port: number;
}

/**
 * The worker's HTTP server: `POST /v1/embeddings` takes
 * `{ "model", "input": [texts] }` and answers
 * `{ "object": "list", "data": [{ "object": "embedding", "index", "embedding" }], "model", "usage" }`,
 * the shape the API's `HttpEmbedder` reads; `GET /health`. One request runs
 * at a time (one model, loaded once), `queue` more wait in order, and
 * another is answered 503 with `Retry-After`. Bodies are read up to
 * `MAX_BODY_BYTES` and checked before the model sees them; errors answer
 * `{ "error": { "message", "type" } }` and never echo the text. No
 * authentication: it listens on the deployment's internal network only
 * (`deploy/compose.embedder.yaml`).
 */
export function createEmbedderServer(
  model: EmbeddingModel,
  options: ServerOptions,
): Server {
  const queue = new RunQueue(options.queue);
  // Slow clients are checked every 2 s (Node's default is 30 s), so a
  // request past its timeout is closed soon after.
  const server = createServer(
    { connectionsCheckingInterval: 2_000 },
    (req, res) => {
      handle(req, res, model, options, queue).catch((cause: unknown) => {
        // A ModelError names no text; anything else is not passed on.
        console.error(
          `Embedding failed: ${cause instanceof ModelError ? cause.message : 'unexpected error'}`,
        );
        if (!res.headersSent)
          send(res, 500, error('The model failed.', 'model_error'));
        else res.destroy();
      });
    },
  );
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = Math.min(REQUEST_TIMEOUT_MS, 10_000);
  server.keepAliveTimeout = 5_000;
  // Each open request may buffer up to MAX_BODY_BYTES: the connections are
  // bounded with the queue, so memory is too (one more is refused).
  server.maxConnections = options.queue + EXTRA_CONNECTIONS;
  return server;
}

/** Starts `createEmbedderServer` and resolves once it listens. */
export async function startEmbedderServer(
  model: EmbeddingModel,
  options: ServerOptions,
): Promise<Server> {
  const server = createEmbedderServer(model, options);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  model: EmbeddingModel,
  options: ServerOptions,
  queue: RunQueue,
): Promise<void> {
  const url = req.url ?? '/';
  const pathname = url.split('?', 1)[0];
  if (pathname === HEALTH_PATH) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return refuse(req, res, 405, 'Only GET.', { Allow: 'GET, HEAD' });
    }
    return send(res, 200, { status: 'ok' });
  }
  if (pathname !== EMBEDDINGS_PATH) {
    return refuse(req, res, 404, 'Not found.');
  }
  if (req.method !== 'POST') {
    return refuse(req, res, 405, 'Only POST.', { Allow: 'POST' });
  }
  const type = (req.headers['content-type'] ?? '').split(';', 1)[0] ?? '';
  if (type.trim().toLowerCase() !== 'application/json') {
    return refuse(req, res, 415, 'The body must be application/json.');
  }
  const length = Number(req.headers['content-length'] ?? NaN);
  if (length > MAX_BODY_BYTES) {
    return refuse(req, res, 413, `At most ${MAX_BODY_BYTES} bytes.`);
  }
  const body = await readBody(req);
  if (body === TOO_LARGE) {
    return refuse(req, res, 413, `At most ${MAX_BODY_BYTES} bytes.`);
  }
  if (body === ABORTED) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return send(res, 400, error('The body is not JSON.'));
  }
  const request = embeddingRequest(parsed, options.model);
  if (typeof request === 'string') return send(res, 400, error(request));
  if (request.input.length === 0) {
    return send(res, 200, answer([], options.model, 0));
  }
  const ran = await queue.run(async () => {
    // The caller gave up while it waited (its timeout): nothing to run for.
    if (res.destroyed) return undefined;
    return model.embed(request.input);
  });
  if (ran === BUSY) {
    return send(
      res,
      503,
      error('Busy: too many requests waiting.', 'server_busy'),
      { 'Retry-After': '1' },
    );
  }
  if (ran === undefined) return;
  if (
    ran.vectors.length !== request.input.length ||
    ran.vectors.some((vector) => vector.length !== model.dimensions)
  ) {
    return send(res, 500, error('The model answered wrongly.', 'model_error'));
  }
  return send(res, 200, answer(ran.vectors, options.model, ran.tokens));
}

/** A request's texts, checked, or what is wrong with it. */
export function embeddingRequest(
  body: unknown,
  model: string,
): { input: string[] } | string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return 'The body must be an object with "model" and "input".';
  }
  const {
    model: named,
    input,
    encoding_format: format,
  } = body as Record<string, unknown>;
  if (named !== model) return 'Unknown model.';
  if (format !== undefined && format !== 'float') {
    return 'Only the encoding_format "float".';
  }
  const texts = typeof input === 'string' ? [input] : input;
  if (!Array.isArray(texts) || !texts.every((t) => typeof t === 'string')) {
    return '"input" must be a text or a list of texts.';
  }
  if (texts.length > MAX_TEXTS) return `At most ${MAX_TEXTS} texts.`;
  if (texts.some((text) => text.length > MAX_TEXT_LENGTH)) {
    return `At most ${MAX_TEXT_LENGTH} characters per text.`;
  }
  return { input: texts };
}

function answer(
  vectors: readonly Float32Array[],
  model: string,
  tokens: number,
) {
  return {
    object: 'list',
    data: vectors.map((vector, index) => ({
      object: 'embedding',
      index,
      embedding: Array.from(vector),
    })),
    model,
    usage: { prompt_tokens: tokens, total_tokens: tokens },
  };
}

function error(message: string, type = 'invalid_request_error') {
  return { error: { message, type } };
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(text);
}

/** An error answer to a request whose body is not read: the connection is closed after it, so the body never has to arrive. */
function refuse(
  _req: IncomingMessage,
  res: ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  send(res, status, error(message), { Connection: 'close', ...headers });
}

const TOO_LARGE = Symbol('too large');
const ABORTED = Symbol('aborted');

/** The body as text, up to `MAX_BODY_BYTES`. */
async function readBody(
  req: IncomingMessage,
): Promise<string | typeof TOO_LARGE | typeof ABORTED> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const buffer = chunk as Buffer;
      size += buffer.byteLength;
      if (size > MAX_BODY_BYTES) return TOO_LARGE;
      chunks.push(buffer);
    }
  } catch {
    return ABORTED;
  }
  return Buffer.concat(chunks).toString('utf8');
}

const BUSY = Symbol('busy');

/** Runs one task at a time, in order, with at most `waiting` more queued. */
export class RunQueue {
  #tail: Promise<unknown> = Promise.resolve();
  #pending = 0;

  constructor(private readonly waiting: number) {}

  async run<T>(task: () => Promise<T>): Promise<T | typeof BUSY> {
    // One runs, `waiting` wait: the one running counts too.
    if (this.#pending > this.waiting) return BUSY;
    this.#pending++;
    const result = this.#tail.then(task, task);
    this.#tail = result.catch(() => undefined);
    try {
      return await result;
    } finally {
      this.#pending--;
    }
  }
}
