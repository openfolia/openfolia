// The port to whatever runs the sandboxes: the agent (agent.ts) in a deployment, a fake in tests.
// The launcher holds no access to the container runtime itself.
import { request } from 'node:http';

export type SandboxLang = 'en' | 'de';
export const SANDBOX_LANGS: readonly SandboxLang[] = ['en', 'de'];

/**
 * The launcher's route that ends the visitor's own sandbox (#846): the agent gives each sandbox
 * this path as `CCMS_SANDBOX_END_URL`, so the editor's banner offers "End demo". A path on the
 * public origin the editor shares with the launcher.
 */
export const END_PATH = '/_demo/api/end';

/** A sandbox's ID, as the agent makes it: 16 lowercase hex digits. */
export const SANDBOX_ID = /^[0-9a-f]{16}$/;

export interface StartedSandbox {
  readonly id: string;
  /** Where the launcher reaches the sandbox's port 8080 (on the sandbox's own network). */
  readonly url: string;
}

export class RuntimeFullError extends Error {}

export interface SandboxRuntime {
  /** Starts a sandbox and resolves once it is healthy; removes it again on any failure. */
  start(lang: SandboxLang, signal: AbortSignal): Promise<StartedSandbox>;
  /** Removes a sandbox and its network; nothing when it is gone already. */
  remove(id: string): Promise<void>;
  /** The IDs of every sandbox of this deployment that exists, healthy or not. */
  list(): Promise<string[]>;
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

/** The agent's API over HTTP on the private network, with the shared token. */
export class AgentRuntime implements SandboxRuntime {
  constructor(
    private readonly base: URL,
    private readonly token: string,
  ) {}

  async start(lang: SandboxLang, signal: AbortSignal): Promise<StartedSandbox> {
    const { status, body } = await this.call(
      'POST',
      '/sandboxes',
      { lang },
      signal,
    );
    if (status === 503) throw new RuntimeFullError('the agent has no room');
    if (status !== 201)
      throw new Error(`the agent answered ${status} to a start`);
    const { id, url } = body as { id?: unknown; url?: unknown };
    if (
      typeof id !== 'string' ||
      !SANDBOX_ID.test(id) ||
      typeof url !== 'string'
    )
      throw new Error('the agent answered a start without an ID and address');
    return { id, url };
  }

  async remove(id: string): Promise<void> {
    if (!SANDBOX_ID.test(id)) throw new Error('no sandbox ID');
    const { status } = await this.call(
      'DELETE',
      `/sandboxes/${id}`,
      undefined,
      AbortSignal.timeout(30_000),
    );
    if (status !== 204)
      throw new Error(`the agent answered ${status} to a removal`);
  }

  async list(): Promise<string[]> {
    const { status, body } = await this.call(
      'GET',
      '/sandboxes',
      undefined,
      AbortSignal.timeout(15_000),
    );
    if (status !== 200)
      throw new Error(`the agent answered ${status} to a list`);
    const ids = (body as { ids?: unknown }).ids;
    if (!Array.isArray(ids))
      throw new Error('the agent answered a list without IDs');
    return ids.filter(
      (id): id is string => typeof id === 'string' && SANDBOX_ID.test(id),
    );
  }

  private call(
    method: string,
    path: string,
    payload: unknown,
    signal: AbortSignal,
  ): Promise<{ status: number; body: unknown }> {
    const data = payload === undefined ? undefined : JSON.stringify(payload);
    return new Promise((resolve, reject) => {
      const req = request(
        new URL(path, this.base),
        {
          method,
          signal,
          headers: {
            authorization: `Bearer ${this.token}`,
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
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 64 * 1024)
              req.destroy(new Error('the agent answered too much'));
            else chunks.push(chunk);
          });
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({ status: res.statusCode ?? 0, body: parseJson(text) });
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end(data);
    });
  }
}
