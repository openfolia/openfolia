import { UserPageDocument } from '../src/access/api/access.resources.js';
import {
  ForgotPasswordAcceptedDocument,
  PasswordChangedDocument,
  SignedInDocument,
  SignInLinkDocument,
  SignInLinkMadeDocument,
  SignInOptionsDocument,
} from '../src/access/api/password.resources.js';
import { SESSION_COOKIE } from '../src/access/api/session-cookies.js';
import type { Actor } from '../src/access/core/actor.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import { AuditEventPageDocument } from '../src/audit/api/audit-event.resources.js';
import { ErrorDocument, JSON_API } from '../src/base/api/json-api.js';
import { actorWith } from './fakes/actors.js';
import { startMailServer, type TestMailServer } from './mail-server.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Signing in with an email address and a password (#610), end to end: invites, the one-time
 * link, sessions, "Forgot password" with the email read from an SMTP server, changing one's
 * password, and the users list's `meta.signIn`.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const ORIGIN = 'https://docs.example.com';
const admin: Actor = { ...actorWith(['admin.roles']), id: 'pw-admin' };
const GOOD = 'a long and quiet river';
const NEWER = 'another long sentence here';

let server: TestMailServer;
let t: TestApp;

beforeAll(async () => {
  server = await startMailServer();
  t = await createTestApp({
    CCMS_PASSWORD_SIGN_IN: 'on',
    CCMS_MAIL_URL: `smtp://localhost:${server.port}`,
    CCMS_MAIL_FROM: 'docs@example.com',
    CCMS_MAIL_CA_FILE: server.caFile,
    CCMS_PUBLIC_URL: `${ORIGIN}/`,
  });
  await seedAccess(
    t.database,
    Seed.parse({
      roles: [...admin.roles],
      users: [
        {
          id: admin.id,
          name: 'Password Admin',
          roles: admin.roles.map((r) => r.id),
        },
        { id: 'pat', name: 'Pat Example', email: 'pat@example.org', roles: [] },
        { id: 'lee', name: 'Lee Example', email: 'lee@example.org', roles: [] },
        { id: 'sam', name: 'Sam Example', email: 'sam@example.org', roles: [] },
      ],
    }),
  );
});
afterAll(async () => {
  await t?.close();
  await server?.close();
});
afterEach(() => t?.actAs(undefined));

const error = (body: unknown) => ErrorDocument.parse(body).errors[0];

/** A public POST from the editor's origin, with the browser's cookie when given. */
const post = (path: string, body: unknown, cookie?: string) => {
  const req = t
    .anonymous()
    .post(path)
    .set('Content-Type', JSON_API)
    .set('Origin', ORIGIN);
  if (cookie) req.set('Cookie', cookie);
  return req.send(JSON.stringify(body));
};

const cookieOf = (res: { headers: Record<string, unknown> }) => {
  const set = res.headers['set-cookie'] as string[] | undefined;
  const session = set?.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return session?.split(';', 1)[0];
};

async function invite(userId: string) {
  t.actAs(admin);
  const res = await t.post(`/users/${userId}/invite`);
  t.actAs(undefined);
  expect(res.status).toBe(201);
  expect(res.headers['cache-control']).toBe('no-store');
  return SignInLinkMadeDocument.parse(res.body).meta;
}

const setPassword = (token: string, password: string, cookie?: string) =>
  post(
    '/auth/password/set',
    { data: { type: 'PasswordSet', attributes: { token, password } } },
    cookie,
  );

const signIn = (email: string, password: string, cookie?: string) =>
  post(
    '/auth/password/sign-in',
    { data: { type: 'PasswordSignIn', attributes: { email, password } } },
    cookie,
  );

const me = (cookie: string) => t.anonymous().get('/me').set('Cookie', cookie);

/** Runs the queued jobs until the mail server has `count` messages, or gives up. */
async function mailArrives(count: number): Promise<void> {
  for (let i = 0; i < 100 && server.received.length < count; i++) {
    await t.runJobs();
    if (server.received.length < count) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  expect(server.received.length).toBeGreaterThanOrEqual(count);
}

/** The one-time link's token in a message, quoted-printable soft breaks undone. */
function linkIn(raw: string): string | undefined {
  const plain = raw
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
  return /set-password#(ccms_pwl_[0-9a-f]{64})/.exec(plain)?.[1];
}

describe('password sign-in (#610)', () => {
  it('offers the password form and "Forgot password"', async () => {
    const res = await t.anonymous().get('/auth/options').expect(200);
    expect(SignInOptionsDocument.parse(res.body).data.attributes).toEqual({
      password: true,
      passwordReset: true,
      emailCode: true,
      providers: 0,
    });
  });

  it('invites a person, who opens the link, sets a password and is signed in', async () => {
    const made = await invite('pat');
    expect(made.url).toBe(`${ORIGIN}/set-password#${made.token}`);
    expect(made.emailed).toBe(true);

    const opened = await post('/auth/password/link', {
      data: { type: 'SignInLink', attributes: { token: made.token } },
    }).expect(200);
    expect(SignInLinkDocument.parse(opened.body).meta).toMatchObject({
      kind: 'invite',
      name: 'Pat Example',
      email: 'pat@example.org',
    });

    // A password the rules refuse leaves the link working.
    const weak = await setPassword(made.token, 'password1234');
    expect([weak.status, error(weak.body)?.code]).toEqual([
      422,
      'password-too-common',
    ]);

    const set = await setPassword(made.token, GOOD).expect(200);
    expect(SignedInDocument.parse(set.body).meta.userId).toBe('pat');
    const cookie = cookieOf(set);
    expect(cookie).toBeDefined();
    const who = await me(cookie!).expect(200);
    expect((who.body as { data: { id: string } }).data.id).toBe('pat');

    // Once only.
    const again = await setPassword(made.token, NEWER);
    expect([again.status, error(again.body)?.code]).toEqual([
      404,
      'link-invalid',
    ]);

    // Signs in with it later, the address in any case.
    const later = await signIn('PAT@example.org', GOOD).expect(200);
    expect(cookieOf(later)).toBeDefined();

    // Audit: the events, with IDs only.
    t.actAs(admin);
    const audit = await t
      .get('/audit-events?filter[subject]=user/pat&page[size]=50')
      .expect(200);
    const events = AuditEventPageDocument.parse(audit.body).data;
    const actions = events.map((e) => e.attributes.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'user.invite',
        'user.password-set',
        'user.sign-in',
      ]),
    );
    const text = JSON.stringify(audit.body);
    expect(text).not.toContain(made.token);
    expect(text).not.toContain(GOOD);
    expect(text).not.toContain('$argon2id$');
  });

  it('answers a wrong password and an unknown address alike', async () => {
    const wrong = await signIn('pat@example.org', 'not the password at all');
    const unknown = await signIn('nobody@example.org', GOOD);
    for (const res of [wrong, unknown]) {
      expect([res.status, error(res.body)?.code]).toEqual([
        401,
        'invalid-credentials',
      ]);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    expect(error(wrong.body)?.detail).toBe(error(unknown.body)?.detail);
  });

  it('refuses a sign-in from another origin', async () => {
    const res = await t
      .anonymous()
      .post('/auth/password/sign-in')
      .set('Content-Type', JSON_API)
      .set('Origin', 'https://attacker.example')
      .send(
        JSON.stringify({
          data: {
            type: 'PasswordSignIn',
            attributes: { email: 'pat@example.org', password: GOOD },
          },
        }),
      );
    expect([res.status, error(res.body)?.code]).toEqual([
      403,
      'cross-origin-request',
    ]);
  });

  it('changes the password, ending the other sessions but this one', async () => {
    const first = cookieOf(await signIn('pat@example.org', GOOD).expect(200))!;
    const second = cookieOf(await signIn('pat@example.org', GOOD).expect(200))!;
    const wrong = await post(
      '/me/password',
      {
        data: {
          type: 'PasswordChange',
          attributes: {
            currentPassword: 'wrong wrong wrong',
            newPassword: NEWER,
          },
        },
      },
      first,
    );
    expect([wrong.status, error(wrong.body)?.code]).toEqual([
      403,
      'wrong-password',
    ]);
    const changed = await post(
      '/me/password',
      {
        data: {
          type: 'PasswordChange',
          attributes: { currentPassword: GOOD, newPassword: NEWER },
        },
      },
      first,
    ).expect(200);
    expect(
      PasswordChangedDocument.parse(changed.body).meta.sessionsEnded,
    ).toBeGreaterThanOrEqual(1);
    await me(first).expect(200);
    expect((await me(second)).status).toBe(401);
    await signIn('pat@example.org', NEWER).expect(200);
    expect((await signIn('pat@example.org', GOOD)).status).toBe(401);
  });

  it('resets by email: the same answer for any address, a link that ends every session', async () => {
    const session = cookieOf(
      await signIn('pat@example.org', NEWER).expect(200),
    )!;
    // The invites' emails out first: only the reset's below.
    for (let i = 0; i < 10 && (await t.runJobs()) > 0; i++);
    server.received.length = 0;
    const forgot = (email: string) =>
      post('/auth/password/forgot', {
        data: { type: 'PasswordReset', attributes: { email } },
      });
    const known = await forgot('pat@example.org').expect(202);
    const unknown = await forgot('nobody@example.org').expect(202);
    expect(ForgotPasswordAcceptedDocument.parse(known.body)).toEqual(
      ForgotPasswordAcceptedDocument.parse(unknown.body),
    );
    await mailArrives(1);
    expect(server.received).toHaveLength(1);
    const [mail] = server.received;
    expect(mail!.to).toEqual(['pat@example.org']);
    const token = linkIn(mail!.raw);
    expect(token).toBeDefined();

    const reset = await setPassword(token!, GOOD).expect(200);
    expect(cookieOf(reset)).toBeDefined();
    expect((await me(session)).status).toBe(401);
    await signIn('pat@example.org', GOOD).expect(200);
  });

  it('makes a reset link that revokes the earlier one, and withdraws invites', async () => {
    const first = await invite('lee');
    t.actAs(admin);
    const reset = SignInLinkMadeDocument.parse(
      (await t.post('/users/lee/password-reset').expect(201)).body,
    ).meta;
    const old = await post('/auth/password/link', {
      data: { type: 'SignInLink', attributes: { token: first.token } },
    });
    expect(old.status).toBe(404);
    await post('/auth/password/link', {
      data: { type: 'SignInLink', attributes: { token: reset.token } },
    }).expect(200);

    const open = await invite('sam');
    t.actAs(admin);
    const listed = await t.get('/users?filter[q]=sam@example.org').expect(200);
    const sam = UserPageDocument.parse(listed.body).data.find(
      (u) => u.id === 'sam',
    );
    expect(sam?.meta?.signIn).toMatchObject({
      password: false,
      provider: false,
      inviteExpiresAt: open.expiresAt,
    });
    await t.delete('/users/sam/invite').expect(204);
    expect((await t.delete('/users/sam/invite')).status).toBe(404);
    t.actAs(undefined);
    const gone = await setPassword(open.token, GOOD);
    expect(gone.status).toBe(404);
  });
});
