// A runtime without containers: each "sandbox" is a small HTTP server on the loopback that answers
// with its own ID and echoes what reached it, so tests can tell whose sandbox answered.
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  RuntimeFullError,
  type SandboxLang,
  type SandboxRuntime,
  type StartedSandbox,
} from '../src/runtime.js';

export interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

export class FakeRuntime implements SandboxRuntime {
  readonly servers = new Map<string, Server>();
  readonly seen = new Map<string, Seen[]>();
  readonly removed: string[] = [];
  readonly started: { id: string; lang: SandboxLang }[] = [];
  /** Set to make the next start fail, or say the runtime is full. */
  failNext: 'error' | 'full' | undefined;
  /** Extra IDs the runtime "has" that no start made (left from an earlier run). */
  readonly strays = new Set<string>();
  /** A start waits for this when set. */
  gate: Promise<void> | undefined;
  /** A request for `/hold…` to a sandbox waits for this when set. */
  hold: Promise<void> | undefined;
  /** URLs whose connection the launcher closed before the sandbox answered. */
  readonly dropped: string[] = [];

  async start(lang: SandboxLang): Promise<StartedSandbox> {
    await this.gate;
    const fail = this.failNext;
    this.failNext = undefined;
    if (fail === 'full') throw new RuntimeFullError('full');
    if (fail === 'error') throw new Error('the container did not start');
    const id = randomBytes(8).toString('hex');
    const seen: Seen[] = [];
    const server = createServer((req, res) => {
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: { ...req.headers },
      });
      req.resume();
      res.on('close', () => {
        if (!res.writableFinished) this.dropped.push(req.url ?? '');
      });
      req.on('end', async () => {
        if (req.url?.startsWith('/hold')) await this.hold;
        if (req.url === '/set-cookie') {
          res.setHeader('set-cookie', [
            '__Host-openfolia-demo=stolen; Path=/',
            'editor=1; Path=/',
          ]);
        }
        res.writeHead(200, {
          'content-type': 'text/plain',
          server: 'nginx',
          connection: 'keep-alive',
        });
        res.end(`sandbox ${id} (${lang}) ${req.method} ${req.url}`);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    this.servers.set(id, server);
    this.seen.set(id, seen);
    this.started.push({ id, lang });
    return { id, url: `http://127.0.0.1:${port}` };
  }

  async remove(id: string): Promise<void> {
    this.removed.push(id);
    this.strays.delete(id);
    const server = this.servers.get(id);
    this.servers.delete(id);
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async list(): Promise<string[]> {
    return [...this.servers.keys(), ...this.strays];
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.servers.keys()]) await this.remove(id);
  }
}

/** A clock the test moves. */
export function clock(start = Date.UTC(2026, 10, 24, 9, 0, 0)) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}
