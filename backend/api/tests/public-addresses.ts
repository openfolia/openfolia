/** A public stable address read with and without credentials (#608): what its e2e specs share. */
import { execFileSync } from 'node:child_process';
import { GitWriter } from '@openfolia/content-repo';
import { SESSION_COOKIE } from '../src/access/api/session-cookies.js';
import type { Actor } from '../src/access/core/actor.js';
import { PASSWORD_PROVIDER } from '../src/access/core/passwords.js';
import { mintSessionToken, SessionStore } from '../src/access/core/sessions.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import { UnitOfWork } from '../src/base/core/unit-of-work.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

const publisher: Actor = {
  ...actorWith(['content.read', 'release.publish']),
  id: 'sample-publisher',
};

/** The operating manual (public; at the release, an internal module in it too) and the service manual (internal). */
export const PAGE = '/d/north/operating/model=large/en';
export const INTERNAL = '/d/north/service/model=large/en';

/**
 * An app with `env` over a public project with one release of `north`, a person who reads
 * everything (`pat`) and that person's session (`cookie`, the `Cookie` header).
 */
export async function publicApp(
  env: Record<string, string>,
): Promise<{ t: TestApp; cookie: string }> {
  const t = await createTestApp({
    CCMS_PUBLIC_URL: 'https://docs.example.com/',
    ...env,
  });
  await seedAccess(
    t.database,
    Seed.parse({
      roles: [
        {
          id: 'everything',
          name: 'Reads everything',
          permissions: ['content.read'],
          scope: {},
        },
      ],
      users: [{ id: 'pat', name: 'Pat Example', roles: ['everything'] }],
    }),
  );
  const minted = mintSessionToken();
  await t.app.get(UnitOfWork).run((tx) =>
    t.app.get(SessionStore).create(tx, {
      hash: minted.hash,
      userId: 'pat',
      provider: PASSWORD_PROVIDER,
      endedBefore: new Date(0),
    }),
  );
  const dir = process.env['CCMS_CONTENT_DIR'] as string;
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  await new GitWriter(dir).commit({
    branch: 'main',
    parent: git('rev-parse', 'refs/heads/main'),
    changes: [
      {
        path: 'openfolia.yaml',
        content: `${git('show', 'main:openfolia.yaml').trimEnd()}\ndelivery:\n  access: public\n`,
      },
    ],
    message: 'Public addresses',
    author: { name: 'Someone', email: 'someone@example.com' },
  });
  t.actAs(publisher);
  const res = await t.post('/releases').send(
    JSON.stringify({
      data: {
        type: 'Release',
        attributes: { product: 'north', revision: '1' },
      },
    }),
  );
  expect(res.status).toBe(201);
  t.actAs(undefined);
  return { t, cookie: `${SESSION_COOKIE}=${minted.token}` };
}

export const get = (t: TestApp, path: string) =>
  t.anonymous().get(path).set('Accept', '*/*').redirects(0);

/** What a cache sees of an answer. */
export const seen = (res: {
  status: number;
  text: string;
  headers: Record<string, string>;
}) => ({
  status: res.status,
  text: res.text,
  cacheControl: res.headers['cache-control'],
  vary: res.headers['vary'],
  setCookie: res.headers['set-cookie'],
});
