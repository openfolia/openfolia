/** The rate limit on the stable addresses (#574): what its e2e specs share. */
import { execFileSync } from 'node:child_process';
import { GitWriter } from '@openfolia/content-repo';
import type { Actor } from '../src/access/core/actor.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

const publisher: Actor = {
  ...actorWith(['content.read', 'release.publish']),
  id: 'sample-publisher',
};
export const PAGE = '/d/north/operating/model=large/en';
export const ADDRESS = '/d/{product}/{manual}/{variant}/{lang}';

/** An app over a public project with one release of `north`, and `env` set. */
export const appWith = async (
  env: Record<string, string>,
): Promise<TestApp> => {
  const t = await createTestApp({
    CCMS_PUBLIC_URL: 'https://docs.example.com/',
    ...env,
  });
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
  return t;
};

/** A request without a token, claiming to come from `forwardedFor` (`X-Forwarded-For`). */
export const anonymous = (t: TestApp, path: string, forwardedFor?: string) => {
  const req = t.anonymous().get(path).set('Accept', '*/*').redirects(0);
  return forwardedFor === undefined
    ? req
    : req.set('X-Forwarded-For', forwardedFor);
};

export const expectLimited = (res: {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}) => {
  expect(res.status).toBe(429);
  const wait = Number(res.headers['retry-after']);
  expect(wait).toBeGreaterThanOrEqual(1);
  expect(wait).toBeLessThanOrEqual(60);
  const [error] = ErrorDocument.parse(res.body).errors;
  expect(error?.code).toBe('rate-limited');
  expect(error?.meta).toEqual({ retryAfter: wait });
};
