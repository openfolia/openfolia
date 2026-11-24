// The agent against a recorded Docker API: the options every sandbox gets, the cap, the clean-up,
// and its own HTTP API's refusals.
import type { AddressInfo } from 'node:net';
import { bytes, createAgentServer, DockerRuntime } from '../src/agent.js';
import type { DockerApi } from '../src/docker.js';
import { silentLogger } from '../src/log.js';
import { agentSettings } from '../src/settings.js';
import { FakeRuntime } from './fakes.js';

const settings = agentSettings({
  CCMS_LAUNCHER_PUBLIC_URL: 'https://demo.example.org',
  CCMS_LAUNCHER_AGENT_TOKEN: 't'.repeat(40),
  CCMS_LAUNCHER_SANDBOX_IMAGE: 'ghcr.io/example/openfolia/sandbox:v1.0.0',
  CCMS_LAUNCHER_CONTAINER: 'demo-launcher',
  CCMS_LAUNCHER_PORTAL_URL: 'https://manuals.demo.example.org/',
  CCMS_LAUNCHER_MAX_SANDBOXES: '2',
});

/** A Docker that records the calls and keeps containers and networks by name. */
class RecordedDocker implements DockerApi {
  readonly calls: { method: string; path: string; body?: unknown }[] = [];
  readonly containers = new Map<string, Record<string, string>>();
  readonly networks = new Map<string, Record<string, string>>();
  /** The networks the launcher's container is on. */
  readonly connected = new Set<string>();
  health = 'healthy';

  async call(method: string, path: string, body?: unknown) {
    this.calls.push({ method, path, body });
    const name = /\/(?:containers|networks)\/([^/?]+)/.exec(path)?.[1] ?? '';
    if (method === 'POST' && path === '/networks/create') {
      const b = body as { Name: string; Labels: Record<string, string> };
      this.networks.set(b.Name, b.Labels);
      return { status: 201, body: {} };
    }
    if (method === 'POST' && path.startsWith('/containers/create')) {
      const n = /name=([^&]+)/.exec(path)![1]!;
      this.containers.set(
        n,
        (body as { Labels: Record<string, string> }).Labels,
      );
      return { status: 201, body: {} };
    }
    if (method === 'POST' && path.endsWith('/start'))
      return { status: 204, body: undefined };
    if (method === 'POST' && path.endsWith('/connect')) {
      this.connected.add(name);
      return { status: 200, body: undefined };
    }
    if (method === 'POST' && path.endsWith('/disconnect')) {
      if (!this.networks.has(name)) return { status: 404, body: undefined };
      if (!this.connected.delete(name))
        return {
          status: 500,
          body: {
            message: `container 4746 is not connected to network ${name}`,
          },
        };
      return { status: 200, body: undefined };
    }
    if (
      method === 'GET' &&
      path.endsWith('/json') &&
      path.startsWith('/containers/')
    )
      return {
        status: 200,
        body: { State: { Running: true, Health: { Status: this.health } } },
      };
    if (method === 'GET' && path.startsWith('/containers/json'))
      return {
        status: 200,
        body: [...this.containers.values()].map((Labels) => ({ Labels })),
      };
    if (method === 'GET' && path.startsWith('/networks?'))
      return {
        status: 200,
        body: [...this.networks.values()].map((Labels) => ({ Labels })),
      };
    if (method === 'DELETE' && path.startsWith('/containers/'))
      return {
        status: this.containers.delete(name) ? 204 : 404,
        body: undefined,
      };
    if (method === 'DELETE' && path.startsWith('/networks/'))
      return {
        status: this.networks.delete(name) ? 204 : 404,
        body: undefined,
      };
    return { status: 500, body: { message: `unexpected ${method} ${path}` } };
  }
}

describe('the agent', () => {
  it('starts a sandbox on an internal network of its own, with every limit, the launcher its only other member', async () => {
    const docker = new RecordedDocker();
    const runtime = new DockerRuntime(
      docker,
      settings,
      silentLogger,
      async () => undefined,
    );
    const started = await runtime.start('de', AbortSignal.timeout(1000));
    const name = `openfolia-sandbox-demo-${started.id}`;
    expect(started.url).toBe(`http://${name}:8080`);
    const network = docker.calls.find(
      (c) => c.path === '/networks/create',
    )!.body;
    expect(network).toMatchObject({
      Name: name,
      Internal: true,
      Driver: 'bridge',
      Attachable: false,
    });
    expect(docker.calls.find((c) => c.path.endsWith('/connect'))).toEqual({
      method: 'POST',
      path: `/networks/${name}/connect`,
      body: { Container: 'demo-launcher' },
    });
    const container = docker.calls.find((c) =>
      c.path.startsWith('/containers/create'),
    )!.body as {
      Image: string;
      Env: string[];
      HostConfig: Record<string, unknown>;
    };
    expect(container.Image).toBe('ghcr.io/example/openfolia/sandbox:v1.0.0');
    expect(container.Env).toEqual(
      expect.arrayContaining([
        'CCMS_SANDBOX_LANG=de',
        'CCMS_EDITOR_HOSTS=demo.example.org',
        'CCMS_SANDBOX_IDLE_MINUTES=30',
        'CCMS_SANDBOX_MAX_MINUTES=90',
      ]),
    );
    expect(container.HostConfig).toMatchObject({
      NetworkMode: name,
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': 'rw,size=256m,mode=1777' },
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Memory: 1024 ** 3,
      MemorySwap: 1024 ** 3,
      NanoCpus: 1e9,
      PidsLimit: 256,
      LogConfig: {
        Type: 'local',
        Config: { 'max-size': '5m', 'max-file': '2' },
      },
      Privileged: false,
      PublishAllPorts: false,
    });
    // Nothing of the host: no mounts, no published ports, no extra capability or device.
    for (const key of [
      'Binds',
      'Mounts',
      'PortBindings',
      'CapAdd',
      'Devices',
      'VolumesFrom',
    ])
      expect(container.HostConfig[key], key).toBeUndefined();
    expect(await runtime.list()).toEqual([started.id]);
  });

  it('refuses past the cap and removes what a failed start left', async () => {
    const docker = new RecordedDocker();
    const runtime = new DockerRuntime(
      docker,
      settings,
      silentLogger,
      async () => undefined,
    );
    await runtime.start('en', AbortSignal.timeout(1000));
    await runtime.start('en', AbortSignal.timeout(1000));
    await expect(
      runtime.start('en', AbortSignal.timeout(1000)),
    ).rejects.toThrow(/cap/);
    docker.health = 'unhealthy';
    const [one] = await runtime.list();
    await runtime.remove(one!);
    await expect(
      runtime.start('en', AbortSignal.timeout(1000)),
    ).rejects.toThrow(/unhealthy/);
    expect(await runtime.list()).toHaveLength(1);
    expect(docker.networks.size).toBe(1);
  });

  it('removes a sandbox whose container is gone already', async () => {
    const docker = new RecordedDocker();
    const runtime = new DockerRuntime(
      docker,
      settings,
      silentLogger,
      async () => undefined,
    );
    const { id } = await runtime.start('en', AbortSignal.timeout(1000));
    docker.containers.clear();
    expect(await runtime.list()).toEqual([id]);
    await runtime.remove(id);
    expect(await runtime.list()).toEqual([]);
    await expect(runtime.remove('../../etc')).rejects.toThrow();
  });

  it('removes a network left without the launcher on it', async () => {
    const docker = new RecordedDocker();
    const runtime = new DockerRuntime(
      docker,
      settings,
      silentLogger,
      async () => undefined,
    );
    const name = runtime.name('00000000000000aa');
    docker.networks.set(name, {
      'org.openfolia.sandbox': '00000000000000aa',
      'org.openfolia.sandbox.instance': 'demo',
    });
    expect(await runtime.list()).toEqual(['00000000000000aa']);
    await runtime.remove('00000000000000aa');
    expect(await runtime.list()).toEqual([]);
  });

  it('reads Docker sizes', () => {
    expect(bytes('256m')).toBe(256 * 1024 ** 2);
    expect(bytes('1g')).toBe(1024 ** 3);
    expect(() => bytes('1t')).toThrow();
  });

  describe('its API', () => {
    async function serve() {
      const runtime = new FakeRuntime();
      const server = createAgentServer(runtime, 'x'.repeat(40), silentLogger);
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const call = (
        path: string,
        init: RequestInit = {},
        token = 'x'.repeat(40),
      ) =>
        fetch(`${base}${path}`, {
          ...init,
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
        });
      return { runtime, server, call };
    }

    it('answers only the shared token', async () => {
      const { server, call, runtime } = await serve();
      expect((await call('/sandboxes', {}, 'y'.repeat(40))).status).toBe(401);
      expect((await call('/sandboxes', {}, '')).status).toBe(401);
      expect((await call('/sandboxes')).status).toBe(200);
      server.close();
      await runtime.stopAll();
    });

    it('starts, lists and removes, and nothing else', async () => {
      const { server, call, runtime } = await serve();
      const started = await call('/sandboxes', {
        method: 'POST',
        body: '{"lang":"de"}',
      });
      expect(started.status).toBe(201);
      const { id } = (await started.json()) as { id: string };
      expect(await (await call('/sandboxes')).json()).toEqual({ ids: [id] });
      expect(
        (await call('/sandboxes', { method: 'POST', body: '{"lang":"fr"}' }))
          .status,
      ).toBe(400);
      expect(
        (
          await call('/sandboxes', {
            method: 'POST',
            body: '{"lang":"en","image":"alpine"}',
          })
        ).status,
      ).toBe(201);
      expect(runtime.started.map((s) => s.lang)).toEqual(['de', 'en']);
      expect(
        (await call('/sandboxes/..%2F..', { method: 'DELETE' })).status,
      ).toBe(404);
      expect((await call('/containers/json')).status).toBe(404);
      expect(
        (await call(`/sandboxes/${id}`, { method: 'DELETE' })).status,
      ).toBe(204);
      runtime.failNext = 'full';
      expect(
        (await call('/sandboxes', { method: 'POST', body: '{"lang":"en"}' }))
          .status,
      ).toBe(503);
      server.close();
      await runtime.stopAll();
    });
  });
});
