import { Logger } from '@nestjs/common';
import {
  ActorDocument,
  UserPageDocument,
} from '../src/access/api/access.resources.js';
import {
  SignedInDocument,
  SignInOptionsDocument,
} from '../src/access/api/password.resources.js';
import { SESSION_COOKIE } from '../src/access/api/session-cookies.js';
import { PASSWORD_PROVIDER } from '../src/access/core/passwords.js';
import { mintSessionToken, SessionStore } from '../src/access/core/sessions.js';
import { UnitOfWork } from '../src/base/core/unit-of-work.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import { ErrorDocument, JSON_API } from '../src/base/api/json-api.js';
import { startMailServer, type TestMailServer } from './mail-server.js';
import { createTestApp, TOKEN, type TestApp } from './test-app.js';

/**
 * Signing in with a one-time code by email alone (#639): password sign-in off, no identity
 * provider, `CCMS_EMAIL_CODE_SIGN_IN=on` and email set up. The guard reads the sessions codes
 * start; the first admin from `CCMS_FIRST_ADMIN_EMAIL` signs in by code (no password link); the
 * shared token reads as before.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const ORIGIN = 'https://docs.example.com';

let server: TestMailServer;
let t: TestApp;
let logged: string[];

beforeAll(async () => {
  logged = [];
  const log = (kind: 'log' | 'warn') =>
    vi.spyOn(Logger.prototype, kind).mockImplementation(function (
      this: Logger,
      message: unknown,
    ) {
      logged.push(String(message));
    });
  log('log');
  log('warn');
  server = await startMailServer();
  t = await createTestApp({
    CCMS_PASSWORD_SIGN_IN: 'off',
    CCMS_EMAIL_CODE_SIGN_IN: 'on',
    CCMS_MAIL_URL: `smtp://localhost:${server.port}`,
    CCMS_MAIL_FROM: 'docs@example.com',
    CCMS_MAIL_CA_FILE: server.caFile,
    CCMS_PUBLIC_URL: `${ORIGIN}/`,
    CCMS_FIRST_ADMIN_EMAIL: 'first@example.org',
    CCMS_FIRST_ADMIN_NAME: 'First Admin',
  });
  await seedAccess(
    t.database,
    Seed.parse({
      roles: [],
      users: [
        { id: 'pat', name: 'Pat Example', email: 'pat@example.org', roles: [] },
      ],
    }),
  );
});
afterAll(async () => {
  vi.restoreAllMocks();
  await t?.close();
  await server?.close();
});

const error = (body: unknown) => ErrorDocument.parse(body).errors[0];

const post = (path: string, body: unknown, cookie?: string) => {
  const req = t
    .anonymous()
    .post(path)
    .set('Content-Type', JSON_API)
    .set('Origin', ORIGIN);
  if (cookie !== undefined) req.set('Cookie', cookie);
  return req.send(JSON.stringify(body));
};

const cookieOf = (res: { headers: Record<string, unknown> }) =>
  (res.headers['set-cookie'] as string[] | undefined)
    ?.find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.split(';', 1)[0];

/** Asks for a code for `email` and reads it from the newest message to them. */
async function codeFor(email: string): Promise<string> {
  const before = server.received.length;
  await post('/auth/email-code/request', {
    data: { type: 'EmailCodeRequest', attributes: { email } },
  }).expect(202);
  for (let i = 0; i < 100 && server.received.length <= before; i++) {
    await t.runJobs();
    if (server.received.length <= before) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const mail = server.received.at(-1);
  expect(mail?.to).toEqual([email]);
  const code = /^([0-9]{6})\r?$/m.exec(mail!.raw.replace(/=\r?\n/g, ''))?.[1];
  expect(code).toBeDefined();
  return code!;
}

/** Signs in with a code by email; the session's cookie. */
async function signIn(email: string, userId: string): Promise<string> {
  const code = await codeFor(email);
  const res = await post('/auth/email-code/sign-in', {
    data: { type: 'EmailCodeSignIn', attributes: { email, code } },
  }).expect(200);
  expect(SignedInDocument.parse(res.body).meta.userId).toBe(userId);
  const cookie = cookieOf(res);
  expect(cookie).toBeDefined();
  return cookie!;
}

describe('sign-in with a code by email alone (#639)', () => {
  it('offers codes only on the sign-in page', async () => {
    const res = await t.anonymous().get('/auth/options').expect(200);
    expect(SignInOptionsDocument.parse(res.body).data.attributes).toEqual({
      password: false,
      passwordReset: false,
      emailCode: true,
      providers: 0,
    });
  });

  it('signs in with a code, reads as that person and signs out', async () => {
    const cookie = await signIn('pat@example.org', 'pat');
    const me = await t.anonymous().get('/me').set('Cookie', cookie).expect(200);
    expect(ActorDocument.parse(me.body).data.id).toBe('pat');
    expect(me.headers['vary']).toMatch(/Cookie/);
    // Pat has no role: an admin's read is refused for the person, not for want of a session.
    const users = await t.anonymous().get('/users').set('Cookie', cookie);
    expect(users.status).toBe(403);

    await post('/auth/sign-out', {}, cookie).expect(200);
    const after = await t.anonymous().get('/me').set('Cookie', cookie);
    expect([after.status, error(after.body)?.code]).toEqual([
      401,
      'unauthorized',
    ]);
  });

  it('makes the first admin, who signs in by code: no password link is logged', async () => {
    expect(logged).toContainEqual(
      expect.stringContaining(
        'Made the first admin first@example.org (user "first")',
      ),
    );
    expect(logged.join('\n')).not.toContain('/set-password#');
    expect(logged).toContainEqual(
      expect.stringContaining('They sign in with a code by email'),
    );
    expect(logged.join('\n')).not.toContain('nobody can sign in yet');

    const cookie = await signIn('first@example.org', 'first');
    const users = await t
      .anonymous()
      .get('/users')
      .set('Cookie', cookie)
      .expect(200);
    expect(UserPageDocument.parse(users.body).data.map((u) => u.id)).toContain(
      'first',
    );
  });

  it('ignores a session from a way in that is off: a password, or a provider since removed', async () => {
    for (const provider of [PASSWORD_PROVIDER, 'oidc', 'removed-provider']) {
      const minted = mintSessionToken();
      await t.app.get(UnitOfWork).run((tx) =>
        t.app.get(SessionStore).create(tx, {
          hash: minted.hash,
          userId: 'pat',
          provider,
          endedBefore: new Date(0),
        }),
      );
      const res = await t
        .anonymous()
        .get('/me')
        .set('Cookie', `${SESSION_COOKIE}=${minted.token}`);
      expect([provider, res.status, error(res.body)?.code]).toEqual([
        provider,
        401,
        'unauthorized',
      ]);
    }
  });

  it('still reads with the shared token, and refuses a request without anything', async () => {
    await t
      .anonymous()
      .get('/me')
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(200);
    const none = await t.anonymous().get('/me');
    expect([none.status, error(none.body)?.code]).toEqual([
      401,
      'unauthorized',
    ]);
  });
});
