// `pnpm nx build portal`: the portal built end to end from the fixture content repository
// (testing/fixture-repo.ts) through the real API, booted in this process (testing/fixture-api.ts):
// a public site and an internal one, each in English and German, in dist-fixture/, which
// the browser tests (e2e/) check. The API has a branding (testing/fixture-brand.ts): the internal
// site shows it, the public one is built with the branding off and shows the default look. Each build runs `scripts/build.ts` in a process of its own,
// as a deployment does, with the token in its environment only; its output (the log) and its
// files are searched for the token afterwards. Both sites have the authored start page (#897); a third, `plain`,
// is built from a release without it and keeps the default one. Each build's log is kept beside its site
// (`<site>.log`) for the browser tests' checks of what it reported.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { refuseToken, PORTAL_ROOT } from '../build/run.ts';
import { withFixtureApi } from '../testing/fixture-api.ts';
import { fixtureBranding } from '../testing/fixture-brand.ts';
import {
  INTERNAL_START,
  PORTAL_ORIGIN,
  START_MANUAL,
} from '../testing/fixture-repo.ts';

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
      mkdirSync(OUT, { recursive: true });
      writeFileSync(`${env['CCMS_PORTAL_OUT_DIR']}.log`, log);
      done();
    });
  });
}

// Drawn before the API starts, which narrows the formats the image library reads.
const branding = await fixtureBranding();
await withFixtureApi(async (api) => {
  const common = {
    CCMS_PORTAL_API_URL: api.url.href,
    CCMS_PORTAL_START: `${INTERNAL_START}, ${START_MANUAL}`,
    CCMS_PORTAL_URL: PORTAL_ORIGIN,
  };
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
      // Both languages: the update guide (#907) is internal, and is checked in each.
      CCMS_PORTAL_LANGUAGES: 'en,de',
      // Alpha's older releases beside its newest (#896); the public site keeps the default (the
      // newest only), as every deployment that does not set it.
      CCMS_PORTAL_RELEASES_PER_PRODUCT: '3',
      CCMS_PORTAL_OUT_DIR: join(OUT, 'internal'),
    },
    api.tokens.internal,
  );
  await build(
    {
      ...common,
      CCMS_PORTAL_BRANDING: 'off',
      CCMS_PORTAL_AUDIENCE: 'public',
      CCMS_PORTAL_LANGUAGES: 'en',
      // Alpha's oldest release, from before the start page was written.
      CCMS_PORTAL_RELEASES: api.releases.at(-1)!,
      CCMS_PORTAL_OUT_DIR: join(OUT, 'plain'),
    },
    api.tokens.public,
  );
  for (const token of Object.values(api.tokens)) refuseToken(OUT, token);
});
