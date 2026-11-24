// @vitest-environment node
// The docs image (deploy/docker/docs/) built from a small stand-in site and run, when Docker is
// available: clean addresses, the 404 page, cache headers, compression, the security headers,
// the health check, an unprivileged user on a read-only file system with no capabilities.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');

function docker(args: string[], timeout = 60_000): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function dockerAvailable(): boolean {
  try {
    docker(['info', '--format', '{{.ServerVersion}}'], 15_000);
    docker(['buildx', 'version'], 15_000);
    return true;
  } catch {
    return false;
  }
}

const available = dockerAvailable();
if (!available)
  console.warn(
    'docs-image.test: skipped, Docker (with buildx) is not available on this machine',
  );

/** Enough text that compression applies (Caddy compresses from 512 bytes). */
const filler = 'OpenFolia docs. '.repeat(100);

const SITE: Record<string, string> = {
  'index.html': `<!doctype html><title>Home</title><p>${filler}</p>`,
  '404.html':
    '<!doctype html><title>404: This page could not be found.</title>',
  'guide/writing/index.html': '<!doctype html><title>Writing</title>',
  'de/guide/writing/index.html':
    '<!doctype html><html lang="de"><title>Schreiben</title>',
  'standalone.html': '<!doctype html><title>Standalone</title>',
  'llms.txt': `# OpenFolia\n${filler}`,
  'search.json': '{"pages":[]}',
  'guide/writing.md': '# Writing',
  '_next/static/chunks/abc123.js': `console.log(${JSON.stringify(filler)});`,
  '.hidden': 'never served',
};

describe.skipIf(!available)('the docs image', () => {
  const id = randomBytes(4).toString('hex');
  const image = `openfolia-docs-test:${id}`;
  const container = `openfolia-docs-test-${id}`;
  let site = '';
  let base = '';

  beforeAll(async () => {
    site = mkdtempSync(join(tmpdir(), 'docs-image-site-'));
    for (const [file, text] of Object.entries(SITE)) {
      mkdirSync(dirname(join(site, file)), { recursive: true });
      writeFileSync(join(site, file), text);
    }
    docker(
      [
        'buildx',
        'build',
        '--file',
        join(root, 'deploy/docker/docs/Dockerfile'),
        '--build-context',
        `site=${site}`,
        '--tag',
        image,
        '--load',
        '--quiet',
        root,
      ],
      600_000,
    );
    docker([
      'run',
      '--detach',
      '--name',
      container,
      '--read-only',
      '--tmpfs',
      '/tmp',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--publish',
      '127.0.0.1::8080',
      image,
    ]);
    const port = docker(['port', container, '8080/tcp'])
      .trim()
      .split(':')
      .at(-1);
    base = `http://127.0.0.1:${port}`;
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`${base}/healthz`)).ok) break;
      } catch {
        // not listening yet
      }
      if (i > 100) throw new Error(docker(['logs', container]));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, 660_000);

  afterAll(() => {
    try {
      docker(['rm', '--force', container]);
    } catch {
      // never started
    }
    try {
      docker(['image', 'rm', '--force', image]);
    } catch {
      // never built
    }
    if (site) rmSync(site, { recursive: true, force: true });
  });

  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { headers, redirect: 'manual' });

  it('serves the start page, revalidated, with the security headers', async () => {
    const response = await get('/');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<title>Home</title>');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    // The API reference sends no requests to an instance (#858): only the site itself.
    expect(csp).toContain("connect-src 'self';");
    expect(csp).toContain("object-src 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe(
      'strict-origin-when-cross-origin',
    );
    expect(response.headers.get('server')).toBeNull();
  });

  it('serves clean addresses: a folder by its address with a slash, a file without .html', async () => {
    const redirect = await get('/guide/writing');
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get('location')).toBe('/guide/writing/');
    expect(await (await get('/guide/writing/')).text()).toContain('Writing');
    expect(await (await get('/de/guide/writing/')).text()).toContain(
      'Schreiben',
    );
    const file = await get('/standalone');
    expect(file.status).toBe(200);
    expect(await file.text()).toContain('Standalone');
  });

  it('serves the machine-readable files, revalidated', async () => {
    for (const [path, type] of [
      ['/llms.txt', 'text/plain'],
      ['/search.json', 'application/json'],
      ['/guide/writing.md', 'text/markdown'],
    ]) {
      const response = await get(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toContain(type);
      expect(response.headers.get('cache-control'), path).toBe('no-cache');
    }
  });

  it('caches the hashed build files for a year', async () => {
    const response = await get('/_next/static/chunks/abc123.js');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    );
  });

  it("answers an unknown path with the site's 404 page and status 404, with its headers", async () => {
    for (const path of [
      '/no/such/page',
      '/de/no-such-page',
      '/_next/static/gone.js',
    ]) {
      const response = await get(path);
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).toContain(
        'This page could not be found',
      );
      expect(response.headers.get('content-security-policy'), path).toContain(
        "frame-ancestors 'none'",
      );
      expect(response.headers.get('cache-control'), path).toBe('no-cache');
    }
    expect((await get('/.hidden')).status).toBe(404);
  });

  it('compresses with zstd and gzip', async () => {
    for (const encoding of ['zstd', 'gzip']) {
      const response = await get('/', { 'accept-encoding': encoding });
      expect(response.headers.get('content-encoding'), encoding).toBe(encoding);
      await response.arrayBuffer();
    }
  });

  it('runs as an unprivileged user, with a health check and no build tools', () => {
    expect(docker(['exec', container, 'id', '-u']).trim()).toBe('10001');
    docker([
      'exec',
      container,
      'wget',
      '-q',
      '-O',
      '/dev/null',
      'http://127.0.0.1:8080/healthz',
    ]);
    const config = JSON.parse(
      docker(['image', 'inspect', '--format', '{{json .Config}}', image]),
    );
    expect(config.User).toBe('10001:10001');
    expect(config.Healthcheck.Test.join(' ')).toContain('/healthz');
    const tools = docker([
      'exec',
      container,
      'sh',
      '-c',
      'for t in gcc cc make node npm git go setcap; do command -v "$t"; done; true',
    ]).trim();
    expect(tools).toBe('');
  });
});
