import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PORTAL_ROOT } from '../build/run.ts';
import type { FixtureTokens } from '../testing/fixture-api.ts';

// Boots the API, and builds.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

interface ServedApi {
  readonly url: string;
  readonly tokens: FixtureTokens;
}

/** The fixture API in a process of its own (`testing/serve-fixture-api.ts`), stopped afterwards. */
async function withFixtureApi(
  use: (api: ServedApi) => Promise<void>,
): Promise<void> {
  const child = spawn(process.execPath, ['testing/serve-fixture-api.ts'], {
    cwd: PORTAL_ROOT,
    env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const exited = new Promise((done) => child.once('exit', done));
  try {
    const [line] = await Promise.race([
      createInterface({ input: child.stdout })
        [Symbol.asyncIterator]()
        .next()
        .then((r) => [r.value as string]),
      exited.then(() => {
        throw new Error('the fixture API stopped before it listened');
      }),
    ]);
    await use(JSON.parse(line!) as ServedApi);
  } finally {
    child.stdin.end();
    await exited;
  }
}

/**
 * The build as a deployment runs it (`scripts/build.ts`, the settings in its environment)
 * against the real API over the fixture release: a token that reads above the build's audience,
 * or may do more than read released content, is refused before any content is fetched or
 * written, and neither the log nor the output ever holds the token. (`portal:build` builds
 * the fixture sites the browser tests check, with the right tokens.)
 */
function build(
  settings: Record<string, string>,
): Promise<{ code: number | null; log: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['scripts/build.ts'], {
      cwd: PORTAL_ROOT,
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: process.env['HOME'] ?? '',
        ...settings,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (chunk: Buffer) => (log += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (log += chunk.toString()));
    child.on('error', fail);
    child.on('exit', (code) => done({ code, log }));
  });
}

describe('the portal build against the API', () => {
  let out: string;
  beforeEach(() => {
    out = mkdtempSync(join(tmpdir(), 'openfolia-portal-test-'));
    rmSync(out, { recursive: true });
  });
  afterEach(() => rmSync(out, { recursive: true, force: true }));

  const settings = (api: ServedApi, token: string, audience = 'public') => ({
    CCMS_PORTAL_API_URL: api.url,
    CCMS_PORTAL_TOKEN: token,
    CCMS_PORTAL_AUDIENCE: audience,
    CCMS_PORTAL_OUT_DIR: out,
  });

  it('refuses a token that reads above the audience, or may do more than read, and writes nothing', async () => {
    await withFixtureApi(async (api) => {
      const cases: [string, string, string][] = [
        [
          api.tokens.internal,
          'public',
          'reads up to "internal", above the build\'s audience "public"',
        ],
        [api.tokens.everything, 'public', 'reads every audience level'],
        [api.tokens.everything, 'internal', 'reads every audience level'],
        [api.tokens.drafts, 'public', 'holds content.read.draft'],
      ];
      for (const [token, audience, reason] of cases) {
        const { code, log } = await build(settings(api, token, audience));
        expect(code).toBe(1);
        expect(log).toContain(`Portal build failed: the token's role`);
        expect(log).toContain(reason);
        expect(log).not.toContain(token.slice(-64));
        expect(existsSync(out)).toBe(false);
      }
    });
  });

  it('refuses an audience the project does not configure, and a revoked or wrong token', async () => {
    await withFixtureApi(async (api) => {
      const unknown = await build(settings(api, api.tokens.public, 'everyone'));
      expect(unknown.code).toBe(1);
      expect(unknown.log).toContain(
        '"everyone" is not a configured audience level',
      );

      const wrong = `ccms_sat_${'0'.repeat(16)}_${'f'.repeat(64)}`;
      const denied = await build(settings(api, wrong));
      expect(denied.code).toBe(1);
      expect(denied.log).toContain('/me: the API answered 401');
      expect(denied.log).not.toContain('f'.repeat(64));
      expect(existsSync(out)).toBe(false);
    });
  });

  it('refuses to start without its settings, naming the setting only', async () => {
    const { code, log } = await build({ CCMS_PORTAL_AUDIENCE: 'public' });
    expect(code).toBe(1);
    expect(log).toContain(
      'Portal build failed: CCMS_PORTAL_API_URL: is required',
    );
  });
});
