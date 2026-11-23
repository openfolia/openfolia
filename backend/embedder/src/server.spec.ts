import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeModel } from '../tests/fake-model.js';
import { MAX_TEXT_LENGTH, MAX_TEXTS, ModelError } from './embedding-model.js';
import {
  embeddingRequest,
  EXTRA_CONNECTIONS,
  MAX_BODY_BYTES,
  RunQueue,
  startEmbedderServer,
} from './server.js';

const MODEL = 'test-model';
let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
    server.closeAllConnections();
  });
  server = undefined;
});

async function start(model = new FakeModel(), queue = 8): Promise<string> {
  server = await startEmbedderServer(model, {
    model: MODEL,
    queue,
    host: '127.0.0.1',
    port: 0,
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function post(
  base: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(`${base}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /v1/embeddings', () => {
  it('answers one vector per text, in order, in the shape the API reads', async () => {
    const base = await start();
    const res = await post(base, { model: MODEL, input: ['ab', 'cde'] });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({
      object: 'list',
      data: [
        { object: 'embedding', index: 0, embedding: [2, 97, 0] },
        { object: 'embedding', index: 1, embedding: [3, 99, 0] },
      ],
      model: MODEL,
      usage: { prompt_tokens: 4, total_tokens: 4 },
    });
  });

  it('takes one text as a string, and no texts without running the model', async () => {
    const model = new FakeModel();
    const base = await start(model);
    const one = await post(base, { model: MODEL, input: 'x' });
    expect((await one.json()).data).toHaveLength(1);
    const none = await post(base, { model: MODEL, input: [] });
    expect((await none.json()).data).toEqual([]);
    expect(model.calls).toEqual([['x']]);
  });

  it.each([
    [{ model: 'other', input: ['a'] }, 'Unknown model.'],
    [{ input: ['a'] }, 'Unknown model.'],
    [{ model: MODEL }, '"input" must be a text or a list of texts.'],
    [
      { model: MODEL, input: [1] },
      '"input" must be a text or a list of texts.',
    ],
    [
      { model: MODEL, input: Array(MAX_TEXTS + 1).fill('a') },
      `At most ${MAX_TEXTS} texts.`,
    ],
    [
      { model: MODEL, input: ['a'.repeat(MAX_TEXT_LENGTH + 1)] },
      `At most ${MAX_TEXT_LENGTH} characters per text.`,
    ],
    [
      { model: MODEL, input: ['a'], encoding_format: 'base64' },
      'Only the encoding_format "float".',
    ],
    [[1, 2], 'The body must be an object with "model" and "input".'],
  ])('refuses %j with 400', async (body, message) => {
    const model = new FakeModel();
    const base = await start(model);
    const res = await post(base, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { message, type: 'invalid_request_error' },
    });
    expect(model.calls).toEqual([]);
  });

  it('takes the most the API sends: 32 texts of 4,000 characters, escaped', async () => {
    const base = await start();
    // Each control character is six bytes in JSON (\u0001).
    const texts = Array(MAX_TEXTS).fill('\u0001'.repeat(MAX_TEXT_LENGTH));
    const body = JSON.stringify({ model: MODEL, input: texts });
    expect(Buffer.byteLength(body)).toBeLessThan(MAX_BODY_BYTES);
    const res = await post(base, body);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toHaveLength(MAX_TEXTS);
  });

  it('refuses a body that is not JSON, or not declared as JSON', async () => {
    const base = await start();
    expect((await post(base, '{')).status).toBe(400);
    const plain = await post(base, '{}', { 'Content-Type': 'text/plain' });
    expect(plain.status).toBe(415);
  });

  it('refuses a body over the limit, declared or streamed, without reading it all', async () => {
    const model = new FakeModel();
    const base = await start(model);
    const big = 'x'.repeat(MAX_BODY_BYTES + 1);
    expect((await post(base, big)).status).toBe(413);
    const { port } = server!.address() as AddressInfo;
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/v1/embeddings',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }, // chunked: no length
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.write('x'.repeat(MAX_BODY_BYTES));
      req.end('xx');
    });
    expect(status).toBe(413);
    expect(model.calls).toEqual([]);
  });

  it('answers 503 with Retry-After once the queue is full, and runs one request at a time', async () => {
    const model = new FakeModel();
    let release!: () => void;
    model.gate = new Promise((resolve) => (release = resolve));
    const base = await start(model, 1);
    const first = post(base, { model: MODEL, input: ['a'] });
    const second = post(base, { model: MODEL, input: ['b'] });
    // Let both arrive: one runs, one waits.
    await expect.poll(() => model.calls.length).toBe(1);
    const third = await post(base, { model: MODEL, input: ['c'] });
    expect(third.status).toBe(503);
    expect(third.headers.get('retry-after')).toBe('1');
    expect((await third.json()).error.type).toBe('server_busy');
    release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(model.calls).toEqual([['a'], ['b']]);
  });

  it('does not run a request whose caller hung up while it waited', async () => {
    const model = new FakeModel();
    let release!: () => void;
    model.gate = new Promise((resolve) => (release = resolve));
    const base = await start(model);
    const first = post(base, { model: MODEL, input: ['a'] });
    await expect.poll(() => model.calls.length).toBe(1);
    const gone = new AbortController();
    const second = fetch(`${base}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, input: ['b'] }),
      signal: gone.signal,
    }).catch(() => undefined);
    // Let the second arrive and wait, then hang up.
    await new Promise((resolve) => setTimeout(resolve, 50));
    gone.abort();
    await second;
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    expect((await first).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(model.calls).toEqual([['a']]);
  });

  it('answers 500 when the model fails, naming no text', async () => {
    const model = new FakeModel();
    model.failWith = new ModelError('The model could not be run.');
    const base = await start(model);
    const res = await post(base, { model: MODEL, input: ['secret text'] });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('secret');
    expect(JSON.parse(text).error.type).toBe('model_error');
  });

  it('answers 500 when the model answers vectors of the wrong count or size', async () => {
    const model = new FakeModel();
    model.answer = () => [new Float32Array(2)];
    const base = await start(model);
    const res = await post(base, { model: MODEL, input: ['a', 'b'] });
    expect(res.status).toBe(500);
  });
});

describe('bounds', () => {
  it('caps open connections at the queue plus EXTRA_CONNECTIONS', async () => {
    await start(new FakeModel(), 2);
    expect(server!.maxConnections).toBe(2 + EXTRA_CONNECTIONS);
  });
});

describe('the other routes', () => {
  it('GET /health is 200', async () => {
    const base = await start();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('answers 404 for another path and 405 for another method', async () => {
    const base = await start();
    expect((await fetch(`${base}/v1/models`)).status).toBe(404);
    const get = await fetch(`${base}/v1/embeddings`);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect((await fetch(`${base}/health`, { method: 'POST' })).status).toBe(
      405,
    );
  });
});

describe('embeddingRequest', () => {
  it('reads the texts of a valid request', () => {
    expect(embeddingRequest({ model: 'm', input: ['a', 'b'] }, 'm')).toEqual({
      input: ['a', 'b'],
    });
    expect(
      embeddingRequest(
        { model: 'm', input: 'a', encoding_format: 'float' },
        'm',
      ),
    ).toEqual({ input: ['a'] });
  });
});

describe('RunQueue', () => {
  it('runs in order, one at a time, and goes on after a failure', async () => {
    const queue = new RunQueue(5);
    const order: string[] = [];
    let running = 0;
    const task =
      (name: string, fail = false) =>
      async () => {
        running++;
        expect(running).toBe(1);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(name);
        running--;
        if (fail) throw new Error(name);
        return name;
      };
    const results = await Promise.allSettled([
      queue.run(task('a')),
      queue.run(task('b', true)),
      queue.run(task('c')),
    ]);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(results.map((r) => r.status)).toEqual([
      'fulfilled',
      'rejected',
      'fulfilled',
    ]);
  });
});
