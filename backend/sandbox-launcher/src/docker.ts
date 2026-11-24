// The Docker Engine API over its Unix socket: only the calls the agent makes (containers and
// networks: create, start, inspect, list, remove; connect a container to a network). Plain HTTP
// on the socket, no client library.
import { request } from 'node:http';

const API = '/v1.44';

export class DockerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface DockerApi {
  call(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<{ status: number; body: unknown }>;
}

export class DockerSocket implements DockerApi {
  constructor(private readonly socketPath: string) {}

  call(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<{ status: number; body: unknown }> {
    const data = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          path: `${API}${path}`,
          method,
          signal: signal ?? AbortSignal.timeout(60_000),
          headers: {
            host: 'docker',
            ...(data
              ? {
                  'content-type': 'application/json',
                  'content-length': Buffer.byteLength(data),
                }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({ status: res.statusCode ?? 0, body: parse(text) });
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end(data);
    });
  }
}

function parse(text: string): unknown {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return text;
  }
}

/** Throws unless the status is one of `ok`. */
export function expect(
  answer: { status: number; body: unknown },
  what: string,
  ...ok: number[]
): unknown {
  if (ok.includes(answer.status)) return answer.body;
  const message =
    answer.body && typeof answer.body === 'object' && 'message' in answer.body
      ? String((answer.body as { message: unknown }).message)
      : '';
  throw new DockerError(
    answer.status,
    `${what}: ${answer.status} ${message}`.trim(),
  );
}
