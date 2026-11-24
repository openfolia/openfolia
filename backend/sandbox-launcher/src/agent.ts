// The agent: the only process with access to the container runtime, on a private network with the
// launcher alone. It does three things, each with fixed options a caller cannot change: start a
// sandbox (its own internal network, the image's limits, the launcher joined to that network),
// remove one, and list this deployment's. Nothing else of the Docker API is reachable through it,
// so a launcher taken over by a visitor still cannot start another image, mount the host, publish
// a port or touch another container.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { type DockerApi, DockerError, expect } from './docker.js';
import type { Logger } from './log.js';
import {
  RuntimeFullError,
  SANDBOX_ID,
  SANDBOX_LANGS,
  type SandboxLang,
  type SandboxRuntime,
  type StartedSandbox,
} from './runtime.js';
import type { AgentSettings } from './settings.js';

const LABEL = 'org.openfolia.sandbox';
const INSTANCE_LABEL = 'org.openfolia.sandbox.instance';

/** Docker's sizes (`1g`, `256m`) in bytes. */
export function bytes(size: string): number {
  const match = /^(\d+)([kmg]?)$/.exec(size);
  if (!match) throw new Error(`no size: ${size}`);
  const unit = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[
    match[2] as '' | 'k' | 'm' | 'g'
  ];
  return Number(match[1]) * unit;
}

export class DockerRuntime implements SandboxRuntime {
  /** Starts under way: they count against the cap with the containers that exist. */
  private readonly pending = new Set<string>();

  constructor(
    private readonly docker: DockerApi,
    private readonly settings: AgentSettings,
    private readonly log: Logger,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** A sandbox's container and network share one name. */
  name(id: string): string {
    return `openfolia-sandbox-${this.settings.instance}-${id}`;
  }

  private labels(id: string): Record<string, string> {
    return { [LABEL]: id, [INSTANCE_LABEL]: this.settings.instance };
  }

  /** The container as the sandbox image's documentation runs it (deploy/README.md, "The sandbox image"). */
  containerSpec(id: string, lang: SandboxLang): Record<string, unknown> {
    const s = this.settings;
    const name = this.name(id);
    const env = {
      CCMS_SANDBOX_LANG: lang,
      CCMS_EDITOR_HOSTS: s.publicUrl.hostname,
      CCMS_SANDBOX_IDLE_MINUTES: String(s.idleMinutes),
      CCMS_SANDBOX_MAX_MINUTES: String(s.maxMinutes),
      ...s.sandboxEnv,
    };
    const memory = bytes(s.memory);
    return {
      Image: s.image,
      Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      Labels: this.labels(id),
      ExposedPorts: { '8080/tcp': {} },
      HostConfig: {
        NetworkMode: name,
        ReadonlyRootfs: true,
        Tmpfs: { '/tmp': `rw,size=${s.tmpfs},mode=1777` },
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        Memory: memory,
        MemorySwap: memory,
        NanoCpus: s.cpus * 1e9,
        PidsLimit: s.pids,
        LogConfig: {
          Type: 'local',
          Config: { 'max-size': '5m', 'max-file': '2' },
        },
        RestartPolicy: { Name: 'no' },
        Privileged: false,
        PublishAllPorts: false,
        Init: false,
      },
      NetworkingConfig: { EndpointsConfig: { [name]: {} } },
    };
  }

  async start(lang: SandboxLang, signal: AbortSignal): Promise<StartedSandbox> {
    const id = randomBytes(8).toString('hex');
    const name = this.name(id);
    // Counted before the list is read, so two starts at once cannot both pass the cap.
    this.pending.add(id);
    try {
      const counted = new Set([...(await this.list()), ...this.pending]);
      if (counted.size > this.settings.maxSandboxes)
        throw new RuntimeFullError('the cap is reached');
      // Internal: no route out. The sandbox and the launcher are its only members.
      expect(
        await this.docker.call(
          'POST',
          '/networks/create',
          {
            Name: name,
            Driver: 'bridge',
            Internal: true,
            Attachable: false,
            Labels: this.labels(id),
          },
          signal,
        ),
        'network create',
        201,
      );
      expect(
        await this.docker.call(
          'POST',
          `/networks/${name}/connect`,
          { Container: this.settings.launcherContainer },
          signal,
        ),
        'network connect',
        200,
      );
      expect(
        await this.docker.call(
          'POST',
          `/containers/create?name=${name}`,
          this.containerSpec(id, lang),
          signal,
        ),
        'container create',
        201,
      );
      expect(
        await this.docker.call(
          'POST',
          `/containers/${name}/start`,
          undefined,
          signal,
        ),
        'container start',
        204,
      );
      await this.healthy(name, signal);
      this.log.info('started', { sandbox: id, lang });
      return { id, url: `http://${name}:8080` };
    } catch (error) {
      if (error instanceof RuntimeFullError) throw error;
      this.log.error('start-failed', {
        sandbox: id,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.remove(id).catch(() => undefined);
      throw error;
    } finally {
      this.pending.delete(id);
    }
  }

  /** Waits for the image's own health check: the API is ready and the editor answers. */
  private async healthy(name: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      const state = expect(
        await this.docker.call(
          'GET',
          `/containers/${name}/json`,
          undefined,
          signal,
        ),
        'container inspect',
        200,
      ) as { State?: { Running?: boolean; Health?: { Status?: string } } };
      if (state.State?.Running === false)
        throw new Error('the sandbox ended while starting');
      if (state.State?.Health?.Status === 'healthy') return;
      if (state.State?.Health?.Status === 'unhealthy')
        throw new Error('the sandbox is unhealthy');
      await this.sleep(150);
    }
  }

  async remove(id: string): Promise<void> {
    if (!SANDBOX_ID.test(id)) throw new Error('no sandbox ID');
    const name = this.name(id);
    const signal = AbortSignal.timeout(60_000);
    expect(
      await this.docker.call(
        'DELETE',
        `/containers/${name}?force=true&v=true`,
        undefined,
        signal,
      ),
      'container remove',
      204,
      404,
    );
    // The launcher may not be on it (a network left from a start that failed): Docker says so
    // with a 500, which is as good as done.
    const disconnected = await this.docker.call(
      'POST',
      `/networks/${name}/disconnect`,
      { Container: this.settings.launcherContainer, Force: true },
      signal,
    );
    if (!notConnected(disconnected))
      expect(disconnected, 'network disconnect', 200, 404);
    expect(
      await this.docker.call('DELETE', `/networks/${name}`, undefined, signal),
      'network remove',
      204,
      404,
    );
    this.log.info('removed', { sandbox: id });
  }

  /** This deployment's sandboxes: every container or network with its label (one may outlive the other). */
  async list(): Promise<string[]> {
    const filters = encodeURIComponent(
      JSON.stringify({
        label: [`${INSTANCE_LABEL}=${this.settings.instance}`],
      }),
    );
    const containers = expect(
      await this.docker.call(
        'GET',
        `/containers/json?all=true&filters=${filters}`,
      ),
      'container list',
      200,
    ) as { Labels?: Record<string, string> }[];
    const networks = expect(
      await this.docker.call('GET', `/networks?filters=${filters}`),
      'network list',
      200,
    ) as {
      Labels?: Record<string, string>;
    }[];
    const ids = new Set<string>();
    for (const item of [...containers, ...networks]) {
      const id = item.Labels?.[LABEL];
      if (id && SANDBOX_ID.test(id)) ids.add(id);
    }
    return [...ids];
  }
}

function notConnected(answer: { status: number; body: unknown }): boolean {
  const message =
    answer.body && typeof answer.body === 'object' && 'message' in answer.body
      ? String((answer.body as { message: unknown }).message)
      : '';
  return answer.status === 500 && /is not connected to network/.test(message);
}

/** The agent's HTTP API for the launcher: the shared token, three routes. */
export function createAgentServer(
  runtime: SandboxRuntime,
  token: string,
  log: Logger,
): Server {
  const expected = Buffer.from(token);
  const authorised = (req: IncomingMessage) => {
    const given = Buffer.from(
      /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '',
    );
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  const send = (res: ServerResponse, status: number, body?: unknown) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(data),
    });
    res.end(data);
  };
  const server = createServer({ requestTimeout: 120_000 }, (req, res) => {
    const run = async () => {
      if (!authorised(req)) {
        log.error('refused', { reason: 'token' });
        return send(res, 401, { code: 'unauthorized' });
      }
      const path = new URL(req.url ?? '/', 'http://agent').pathname;
      if (path === '/sandboxes' && req.method === 'GET')
        return send(res, 200, { ids: await runtime.list() });
      if (path === '/sandboxes' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req as AsyncIterable<Buffer>) {
          size += chunk.length;
          if (size > 256) return send(res, 413, { code: 'too-large' });
          chunks.push(chunk);
        }
        let lang: unknown;
        try {
          lang = (
            JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              lang?: unknown;
            }
          ).lang;
        } catch {
          lang = undefined;
        }
        if (
          typeof lang !== 'string' ||
          !(SANDBOX_LANGS as readonly string[]).includes(lang)
        )
          return send(res, 400, { code: 'invalid-request' });
        const controller = new AbortController();
        res.on('close', () => {
          if (!res.writableFinished) controller.abort();
        });
        try {
          const started = await runtime.start(
            lang as SandboxLang,
            AbortSignal.any([controller.signal, AbortSignal.timeout(110_000)]),
          );
          return send(res, 201, started);
        } catch (error) {
          if (error instanceof RuntimeFullError)
            return send(res, 503, { code: 'full' });
          return send(res, 502, { code: 'start-failed' });
        }
      }
      const remove = /^\/sandboxes\/([0-9a-f]{16})$/.exec(path);
      if (remove && req.method === 'DELETE') {
        await runtime.remove(remove[1] as string);
        return send(res, 204);
      }
      return send(res, 404, { code: 'not-found' });
    };
    run().catch((error: unknown) => {
      log.error('request-failed', {
        error:
          error instanceof DockerError || error instanceof Error
            ? error.message
            : String(error),
      });
      if (!res.headersSent) send(res, 500, { code: 'internal-error' });
    });
  });
  server.on('upgrade', (_req, socket) => socket.destroy());
  return server;
}
