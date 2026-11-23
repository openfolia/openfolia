import {
  CONCEPTS,
  conceptVector,
} from '../../../tests/fakes/concept-embedder.js';
import {
  embeddingServer,
  type EmbeddingServer,
} from '../../../tests/fakes/embedding-server.js';
import { EmbedderError, MAX_EMBED_BATCH } from '../core/embedder.js';
import {
  HttpEmbedder,
  MAX_EMBED_RESPONSE_BYTES,
  vectorsOf,
} from './http-embedder.js';

const KEY = 'embed-key-0123456789-very-secret';
const DIMENSIONS = CONCEPTS.length + 1;

let server: EmbeddingServer;
beforeAll(async () => {
  server = await embeddingServer();
});
afterAll(() => server?.close());

const embedder = (
  settings: Partial<{ apiKey: string; timeoutMs: number; url: string }> = {},
) =>
  new HttpEmbedder({
    url: settings.url ?? server.url,
    model: 'some-model',
    dimensions: DIMENSIONS,
    apiKey: settings.apiKey,
    timeoutMs: settings.timeoutMs ?? 2_000,
  });
const signal = () => new AbortController().signal;

/** The error `embed` throws, checked to name neither the key, the URL nor the text. */
async function failure(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(EmbedderError);
  const message = (error as Error).message;
  expect(message).not.toContain(KEY);
  expect(message).not.toContain('127.0.0.1');
  expect(message).not.toContain('secret text');
  return message;
}

describe('HttpEmbedder', () => {
  it('posts the model and the texts, with the key, and reads one vector per text in order', async () => {
    server.handle = (req, res, body) => {
      const { input } = JSON.parse(body) as { input: string[] };
      res.setHeader('Content-Type', 'application/json');
      // Out of order, by index.
      res.end(
        JSON.stringify({
          data: input
            .map((text, index) => ({ index, embedding: conceptVector(text) }))
            .reverse(),
        }),
      );
    };
    const vectors = await embedder({ apiKey: KEY }).embed(
      ['The battery', 'A cable'],
      signal(),
    );
    expect(vectors).toEqual([
      conceptVector('The battery'),
      conceptVector('A cable'),
    ]);
    const last = server.received.at(-1);
    expect(JSON.parse(last?.body ?? '')).toEqual({
      model: 'some-model',
      input: ['The battery', 'A cable'],
    });
    expect(last?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(embedder().model).toBe(`some-model@${DIMENSIONS}`);
  });

  it('sends no key when none is set, and nothing for no texts', async () => {
    const before = server.received.length;
    expect(await embedder().embed([], signal())).toEqual([]);
    expect(server.received.length).toBe(before);
    server.handle = (req, res, body) => {
      const { input } = JSON.parse(body) as { input: string[] };
      res.end(
        JSON.stringify({
          data: input.map((text) => ({ embedding: conceptVector(text) })),
        }),
      );
    };
    await embedder().embed(['x'], signal());
    expect(server.received.at(-1)?.headers.authorization).toBeUndefined();
  });

  it('refuses too much text before sending anything', async () => {
    const before = server.received.length;
    await failure(
      embedder().embed(
        new Array<string>(MAX_EMBED_BATCH + 1).fill('a'),
        signal(),
      ),
    );
    await failure(embedder().embed(['a'.repeat(4_001)], signal()));
    expect(server.received.length).toBe(before);
  });

  it('fails on an error status, a redirect, a wrong answer, a huge answer and a timeout, naming none of it', async () => {
    const one = () =>
      embedder({ apiKey: KEY }).embed(['secret text'], signal());
    server.handle = (_req, res) => {
      res.statusCode = 500;
      res.end('secret text in the error');
    };
    expect(await failure(one())).toBe('The embedder answered 500.');
    server.handle = (_req, res) => {
      res.statusCode = 302;
      res.setHeader('Location', 'http://elsewhere.example/');
      res.end();
    };
    expect(await failure(one())).toBe('The embedder could not be reached.');
    server.handle = (_req, res) => res.end('not json');
    await failure(one());
    server.handle = (_req, res) =>
      res.end(JSON.stringify({ data: [{ embedding: [1, 2] }] }));
    await failure(one());
    server.handle = (_req, res) => {
      res.setHeader('Content-Length', String(MAX_EMBED_RESPONSE_BYTES + 1));
      res.end();
    };
    expect(await failure(one())).toBe('The embedder answer is too large.');
    server.handle = () => undefined; // never answers
    expect(
      await failure(
        embedder({ timeoutMs: 100 }).embed(['secret text'], signal()),
      ),
    ).toBe('The embedding request was cut off.');
  });
});

describe('vectorsOf', () => {
  it('takes one finite vector of the dimensions per text, each index once', () => {
    expect(vectorsOf({ data: [{ embedding: [1, 0] }] }, 1, 2)).toEqual([
      [1, 0],
    ]);
    for (const body of [
      null,
      {},
      { data: [] },
      { data: [{ embedding: [1, 0] }, { embedding: [0, 1] }] },
      { data: [{ embedding: [1] }] },
      { data: [{ embedding: [1, Number.NaN] }] },
      { data: [{ embedding: ['1', 0] }] },
      { data: [{ embedding: [1, 0], index: 3 }] },
      { data: [{ embedding: [1, 0], index: 0.5 }] },
    ]) {
      expect(() => vectorsOf(body, 1, 2)).toThrow(EmbedderError);
    }
    expect(() =>
      vectorsOf(
        {
          data: [
            { embedding: [1, 0], index: 0 },
            { embedding: [0, 1], index: 0 },
          ],
        },
        2,
        2,
      ),
    ).toThrow(EmbedderError);
  });
});
