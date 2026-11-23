// `pnpm nx build portal`: the portal built end to end from the fixture content repository
// (testing/fixture-repo.ts) through the real API, booted in this process (testing/fixture-api.ts):
// a public site in English and German and an internal one in English, in dist-fixture/, which
// the browser tests (e2e/) check. The API has a branding (testing/fixture-brand.ts): the internal
// site shows it, the public one is built with the branding off and shows the default look. Each build runs `scripts/build.ts` in a process of its own,
// as a deployment does, with the token in its environment only; its output (the log) and its
// files are searched for the token afterwards.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { refuseToken, PORTAL_ROOT } from '../build/run.ts';
import { withFixtureApi } from '../testing/fixture-api.ts';
import { fixtureBranding } from '../testing/fixture-brand.ts';

const OUT = join(PORTAL_ROOT, 'dist-fixture');

function build(env: Record<string, string>, token: string): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['scripts/build.ts'], {
      cwd: PORTAL_ROOT,
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: process.env['HOME'] ?? '',
        ...env,
        CCMS_PORTAL_TOKEN: token,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (chunk: Buffer) => (log += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (log += chunk.toString()));
    child.on('error', fail);
    child.on('exit', (code) => {
      process.stdout.write(log);
      if (log.includes(token) || log.includes(token.slice(-64)))
        return fail(new Error('the build log holds the token'));
      if (code !== 0)
        return fail(
          new Error(`the ${env['CCMS_PORTAL_AUDIENCE']} build failed`),
        );
      done();
    });
  });
}

// Drawn before the API starts, which narrows the formats the image library reads.
const branding = await fixtureBranding();
await withFixtureApi(async (api) => {
  const common = { CCMS_PORTAL_API_URL: api.url.href };
  await api.brand(branding);
  await build(
    {
      ...common,
      CCMS_PORTAL_BRANDING: 'off',
      CCMS_PORTAL_AUDIENCE: 'public',
      CCMS_PORTAL_LANGUAGES: 'en,de',
      CCMS_PORTAL_OUT_DIR: join(OUT, 'public'),
    },
    api.tokens.public,
  );
  await build(
    {
      ...common,
      CCMS_PORTAL_AUDIENCE: 'internal',
      CCMS_PORTAL_LANGUAGES: 'en',
      CCMS_PORTAL_OUT_DIR: join(OUT, 'internal'),
    },
    api.tokens.internal,
  );
  for (const token of Object.values(api.tokens)) refuseToken(OUT, token);
});
