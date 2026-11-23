import { Logger } from '@nestjs/common';
import { ActorDocument } from '../src/access/api/access.resources.js';
import { SESSION_COOKIE } from '../src/access/api/session-cookies.js';
import { FirstAdminAtStart } from '../src/access/repos/first-admin-at-start.js';
import { signInLinks } from '../src/access/repos/passwords.tables.js';
import { JSON_API } from '../src/base/api/json-api.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * The first admin from the environment (#373), end to end: the API's first start on an empty
 * instance makes `CCMS_FIRST_ADMIN_EMAIL` an admin and logs their one-time link; the link sets
 * their password and signs them in, once; a later start does nothing.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const ORIGIN = 'https://docs.example.com';
const PASSWORD = 'a long and quiet river';

let t: TestApp;
let logged: string[];

beforeAll(async () => {
  logged = [];
  vi.spyOn(Logger.prototype, 'log').mockImplementation(function (
    this: Logger,
    message: unknown,
  ) {
    logged.push(String(message));
  });
  t = await createTestApp({
    CCMS_PASSWORD_SIGN_IN: 'on',
    CCMS_PUBLIC_URL: `${ORIGIN}/`,
    CCMS_FIRST_ADMIN_EMAIL: 'first@example.org',
    CCMS_FIRST_ADMIN_NAME: 'First Admin',
  });
});
afterAll(async () => {
  vi.restoreAllMocks();
  await t?.close();
});

const post = (path: string, body: unknown) =>
  t
    .anonymous()
    .post(path)
    .set('Content-Type', JSON_API)
    .set('Origin', ORIGIN)
    .send(JSON.stringify(body));

const setPassword = (token: string) =>
  post('/auth/password/set', {
    data: { type: 'PasswordSet', attributes: { token, password: PASSWORD } },
  });

const cookieOf = (res: { headers: Record<string, unknown> }) =>
  (res.headers['set-cookie'] as string[] | undefined)
    ?.find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.split(';', 1)[0];

describe('the first admin from CCMS_FIRST_ADMIN_EMAIL (#373)', () => {
  let token: string;

  it('is made on the first start, with their one-time link in the log', () => {
    expect(logged).toContainEqual(
      expect.stringContaining(
        'Made the first admin first@example.org (user "first")',
      ),
    );
    const line = logged.find((l) => l.includes('/set-password#'));
    const match =
      /(https:\/\/docs\.example\.com\/set-password#(ccms_pwl_[0-9a-f]{64}))$/.exec(
        line ?? '',
      );
    expect(match, line).not.toBeNull();
    token = match![2]!;
  });

  it('sets their password through the link, once, and they are the admin', async () => {
    const set = await setPassword(token).expect(200);
    const cookie = cookieOf(set);
    expect(cookie).toBeDefined();
    const me = await t
      .anonymous()
      .get('/me')
      .set('Cookie', cookie!)
      .expect(200);
    const actor = ActorDocument.parse(me.body).data;
    expect(actor.id).toBe('first');
    expect(actor.attributes.name).toBe('First Admin');
    expect(actor.attributes.roles.map((r) => r.id)).toEqual(['admin']);
    expect(actor.meta.permissions.map((p) => p.permission)).toContain(
      'admin.roles',
    );
    expect((await setPassword(token)).status).not.toBe(200);
    await post('/auth/password/sign-in', {
      data: {
        type: 'PasswordSignIn',
        attributes: { email: 'first@example.org', password: PASSWORD },
      },
    }).expect(200);
  });

  it('does nothing on a later start: the instance has a user', async () => {
    logged.length = 0;
    const before = await t.database.db.select().from(signInLinks);
    await t.app.get(FirstAdminAtStart).onApplicationBootstrap();
    expect(logged).toEqual([
      expect.stringContaining('CCMS_FIRST_ADMIN_EMAIL is ignored'),
    ]);
    expect(await t.database.db.select().from(signInLinks)).toEqual(before);
  });
});
