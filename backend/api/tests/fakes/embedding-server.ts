import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { conceptVector } from './concept-embedder.js';

/**
 * A local embeddings endpoint (`{ model, input }` in, `{ data: [{
 * embedding, index }] }` out) answering `conceptVector`s, for tests of
 * `HttpEmbedder` and of semantic search end to end. `handle` replaces the
 * answer; every request is kept.
 */
export interface EmbeddingServer {
  readonly url: string;
  readonly received: { headers: IncomingMessage['headers']; body: string }[];
  handle: (req: IncomingMessage, res: ServerResponse, body: string) => void;
  close(): Promise<void>;
}

/** Answers with concept vectors of the texts it was sent. */
export function conceptAnswer(
  _req: IncomingMessage,
  res: ServerResponse,
  body: string,
): void {
  const { input } = JSON.parse(body) as { input: string[] };
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify({
      data: input.map((text, index) => ({
        index,
        embedding: conceptVector(text),
      })),
    }),
  );
}

export async function embeddingServer(): Promise<EmbeddingServer> {
  const received: EmbeddingServer['received'] = [];
  const state = { handle: conceptAnswer };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      state.handle(req, res, body);
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1/embeddings`,
    received,
    get handle() {
      return state.handle;
    },
    set handle(handle) {
      state.handle = handle;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
